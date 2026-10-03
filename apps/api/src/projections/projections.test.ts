import { describe, expect, it } from 'vitest';
import type { ConnectorBindingRecord } from '@agentos/database';

import { mapAiTeam } from './ai-team.js';
import { groupAttention, mapAttention } from './attention.js';
import { mapActivity } from './activity.js';
import { mapIntegrations } from './integrations.js';
import { mapOverview } from './overview.js';

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

  it('surfaces a parked draft-gated policy as PARKED_DRAFT for its domain', () => {
    const items = mapAttention({
      parked_drafts: [{ skill_id: 'skill.mkt.generate_content', policy_version: 'v1' }],
    });
    expect(items).toEqual([{
      type: 'PARKED_DRAFT',
      severity: 'warning',
      domain: 'marketing',
      title_key: 'company.attention.parked_draft',
      params: { skill_id: 'skill.mkt.generate_content', policy_version: 'v1' },
      href: '/ai-team/marketing/skills',
      source_ref: 'autonomy_policies:skill.mkt.generate_content:v1',
    }]);
    const [group] = groupAttention(items);
    expect(group).toMatchObject({
      type: 'PARKED_DRAFT',
      title_key: 'company.attention_group.parked_draft',
      cta_key: 'company.attention_cta.parked_draft',
    });
  });

  it('surfaces a durable parked campaign without an autonomy policy as one attention item', () => {
    const sources = {
      parked_drafts: [{
        skill_id: 'skill.mkt.generate_content',
        policy_version: '',
        run_id: 'run-parked-campaign',
      }],
      reconciliations: [{
        run_id: 'run-parked-campaign',
        state: 'waiting',
        effect_key: null,
        effect_status: null,
        state_payload: {
          pending_action: { skill_id: 'skill.mkt.generate_content' },
          wait_reason: 'OTHER',
        },
      }],
    };

    const items = mapAttention(sources);

    expect(items).toEqual([{
      type: 'PARKED_DRAFT',
      severity: 'warning',
      domain: 'marketing',
      title_key: 'company.attention.parked_draft',
      params: {
        skill_id: 'skill.mkt.generate_content', policy_version: '', run_id: 'run-parked-campaign',
      },
      href: '/ai-team/marketing/skills',
      source_ref: 'platform_durable_tasks:run-parked-campaign',
    }]);
    expect(mapOverview(sources).attention).toEqual([{
      type: 'PARKED_DRAFT',
      severity: 'warning',
      domain: 'marketing',
      count: 1,
      title_key: 'company.attention_group.parked_draft',
      params: { count: 1 },
      href: '/ai-team/marketing/skills',
      cta_key: 'company.attention_cta.parked_draft',
    }]);
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

  it('projects the DEMO ERP fallback only for pristine bindings, never after a company disconnect', () => {
    const pristine: ConnectorBindingRecord = {
      tenant_id: 'demo', connector_id: 'API-001', status: 'UNBOUND', mode: 'MOCK',
      config: {}, secret_id: null, bound_at: null, probe_outcome: null,
      probe_latency_ms: null, probe_http_status: null, probe_error_class: null,
      probed_at: null, version: 1,
    };
    const erpStatus = (binding: ConnectorBindingRecord | null, eligible = true) =>
      mapIntegrations({ bindings: binding === null ? [] : [binding], demo_erp_eligible: eligible })
        .find((item) => item.key === 'API-001')?.status;

    expect(erpStatus(null)).toBe('DEMO_MOCK');
    expect(erpStatus(pristine)).toBe('DEMO_MOCK');
    expect(erpStatus(pristine, false)).toBe('NOT_CONFIGURED');
    expect(erpStatus({ ...pristine, version: 2 })).toBe('NOT_CONFIGURED');
    expect(erpStatus({ ...pristine, config: { base_url: 'https://erp.example' } })).toBe('NOT_CONFIGURED');
    expect(erpStatus({ ...pristine, status: 'DEGRADED', probe_outcome: 'FAIL' })).toBe('NOT_INTEGRATED');
    expect(erpStatus({ ...pristine, status: 'DISABLED' })).toBe('NOT_INTEGRATED');
    expect(erpStatus({ ...pristine, status: 'BOUND', mode: 'LIVE', probe_outcome: 'PASS' })).toBe('LIVE');
    expect(mapIntegrations({ bindings: [], demo_erp_eligible: true })
      .find((item) => item.key === 'API-002')?.status).toBe('NOT_CONFIGURED');
  });

  it('groups attention by type, strongest first, with counts and one CTA', () => {
    const items = mapAttention({
      handoffs: [
        { id: 'h1', run_id: 'r1', conversation_id: 'c1', status: 'ENQUEUED', created_at: '' },
        { id: 'h2', run_id: 'r2', conversation_id: 'c2', status: 'ASSIGNED', created_at: '' },
        { id: 'h3', run_id: 'r3', conversation_id: 'c3', status: 'ENQUEUED', created_at: '' },
      ],
      approvals: [{ id: 'a1', run_id: 'r9', skill_name: null, decision: 'PENDING', created_at: '', decided_at: null }],
      connectors: [{ connector_id: 'SHOPIFY', status: 'UNBOUND' }],
    });
    const groups = groupAttention(items);
    expect(groups.map((group) => [group.type, group.count])).toEqual([
      ['HUMAN_HANDOFF', 3],
      ['APPROVAL_PENDING', 1],
      ['CONNECTOR_NOT_CONFIGURED', 1],
    ]);
    expect(groups.every((group) => group.href.startsWith('/') && group.cta_key.startsWith('company.attention_cta.'))).toBe(true);
    expect(groupAttention(items, 1)).toHaveLength(1);
  });

  it('emits no today metric when its source has no rows', () => {
    const overview = mapOverview({ activity: [] });
    expect(overview.today).toBeUndefined();
    expect(overview.sections).toEqual({ attention: 'OK', ai_team: 'OK', today: 'OK', activity: 'OK', workspace: 'OK' });
    expect(overview.workspace).toBeUndefined();
  });

  it('emits only metrics whose source observed rows', () => {
    const overview = mapOverview({
      activity: [],
      conversations_today: [{ conversation_id: 'c1', state: 'open', occurred_at: '2026-10-01T01:00:00.000Z' }],
      handoffs: [],
      runs_today: [],
      approvals: [],
      campaigns_today: [],
    });
    expect(overview.today?.metrics.map((metric) => metric.key)).toEqual(['conversations']);
    expect(overview.today?.updated_at).toBe('2026-10-01T01:00:00.000Z');
  });

  it('hides the setup checklist once the workspace is ACTIVE', () => {
    const workspace = {
      status: 'PROVISIONING',
      profile_ready: true,
      erp_ready: false,
      knowledge_ready: false,
      llm_ready: false,
      channels_ready: false,
      test_agents_ready: false,
    };
    const pending = mapOverview({ activity: [], workspace });
    expect(pending.workspace?.checklist).toHaveLength(7);
    const active = mapOverview({ activity: [], workspace: { ...workspace, status: 'ACTIVE' } });
    expect(active.workspace).toBeUndefined();
  });
});
