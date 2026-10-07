import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../dist/server.js';

const noopAsync = async () => undefined;
const noopPort = new Proxy({}, { get: () => noopAsync });
const runtime = new Proxy(
  {
    audit: { record: noopAsync },
    clock: () => new Date(0),
    ids: () => 'openapi-offline-correlation',
  },
  { get: (target, property) => (property in target ? target[property] : noopPort) },
);
const credentials = {
  resolveOperator: () => null,
  resolveConversationSession: () => null,
  resolveWidgetSession: () => null,
};
const companySources = {
  approvals: [],
  handoffs: [],
  connectors: [],
  owner_inputs: [],
  reconciliations: [],
  agents: [],
  runs_today: [],
  activity: [],
};
const offlineComposition = {
  runtime,
  credentials,
  platform: {
    listTenants: async () => [],
    getTenant: async () => null,
    readiness: async () => null,
    usage: async () => [],
  },
  providers: { list: async () => [] },
  companyProjections: { getSources: async () => companySources },
};

const app = buildServer(offlineComposition);
await app.ready();
const document = app.swagger();
const output = new URL('../../../packages/api-contract/openapi.json', import.meta.url);
await mkdir(dirname(fileURLToPath(output)), { recursive: true });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
await app.close();
