import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from '@playwright/test';


const REPO_ROOT = resolve(__dirname, '../..');
const STORAGE_STATE = resolve(REPO_ROOT, 'test-results/live/company-storage-state.json');

function loopbackOrigin(raw: string | undefined, key: string): string {
  if (!raw) throw new Error(`LIVE_UI_CONFIGURATION_MISSING: ${key}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LIVE_UI_CONFIGURATION_INVALID: ${key}`);
  }
  if (
    url.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error(`LIVE_UI_CONFIGURATION_INVALID: ${key} must be an HTTP loopback origin`);
  }
  return url.origin;
}

function isCompanySession(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('membership' in value)) return false;
  const membership = value.membership;
  return typeof membership === 'object'
    && membership !== null
    && 'scope' in membership
    && membership.scope === 'company';
}

export default async function globalSetup(): Promise<void> {
  const envFile = resolve(REPO_ROOT, process.env.LIVE_ENV_FILE ?? '.env');
  const preflight = spawnSync(
    process.execPath,
    [resolve(REPO_ROOT, 'scripts/live/preflight.mjs'), '--env-file', envFile],
    { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' },
  );
  if (preflight.stdout) process.stdout.write(preflight.stdout);
  if (preflight.stderr) process.stderr.write(preflight.stderr);
  if (preflight.error || preflight.status !== 0) {
    throw new Error('LIVE_PREFLIGHT_FAILED: Playwright did not start because live preflight refused');
  }

  if (process.env.APP_ENV !== 'local') {
    throw new Error('LIVE_PREFLIGHT_FAILED: Playwright requires APP_ENV=local');
  }
  const baseURL = loopbackOrigin(process.env.WEB_BASE_URL, 'WEB_BASE_URL');
  const email = process.env.DEMO_COMPANY_ADMIN_EMAIL;
  const password = process.env.DEMO_COMPANY_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('LIVE_UI_CONFIGURATION_MISSING: company demo credentials');

  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { accept: 'application/json' },
  });
  try {
    const bootstrap = await api.get('/api/auth/session');
    if (bootstrap.status() !== 401) throw new Error('LIVE_UI_AUTH_FAILED: expected an unauthenticated bootstrap session');
    const initialState = await api.storageState();
    const csrf = initialState.cookies.find((cookie) => cookie.name === 'agentos_tenant_csrf')?.value;
    if (!csrf) throw new Error('LIVE_UI_AUTH_FAILED: CSRF bootstrap cookie was not issued');

    const signedIn = await api.post('/api/auth/sign-in', {
      headers: {
        origin: baseURL,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
      },
      data: { email, password },
    });
    if (!signedIn.ok()) throw new Error(`LIVE_UI_AUTH_FAILED: API sign-in returned HTTP ${signedIn.status()}`);
    const session: unknown = await signedIn.json().catch(() => null);
    if (!isCompanySession(session)) throw new Error('LIVE_UI_AUTH_FAILED: sign-in did not return a company session');

    const state = await api.storageState();
    if (!state.cookies.some((cookie) => cookie.name === 'agentos_tenant_session' && cookie.value.length > 0)) {
      throw new Error('LIVE_UI_AUTH_FAILED: authenticated session cookie was not issued');
    }
    await mkdir(dirname(STORAGE_STATE), { recursive: true });
    await writeFile(STORAGE_STATE, JSON.stringify(state), { mode: 0o600 });
    await chmod(STORAGE_STATE, 0o600);
  } finally {
    await api.dispose();
  }
}
