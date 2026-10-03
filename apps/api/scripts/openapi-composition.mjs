/**
 * @file The offline composition the OpenAPI document is emitted from (`pnpm openapi:emit`).
 *
 * Every optional route group is mounted with a stub port so no group can be dropped from the
 * contract by a missing binding: the point of the exercise is that the emitted document covers the
 * whole registered surface, not just the groups a local `.env` happens to enable. Stubs are never
 * reached — `app.ready()` registers routes, it does not answer them.
 */

/**
 * Builds the offline server. `buildServer` and `KnowledgeRepository` are injected so the node
 * emitter can pass the compiled `dist` module while vitest passes the TypeScript source, and both
 * compare against the very same route set.
 *
 * @param {{ buildServer: Function, KnowledgeRepository: new () => unknown }} ports
 * @returns {import('fastify').FastifyInstance}
 */
export function createOfflineApp({ buildServer, KnowledgeRepository }) {
  const noopAsync = async () => undefined;
  // Callable and property-bearing: a group may use its port as a function or as an object.
  const noopPort = new Proxy(function noop() {}, {
    get: () => noopAsync,
    apply: () => Promise.resolve(undefined),
  });
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

  return buildServer({
    runtime,
    credentials,
    env: () => ({}),
    demoMode: true,
    documentRefusals: true,
    demoAuth: noopPort,
    demoWidgetSessions: noopPort,
    auth: noopPort,
    readiness: noopPort,
    trace: noopPort,
    provisioning: noopPort,
    autonomyAdmin: noopPort,
    platform: noopPort,
    companyCommands: noopPort,
    userAdmin: noopPort,
    platformAdmins: noopPort,
    invitationAccept: noopPort,
    providers: noopPort,
    llmConfiguration: noopPort,
    knowledge: new KnowledgeRepository(),
    skills: noopPort,
    platformSkills: noopPort,
    testCustomers: noopPort,
    widgetSessions: noopPort,
    companyProjections: { getSources: async () => companySources },
  });
}
