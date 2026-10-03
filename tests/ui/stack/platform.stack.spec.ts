import { expect, test } from '@playwright/test';
import { assertRouteQuality, signIn } from './helpers';

test('platform sign-in opens operations with real stack runs', async ({ page }) => {
  await signIn(page, 'platform');
  await page.getByRole('link', { name: 'Vận hành', exact: true }).click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.getByRole('heading', { name: 'Vận hành' })).toBeVisible();

  const runs = page.getByRole('table', { name: 'Danh sách lượt chạy trên toàn nền tảng' });
  await expect(runs).toBeVisible();
  await expect.poll(async () => runs.getByRole('link', { name: 'Chi tiết' }).count(), { timeout: 90_000 }).toBeGreaterThan(0);
  await assertRouteQuality(page);
});
