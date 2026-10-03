import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertRouteQuality } from './helpers';

async function signInByKeyboard(page: Page): Promise<void> {
  const email = process.env.DEMO_COMPANY_ADMIN_EMAIL;
  const password = process.env.DEMO_COMPANY_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Stack UI sign-in is missing company admin credentials');

  await page.goto('/sign-in?next=%2F');
  await page.locator('#email').focus();
  await page.keyboard.type(email);
  await page.locator('#password').focus();
  await page.keyboard.type(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/);
}

test('company can create, submit, and approve knowledge with the keyboard only', async ({ page }) => {
  await signInByKeyboard(page);
  await page.goto('/knowledge');
  await expect(page.getByRole('heading', { name: 'Kiến thức' })).toBeVisible();
  await assertRouteQuality(page);

  const title = `Keyboard UI knowledge ${Date.now()}`;
  await page.getByRole('button', { name: 'Thêm tài liệu', exact: true }).press('Enter');
  const editor = page.getByRole('dialog', { name: 'Thêm tài liệu' });
  const titleInput = editor.getByRole('textbox', { name: 'Tiêu đề' });
  await titleInput.focus();
  await titleInput.pressSequentially(title);
  const bodyInput = editor.getByRole('textbox', { name: 'Nội dung (Markdown)' });
  await bodyInput.focus();
  await bodyInput.pressSequentially('Customers may return an item within thirty days of delivery.');
  await editor.getByRole('button', { name: 'Gửi duyệt', exact: true }).press('Enter');

  const document = page.getByRole('row').filter({ hasText: title });
  await expect(document).toContainText('Chờ duyệt');
  await document.getByRole('button', { name: 'Kiểm duyệt', exact: true }).press('Enter');
  const review = page.getByRole('dialog', { name: title });
  await review.getByRole('button', { name: 'Duyệt', exact: true }).press('Enter');
  const availableLabel = await page.locator('select option[value="AVAILABLE"]').textContent();
  if (availableLabel === null) throw new Error('Knowledge status catalog is missing AVAILABLE');
  await expect(document).toContainText(availableLabel.trim());
});
