import { describe, expect, it } from 'vitest';

import {
  createSecretCipher,
  decryptSecret,
  encryptSecret,
  secretKeyVersion,
} from './cipher.js';
import { createSecretResolver } from './resolver.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const SECRET_ID = '20000000-0000-4000-8000-000000000002';
const PURPOSE = 'llm:openai';
const AAD = `${TENANT}|${SECRET_ID}|${PURPOSE}`;
const CURRENT_KEY = '01'.repeat(32);
const PREVIOUS_KEY = '02'.repeat(32);

function encryptUnder(key: string, plaintext: string) {
  const keyVersion = secretKeyVersion(key);
  return encryptSecret({ plaintext, aad: AAD, key, keyVersion });
}

describe('AES-256-GCM secret cipher', () => {
  it('round-trips with the tenant-bound AAD and derives key ids from SHA-256', () => {
    const encrypted = encryptUnder(CURRENT_KEY, 'api-secret-value');

    expect(encrypted.keyVersion).toMatch(/^[0-9a-f]{8}$/);
    expect(encrypted.keyVersion).toBe(secretKeyVersion(CURRENT_KEY));
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.ciphertext).toHaveLength(Buffer.byteLength('api-secret-value') + 16);
    expect(encrypted.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(decryptSecret({ ...encrypted, aad: AAD, key: CURRENT_KEY })).toBe('api-secret-value');
  });

  it('rejects a ciphertext opened with different AAD', () => {
    const encrypted = encryptUnder(CURRENT_KEY, 'api-secret-value');

    expect(() => decryptSecret({ ...encrypted, aad: `${TENANT}|other-secret|${PURPOSE}`, key: CURRENT_KEY }))
      .toThrow('SECRET_DECRYPTION_FAILED');
  });

  it('resolves an old-key ciphertext using ENCRYPTION_KEY_AES256_PREVIOUS after rotation', async () => {
    const oldCipher = createSecretCipher({ ENCRYPTION_KEY_AES256: PREVIOUS_KEY });
    const encrypted = oldCipher.encrypt({ plaintext: 'rotated-api-key', aad: AAD });
    const secret = {
      secret_id: SECRET_ID,
      purpose: PURPOSE,
      key_version: encrypted.keyVersion,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
    };
    const resolver = createSecretResolver({
      getEncrypted: async (tenant_id, secret_id) => tenant_id === TENANT && secret_id === SECRET_ID ? secret : null,
    }, {
      ENCRYPTION_KEY_AES256: CURRENT_KEY,
      ENCRYPTION_KEY_AES256_PREVIOUS: PREVIOUS_KEY,
    });

    await expect(resolver.resolve(TENANT, SECRET_ID)).resolves.toBe('rotated-api-key');
    await expect(resolver.resolve(TENANT, 'not-this-tenant-secret')).rejects.toThrow('SECRET_NOT_AVAILABLE');
  });

  it('refuses malformed current and previous encryption keys', () => {
    expect(() => createSecretCipher({ ENCRYPTION_KEY_AES256: 'not-hex' }))
      .toThrow('SECRET_ENCRYPTION_KEY_INVALID');
    expect(() => createSecretCipher({
      ENCRYPTION_KEY_AES256: CURRENT_KEY,
      ENCRYPTION_KEY_AES256_PREVIOUS: 'bad-previous-key',
    })).toThrow('SECRET_ENCRYPTION_KEY_INVALID');
  });
});
