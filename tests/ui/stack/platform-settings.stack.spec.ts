import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

interface InvitationOutboxRecord {
  readonly to: string;
  readonly invitation_url: string;
}

function isInvitationOutboxRecord(value: unknown): value is InvitationOutboxRecord {
  return typeof value === 'object' && value !== null
    && 'to' in value && typeof value.to === 'string'
    && 'invitation_url' in value && typeof value.invitation_url === 'string';
}

async function invitationUrlFor(directory: string, email: string): Promise<string> {
  let invitationUrl: string | null = null;
  await expect.poll(async () => {
    for (const filename of await readdir(directory)) {
      if (!/^invitation-[^/]+\.json$/.test(filename)) continue;
      let value: unknown;
      try {
        value = JSON.parse(await readFile(`${directory}/${filename}`, 'utf8'));
      } catch {
        continue;
      }
      if (isInvitationOutboxRecord(value) && value.to === email) {
        invitationUrl = value.invitation_url;
        return invitationUrl;
      }
    }
    return invitationUrl;
  }, { timeout: 30_000, intervals: [100, 250, 500] }).not.toBeNull();
  if (invitationUrl === null) throw new Error('The stack invitation was not written to the outbox.');
  return invitationUrl;
}

test('platform settings tabs and skill catalog entitlement are operable (T8.9)', async ({ page }) => {
  await openConsole(page, 'platform');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Cài đặt', exact: true })).toBeVisible();

  for (const label of ['Tài khoản', 'Quản trị viên', 'Danh mục kỹ năng', 'Tính năng', 'Bảo mật']) {
    const tab = page.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await assertRouteQuality(page);
  }
  await page.getByRole('tab', { name: 'Danh mục kỹ năng', exact: true }).click();

  const companySelect = page.getByRole('combobox', { name: 'Công ty', exact: true });
  await expect(companySelect.locator('option').nth(1)).toBeAttached();
  await companySelect.selectOption({ index: 1 });
  const catalog = page.getByRole('table', { name: 'Danh mục kỹ năng' });
  const firstSkill = catalog.getByRole('row').nth(1);
  await expect(firstSkill).toBeVisible();
  await firstSkill.getByRole('button', { name: 'Bật', exact: true }).click();
  await expect(firstSkill.getByText('Đang bật', { exact: true })).toBeVisible();
  await assertRouteQuality(page);
});

test('platform admins can invite, activate, and sign in as another platform admin (T9.3)', async ({ page }) => {
  test.skip(process.env.STACK_AUTH_PROVIDER !== 'db', 'Platform invitation redemption requires STACK_AUTH_PROVIDER=db.');
  const outboxDirectory = process.env.EMAIL_OUTBOX_DIR;
  if (!outboxDirectory) throw new Error('Stack invitation outbox is unavailable.');

  await openConsole(page, 'platform');
  await page.goto('/settings');
  const adminsTab = page.getByRole('tab', { name: 'Quản trị viên', exact: true });
  await adminsTab.click();
  await expect(adminsTab).toHaveAttribute('aria-selected', 'true');
  await assertRouteQuality(page);

  const email = `stack-platform-admin-${Date.now()}@example.invalid`;
  await page.getByLabel('Email quản trị viên mới').fill(email);
  await page.getByRole('button', { name: 'Gửi lời mời', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã gửi lời mời quản trị viên.' })).toBeVisible();
  const invite = new URL(await invitationUrlFor(outboxDirectory, email));
  expect(invite.origin).toBe('http://localhost:13001');
  expect(invite.pathname).toBe('/accept-invite');

  await page.goto(invite.toString());
  await expect(page.getByRole('heading', { name: 'Đặt mật khẩu của bạn' })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await assertRouteQuality(page);

  const password = 'stack-platform-invite-password-2026';
  await page.getByLabel('Tên', { exact: true }).fill('Stack Invited Admin');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Kích hoạt tài khoản', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Tài khoản đã được kích hoạt. Hãy đăng nhập để tiếp tục.');
  await assertRouteQuality(page);

  await expect(page).toHaveURL(/\/sign-in\?invited=1$/, { timeout: 15_000 });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('main')).toBeVisible();
  await assertRouteQuality(page);
});
