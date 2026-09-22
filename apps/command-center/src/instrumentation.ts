// Command Center boot gate for the Next.js standalone server.
//
// The container entrypoint is Next's standalone `server.js`, not `node src/server.mjs`, so the
// stub's fail-closed configuration check has to run from inside the Next process. `register()`
// is that seam: Next calls it once, when the server instance is bootstrapped and before it
// serves a request, and the `process.exit(1)` below stops a misconfigured container exactly as
// `node src/server.mjs` used to.
//
// `parseCommandCenterEnv` is reused verbatim and the gateway `parseEnvironment` is deliberately
// NOT called: the latter requires DATABASE_URL, and this process reads no data-store
// credential at all. Nothing here reads DATABASE_URL, REDIS_*, QDRANT_* or the ERP secrets,
// and the report below carries field paths and fixed messages only, never a value.

export async function register(): Promise<void> {
  // Instrumentation also runs on the edge runtime, where the Node HTTP stub cannot load.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // A static import cannot be used: this module is also compiled for the edge runtime, and
  // `env.mjs` pulls the Node validator, so it may only be loaded after the runtime check.
  // The specifier stays the literal `./env.mjs` so the standalone trace follows it. It does
  // not import `server.mjs`, which uses `node:http` and breaks the Next 14 webpack build.
  const { parseCommandCenterEnv } = await import('./env.mjs');

  // Next.js standalone forces NODE_ENV=production before register(). APP_ENV remains the
  // profile selector (01 §3.1); the forced runtime mode is not a second profile.
  const env = { ...process.env };
  if (env.APP_ENV === 'local' && env.NODE_ENV === 'production') env.NODE_ENV = 'development';
  if (env.APP_ENV === 'ci' && env.NODE_ENV === 'production') env.NODE_ENV = 'test';

  const parsed = parseCommandCenterEnv(env);
  if (parsed.ok) return;
  // Same value-free report as `printFatal` in `src/server.mjs`, so every image fails alike.
  const lines = ['FATAL: Environment validation failed'];
  for (const issue of parsed.issues ?? []) lines.push(`[${issue.path}] ${issue.message}`);
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(1);
}
