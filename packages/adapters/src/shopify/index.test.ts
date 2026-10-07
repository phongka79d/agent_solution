import { describe, expect, it } from 'vitest';

import {
  ShopifyAdminClient,
  issueShopifyInstallState,
  verifyShopifyCallback,
  verifyShopifyWebhook,
} from './index.js';

function mockHmac(secret: string, material: string): string {
  return `${secret}:${material}`;
}

function installationStore() {
  const rows = new Map<string, { tenant_id: string; shop: string; credential_ref: string; installed_at: string; revoked_at: string | null }>();
  return {
    rows,
    find: ({ tenant_id, shop }: { tenant_id: string; shop: string }) => rows.get(`${tenant_id}:${shop}`) ?? null,
    findByShop: (shop: string) => [...rows.values()].find((row) => row.shop === shop) ?? null,
    save: (row: (typeof rows extends Map<string, infer T> ? T : never)) => { rows.set(`${row.tenant_id}:${row.shop}`, row); },
    revoke: ({ tenant_id, shop, revoked_at }: { tenant_id: string; shop: string; revoked_at: string }) => {
      const row = rows.get(`${tenant_id}:${shop}`);
      if (row !== undefined) rows.set(`${tenant_id}:${shop}`, { ...row, revoked_at });
    },
  };
}

describe('Shopify adapter', () => {
  it('stores only a digest for OAuth state', async () => {
    const records: Array<{ state_hash: string }> = [];
    let rawSeen = false;
    const rawState = 'oauth-state-only-in-memory';
    await issueShopifyInstallState({
      tenant_id: 'tenant-1',
      shop: 'shop.myshopify.com',
      raw_state: rawState,
      hash_state: (value) => { rawSeen = value === rawState; return 'digest'; },
      now: '2026-01-01T00:00:00Z',
      expires_at: '2026-01-01T00:05:00Z',
      store: { put: (record) => { records.push({ state_hash: record.state_hash }); } , consume: () => true },
    });
    expect(rawSeen).toBe(true);
    expect(records).toEqual([{ state_hash: 'digest' }]);
    expect(records[0]).not.toHaveProperty('raw_state');
  });

  it('hashes the callback state before consuming it, so mismatched raw state is refused', async () => {
    let consumedHash = '';
    const result = await verifyShopifyCallback({
      tenant_id: 'tenant-1',
      shop: 'shop.myshopify.com',
      state: 'different-raw-state',
      signed_material: 'query',
      provided_signature: 'secret:query',
      client_secret_ref: 'client-secret',
      secret_resolver: { resolve: () => 'secret' },
      hash_state: (value) => `hash:${value}`,
      hmac: mockHmac,
      state_store: {
        put: () => undefined,
        consume: ({ state_hash }) => { consumedHash = state_hash; return state_hash === 'hash:expected-state'; },
      },
    });
    expect(result).toEqual({ ok: false, reason: 'STATE_REPLAYED' });
    expect(consumedHash).toBe('hash:different-raw-state');
  });

  it('fails a webhook closed before replay claim when the shop is unbound', async () => {
    let claims = 0;
    const result = await verifyShopifyWebhook({
      tenant_id: 'tenant-1',
      shop: 'unknown.myshopify.com',
      delivery_id: 'delivery-1',
      raw_body: '{}',
      provided_signature: 'secret:{}',
      webhook_secret_ref: 'ref',
      secret_resolver: { resolve: () => 'secret' },
      hmac: mockHmac,
      installations: { find: () => null, findByShop: () => null, save: () => undefined, revoke: () => undefined },
      replay: { claim: () => { claims += 1; return true; } },
    });
    expect(result).toEqual({ ok: false, reason: 'SHOP_BINDING_MISMATCH' });
    expect(claims).toBe(0);
  });

  it('never leaks a missing raw credential in errors', async () => {
    const stores = installationStore();
    stores.rows.set('tenant-1:shop.myshopify.com', {
      tenant_id: 'tenant-1', shop: 'shop.myshopify.com', credential_ref: 'secret-ref', installed_at: 'now', revoked_at: null,
    });
    const client = new ShopifyAdminClient({
      installations: stores,
      secret_resolver: { resolve: () => null },
      transport: { execute: async () => ({ ok: true, status: 200, body: {}, observed_at: 'now' }) },
    });
    await expect(client.query({ tenant_id: 'tenant-1', shop: 'shop.myshopify.com', query: 'query {}' }))
      .rejects.toMatchObject({ refusal_code: 'SECRET_UNAVAILABLE' });
  });
});
