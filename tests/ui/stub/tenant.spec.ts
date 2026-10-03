import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resolve } from 'node:path';
import { DEMO_ACCOUNTS } from './global-setup';

function viewportName(projectName: string): 'desktop' | 'mobile' {
  return projectName.endsWith('mobile') ? 'mobile' : 'desktop';
}

async function saveScreenshot(page: Page, projectName: string, pageName: string): Promise<void> {
  await page.screenshot({
    path: resolve('test-results/ui', `tenant-${viewportName(projectName)}-${pageName}.png`),
    fullPage: true,
  });
}

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(serious, serious.map((violation) => `${violation.id}: ${violation.help}`).join('\n')).toEqual([]);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in?next=%2F');
  await page.locator('input[type="email"]').fill(DEMO_ACCOUNTS.company.email);
  await page.locator('input[type="password"]').fill(DEMO_ACCOUNTS.company.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('tenant console', () => {
  test('unauthenticated root redirects to sign-in and sign-in exposes only email and password', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in\?next=%2F$/);

    const fields = page.locator('form input');
    await expect(fields).toHaveCount(2);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('select, input[type="radio"], [role="radio"]')).toHaveCount(0);

    await expectNoSeriousAxeViolations(page);
    await saveScreenshot(page, testInfo.project.name, 'sign-in');
  });

  test('successful company login lands on the overview with navigation visible', async ({ page }, testInfo) => {
    await signIn(page);
    await expect(page.locator('.ui-loading-state')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cần bạn xử lý' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hôm nay' })).toBeVisible();
    await expect(page.locator('.app-shell[data-responsive-shell="true"]')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    if (viewportName(testInfo.project.name) === 'desktop') {
      await expect(page.getByRole('navigation', { name: 'Điều hướng công ty' })).toBeVisible();
    } else {
      await expect(page.locator('button.mobile-menu-button:visible')).toHaveCount(1);
    }

    await expectNoSeriousAxeViolations(page);
    await saveScreenshot(page, testInfo.project.name, 'overview');
  });

  test('mobile navigation drawer opens and returns focus to its trigger', async ({ page }, testInfo) => {
    test.skip(viewportName(testInfo.project.name) !== 'mobile', 'mobile-only interaction');
    await signIn(page);

    const menuButton = page.locator('button.mobile-menu-button:visible').first();
    await expect(menuButton).toBeVisible();
    await menuButton.focus();
    await menuButton.click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: 'Điều hướng công ty' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Đóng menu' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(menuButton).toBeFocused();
  });
});
