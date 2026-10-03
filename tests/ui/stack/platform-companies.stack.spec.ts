import { expect, test } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

test('platform company wizard provisions a company shown as not configured (T8.2)', async ({ page }) => {
  await openConsole(page, 'platform');
  await page.goto('/companies');
  await expect(page.getByRole('heading', { level: 1, name: 'Công ty', exact: true })).toBeVisible();
  await assertRouteQuality(page);

  await page.getByRole('button', { name: 'Tạo công ty', exact: true }).first().click();
  const wizard = page.getByRole('dialog', { name: 'Tạo công ty' });
  await expect(wizard).toBeVisible();
  await assertRouteQuality(page);

  const companyName = `Stack UI company ${Date.now()}`;
  await wizard.getByLabel('Tên công ty').fill(companyName);
  await wizard.getByLabel('Phân loại dữ liệu').selectOption('TEST');
  await wizard.getByRole('button', { name: 'Tạo công ty', exact: true }).click();
  await expect(wizard).toBeHidden();

  const companyRow = page.getByRole('table').getByRole('row').filter({ hasText: companyName });
  await expect(companyRow).toBeVisible({ timeout: 90_000 });
  await expect(companyRow).toContainText('Chưa cấu hình');
  await assertRouteQuality(page);
});
