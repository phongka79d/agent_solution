import { Pool } from 'pg';

let pool: Pool | undefined;

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

    pool = new Pool({ connectionString });
  }

  return pool;
}
