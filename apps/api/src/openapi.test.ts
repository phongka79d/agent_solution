import { readFile } from 'node:fs/promises';

import { KnowledgeRepository } from '@agentos/database';
import { describe, expect, it } from 'vitest';

import { createOfflineApp } from '../scripts/openapi-composition.mjs';
import { buildServer } from './server.js';

interface OpenApiDocument {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

describe('emitted OpenAPI document', () => {
  it('documents every route registered by the offline API composition', async () => {
    const app = createOfflineApp({ buildServer, KnowledgeRepository });
    const routes: { readonly method: string; readonly path: string }[] = [];
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) routes.push({ method, path: route.url });
    });

    try {
      await app.ready();
      const document = JSON.parse(
        await readFile(new URL('../../../packages/api-contract/openapi.json', import.meta.url), 'utf8'),
      ) as OpenApiDocument;
      const paths = document.paths ?? {};
      const apiRoutes = routes.filter(({ path }) => path.startsWith('/api/v1'));
      expect(apiRoutes.length).toBeGreaterThan(0);

      const missingRoutes: string[] = [];
      for (const { method, path } of apiRoutes) {
        const openApiPath = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        const pathOperations = paths[openApiPath];
        if (pathOperations === undefined) {
          missingRoutes.push(`${method} ${openApiPath} (path)`);
          continue;
        }
        const methodName = method.toLowerCase();
        // Fastify's automatic HEAD handler shares GET semantics, which OpenAPI records as `get`.
        const documentedMethod = methodName === 'head' && pathOperations.head === undefined ? 'get' : methodName;
        if (!Object.prototype.hasOwnProperty.call(pathOperations, documentedMethod)) {
          missingRoutes.push(`${method} ${openApiPath} (operation)`);
        }
      }
      expect(missingRoutes).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

