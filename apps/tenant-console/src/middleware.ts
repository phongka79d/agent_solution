import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from '@agentos/ui-foundation/auth';

const TENANT_SESSION_COOKIE = 'agentos_tenant_session';
const isDevelopment = process.env.NODE_ENV === 'development';

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function withContentSecurityPolicy(response: NextResponse, policy: string): NextResponse {
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

function currentPath(request: NextRequest): string {
  return `${request.nextUrl.pathname}${request.nextUrl.search}`;
}

function signInRedirect(request: NextRequest, reason?: 'expired'): NextResponse {
  const target = new URL('/sign-in', request.url);
  if (reason) target.searchParams.set('reason', reason);
  target.searchParams.set('next', safeNext(currentPath(request)));
  return NextResponse.redirect(target);
}

function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(TENANT_SESSION_COOKIE, '', { path: '/', maxAge: 0, expires: new Date(0) });
}

function passThrough(request: NextRequest, policy: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set('x-agentos-pathname', currentPath(request));
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Cache-Control', 'no-store');
  return withContentSecurityPolicy(response, policy);
}

function liveCookie(value: string | undefined, nowEpochSec: number): 'missing' | 'live' | 'expired' | 'malformed' {
  if (value === undefined) return 'missing';
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !parts[1] || !parts[3] || !/^\d+$/.test(parts[2] ?? '')) return 'malformed';
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(expiresAt)) return 'malformed';
  return expiresAt > nowEpochSec ? 'live' : 'expired';
}

export default function middleware(request: NextRequest): NextResponse {
  const contentSecurityPolicy = buildContentSecurityPolicy(createNonce());
  const pathname = request.nextUrl.pathname;
  const isApi = pathname === '/api/v1' || pathname.startsWith('/api/v1/') || pathname === '/api/auth' || pathname.startsWith('/api/auth/');
  const isPublic = pathname === '/health' || pathname === '/sign-in' || pathname.startsWith('/sign-in/');
  const cookieState = liveCookie(request.cookies.get(TENANT_SESSION_COOKIE)?.value, Math.floor(Date.now() / 1000));

  if (isApi || pathname === '/health') return passThrough(request, contentSecurityPolicy);
  if (isPublic) {
    if (pathname === '/sign-in' || pathname.startsWith('/sign-in/')) {
      if (request.nextUrl.searchParams.get('reason') === 'expired') {
        const response = passThrough(request, contentSecurityPolicy);
        clearSessionCookie(response);
        return response;
      }
      if (cookieState === 'live') {
        return withContentSecurityPolicy(
          NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get('next')), request.url)),
          contentSecurityPolicy,
        );
      }
      if (cookieState === 'expired' || cookieState === 'malformed') {
        const response = withContentSecurityPolicy(signInRedirect(request, 'expired'), contentSecurityPolicy);
        clearSessionCookie(response);
        return response;
      }
    }
    return passThrough(request, contentSecurityPolicy);
  }

  if (cookieState === 'missing') {
    return withContentSecurityPolicy(signInRedirect(request), contentSecurityPolicy);
  }
  if (cookieState === 'expired' || cookieState === 'malformed') {
    const response = withContentSecurityPolicy(signInRedirect(request, 'expired'), contentSecurityPolicy);
    clearSessionCookie(response);
    return response;
  }
  return passThrough(request, contentSecurityPolicy);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)).*)'],
};
