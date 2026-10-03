import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSkills: vi.fn(),
  getSkillHealth: vi.fn(),
  updateSkillSettings: vi.fn(),
  setSkillAgents: vi.fn(),
  testSkill: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { AiTeamSkillsPanel } from './AiTeamSkillsPanel';

const skill = {
  skill_id: 'skill-sales-recommend',
  display_key: 'skill.sales.recommend',
  domain: 'sales',
  effect_class: 'READ' as const,
  required_authority: 'agent',
  autonomy_class: 'NEVER' as const,
  completion: 'SYNC' as const,
  connector_kinds: [],
  config_schema: {},
  allowed_agents: ['agent-a'],
  enabled: true,
  config: {},
  connector_id: null,
  version: 'v1',
  assigned_agents: ['agent-a'],
  availability: { available: true, status: 'READY', reason: 'OK' as const },
};

describe('AiTeamSkillsPanel', () => {
  beforeEach(() => {
    mocks.getSkills.mockResolvedValue({ skills: [skill] });
    mocks.getSkillHealth.mockResolvedValue({
      health: { window_start: '2026-10-01T00:00:00.000Z', success_count: 3, failure_count: 0, refusal_count: 0, awaiting_human_count: 0, success_rate: 1, avg_latency_ms: 120, p95_latency_ms: 200, last_activity_at: null, last_error_class: null },
      recent_tests: [],
      data_class: 'DEMO',
    });
    mocks.updateSkillSettings.mockResolvedValue({ ...skill, enabled: false });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('sends a PATCH with the narrowed enabled flag when the toggle changes', async () => {
    render(<AiTeamSkillsPanel domain="sales" />);
    const toggle = await screen.findByRole('switch') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    toggle.click();

    await waitFor(() => expect(mocks.updateSkillSettings).toHaveBeenCalledTimes(1));
    expect(mocks.updateSkillSettings).toHaveBeenCalledWith('skill-sales-recommend', {
      enabled: false,
      config: {},
      connector_id: null,
      version: 'v1',
    });
    await waitFor(() => expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false));
  });
});
