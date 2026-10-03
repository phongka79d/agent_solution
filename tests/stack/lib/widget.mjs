import { login, requestApi } from './api.mjs';

function widgetOrigin() {
  const origin = (process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0].trim();
  if (!origin) throw new Error('stack widget origin is not configured');
  return origin;
}

// Verified fixtures must launch the session for their own customer, never copy another session's identity.
export async function mintWidgetForCustomer(customerId, operatorToken) {
  const origin = widgetOrigin();
  const { response, body } = await requestApi(
    `testing/customers/${encodeURIComponent(customerId)}/widget-session`,
    { method: 'POST', token: operatorToken, body: { origin } },
  );
  if (response.status !== 201 || typeof body?.access_token !== 'string' || typeof body.session_id !== 'string'
    || body.customer_id !== customerId) {
    throw new Error(`TEST customer widget session mint returned HTTP ${response.status}`);
  }
  return { ...body, origin, operatorToken };
}

export async function mintWidget(persona) {
  const authProvider = (process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  const operator = await login('company');
  const origin = widgetOrigin();

  // Test Lab sessions are verified even when the fixture is named "anonymous".
  // The demo launcher can issue genuinely unbound sessions using either operator auth provider.
  if (authProvider === 'db' && persona !== 'anonymous') {
    const display_name = `Stack widget ${persona}`;
    const query = new URLSearchParams({ limit: '100', search: display_name });
    const listed = await requestApi(`testing/customers?${query}`, { token: operator.access_token });
    if (!listed.response.ok || !Array.isArray(listed.body?.items)) {
      throw new Error(`TEST customer lookup returned HTTP ${listed.response.status}`);
    }
    let customer = listed.body.items.find((item) =>
      item.display_name === display_name && item.data_class === 'TEST' && typeof item.id === 'string',
    );
    if (customer === undefined) {
      const created = await requestApi('testing/customers', {
        method: 'POST',
        token: operator.access_token,
        body: { display_name },
      });
      customer = created.body?.customer;
      if (created.response.status !== 201 || customer?.data_class !== 'TEST' || typeof customer?.id !== 'string') {
        throw new Error(`TEST customer creation returned HTTP ${created.response.status}`);
      }
    }

    return mintWidgetForCustomer(customer.id, operator.access_token);
  }

  const { response, body } = await requestApi('demo/widget-session', {
    method: 'POST',
    token: operator.access_token,
    headers: { origin },
    body: { persona },
  });
  if (response.status !== 201 || typeof body?.access_token !== 'string' || typeof body.session_id !== 'string') {
    throw new Error(`widget session mint returned HTTP ${response.status}`);
  }
  return { ...body, origin, operatorToken: operator.access_token };
}
