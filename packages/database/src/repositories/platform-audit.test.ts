import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { appendConfigAudit, PlatformAuditRepository } from './platform-audit.js';
import type { PlatformAuditRow } from './platform-audit.js';

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000002';
interface MockQuery {
  readonly mock: {
    readonly calls: readonly (readonly [string, unknown[]])[];
  };
}

function digest(seq: number): string {
  return seq.toString(16).padStart(64, '0');
}

/**
 * A coherent chain link: its `hash` reproduces its own payload, and its `prev_hash` is the
 * predecessor's hash, so a page of consecutive links verifies unless a test tampers with one.
 */
function row(chain_seq: string): PlatformAuditRow {
  const seq = Number(chain_seq);
  return {
    event_id: `event-${chain_seq}`,
    chain_seq,
    prev_hash: digest(seq - 1),
    hash: digest(seq),
    recomputed_hash: digest(seq),
    actor_kind: 'OPERATOR',
    actor_id: 'operator-1',
    scope: 'COMPANY',
    action: 'settings.update',
    tenant_id: TENANT,
    target: 'tenant_settings',
    outcome: 'ACCEPTED',
    reason: null,
    before_state: { enabled: false },
    after_state: { enabled: true },
    correlation_id: 'corr-1',
    created_at: new Date('2026-09-30T12:00:00.000Z'),
  };
}

describe('PlatformAuditRepository', () => {
  it('paginates tenant audit rows through the tenant view and emits the oldest returned sequence as the next cursor', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [row('10'), row('9'), row('8')] })),
    } as unknown as PoolClient;
    const tenantTransactions: string[] = [];
    const tenantTransaction = async <T>(
      tenant_id: string,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      tenantTransactions.push(tenant_id);
      return work(client);
    };
    const repository = new PlatformAuditRepository({ tenantTransaction });

    const page = await repository.listForTenant(TENANT, { cursor: '11', limit: 2, scope: 'company.profile' });

    expect(tenantTransactions).toEqual([TENANT]);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as unknown as MockQuery).mock.calls[0]!;
    expect(sql).toContain('FROM agentos.tenant_audit_events');
    expect(values).toEqual([TENANT, 'company.profile', '11', 3]);
    expect(page.items.map((event) => event.chain_seq)).toEqual(['10', '9']);
    expect(page.next_cursor).toBe('9');
    expect(page.chain_verified).toBe(true);
    expect(page.items[0]?.created_at).toBe('2026-09-30T12:00:00.000Z');
  });

  it('filters platform history by tenant and paginates using the global sequence cursor', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [row('5'), row('4')] })),
    } as unknown as PoolClient;
    let platformTransactionCalled = false;
    const platformTransaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
      platformTransactionCalled = true;
      return work(client);
    };
    const repository = new PlatformAuditRepository({ platformTransaction });

    const page = await repository.listForPlatform({ tenant_id: TENANT, scope: 'PLATFORM', cursor: '6', limit: 1 });

    expect(platformTransactionCalled).toBe(true);
    const [sql, values] = (client.query as unknown as MockQuery).mock.calls[0]!;
    expect(sql).toContain('FROM agentos.platform_audit_events');
    expect(values).toEqual([TENANT, 'PLATFORM', '6', 2]);
    expect(page.items.map((event) => event.chain_seq)).toEqual(['5']);
    expect(page.items[0]?.tenant_id).toBe(TENANT);
    expect(page.next_cursor).toBe('5');
    expect(page.chain_verified).toBe(true);
  });

  it('calls the database audit writer using the caller transaction and already-redacted projections', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ event_id: 'event-1' }] })),
    } as unknown as PoolClient;

    const event_id = await appendConfigAudit(client, {
      actor_kind: 'OPERATOR',
      actor_id: 'operator-1',
      scope: 'COMPANY',
      action: 'settings.update',
      target_tenant: TENANT,
      target: 'tenant_settings',
      outcome: 'ACCEPTED',
      reason: 'operator request',
      before: { enabled: false },
      after: { enabled: true },
      correlation_id: 'corr-1',
    });

    expect(event_id).toBe('event-1');
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as unknown as MockQuery).mock.calls[0]!;
    expect(sql).toContain('agentos.platform_append_audit');
    expect(values).toEqual([
      'OPERATOR', 'operator-1', 'COMPANY', 'settings.update', TENANT, 'tenant_settings',
      'ACCEPTED', 'operator request', '{"enabled":false}', '{"enabled":true}', 'corr-1',
    ]);
  });

  it('reports the page as unverified when a stored hash no longer reproduces its payload', async () => {
    const tampered = { ...row('10'), recomputed_hash: digest(999) };
    const client = {
      query: vi.fn(async () => ({ rows: [tampered, row('9')] })),
    } as unknown as PoolClient;
    const repository = new PlatformAuditRepository({
      tenantTransaction: async <T>(_tenant_id: string, work: (client: PoolClient) => Promise<T>): Promise<T> => work(client),
    });

    const page = await repository.listForTenant(TENANT, { limit: 2 });

    expect(page.items.map((event) => event.chain_seq)).toEqual(['10', '9']);
    expect(page.chain_verified).toBe(false);
  });

  it('reports the page as unverified when a link no longer points at its predecessor', async () => {
    const broken = { ...row('10'), prev_hash: digest(1234) };
    const client = {
      query: vi.fn(async () => ({ rows: [broken, row('9')] })),
    } as unknown as PoolClient;
    const repository = new PlatformAuditRepository({
      platformTransaction: async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => work(client),
    });

    const page = await repository.listForPlatform({ limit: 2 });

    expect(page.chain_verified).toBe(false);
  });

  it('treats an empty page as verified rather than as a chain break', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PoolClient;
    const repository = new PlatformAuditRepository({
      tenantTransaction: async <T>(_tenant_id: string, work: (client: PoolClient) => Promise<T>): Promise<T> => work(client),
    });

    const page = await repository.listForTenant(TENANT);

    expect(page.items).toEqual([]);
    expect(page.chain_verified).toBe(true);
  });
});
