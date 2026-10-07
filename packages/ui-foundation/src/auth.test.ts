import { describe, expect, it } from 'vitest';
import { can, canAll, canAny, safeNext, type AuthSession } from './auth.js';

const session: AuthSession = {
  identity: {
    user_id: 'user-1',
    email: 'user@example.com',
    display_name: 'User',
  },
  membership: {
    tenant_id: 'tenant-1',
    tenant_name: null,
    role: 'operator',
    scope: 'company',
  },
  permissions: ['approval:read', 'run:read'],
  expires_at: '2030-01-01T00:00:00.000Z',
};

describe('auth permission helpers', () => {
  it('denies every permission check without a session', () => {
    expect(can(null, 'approval:read')).toBe(false);
    expect(can(undefined, 'approval:read')).toBe(false);
    expect(canAll(null, ['approval:read'])).toBe(false);
    expect(canAll(undefined, ['approval:read'])).toBe(false);
    expect(canAny(null, ['approval:read'])).toBe(false);
    expect(canAny(undefined, ['approval:read'])).toBe(false);
  });

  it('checks one, every, and at least one permission', () => {
    expect(can(session, 'approval:read')).toBe(true);
    expect(can(session, 'platform:admin')).toBe(false);
    expect(canAll(session, ['approval:read', 'run:read'])).toBe(true);
    expect(canAll(session, ['approval:read', 'platform:admin'])).toBe(false);
    expect(canAny(session, ['platform:admin', 'run:read'])).toBe(true);
    expect(canAny(session, ['campaign:draft', 'platform:admin'])).toBe(false);
    expect(canAll(session, [])).toBe(true);
    expect(canAny(session, [])).toBe(false);
  });
});

describe('safeNext', () => {
  it('accepts a same-origin application path', () => {
    expect(safeNext('/approvals?x=1')).toBe('/approvals?x=1');
  });

  it.each([
    '//evil.com',
    '/\\evil',
    'https://evil.com',
    '/sign-in?next=/',
    'javascript:alert(1)',
    '/sign-in?',
    '/sign-in',
    '/sign-in/settings',
    '/api/v1/x',
    '/_next/static/x',
    '/a%0d%0ab',
    '/a%2',
    '/a%ZZ',
    '/a%',
  ])('rejects unsafe next value %j', (value) => {
    expect(safeNext(value)).toBe('/');
  });

  it.each(['', null, undefined])('falls back for missing next value %j', (value) => {
    expect(safeNext(value)).toBe('/');
  });
});
