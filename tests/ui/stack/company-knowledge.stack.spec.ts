import { expect, test } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

test('company creates, submits, and approves knowledge for AI use', async ({ page }) => {
  await openConsole(page, 'company');
  await page.goto('/knowledge');
  await expect(page.getByRole('heading', { name: 'Kiến thức' })).toBeVisible();
  await assertRouteQuality(page);

  const title = `Stack UI knowledge ${Date.now()}`;
  await page.getByRole('button', { name: 'Thêm tài liệu', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Thêm tài liệu' });
  await editor.getByRole('textbox', { name: 'Tiêu đề' }).fill(title);
  await editor.getByRole('textbox', { name: 'Nội dung (Markdown)' }).fill('Customers may request a return within thirty days of delivery.');
  await editor.getByRole('button', { name: 'Gửi duyệt', exact: true }).click();

  const document = page.getByRole('row').filter({ hasText: title });
  await expect(document).toContainText('Chờ duyệt');
  await document.getByRole('button', { name: 'Kiểm duyệt', exact: true }).click();
  const review = page.getByRole('dialog', { name: title });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Duyệt', exact: true }).click();

  const availableLabel = await page.locator('select option[value="AVAILABLE"]').textContent();
  if (availableLabel === null) throw new Error('Knowledge status catalog is missing AVAILABLE');
  await expect(document).toContainText(availableLabel.trim());
});
