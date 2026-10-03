import { expect, test } from '@playwright/test';
import { assertRouteQuality, signIn } from './helpers';

function accessToken(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'access_token' in value && typeof value.access_token === 'string') {
    return value.access_token;
  }
  throw new Error('Company sign-in did not return an access token.');
}

test('platform admin signs in, signs out, and is redirected after an expired session (T9.2)', async ({ page }) => {
  test.skip(process.env.STACK_AUTH_PROVIDER !== 'db', 'Sign-in, sign-out, and expired-session journeys require STACK_AUTH_PROVIDER=db.');

  await signIn(page, 'platform');
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeVisible();
  await assertRouteQuality(page);

  await page.context().addCookies([{
    name: 'agentos_platform_session',
    value: 'v1.expired.1.signature',
    url: 'http://localhost:13001',
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/sign-in\?reason=expired&next=%2Fsettings$/);
  await expect(page.getByRole('alert').filter({ hasText: 'Phiên đăng nhập đã hết hạn.' })).toContainText('Phiên đăng nhập đã hết hạn.');
  await assertRouteQuality(page);
});

test('a company session is denied at platform sign-in and platform API routes (T9.2)', async ({ page }) => {
  test.skip(process.env.STACK_AUTH_PROVIDER !== 'db', 'Company/platform session separation requires STACK_AUTH_PROVIDER=db.');
  const email = process.env.DEMO_COMPANY_ADMIN_EMAIL;
  const password = process.env.DEMO_COMPANY_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Stack company DB credentials are unavailable.');

  await page.goto('/sign-in?next=%2F');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Email hoặc mật khẩu không đúng.' })).toContainText('Email hoặc mật khẩu không đúng.');
  await expect(page).toHaveURL(/\/sign-in\?next=%2F$/);
  await assertRouteQuality(page);

  const login = await page.request.post('http://localhost:14000/api/v1/auth/login', {
    data: { audience: 'company', email, password },
  });
  expect(login.status()).toBe(200);
  const token = accessToken(await login.json());
  const denial = await page.request.get('http://localhost:14000/api/v1/platform/providers', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(denial.status()).toBe(403);
});
