/**
 * AgentOS boot-time environment validator.
 *
 * Runtime implementation for `packages/core-engine/src/config/env.validator.mjs`.
 * Deliberately dependency-free plain JavaScript: the Gate P0 images run Node 20
 * (`node:20-alpine`) with no compile step and no `node_modules`, so this module
 * MUST NOT import `zod` (the blueprint's target schema in
 * `implement/01-tech-stack-and-environment.md` §4) or any other package.
 * `env.validator.ts` is the typed pointer for TypeScript consumers.
 *
 * Fail-closed semantics:
 * - `APP_ENV` selects the deployment profile (`local|ci|staging|sandbox|production`)
 *   and has no default. `NODE_ENV` is the Node runtime mode only
 *   (`development|test|production`) and never selects the profile.
 * - Managed profiles (`staging|sandbox|production`) refuse placeholder/mock values
 *   and refuse a mock system-of-record boundary.
 * - Every issue message names the variable it concerns and never contains its value;
 *   secret-shaped values are additionally redacted from any message.
 *
 * @typedef {'local'|'ci'|'staging'|'sandbox'|'production'} AppEnv
 * @typedef {'development'|'test'|'production'} NodeEnv
 * @typedef {{ path: string, message: string }} EnvironmentIssue
 * @typedef {{ requireNodeEnv?: boolean }} ParseOptions
 * @typedef {{ ok: true, data: Record<string, unknown> } | { ok: false, issues: EnvironmentIssue[] }} ParseResult
 */

/** Deployment profiles. Mirrors the blueprint profile mapping table (§3.1). */
export const APP_ENVS = ['local', 'ci', 'staging', 'sandbox', 'production'];
/** Node runtime modes. Never a profile selector. */
export const NODE_ENVS = ['development', 'test', 'production'];
/** `APP_ENV` -> required `NODE_ENV`. */
export const PROFILE_NODE_ENV = {
  local: 'development',
  ci: 'test',
  staging: 'production',
  sandbox: 'production',
  production: 'production',
};
/** Profiles where placeholders, mocks and debug logging are refused. */
export const MANAGED_APP_ENVS = ['staging', 'sandbox', 'production'];

/**
 * Placeholder pattern from the catalog §8 rules (case-insensitive): a value matching it is
 * acceptable only in `local`/`ci`.
 */
const PLACEHOLDER_PATTERN =
  /(mock|placeholder|example\.invalid|super_secret|agentos_internal_service_mesh_key|hmac_signature_validation_secret|local_only_audit_chain_signing|change[-_]me|test[-_](?:secret|key|password))/i;

/**
 * Literal banner values from the blueprint `.env.example` and Compose blueprint. These are
 * local-only fixtures; they must never satisfy a managed profile, even though some of them
 * do not match {@link PLACEHOLDER_PATTERN}.
 */
const BANNER_VALUES = [
  'postgres_dev_secret_password',
  'redis_dev_secret_password',
  'qdrant_dev_secret_api_key',
  'mock_erp_hmac_secret_key',
  'agentos_app_password',
  'sk-proj-mock',
  'sk-ant-mock',
  'sk_test_mock',
  'whsec_mock',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
];

/** Keys whose values are treated as secret-shaped for message redaction. */
const SECRET_KEY_PATTERN = /(secret|password|passwd|key|token|url|dsn|credential|signature)/i;

/**
 * The complete set of variables this validator owns. Placeholder rejection in managed
 * profiles runs over these fields only, so unrelated host variables (for example
 * `npm_config_*`) can never fail a boot.
 */
const KNOWN_KEYS = new Set([
  'APP_ENV',
  'NODE_ENV',
  'PORT',
  'SERVICE_NAME',
  'JWT_SECRET',
  'JWT_EXPIRES_IN',
  'INTERNAL_API_KEY',
  'WEBHOOK_HMAC_SECRET',
  'AUDIT_HMAC_SECRET',
  'ENCRYPTION_KEY_AES256',
  'DATABASE_URL',
  'DATABASE_POOL_MIN',
  'DATABASE_POOL_MAX',
  'POSTGRES_PRIMARY_URL',
  'POSTGRES_REPLICA_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'REDIS_DB',
  'REDIS_KEY_PREFIX',
  'SESSION_MUTEX_TTL_SECONDS',
  'IDEMPOTENCY_TTL_SECONDS',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'EMBEDDING_DIMENSIONS',
  'OPENAI_API_KEY',
  'PRIMARY_REASONING_MODEL',
  'FAST_COMPLETION_MODEL',
  'ERP_API_BASE_URL',
  'ERP_TIMEOUT_MS',
  'EVENT_INGESTION_BASE_URL',
  'EVENT_INGESTION_HMAC_SECRET',
  'API_BASE_URL',
  'WEB_BASE_URL',
  'CORS_ALLOWED_ORIGINS',
  'LOG_LEVEL',
  'MOCK_ERP_ENABLED',
  // The shared secret the platform signs API-001 calls with while the mock system of record is
  // enabled. It is a local/CI credential, so it belongs in the same placeholder scan: a managed
  // profile that somehow carries the mock secret must fail rather than sign against a fixture.
  'MOCK_SECRET_KEY',
  'STORAGE_PROVIDER',
  'PAYPAL_MODE',
  'LINE_CHANNEL_ID',
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'EMAIL_PROVIDER',
  'EMAIL_API_KEY',
  'EMAIL_WEBHOOK_SIGNING_KEY',
  'SMS_PROVIDER',
  'SMS_API_KEY',
  'SMS_WEBHOOK_SIGNING_KEY',
  'ECPAY_MERCHANT_ID',
  'ECPAY_HASH_KEY',
  'ECPAY_HASH_IV',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TEMPORAL_ADDRESS',
  'TEMPORAL_NAMESPACE',
]);

/**
 * Optional adapter credential sets. A set is enabled only when every credential is present;
 * the validator never substitutes a default (in particular never a mock) credential, so an
 * absent set leaves the adapter disabled. `requiredProvider` names the extra variable that
 * becomes mandatory once the credential set is present.
 */
const ADAPTER_SETS = [
  { name: 'LINE', credentials: ['LINE_CHANNEL_ID', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'] },
  { name: 'Email', credentials: ['EMAIL_API_KEY', 'EMAIL_WEBHOOK_SIGNING_KEY'], requiredProvider: 'EMAIL_PROVIDER' },
  { name: 'SMS', credentials: ['SMS_API_KEY', 'SMS_WEBHOOK_SIGNING_KEY'], requiredProvider: 'SMS_PROVIDER' },
  { name: 'ECPay', credentials: ['ECPAY_MERCHANT_ID', 'ECPAY_HASH_KEY', 'ECPAY_HASH_IV'] },
  { name: 'Stripe', credentials: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
];

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
const STORAGE_PROVIDERS = ['s3', 'r2', 'local'];
const PAYPAL_MODES = ['sandbox', 'live'];
const JWT_EXPIRES_IN_PATTERN = /^\d+[smhd]$/;

/**
 * True when a value is a local/CI placeholder that must never satisfy a managed profile.
 * Pure: usable on a single value with no environment in scope.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlaceholder(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (PLACEHOLDER_PATTERN.test(value)) return true;
  const lowered = value.toLowerCase();
  return BANNER_VALUES.some((banner) => lowered.includes(banner));
}

/**
 * Replaces every secret-shaped value with `[REDACTED]` so a message can never echo a
 * credential. Values shorter than 6 characters are skipped: they are not credentials and
 * blind replacement would corrupt ordinary words.
 *
 * @param {string} message
 * @param {Iterable<string>} secrets
 * @returns {string}
 */
export function redact(message, secrets) {
  let safe = String(message);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    if (safe.includes(secret)) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe;
}

/**
 * Secret-shaped values of an environment object, used for message redaction.
 *
 * @param {Record<string, unknown>} source
 * @returns {string[]}
 */
export function secretValues(source) {
  const values = [];
  for (const [key, raw] of Object.entries(source)) {
    if (!SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length >= 6) values.push(value);
  }
  return values;
}

/**
 * @param {unknown} raw
 * @returns {string|undefined} trimmed value, `''` for an empty value, `undefined` when unset
 */
export function readValue(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return undefined;
}

/**
 * @param {string} value
 * @returns {number|undefined} integer parsed from a strict `-?\d+` token
 */
function parseIntStrict(value) {
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * @param {string} value
 * @returns {boolean|undefined}
 */
export function parseBool(value) {
  const lowered = value.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
  if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  return undefined;
}

/**
 * @param {string} value
 * @returns {URL|undefined} parsed URL when it is an absolute http(s) URL
 */
function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.hostname === '') return undefined;
  return url;
}

/**
 * @param {string} value
 * @returns {URL|undefined} parsed URL when it uses the postgresql:// or postgres:// scheme
 */
function parsePostgresUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return undefined;
  if (url.hostname === '') return undefined;
  return url;
}

/**
 * @param {URL} url
 * @returns {boolean} true when the URI pins TLS certificate verification
 */
function hasVerifyFullTls(url) {
  return url.searchParams.get('sslmode') === 'verify-full';
}

/**
 * @param {string} value
 * @returns {boolean} true for `host:port` with a port in 1..65535
 */
function isHostPort(value) {
  const match = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(value);
  if (!match) return false;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535;
}

/**
 * Strictly validates an environment object against the Gate P0 contract.
 * Collects every issue instead of failing on the first one; never throws.
 *
 * @param {Record<string, unknown>} [env] raw environment (defaults to `process.env`)
 * @param {ParseOptions} [options] `requireNodeEnv: false` relaxes the NODE_ENV requirement
 *   for consumers that are not the api/worker processes (for example Command Center or the
 *   mock ERP simulator); the mapping check still applies whenever NODE_ENV is present.
 * @returns {ParseResult}
 */
export function parseEnvironment(env = process.env, options = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const requireNodeEnv = options.requireNodeEnv !== false;

  /** @type {EnvironmentIssue[]} */
  const issues = [];
  const secrets = secretValues(source);
  const add = (path, message) => {
    issues.push({ path, message: redact(message, secrets) });
  };
  const read = (key) => readValue(source[key]);

  // ---- profile ------------------------------------------------------------------
  const appEnv = read('APP_ENV') ?? '';
  if (appEnv === '') {
    add('APP_ENV', `APP_ENV is required and has no default; set one of ${APP_ENVS.join('|')}. NODE_ENV never selects the profile.`);
  } else if (!APP_ENVS.includes(appEnv)) {
    add('APP_ENV', `APP_ENV must be one of ${APP_ENVS.join('|')}.`);
  }
  const isLocalOrCi = appEnv === 'local' || appEnv === 'ci';
  const isManaged = MANAGED_APP_ENVS.includes(appEnv);

  // ---- node runtime mode --------------------------------------------------------
  const nodeEnv = read('NODE_ENV') ?? '';
  if (nodeEnv === '') {
    if (requireNodeEnv) {
      add('NODE_ENV', `NODE_ENV is required for api/worker boot and must be one of ${NODE_ENVS.join('|')}.`);
    }
  } else if (!NODE_ENVS.includes(nodeEnv)) {
    add('NODE_ENV', `NODE_ENV must be one of ${NODE_ENVS.join('|')}; it is the Node runtime mode only and never selects the deployment profile.`);
  } else if (APP_ENVS.includes(appEnv) && nodeEnv !== PROFILE_NODE_ENV[appEnv]) {
    add(
      'NODE_ENV',
      `NODE_ENV disagrees with APP_ENV: APP_ENV requires NODE_ENV=${PROFILE_NODE_ENV[appEnv]} (local=>development, ci=>test, staging|sandbox|production=>production).`,
    );
  }

  // ---- runtime ------------------------------------------------------------------
  const portRaw = read('PORT');
  let port = 4000;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = parseIntStrict(portRaw);
    if (parsed === undefined || parsed < 1 || parsed > 65535) {
      add('PORT', 'PORT must be an integer between 1 and 65535.');
    } else {
      port = parsed;
    }
  }
  let serviceName = 'agentos-api';
  const serviceNameRaw = read('SERVICE_NAME');
  if (serviceNameRaw !== undefined && serviceNameRaw !== '') {
    serviceName = serviceNameRaw;
  }

  // ---- security -----------------------------------------------------------------
  const jwtSecret = stringField(add, read, 'JWT_SECRET', 32);
  let jwtExpiresIn = '24h';
  const jwtExpiresInRaw = read('JWT_EXPIRES_IN');
  if (jwtExpiresInRaw !== undefined && jwtExpiresInRaw !== '') {
    if (JWT_EXPIRES_IN_PATTERN.test(jwtExpiresInRaw)) {
      jwtExpiresIn = jwtExpiresInRaw;
    } else {
      add('JWT_EXPIRES_IN', 'JWT_EXPIRES_IN must match /^\\d+[smhd]$/ (for example 24h, 30m, 7d).');
    }
  }
  const internalApiKey = stringField(add, read, 'INTERNAL_API_KEY', 32);
  const webhookHmacSecret = stringField(add, read, 'WEBHOOK_HMAC_SECRET', 16);
  const auditHmacSecret = stringField(add, read, 'AUDIT_HMAC_SECRET', 16);
  const encryptionKey = stringField(add, read, 'ENCRYPTION_KEY_AES256', 64, {
    validate: (value) => /^[0-9a-f]{64}$/i.test(value),
    invalidMessage: 'ENCRYPTION_KEY_AES256 must be exactly 64 hexadecimal characters (32 bytes); the value is never truncated or padded.',
  });

  // ---- relational database ------------------------------------------------------
  let databaseUrl;
  const databaseUrlRaw = read('DATABASE_URL');
  if (databaseUrlRaw === undefined || databaseUrlRaw === '') {
    add('DATABASE_URL', 'DATABASE_URL is required and must be a postgresql:// or postgres:// connection URI.');
  } else {
    const parsed = parsePostgresUrl(databaseUrlRaw);
    if (!parsed) {
      add('DATABASE_URL', 'DATABASE_URL must use the postgresql:// or postgres:// scheme; other database schemes are rejected.');
    } else {
      if (isManaged && !hasVerifyFullTls(parsed)) {
        add('DATABASE_URL', 'DATABASE_URL must include sslmode=verify-full outside local and ci.');
      }
      databaseUrl = databaseUrlRaw;
    }
  }
  const poolMin = intField(add, read, 'DATABASE_POOL_MIN', 5, {
    min: 1,
    description: 'an integer >= 1',
  });
  const poolMax = intField(add, read, 'DATABASE_POOL_MAX', 20, {
    min: 5,
    description: 'an integer >= 5',
  });
  if (poolMin !== undefined && poolMax !== undefined && poolMin > poolMax) {
    add('DATABASE_POOL_MAX', 'DATABASE_POOL_MAX must be greater than or equal to DATABASE_POOL_MIN.');
  }
  const postgresUrlFields = {};
  for (const key of ['POSTGRES_PRIMARY_URL', 'POSTGRES_REPLICA_URL']) {
    const value = read(key);
    if (value === undefined || value === '') continue;
    const parsed = parsePostgresUrl(value);
    if (!parsed) {
      add(key, `${key} must use the postgresql:// or postgres:// scheme when set.`);
    } else if (!hasVerifyFullTls(parsed)) {
      add(key, `${key} must include sslmode=verify-full when set.`);
    } else {
      postgresUrlFields[key] = value;
    }
  }

  // ---- redis --------------------------------------------------------------------
  const redisHost = stringField(add, read, 'REDIS_HOST', 1);
  const redisPort = intField(add, read, 'REDIS_PORT', 6379, {
    min: 1,
    max: 65535,
    description: 'an integer between 1 and 65535',
  });
  const redisPassword = stringField(add, read, 'REDIS_PASSWORD', 1);
  const redisDb = intField(add, read, 'REDIS_DB', 0, { min: 0, description: 'an integer >= 0' });
  const redisKeyPrefixRaw = read('REDIS_KEY_PREFIX');
  const redisKeyPrefix = redisKeyPrefixRaw === undefined || redisKeyPrefixRaw === '' ? 'agentos:' : redisKeyPrefixRaw;
  const sessionMutexTtlSeconds = intField(add, read, 'SESSION_MUTEX_TTL_SECONDS', 30, {
    min: 1,
    description: 'a positive integer (seconds)',
  });
  const idempotencyTtlSeconds = intField(add, read, 'IDEMPOTENCY_TTL_SECONDS', 259200, {
    min: 1,
    description: 'a positive integer (seconds)',
  });

  // ---- vector store -------------------------------------------------------------
  const qdrantUrl = urlField(add, read, 'QDRANT_URL');
  const qdrantApiKey = stringField(add, read, 'QDRANT_API_KEY', 1);
  // Compose renders one key into both names; the Qdrant service and the gateway would
  // authenticate with different keys if the two ever diverged, so the boot is refused instead of
  // picking one. The message names both variables and echoes neither value.
  const qdrantServiceApiKey = read('QDRANT__SERVICE__API_KEY');
  if (qdrantServiceApiKey !== undefined && qdrantServiceApiKey !== '' && qdrantServiceApiKey !== qdrantApiKey) {
    const message =
      'QDRANT__SERVICE__API_KEY and QDRANT_API_KEY must carry the same key: render one value into both names, or leave QDRANT__SERVICE__API_KEY unset. Neither value is reported here.';
    add('QDRANT__SERVICE__API_KEY', message);
    add('QDRANT_API_KEY', message);
  }
  const embeddingDimensions = intField(add, read, 'EMBEDDING_DIMENSIONS', 1536, {
    min: 1,
    description: 'a positive integer',
  });

  // ---- llm providers ------------------------------------------------------------
  const openaiApiKey = stringField(add, read, 'OPENAI_API_KEY', 1);
  const primaryReasoningModel = defaultedString(read, 'PRIMARY_REASONING_MODEL', 'gpt-4o');
  const fastCompletionModel = defaultedString(read, 'FAST_COMPLETION_MODEL', 'gpt-4o-mini');

  // ---- external boundaries ------------------------------------------------------
  const erpApiBaseUrl = urlField(add, read, 'ERP_API_BASE_URL');
  const erpTimeoutMs = intField(add, read, 'ERP_TIMEOUT_MS', 5000, {
    min: 1,
    description: 'a positive integer (milliseconds)',
  });
  const eventIngestionBaseUrl = urlField(add, read, 'EVENT_INGESTION_BASE_URL');
  const eventIngestionHmacSecret = stringField(add, read, 'EVENT_INGESTION_HMAC_SECRET', 1);
  const apiBaseUrl = urlField(add, read, 'API_BASE_URL');
  const webBaseUrl = urlField(add, read, 'WEB_BASE_URL');
  const corsAllowedOrigins = corsField(add, read, { isLocalOrCi });

  // ---- logging, mocks, storage --------------------------------------------------
  const logLevelRaw = read('LOG_LEVEL');
  let logLevel = 'info';
  if (logLevelRaw !== undefined && logLevelRaw !== '') {
    if (!LOG_LEVELS.includes(logLevelRaw)) {
      add('LOG_LEVEL', `LOG_LEVEL must be one of ${LOG_LEVELS.join('|')}.`);
    } else if (logLevelRaw === 'debug' && !isLocalOrCi) {
      add('LOG_LEVEL', 'LOG_LEVEL=debug is refused outside local and ci.');
    } else {
      logLevel = logLevelRaw;
    }
  }

  const mockErpRaw = read('MOCK_ERP_ENABLED');
  let mockErpEnabled = isLocalOrCi;
  if (mockErpRaw !== undefined && mockErpRaw !== '') {
    const parsed = parseBool(mockErpRaw);
    if (parsed === undefined) {
      add('MOCK_ERP_ENABLED', 'MOCK_ERP_ENABLED must be a boolean (true|false).');
    } else if (parsed && !isLocalOrCi) {
      add('MOCK_ERP_ENABLED', 'MOCK_ERP_ENABLED=true is refused outside local and ci: the mock system-of-record must never satisfy a managed profile.');
    } else {
      mockErpEnabled = parsed;
    }
  }

  const storageProviderRaw = read('STORAGE_PROVIDER');
  let storageProvider = 's3';
  if (storageProviderRaw !== undefined && storageProviderRaw !== '') {
    if (!STORAGE_PROVIDERS.includes(storageProviderRaw)) {
      add('STORAGE_PROVIDER', `STORAGE_PROVIDER must be one of ${STORAGE_PROVIDERS.join('|')}.`);
    } else if (storageProviderRaw === 'local' && !isLocalOrCi) {
      add('STORAGE_PROVIDER', 'STORAGE_PROVIDER=local is refused outside local and ci.');
    } else {
      storageProvider = storageProviderRaw;
    }
  }

  const paypalModeRaw = read('PAYPAL_MODE');
  let paypalMode;
  if (paypalModeRaw !== undefined && paypalModeRaw !== '') {
    if (!PAYPAL_MODES.includes(paypalModeRaw)) {
      add('PAYPAL_MODE', `PAYPAL_MODE must be one of ${PAYPAL_MODES.join('|')} when set.`);
    } else if (paypalModeRaw === 'live' && appEnv !== 'production') {
      add('PAYPAL_MODE', 'PAYPAL_MODE=live is refused outside production.');
    } else {
      paypalMode = paypalModeRaw;
    }
  }

  // ---- optional provider adapters (all-or-nothing, never defaulted) --------------
  const adapterFields = {};
  for (const set of ADAPTER_SETS) {
    const present = set.credentials.filter((key) => {
      const value = read(key);
      return value !== undefined && value !== '';
    });
    if (present.length === 0) continue; // adapter stays disabled; no default credential is invented
    if (present.length !== set.credentials.length) {
      const missing = set.credentials.filter((key) => !present.includes(key));
      add(
        present[0],
        `Incomplete ${set.name} credential set: missing ${missing.join(', ')}. Set every one of ${set.credentials.join(', ')} to enable the adapter, or leave the whole set unset (the adapter stays disabled).`,
      );
      continue;
    }
    for (const key of set.credentials) adapterFields[key] = read(key);
    if (set.requiredProvider) {
      const provider = read(set.requiredProvider);
      if (provider === undefined || provider === '') {
        add(set.requiredProvider, `${set.requiredProvider} is required when the ${set.name} credential set is configured.`);
      } else {
        adapterFields[set.requiredProvider] = provider;
      }
    }
  }

  // ---- durable workflow engine ---------------------------------------------------
  const temporalFields = {};
  const temporalAddress = read('TEMPORAL_ADDRESS');
  if (temporalAddress !== undefined && temporalAddress !== '') {
    if (!isHostPort(temporalAddress)) {
      add('TEMPORAL_ADDRESS', 'TEMPORAL_ADDRESS must be host:port (for example temporal:7233).');
    } else {
      temporalFields.TEMPORAL_ADDRESS = temporalAddress;
      temporalFields.TEMPORAL_NAMESPACE = read('TEMPORAL_NAMESPACE') || 'default';
    }
  }

  // ---- managed-profile placeholder rejection -------------------------------------
  if (isManaged) {
    for (const key of Object.keys(source)) {
      if (!KNOWN_KEYS.has(key)) continue;
      const value = read(key);
      if (value === undefined || value === '') continue;
      if (isPlaceholder(value)) {
        add(key, `Placeholder value rejected for APP_ENV=${appEnv}; inject the real value from the secret store.`);
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const data = pruneUndefined({
    APP_ENV: appEnv,
    NODE_ENV: nodeEnv === '' ? undefined : nodeEnv,
    PORT: port,
    SERVICE_NAME: serviceName,
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: jwtExpiresIn,
    INTERNAL_API_KEY: internalApiKey,
    WEBHOOK_HMAC_SECRET: webhookHmacSecret,
    AUDIT_HMAC_SECRET: auditHmacSecret,
    ENCRYPTION_KEY_AES256: encryptionKey,
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MIN: poolMin,
    DATABASE_POOL_MAX: poolMax,
    ...postgresUrlFields,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_PASSWORD: redisPassword,
    REDIS_DB: redisDb,
    REDIS_KEY_PREFIX: redisKeyPrefix,
    SESSION_MUTEX_TTL_SECONDS: sessionMutexTtlSeconds,
    IDEMPOTENCY_TTL_SECONDS: idempotencyTtlSeconds,
    QDRANT_URL: qdrantUrl,
    QDRANT_API_KEY: qdrantApiKey,
    EMBEDDING_DIMENSIONS: embeddingDimensions,
    OPENAI_API_KEY: openaiApiKey,
    PRIMARY_REASONING_MODEL: primaryReasoningModel,
    FAST_COMPLETION_MODEL: fastCompletionModel,
    ERP_API_BASE_URL: erpApiBaseUrl,
    ERP_TIMEOUT_MS: erpTimeoutMs,
    EVENT_INGESTION_BASE_URL: eventIngestionBaseUrl,
    EVENT_INGESTION_HMAC_SECRET: eventIngestionHmacSecret,
    API_BASE_URL: apiBaseUrl,
    WEB_BASE_URL: webBaseUrl,
    CORS_ALLOWED_ORIGINS: corsAllowedOrigins,
    LOG_LEVEL: logLevel,
    MOCK_ERP_ENABLED: mockErpEnabled,
    STORAGE_PROVIDER: storageProvider,
    PAYPAL_MODE: paypalMode,
    ...adapterFields,
    ...temporalFields,
  });

  return { ok: true, data };
}

/**
 * Validates `process.env` (or the supplied object) and refuses to continue on any issue:
 * prints a fail-closed report to stderr and exits with status 1. Issue lines name the
 * variable and never contain its value.
 *
 * @param {Record<string, unknown>} [env]
 * @param {ParseOptions} [options]
 * @returns {Record<string, unknown>} the parsed environment (unreachable after `process.exit`)
 */
export function validateEnvironment(env = process.env, options = {}) {
  const result = parseEnvironment(env, options);
  if (result.ok) return result.data;

  const lines = ['FATAL: Environment validation failed', ...result.issues.map((issue) => `[${issue.path}] ${issue.message}`)];
  console.error(lines.join('\n'));
  process.exit(1);
  return undefined;
}

/**
 * Required non-empty string of at least `min` characters. Absent, empty and too-short values
 * are rejected; a wrong-length credential is never cropped or padded to fit.
 *
 * @param {(path: string, message: string) => void} add
 * @param {(key: string) => string|undefined} read
 * @param {string} key
 * @param {number} min
 * @param {{ validate?: (value: string) => boolean, invalidMessage?: string }} [extra]
 * @returns {string|undefined}
 */
function stringField(add, read, key, min, extra = {}) {
  const value = read(key);
  if (value === undefined || value === '') {
    add(key, `${key} is required and must be at least ${min} character${min === 1 ? '' : 's'}.`);
    return undefined;
  }
  if (extra.validate && !extra.validate(value)) {
    add(key, extra.invalidMessage ?? `${key} is invalid.`);
    return undefined;
  }
  if (value.length < min) {
    add(key, `${key} must be at least ${min} characters.`);
    return undefined;
  }
  return value;
}

/**
 * Optional integer with a default applied only when the variable is absent or empty.
 *
 * @param {(path: string, message: string) => void} add
 * @param {(key: string) => string|undefined} read
 * @param {string} key
 * @param {number} fallback
 * @param {{ min?: number, max?: number, description: string }} bounds
 * @returns {number|undefined} `undefined` when the supplied value is invalid
 */
function intField(add, read, key, fallback, bounds) {
  const value = read(key);
  if (value === undefined || value === '') return fallback;
  const parsed = parseIntStrict(value);
  const inBounds =
    parsed !== undefined &&
    (bounds.min === undefined || parsed >= bounds.min) &&
    (bounds.max === undefined || parsed <= bounds.max);
  if (!inBounds) {
    add(key, `${key} must be ${bounds.description}.`);
    return undefined;
  }
  return parsed;
}

/**
 * Required absolute http(s) URL.
 *
 * @param {(path: string, message: string) => void} add
 * @param {(key: string) => string|undefined} read
 * @param {string} key
 * @returns {string|undefined}
 */
function urlField(add, read, key) {
  const value = read(key);
  if (value === undefined || value === '') {
    add(key, `${key} is required and must be an absolute http(s) URL.`);
    return undefined;
  }
  if (!parseHttpUrl(value)) {
    add(key, `${key} must be an absolute http(s) URL.`);
    return undefined;
  }
  return value;
}

/**
 * Required comma-separated list of absolute http(s) origins. The wildcard `*` is a local/CI
 * convenience only and is refused in managed profiles.
 *
 * @param {(path: string, message: string) => void} add
 * @param {(key: string) => string|undefined} read
 * @param {{ isLocalOrCi: boolean }} context
 * @returns {string|undefined}
 */
function corsField(add, read, context) {
  const key = 'CORS_ALLOWED_ORIGINS';
  const value = read(key);
  if (value === undefined || value === '') {
    add(key, 'CORS_ALLOWED_ORIGINS is required: a comma-separated list of allowed http(s) origins.');
    return undefined;
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    add(key, 'CORS_ALLOWED_ORIGINS is required: a comma-separated list of allowed http(s) origins.');
    return undefined;
  }
  if (entries.includes('*') && !context.isLocalOrCi) {
    add(key, 'CORS_ALLOWED_ORIGINS must not contain the wildcard "*" outside local and ci.');
  }
  if (entries.some((entry) => entry !== '*' && !parseHttpUrl(entry))) {
    add(key, 'CORS_ALLOWED_ORIGINS entries must be absolute http(s) origins.');
  }
  return value;
}

/**
 * @param {(key: string) => string|undefined} read
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function defaultedString(read, key, fallback) {
  const value = read(key);
  return value === undefined || value === '' ? fallback : value;
}

/**
 * @param {Record<string, unknown>} object
 * @returns {Record<string, unknown>} the object without `undefined`-valued keys
 */
function pruneUndefined(object) {
  const pruned = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) pruned[key] = value;
  }
  return pruned;
}
