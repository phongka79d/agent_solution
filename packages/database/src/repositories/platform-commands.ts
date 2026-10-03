import { withPlatformRole } from './platform-directory.js';
import type { PlatformTransactionRunner } from './platform-directory.js';

/** Result of a platform tenant lifecycle command. */
export interface PlatformTenantStatusRecord {
  readonly tenant_id: string;
  readonly status: string;
}

export interface PlatformCompanyRepositoryOptions {
  readonly platformTransaction?: PlatformTransactionRunner;
}

function assertTenantId(tenant_id: string): void {
  if (typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
    throw new Error('PLATFORM_TENANT_ID_REQUIRED: tenant id is required.');
  }
}

/**
 * Platform-only tenant lifecycle commands use the dedicated platform role and a fixed
 * SECURITY DEFINER command fenced by the explicit target tenant context. The route
 * boundary authorizes the platform principal; application-role table privileges stay unchanged.
 */
export class PlatformCompanyRepository {
  private readonly runInPlatformTransaction: PlatformTransactionRunner;

  constructor(options: PlatformCompanyRepositoryOptions = {}) {
    this.runInPlatformTransaction = options.platformTransaction ?? withPlatformRole;
  }

  private async setStatus(tenant_id: string, status: 'SUSPENDED' | 'ACTIVE'): Promise<PlatformTenantStatusRecord> {
    assertTenantId(tenant_id);
    return this.runInPlatformTransaction(async (client) => {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant_id]);
      const result = await client.query<{ tenant_id: string; status: string }>(
        'SELECT tenant_id, status FROM agentos.platform_set_tenant_status($1::uuid, $2::text)',
        [tenant_id, status],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('PLATFORM_TENANT_NOT_FOUND: the requested company was not found.');
      }
      return { tenant_id: row.tenant_id, status: row.status };
    });
  }

  suspend(tenant_id: string): Promise<PlatformTenantStatusRecord> {
    return this.setStatus(tenant_id, 'SUSPENDED');
  }

  resume(tenant_id: string): Promise<PlatformTenantStatusRecord> {
    return this.setStatus(tenant_id, 'ACTIVE');
  }
}
