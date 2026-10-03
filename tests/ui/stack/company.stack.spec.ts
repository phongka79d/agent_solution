import { expect, test } from '@playwright/test';
import { assertRouteQuality, openConsole, signIn } from './helpers';

test('company signs in, sees live activity, gets an assistant answer, and handles a human handoff', async ({ page }) => {
  await signIn(page, 'company');

  const aiTeam = page.getByRole('heading', { name: 'AI Team' });
  const activity = page.locator('section[aria-labelledby="overview-activity-heading"]');
  await expect(aiTeam).toBeVisible();
  await expect(activity.getByRole('heading', { name: 'Hoạt động gần đây', exact: true })).toBeVisible();

  await page.goto('/ai-team/sales/try');
  await expect(page.getByRole('heading', { name: 'Thử trợ lý Sales' })).toBeVisible();
  const chat = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Tin nhắn' }) });
  const messageBox = chat.getByRole('textbox', { name: 'Tin nhắn' });
  await expect(messageBox).toBeVisible();
  await chat.getByLabel('Khách hàng thử').selectOption('C05');
  await assertRouteQuality(page);

  await messageBox.fill('I need a laptop under 20 million VND for graphic design.');
  await chat.getByRole('button', { name: 'Gửi', exact: true }).click();
  const firstAnswer = chat.locator('[aria-live="polite"] > div').nth(1).locator('p').first();
  await expect(firstAnswer).toBeVisible({ timeout: 240_000 });
  await expect(firstAnswer).not.toHaveAttribute('role', 'alert');
  await expect(chat.getByRole('button', { name: 'Vì sao gợi ý này?' })).toBeVisible({ timeout: 240_000 });
  await expect(firstAnswer).toHaveText(/\S/);
  await assertRouteQuality(page);

  await page.goto('/');
  await expect(activity.locator('ol li').first()).toBeVisible({ timeout: 90_000 });
  await assertRouteQuality(page);

  await page.goto('/ai-team/sales/try');
  await expect(page.getByRole('heading', { name: 'Thử trợ lý Sales' })).toBeVisible();
  const escalationChat = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Tin nhắn' }) });
  await assertRouteQuality(page);
  await escalationChat.getByRole('textbox', { name: 'Tin nhắn' }).fill('I want to speak to a person');
  await escalationChat.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(page.getByText('Lượt tư vấn cần nhân viên hỗ trợ tiếp tục.')).toBeVisible({ timeout: 240_000 });
  await assertRouteQuality(page);

  await page.goto('/conversations');
  await expect(page.getByRole('heading', { level: 1, name: 'Hội thoại', exact: true })).toBeVisible();
  // The inbox opens on the needs-human tab; list rows carry no message preview, so the escalated
  // turn is identified by its ownership label and then confirmed in the thread itself.
  const handoff = page
    .locator('aside[aria-label="Danh sách hội thoại"] ul button')
    .filter({ hasText: 'Khách yêu cầu nhân viên' })
    .first();
  await expect(handoff).toBeVisible({ timeout: 120_000 });
  await assertRouteQuality(page);
  await handoff.click();
  await expect(page.getByText('I want to speak to a person').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Nhận xử lý' })).toBeVisible();
  await assertRouteQuality(page);

  const takeoverDialog = page.getByRole('dialog', { name: 'Xác nhận tiếp quản' });
  await page.getByRole('button', { name: 'Nhận xử lý' }).click();
  await expect(takeoverDialog).toBeVisible();
  await takeoverDialog.getByRole('button', { name: 'Nhận xử lý' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã tiếp quản hội thoại.' })).toBeVisible();

  const reply = 'A team member is here to help with your order.';
  await page.getByRole('textbox', { name: 'Tin nhắn của nhân viên' }).fill(reply);
  await page.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(page.locator('article').filter({ hasText: reply })).toBeVisible({ timeout: 60_000 });
  await assertRouteQuality(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI Team' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="overview-activity-heading"] ol li').first()).toBeVisible();
  await assertRouteQuality(page);
});

test('campaign wizard creates a draft that an operator can approve', async ({ page }) => {
  await openConsole(page, 'company');
  await page.goto('/campaigns/new');
  await expect(page.getByRole('heading', { name: 'Tạo bản nháp chiến dịch' })).toBeVisible();
  await assertRouteQuality(page);

  const campaignName = 'Stack UI win-back approval';
  await page.getByLabel('Tên chiến dịch').fill(campaignName);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  const segment = page.getByLabel('Phân khúc');
  const inactiveSegment = segment.locator('option[value="inactive_30d"]');
  await expect(inactiveSegment).toContainText('Khách hàng không hoạt động trong 30 ngày');
  await segment.selectOption('inactive_30d');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByLabel('Hướng dẫn').fill('A concise win-back note for customers who agreed to receive marketing.');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByText(campaignName)).toBeVisible();
  await page.getByRole('button', { name: 'Tạo bản nháp' }).click();

  await expect(page).toHaveURL(/\/campaigns\/[^/]+$/);
  await expect(page.getByRole('heading', { name: campaignName })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole('link', { name: 'Xem đề xuất phê duyệt' })).toBeVisible({ timeout: 180_000 });
  await assertRouteQuality(page);

  await page.getByRole('link', { name: 'Xem đề xuất phê duyệt' }).click();
  await expect(page).toHaveURL(/\/approvals$/);
  const approval = page.getByRole('button').filter({ hasText: campaignName }).first();
  await expect(approval).toBeVisible({ timeout: 180_000 });
  await assertRouteQuality(page);
  await approval.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await assertRouteQuality(page);
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã duyệt' })).toBeVisible({ timeout: 60_000 });
  await assertRouteQuality(page);
});
