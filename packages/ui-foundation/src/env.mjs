// Shared browser-application configuration checks; no data-store credential is read.
// Next.js instrumentation imports this module, so it contains no node: imports.
export const APP_ENVS = ['local', 'ci', 'staging', 'sandbox', 'production'];
export const NODE_ENVS = ['development', 'test', 'production'];
export const PROFILE_NODE_ENV = {
  local: 'development',
  ci: 'test',
  staging: 'production',
  sandbox: 'production',
  production: 'production',
};

export const DEFAULT_PORT = 3000;

function readEnv(env, key) {
  return env && typeof env === 'object' ? env[key] : undefined;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** @returns {{ path: string, message: string } | null} */
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
 * Validate shared browser-application runtime configuration. Browser applications may select a
 * different default port and require the platform redirect origin.
 * Error reports contain field names and fixed messages, never values.
 * @param {Record<string, unknown>} [env]
 * @param {{ defaultPort?: number, requirePlatformAdminUrl?: boolean }} [options]
 */
export function parseCommandCenterEnv(env = process.env, options = {}) {
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

  const apiUrlIssue = urlIssue(readEnv(source, 'NEXT_PUBLIC_API_URL'), 'NEXT_PUBLIC_API_URL', { originOnly: true });
  if (apiUrlIssue) issues.push(apiUrlIssue);
  const platformAdminUrl = readEnv(source, 'PLATFORM_ADMIN_URL');
  if (options.requirePlatformAdminUrl || platformAdminUrl !== undefined) {
    const platformIssue = urlIssue(platformAdminUrl, 'PLATFORM_ADMIN_URL', { originOnly: true });
    if (platformIssue) issues.push(platformIssue);
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    data: {
      appEnv,
      nodeEnv,
      nextPublicApiUrl: String(readEnv(source, 'NEXT_PUBLIC_API_URL')).trim(),
      port: nonNegativeInt(readEnv(source, 'PORT'), options.defaultPort ?? DEFAULT_PORT),
      ...(platformAdminUrl !== undefined ? { platformAdminUrl: String(platformAdminUrl).trim() } : {}),
    },
  };
}
