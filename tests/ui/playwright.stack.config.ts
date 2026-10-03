import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const companyAuthJourneys = /company signs in|keyboard only|session expiry warning/;
const companyState = resolve(root, 'test-results/ui-auth/company.json');
const platformState = resolve(root, 'test-results/ui-auth/platform.json');

export default defineConfig({
  testDir: resolve(__dirname, 'stack'),
  globalSetup: resolve(__dirname, 'stack/global-setup.mjs'),
  outputDir: resolve(root, 'test-results/ui-stack'),
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
  },
  projects: [
    {
      name: 'company-auth',
      testMatch: /company(?:-keyboard|-integrations-settings)?\.stack\.spec\.ts/,
      grep: companyAuthJourneys,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:13000', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'platform-auth',
      testMatch: /platform(?:-auth)?\.stack\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:13001', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'company-setup',
      testMatch: /auth\.setup\.ts/,
      dependencies: ['company-auth'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:13000' },
    },
    {
      name: 'platform-setup',
      testMatch: /auth\.setup\.ts/,
      dependencies: ['platform-auth'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:13001' },
    },
    {
      name: 'company-stack',
      testMatch: /company.*\.stack\.spec\.ts/,
      grepInvert: companyAuthJourneys,
      dependencies: ['company-setup'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:13000', storageState: companyState, viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'platform-stack',
      testMatch: /platform.*\.stack\.spec\.ts/,
      testIgnore: /platform(?:-auth)?\.stack\.spec\.ts/,
      dependencies: ['platform-setup'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:13001', storageState: platformState, viewport: { width: 1280, height: 800 } },
    },
  ],
});
