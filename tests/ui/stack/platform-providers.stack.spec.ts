import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The stack is missing ${name}.`);
  return value;
}

/**
 * A fresh stack has no platform provider rows (the env default is not a row). Create one through
 * the UI and make it the default, so the journey below always has a default provider to work on.
 */
async function ensureDefaultProvider(page: Page, baseUrl: string): Promise<void> {
  const table = page.getByRole('table').first();
  // Case-sensitive: the "Mặc định" badge, not the "Đặt làm mặc định" button on other rows.
  if (await table.getByRole('row').filter({ hasText: /Mặc định/ }).count() > 0) return;
  const providerId = `stack-ui-base-${Date.now()}`;
  await page.getByRole('button', { name: 'Thêm nhà cung cấp', exact: true }).click();
  const createDrawer = page.getByRole('dialog', { name: 'Thêm nhà cung cấp' });
  await createDrawer.getByLabel('Mã nhà cung cấp', { exact: true }).fill(providerId);
  await createDrawer.getByLabel('Tên hiển thị', { exact: true }).fill('Stack UI Base Provider');
  await createDrawer.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await createDrawer.getByLabel('Model suy luận', { exact: true }).fill('llm-stub');
  await createDrawer.getByLabel('Model nhanh', { exact: true }).fill('llm-stub');
  await createDrawer.getByLabel('Thời gian chờ (ms)', { exact: true }).fill('5000');
  await createDrawer.getByLabel('Khóa API', { exact: true }).fill(`stack-ui-base-key-${Date.now()}`);
  await createDrawer.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(createDrawer).toBeHidden();
  const created = table.getByRole('row').filter({ hasText: providerId });
  await expect(created).toBeVisible();
  if (await created.getByText('Mặc định', { exact: true }).count() > 0) return;
  await created.getByRole('button', { name: 'Đặt làm mặc định', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Xác nhận đặt nhà cung cấp mặc định' });
  await dialog.getByLabel('Lý do', { exact: true }).fill('Seed a default provider for the stack journey.');
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(created.getByText('Mặc định', { exact: true })).toBeVisible();
}

test('platform providers rotate a key, verify the connection, refuse unsafe URLs, and switch the default (T8.5)', async ({ page }) => {
  await openConsole(page, 'platform');
  await page.goto('/providers');
  await expect(page.getByRole('heading', { name: 'Nhà cung cấp AI', exact: true })).toBeVisible();
  const stubUrl = new URL(requiredEnvironment('LLM_STUB_URL'));
  stubUrl.hostname = 'host.docker.internal';
  const safeBaseUrl = stubUrl.toString().replace(/\/$/, '');
  await ensureDefaultProvider(page, safeBaseUrl);

  const table = page.getByRole('table').first();
  const providerRow = table.getByRole('row').filter({ hasText: /Mặc định/ });
  await expect(providerRow).toBeVisible();
  await providerRow.getByRole('button', { name: 'Chỉnh sửa nhà cung cấp', exact: true }).click();

  const drawer = page.getByRole('dialog', { name: 'Chỉnh sửa nhà cung cấp' });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel('Base URL', { exact: true }).fill(safeBaseUrl);
  await drawer.getByLabel('Khóa API', { exact: true }).fill(`stack-ui-key-${Date.now()}`);
  await drawer.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu cấu hình nhà cung cấp.' })).toBeVisible();
  await expect(providerRow.getByText('Đã lưu khóa — không hiển thị', { exact: true })).toBeVisible();

  await providerRow.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
  await expect(providerRow.getByText('Hoạt động', { exact: true })).toBeVisible({ timeout: 30_000 });
  await assertRouteQuality(page);

  await providerRow.getByRole('button', { name: 'Chỉnh sửa nhà cung cấp', exact: true }).click();
  await expect(drawer.getByLabel('Khóa API', { exact: true })).toHaveValue('');
  // Loopback stubs are allowed in local/CI by design (url-guard); the link-local metadata address
  // is refused in every environment, so it is the SSRF case this journey must reject.
  await drawer.getByLabel('Base URL', { exact: true }).fill('http://169.254.169.254/v1');
  await drawer.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('Không thể lưu cấu hình nhà cung cấp.');
  await expect(drawer.getByLabel('Base URL', { exact: true })).toHaveValue('http://169.254.169.254/v1');
  await assertRouteQuality(page);

  await drawer.getByRole('button', { name: 'Hủy', exact: true }).click();
  await providerRow.getByRole('button', { name: 'Chỉnh sửa nhà cung cấp', exact: true }).click();
  await expect(drawer.getByLabel('Base URL', { exact: true })).toHaveValue(safeBaseUrl);
  await expect(drawer.getByLabel('Khóa API', { exact: true })).toHaveValue('');
  await drawer.getByRole('button', { name: 'Hủy', exact: true }).click();
  const tableRows = table.getByRole('row');
  const originalDefault = tableRows.filter({ hasText: /Mặc định/ });
  await expect(originalDefault).toHaveCount(1);
  const originalDefaultId = await originalDefault.locator('.font-mono').innerText();

  const candidateId = `stack-ui-default-${Date.now()}`;
  await page.getByRole('button', { name: 'Thêm nhà cung cấp', exact: true }).click();
  const createDrawer = page.getByRole('dialog', { name: 'Thêm nhà cung cấp' });
  await createDrawer.getByLabel('Mã nhà cung cấp', { exact: true }).fill(candidateId);
  await createDrawer.getByLabel('Tên hiển thị', { exact: true }).fill('Stack UI Default Candidate');
  await createDrawer.getByLabel('Base URL', { exact: true }).fill(safeBaseUrl);
  await createDrawer.getByLabel('Model suy luận', { exact: true }).fill('llm-stub');
  await createDrawer.getByLabel('Model nhanh', { exact: true }).fill('llm-stub');
  await createDrawer.getByLabel('Thời gian chờ (ms)', { exact: true }).fill('5000');
  await createDrawer.getByLabel('Khóa API', { exact: true }).fill(`stack-ui-default-key-${Date.now()}`);
  await createDrawer.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(createDrawer).toBeHidden();

  const candidateRow = tableRows.filter({ hasText: candidateId });
  await expect(candidateRow).toBeVisible();
  await candidateRow.getByRole('button', { name: 'Đặt làm mặc định', exact: true }).click();
  const defaultDialog = page.getByRole('dialog', { name: 'Xác nhận đặt nhà cung cấp mặc định' });
  const confirmDefault = defaultDialog.getByRole('button', { name: 'Xác nhận', exact: true });
  await expect(confirmDefault).toBeDisabled();
  await defaultDialog.getByLabel('Lý do', { exact: true }).fill('Exercise the platform default-provider switch.');
  await confirmDefault.click();
  await expect(defaultDialog).toBeHidden();
  await expect(candidateRow.getByText('Mặc định', { exact: true })).toBeVisible();

  const originalDefaultRow = tableRows.filter({ hasText: originalDefaultId });
  await originalDefaultRow.getByRole('button', { name: 'Đặt làm mặc định', exact: true }).click();
  const restoreDialog = page.getByRole('dialog', { name: 'Xác nhận đặt nhà cung cấp mặc định' });
  await restoreDialog.getByLabel('Lý do', { exact: true }).fill('Restore the original stack default after the journey.');
  await restoreDialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(restoreDialog).toBeHidden();
  await expect(originalDefaultRow.getByText('Mặc định', { exact: true })).toBeVisible();
  await expect(candidateRow.getByRole('button', { name: 'Đặt làm mặc định', exact: true })).toBeVisible();
  await assertRouteQuality(page);
});