import { describe, expect, it } from 'vitest';
import openapi from '../../../../packages/api-contract/openapi.json';
import { TENANT_BFF_ROUTES } from './bff-routes';

const MUTATING_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };
const OPENAPI_METHODS: Record<string, true> = { get: true, post: true, put: true, patch: true, delete: true };
const OPENAPI_OPERATIONS = new Set<string>(
  Object.entries(openapi.paths).flatMap(([path, pathItem]) =>
    Object.keys(pathItem)
      .filter((method) => OPENAPI_METHODS[method] === true)
      .map((method) => `${method.toUpperCase()} ${path}`),
  ),
);

describe('tenant BFF route contracts', () => {
  it('keeps every table entry mapped to an OpenAPI operation and protects mutations with CSRF', () => {
    const operations = OPENAPI_OPERATIONS;
    for (const entry of TENANT_BFF_ROUTES) {
      const operation = `${entry.method} /api/v1/${entry.pattern.template}`;
      expect(operations.has(operation), operation).toBe(true);
      if (MUTATING_METHODS[entry.method]) expect(entry.csrf, operation).toBe(true);
    }
  });
});
