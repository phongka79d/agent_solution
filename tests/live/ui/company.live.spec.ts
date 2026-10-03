import { expect, test } from '@playwright/test';
import { assertRouteQuality } from '../../ui/stack/helpers';
import { assertBudgetAvailable, assertUsageRecorded, login, usageBefore } from '../api/helpers.mjs';

test('company Try assistant returns a customer-facing Sales answer', async ({ page }) => {
  await assertBudgetAvailable();
  const [company, platform] = await Promise.all([login('company'), login('platform')]);
  const tenantId = company.membership?.tenant_id;
  expect(typeof tenantId).toBe('string');
  const before = await usageBefore(platform.access_token, tenantId, 'sales');
  await page.goto('/ai-team/sales/try');
  await expect(page.getByRole('heading', { name: 'Thử trợ lý Sales' })).toBeVisible();
  const chat = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Tin nhắn' }) });
  const messageBox = chat.getByRole('textbox', { name: 'Tin nhắn' });
  await chat.getByLabel('Khách hàng thử').selectOption('C05');
  await assertRouteQuality(page);

  await messageBox.fill('I need a laptop under 20 million VND for graphic design.');
  await chat.getByRole('button', { name: 'Gửi', exact: true }).click();
  const answer = chat.locator('[aria-live="polite"] > div').nth(1).locator('p').first();
  await expect(answer).toBeVisible({ timeout: 240_000 });
  await expect(answer).not.toHaveAttribute('role', 'alert');
  await expect(answer).toHaveText(/\S/);
  await assertRouteQuality(page);
  await assertUsageRecorded(platform.access_token, tenantId, 'sales', before);
});

test('company approves a real-provider campaign draft', async ({ page }) => {
  await assertBudgetAvailable();
  await page.goto('/campaigns/new');
  const [company, platform] = await Promise.all([login('company'), login('platform')]);
  const tenantId = company.membership?.tenant_id;
  expect(typeof tenantId).toBe('string');
  const before = await usageBefore(platform.access_token, tenantId, 'marketing');
  await expect(page.getByRole('heading', { name: 'Tạo bản nháp chiến dịch' })).toBeVisible();
  await assertRouteQuality(page);

  const campaignName = `Live UI win-back ${Date.now()}`;
  await page.getByLabel('Tên chiến dịch').fill(campaignName);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  const segment = page.getByLabel('Phân khúc');
  const inactiveSegment = segment.locator('option[value="inactive_30d"]');
  await expect(inactiveSegment).toContainText('Khách hàng không hoạt động trong 30 ngày');
  await segment.selectOption('inactive_30d');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByLabel('Hướng dẫn').fill('A concise, synthetic win-back note for customers who agreed to receive marketing.');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByText(campaignName)).toBeVisible();
  await page.getByRole('button', { name: 'Tạo bản nháp' }).click();

  await expect(page).toHaveURL(/\/campaigns\/[^/]+$/);
  await expect(page.getByRole('heading', { name: campaignName })).toBeVisible({ timeout: 240_000 });
  const approvalLink = page.getByRole('link', { name: 'Xem đề xuất phê duyệt' });
  await expect(approvalLink).toBeVisible({ timeout: 240_000 });
  await assertRouteQuality(page);

  await approvalLink.click();
  await expect(page).toHaveURL(/\/approvals$/);
  const approval = page.getByRole('button').filter({ hasText: campaignName }).first();
  await expect(approval).toBeVisible({ timeout: 180_000 });
  await assertRouteQuality(page);
  await approval.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã duyệt' })).toBeVisible({ timeout: 60_000 });
  await assertRouteQuality(page);
  await assertUsageRecorded(platform.access_token, tenantId, 'marketing', before);
});
