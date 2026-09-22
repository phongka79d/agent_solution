// Liveness for the Command Center container.
//
// The container runs the Next.js standalone server (`node apps/command-center/server.js`), so
// the handlers in `src/server.mjs` are never mounted: this App Router route is the `/health`
// the orchestrator sees.
//
// It is the whole contract and nothing more: no authentication, no data-store or gateway call,
// no environment read, no secret. `force-dynamic` keeps the probe answered by the running
// process instead of a response frozen at image build time.

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
