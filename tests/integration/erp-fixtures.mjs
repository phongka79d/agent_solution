/**
 * Binds the local/CI provider explicitly, using the production DB-bound API-001 transport path.
 * TEST tenants must not impersonate DEMO tenants to inherit a process-environment mock.
 * No shared tenant connector configuration or credential rows are changed by this fixture.
 */
export function createIntegrationErpConnectors(adapters, { app_env, tenant_id, base_url, secret, hmac }) {
  if (app_env !== 'local' && app_env !== 'ci') {
    throw new Error('MOCK_PROVIDER_FORBIDDEN: integration ERP bindings are local/CI only');
  }
  const transport = adapters.createConnectorHttpTransport({
    base_url,
    auth_scheme: 'HMAC_MOCK',
    secret,
    tenant_id,
    hmacSha256Hex: hmac,
    timeoutMs: 5_000,
  });
  const connector = new adapters.Api001ErpConnector({
    transport,
    authority: { authorize: () => false },
  });
  const registry = new adapters.ConnectorRegistry();
  registry.register({
    descriptor: {
      connector_id: 'API-001',
      kind: 'SYSTEM_OF_RECORD',
      provider: 'mock-erp (local/ci integration fixture)',
      read_resources: ['catalog', 'inventory', 'customers', 'orders'],
    },
    dispatch: (draft, options) => connector.dispatch(draft, options),
    read: (input) => connector.read(input),
    reconcile: (input) => connector.reconcile(input),
  });
  return {
    registry,
    bound: registry.ids(),
    erp_read: {
      read: (input) => connector.read(input),
      reconcile: (input) => connector.reconcile(input),
      createOrder: (input) => connector.createOrder(input),
      cart_transport: transport,
    },
  };
}
