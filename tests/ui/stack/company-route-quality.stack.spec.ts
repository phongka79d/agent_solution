import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

async function visitCompanyRoute(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
  await assertRouteQuality(page);
}

test('axe and copy-lint cover every company route and settings tab', async ({ page }) => {
  await openConsole(page, 'company');
  for (const route of [
    '/',
    '/ai-team',
    '/ai-team/sales',
    '/conversations',
    '/approvals',
    '/customers',
    '/campaigns',
    '/campaigns/new',
    '/knowledge',
    '/integrations',
    '/analytics',
    '/testing/customers',
  ]) {
    await visitCompanyRoute(page, route);
  }

  await visitCompanyRoute(page, '/customers');
  const customerHref = await page.locator('a[href^="/customers/"]').first().getAttribute('href')
    ?? '/customers/route-sweep-no-match';
  await visitCompanyRoute(page, customerHref);

  await visitCompanyRoute(page, '/campaigns');
  const campaignHref = await page
    .locator('a[href^="/campaigns/"]:not([href="/campaigns/new"])')
    .first()
    .getAttribute('href') ?? '/campaigns/route-sweep-no-match';
  await visitCompanyRoute(page, campaignHref);

  await visitCompanyRoute(page, '/');
  const runHref = await page
    .locator('section[aria-labelledby="overview-activity-heading"] a[href^="/runs/"]')
    .first()
    .getAttribute('href') ?? '/runs/route-sweep-no-match';
  await visitCompanyRoute(page, runHref);

  await visitCompanyRoute(page, '/settings');
  for (const label of ['Phê duyệt', 'AI & mô hình', 'Dữ liệu', 'Bảo mật', 'Người dùng', 'Nhật ký']) {
    const tab = page.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
    await assertRouteQuality(page);
  }
});

test('company shell and overview fit mobile and tablet viewports', async ({ page }) => {
  await openConsole(page, 'company');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('[data-app="tenant"][data-responsive-shell]')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI Team' })).toBeVisible();

    if (viewport.width === 390) {
      const openMenu = page.getByRole('button', { name: 'Mở menu' });
      await expect(openMenu).toBeVisible();
      await openMenu.click();
      const drawer = page.locator('aside[aria-modal="true"]');
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('navigation', { name: 'Điều hướng công ty' })).toBeVisible();
      await drawer.getByRole('button', { name: 'Đóng menu' }).click();
      await expect(openMenu).toHaveAttribute('aria-expanded', 'false');
    }

    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(viewport.width);
    await assertRouteQuality(page);
  }
});
