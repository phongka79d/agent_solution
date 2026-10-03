import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { signIn } from './helpers';

// Run real auth/expiry journeys before setup: a console sign-in revokes the user's older sessions.
test('save audience authentication for ordinary UI journeys', async ({ page }, testInfo) => {
  const audience = testInfo.project.name === 'company-setup' ? 'company' : 'platform';
  await signIn(page, audience);
  const directory = resolve(__dirname, '../../../test-results/ui-auth');
  await mkdir(directory, { recursive: true });
  await page.context().storageState({ path: resolve(directory, `${audience}.json`) });
});
