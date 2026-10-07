import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import {
  NOVAMART_TENANT_ID,
  loadDemoPack,
  mapDemoServiceCase,
  stableUuid,
  validateDemoEnvironment,
  validateDemoPack,
} from './seed.mjs';
import { isMainModule } from './lib/main-module.mjs';

const VALID_ENV = Object.freeze({
  APP_ENV: 'local',
  DEMO_MODE: 'true',
  DEMO_TENANT_ID: NOVAMART_TENANT_ID,
  DATABASE_URL: 'postgresql://localhost:5432/agentos_dev',
});

describe('scripts/demo main-module helper', () => {
  it('detects POSIX-style and Windows-style argv paths and rejects mismatches', () => {
    const nativePath = fileURLToPath(new URL('./seed.mjs', import.meta.url));
    const posixPath = nativePath.replaceAll('\\', '/');
    const windowsPath = nativePath.replaceAll('/', '\\');

    for (const argvPath of [posixPath, windowsPath]) {
      const matchingUrl = pathToFileURL(argvPath).href;
      assert.equal(isMainModule(matchingUrl, argvPath), true);
      assert.equal(isMainModule(`${matchingUrl}.mismatch`, argvPath), false);
    }

    assert.equal(isMainModule(pathToFileURL(nativePath).href, undefined), false);
  });
});

describe('scripts/demo/seed pure helpers', () => {
  it('accepts local and ci DEMO_MODE gate for the canonical NovaMart tenant', () => {
    assert.doesNotThrow(() => validateDemoEnvironment({ ...VALID_ENV, APP_ENV: 'local' }));
    assert.doesNotThrow(() => validateDemoEnvironment({ ...VALID_ENV, APP_ENV: 'ci' }));
  });

  it('rejects production/non-demo profiles, mismatched tenant, and missing database URL', () => {
    for (const appEnv of ['production', 'staging', 'sandbox', '', undefined]) {
      assert.throws(
        () => validateDemoEnvironment({ ...VALID_ENV, APP_ENV: appEnv }),
        /DEMO_SEED_FORBIDDEN/,
      );
    }

    for (const demoMode of ['false', '1', '', undefined]) {
      assert.throws(
        () => validateDemoEnvironment({ ...VALID_ENV, DEMO_MODE: demoMode }),
        /DEMO_SEED_FORBIDDEN/,
      );
    }

    for (const tenantId of ['00000000-0000-4000-8000-000000000001', '', undefined]) {
      assert.throws(
        () => validateDemoEnvironment({ ...VALID_ENV, DEMO_TENANT_ID: tenantId }),
        /DEMO_TENANT_MISMATCH/,
      );
    }

    for (const dbUrl of ['', '   ', undefined]) {
      assert.throws(
        () => validateDemoEnvironment({ ...VALID_ENV, DATABASE_URL: dbUrl }),
        /DATABASE_URL_REQUIRED/,
      );
    }
  });

  it('validates NovaMart pack counts, provenance, and canonical C05/C08/C12 scenario facts', async () => {
    const pack = await loadDemoPack();

    assert.equal(pack.pack_version, 'novamart-demo-v1');
    assert.equal(pack.tenant_id, NOVAMART_TENANT_ID);
    assert.equal(pack.demo_as_of, '2026-09-28T00:00:00Z');
    assert.equal(pack.products.length, 24);
    assert.equal(pack.skus.length, 28);
    assert.equal(pack.customers.length, 12);
    assert.equal(pack.orders.length, 20);
    assert.equal(pack.events.length, 53);
    assert.equal(pack.segments.length, 2);
    assert.equal(pack.campaigns.length, 1);
    assert.equal(pack.engagement_events.length, 8);
    assert.equal(pack.cases.length, 4);

    const byCode = Object.fromEntries(pack.customers.map((c) => [c.customer_code, c]));
    const inactive = pack.segments.find((s) => s.segment_id === 'inactive90');

    assert.equal(byCode.C05.customer_tier, 'GOLD');
    assert.equal(byCode.C05.consent.email_marketing, true);
    assert.equal(byCode.C05.web_chat_identity.verified, true);
    assert.deepEqual(inactive.member_customer_ids, [byCode.C05.customer_id]);

    assert.equal(byCode.C08.consent.email_marketing, false);
    assert.ok(inactive.excluded_customer_ids.includes(byCode.C08.customer_id));

    assert.equal(byCode.C12.consent.email_marketing, false);
    assert.equal(byCode.C12.consent.service_chat, false);
    assert.equal(byCode.C12.web_chat_identity.verified, false);
    assert.ok(inactive.excluded_customer_ids.includes(byCode.C12.customer_id));

    assert.throws(
      () => validateDemoPack({ ...structuredClone(pack), pack_version: 'tampered' }),
      /DEMO_PACK_INVALID/,
    );
    assert.throws(
      () => validateDemoPack({ ...structuredClone(pack), products: pack.products.slice(1) }),
      /DEMO_PACK_INVALID/,
    );

    const brokenC05 = structuredClone(pack);
    brokenC05.customers.find((c) => c.customer_code === 'C05').customer_tier = 'BASIC';
    assert.throws(() => validateDemoPack(brokenC05), /DEMO_PACK_INVALID/);

    const brokenC08 = structuredClone(pack);
    brokenC08.customers.find((c) => c.customer_code === 'C08').consent.email_marketing = true;
    assert.throws(() => validateDemoPack(brokenC08), /DEMO_PACK_INVALID/);

    const brokenC12 = structuredClone(pack);
    brokenC12.customers.find((c) => c.customer_code === 'C12').web_chat_identity.verified = true;
    assert.throws(() => validateDemoPack(brokenC12), /DEMO_PACK_INVALID/);
  });

  it('produces deterministic UUIDs via stableUuid and differentiates distinct keys/kinds', () => {
    const first = stableUuid('sku', 'NM-L01-BLK');
    const second = stableUuid('sku', 'NM-L01-BLK');
    const differentKey = stableUuid('sku', 'NM-L01-GRY');
    const differentKind = stableUuid('price', 'NM-L01-BLK');

    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first, differentKey);
    assert.notEqual(first, differentKind);
  });

  it('maps pack case statuses, priorities, and escalated truth to canonical service_cases columns', async () => {
    const pack = await loadDemoPack();
    const mapped = Object.fromEntries(pack.cases.map((item) => [item.case_id, mapDemoServiceCase(item)]));

    assert.equal(mapped['CASE-DEMO-001'].state, 'NEW');
    assert.equal(mapped['CASE-DEMO-001'].priority, 'P3');
    assert.equal(mapped['CASE-DEMO-001'].category, 'demo');
    assert.equal(mapped['CASE-DEMO-001'].assigned_human_id, null);

    assert.equal(mapped['CASE-DEMO-002'].state, 'WAITING_CUSTOMER');
    assert.equal(mapped['CASE-DEMO-002'].priority, 'P2');
    assert.equal(mapped['CASE-DEMO-002'].category, 'escalated');
    assert.equal(mapped['CASE-DEMO-002'].assigned_human_id, 'awaiting_human');

    assert.equal(mapped['CASE-DEMO-003'].state, 'RESOLVED');
    assert.equal(mapped['CASE-DEMO-003'].priority, 'P4');
    assert.equal(mapped['CASE-DEMO-003'].category, 'demo');
    assert.equal(mapped['CASE-DEMO-003'].assigned_human_id, null);

    assert.equal(mapped['CASE-DEMO-004'].state, 'NEW');
    assert.equal(mapped['CASE-DEMO-004'].priority, 'P3');

    const urgentCase = mapDemoServiceCase({
      ...pack.cases[0],
      status: 'open',
      priority: 'urgent',
      escalated: true,
      handoff_status: 'operator_queue',
    });
    assert.equal(urgentCase.state, 'NEW');
    assert.equal(urgentCase.priority, 'P1');
    assert.equal(urgentCase.category, 'escalated');
    assert.equal(urgentCase.assigned_human_id, 'operator_queue');

    assert.throws(
      () => mapDemoServiceCase({ ...pack.cases[0], status: 'invalid_status' }),
      /DEMO_PACK_INVALID/,
    );
    assert.throws(
      () => mapDemoServiceCase({ ...pack.cases[0], priority: 'invalid_priority' }),
      /DEMO_PACK_INVALID/,
    );
  });

  it('keeps canonical migrations generic and fences demo bootstrap in one replay-safe transaction', async () => {
    const migrationDirectory = new URL('../../packages/database/migrations/', import.meta.url);
    const migrationNames = await readdir(migrationDirectory);
    assert.equal(migrationNames.includes('0008_demo_novamart_bootstrap.sql'), false);

    const migrationSql = (await Promise.all(
      migrationNames
        .filter((name) => name.endsWith('.sql'))
        .map((name) => readFile(new URL(name, migrationDirectory), 'utf8')),
    )).join('\n');
    assert.doesNotMatch(migrationSql, /NovaMart|provision_novamart_demo_tenant|99999999-9999-4999-8999-999999999999/i);
    assert.match(migrationSql, /provision_tenant_shell_for_id/);
    assert.match(migrationSql, /ON CONFLICT DO NOTHING/);

    const seedSource = await readFile(new URL('./seed.mjs', import.meta.url), 'utf8');
    assert.match(seedSource, /provision_tenant_shell_for_id/);
    assert.match(seedSource, /BEGIN/);
    assert.match(seedSource, /COMMIT/);
    assert.match(seedSource, /ROLLBACK/);
    assert.doesNotMatch(seedSource, /provision_novamart_demo_tenant/);
  });

  it('binds exact-tenant RLS in seed source without BYPASSRLS or multi-tenant settings', async () => {
    const source = await readFile(new URL('./seed.mjs', import.meta.url), 'utf8');

    assert.match(source, /SET LOCAL ROLE agentos_app/);
    assert.match(
      source,
      /client\.query\(\s*"SELECT set_config\('app\.current_tenant_id', \$1, true\)"\s*,\s*\[NOVAMART_TENANT_ID\]\s*\)/,
    );
    assert.doesNotMatch(source, /BYPASSRLS/i);
    assert.doesNotMatch(source, /app\.current_tenant_ids/i);
    assert.doesNotMatch(source, /row_security\s*=\s*off/i);
  });
});
