import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies only the password used to create the salted scrypt hash', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    expect(encoded).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    await expect(verifyPassword('correct horse battery staple', encoded)).resolves.toBe(true);
    await expect(verifyPassword('incorrect horse battery staple', encoded)).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery staple', 'invalid')).resolves.toBe(false);
  });
});
