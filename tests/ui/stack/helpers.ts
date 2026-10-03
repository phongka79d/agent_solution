import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type ConsoleAudience = 'company' | 'platform';

const UUID_TEXT = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i;
const UPPER_SNAKE_TEXT = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

function credential(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Stack UI sign-in is missing ${name}`);
  return value;
}

export async function signIn(page: Page, audience: ConsoleAudience): Promise<void> {
  await page.goto('/sign-in?next=%2F');
  await expect(page).toHaveURL(/\/sign-in\?next=%2F$/);
  await assertRouteQuality(page);

  const prefix = audience === 'company' ? 'DEMO_COMPANY_ADMIN' : 'DEMO_PLATFORM_ADMIN';
  await page.locator('input[type="email"]').fill(credential(`${prefix}_EMAIL`));
  await page.locator('input[type="password"]').fill(credential(`${prefix}_PASSWORD`));
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('main')).toBeVisible();
  await assertRouteQuality(page);
}

/** Ordinary journeys reuse the audience's setup storageState; auth journeys call signIn instead. */
export async function openConsole(page: Page, audience: ConsoleAudience): Promise<void> {
  const port = audience === 'company' ? '13000' : '13001';
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`:${port}/$`));
  await expect(page.getByRole('main')).toBeVisible();
  await assertRouteQuality(page);
}

const apiTokens = new Map<ConsoleAudience, Promise<string>>();

/** API fixture creation needs its own token, not another console login that revokes shared sessions. */
export function stackApiToken(page: Page, audience: ConsoleAudience): Promise<string> {
  const cached = apiTokens.get(audience);
  if (cached) return cached;
  const pending = (async () => {
    const provider = (process.env.STACK_AUTH_PROVIDER ?? process.env.AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
    const prefix = audience === 'company' ? 'DEMO_COMPANY_ADMIN' : 'DEMO_PLATFORM_ADMIN';
    const response = await page.request.post(`http://localhost:14000/api/v1/${provider === 'db' ? 'auth' : 'demo'}/login`, {
      data: { audience, email: credential(`${prefix}_EMAIL`), password: credential(`${prefix}_PASSWORD`) },
    });
    expect(response.status()).toBe(200);
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('access_token' in payload) || typeof payload.access_token !== 'string') {
      throw new Error('Stack API sign-in did not return an access token.');
    }
    return payload.access_token;
  })();
  apiTokens.set(audience, pending);
  return pending;
}

export async function assertRouteQuality(page: Page): Promise<void> {
  let visibleText = await page.locator('body').innerText();
  const technicalValues = await page.locator('main .font-mono').allInnerTexts();
  const routeValues = new URL(page.url()).pathname.split('/').map((segment) => decodeURIComponent(segment));
  for (const value of [...technicalValues, ...routeValues]) {
    if (UUID_TEXT.test(value.trim())) visibleText = visibleText.replaceAll(value.trim(), '');
  }
  expect(visibleText, 'visible copy must not contain UUIDs').not.toMatch(UUID_TEXT);
  expect(visibleText, 'visible copy must not contain UPPER_SNAKE tokens').not.toMatch(UPPER_SNAKE_TEXT);

  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(serious, serious.map((violation) => `${violation.id}: ${violation.help}`).join('\n')).toEqual([]);
}
