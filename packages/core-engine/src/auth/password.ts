import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAX_MEMORY_BYTES,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Create a versioned, salted scrypt password hash suitable for storage in users.password_hash. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string') throw new TypeError('PASSWORD_INVALID');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Verify a password without a data-dependent digest comparison. Malformed hashes fail closed. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt'
      || parts[1] !== String(SCRYPT_N) || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)
      || !/^[A-Za-z0-9_-]+$/.test(parts[4] ?? '') || !/^[A-Za-z0-9_-]+$/.test(parts[5] ?? '')) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.byteLength !== SALT_BYTES || expected.byteLength !== KEY_BYTES) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}
