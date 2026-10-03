import { globalSetup as startStack, globalTeardown } from '../../stack/global-setup.mjs';

export default async function playwrightStackSetup() {
  await startStack();
  return globalTeardown;
}
