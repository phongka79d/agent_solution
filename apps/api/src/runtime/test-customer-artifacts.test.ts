import { describe, expect, it, vi } from 'vitest';

import { createTestCustomerArtifactPurger } from './test-customer-artifacts.js';

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000011';
const OTHER_TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000012';
const CUSTOMER = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER_CUSTOMER = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5c';

 describe('TEST customer artifact cleanup', () => {
  it('purges exact tenant/customer Redis namespaces and Qdrant points', async () => {
    const scan = vi.fn(async (_cursor: string, pattern: string) => ({
      cursor: '0',
      keys: pattern.includes(':session:')
        ? [
            `tenant:${TENANT}:session:testlab-${CUSTOMER}-session:takeover_lock`,
            `tenant:${OTHER_TENANT}:session:testlab-${CUSTOMER}-session:takeover_lock`,
            `tenant:${TENANT}:session:testlab-${OTHER_CUSTOMER}-session:takeover_lock`,
          ]
        : [`tenant:${TENANT}:wm:testlab-${CUSTOMER}-session`],
    }));
    const del = vi.fn(async (_keys: readonly string[]) => 1);
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response('{"status":"ok"}', { status: 200 });
    };
    const purger = createTestCustomerArtifactPurger({
      redis: { scan, del },
      qdrantUrl: 'http://localhost:6333',
      qdrantApiKey: 'qdrant-test-key',
      fetcher,
    });

    await purger.purge({ tenant_id: TENANT, customer_ids: [CUSTOMER] });

    expect(scan).toHaveBeenNthCalledWith(1, '0', `tenant:${TENANT}:session:testlab-${CUSTOMER}-*`, 100);
    expect(scan).toHaveBeenNthCalledWith(2, '0', `tenant:${TENANT}:wm:testlab-${CUSTOMER}-*`, 100);
    expect(del).toHaveBeenNthCalledWith(1, [`tenant:${TENANT}:session:testlab-${CUSTOMER}-session:takeover_lock`]);
    expect(del).toHaveBeenNthCalledWith(2, [`tenant:${TENANT}:wm:testlab-${CUSTOMER}-session`]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'http://localhost:6333/collections/second_brain_knowledge/points/delete?wait=true',
    );
    expect(requests[0]?.init?.headers).toMatchObject({ 'api-key': 'qdrant-test-key' });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      filter: {
        must: [
          { key: 'tenant_id', match: { value: TENANT } },
          { key: 'customer_id', match: { value: CUSTOMER } },
        ],
      },
    });
  });

  it('refuses malformed tenant or customer identifiers before touching external stores', async () => {
    const scan = vi.fn(async () => ({ cursor: '0', keys: [] }));
    const del = vi.fn(async () => 0);
    const fetcher: typeof fetch = async () => new Response('', { status: 200 });
    const purger = createTestCustomerArtifactPurger({
      redis: { scan, del },
      qdrantUrl: 'http://localhost:6333',
      fetcher,
    });

    await expect(purger.purge({ tenant_id: TENANT, customer_ids: ['not-a-uuid'] })).rejects.toThrow(
      'TEST_DATA_ARTIFACT_SCOPE_INVALID',
    );
    expect(scan).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
