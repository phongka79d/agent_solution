import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { UI_API_BASE_URL } from './global-setup';

const root = resolve(__dirname, '../../..');
const nextAuthSecret = 'ui-ci-nextauth-secret-2026-09-30-agentos';

const consoleEnv = {
  API_BASE_URL: UI_API_BASE_URL,
  NEXT_PUBLIC_API_URL: UI_API_BASE_URL,
  DEMO_MODE: 'true',
  APP_ENV: 'ci',
  NODE_ENV: 'production',
  NEXTAUTH_SECRET: nextAuthSecret,
  TENANT_COOKIE_HMAC_KEY: 'ui-ci-tenant-cookie-hmac-key-2026-09-30',
  PLATFORM_COOKIE_HMAC_KEY: 'ui-ci-platform-cookie-hmac-key-2026-09-30',
};

export default defineConfig({
  testDir: __dirname,
  globalSetup: resolve(__dirname, 'global-setup.ts'),
  outputDir: resolve(root, 'test-results/ui'),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: process.env.LIVE === '1' ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'tenant-desktop',
      testMatch: /tenant\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3100', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'tenant-mobile',
      testMatch: /tenant\.spec\.ts/,
      use: { ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:3100', viewport: { width: 390, height: 844 }, isMobile: true },
    },
    {
      name: 'platform-desktop',
      testMatch: /platform\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3101', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'platform-mobile',
      testMatch: /platform\.spec\.ts/,
      use: { ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:3101', viewport: { width: 390, height: 844 }, isMobile: true },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @agentos/tenant-console exec next start --port 3100',
      cwd: root,
      url: 'http://127.0.0.1:3100/health',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        ...consoleEnv,
        NEXTAUTH_URL: 'http://127.0.0.1:3100',
        PLATFORM_ADMIN_URL: 'http://127.0.0.1:3101',
        PORT: '3100',
      },
    },
    {
      command: 'pnpm --filter @agentos/platform-admin exec next start --port 3101',
      cwd: root,
      url: 'http://127.0.0.1:3101/health',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        ...consoleEnv,
        NEXTAUTH_URL: 'http://127.0.0.1:3101',
        PORT: '3101',
      },
    },
  ],
});
