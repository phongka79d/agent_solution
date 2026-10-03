import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiTeamDomain, CompanyActivityItem } from '../../lib/types/tenant-console';

const mocks = vi.hoisted(() => ({
  getAiTeamDomain: vi.fn(),
  getCompanyActivity: vi.fn(),
  getSkills: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));
vi.mock('@agentos/ui-foundation/i18n', async () => import('../../../../../packages/ui-foundation/src/i18n/index.js'));

import { AiTeamDomainOverview, AiTeamTechnicalPanel, AiTeamTry } from './AiTeamDomain';

const careSkill = {
  skill_id: 'skill-care-faq',
  display_key: 'skills.care.faq',
  domain: 'care',
  required_authority: 'AUTH-2',
};
const salesSkill = {
  skill_id: 'skill-sales-recommend',
  display_key: 'skills.sales.recommend',
  domain: 'sales',
  required_authority: 'AUTH-1',
};

const activityCases: readonly {
  readonly domain: AiTeamDomain;
  readonly kind: string;
  readonly sentenceKey: string;
  readonly title: string;
}[] = [
  { domain: 'sales', kind: 'RUN_COMPLETED', sentenceKey: 'company.activity.run_completed', title: 'Sales vừa hoàn tất một lượt xử lý.' },
  { domain: 'marketing', kind: 'RUN_COMPLETED', sentenceKey: 'company.activity.run_completed', title: 'Marketing vừa hoàn tất một lượt xử lý.' },
  { domain: 'care', kind: 'RUN_COMPLETED', sentenceKey: 'company.activity.run_completed', title: 'Care vừa hoàn tất một lượt xử lý.' },
  { domain: 'sales', kind: 'RUN_FAILED', sentenceKey: 'company.activity.run_failed', title: 'Sales chưa hoàn tất một lượt xử lý.' },
  { domain: 'sales', kind: 'RUN_NEEDS_RECONCILIATION', sentenceKey: 'company.activity.run_needs_reconciliation', title: 'Sales có một lượt xử lý cần đối soát.' },
  { domain: 'sales', kind: 'RUN_WAITING_FOR_APPROVAL', sentenceKey: 'company.activity.run_waiting_for_approval', title: 'Sales có một lượt xử lý đang chờ phê duyệt.' },
  { domain: 'sales', kind: 'RUN_STOPPED', sentenceKey: 'company.activity.run_stopped', title: 'Sales đã dừng một lượt xử lý.' },
  { domain: 'sales', kind: 'RUN_OUTCOME', sentenceKey: 'company.activity.run_outcome', title: 'Sales vừa có kết quả cho một lượt xử lý.' },
  { domain: 'sales', kind: 'UNKNOWN_ACTIVITY', sentenceKey: 'company.activity.run_outcome', title: 'Sales vừa có hoạt động mới.' },
];

describe('AI Team domain pages', () => {
  beforeEach(() => {
    mocks.getAiTeamDomain.mockResolvedValue({
      activation_status: 'ACTIVE',
      agent: { status: 'ACTIVE', enabled: true, readiness: 'READY', runs_today: 1 },
      unmet: [],
    });
    mocks.getCompanyActivity.mockResolvedValue({ items: [], next_cursor: null });
    mocks.getSkills.mockResolvedValue({ skills: [careSkill, salesSkill] });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it.each(activityCases)('renders business copy for $domain $kind while preserving the run link', async ({ domain, kind, sentenceKey, title }) => {
    const runId = 'd6b799ea-91b4-4333-8444-555555555555';
    const otherRunId = '11111111-2222-4333-8444-555555555555';
    const item: CompanyActivityItem = {
      kind,
      sentence_key: sentenceKey,
      params: { run_id: runId },
      run_id: runId,
      domain,
      occurred_at: '2026-10-01T02:30:00.000Z',
    };
    mocks.getCompanyActivity.mockResolvedValue({
      items: [item, { ...item, domain: domain === 'sales' ? 'care' : 'sales', run_id: otherRunId }],
      next_cursor: null,
    });

    const { container } = render(<AiTeamDomainOverview domain={domain} />);

    const link = await screen.findByRole('link', { name: title });
    expect(link.getAttribute('href')).toBe(`/runs/${runId}`);
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(container.querySelector(`a[href="/runs/${otherRunId}"]`)).toBeNull();
  });

  it('renders the server-backed Care chat with a suggested FAQ question', async () => {
    render(<AiTeamTry domain="care" />);

    expect(screen.getByRole('heading', { name: 'Hội thoại' })).toBeTruthy();
    expect(await screen.findByDisplayValue('Tôi có thể đổi trả sản phẩm trong bao lâu?')).toBeTruthy();
  });

  it('links Marketing to the real campaign wizard and explains that it does not send', () => {
    render(<AiTeamTry domain="marketing" />);

    expect(screen.getByText('Mở trình tạo chiến dịch để xem mục tiêu, đối tượng và bước xem lại; nội dung chưa được gửi.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mở trình tạo chiến dịch' }).getAttribute('href')).toBe('/campaigns/new');
  });

  it('shows authority levels for this domain only from the skills API', async () => {
    render(<AiTeamTechnicalPanel domain="care" />);

    expect(await screen.findByText('AUTH-2')).toBeTruthy();
    expect(screen.getByText('skill-care-faq')).toBeTruthy();
    expect(screen.queryByText('skill-sales-recommend')).toBeNull();
    expect(mocks.getSkills).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the domain overview is loading', () => {
    const pending = new Promise<never>(() => {
      // Keep requests unresolved so the loading skeleton remains visible.
    });
    mocks.getAiTeamDomain.mockReturnValue(pending);
    mocks.getCompanyActivity.mockReturnValue(pending);
    const { container } = render(<AiTeamDomainOverview domain="care" />);

    expect(container.querySelector('.ui-skeleton')).not.toBeNull();
  });

  it('renders one domain heading without an AI Team eyebrow', async () => {
    render(<AiTeamDomainOverview domain="care" />);

    expect(await screen.findAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText('AI Team')).toBeNull();
  });
});
