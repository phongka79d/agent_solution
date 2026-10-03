import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { appendConfigAudit } from './platform-audit.js';
import { withPlatformRole, type PlatformTransactionRunner } from './platform-directory.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

export interface EncryptedSecret {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly keyVersion: string;
  readonly fingerprint: string;
}

export interface SecretEncryptor {
  encrypt(input: { readonly plaintext: string; readonly aad: string }): EncryptedSecret | Promise<EncryptedSecret>;
}

export interface SecretAuditContext {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export interface PutPlatformSecretInput extends SecretAuditContext {
  readonly purpose: string;
  readonly plaintext: string;
}

export interface PlatformSecretDescription {
  readonly secret_id: string;
  readonly purpose: string;
  readonly fingerprint: string;
  readonly last4: string;
  readonly created_at: string;
}

export interface PutTenantSecretInput extends SecretAuditContext {
  readonly purpose: string;
  readonly plaintext: string;
}

export interface TenantSecretDescription {
  readonly secret_id: string;
  readonly purpose: string;
  readonly fingerprint: string;
  readonly last4: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

export interface EncryptedTenantSecret {
  readonly secret_id: string;
  readonly purpose: string;
  readonly key_version: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

interface SecretDescriptionRow extends QueryResultRow {
  readonly secret_id: string;
  readonly purpose: string;
  readonly fingerprint: string;
  readonly last4: string;
  readonly created_at: Date | string;
  readonly revoked_at: Date | string | null;
}

interface EncryptedSecretRow extends QueryResultRow {
  readonly secret_id: string;
  readonly purpose: string;
  readonly key_version: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
}

interface InsertedSecretRow extends QueryResultRow {
  readonly secret_id: string;
  readonly fingerprint: string;
  readonly last4: string;
  readonly created_at: Date | string;
}

export class SecretRepository {
  constructor(
    private readonly cipher: SecretEncryptor,
    private readonly runInTenantTransaction: TenantTransactionRunner = withTenantContext,
    private readonly runInPlatformTransaction: PlatformTransactionRunner = withPlatformRole,
  ) {}

  async putPlatform(input: PutPlatformSecretInput): Promise<PlatformSecretDescription> {
    if (
      input.purpose.length === 0
      || input.actor_kind.length === 0
      || input.actor_id.length === 0
      || input.correlation_id.length === 0
      || input.plaintext.length === 0
    ) {
      throw new Error('SECRET_INPUT_INVALID');
    }

    const secret_id = randomUUID();
    const encrypted = await this.cipher.encrypt({
      plaintext: input.plaintext,
      aad: `platform|${secret_id}|${input.purpose}`,
    });

    return this.runInPlatformTransaction(async (client) => {
      const result = await client.query<InsertedSecretRow>(
        `INSERT INTO agentos.platform_secrets
           (secret_id, purpose, key_version, nonce, ciphertext, fingerprint, last4, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING secret_id::text AS secret_id, fingerprint, last4, created_at`,
        [secret_id, input.purpose, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext,
          encrypted.fingerprint, input.plaintext.slice(-4), input.actor_id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('SECRET_PERSISTENCE_FAILED');
      const created_at = row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString();
      await appendConfigAudit(client, {
        actor_kind: input.actor_kind,
        actor_id: input.actor_id,
        scope: 'PLATFORM',
        action: 'secret.create',
        target_tenant: null,
        target: secret_id,
        outcome: 'ACCEPTED',
        reason: null,
        before: null,
        after: { purpose: input.purpose, fingerprint: row.fingerprint, last4: row.last4 },
        correlation_id: input.correlation_id,
      });
      return {
        secret_id: row.secret_id,
        purpose: input.purpose,
        fingerprint: row.fingerprint,
        last4: row.last4,
        created_at,
      };
    });
  }

  async put(tenant_id: string, input: PutTenantSecretInput): Promise<TenantSecretDescription> {
    if (
      input.purpose.length === 0
      || input.actor_kind.length === 0
      || input.actor_id.length === 0
      || input.correlation_id.length === 0
      || input.plaintext.length === 0
    ) {
      throw new Error('SECRET_INPUT_INVALID');
    }

    const secret_id = randomUUID();
    const encrypted = await this.cipher.encrypt({
      plaintext: input.plaintext,
      aad: `${tenant_id}|${secret_id}|${input.purpose}`,
    });

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<InsertedSecretRow>(
        `INSERT INTO agentos.tenant_secrets
           (tenant_id, secret_id, purpose, key_version, nonce, ciphertext,
            fingerprint, last4, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING secret_id::text AS secret_id, fingerprint, last4, created_at`,
        [
          tenant_id,
          secret_id,
          input.purpose,
          encrypted.keyVersion,
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.fingerprint,
          input.plaintext.slice(-4),
          input.actor_id,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('SECRET_PERSISTENCE_FAILED');
      const created_at = row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString();
      await appendConfigAudit(client, {
        actor_kind: input.actor_kind,
        actor_id: input.actor_id,
        scope: 'COMPANY',
        action: 'secret.create',
        target_tenant: tenant_id,
        target: secret_id,
        outcome: 'ACCEPTED',
        reason: null,
        before: null,
        after: {
          purpose: input.purpose,
          fingerprint: row.fingerprint,
          last4: row.last4,
        },
        correlation_id: input.correlation_id,
      });
      return {
        secret_id: row.secret_id,
        purpose: input.purpose,
        fingerprint: row.fingerprint,
        last4: row.last4,
        created_at,
        revoked_at: null,
      };
    });
  }

  async describe(tenant_id: string, secret_id: string): Promise<TenantSecretDescription | null> {
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<SecretDescriptionRow>(
        `SELECT secret_id::text AS secret_id, purpose, fingerprint, last4,
                created_at, revoked_at
           FROM agentos.tenant_secrets
          WHERE tenant_id = $1 AND secret_id = $2`,
        [tenant_id, secret_id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const created_at = row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString();
      const revoked_at = row.revoked_at === null
        ? null
        : row.revoked_at instanceof Date
          ? row.revoked_at.toISOString()
          : new Date(row.revoked_at).toISOString();
      return {
        secret_id: row.secret_id,
        purpose: row.purpose,
        fingerprint: row.fingerprint,
        last4: row.last4,
        created_at,
        revoked_at,
      };
    });
  }

  async revoke(tenant_id: string, secret_id: string, context: SecretAuditContext): Promise<boolean> {
    if (
      context.actor_kind.length === 0
      || context.actor_id.length === 0
      || context.correlation_id.length === 0
    ) {
      throw new Error('SECRET_INPUT_INVALID');
    }

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<SecretDescriptionRow>(
        `UPDATE agentos.tenant_secrets
            SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
          WHERE tenant_id = $1 AND secret_id = $2
          RETURNING secret_id::text AS secret_id, purpose, fingerprint, last4,
                    created_at, revoked_at`,
        [tenant_id, secret_id],
      );
      const row = result.rows[0];
      await appendConfigAudit(client, {
        actor_kind: context.actor_kind,
        actor_id: context.actor_id,
        scope: 'COMPANY',
        action: 'secret.revoke',
        target_tenant: tenant_id,
        target: secret_id,
        outcome: row === undefined ? 'NOT_FOUND' : 'ACCEPTED',
        reason: null,
        before: null,
        after: row === undefined
          ? null
          : {
              purpose: row.purpose,
              fingerprint: row.fingerprint,
              last4: row.last4,
              revoked: true,
            },
        correlation_id: context.correlation_id,
      });
      return row !== undefined;
    });
  }

  /** Internal runtime read for platform-owned provider credentials. AAD is `platform|id|purpose`. */
  async getEncryptedPlatform(secret_id: string): Promise<EncryptedTenantSecret | null> {
    return withPlatformRole(async (client) => {
      const result = await client.query<EncryptedSecretRow>(
        `SELECT secret_id::text AS secret_id, purpose, key_version, nonce, ciphertext
           FROM agentos.platform_secrets
          WHERE secret_id = $1 AND revoked_at IS NULL`,
        [secret_id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        secret_id: row.secret_id,
        purpose: row.purpose,
        key_version: row.key_version,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      };
    });
  }

  /** Internal tenant-scoped runtime read. Revoked rows are never returned to a resolver. */
  async getEncrypted(tenant_id: string, secret_id: string): Promise<EncryptedTenantSecret | null> {
    return this.runInTenantTransaction(tenant_id, async (client: PoolClient) => {
      const result = await client.query<EncryptedSecretRow>(
        `SELECT secret_id::text AS secret_id, purpose, key_version, nonce, ciphertext
           FROM agentos.tenant_secrets
          WHERE tenant_id = $1 AND secret_id = $2 AND revoked_at IS NULL`,
        [tenant_id, secret_id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        secret_id: row.secret_id,
        purpose: row.purpose,
        key_version: row.key_version,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      };
    });
  }
}

