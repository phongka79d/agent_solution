import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_API_ORIGIN, apiOrigin } from './api-client';

const original = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  if (original === undefined) {
    delete process.env.NEXT_PUBLIC_API_URL;
  } else {
    process.env.NEXT_PUBLIC_API_URL = original;
  }
});

describe('apiOrigin', () => {
  it('falls back to the local API gateway when NEXT_PUBLIC_API_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_API_URL;

    expect(apiOrigin()).toBe(DEFAULT_API_ORIGIN);
    expect(apiOrigin()).toBe('http://localhost:4000');
  });

  it('uses the configured origin when NEXT_PUBLIC_API_URL is set', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test';

    expect(apiOrigin()).toBe('https://api.example.test');
  });
});
