import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const storageState = resolve(root, 'test-results/live/company-storage-state.json');

export default defineConfig({
  testDir: resolve(__dirname, 'ui'),
  globalSetup: resolve(__dirname, 'global-setup.ts'),
  outputDir: resolve(root, 'test-results/live'),
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'company-live',
      testMatch: /company\.live\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.WEB_BASE_URL ?? 'http://127.0.0.1:3000',
        storageState,
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
