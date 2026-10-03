import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality, openConsole, stackApiToken } from './helpers';

const API_BASE = 'http://127.0.0.1:14000/api/v1';
const ERP_BASE = 'http://127.0.0.1:18081';

type ApiMethod = 'GET' | 'POST' | 'PUT';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}


function requiredText(value: unknown, field: string): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entry = Object.entries(value).find(([key]) => key === field);
    if (entry !== undefined && typeof entry[1] === 'string') return entry[1];
  }
  throw new Error(`The stack API response omitted ${field}.`);
}

function nestedText(value: unknown, parent: string, field: string): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entry = Object.entries(value).find(([key]) => key === parent);
    if (entry !== undefined && typeof entry[1] === 'object' && entry[1] !== null && !Array.isArray(entry[1])) {
      return requiredText(entry[1], field);
    }
  }
  throw new Error(`The stack API response omitted ${parent}.${field}.`);
}




function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The stack is missing ${name}.`);
  return value;
}

async function requestApi(
  page: Page,
  path: string,
  method: ApiMethod,
  token?: string,
  body?: Record<string, unknown>,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await page.request.fetch(`${API_BASE}/${path.replace(/^\/+/, '')}`, {
    method,
    headers,
    ...(body === undefined ? {} : { data: body }),
  });
  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    // Keep the HTTP status as the useful failure if an endpoint returns no JSON.
  }
  return { status: response.status(), body: responseBody };
}


async function setLlmFaults(page: Page, faults: readonly Record<string, unknown>[]): Promise<void> {
  const controlUrl = new URL('/__stub/control', requiredEnvironment('LLM_STUB_URL'));
  const result = await page.request.post(controlUrl.toString(), {
    headers: { 'x-llm-stub-control-token': requiredEnvironment('LLM_STUB_CONTROL_TOKEN') },
    data: { faults },
  });
  expect(result.status()).toBe(200);
}

async function waitForTaskState(page: Page, token: string, runId: string, expected: string): Promise<void> {
  await expect.poll(async () => {
    const result = await requestApi(page, `tasks/${encodeURIComponent(runId)}`, 'GET', token);
    return result.status === 200 ? requiredText(result.body, 'status') : `HTTP ${result.status}`;
  }, { timeout: 240_000, intervals: [250, 500, 1_000] }).toBe(expected);
}

async function createRetryableRun(page: Page, companyToken: string): Promise<string> {
  const marker = `platform-ui-retry-${Date.now()}`;
  const stubBaseUrl = new URL(requiredEnvironment('LLM_STUB_URL'));
  stubBaseUrl.hostname = 'host.docker.internal';
  const configured = await requestApi(page, 'company/settings/llm', 'PUT', companyToken, {
    mode: 'CUSTOM',
    provider_id: `ui-stack-${Date.now()}`,
    base_url: stubBaseUrl.toString().replace(/\/$/, ''),
    reasoning_model: 'llm-stub',
    fast_model: 'llm-stub',
    timeout_ms: 5_000,
    structured_mode: 'json_object',
    api_key: `stack-ui-${Date.now()}`,
  });
  expect(configured.status).toBe(200);

  // One transient 500 is recovered by the bounded retries (T5.5); a run only fails RETRYABLE when the
  // fault outlasts every attempt: 3 adapter attempts × 2 skill attempts × 4 durable attempts.
  await setLlmFaults(page, [{ match: { kind: 'marketing', contains: marker }, mode: '500', times: 24 }]);
  try {
    const created = await requestApi(page, 'campaigns/drafts', 'POST', companyToken, {
      idempotency_key: `platform-ui-retry:${marker}`,
      segment_id: 'inactive_30d',
      name: `Platform UI retry ${marker}`,
      objective: 'winback',
      instruction: `Create a tenant-scoped reactivation draft. ${marker}`,
    });
    expect(created.status).toBe(202);
    const runId = requiredText(created.body, 'task_id');
    await waitForTaskState(page, companyToken, runId, 'failed');
    return runId;
  } finally {
    await setLlmFaults(page, []);
  }
}

async function signedErpPost(page: Page, path: string, value: Record<string, unknown>): Promise<ApiResult> {
  const rawBody = JSON.stringify(value);
  const signature = createHmac('sha256', requiredEnvironment('MOCK_SECRET_KEY'))
    .update(`POST ${path}\n`)
    .update(rawBody)
    .digest('hex');
  const response = await page.request.post(`${ERP_BASE}${path}`, {
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': requiredText(value, 'tenant_id'),
      'x-mock-signature': signature,
    },
    data: rawBody,
  });
  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    // Preserve the status when the mock ERP intentionally omits a JSON body.
  }
  return { status: response.status(), body: responseBody };
}

async function storefrontTurn(page: Page, widgetToken: string, origin: string): Promise<string> {
  const response = await fetch(`${API_BASE}/storefront/stream`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${widgetToken}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'Please order SKU: NM-L01-BLK qty 1 with Stripe.', idempotency_key: `platform-ui-order-${Date.now()}` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.body === null) throw new Error(`Storefront admission returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstLine = '';
  try {
    while (!firstLine.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstLine += decoder.decode(chunk.value, { stream: true });
      if (firstLine.length > 16_384) throw new Error('The storefront receipt exceeded its expected size.');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(firstLine.split(/\r?\n/, 1)[0] ?? '');
  } catch {
    throw new Error('The storefront response omitted its JSON receipt.');
  }
  return requiredText(receipt, 'task_id');
}

async function createReconciliationRun(page: Page, companyToken: string, tenantId: string): Promise<string> {
  const widget = await requestApi(
    page,
    'demo/widget-session',
    'POST',
    companyToken,
    { persona: 'anonymous' },
    { origin: 'http://localhost:3000' },
  );
  expect(widget.status).toBe(201);
  const widgetToken = requiredText(widget.body, 'access_token');
  const sessionId = requiredText(widget.body, 'session_id');
  const address = {
    recipient_name: 'Stack Order Customer',
    phone: '+84900000002',
    postal_code: '700000',
    city: 'Ho Chi Minh City',
    district: 'District 1',
    address_line1: '3 Stack Test Street',
  };
  const customer = await requestApi(page, 'testing/customers', 'POST', companyToken, {
    display_name: `Platform UI order customer ${Date.now()}`,
    identities: [{ channel_type: 'WEB_CHAT', channel_identifier: sessionId, is_primary: true }],
    default_shipping_address: address,
  });
  expect(customer.status).toBe(201);
  // POST /testing/customers already seeds this TEST customer into the ERP simulator (T7.2);
  // seeding it again would be refused with SIM_SEED_CONFLICT.
  nestedText(customer.body, 'customer', 'id');

  let parked = false;
  try {
    const controlled = await signedErpPost(page, '/__sim/control', {
      tenant_id: tenantId,
      failure_rate: 0,
      latency_ms: 0,
      swallow_after_write: true,
    });
    expect(controlled.status).toBe(200);
    const runId = await storefrontTurn(page, widgetToken, 'http://localhost:3000');
    await waitForTaskState(page, companyToken, runId, 'awaiting_human');

    const approvals = await requestApi(page, 'approvals?status=PENDING', 'GET', companyToken);
    expect(approvals.status).toBe(200);
    let items: unknown[] = [];
    if (typeof approvals.body === 'object' && approvals.body !== null && !Array.isArray(approvals.body)
      && 'items' in approvals.body && Array.isArray(approvals.body['items'])) items = approvals.body['items'];
    const approval = items.find((item) => typeof item === 'object' && item !== null && !Array.isArray(item)
      && 'run_id' in item && item['run_id'] === runId);
    if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) {
      throw new Error('The order run was not placed in the approval queue.');
    }
    const approvalId = requiredText(approval, 'approval_id');
    const detail = await requestApi(page, `approvals/${encodeURIComponent(approvalId)}`, 'GET', companyToken);
    expect(detail.status).toBe(200);
    const decision = await requestApi(page, `approvals/${encodeURIComponent(approvalId)}/decision`, 'POST', companyToken, {
      decision: 'APPROVE',
      reason: 'Approve the synthetic stack order to exercise platform reconciliation.',
      expected_payload_sha256: requiredText(detail.body, 'payload_sha256'),
    });
    expect(decision.status).toBe(202);
    await waitForTaskState(page, companyToken, runId, 'waiting');
    parked = true;
    return runId;
  } finally {
    // Once the run is parked the provider stays unreachable, so the sweeper cannot confirm the write
    // and the outcome remains genuinely indeterminate for the operator; the test restores it after.
    const reset = await signedErpPost(page, '/__sim/control', {
      tenant_id: tenantId,
      failure_rate: parked ? 1 : 0,
      latency_ms: 0,
      swallow_after_write: false,
    });
    expect(reset.status).toBe(200);
  }
}

test('platform operations filters runs, inspects details, retries, and reconciles an unknown outcome (T8.3)', async ({ page }) => {
  test.setTimeout(600_000);
  const platformToken = await stackApiToken(page, 'platform');
  const companyToken = await stackApiToken(page, 'company');
  const authProvider = (process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  const companySession = await requestApi(page, authProvider === 'db' ? 'auth/session' : 'demo/session', 'GET', companyToken);
  expect(companySession.status).toBe(200);
  const tenantId = nestedText(companySession.body, 'membership', 'tenant_id');
  const retryRunId = await createRetryableRun(page, companyToken);
  await openConsole(page, 'platform');
  await page.goto('/operations');
  const filters = page.getByRole('form', { name: 'Bộ lọc lượt chạy' });
  await filters.getByLabel('Tìm kiếm', { exact: true }).fill(retryRunId);
  await filters.getByLabel('Trạng thái', { exact: true }).selectOption('failed');
  await filters.getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).click();
  const runs = page.getByRole('table', { name: 'Danh sách lượt chạy trên toàn nền tảng' });
  let retryRow = runs.getByRole('row').filter({ has: page.getByRole('link', { name: 'Chi tiết', exact: true }) });
  await expect(retryRow).toHaveCount(1, { timeout: 90_000 });
  await assertRouteQuality(page);

  const detailHref = await retryRow.getByRole('link', { name: 'Chi tiết', exact: true }).getAttribute('href');
  if (!detailHref) throw new Error('The retryable run has no detail link.');
  await page.goto(detailHref);
  await expect(page.getByRole('heading', { name: retryRunId, exact: true })).toBeVisible();
  await assertRouteQuality(page);

  await page.goto('/operations');
  const retryFilters = page.getByRole('form', { name: 'Bộ lọc lượt chạy' });
  await retryFilters.getByLabel('Tìm kiếm', { exact: true }).fill(retryRunId);
  await retryFilters.getByLabel('Trạng thái', { exact: true }).selectOption('failed');
  await retryFilters.getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).click();
  retryRow = page.getByRole('table', { name: 'Danh sách lượt chạy trên toàn nền tảng' }).getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Chi tiết', exact: true }) });
  await expect(retryRow).toHaveCount(1, { timeout: 90_000 });
  await retryRow.getByRole('button', { name: 'Thử lại', exact: true }).click();
  const retryDialog = page.getByRole('dialog', { name: 'Thử lại lượt chạy' });
  await expect(retryDialog).toBeVisible();
  await retryDialog.getByLabel('Lý do (không bắt buộc)').fill('Retry the one-shot provider fault from this UI journey.');
  await retryDialog.getByRole('button', { name: 'Xác nhận thử lại', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã gửi yêu cầu thử lại' })).toBeVisible({ timeout: 30_000 });
  await waitForTaskState(page, companyToken, retryRunId, 'awaiting_human');

  const reconcileRunId = await createReconciliationRun(page, companyToken, tenantId);
  try {
    const queue = await requestApi(page, 'platform/runs/reconciliation', 'GET', platformToken);
    expect(queue.status).toBe(200);
    let queueItems: unknown[] = [];
    if (typeof queue.body === 'object' && queue.body !== null && !Array.isArray(queue.body)
      && 'items' in queue.body && Array.isArray(queue.body['items'])) queueItems = queue.body['items'];
    expect(queueItems.some((item) => typeof item === 'object' && item !== null && !Array.isArray(item)
      && 'run_id' in item && item['run_id'] === reconcileRunId)).toBe(true);

    await page.goto('/operations');
    const reconcileTab = page.getByRole('tab', { name: 'Đối soát', exact: true });
    await reconcileTab.click();
    await expect(reconcileTab).toHaveAttribute('aria-selected', 'true');
    const reconciliationRow = page.getByRole('row').filter({ hasText: reconcileRunId });
    await expect(reconciliationRow).toBeVisible({ timeout: 90_000 });
    await assertRouteQuality(page);
    await reconciliationRow.getByRole('button', { name: 'Đối soát', exact: true }).click();

    const reconcileDialog = page.getByRole('dialog', { name: 'Đối soát lượt chạy' });
    await expect(reconcileDialog).toBeVisible();
    await reconcileDialog.getByRole('button', { name: 'Xác nhận đối soát', exact: true }).click();
    await expect(reconcileDialog.getByRole('alert')).toHaveText('Vui lòng nhập lý do đối soát.');
    await reconcileDialog.getByLabel('Lý do (bắt buộc)').fill('The mock ERP confirms the single order was written.');
    await reconcileDialog.getByLabel('Biên nhận nhà cung cấp (không bắt buộc, JSON)').fill('{"reference":"platform-ui-reconcile"}');
    await reconcileDialog.getByRole('button', { name: 'Xác nhận đối soát', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã ghi nhận đối soát' })).toBeVisible({ timeout: 30_000 });
    await expect(reconcileDialog).toBeHidden();
  } finally {
    const restored = await signedErpPost(page, '/__sim/control', {
      tenant_id: tenantId,
      failure_rate: 0,
      latency_ms: 0,
      swallow_after_write: false,
    });
    expect(restored.status).toBe(200);
  }
  // The operator's provider-confirmed resolution settles the parked run (T8.3).
  await waitForTaskState(page, companyToken, reconcileRunId, 'completed');
});