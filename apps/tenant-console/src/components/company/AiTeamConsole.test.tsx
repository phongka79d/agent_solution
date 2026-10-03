import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCompanyAiTeam: vi.fn(),
  getCompanyActivity: vi.fn(),
  getAiTeamDomain: vi.fn(),
  changeAiTeamDomain: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { AiTeamConsole, unmetFromError } from './AiTeamConsole';

const agent = (domain: string) => ({ domain, status: 'DISABLED', enabled: false, readiness: 'NOT_READY' });

describe('AiTeamConsole', () => {
  beforeEach(() => {
    mocks.getCompanyAiTeam.mockResolvedValue({ agents: [agent('marketing'), agent('sales'), agent('care')] });
    mocks.getCompanyActivity.mockResolvedValue({ items: [], next_cursor: null });
    mocks.getAiTeamDomain.mockResolvedValue({ agent: agent('sales'), activation_status: 'NOT_ACTIVATED', unmet: [] });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('shows a card skeleton while the AI Team data is loading', () => {
    const pending = new Promise<never>(() => {
      // Keep requests unresolved so the loading skeleton remains visible.
    });
    mocks.getCompanyAiTeam.mockReturnValue(pending);
    mocks.getCompanyActivity.mockReturnValue(pending);
    mocks.getAiTeamDomain.mockReturnValue(pending);

    const { container } = render(<AiTeamConsole />);

    expect(container.querySelector('.ui-skeleton')).not.toBeNull();
  });

  it('renders one page heading without an eyebrow repeating it', async () => {
    render(<AiTeamConsole />);

    expect(await screen.findByRole('heading', { level: 1, name: 'AI Team' })).toBeTruthy();
    expect(screen.getAllByText('AI Team')).toHaveLength(1);
  });

  it('shows the unmet prerequisite reasons when activation returns 409', async () => {
    mocks.changeAiTeamDomain.mockRejectedValue({
      status: 409,
      details: {
        unmet: [{ reason_key: 'ERP_NOT_CONNECTED', cta: { href: '/integrations', label_key: 'company.ai_team.connect_erp' } }],
      },
    });

    render(<AiTeamConsole />);
    await waitFor(() => expect(mocks.getAiTeamDomain).toHaveBeenCalledTimes(3));

    screen.getAllByRole('button', { name: 'Kích hoạt' })[0]!.click();

    await waitFor(() => expect(screen.getByText('Chưa cấu hình: thiếu kết nối ERP')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Kết nối ERP' }).getAttribute('href')).toBe('/integrations');
  });

  it('reads the unmet reasons from a 409 details payload and ignores malformed entries', () => {
    expect(unmetFromError({ details: { unmet: [{ reason_key: 'LLM_NOT_VERIFIED', cta: { href: '/settings/llm', label_key: 'company.ai_team.verify_llm' } }] } }))
      .toHaveLength(1);
    expect(unmetFromError({ details: { unmet: [{ reason_key: 1 }] } })).toHaveLength(0);
    expect(unmetFromError(new Error('boom'))).toHaveLength(0);
  });
});
