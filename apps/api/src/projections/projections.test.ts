import { describe, expect, it } from 'vitest';

import { mapAiTeam } from './ai-team.js';
import { mapAttention } from './attention.js';
import { mapActivity } from './activity.js';
import { mapIntegrations } from './integrations.js';

const EMPTY_ACTIVITY = { activity: [] as const };

describe('company projection mappers', () => {
  it('maps each authoritative attention source without emitting prose', () => {
    const items = mapAttention({
      approvals: [{ id: 'a1', run_id: 'r1', skill_name: 'skill.sales.offer', decision: 'PENDING', created_at: '', decided_at: null }],
      handoffs: [{ id: 'h1', run_id: 'r2', conversation_id: 'c1', status: 'ASSIGNED', created_at: '' }],
      connectors: [{ connector_id: 'API-001', status: 'UNBOUND' }],
      owner_inputs: [{ input_id: 'owner-1', status: 'UNRESOLVED' }],
      reconciliations: [{ run_id: 'r3', state: 'waiting', effect_key: 'e3', effect_status: null, state_payload: { reconciliation_required: true } }],
      provider: { configured: false },
    });
    expect(items.map((item) => item.type)).toEqual([
      'APPROVAL_PENDING',
      'HUMAN_HANDOFF',
      'PROVIDER_UNAVAILABLE',
      'CONNECTOR_NOT_CONFIGURED',
      'POLICY_CONFIGURATION_REQUIRED',
      'RUN_NEEDS_RECONCILIATION',
    ]);
    expect(items.every((item) => item.title_key.length > 0 && item.href.startsWith('/'))).toBe(true);
    expect(items.every((item) => !('sentence' in item))).toBe(true);
  });

  it('omits counters when their source table has no rows', () => {
    const agents = mapAiTeam({ agents: [], runs_today: [], approvals: [], handoffs: [] });
    expect(agents.every((agent) => !('runs_today' in agent) && !('pending_approvals' in agent) && !('open_handoffs' in agent))).toBe(true);
    expect(mapActivity(EMPTY_ACTIVITY)).toEqual({ items: [], next_cursor: null });
  });

  it('keeps integration output redacted and uses explicit observed statuses', () => {
    const items = mapIntegrations({
      connectors: [{ connector_id: 'SHOPIFY', status: 'DISABLED' }],
      provider: { provider: 'openai-compatible', configured: true },
    });
    expect(items).toEqual([
      { key: 'SHOPIFY', category: 'commerce', status: 'NOT_INTEGRATED', detail_key: 'company.integrations.not_integrated' },
      { key: 'openai-compatible', category: 'ai', status: 'LIVE', detail_key: 'company.integrations.live' },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/secret|token|password|https?:/i);
  });
});
