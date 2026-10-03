import { buildServer } from '../dist/server.js';
import { KnowledgeRepository } from '@agentos/database';

const noopAsync = async () => undefined;
const noopPort = new Proxy({}, { get: () => noopAsync });
const runtime = new Proxy(
  { audit: { record: noopAsync }, clock: () => new Date(0), ids: () => 'x' },
  { get: (t, p) => (p in t ? t[p] : noopPort) },
);
const credentials = { resolveOperator: () => null, resolveConversationSession: () => null, resolveWidgetSession: () => null };
const companySources = { approvals: [], handoffs: [], connectors: [], owner_inputs: [], reconciliations: [], agents: [], runs_today: [], activity: [] };
const app = buildServer({
  runtime,
  credentials,
  platform: { listTenants: async () => [], getTenant: async () => null, readiness: async () => null, usage: async () => [] },
  providers: { list: async () => [] },
  companyProjections: { getSources: async () => companySources },
  knowledge: new KnowledgeRepository(),
});
await app.ready();
process.stdout.write(app.printRoutes({ commonPrefix: false }));
await app.close();
