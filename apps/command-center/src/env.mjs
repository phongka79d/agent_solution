// Command Center configuration checks. No HTTP server and no data-store credential:
// Next.js instrumentation imports this module, so it must stay free of `node:` schemes
// that the Next 14 webpack build cannot load.

import {
  APP_ENVS,
  MANAGED_APP_ENVS,
  NODE_ENVS,
  PROFILE_NODE_ENV,
  isPlaceholder,
} from '../../../packages/core-engine/src/config/env.validator.mjs';

export const DEFAULT_PORT = 3000;
export const MIN_NEXTAUTH_SECRET_LENGTH = 32;

function readEnv(env, key) {
  return env && typeof env === 'object' ? env[key] : undefined;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ originOnly?: boolean }} [opts]
 * @returns {{ path: string, message: string } | null}
 */
function urlIssue(value, path, opts = {}) {
  const raw = String(value ?? '').trim();
  if (raw === '') return { path, message: 'is required' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { path, message: 'must be an absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { path, message: 'must use http or https' };
  if (url.hostname === '') return { path, message: 'must include a host' };
  if (url.username !== '' || url.password !== '') return { path, message: 'must not embed credentials' };

  if (opts.originOnly) {
    if (url.pathname.toLowerCase().includes('/api/v1')) {
      return { path, message: 'must be the gateway origin only (no /api/v1 suffix)' };
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return { path, message: 'must be an origin only (no path, query or fragment)' };
    }
  }

  return null;
}

/**
 * Profile, runtime mode, NextAuth secret, and the two browser-facing URLs.
 * No data-store variable is read, and no issue message contains a value.
 *
 * @param {Record<string, unknown>} [env]
 */
export function parseCommandCenterEnv(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  /** @type {Array<{ path: string, message: string }>} */
  const issues = [];

  const appEnv = String(readEnv(source, 'APP_ENV') ?? '').trim();
  const requiredNodeEnv = PROFILE_NODE_ENV[appEnv];
  if (appEnv === '') issues.push({ path: 'APP_ENV', message: 'is required' });
  else if (!APP_ENVS.includes(appEnv)) {
    issues.push({ path: 'APP_ENV', message: `must be one of ${APP_ENVS.join(' | ')}` });
  }

  const nodeEnv = String(readEnv(source, 'NODE_ENV') ?? '').trim();
  if (nodeEnv === '') issues.push({ path: 'NODE_ENV', message: 'is required' });
  else if (!NODE_ENVS.includes(nodeEnv)) {
    issues.push({ path: 'NODE_ENV', message: `must be one of ${NODE_ENVS.join(' | ')}` });
  } else if (requiredNodeEnv && nodeEnv !== requiredNodeEnv) {
    issues.push({ path: 'NODE_ENV', message: `must be "${requiredNodeEnv}" when APP_ENV is "${appEnv}"` });
  }

  const secret = String(readEnv(source, 'NEXTAUTH_SECRET') ?? '');
  if (secret === '') issues.push({ path: 'NEXTAUTH_SECRET', message: 'is required' });
  else if (secret.length < MIN_NEXTAUTH_SECRET_LENGTH) {
    issues.push({ path: 'NEXTAUTH_SECRET', message: `must be at least ${MIN_NEXTAUTH_SECRET_LENGTH} characters` });
  } else if (MANAGED_APP_ENVS.includes(appEnv) && isPlaceholder(secret)) {
    issues.push({ path: 'NEXTAUTH_SECRET', message: `must not be a placeholder value when APP_ENV is "${appEnv}"` });
  }

  const nextAuthIssue = urlIssue(readEnv(source, 'NEXTAUTH_URL'), 'NEXTAUTH_URL');
  if (nextAuthIssue) issues.push(nextAuthIssue);

  const apiUrlIssue = urlIssue(readEnv(source, 'NEXT_PUBLIC_API_URL'), 'NEXT_PUBLIC_API_URL', { originOnly: true });
  if (apiUrlIssue) issues.push(apiUrlIssue);

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    data: {
      appEnv,
      nodeEnv,
      nextAuthUrl: String(readEnv(source, 'NEXTAUTH_URL')).trim(),
      nextPublicApiUrl: String(readEnv(source, 'NEXT_PUBLIC_API_URL')).trim(),
      port: nonNegativeInt(readEnv(source, 'PORT'), DEFAULT_PORT),
    },
  };
}
