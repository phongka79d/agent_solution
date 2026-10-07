import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface OpenApiDocument {
  readonly paths?: Readonly<Record<string, unknown>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> };
}

const OPENAPI_PATHS = [
  '/api/v1/company/overview',
  '/api/v1/company/attention',
  '/api/v1/company/ai-team',
  '/api/v1/company/activity',
  '/api/v1/company/integrations',
  '/api/v1/company/settings/governance',
  '/api/v1/platform/tenants',
  '/api/v1/platform/tenants/{id}',
  '/api/v1/platform/tenants/{id}/readiness',
  '/api/v1/platform/usage',
  '/api/v1/platform/providers',
  '/api/v1/approvals',
  '/api/v1/approvals/{approval_id}',
  '/api/v1/approvals/{approval_id}/decision',
] as const;

describe('emitted OpenAPI document', () => {
  it('contains the company, platform, and approval contract paths', async () => {
    const document = JSON.parse(
      await readFile(new URL('../../../packages/api-contract/openapi.json', import.meta.url), 'utf8'),
    ) as OpenApiDocument;
    const paths = document.paths ?? {};

    for (const path of OPENAPI_PATHS) expect(paths).toHaveProperty(path);
    expect(document.components?.schemas ?? {}).toHaveProperty('CompanyGovernanceResponse');
  });
});
