import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const AES_256_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_HEX = /^[0-9a-f]{64}$/i;

export type SecretKey = string | Uint8Array;

export interface EncryptedSecret {
  readonly nonce: Buffer;
  /** AES-GCM ciphertext followed by the 16-byte authentication tag. */
  readonly ciphertext: Buffer;
  readonly keyVersion: string;
  readonly fingerprint: string;
}

export interface EncryptSecretInput {
  readonly plaintext: string;
  readonly aad: string;
  readonly key: SecretKey;
  readonly keyVersion: string;
}

export interface DecryptSecretInput {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly aad: string;
  readonly key: SecretKey;
  readonly keyVersion: string;
  readonly previousKey?: SecretKey | undefined;
}

export interface SecretCipher {
  readonly keyVersion: string;
  encrypt(input: { readonly plaintext: string; readonly aad: string }): EncryptedSecret;
  decrypt(input: Omit<DecryptSecretInput, 'key' | 'previousKey'>): string;
}

function keyBytes(key: SecretKey): Uint8Array {
  if (typeof key === 'string') {
    if (!KEY_HEX.test(key)) throw new Error('SECRET_ENCRYPTION_KEY_INVALID');
    return Buffer.from(key, 'hex');
  }
  if (!(key instanceof Uint8Array) || key.byteLength !== AES_256_KEY_BYTES) {
    throw new Error('SECRET_ENCRYPTION_KEY_INVALID');
  }
  return key;
}

export function secretKeyVersion(key: SecretKey): string {
  return createHash('sha256').update(keyBytes(key)).digest('hex').slice(0, 8);
}

export function encryptSecret(input: EncryptSecretInput): EncryptedSecret {
  const key = keyBytes(input.key);
  const keyVersion = createHash('sha256').update(key).digest('hex').slice(0, 8);
  if (input.keyVersion !== keyVersion) throw new Error('SECRET_KEY_VERSION_MISMATCH');

  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(input.aad, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(input.plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const fingerprint = createHash('sha256').update(input.plaintext, 'utf8').digest('hex');
  return { nonce, ciphertext: encrypted, keyVersion, fingerprint };
}

export function decryptSecret(input: DecryptSecretInput): string {
  if (input.nonce.byteLength !== GCM_NONCE_BYTES || input.ciphertext.byteLength < GCM_TAG_BYTES) {
    throw new Error('SECRET_CIPHERTEXT_INVALID');
  }

  const currentKey = keyBytes(input.key);
  const previousKey = input.previousKey === undefined ? undefined : keyBytes(input.previousKey);
  let key: Uint8Array;
  if (createHash('sha256').update(currentKey).digest('hex').slice(0, 8) === input.keyVersion) {
    key = currentKey;
  } else if (
    previousKey !== undefined &&
    createHash('sha256').update(previousKey).digest('hex').slice(0, 8) === input.keyVersion
  ) {
    key = previousKey;
  } else {
    throw new Error('SECRET_KEY_VERSION_UNAVAILABLE');
  }

  try {
    const payload = Buffer.from(input.ciphertext.buffer, input.ciphertext.byteOffset, input.ciphertext.byteLength);
    const tag = payload.subarray(payload.byteLength - GCM_TAG_BYTES);
    const encrypted = payload.subarray(0, payload.byteLength - GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, input.nonce);
    decipher.setAAD(Buffer.from(input.aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    // Do not expose crypto error details; in particular, wrong AAD and tampering have one result.
    throw new Error('SECRET_DECRYPTION_FAILED');
  }
}

/** Binds current/previous environment keys for repository writes and runtime reads. */
export function createSecretCipher(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretCipher {
  const rawKey = env.ENCRYPTION_KEY_AES256;
  if (rawKey === undefined || !KEY_HEX.test(rawKey)) throw new Error('SECRET_ENCRYPTION_KEY_INVALID');
  const key = keyBytes(rawKey);
  const rawPrevious = env.ENCRYPTION_KEY_AES256_PREVIOUS;
  const previousKey = rawPrevious === undefined || rawPrevious === '' ? undefined : keyBytes(rawPrevious);
  const keyVersion = secretKeyVersion(key);

  return {
    keyVersion,
    encrypt: ({ plaintext, aad }) => encryptSecret({ plaintext, aad, key, keyVersion }),
    decrypt: (input) => decryptSecret({ ...input, key, ...(previousKey === undefined ? {} : { previousKey }) }),
  };
}
