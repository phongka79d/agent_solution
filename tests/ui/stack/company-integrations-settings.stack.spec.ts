import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality, openConsole, signIn, stackApiToken } from './helpers';

const API_BASE = 'http://127.0.0.1:14000/api/v1';
// The API/worker run inside Compose; the host-facing ERP port used by platform-operations is 18081.
const ERP_CONFIG = { base_url: 'http://mock-erp:8081/api/v1', auth_scheme: 'HMAC_MOCK' };
const ERP_PATH = 'company/integrations/API-001';
const PROFILE_PATH = 'company/settings/profile';

const ANALYTICS_PERIODS = [
  { window: '24h', label: '24 giờ' },
  { window: '7d', label: '7 ngày' },
  { window: '30d', label: '30 ngày' },
];

const KPI_LABELS: Readonly<Record<string, string>> = {
  conversations: 'Hội thoại',
  ai_resolved_rate: 'Tỷ lệ AI tự giải quyết',
  handed_to_staff: 'Chuyển cho nhân viên',
  avg_first_response_ms: 'Thời gian phản hồi đầu tiên (trung bình)',
  approvals: 'Phê duyệt',
  campaigns_by_state: 'Chiến dịch theo trạng thái',
  ai_cost_by_currency: 'Chi phí AI theo tiền tệ',
  failures_by_reason: 'Lỗi theo nguyên nhân',
  revenue_attribution: 'Doanh thu được quy cho AI',
};
const CAMPAIGN_LABELS: Readonly<Record<string, string>> = {
  draft: 'Nháp', awaiting_approval: 'Chờ phê duyệt', approved: 'Đã duyệt',
  running: 'Đang chạy', completed: 'Hoàn tất', UNKNOWN: 'Không xác định',
};

interface StackApiPayload {
  readonly [key: string]: unknown;
  readonly version?: number;
  readonly status?: string;
  readonly timezone?: string;
  readonly company_name?: string;
  readonly access_token?: string;
  readonly expires_at?: string;
  readonly key?: string;
  readonly kind?: string;
  readonly unit?: string;
  readonly value?: number | null;
  readonly config?: StackApiPayload;
  readonly brand_profile?: StackApiPayload;
  readonly binding?: StackApiPayload | null;
  readonly secret?: StackApiPayload | null;
  readonly detail?: StackApiPayload;
  readonly items?: readonly StackApiPayload[];
  readonly kpis?: readonly StackApiPayload[];
  readonly breakdown?: readonly StackApiPayload[];
}

/** Validate the consumed JSON fields once at the network boundary, including nested payloads. */
function isStackApiPayload(value: unknown): value is StackApiPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, field] of Object.entries(value)) {
    switch (key) {
      case 'version':
        if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 1) return false;
        break;
      case 'value':
        if (field !== null && (typeof field !== 'number' || !Number.isFinite(field))) return false;
        break;
      case 'status': case 'timezone': case 'company_name': case 'access_token': case 'expires_at':
      case 'key': case 'kind': case 'unit':
        if (typeof field !== 'string') return false;
        break;
      case 'config': case 'brand_profile': case 'detail':
        if (!isStackApiPayload(field)) return false;
        break;
      case 'binding': case 'secret':
        if (field !== null && !isStackApiPayload(field)) return false;
        break;
      case 'items': case 'kpis': case 'breakdown':
        if (!Array.isArray(field) || !field.every(isStackApiPayload)) return false;
        break;
    }
  }
  return true;
}

function requiredRecord(value: unknown): StackApiPayload {
  if (isStackApiPayload(value)) return value;
  throw new Error('The stack API response has invalid consumed fields.');
}

function requiredText(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field === 'string') return field;
  throw new Error(`The stack API response omitted ${key}.`);
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field === 'number' && Number.isFinite(field)) return field;
  throw new Error(`The stack API response omitted numeric ${key}.`);
}

function requiredItems(value: unknown): StackApiPayload[] {
  if (Array.isArray(value) && value.every(isStackApiPayload)) return value;
  throw new Error('The stack API response must contain an array of valid payloads.');
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value) return value;
  throw new Error(`The stack is missing ${name}.`);
}

async function requestApi(
  page: Page,
  token: string,
  path: string,
  method: 'GET' | 'POST' | 'PUT' = 'GET',
  body?: Record<string, unknown>,
  version?: number,
): Promise<Record<string, unknown>> {
  const response = await page.request.fetch(`${API_BASE}/${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  expect(response.status(), `${method} ${path}`).toBe(200);
  const result: unknown = await response.json();
  return requiredRecord(result);
}



async function erpBinding(page: Page, token: string): Promise<Record<string, unknown>> {
  const result = await requestApi(page, token, 'company/integrations');
  const connector = requiredItems(result['items']).find((item) => item['connector_id'] === 'API-001');
  if (connector === undefined) throw new Error('The stack ERP connector is unavailable.');
  return requiredRecord(connector['binding']);
}

function profileBody(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    company_name: requiredText(profile, 'company_name'),
    industry: profile['industry'],
    locale: requiredText(profile, 'locale'),
    timezone: requiredText(profile, 'timezone'),
    currency: requiredText(profile, 'currency'),
    brand_profile: requiredRecord(profile['brand_profile']),
  };
}

function formattedMetric(kpi: Record<string, unknown>): string {
  const value = requiredNumber(kpi, 'value');
  const format = new Intl.NumberFormat('vi-VN');
  if (kpi['unit'] === 'percent') return `${format.format(value)}%`;
  if (kpi['unit'] === 'ms') {
    return value >= 60_000
      ? `${format.format(Math.round(value / 60_000))} phút`
      : `${format.format(Math.round(value / 1000))} giây`;
  }
  return format.format(value);
}

async function saveErpSecret(page: Page, secret: string): Promise<void> {
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Khoá xác thực', { exact: true }).fill(secret);
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/${ERP_PATH}`
    && response.request().method() === 'PUT');
  await modal.getByRole('button', { name: 'Lưu', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(modal.getByLabel('Khoá xác thực', { exact: true })).toHaveValue('');
}

test('T6.9 ERP connects to the stack mock, passes probes, and rejects a wrong secret in Vietnamese', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const secret = requiredEnvironment('MOCK_SECRET_KEY');

  try {
    await page.goto('/integrations');
    const card = page.getByTestId('connector-card-API-001');
    await expect(card).toBeVisible();
    await assertRouteQuality(page);
    await card.getByRole('button', { name: 'Kết nối', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Địa chỉ máy chủ (URL)', { exact: true }).fill(ERP_CONFIG.base_url);
    await modal.getByLabel('Cách xác thực', { exact: true }).selectOption(ERP_CONFIG.auth_scheme);
    await saveErpSecret(page, secret);
    await modal.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
    const results = modal.getByTestId('integration-test-results');
    await expect(results.getByText('Kết nối hoạt động.', { exact: true })).toBeVisible();
    expect(requiredText(await erpBinding(page, token), 'status')).toBe('BOUND');
    await expect(card.getByText('Mô phỏng demo', { exact: true })).toBeVisible();
    await expect(results.getByText('Danh mục', { exact: true })).toBeVisible();
    await expect(results.getByText('Tồn kho', { exact: true })).toBeVisible();
    await assertRouteQuality(page);

    await saveErpSecret(page, `invalid-stack-key-${randomUUID()}`);
    await modal.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
    await expect(results.getByText('Kết nối lỗi.', { exact: true })).toBeVisible();
    await expect(results.getByText('Lỗi xác thực', { exact: true }).first()).toBeVisible();
    expect(requiredText(await erpBinding(page, token), 'status')).toBe('DEGRADED');
    await expect(card.getByText('Lỗi', { exact: true })).toBeVisible();
    await assertRouteQuality(page);

    await saveErpSecret(page, secret);
    await modal.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
    await expect(results.getByText('Kết nối hoạt động.', { exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Hủy', exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(card.getByText('Mô phỏng demo', { exact: true })).toBeVisible();
    await assertRouteQuality(page);
  } finally {
    const current = await erpBinding(page, token);
    // Leave the shared stack connected to its mock ERP with the valid key for subsequent specs.
    await requestApi(page, token, ERP_PATH, 'PUT', {
      config: ERP_CONFIG,
      secret,
    }, requiredNumber(current, 'version'));
    const probe = await requestApi(page, token, `${ERP_PATH}/test`, 'POST');
    expect(requiredText(probe, 'outcome')).toBe('PASS');
    const connected = requiredRecord(probe['binding']);
    // The binding API names a successfully connected binding BOUND (not the badge code CONNECTED).
    expect(requiredText(connected, 'status')).toBe('BOUND');
    expect(requiredRecord(connected['config'])).toEqual(ERP_CONFIG);
  }
});

test('T6.10 analytics numeric totals and breakdowns equal the live company analytics API', async ({ page }) => {
  await openConsole(page, 'company');
  const format = new Intl.NumberFormat('vi-VN');
  for (const { window, label } of ANALYTICS_PERIODS) {
    // Read the very snapshot rendered by the browser, avoiding races with worker updates between
    // an independent count request and the UI fetch. This is a real BFF/API response, not a fixture.
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/company/analytics'
      && new URL(response.url()).searchParams.get('window') === window && response.request().method() === 'GET');
    if (window === '24h') await page.goto('/analytics');
    else await page.getByRole('button', { name: label, exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const payload: unknown = await response.json();
    const snapshot = requiredRecord(payload);
    expect(requiredText(snapshot, 'window')).toBe(window);
    const kpis = requiredItems(snapshot['kpis']);
    expect(kpis.map((kpi) => requiredText(kpi, 'key'))).toEqual(expect.arrayContaining([
      'conversations', 'handed_to_staff', 'approvals', 'campaigns_by_state', 'ai_cost_by_currency', 'failures_by_reason',
    ]));
    let numericCards = 0;
    for (const kpi of kpis) {
      const key = requiredText(kpi, 'key');
      const heading = KPI_LABELS[key];
      if (heading === undefined) throw new Error(`Unmapped analytics KPI: ${key}.`);
      if (kpi['kind'] === 'BREAKDOWN' && key !== 'approvals') {
        const section = page.locator('main section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
        await expect(section).toBeVisible();
        const entries = requiredItems(kpi['breakdown'] ?? []);
        if (entries.length > 0) {
          const showTable = section.getByRole('button', { name: 'Xem bảng', exact: true });
          if (await showTable.count() > 0) await showTable.click();
          await expect(section.locator('tbody tr')).toHaveCount(entries.length);
          for (const entry of entries) {
            const entryKey = requiredText(entry, 'key');
            const row = section.getByRole('row').filter({
              has: page.getByRole('cell', { name: CAMPAIGN_LABELS[entryKey] ?? entryKey, exact: true }),
            });
            await expect(row.getByRole('cell').nth(1)).toHaveText(format.format(requiredNumber(entry, 'value')));
          }
        }
      } else {
        const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
        await expect(card).toBeVisible();
        if (kpi['value'] !== null) {
          numericCards += 1;
          await expect(card.locator('.ui-metric-card__value')).toHaveText(formattedMetric(kpi));
        }
        if (key === 'approvals' && kpi['detail'] !== undefined) {
          await expect(card.locator('.ui-metric-card__detail')).toContainText(
            `${format.format(requiredNumber(kpi['detail'], 'pending'))} chờ phê duyệt · ${format.format(requiredNumber(kpi['detail'], 'decided'))} đã xử lý`,
          );
        }
        if (key === 'ai_resolved_rate' && kpi['detail'] !== undefined) {
          await expect(card.locator('.ui-metric-card__detail')).toHaveText(
            `${format.format(requiredNumber(kpi['detail'], 'resolved'))} tự giải quyết · ${format.format(requiredNumber(kpi['detail'], 'handed_to_staff'))} chuyển nhân viên`,
          );
        }
      }
    }
    expect(numericCards).toBeGreaterThanOrEqual(2);
    await assertRouteQuality(page);
  }
});

test('T6.11 concurrent profile saves show a conflict and reload the winning timezone', async ({ page, context }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const original = await requestApi(page, token, PROFILE_PATH);
  const firstTimezone = original['timezone'] === 'Asia/Tokyo' ? 'Europe/Paris' : 'Asia/Tokyo';
  const secondTimezone = 'America/New_York';
  const other = await context.newPage();
  try {
    await page.goto('/settings');
    await other.goto('/settings');
    await expect(page.getByLabel('Múi giờ', { exact: true })).toHaveValue(requiredText(original, 'timezone'));
    await expect(other.getByLabel('Múi giờ', { exact: true })).toHaveValue(requiredText(original, 'timezone'));
    await page.getByLabel('Múi giờ', { exact: true }).fill(firstTimezone);
    await other.getByLabel('Múi giờ', { exact: true }).fill(secondTimezone);
    await page.getByTestId('settings-profile-form').getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(page.getByTestId('settings-profile-form').getByText('Đã lưu', { exact: true })).toBeVisible();
    const winner = await requestApi(page, token, PROFILE_PATH);
    expect(requiredText(winner, 'timezone')).toBe(firstTimezone);
    expect(requiredNumber(winner, 'version')).toBe(requiredNumber(original, 'version') + 1);
    await assertRouteQuality(page);

    const rejected = other.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/${PROFILE_PATH}`
      && response.request().method() === 'PUT');
    await other.getByTestId('settings-profile-form').getByRole('button', { name: 'Lưu', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    const conflict = other.getByRole('dialog', { name: 'Cài đặt vừa được người khác thay đổi', exact: true });
    await expect(conflict).toBeVisible();
    await assertRouteQuality(other);
    expect(requiredText(await requestApi(page, token, PROFILE_PATH), 'timezone')).toBe(firstTimezone);
    await conflict.getByRole('button', { name: 'Tải lại', exact: true }).click();
    await expect(conflict).toBeHidden();
    await expect(other.getByLabel('Múi giờ', { exact: true })).toHaveValue(firstTimezone);
    await expect(other.getByTestId('settings-profile-form').getByRole('button', { name: 'Lưu', exact: true })).toBeDisabled();
  } finally {
    const latest = await requestApi(page, token, PROFILE_PATH);
    const restored = await requestApi(page, token, PROFILE_PATH, 'PUT', profileBody(original), requiredNumber(latest, 'version'));
    expect(profileBody(restored)).toEqual(profileBody(original));
    await other.close();
  }
});

for (const failure of [
  { status: 502, code: 'DEPENDENCY_UNAVAILABLE', message: 'Dịch vụ liên quan tạm thời không khả dụng. Vui lòng thử lại.' },
  { status: 429, code: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.' },
]) {
  test(`T6.12 BFF ${failure.status} shows a Vietnamese error and recovers after retry`, async ({ page }) => {
    await openConsole(page, 'company');
    const pattern = '**/api/v1/company/integrations';
    let intercepted = 0;
    await page.route(pattern, async (route) => {
      intercepted += 1;
      await route.fulfill({
        status: failure.status,
        contentType: 'application/json',
        headers: { 'retry-after': '1' },
        body: JSON.stringify({ error_code: failure.code, message: 'Synthetic upstream failure', retryable: true }),
      });
    });
    try {
      await page.goto('/integrations');
      const alert = page.getByRole('alert').filter({ hasText: failure.message });
      await expect(alert).toBeVisible();
      expect(intercepted).toBeGreaterThan(0);
      await expect(page.getByTestId('connector-card-API-001')).toHaveCount(0);
      await expect(page.getByRole('main')).not.toContainText('Synthetic upstream failure');
      await assertRouteQuality(page);
      await page.unroute(pattern);
      await alert.getByRole('button', { name: 'Thử lại', exact: true }).click();
      await expect(page.getByTestId('connector-card-API-001')).toBeVisible();
      await expect(alert).toHaveCount(0);
      await assertRouteQuality(page);
    } finally {
      await page.unroute(pattern);
    }
  });
}

test('T6.12 session expiry warning offers renewal without losing the current route', async ({ page }) => {
  // Only the browser clock advances: the real server session/cookie remain valid for renewal.
  const startedAt = Date.now();
  await page.clock.install({ time: new Date(startedAt) });
  await signIn(page, 'company');
  await page.goto('/integrations');
  await expect(page.getByTestId('connector-card-API-001')).toBeVisible();
  const response = await page.request.get('/api/auth/session');
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  const expiry = Date.parse(requiredText(requiredRecord(payload), 'expires_at'));
  expect(Number.isFinite(expiry)).toBe(true);
  expect(expiry - startedAt).toBeGreaterThan(5 * 60_000);
  await page.clock.fastForward(expiry - startedAt - 4 * 60_000);
  const warning = page.getByRole('dialog', { name: 'Phiên đăng nhập sắp hết hạn', exact: true });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/Phiên đăng nhập sẽ hết hạn sau [1-5] phút nữa\./);
  await assertRouteQuality(page);
  const renewed = page.waitForResponse((result) => new URL(result.url()).pathname === '/api/auth/renew'
    && result.request().method() === 'POST');
  await warning.getByRole('button', { name: 'Gia hạn', exact: true }).click();
  expect((await renewed).status()).toBe(200);
  await expect(warning).toBeHidden();
  await expect(page).toHaveURL(/\/integrations$/);
  await expect(page.getByTestId('connector-card-API-001')).toBeVisible();
  await assertRouteQuality(page);
});
