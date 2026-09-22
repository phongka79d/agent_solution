import { packageName as adaptersPackageName } from '@agentos/adapters';
import { packageName as coreEnginePackageName } from '@agentos/core-engine';
import { packageName as databasePackageName } from '@agentos/database';
import { packageName as skillsPackageName } from '@agentos/skills';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerRoutes } from './routes/index.js';

export const DEFAULT_PORT = 4000;

/**
 * Workspace packages this gateway is allowed to depend on (02 §2 dependency DAG).
 * Exported so the health payload can prove the binding without calling into them.
 */
export const DEPENDENCIES: readonly string[] = [
  coreEnginePackageName,
  skillsPackageName,
  adaptersPackageName,
  databasePackageName,
];

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
    dependencies: [...DEPENDENCIES],
  }));

  registerRoutes(app);

  return app;
}

async function closeOnSignal(app: FastifyInstance): Promise<void> {
  try {
    await app.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

export async function startServer(): Promise<FastifyInstance> {
  const app = buildServer();
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;

  process.once('SIGINT', () => {
    void closeOnSignal(app);
  });
  process.once('SIGTERM', () => {
    void closeOnSignal(app);
  });

  await app.listen({ port, host: '0.0.0.0' });

  return app;
}
