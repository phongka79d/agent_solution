import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PlatformSkillFleetHealthRepository } from './platform-skill-health.js';
import type { PlatformTransactionRunner } from './platform-directory.js';

describe('PlatformSkillFleetHealthRepository', () => {
  it('maps the fixed fleet projection and preserves no-data latency and success values', async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [
          { skill_id: 'skill.sales.propose', runs_24h: '12', success_rate_24h: '91.7', p95_ms_24h: '480' },
          { skill_id: 'skill.care.lookup', runs_24h: 0, success_rate_24h: null, p95_ms_24h: null },
        ],
      })),
    } as unknown as PoolClient;
    const transaction: PlatformTransactionRunner = async (work) => work(client);
    const repository = new PlatformSkillFleetHealthRepository({ transaction });

    await expect(repository.list()).resolves.toEqual([
      { skill_id: 'skill.sales.propose', runs_24h: 12, success_rate_24h: 91.7, p95_ms_24h: 480 },
      { skill_id: 'skill.care.lookup', runs_24h: 0, success_rate_24h: null, p95_ms_24h: null },
    ]);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT skill_id, runs_24h, success_rate_24h, p95_ms_24h FROM agentos.platform_skill_fleet_health()',
    );
  });
});
