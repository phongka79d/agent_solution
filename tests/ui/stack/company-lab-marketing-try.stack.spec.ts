import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality, openConsole, stackApiToken } from './helpers';

const API_BASE = 'http://127.0.0.1:14000/api/v1';

function requiredText(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The stack response must be an object.');
  }
  const text: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  if (typeof text === 'string' && text !== '') return text;
  throw new Error(`The stack response is missing ${key}.`);
}


async function inactiveAudienceCount(page: Page, token: string): Promise<number> {
  const response = await page.request.get(`${API_BASE}/campaigns/segments`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('segments' in body) || !Array.isArray(body.segments)) {
    throw new Error('The campaign segments response is missing.');
  }
  const segment: unknown = body.segments.find((value: unknown) => typeof value === 'object' && value !== null
    && 'segment_id' in value && value.segment_id === 'inactive_90d');
  if (typeof segment !== 'object' || segment === null || !('audience_count' in segment)
    || typeof segment.audience_count !== 'number' || !Number.isSafeInteger(segment.audience_count)
    || segment.audience_count < 0) {
    throw new Error('The inactive segment has no valid audience count.');
  }
  return segment.audience_count;
}

function vndAmounts(text: string): readonly number[] {
  // Support vi-VN currency labels and plain ERP answers such as "VND 18900000".
  const number = String.raw`\d{1,3}(?:[., \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
  const currencyAmount = new RegExp(String.raw`\bVND\s+(${number})(?!\d)|\b(${number})\s*(?:₫|VND|đ)(?!\w)`, 'g');
  return [...text.matchAll(currencyAmount)].map((match) => {
    const amount = match[1] ?? match[2];
    if (amount === undefined) throw new Error('The currency match has no numeric amount.');
    const compact = amount.replace(/[ \u00a0\u202f]/g, '');
    const decimal = /[.,]\d{1,2}$/.exec(compact);
    const whole = decimal === null ? compact : compact.slice(0, decimal.index);
    return Number(`${whole.replace(/[.,]/g, '')}${decimal === null ? '' : `.${decimal[0].slice(1)}`}`);
  });
}


test.describe.configure({ timeout: 540_000 });

test('T7.5 daily QA creates a TEST marketing cohort, grows its audience and reaches a matching pending approval', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const audienceBeforeCreation = await inactiveAudienceCount(page, token);
  const stamp = Date.now();
  const customerName = `Khách Marketing QA ${stamp}`;
  const customerEmail = `marketing-qa-${stamp}@example.test`;
  const campaignName = `Chiến dịch QA ${stamp}`;

  await page.goto('/testing/customers/new');
  await page.getByRole('textbox', { name: 'Họ tên', exact: true }).fill(customerName);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(customerEmail);
  await page.getByRole('checkbox', { name: 'Email marketing', exact: true }).check();
  const seed = page.locator('details').filter({ hasText: 'Hạt giống Marketing' });
  await seed.locator('summary').click();
  await seed.getByRole('checkbox', { name: 'Bật hạt giống Marketing' }).check();
  await seed.getByRole('spinbutton', { name: 'Số ngày từ lần mua đã thanh toán' }).fill('120');
  await seed.getByRole('spinbutton', { name: 'Số đơn đã mua' }).fill('2');
  await assertRouteQuality(page);
  const createdResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/testing/customers' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Tạo khách hàng thử', exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const createdBody: unknown = await created.json();
  if (typeof createdBody !== 'object' || createdBody === null || !('customer' in createdBody)
    || typeof createdBody.customer !== 'object' || createdBody.customer === null || !('data_class' in createdBody.customer)) {
    throw new Error('The lab did not return its customer.');
  }
  expect(createdBody.customer.data_class).toBe('TEST');
  const customerId = requiredText(createdBody.customer, 'id');

  try {
    // Public campaign/approval/run APIs do not expose raw recipient lists. Isolate the
    // newly created cohort's contribution through the canonical segment API instead.
    const expectedAudience = audienceBeforeCreation + 1;
    await expect.poll(() => inactiveAudienceCount(page, token)).toBe(expectedAudience);
    await expect(page.getByRole('link', { name: 'Mở Customer360', exact: true })).toBeVisible();
    await assertRouteQuality(page);
    await page.goto(`/testing/customers/${encodeURIComponent(customerId)}`);
    await expect(page.getByRole('heading', { name: customerName, exact: true })).toBeVisible();
    const signalResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/testing/customers/${customerId}/events`
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Gửi tín hiệu Marketing', exact: true }).click();
    expect((await signalResponse).status()).toBe(201);
    await expect(page.getByRole('status')).toHaveText('Đã gửi tín hiệu Marketing.');
    await assertRouteQuality(page);

    await page.goto('/campaigns/new');
    await page.getByRole('textbox', { name: 'Tên chiến dịch', exact: true }).fill(campaignName);
    await page.getByRole('textbox', { name: 'Mô tả ngắn' }).fill('Soạn email mời khách hàng đã đồng ý nhận tin quay lại mua sắm.');
    await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Phân khúc', exact: true })).toBeEnabled();
    await page.getByRole('combobox', { name: 'Phân khúc', exact: true }).selectOption('inactive_90d');
    await assertRouteQuality(page);
    await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await page.getByRole('combobox', { name: 'Kênh', exact: true }).selectOption('EMAIL_HTML');
    await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await assertRouteQuality(page);
    const draftResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/campaigns/drafts' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Tạo bản nháp', exact: true }).click();
    const draft = await draftResponse;
    expect(draft.status()).toBe(202);
    const draftBody: unknown = await draft.json();
    const runId = requiredText(draftBody, 'task_id');
    await expect(page).toHaveURL(new RegExp(`/campaigns/${runId}$`));
    await expect(page.getByRole('link', { name: 'Xem đề xuất phê duyệt', exact: true })).toBeVisible({ timeout: 240_000 });
    await assertRouteQuality(page);

    const campaignResponse = await page.request.get(`${API_BASE}/campaigns/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(campaignResponse.status()).toBe(200);
    const campaign: unknown = await campaignResponse.json();
    if (typeof campaign !== 'object' || campaign === null || !('approval' in campaign)
      || !('audience_count' in campaign)) {
      throw new Error('The campaign did not reach approval with its audience.');
    }
    expect(campaign.audience_count).toBe(expectedAudience);
    await expect(page.getByText(`${expectedAudience.toLocaleString('vi-VN')} khách`, { exact: true })).toBeVisible();
    const approvalId = requiredText(campaign.approval, 'approval_id');
    const approvalResponse = await page.request.get(`${API_BASE}/approvals/${encodeURIComponent(approvalId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approvalResponse.status()).toBe(200);
    const approval: unknown = await approvalResponse.json();
    expect(requiredText(approval, 'status')).toBe('PENDING');
    expect(requiredText(approval, 'run_id')).toBe(runId);


    await page.getByRole('link', { name: 'Xem đề xuất phê duyệt', exact: true }).click();
    const approvalCard = page.getByRole('button').filter({ hasText: campaignName });
    await expect(approvalCard).toBeVisible();
    await approvalCard.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Duyệt', exact: true })).toBeEnabled();
    await assertRouteQuality(page);
  } finally {
    const deleted = await page.request.delete(`${API_BASE}/testing/customers/${encodeURIComponent(customerId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.status()).toBe(200);
  }
});

test('T1.8 Sales try shows the exact SKU price from the mock ERP demo catalog', async ({ page }) => {
  await openConsole(page, 'company');
  const token = await stackApiToken(page, 'company');
  const response = await page.request.get(`${API_BASE}/demo/catalog`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  const catalog: unknown = await response.json();
  if (typeof catalog !== 'object' || catalog === null || !('items' in catalog) || !Array.isArray(catalog.items)) {
    throw new Error('The ERP catalog is missing.');
  }
  const item: unknown = catalog.items.find((candidate: unknown) => typeof candidate === 'object' && candidate !== null
    && 'is_active' in candidate && candidate.is_active === true
    && 'list_price' in candidate && typeof candidate.list_price === 'number' && candidate.list_price > 0);
  if (typeof item !== 'object' || item === null || !('list_price' in item) || typeof item.list_price !== 'number') {
    throw new Error('The ERP catalog has no priced product.');
  }
  const sku = requiredText(item, 'sku_id');
  const currency = requiredText(item, 'currency');
  await page.goto('/ai-team/sales/try');
  await assertRouteQuality(page);
  const chat = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Tin nhắn', exact: true }) });
  await chat.getByRole('textbox', { name: 'Tin nhắn', exact: true }).fill(`What is the price of SKU ${sku}? Quote the full numeric price in ${currency}.`);
  await chat.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Vì sao gợi ý này?', exact: true })).toBeVisible({ timeout: 240_000 });
  const answer = chat.locator('[aria-live="polite"] > div').nth(1).locator('p').first();
  await expect(answer).not.toHaveAttribute('role', 'alert');
  await expect(answer).toContainText(sku);
  expect(currency).toBe('VND');
  const amounts = vndAmounts(await answer.innerText());
  expect(amounts, 'the assistant answer must quote the exact ERP catalog price').toContain(item.list_price);
  await assertRouteQuality(page);
});

test('T1.8 a forced chat BFF 403 renders exactly one Vietnamese error bubble', async ({ page }) => {
  await openConsole(page, 'company');
  await page.goto('/ai-team/sales/try');
  await assertRouteQuality(page);
  let refusals = 0;
  await page.route('**/api/testing/chat/**', async (route) => {
    refusals += 1;
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error_code: 'FORBIDDEN' }) });
  });
  const chat = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Tin nhắn', exact: true }) });
  await chat.getByRole('textbox', { name: 'Tin nhắn', exact: true }).fill('Cho tôi biết giá sản phẩm.');
  await chat.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(chat.getByRole('alert')).toHaveCount(1);
  await expect(chat.getByRole('alert')).toHaveText('Bạn không có quyền thực hiện lượt tư vấn này.');
  await expect(chat.locator('[aria-live="polite"] > div')).toHaveCount(2);
  await expect(chat.getByRole('button', { name: 'Vì sao gợi ý này?', exact: true })).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Gửi', exact: true })).toBeVisible();
  expect(refusals).toBe(1);
  await assertRouteQuality(page);
});
