import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from '@agentos/ui-foundation/auth';

const PLATFORM_SESSION_COOKIE = 'agentos_platform_session';

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
  response.cookies.set(PLATFORM_SESSION_COOKIE, '', { path: '/', maxAge: 0, expires: new Date(0) });
}

function passThrough(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set('x-agentos-pathname', currentPath(request));
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('x-agentos-pathname', currentPath(request));
  return response;
}

function liveCookie(value: string | undefined, nowEpochSec: number): 'missing' | 'live' | 'expired' | 'malformed' {
  if (value === undefined) return 'missing';
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !parts[1] || !parts[3] || !/^\d+$/.test(parts[2] ?? '')) return 'malformed';
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(expiresAt)) return 'malformed';
  return expiresAt > nowEpochSec ? 'live' : 'expired';
}
export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const isApi = pathname === '/api/v1' || pathname.startsWith('/api/v1/') || pathname === '/api/auth' || pathname.startsWith('/api/auth/');
  const isPublic = pathname === '/health' || pathname === '/sign-in' || pathname.startsWith('/sign-in/');
  const cookieState = liveCookie(request.cookies.get(PLATFORM_SESSION_COOKIE)?.value, Math.floor(Date.now() / 1000));

  if (isApi || pathname === '/health') return passThrough(request);
  if (isPublic) {
    if (pathname === '/sign-in' || pathname.startsWith('/sign-in/')) {
      if (cookieState === 'live') return NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get('next')), request.url));
      if (cookieState === 'expired' || cookieState === 'malformed') {
        const response = signInRedirect(request, 'expired');
        clearSessionCookie(response);
        return response;
      }
    }
    return passThrough(request);
  }

  if (cookieState === 'missing') return signInRedirect(request);
  if (cookieState === 'expired' || cookieState === 'malformed') {
    const response = signInRedirect(request, 'expired');
    clearSessionCookie(response);
    return response;
  }
  return passThrough(request);
}
export default middleware;

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)).*)'],
};
