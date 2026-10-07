import type { AuthSession } from '@agentos/ui-foundation/auth';
import {
  appendClearedCookies,
  backendErrorPayload,
  configurationResponse,
  destroySession,
  forbiddenResponse,
  getSessionFromRequest,
  hasCookieKey,
  isAuthEnabled,
  isMutationMethod,
  jsonResponse,
  MAX_PROXY_BODY_BYTES,
  mutationGuard,
  unauthorizedResponse,
} from '../../../../lib/auth/session';
import {
  apiV1Url,
  demoAuthProvider,
  ExpiredProviderSessionError,
  ProviderHttpError,
} from '../../../../lib/auth/demo-provider';
import { isAllowedPath, routePath } from '../../../../lib/bff-allowlist';
import { getDemoMockResponse } from '../../../../lib/demo-mock-fallback';
export const dynamic = 'force-dynamic';


const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'idempotency-key',
  'if-none-match',
  'if-match',
  'x-correlation-id',
  'x-idempotency-key',
  'x-request-id',
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-type',
  'etag',
  'last-modified',
  'location',
] as const;

type RouteContext = { params: { path?: string[] } | Promise<{ path?: string[] }> };




function requestHeaders(request: Request, token: string, path: string): Headers {
  const incomingAuth = request.headers.get('authorization');
  const headers = new Headers({
    Authorization: path.startsWith('storefront/') && incomingAuth ? incomingAuth : `Bearer ${token}`,
  });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (path === 'demo/widget-session') {
    const origin = request.headers.get('origin');
    if (origin) headers.set('origin', origin);
  }
  return headers;
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  if (!isAuthEnabled()) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
  if (!hasCookieKey()) return configurationResponse();

  const params = await context.params;
  const path = routePath(params.path);
  if (!path || !isAllowedPath(path, request.method.toUpperCase())) return jsonResponse({ error: 'NOT_FOUND' }, 404);

  const session = await getSessionFromRequest(request);
  if (!session) return unauthorizedResponse();
  if (isMutationMethod(request.method)) {
    const guard = mutationGuard(request, session);
    if (guard) return guard;
  }

  let verified: AuthSession | null;
  try {
    verified = await demoAuthProvider.getSession(request);
  } catch (error) {
    if (error instanceof ExpiredProviderSessionError) {
      await destroySession(request);
      const response = unauthorizedResponse('expired');
      appendClearedCookies(response, request);
      return response;
    }
    if (error instanceof ProviderHttpError) {
      if (error.status === 403) return jsonResponse(backendErrorPayload(error.payload, 'FORBIDDEN'), 403);
      return jsonResponse({ error: 'SESSION_LOOKUP_FAILED' }, 502);
    }
    return jsonResponse({ error: 'SESSION_LOOKUP_FAILED' }, 502);
  }
  if (!verified) return unauthorizedResponse();
  session.authSession = verified;
  if (path === 'demo/widget-session' && !session.authSession.permissions.includes('conversation:takeover')) return forbiddenResponse();

  let body: ArrayBuffer | undefined;
  if (isMutationMethod(request.method)) {
    const declaredLength = Number(request.headers.get('content-length') || '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BODY_BYTES) return jsonResponse({ error: 'REQUEST_TOO_LARGE' }, 413);
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_PROXY_BODY_BYTES) return jsonResponse({ error: 'REQUEST_TOO_LARGE' }, 413);
  }

  let target: string;
  try {
    target = `${apiV1Url(`/${path}`)}${new URL(request.url).search}`;
  } catch {
    return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 503);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: requestHeaders(request, session.apiToken, path),
      ...(body ? { body } : {}),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    if (process.env.APP_ENV === 'local' || process.env.DEMO_MODE === 'true') {
      const mock = getDemoMockResponse(path, request.method);
      if (mock) return mock;
    }
    return jsonResponse({ error: 'API_UNAVAILABLE' }, 502);
  }

  if (upstream.status === 401) {
    if (!path.startsWith('storefront/')) {
      destroySession(request);
      const response = unauthorizedResponse('expired');
      appendClearedCookies(response, request);
      return response;
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}
