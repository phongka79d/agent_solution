import { afterEach, describe, expect, it } from 'vitest';

import { getPool } from './client.js';

const originalDatabaseUrl = process.env.DATABASE_URL;

describe('getPool rehearsal (no PostgreSQL required)', () => {
  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('fails closed when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;

    expect(() => getPool()).toThrow('DATABASE_URL_REQUIRED');
  });
});
