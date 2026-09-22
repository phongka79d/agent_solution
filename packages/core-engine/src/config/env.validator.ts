/**
 * Type surface for the Gate P0 environment validator.
 *
 * The runtime implementation is `./env.validator.mjs` — not this file:
 * - the Gate P0 images run Node 20 (`node:20-alpine`) with no compile step, and Node 20
 *   cannot import TypeScript, so no `.ts` module may sit on a runtime import path;
 * - `zod` is not installed. The blueprint schema in
 *   `implement/01-tech-stack-and-environment.md` §4 is the design source for the rules, not a
 *   dependency, so a compiled TypeScript validator could not run in these images either.
 *
 * Runtime consumers import the JavaScript module directly:
 *
 * ```ts
 * import { parseEnvironment, validateEnvironment, isPlaceholder } from './env.validator.mjs';
 * import type { Environment, ParseResult } from './env.validator'; // types from this file
 * ```
 *
 * Keep this file in sync with `env.validator.mjs`; it exists so TypeScript callers get the
 * parsed-environment shape without adding a build step. Fail-closed rules it mirrors:
 * `APP_ENV` selects the profile and has no default, `NODE_ENV` is the runtime mode only,
 * managed profiles refuse placeholder/mock values, and issue messages never carry the
 * rejected value.
 */

export type AppEnv = 'local' | 'ci' | 'staging' | 'sandbox' | 'production';
export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type StorageProvider = 's3' | 'r2' | 'local';
export type PaypalMode = 'sandbox' | 'live';

/** A single validation failure. `path` is the variable name; `message` names it and never prints its value. */
export interface EnvironmentIssue {
  path: string;
  message: string;
}

/** Options for both entry points. `requireNodeEnv: false` relaxes NODE_ENV for non api/worker consumers. */
export interface ParseOptions {
  requireNodeEnv?: boolean;
}

/** Validated configuration with defaults applied and numbers coerced. Optional sets appear only when complete. */
export interface Environment {
  APP_ENV: AppEnv;
  NODE_ENV?: NodeEnv;
  PORT: number;
  SERVICE_NAME: string;

  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  INTERNAL_API_KEY: string;
  WEBHOOK_HMAC_SECRET: string;
  AUDIT_HMAC_SECRET: string;
  ENCRYPTION_KEY_AES256: string;

  DATABASE_URL: string;
  DATABASE_POOL_MIN: number;
  DATABASE_POOL_MAX: number;
  POSTGRES_PRIMARY_URL?: string;
  POSTGRES_REPLICA_URL?: string;

  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD: string;
  REDIS_DB: number;
  REDIS_KEY_PREFIX: string;
  SESSION_MUTEX_TTL_SECONDS: number;
  IDEMPOTENCY_TTL_SECONDS: number;

  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  EMBEDDING_DIMENSIONS: number;

  OPENAI_API_KEY: string;
  PRIMARY_REASONING_MODEL: string;
  FAST_COMPLETION_MODEL: string;

  ERP_API_BASE_URL: string;
  ERP_TIMEOUT_MS: number;
  EVENT_INGESTION_BASE_URL: string;
  EVENT_INGESTION_HMAC_SECRET: string;
  API_BASE_URL: string;
  WEB_BASE_URL: string;
  CORS_ALLOWED_ORIGINS: string;

  LOG_LEVEL: LogLevel;
  MOCK_ERP_ENABLED: boolean;
  STORAGE_PROVIDER: StorageProvider;
  PAYPAL_MODE?: PaypalMode;

  TEMPORAL_ADDRESS?: string;
  TEMPORAL_NAMESPACE?: string;

  // Optional adapter credential sets: present only as a complete set, never defaulted.
  LINE_CHANNEL_ID?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_WEBHOOK_SIGNING_KEY?: string;
  SMS_PROVIDER?: string;
  SMS_API_KEY?: string;
  SMS_WEBHOOK_SIGNING_KEY?: string;
  ECPAY_MERCHANT_ID?: string;
  ECPAY_HASH_KEY?: string;
  ECPAY_HASH_IV?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export type ParseResult = { ok: true; data: Environment } | { ok: false; issues: EnvironmentIssue[] };

/** `env.validator.mjs#parseEnvironment` — collects every issue, never throws. */
export type ParseEnvironment = (env?: Record<string, unknown>, options?: ParseOptions) => ParseResult;

/** `env.validator.mjs#validateEnvironment` — prints the fail-closed report to stderr and exits 1 on any issue. */
export type ValidateEnvironment = (env?: Record<string, unknown>, options?: ParseOptions) => Environment;

/** `env.validator.mjs#isPlaceholder` — pure placeholder/mock check for a single value. */
export type IsPlaceholder = (value: unknown) => boolean;
