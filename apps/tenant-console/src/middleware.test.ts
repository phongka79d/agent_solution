import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import middleware from './middleware';

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, cookie
    ? { headers: { cookie: `agentos_tenant_session=${cookie}` } }
    : undefined);
}

describe('tenant middleware', () => {
  it('redirects unauthenticated protected requests with the path and query', () => {
    const response = middleware(request('/approvals?x=1'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/sign-in?next=%2Fapprovals%3Fx%3D1');
  });

  it('passes a live cookie without caching', () => {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const response = middleware(request('/approvals', `v1.session.${expires}.signature`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sets a nonce CSP without inline scripts or non-BFF connections', () => {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const response = middleware(request('/approvals', `v1.session.${expires}.signature`));
    const policy = response.headers.get('content-security-policy') ?? '';
    const directives = policy.split(';').map((directive) => directive.trim());
    const scriptSource = directives.find((directive) => directive.startsWith('script-src ')) ?? '';
    const connectSource = directives.find((directive) => directive.startsWith('connect-src ')) ?? '';

    expect(scriptSource).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/);
    expect(scriptSource).not.toContain("'unsafe-inline'");
    expect(connectSource).toBe("connect-src 'self'");
  });

  it('redirects signed-in sign-in requests to a safe next path', () => {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const response = middleware(request('/sign-in?next=//evil.com', `v1.session.${expires}.signature`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
  });

  it('clears an expired cookie and redirects with an expiry reason', () => {
    const expires = Math.floor(Date.now() / 1000) - 1;
    const response = middleware(request('/approvals?x=1', `v1.session.${expires}.signature`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/sign-in?reason=expired&next=%2Fapprovals%3Fx%3D1');
    expect(response.headers.get('set-cookie')).toContain('agentos_tenant_session=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('lets the BFF answer unauthenticated API requests', () => {
    const response = middleware(request('/api/v1/x'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
