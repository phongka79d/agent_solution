import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

async function visitPlatformRoute(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
  await assertRouteQuality(page);
}

test('axe and copy-lint cover every platform console route and tab (T8.2–T8.9)', async ({ page }) => {
  await openConsole(page, 'platform');

  await visitPlatformRoute(page, '/');
  await visitPlatformRoute(page, '/companies');
  const companyLink = page.locator('a[href^="/companies/"]').first();
  await expect(companyLink).toBeVisible();
  const companyRoute = await companyLink.getAttribute('href');
  if (!companyRoute) throw new Error('Platform company detail link is missing.');
  await visitPlatformRoute(page, companyRoute);
  for (const label of ['Tổng quan', 'Người dùng', 'AI Team', 'Kết nối & nhà cung cấp', 'Mức sử dụng', 'Lượt chạy', 'Tự chủ', 'Kiểm toán']) {
    const tab = page.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
    await assertRouteQuality(page);
  }

  await visitPlatformRoute(page, '/operations');
  for (const label of ['Lượt chạy', 'Đối soát', 'Bị kẹt']) {
    const tab = page.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
    await assertRouteQuality(page);
  }
  await page.getByRole('tab', { name: 'Lượt chạy', exact: true }).click();
  const detailLink = page.getByRole('table', { name: 'Danh sách lượt chạy trên toàn nền tảng' }).getByRole('link', { name: 'Chi tiết' }).first();
  await expect(detailLink).toBeVisible({ timeout: 90_000 });
  const detailRoute = await detailLink.getAttribute('href');
  if (!detailRoute) throw new Error('Platform run detail link is missing.');
  await visitPlatformRoute(page, detailRoute);

  for (const route of ['/usage', '/providers', '/system-health', '/audit', '/settings']) {
    await visitPlatformRoute(page, route);
    if (route === '/settings') {
      for (const label of ['Tài khoản', 'Quản trị viên', 'Danh mục kỹ năng', 'Tính năng', 'Bảo mật']) {
        const tab = page.getByRole('tab', { name: label, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
        await assertRouteQuality(page);
      }
    }
  }

  await visitPlatformRoute(page, '/accept-invite?token=invalid-stack-route-token');
  // Next's empty route announcer is also role=alert; target the page's own message.
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
});

