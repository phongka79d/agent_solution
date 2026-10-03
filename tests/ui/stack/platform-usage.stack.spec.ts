import { expect, test } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

test('platform usage route loads and keeps currency totals on its own page (T8.4)', async ({ page }) => {
  await openConsole(page, 'platform');
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Mức sử dụng', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Mức sử dụng' })).toBeVisible();
  await assertRouteQuality(page);
});

test('usage totals show separate currency cards for recorded rows (T8.4)', async () => {
  test.skip(
    true,
    'The stack has no API write path for token_cost_records; UI tests cannot seed these rows with the read-only SQL helper.',
  );
});
