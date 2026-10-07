import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoAuthProvider, isValidLoginEmail, ProviderHttpError } from './demo-provider';

describe('isValidLoginEmail', () => {
  it('validates email length and non-empty content', () => {
    expect(isValidLoginEmail('user@example.test')).toBe(true);
    expect(isValidLoginEmail('')).toBe(false);
    expect(isValidLoginEmail('   ')).toBe(false);
    expect(isValidLoginEmail(null)).toBe(false);
    expect(isValidLoginEmail(undefined)).toBe(false);
    expect(isValidLoginEmail('a'.repeat(321))).toBe(false);
    expect(isValidLoginEmail('a'.repeat(320))).toBe(true);
  });
});

describe('DemoAuthProvider signIn', () => {
  beforeEach(() => {
    process.env.API_BASE_URL = 'http://localhost:4000';
  });

  it('rejects whitespace-only or oversized email with 400', async () => {
    const fetchMock = vi.fn();
    const provider = createDemoAuthProvider(fetchMock as unknown as typeof fetch);

    await expect(provider.signIn('   ', 'password')).rejects.toThrow(ProviderHttpError);
    await expect(provider.signIn('a'.repeat(321), 'password')).rejects.toThrow(ProviderHttpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
