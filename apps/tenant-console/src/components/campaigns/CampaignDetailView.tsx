'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AdvancedDetails, EmptyState, ErrorBanner, PageHeader, SectionHeader, Skeleton, StageTimeline, StatusBadge } from '@agentos/ui-foundation/react';
import { useApi } from '@agentos/ui-foundation/data';

import {
  audienceText,
  buildCampaignStages,
  campaignStatusView,
  channelLabel,
  contentPreview,
  failureReasonText,
  firstChannel,
  objectiveLabel,
  type CampaignSummary,
} from './campaign-model';
import type { RunStoryStep } from './campaign-model';

const TERMINAL_CAMPAIGN_STATUSES: Readonly<Record<string, true>> = {
  approved: true,
  rejected: true,
  failed: true,
  cancelled: true,
};

function selectCampaign(body: unknown): CampaignSummary | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  // Boundary cast: the BFF returns our own projection; only object-ness is asserted here.
  return body as CampaignSummary;
}

function selectStorySteps(body: unknown): readonly RunStoryStep[] {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('steps' in body)) return [];
  const steps = body.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step): RunStoryStep[] => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    if (!('name' in step) || !('status' in step) || typeof step.name !== 'string' || typeof step.status !== 'string') return [];
    const duration = 'duration_ms' in step && typeof step.duration_ms === 'number' ? step.duration_ms : 0;
    return [{ name: step.name, status: step.status, duration_ms: duration }];
  });
}

export function CampaignDetailView({ runId }: { readonly runId: string }) {
  const campaign = useApi<CampaignSummary | null>(`/api/v1/campaigns/${encodeURIComponent(runId)}`, {
    select: selectCampaign,
  });
  const story = useApi<readonly RunStoryStep[]>(`/api/v1/runs/${encodeURIComponent(runId)}/story`, {
    select: selectStorySteps,
  });
  const shouldPoll = campaign.data !== null
    && !Object.hasOwn(TERMINAL_CAMPAIGN_STATUSES, campaign.data.status ?? '');
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const interval = window.setInterval(() => {
      campaign.refresh();
      story.refresh();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [campaign.refresh, shouldPoll, story.refresh]);


  if (campaign.loading) return <Skeleton variant="card" />;
  if (campaign.error) return <ErrorBanner error={campaign.error} onRetry={campaign.refresh} />;
  const data = campaign.data;
  if (!data) {
    return <EmptyState status="NOT_FOUND" title="Không tìm thấy chiến dịch" description="Chiến dịch này không tồn tại hoặc bạn không có quyền xem." />;
  }

  const status = data.status;
  const state = campaignStatusView(status);
  const failureText = status === 'failed' || status === 'rejected' ? failureReasonText(data.failure_reason_key) : null;
  const stages = buildCampaignStages(status, story.data ?? [], failureText);
  const preview = contentPreview(data.draft_receipt) ?? contentPreview(data.brand_audit);
  const approvalId = data.approval?.approval_id;

  return (
    <div className="space-y-6">
      <PageHeader
        title={data.name ?? 'Chiến dịch'}
        description="Vòng đời chiến dịch từ bản nháp tới phê duyệt."
        actions={<Link href="/campaigns" className="ui-button ui-button--secondary">Quay lại</Link>}
      />
      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted">Mục tiêu</p>
            <p className="mt-1 font-medium text-ink">{objectiveLabel(data.objective)}</p>
          </div>
          <StatusBadge tone={state.tone} label={state.label} />
        </div>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Kênh</dt>
            <dd className="mt-1 text-ink">{channelLabel(firstChannel(data.channels))}</dd>
          </div>
          <div>
            <dt className="text-muted">Đối tượng</dt>
            <dd className="mt-1 text-ink">{audienceText(data.audience_count)}</dd>
          </div>
        </dl>
      </section>

      {failureText ? (
        <section role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-5">
          <h2 className="text-sm font-semibold text-danger">Không hoàn tất</h2>
          <p className="mt-1 text-sm text-danger">{failureText}</p>
        </section>
      ) : null}

      <section className="rounded-xl border border-line bg-surface p-5">
        <SectionHeader title="Tiến trình" />
        <StageTimeline stages={stages} />
      </section>

      {preview ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <SectionHeader title="Nội dung xem trước" />
          <p className="mt-3 whitespace-pre-wrap text-sm text-ink">{preview}</p>
        </section>
      ) : null}

      {approvalId ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <SectionHeader title="Phê duyệt" />
          <p className="mt-2 text-sm text-muted">Đề xuất gửi chiến dịch đang chờ người phê duyệt xử lý.</p>
          <Link href="/approvals" className="ui-button ui-button--secondary mt-3">Xem đề xuất phê duyệt</Link>
        </section>
      ) : null}

      {status === 'approved' ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <p className="text-sm text-ink">Gửi đi: Chưa tích hợp kênh gửi</p>
          <Link href="/integrations" className="mt-2 inline-block text-sm text-primary hover:underline">Kết nối kênh</Link>
        </section>
      ) : null}

      <AdvancedDetails summary="Chi tiết kỹ thuật">
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <div><dt className="text-muted">run_id</dt><dd className="break-all font-mono text-ink">{data.run_id ?? runId}</dd></div>
          <div><dt className="text-muted">campaign_id</dt><dd className="break-all font-mono text-ink">{data.campaign_id ?? '—'}</dd></div>
          <div><dt className="text-muted">approval_id</dt><dd className="break-all font-mono text-ink">{approvalId ?? '—'}</dd></div>
          <div><dt className="text-muted">dispatch</dt><dd className="font-mono text-ink">{data.dispatch?.status ?? '—'}</dd></div>
        </dl>
      </AdvancedDetails>
    </div>
  );
}
