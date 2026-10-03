import type { FastifyInstance } from 'fastify';

/**
 * The offline composition used by `openapi-emit.mjs` and the contract test. Declared here because
 * the module is plain JavaScript (loaded by node and vitest alike).
 */
export declare function createOfflineApp(input: {
  readonly buildServer: (deps: never, options?: { readonly loggerStream?: NodeJS.WritableStream }) => FastifyInstance;
  readonly KnowledgeRepository: new () => unknown;
}): FastifyInstance;
