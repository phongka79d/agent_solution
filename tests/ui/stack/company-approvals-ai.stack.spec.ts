import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality, openConsole, stackApiToken } from './helpers';

const API_BASE = 'http://127.0.0.1:14000/api/v1';

type ApiMethod = 'GET' | 'POST';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

interface CampaignApproval {
  readonly name: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly digest: string;
  readonly payload: Record<string, unknown>;
}


function requiredText(value: unknown, field: string): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entry = Object.entries(value).find(([key]) => key === field);
    if (entry !== undefined && typeof entry[1] === 'string') return entry[1];
  }
  throw new Error(`The stack API response omitted ${field}.`);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entry = Object.entries(value).find(([key]) => key === field);
    if (entry !== undefined && typeof entry[1] === 'object' && entry[1] !== null && !Array.isArray(entry[1])) {
      return Object.fromEntries(Object.entries(entry[1]));
    }
  }
  throw new Error(`The stack API response omitted ${field}.`);
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



async function waitForTaskState(page: Page, token: string, runId: string, expected: string): Promise<void> {
  await expect.poll(async () => {
    const result = await requestApi(page, `tasks/${encodeURIComponent(runId)}`, 'GET', token);
    return result.status === 200 ? requiredText(result.body, 'status') : `HTTP ${result.status}`;
  }, { timeout: 240_000, intervals: [250, 500, 1_000] }).toBe(expected);
}

async function createCampaignApproval(page: Page, token: string, purpose: string): Promise<CampaignApproval> {
  const name = `${purpose} ${Date.now()}`;
  const created = await requestApi(page, 'campaigns/drafts', 'POST', token, {
    idempotency_key: `company-ui-campaign-${randomUUID()}`,
    name,
    segment_id: 'inactive_30d',
    objective: 'winback',
    instruction: 'Create a concise reactivation draft for customers who agreed to receive marketing.',
  });
  expect(created.status).toBe(202);
  const runId = requiredText(created.body, 'task_id');
  await waitForTaskState(page, token, runId, 'awaiting_human');

  const campaign = await requestApi(page, `campaigns/${encodeURIComponent(runId)}`, 'GET', token);
  expect(campaign.status).toBe(200);
  const approvalId = requiredText(requiredRecord(campaign.body, 'approval'), 'approval_id');
  const detail = await requestApi(page, `approvals/${encodeURIComponent(approvalId)}`, 'GET', token);
  expect(detail.status).toBe(200);
  expect(requiredText(detail.body, 'status')).toBe('PENDING');
  expect(requiredText(detail.body, 'run_id')).toBe(runId);
  const digest = requiredText(detail.body, 'payload_sha256');
  expect(digest).toMatch(/^[a-f0-9]{64}$/i);
  return { name, runId, approvalId, digest, payload: requiredRecord(detail.body, 'payload') };
}

async function openApproval(page: Page, campaign: CampaignApproval): Promise<void> {
  await page.goto('/approvals');
  const card = page.getByRole('button').filter({ hasText: campaign.name });
  await expect(card).toBeVisible();
  await assertRouteQuality(page);
  await card.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Duyệt', exact: true })).toBeEnabled();
  await assertRouteQuality(page);
}

async function waitForApprovalState(
  page: Page,
  token: string,
  campaign: CampaignApproval,
  expected: string,
): Promise<Record<string, unknown>> {
  let detail: unknown;
  await expect.poll(async () => {
    const result = await requestApi(page, `approvals/${encodeURIComponent(campaign.approvalId)}`, 'GET', token);
    expect(result.status).toBe(200);
    detail = result.body;
    return requiredText(detail, 'status');
  }, { timeout: 240_000, intervals: [250, 500, 1_000] }).toBe(expected);
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    throw new Error('The approval detail is not an object.');
  }
  return Object.fromEntries(Object.entries(detail));
}

async function mintWidget(page: Page, companyToken: string): Promise<{ token: string; origin: string }> {
  const origin = (process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0]?.trim();
  if (!origin) throw new Error('The stack widget origin is not configured.');
  const provider = (process.env.STACK_AUTH_PROVIDER ?? process.env.AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  let widget: ApiResult;
  if (provider === 'db') {
    const created = await requestApi(page, 'testing/customers', 'POST', companyToken, {
      display_name: `Khách kiểm thử tổng quan ${Date.now()}`,
    });
    expect(created.status).toBe(201);
    const customer = requiredRecord(created.body, 'customer');
    expect(requiredText(customer, 'data_class')).toBe('TEST');
    widget = await requestApi(
      page,
      `testing/customers/${encodeURIComponent(requiredText(customer, 'id'))}/widget-session`,
      'POST',
      companyToken,
      { origin },
    );
  } else {
    widget = await requestApi(page, 'demo/widget-session', 'POST', companyToken, { persona: 'anonymous' }, { origin });
  }
  expect(widget.status).toBe(201);
  return { token: requiredText(widget.body, 'access_token'), origin };
}

async function storefrontTurn(widgetToken: string, origin: string): Promise<string> {
  const response = await fetch(`${API_BASE}/storefront/stream`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${widgetToken}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: 'I need a laptop under 20 million VND for graphic design.',
      idempotency_key: `company-ui-overview-${randomUUID()}`,
    }),
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
  const receipt: unknown = JSON.parse(firstLine.split(/\r?\n/, 1)[0] ?? '');
  expect(requiredText(receipt, 'conversation_id')).not.toBe('');
  return requiredText(receipt, 'task_id');
}

test.describe.configure({ timeout: 540_000 });

test('T6.8 rejects a campaign approval with a reason', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const campaign = await createCampaignApproval(page, token, 'Chiến dịch từ chối');
  await openApproval(page, campaign);
  await page.getByRole('button', { name: 'Từ chối', exact: true }).click();
  const rejection = page.getByRole('dialog', { name: 'Từ chối đề xuất' });
  await expect(rejection).toBeVisible();
  await expect(rejection.getByRole('button', { name: 'Từ chối', exact: true })).toBeDisabled();
  const reason = 'Cần làm rõ quyền lợi của khách trước khi gửi chiến dịch.';
  await rejection.getByLabel('Hoặc nhập lý do').fill(reason);
  await assertRouteQuality(page);
  await rejection.getByRole('button', { name: 'Từ chối', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã từ chối · Đề xuất không được thực hiện' })).toBeVisible();
  await waitForTaskState(page, token, campaign.runId, 'stopped');
  const decided = await waitForApprovalState(page, token, campaign, 'REJECTED');
  expect(requiredText(decided, 'decision_notes')).toBe(reason);
  expect(requiredText(decided, 'payload_sha256')).toBe(campaign.digest);

  await page.getByRole('tab', { name: 'Đã xử lý', exact: true }).click();
  const historyCard = page.getByRole('button').filter({ hasText: campaign.name });
  await expect(historyCard).toContainText('Đã từ chối');
  await assertRouteQuality(page);
});

test('T6.8 modifies and authorizes a campaign payload then resumes its run', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const campaign = await createCampaignApproval(page, token, 'Chiến dịch chỉnh sửa');
  expect(campaign.payload['channel']).toBe('EMAIL');
  await openApproval(page, campaign);
  await page.getByRole('button', { name: 'Yêu cầu sửa', exact: true }).click();
  const modification = page.getByRole('dialog', { name: 'Yêu cầu sửa đề xuất' });
  await expect(modification).toBeVisible();
  await modification.getByLabel('Kênh gửi').fill('ZALO');
  const reason = 'Chuyển chiến dịch sang kênh Zalo trước khi thực hiện.';
  await modification.getByLabel('Ghi chú').fill(reason);
  await assertRouteQuality(page);
  // MODIFY authorizes the edited revision itself; a second APPROVE would target a consumed approval.
  await modification.getByRole('button', { name: 'Gửi yêu cầu sửa', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã duyệt bản chỉnh sửa' })).toBeVisible();
  const decided = await waitForApprovalState(page, token, campaign, 'MODIFIED');
  expect(requiredRecord(decided, 'payload')).toEqual({ ...campaign.payload, channel: 'ZALO' });
  expect(requiredText(decided, 'payload_sha256')).not.toBe(campaign.digest);
  expect(requiredText(decided, 'decision_notes')).toBe(reason);
  await waitForTaskState(page, token, campaign.runId, 'completed');
  const completed = await requestApi(page, `campaigns/${encodeURIComponent(campaign.runId)}`, 'GET', token);
  expect(completed.status).toBe(200);
  expect(requiredText(requiredRecord(completed.body, 'approval'), 'decision')).toBe('MODIFIED');
  expect(requiredText(requiredRecord(completed.body, 'dispatch'), 'status')).toBe('NOT_INTEGRATED');

  await page.getByRole('tab', { name: 'Đã xử lý', exact: true }).click();
  const historyCard = page.getByRole('button').filter({ hasText: campaign.name });
  await expect(historyCard).toContainText('Đã duyệt bản chỉnh sửa');
  await historyCard.click();
  const history = page.getByRole('dialog');
  await expect(history).toContainText(reason);
  await expect(history.getByRole('button', { name: 'Duyệt', exact: true })).toHaveCount(0);
  await assertRouteQuality(page);

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Chờ duyệt', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByRole('button').filter({ hasText: campaign.name })).toHaveCount(0);
  await assertRouteQuality(page);
});

test('T6.8 refreshes an outdated approval with a Vietnamese conflict message', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const campaign = await createCampaignApproval(page, token, 'Chiến dịch đã thay đổi');
  await openApproval(page, campaign);

  // Another reviewer modifies the proposal after this browser has captured the original digest.
  const changed = await requestApi(page, `approvals/${encodeURIComponent(campaign.approvalId)}/decision`, 'POST', token, {
    decision: 'MODIFY',
    reason: 'Người duyệt khác đã chuyển chiến dịch sang Zalo.',
    expected_payload_sha256: campaign.digest,
    modified_payload: { ...campaign.payload, channel: 'ZALO' },
  });
  expect(changed.status).toBe(202);
  const decided = await waitForApprovalState(page, token, campaign, 'MODIFIED');
  expect(requiredText(decided, 'payload_sha256')).not.toBe(campaign.digest);
  await waitForTaskState(page, token, campaign.runId, 'completed');

  const conflictResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/approvals/${campaign.approvalId}/decision`),
  );
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  const conflict = await conflictResponse;
  expect(conflict.status()).toBe(409);
  const errorBody: unknown = await conflict.json();
  expect(['APPROVAL_NOT_CLAIMABLE', 'APPROVAL_STALE_PAYLOAD']).toContain(requiredText(errorBody, 'error_code'));
  await expect(page.getByRole('status').filter({ hasText: 'Đề xuất đã thay đổi, cần xem lại' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Đã xử lý', exact: true })).toHaveAttribute('aria-selected', 'true');
  const historyCard = page.getByRole('button').filter({ hasText: campaign.name });
  await expect(historyCard).toContainText('Đã duyệt bản chỉnh sửa');
  await expect(page.getByRole('button', { name: 'Duyệt', exact: true })).toHaveCount(0);
  await assertRouteQuality(page);
  await historyCard.click();
  await expect(page.getByRole('dialog')).toContainText('Người duyệt khác đã chuyển chiến dịch sang Zalo.');
  await expect(page.getByRole('button', { name: 'Duyệt', exact: true })).toHaveCount(0);
  await assertRouteQuality(page);
  const unchanged = await requestApi(page, `approvals/${encodeURIComponent(campaign.approvalId)}`, 'GET', token);
  expect(unchanged.status).toBe(200);
  expect(requiredText(unchanged.body, 'status')).toBe('MODIFIED');
  expect(requiredText(unchanged.body, 'payload_sha256')).toBe(requiredText(decided, 'payload_sha256'));
});

test('T6.4 pauses and resumes Sales with updated domain-card status', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  // Activation is idempotent; the disposable stack may start with NOT_ACTIVATED agents.
  const activated = await requestApi(page, 'company/ai-team/sales/activate', 'POST', token);
  expect(activated.status).toBe(200);
  expect(requiredText(activated.body, 'activation_status')).toBe('ACTIVE');
  try {
    await page.goto('/ai-team');
    const salesCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Sales', exact: true }) });
    await expect(salesCard.getByText('Hoạt động', { exact: true })).toBeVisible();
    await assertRouteQuality(page);
    await salesCard.getByRole('link', { name: 'Xem', exact: true }).click();
    await expect(page).toHaveURL(/\/ai-team\/sales$/);
    await expect(page.getByRole('heading', { name: 'Sales', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tạm dừng', exact: true }).click();
    await expect(page.getByRole('main').getByText('Tạm dừng', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kích hoạt', exact: true })).toBeVisible();
    await assertRouteQuality(page);

    await page.goto('/ai-team');
    await expect(salesCard.getByText('Tạm dừng', { exact: true })).toBeVisible();
    await assertRouteQuality(page);
    await salesCard.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await expect(salesCard.getByText('Hoạt động', { exact: true })).toBeVisible();
    await expect(salesCard.getByRole('button', { name: 'Tiếp tục', exact: true })).toHaveCount(0);
    await expect(salesCard.getByRole('link', { name: 'Xem', exact: true })).toBeVisible();
    await assertRouteQuality(page);
    const resumed = await requestApi(page, 'company/ai-team/sales', 'GET', token);
    expect(resumed.status).toBe(200);
    expect(requiredText(resumed.body, 'activation_status')).toBe('ACTIVE');
  } finally {
    // Do not leave the shared Sales domain paused when an assertion or UI interaction fails.
    const restored = await requestApi(page, 'company/ai-team/sales/resume', 'POST', token);
    expect(restored.status).toBe(200);
    expect(requiredText(restored.body, 'activation_status')).toBe('ACTIVE');
  }
});

test('T6.3 increments today\'s conversation metric after a widget turn', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const activated = await requestApi(page, 'company/ai-team/sales/activate', 'POST', token);
  expect(activated.status).toBe(200);
  expect(requiredText(activated.body, 'activation_status')).toBe('ACTIVE');
  await page.goto('/');
  const today = page.locator('section[aria-labelledby="overview-today-heading"]');
  await expect(today.getByRole('heading', { name: 'Hôm nay', exact: true })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const metric = today.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Hội thoại', exact: true }) });
  const baseline = await metric.count() === 0 ? 0 : Number(await metric.locator('.ui-metric-card__value').innerText());
  expect(Number.isSafeInteger(baseline)).toBe(true);
  expect(baseline).toBeGreaterThanOrEqual(0);
  await assertRouteQuality(page);

  const widget = await mintWidget(page, token);
  const runId = await storefrontTurn(widget.token, widget.origin);
  await waitForTaskState(page, token, runId, 'completed');
  await page.reload();
  await expect(metric.locator('.ui-metric-card__value')).toHaveText(String(baseline + 1));
  await expect(metric).toContainText('cập nhật lúc');
  const activity = page.locator('section[aria-labelledby="overview-activity-heading"] ol li')
    .filter({ has: page.locator(`a[href="/runs/${runId}"]`) });
  await expect(activity).toContainText('Sales');
  const runLink = activity.getByRole('link', { name: 'Sales vừa hoàn tất một lượt xử lý.', exact: true });
  await expect(runLink).toBeVisible();
  await expect(runLink).toHaveAttribute('href', `/runs/${runId}`);
  await expect(activity).toContainText('Chi tiết thực thi');
  await assertRouteQuality(page);
});
