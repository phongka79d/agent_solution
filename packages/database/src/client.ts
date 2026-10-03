import { Pool } from 'pg';

let pool: Pool | undefined;
let platformPool: Pool | undefined;
let indexerPool: Pool | undefined;

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 60_000;

function timeoutFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const configured = Number(raw);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
}

function createConfiguredPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    statement_timeout: timeoutFromEnvironment('DATABASE_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS),
    idle_in_transaction_session_timeout: timeoutFromEnvironment(
      'DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
      DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    ),
  });
}

/**
 * Returns the process-wide PostgreSQL connection pool, creating it on first use.
 *
 * The pool is deliberately lazy: importing this module never opens a socket and
 * never requires `DATABASE_URL`, so contract-only consumers stay importable in
 * environments without a database. The first caller without `DATABASE_URL` fails
 * closed with `DATABASE_URL_REQUIRED` instead of silently connecting somewhere else.
 *
 * @returns The shared `pg` pool bound to `DATABASE_URL`.
 * @throws Error `DATABASE_URL_REQUIRED` when the environment variable is unset or empty.
 */
export function getPool(): Pool {
  if (pool === undefined) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL_REQUIRED: refusing to open a database pool without DATABASE_URL.');
    }

    pool = createConfiguredPool(connectionString);
  }

  return pool;
}

/**
 * Returns the process-wide PostgreSQL pool used for platform transactions.
 *
 * `PLATFORM_DATABASE_URL` must identify the dedicated platform login. When it is unset,
 * the existing `DATABASE_URL` pool is used for compatibility with databases that still
 * grant `agentos_app` membership in `agentos_platform`. After migration 0052, configure
 * `PLATFORM_DATABASE_URL`; migration 0052 revokes that legacy membership.
 */
export function getPlatformPool(): Pool {
  if (platformPool === undefined) {
    const connectionString = process.env.PLATFORM_DATABASE_URL;
    if (!connectionString) return getPool();
    platformPool = createConfiguredPool(connectionString);
  }

  return platformPool;
}

/**
 * Returns the process-wide PostgreSQL pool used for knowledge indexer transactions.
 *
 * The indexer always uses its dedicated login; unlike the legacy platform pool,
 * it never falls back to the application connection.
 *
 * @returns The shared `pg` pool bound to `INDEXER_DATABASE_URL`.
 * @throws Error `INDEXER_DATABASE_URL_REQUIRED` when the variable is unset or empty.
 */
export function getIndexerPool(): Pool {
  if (indexerPool === undefined) {
    const connectionString = process.env.INDEXER_DATABASE_URL;

    if (!connectionString) {
      throw new Error('INDEXER_DATABASE_URL_REQUIRED: refusing to open a database pool without INDEXER_DATABASE_URL.');
    }

    indexerPool = createConfiguredPool(connectionString);
  }

  return indexerPool;
}
