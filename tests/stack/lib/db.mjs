import { createRequire } from 'node:module';

import { readStackState } from './stack.mjs';

const requireRootDependency = createRequire(new URL('../../../package.json', import.meta.url));
const requireDatabaseDependency = createRequire(new URL('../../../packages/database/package.json', import.meta.url));
let requirePg = requireRootDependency;
try {
  requireRootDependency.resolve('pg');
} catch {
  requirePg = requireDatabaseDependency;
}
const STACK_SQL_CONNECT_TIMEOUT_MS = 10_000;
const STACK_SQL_QUERY_TIMEOUT_MS = 15_000;

export async function sql(text, params = []) {
  if (typeof text !== 'string' || !/^\s*(?:SELECT|WITH)\b/i.test(text) || /;\s*\S/.test(text)) {
    throw new TypeError('stack SQL diagnostics accept one read-only SELECT or WITH statement');
  }
  if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array');

  const { superDatabaseUrl } = readStackState();
  const { Client } = requirePg('pg');
  const client = new Client({
    connectionString: superDatabaseUrl,
    connectionTimeoutMillis: STACK_SQL_CONNECT_TIMEOUT_MS,
    query_timeout: STACK_SQL_QUERY_TIMEOUT_MS,
    statement_timeout: STACK_SQL_QUERY_TIMEOUT_MS,
  });
  await client.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN READ ONLY');
    transactionStarted = true;
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    try {
      if (transactionStarted) await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}
