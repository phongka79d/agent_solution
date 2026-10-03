import type { PoolClient, QueryResultRow } from 'pg';

import { withPlatformRole } from './platform-directory.js';
import type { PlatformTransactionRunner } from './platform-directory.js';

export interface PlatformSkillFleetHealthRecord {
  readonly skill_id: string;
  readonly runs_24h: number;
  readonly success_rate_24h: number | null;
  readonly p95_ms_24h: number | null;
}

interface FleetHealthRow extends QueryResultRow {
  skill_id: string;
  runs_24h: string | number;
  success_rate_24h: string | number | null;
  p95_ms_24h: string | number | null;
}

export interface PlatformSkillFleetHealthRepositoryOptions {
  readonly transaction?: PlatformTransactionRunner;
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads only the SECURITY DEFINER fleet aggregate while running under the platform role. */
export class PlatformSkillFleetHealthRepository {
  private readonly transaction: PlatformTransactionRunner;

  constructor(options: PlatformSkillFleetHealthRepositoryOptions = {}) {
    this.transaction = options.transaction ?? withPlatformRole;
  }

  async list(): Promise<readonly PlatformSkillFleetHealthRecord[]> {
    return this.transaction(async (client: PoolClient) => {
      const result = await client.query<FleetHealthRow>(
        'SELECT skill_id, runs_24h, success_rate_24h, p95_ms_24h FROM agentos.platform_skill_fleet_health()',
      );
      return result.rows.map((row) => ({
        skill_id: row.skill_id,
        runs_24h: Number(row.runs_24h),
        success_rate_24h: numberOrNull(row.success_rate_24h),
        p95_ms_24h: numberOrNull(row.p95_ms_24h),
      }));
    });
  }
}
