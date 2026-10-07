import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const COOKIE_KEY = 'p'.repeat(32);
const COOKIE_NAME = 'agentos_platform_session';

function cookie(expiry: number, key = COOKIE_KEY, id = 'session-id'): string {
  const payload = `v1.${id}.${expiry}`;
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function request(path: string, value?: string): NextRequest {
  const headers = value ? { cookie: `${COOKIE_NAME}=${encodeURIComponent(value)}` } : undefined;
  return new NextRequest(`http://localhost${path}`, headers ? { headers } : undefined);
}

describe('platform middleware', () => {
  const previousKey = process.env.PLATFORM_COOKIE_HMAC_KEY;

  beforeEach(() => {
    process.env.PLATFORM_COOKIE_HMAC_KEY = COOKIE_KEY;
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.PLATFORM_COOKIE_HMAC_KEY;
    else process.env.PLATFORM_COOKIE_HMAC_KEY = previousKey;
  });

  it('redirects an unauthenticated app request with its safe next path', async () => {
    const response = await middleware(request('/operations?state=failed'));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('next')).toBe('/operations?state=failed');
  });

  it('passes a live session with no-store and the pathname marker', async () => {
    const response = await middleware(request('/operations', cookie(Math.floor(Date.now() / 1000) + 300)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-agentos-pathname')).toBe('/operations');
  });

  it('redirects a signed-in sign-in request to its safe next path', async () => {
    const response = await middleware(request('/sign-in?next=%2Fsettings', cookie(Math.floor(Date.now() / 1000) + 300)));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/settings');
  });

  it('falls back to the root for an unsafe sign-in next path', async () => {
    const response = await middleware(request('/sign-in?next=%2F%2Fevil.example', cookie(Math.floor(Date.now() / 1000) + 300)));
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/');
  });

  it('clears an expired cookie and redirects with the expired reason', async () => {
    const response = await middleware(request('/settings', cookie(Math.floor(Date.now() / 1000) - 1)));
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('reason')).toBe('expired');
    expect(response.headers.get('set-cookie')).toContain(`${COOKIE_NAME}=`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('clears a malformed cookie and redirects with the expired reason', async () => {
    const response = await middleware(request('/', 'not-a-session'));
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('reason')).toBe('expired');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('passes API v1 requests without applying page authentication', async () => {
    const response = await middleware(request('/api/v1/runs'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
