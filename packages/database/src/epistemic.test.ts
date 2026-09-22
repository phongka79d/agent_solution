import { afterEach, describe, expect, it } from 'vitest';

import type { EpistemicClass } from './contracts/index.js';
import { SOR_FACT_TABLES, assertEpistemicWrite } from './epistemic.js';
import { insertFact } from './repositories/customer-360.js';

const originalDatabaseUrl = process.env.DATABASE_URL;
const TENANT = '01920000-0000-7000-8000-00000000000a';

/** SoR mirrors: authoritative facts, therefore closed to HYPOTHESIS writes (FR-C360-003). */
const SOR_MIRROR_TABLES: readonly string[] = [
  'customers',
  'products',
  'skus',
  'prices',
  'inventories',
  'orders',
  'invoices',
];

const NON_HYPOTHESIS_CLASSES: readonly EpistemicClass[] = ['FACT', 'SIGNAL', 'DECISION', 'ACTION'];

/** Tables where a derived HYPOTHESIS is allowed to live, including the evidence sink. */
const HYPOTHESIS_TABLES: readonly string[] = [
  'evidences',
  'customer_events',
  'conversations',
  'conversation_messages',
  'recommendations',
  'leads',
  'segments',
];

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }

  return undefined;
}

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe('assertEpistemicWrite', () => {
  it('names exactly the seven SoR mirror tables', () => {
    expect([...SOR_FACT_TABLES].sort()).toEqual([...SOR_MIRROR_TABLES].sort());
  });

  it('allows a FACT write to every SoR mirror table', () => {
    for (const table of SOR_MIRROR_TABLES) {
      expect(() => assertEpistemicWrite('FACT', table)).not.toThrow();
    }
  });

  it('refuses a HYPOTHESIS write to every SoR mirror table', () => {
    for (const table of SOR_MIRROR_TABLES) {
      expect(() => assertEpistemicWrite('HYPOTHESIS', table)).toThrow('HYPOTHESIS_PROMOTION_REFUSED');
    }
  });

  it('allows SIGNAL, DECISION and ACTION writes to SoR mirror tables', () => {
    for (const epistemicClass of NON_HYPOTHESIS_CLASSES) {
      for (const table of SOR_MIRROR_TABLES) {
        expect(() => assertEpistemicWrite(epistemicClass, table)).not.toThrow();
      }
    }
  });

  it('allows a HYPOTHESIS in evidence and other non-mirror tables', () => {
    for (const table of HYPOTHESIS_TABLES) {
      expect(() => assertEpistemicWrite('HYPOTHESIS', table)).not.toThrow();
    }
  });
});

describe('insertFact epistemic guard (no PostgreSQL required)', () => {
  it('refuses a HYPOTHESIS-shaped customer fact before the pool is touched', async () => {
    delete process.env.DATABASE_URL;

    const failure = await captureFailure(() =>
      insertFact(TENANT, {
        display_name: 'fixture-hypothesis',
        rfm_segment_hypothesis: 'champion',
      }),
    );

    expect(String(failure)).toContain('HYPOTHESIS_PROMOTION_REFUSED');
    expect(String(failure)).not.toContain('DATABASE_URL_REQUIRED');
  });

  it('passes a plain customer fact through the epistemic guard', async () => {
    delete process.env.DATABASE_URL;

    const failure = await captureFailure(() =>
      insertFact(TENANT, { display_name: 'fixture-fact', order_count: 0 }),
    );

    // The only thing standing between a clean FACT write and the database is the pool.
    expect(String(failure)).toContain('DATABASE_URL_REQUIRED');
    expect(String(failure)).not.toContain('HYPOTHESIS_PROMOTION_REFUSED');
  });
});
