import { expect, test } from '@playwright/test';
import { openConsole } from './helpers';

test('company edits its profile, reviews history, resolves an owner input, and invites a user', async ({ page }) => {
  await openConsole(page, 'company');
  await page.goto('/settings');

  const timezone = page.getByRole('textbox', { name: 'Múi giờ' });
  await expect(timezone).toBeVisible();
  const originalTimezone = await timezone.inputValue();
  const editedTimezone = originalTimezone === 'Asia/Bangkok' ? 'Asia/Ho_Chi_Minh' : 'Asia/Bangkok';
  await timezone.fill(editedTimezone);
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible();

  await page.getByRole('button', { name: 'Lịch sử thay đổi', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Lịch sử thay đổi' });
  await expect(history).toBeVisible();
  await expect(history.locator('ol')).toContainText(editedTimezone);
  await history.getByRole('button', { name: 'Đóng' }).click();

  await timezone.fill(originalTimezone);
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible();
  await expect(timezone).toHaveValue(originalTimezone);

  await page.getByRole('tab', { name: 'Dữ liệu', exact: true }).click();
  const ownerInput = page.getByRole('listitem').filter({ hasText: 'Lịch trình bàn giao sang chăm sóc' });
  await expect(ownerInput.getByRole('button', { name: 'Cấu hình', exact: true })).toBeVisible();
  await ownerInput.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await ownerInput.getByRole('textbox', { name: 'Giá trị cấu hình' }).fill('{"itinerary":[{"step":"owner-defined"}]}');
  await ownerInput.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
  await expect(ownerInput).toContainText('Đã cấu hình');

  await page.getByRole('tab', { name: 'Người dùng', exact: true }).click();
  if (process.env.STACK_AUTH_PROVIDER !== 'db') {
    // Demo identity has no durable users: the tab explains that instead of failing to load.
    await expect(page.getByRole('note').filter({ hasText: 'không khả dụng ở chế độ demo' })).toBeVisible();
    return;
  }
  const invitedEmail = `stack-ui-invite-${Date.now()}@example.test`;
  await page.getByRole('textbox', { name: 'Địa chỉ email' }).fill(invitedEmail);
  await page.getByRole('button', { name: 'Mời người dùng', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã gửi lời mời.' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: invitedEmail })).toContainText('Đã mời');
});
