import { expect, test } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

test('company runs daily QA as a TEST customer through Sales, Care, takeover, trace, and reset', async ({ page }) => {
  await openConsole(page, 'company');
  const stamp = Date.now();
  const customerName = `Stack UI QA ${stamp}`;
  const orderReference = `TEST-UI-${stamp}`;
  const customerEmail = `stack-ui-qa-${stamp}@example.test`;

  await page.goto('/testing/customers/new');
  await page.getByRole('textbox', { name: 'Họ tên' }).fill(customerName);
  await page.getByRole('textbox', { name: 'Email' }).fill(customerEmail);
  await page.getByRole('textbox', { name: 'Phân khúc' }).fill(`stack-qa-${stamp}`);

  // Each seed group is a collapsed <details>; open it the way a user would before filling it.
  const salesSeed = page.locator('details').filter({ hasText: 'Hạt giống Sales' });
  await salesSeed.locator('summary').click();
  await salesSeed.getByRole('checkbox', { name: 'Bật hạt giống Sales' }).check();
  await salesSeed.getByRole('textbox', { name: 'Danh mục quan tâm' }).fill('laptop');
  await salesSeed.getByRole('textbox', { name: 'Ngân sách' }).fill('20000000');
  await salesSeed.getByRole('textbox', { name: 'Nhu cầu' }).fill('graphic design');

  const orderSeed = page.locator('details').filter({ hasText: 'Hạt giống Đơn hàng' });
  await orderSeed.locator('summary').click();
  await orderSeed.getByRole('checkbox', { name: 'Tạo đơn hàng mẫu' }).check();
  await orderSeed.getByRole('textbox', { name: 'Mã đơn' }).fill(orderReference);
  await orderSeed.getByRole('textbox', { name: 'Tổng tiền' }).fill('18900000');
  await orderSeed.getByRole('textbox', { name: 'Mặt hàng (mỗi dòng một mặt hàng)' }).fill('Nova Studio 14');

  const careSeed = page.locator('details').filter({ hasText: 'Hạt giống Hỗ trợ' });
  await careSeed.locator('summary').click();
  await careSeed.getByRole('checkbox', { name: 'Mở yêu cầu hỗ trợ' }).check();
  await careSeed.getByRole('textbox', { name: 'Chủ đề', exact: true }).fill('Order status assistance');

  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(page.locator('pre')).toContainText(orderReference);
  await page.getByRole('button', { name: 'Tạo khách hàng thử', exact: true }).click();
  const openCustomer = page.getByRole('link', { name: 'Mở Customer360' });
  const storefrontLink = page.getByRole('link', { name: 'Khởi chạy Storefront với khách này' });
  await expect(openCustomer).toBeVisible();
  const customerHref = await openCustomer.getAttribute('href');

  await openCustomer.click();
  await expect(page.getByRole('heading', { name: customerName })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('region', { name: 'Đơn hàng gần đây' })).toContainText(orderReference);
  await expect(page.getByRole('region', { name: 'Đồng ý theo kênh' })).toBeVisible();
  await assertRouteQuality(page);
  await page.getByRole('link', { name: 'Khởi chạy Storefront như khách này' }).click();

  await expect(page.getByRole('heading', { name: 'Storefront thử nghiệm' })).toBeVisible();
  await expect(page.getByText(`Phiên khách hàng: ${customerName} (TEST)`)).toBeVisible();
  await assertRouteQuality(page);
  const chat = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Tin nhắn' }) });
  const messageBox = chat.getByRole('textbox', { name: 'Tin nhắn' });
  const entries = chat.locator('[aria-live="polite"] > div');

  await messageBox.fill('I need a laptop under 20 million VND for graphic design.');
  await chat.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(entries.nth(1).locator('p').first()).toBeVisible({ timeout: 240_000 });
  await expect(chat.getByRole('button', { name: 'Vì sao gợi ý này?' })).toBeVisible({ timeout: 240_000 });
  await expect(entries.nth(1).locator('p').first()).not.toHaveAttribute('role', 'alert');

  await messageBox.fill(`Where is my order ${orderReference}?`);
  await chat.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(entries.nth(3).locator('p').first()).toBeVisible({ timeout: 240_000 });
  await expect(chat.getByRole('button', { name: 'Vì sao gợi ý này?' }).nth(1)).toBeVisible({ timeout: 240_000 });
  await expect(entries.nth(3).locator('p').first()).not.toHaveAttribute('role', 'alert');

  await messageBox.fill('I want to speak to a person');
  await chat.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(entries.nth(5).locator('p').first()).toHaveText('Lượt tư vấn cần nhân viên hỗ trợ tiếp tục.', { timeout: 240_000 });

  await page.goto('/conversations');
  const handoff = page
    .locator('aside[aria-label="Danh sách hội thoại"] ul button')
    .filter({ hasText: customerName })
    .first();
  await expect(handoff).toBeVisible({ timeout: 120_000 });
  await handoff.click();
  await page.getByRole('button', { name: 'Nhận xử lý', exact: true }).click();
  const takeoverDialog = page.getByRole('dialog', { name: 'Xác nhận tiếp quản' });
  await expect(takeoverDialog).toBeVisible();
  await takeoverDialog.getByRole('button', { name: 'Nhận xử lý', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã tiếp quản hội thoại.' })).toBeVisible();

  const reply = `Stack UI team member reply ${stamp}.`;
  await page.getByRole('textbox', { name: 'Tin nhắn của nhân viên' }).fill(reply);
  await page.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(page.locator('article').filter({ hasText: reply })).toBeVisible({ timeout: 60_000 });

  await page.goto('/');
  const runLink = page.locator('section[aria-labelledby="overview-activity-heading"] ol li a[href^="/runs/"]').first();
  await expect(runLink).toBeVisible({ timeout: 90_000 });
  const runHref = await runLink.getAttribute('href');
  expect(runHref).toMatch(/^\/runs\/[^/]+$/);
  await page.goto(runHref ?? '/runs/');
  await expect(page.getByText('Chi tiết thực thi', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Kết quả' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trợ lý đã thực hiện' })).toBeVisible();
  await assertRouteQuality(page);

  await page.goto('/testing/customers');
  await assertRouteQuality(page);
  await page.getByRole('button', { name: 'Đặt lại dữ liệu thử nghiệm', exact: true }).click();
  const resetDialog = page.getByRole('dialog', { name: 'Xác nhận đặt lại dữ liệu thử nghiệm' });
  await expect(resetDialog).toBeVisible();
  await resetDialog.getByRole('textbox').fill('RESET');
  await resetDialog.getByRole('button', { name: 'Xác nhận đặt lại', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã đặt lại dữ liệu thử nghiệm.' })).toBeVisible();
  await page.goto('/testing/customers');
  await expect(page.getByRole('link', { name: customerName, exact: true })).toHaveCount(0);
});
