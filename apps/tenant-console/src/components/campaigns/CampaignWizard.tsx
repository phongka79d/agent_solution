'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '@agentos/ui-foundation/data';
import { Button, ErrorBanner, Field, Input, PageHeader, Select } from '@agentos/ui-foundation/react';

import {
  CHANNEL_OPTIONS,
  audienceText,
  isCampaignSegment,
  objectiveLabel,
  segmentLabel,
  type CampaignSegment,
} from './campaign-model';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

const STEPS = ['Mục tiêu', 'Đối tượng', 'Kênh, giọng điệu, hướng dẫn', 'Xem lại'] as const;

const OBJECTIVE_OPTIONS = [
  { value: 'winback', label: 'Khuyến khích khách hàng quay lại' },
  { value: 'reactivation', label: 'Tái kích hoạt khách hàng' },
];

function selectSegments(body: unknown): readonly CampaignSegment[] {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('segments' in body)) return [];
  const segments = body.segments;
  return Array.isArray(segments) ? segments.filter(isCampaignSegment) : [];
}

export function CampaignWizard() {
  const router = useRouter();
  const { data: segments, error: segmentsError, loading: segmentsLoading } = useApi<readonly CampaignSegment[]>(
    '/api/v1/campaigns/segments',
    { select: selectSegments },
  );
  const available = segments ?? [];

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('winback');
  const [brief, setBrief] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [channel, setChannel] = useState('EMAIL_HTML');
  const [tone, setTone] = useState('');
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (segmentId === '' && available.length > 0) setSegmentId(available[0]!.segment_id);
  }, [available, segmentId]);

  const selectedSegment = available.find((segment) => segment.segment_id === segmentId) ?? null;
  const instruction = [brief.trim(), guidance.trim()].filter((part) => part.length > 0).join('\n\n');

  const canContinue =
    step === 0 ? name.trim().length > 0 && objective.trim().length > 0
      : step === 1 ? segmentId.trim().length > 0
        : true;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSubmitError(null);
    const key = `campaign-draft-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const contentConstraints: Record<string, unknown> = { channel, locale: 'vi-VN' };
    if (tone.trim().length > 0) contentConstraints['tone'] = tone.trim();
    try {
      const payload = await tenantConsoleClient.request<{ readonly task_id?: unknown }>(
        '/campaigns/drafts',
        {
          method: 'POST',
          body: JSON.stringify({
            idempotency_key: key,
            name: name.trim(),
            segment_id: segmentId.trim(),
            objective: objective.trim(),
            ...(instruction.length === 0 ? {} : { instruction }),
            content_constraints: contentConstraints,
          }),
        },
      );
      const runId = typeof payload.task_id === 'string' ? payload.task_id : undefined;
      if (runId) router.push(`/campaigns/${encodeURIComponent(runId)}`);
      else setSubmitError('Bản nháp đã được tiếp nhận nhưng chưa có mã thực thi.');
    } catch (reason: unknown) {
      setSubmitError(reason instanceof Error ? reason.message : 'Không thể tạo bản nháp.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Tạo bản nháp chiến dịch"
        description="Bản nháp chỉ được tiếp nhận; không gửi nội dung khi chưa có phê duyệt."
      />
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Các bước">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? 'step' : undefined}
            className={index === step ? 'font-semibold text-primary' : 'text-muted'}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="space-y-5 rounded-xl border border-line bg-surface p-5">
        {step === 0 ? (
          <>
            <Field label="Tên chiến dịch">
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
            </Field>
            <Field label="Mục tiêu">
              <Select value={objective} onChange={(event) => setObjective(event.target.value)} required options={OBJECTIVE_OPTIONS} />
            </Field>
            <Field label="Mô tả ngắn" hint="Không bắt buộc. Giúp AI hiểu đúng ý định của chiến dịch.">
              <textarea value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={2000} rows={3} className="ui-input w-full" />
            </Field>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Field label="Phân khúc">
              <Select
                value={segmentId}
                onChange={(event) => setSegmentId(event.target.value)}
                required
                disabled={segmentsLoading || available.length === 0}
                options={[
                  { value: '', label: segmentsLoading ? 'Đang tải phân khúc…' : 'Chọn phân khúc', disabled: true },
                  ...available.map((segment) => ({
                    value: segment.segment_id,
                    label: `${segmentLabel(segment)} · ${segment.audience_count.toLocaleString('vi-VN')} khách`,
                  })),
                ]}
              />
            </Field>
            <p className="text-sm text-muted">Chỉ gửi khách đã đồng ý nhận marketing.</p>
            {selectedSegment ? (
              <p className="text-sm text-ink">
                Đối tượng: {audienceText(selectedSegment.audience_count)} trong phân khúc “{segmentLabel(selectedSegment)}”.
              </p>
            ) : null}
            {segmentsError ? <ErrorBanner error={segmentsError} /> : null}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Field label="Kênh">
              <Select
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                options={CHANNEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              />
            </Field>
            <Field label="Giọng điệu" hint="Không bắt buộc, ví dụ: thân thiện, trang trọng.">
              <Input value={tone} onChange={(event) => setTone(event.target.value)} maxLength={256} />
            </Field>
            <Field label="Hướng dẫn">
              <textarea value={guidance} onChange={(event) => setGuidance(event.target.value)} maxLength={2000} rows={5} className="ui-input w-full" placeholder="Mô tả nội dung cần soạn…" />
            </Field>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">Tên chiến dịch</dt>
                <dd className="mt-1 text-ink">{name || '—'}</dd>
              </div>
              <div>
                <dt className="text-muted">Mục tiêu</dt>
                <dd className="mt-1 text-ink">{objectiveLabel(objective)}</dd>
              </div>
              <div>
                <dt className="text-muted">Đối tượng</dt>
                <dd className="mt-1 text-ink">
                  {selectedSegment ? `${segmentLabel(selectedSegment)} · ${audienceText(selectedSegment.audience_count)}` : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Kênh</dt>
                <dd className="mt-1 text-ink">{CHANNEL_OPTIONS.find((option) => option.value === channel)?.label ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-muted">Giọng điệu</dt>
                <dd className="mt-1 text-ink">{tone || '—'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted">Hướng dẫn</dt>
                <dd className="mt-1 whitespace-pre-wrap text-ink">{instruction || '—'}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted">Chỉ gửi khách đã đồng ý nhận marketing.</p>
          </>
        ) : null}

        {submitError ? <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{submitError}</p> : null}

        <div className="flex justify-between gap-3">
          <Button variant="secondary" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || busy}>
            Quay lại
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              onClick={(event) => {
                event.preventDefault();
                setStep((current) => current + 1);
              }}
              disabled={!canContinue}
            >
              Tiếp tục
            </Button>
          ) : (
            <Button type="submit" disabled={busy || !canContinue || available.length === 0} loading={busy}>
              {busy ? 'Đang tạo…' : 'Tạo bản nháp'}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
