import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakePools = vi.hoisted(() => {
  const configurations: Array<{
    connectionString: string;
    statement_timeout: number;
    idle_in_transaction_session_timeout: number;
  }> = [];
  return { configurations };
});

vi.mock('pg', () => ({
  Pool: class {
    constructor(options: {
      connectionString: string;
      statement_timeout: number;
      idle_in_transaction_session_timeout: number;
    }) {
      fakePools.configurations.push(options);
    }
  },
}));

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPlatformDatabaseUrl = process.env.PLATFORM_DATABASE_URL;
const originalIndexerDatabaseUrl = process.env.INDEXER_DATABASE_URL;
const originalStatementTimeout = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
const originalIdleTransactionTimeout = process.env.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS;

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('database pool security boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    fakePools.configurations.length = 0;
    delete process.env.DATABASE_URL;
    delete process.env.PLATFORM_DATABASE_URL;
    delete process.env.INDEXER_DATABASE_URL;
    delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    delete process.env.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS;
  });

  afterEach(() => {
    restoreEnvironment('DATABASE_URL', originalDatabaseUrl);
    restoreEnvironment('PLATFORM_DATABASE_URL', originalPlatformDatabaseUrl);
    restoreEnvironment('INDEXER_DATABASE_URL', originalIndexerDatabaseUrl);
    restoreEnvironment('DATABASE_STATEMENT_TIMEOUT_MS', originalStatementTimeout);
    restoreEnvironment('DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS', originalIdleTransactionTimeout);
  });

  // Dynamic imports keep the per-case pool singleton isolated after each test sets its environment.
  it('applies configured query timeouts to all separately configured pools', async () => {
    process.env.DATABASE_URL = 'postgresql://agentos_app:app-pass@db/app';
    process.env.PLATFORM_DATABASE_URL = 'postgresql://agentos_platform_login:platform-pass@db/app';
    process.env.INDEXER_DATABASE_URL = 'postgresql://agentos_indexer_login:indexer-pass@db/app';
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '12000';
    process.env.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = '45000';
    const { getIndexerPool, getPlatformPool, getPool } = await import('./client.js');

    const indexerPool = getIndexerPool();
    const platformPool = getPlatformPool();

    expect(indexerPool).not.toBe(platformPool);
    expect(indexerPool).not.toBe(getPool());
    expect(getIndexerPool()).toBe(indexerPool);
    expect(getPlatformPool()).toBe(platformPool);
    expect(fakePools.configurations).toEqual([
      {
        connectionString: 'postgresql://agentos_indexer_login:indexer-pass@db/app',
        statement_timeout: 12000,
        idle_in_transaction_session_timeout: 45000,
      },
      {
        connectionString: 'postgresql://agentos_platform_login:platform-pass@db/app',
        statement_timeout: 12000,
        idle_in_transaction_session_timeout: 45000,
      },
      {
        connectionString: 'postgresql://agentos_app:app-pass@db/app',
        statement_timeout: 12000,
        idle_in_transaction_session_timeout: 45000,
      },
    ]);
  });

  it('uses safe timeout defaults on the shared app pool when the platform URL is unset', async () => {
    process.env.DATABASE_URL = 'postgresql://agentos_app:app-pass@db/app';
    const { getPlatformPool, getPool } = await import('./client.js');

    expect(getPlatformPool()).toBe(getPool());
    expect(fakePools.configurations).toEqual([{
      connectionString: 'postgresql://agentos_app:app-pass@db/app',
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
    }]);
  });

  it('refuses to share the application pool when no dedicated indexer URL is configured', async () => {
    process.env.DATABASE_URL = 'postgresql://agentos_app:app-pass@db/app';
    const { getIndexerPool } = await import('./client.js');

    expect(() => getIndexerPool()).toThrow('INDEXER_DATABASE_URL_REQUIRED');
    expect(fakePools.configurations).toEqual([]);
  });
});
