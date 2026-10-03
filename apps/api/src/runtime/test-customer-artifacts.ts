import { SECOND_BRAIN_COLLECTION } from '@agentos/database';
import type { RuntimeRedisClient } from '@agentos/core-engine';
import type { TestCustomerArtifactPort } from '../gateway/ports.js';

interface TestCustomerArtifactPurgerOptions {
  readonly redis?: Pick<RuntimeRedisClient, 'scan' | 'del'>;
  readonly qdrantUrl?: string;
  readonly qdrantApiKey?: string;
  readonly fetcher?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDIS_SCAN_COUNT = 100;

/** Deletes only session and working-memory keys minted under the Test Customer Lab session prefix. */
async function purgeRedisKeys(
  redis: Pick<RuntimeRedisClient, 'scan' | 'del'>,
  tenant_id: string,
  customer_id: string,
): Promise<void> {
  const tenantPrefix = `tenant:${encodeURIComponent(tenant_id)}:`;
  const patterns = [
    `${tenantPrefix}session:testlab-${customer_id}-*`,
    `${tenantPrefix}wm:testlab-${customer_id}-*`,
  ];

  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const page = await redis.scan(cursor, pattern, REDIS_SCAN_COUNT);
      const scopedKeys = page.keys.filter((key) => key.startsWith(pattern.slice(0, pattern.indexOf('*'))));
      await redis.del(scopedKeys);
      cursor = page.cursor;
    } while (cursor !== '0');
  }
}

function qdrantDeleteEndpoint(baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username !== '' || base.password !== '') {
    throw new Error('TEST_DATA_QDRANT_CONFIG_INVALID');
  }
  const endpoint = new URL(`/collections/${encodeURIComponent(SECOND_BRAIN_COLLECTION)}/points/delete`, base.origin);
  endpoint.searchParams.set('wait', 'true');
  return endpoint;
}

async function purgeQdrantPoints(
  input: { readonly tenant_id: string; readonly customer_id: string },
  options: TestCustomerArtifactPurgerOptions,
): Promise<void> {
  if (options.qdrantUrl === undefined || options.qdrantUrl.trim() === '') return;
  const endpoint = qdrantDeleteEndpoint(options.qdrantUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.qdrantApiKey !== undefined && options.qdrantApiKey !== '') {
    headers['api-key'] = options.qdrantApiKey;
  }
  const response = await (options.fetcher ?? fetch)(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filter: {
        must: [
          { key: 'tenant_id', match: { value: input.tenant_id } },
          { key: 'customer_id', match: { value: input.customer_id } },
        ],
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok && response.status !== 404) throw new Error('TEST_DATA_QDRANT_PURGE_FAILED');
}

/** Binds reset cleanup to server-selected TEST customer UUIDs, never caller-provided identifiers. */
export function createTestCustomerArtifactPurger(
  options: TestCustomerArtifactPurgerOptions = {},
): TestCustomerArtifactPort {
  return {
    async purge({ tenant_id, customer_ids }) {
      if (!UUID.test(tenant_id) || customer_ids.some((id) => !UUID.test(id))) {
        throw new Error('TEST_DATA_ARTIFACT_SCOPE_INVALID');
      }
      if (options.redis !== undefined) {
        for (const customer_id of customer_ids) {
          await purgeRedisKeys(options.redis, tenant_id, customer_id);
        }
      }
      for (const customer_id of customer_ids) {
        await purgeQdrantPoints({ tenant_id, customer_id }, options);
      }
    },
  };
}
