import {
  createSecretCipher,
  type SecretCipher,
} from './cipher.js';

export interface EncryptedSecretRecord {
  readonly secret_id: string;
  readonly purpose: string;
  readonly key_version: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface EncryptedSecretReader {
  getEncrypted(tenant_id: string, secret_id: string): Promise<EncryptedSecretRecord | null>;
  getEncryptedPlatform?(secret_id: string): Promise<EncryptedSecretRecord | null>;
}

export class SecretResolver {
  constructor(
    private readonly secrets: EncryptedSecretReader,
    private readonly cipher: Pick<SecretCipher, 'decrypt'>,
  ) {}

  async resolve(tenant_id: string, secret_id: string): Promise<string> {
    const secret = await this.secrets.getEncrypted(tenant_id, secret_id);
    if (secret === null) throw new Error('SECRET_NOT_AVAILABLE');

    return this.cipher.decrypt({
      nonce: secret.nonce,
      ciphertext: secret.ciphertext,
      keyVersion: secret.key_version,
      aad: `${tenant_id}|${secret.secret_id}|${secret.purpose}`,
    });
  }

  async resolvePlatform(secret_id: string): Promise<string> {
    if (this.secrets.getEncryptedPlatform === undefined) throw new Error('PLATFORM_SECRET_NOT_AVAILABLE');
    const secret = await this.secrets.getEncryptedPlatform(secret_id);
    if (secret === null) throw new Error('SECRET_NOT_AVAILABLE');

    return this.cipher.decrypt({
      nonce: secret.nonce,
      ciphertext: secret.ciphertext,
      keyVersion: secret.key_version,
      aad: `platform|${secret.secret_id}|${secret.purpose}`,
    });
  }
}

export function createSecretResolver(
  secrets: EncryptedSecretReader,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretResolver {
  const cipher = createSecretCipher(env);
  return new SecretResolver(secrets, cipher);
}

