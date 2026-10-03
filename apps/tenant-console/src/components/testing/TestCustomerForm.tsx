'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { DataClassBadge, PageHeader } from '@agentos/ui-foundation/react';
import {
  createTestCustomer,
  TestLabError,
} from '../../lib/testing/test-lab-client';
import type {
  TestCustomerDetail,
} from '../../lib/testing/test-lab-client';

const CHANNELS = ['email', 'sms', 'whatsapp', 'transactional'] as const;
type Channel = (typeof CHANNELS)[number];

interface FormState {
  display_name: string;
  email: string;
  phone: string;
  locale: string;
  timezone: string;
  segment: string;
  lifecycle: string;
  tags: string;
  source: string;
  consent: Record<Channel, boolean>;
  salesEnabled: boolean;
  salesCategory: string;
  salesBudget: string;
  salesCurrency: string;
  salesUseCase: string;
  orderEnabled: boolean;
  orderReference: string;
  orderStatus: string;
  orderCurrency: string;
  orderTotal: string;
  orderItems: string;
  careEnabled: boolean;
  careSubject: string;
  careEscalation: boolean;
  careFaq: string;
  marketingEnabled: boolean;
  marketingLastActive: string;
  marketingInactiveDays: string;
  marketingOrderCount: string;
  marketingCampaign: string;
  marketingSuppressed: boolean;
}

const initial: FormState = {
  display_name: '', email: '', phone: '', locale: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh',
  segment: '', lifecycle: '', tags: '', source: '',
  consent: { email: true, sms: false, whatsapp: false, transactional: true },
  salesEnabled: false, salesCategory: '', salesBudget: '', salesCurrency: 'VND', salesUseCase: '',
  orderEnabled: false, orderReference: '', orderStatus: 'paid', orderCurrency: 'VND', orderTotal: '', orderItems: '',
  careEnabled: false, careSubject: '', careEscalation: false, careFaq: '',
  marketingEnabled: false, marketingLastActive: '', marketingInactiveDays: '90', marketingOrderCount: '1', marketingCampaign: '', marketingSuppressed: false,
};

const CONSENT_TYPE: Record<Channel, string> = {
  email: 'marketing_messaging',
  sms: 'marketing_sms',
  whatsapp: 'marketing_whatsapp',
  transactional: 'transactional',
};

/** Builds the server payload (`workflow.md` §5.3). Server owns tenant + data class. */
export function buildCreatePayload(state: FormState): Record<string, unknown> {
  const identities: Record<string, unknown>[] = [];
  if (state.email.trim() !== '') identities.push({ channel_type: 'email', channel_identifier: state.email.trim(), is_primary: true });
  if (state.phone.trim() !== '') identities.push({ channel_type: 'phone', channel_identifier: state.phone.trim(), is_primary: identities.length === 0 });
  const consents = CHANNELS.map((channel) => ({
    consent_type: CONSENT_TYPE[channel],
    channel,
    is_granted: channel === 'email' && state.marketingEnabled && state.marketingSuppressed ? false : state.consent[channel],
  }));
  const events: Record<string, unknown>[] = [];
  const profile: Record<string, unknown> = {};
  if (state.segment.trim() !== '') profile.segment = state.segment.trim();
  if (state.lifecycle.trim() !== '') profile.lifecycle_stage = state.lifecycle.trim();
  if (state.tags.trim() !== '') profile.tags = state.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
  if (state.source.trim() !== '') profile.acquisition_source = state.source.trim();
  if (Object.keys(profile).length > 0) {
    events.push({ event_name: 'profile_seeded', channel: 'web', payload: profile });
  }
  if (state.salesEnabled) {
    const payload: Record<string, unknown> = {};
    if (state.salesCategory.trim() !== '') payload.category = state.salesCategory.trim();
    if (state.salesBudget.trim() !== '') payload.budget = Number(state.salesBudget);
    if (state.salesCurrency.trim() !== '') payload.currency = state.salesCurrency.trim();
    if (state.salesUseCase.trim() !== '') payload.use_case = state.salesUseCase.trim();
    events.push({ event_name: 'product_view', channel: 'web', payload });
  }
  if (state.marketingEnabled) {
    const payload: Record<string, unknown> = { suppressed: state.marketingSuppressed };
    if (state.marketingLastActive.trim() !== '') payload.last_active_date = state.marketingLastActive.trim();
    if (state.marketingInactiveDays.trim() !== '') payload.inactive_days = Number(state.marketingInactiveDays);
    if (state.marketingCampaign.trim() !== '') payload.campaign_eligibility = state.marketingCampaign.trim();
    events.push({ event_name: 'marketing_signal', channel: 'web', payload });
  }
  return {
    display_name: state.display_name.trim(),
    ...(state.email.trim() === '' ? {} : { primary_email: state.email.trim() }),
    ...(state.phone.trim() === '' ? {} : { primary_phone: state.phone.trim() }),
    identities,
    consents,
    events,
    ...(state.marketingEnabled ? {
      marketing_cohort: {
        last_paid_purchase_days_ago: Number(state.marketingInactiveDays),
        order_count: Number(state.marketingOrderCount),
      },
    } : {}),
    ...(state.orderEnabled
      ? {
          order: {
            ...(state.orderReference.trim() === '' ? {} : { order_number: state.orderReference.trim() }),
            status: state.orderStatus.trim() || 'paid',
            currency: state.orderCurrency.trim() || 'VND',
            total_amount: Number(state.orderTotal || '0'),
            items: state.orderItems.trim() === ''
              ? []
              : state.orderItems.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => ({ description: line })),
          },
        }
      : {}),
    ...(state.careEnabled
      ? {
          support_request: {
            subject: state.careSubject.trim() || 'Yêu cầu hỗ trợ thử nghiệm',
            ...(state.careFaq.trim() === '' ? {} : { category: state.careFaq.trim() }),
            priority: state.careEscalation ? 'P1' : 'P3',
          },
          ...(state.careEscalation
            ? { handoff_request: { escalation_reason: state.careSubject.trim() || 'Cần nhân viên hỗ trợ', channel: 'web' } }
            : {}),
        }
      : {}),
  };
}

export function validateCreateForm(state: FormState): string | null {
  if (state.display_name.trim() === '') return 'Vui lòng nhập họ tên.';
  if (state.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim())) return 'Email chưa hợp lệ.';
  if (state.orderEnabled && (state.orderTotal.trim() === '' || Number.isNaN(Number(state.orderTotal)) || Number(state.orderTotal) < 0)) {
    return 'Tổng tiền đơn hàng chưa hợp lệ.';
  }
  if (state.marketingEnabled) {
    const days = Number(state.marketingInactiveDays);
    const count = Number(state.marketingOrderCount);
    if (state.marketingInactiveDays.trim() === '' || !Number.isInteger(days) || days < 0 || days > 36500) {
      return 'Số ngày từ lần mua đã thanh toán chưa hợp lệ.';
    }
    if (state.marketingOrderCount.trim() === '' || !Number.isInteger(count) || count < 1 || count > 1000000) {
      return 'Số đơn đã mua chưa hợp lệ.';
    }
  }
  return null;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <details open className="rounded-lg border border-line bg-surface p-4">
      <summary className="cursor-pointer font-medium text-ink">{title}</summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{children}</div>
    </details>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label className="text-sm text-muted">{label}<span className="mt-1 block">{children}</span></label>;
}

export function TestCustomerForm() {
  const [state, setState] = useState<FormState>(initial);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<TestCustomerDetail | null>(null);

  const update = (patch: Partial<FormState>) => setState((current) => ({ ...current, ...patch }));

  function onPreview(): void {
    const message = validateCreateForm(state);
    if (message) { setError(message); setPreview(null); return; }
    setError(null);
    setPreview(buildCreatePayload(state));
  }

  async function onCreate(): Promise<void> {
    const message = validateCreateForm(state);
    if (message) { setError(message); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await createTestCustomer(buildCreatePayload(state));
      setCreated(result.customer);
      setPreview(null);
    } catch (reason: unknown) {
      setError(reason instanceof TestLabError ? `Không tạo được khách hàng thử (${reason.errorCode}).` : 'Không tạo được khách hàng thử.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="space-y-4">
        <div className="ui-section-card p-5">
          <h2 className="text-lg font-semibold text-ink">Đã tạo khách hàng thử</h2>
          <p className="mt-1 text-sm text-muted">Tên: <span className="font-medium text-ink">{created.display_name}</span></p>
          <p className="flex items-center gap-2 text-sm text-muted">Môi trường: <DataClassBadge code={created.data_class} /></p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a className="ui-button ui-button--secondary" href={`/customers/${encodeURIComponent(created.id)}`}>Mở Customer360</a>
            <a className="ui-button ui-button--secondary" href={`/testing/customers/${encodeURIComponent(created.id)}/storefront`}>Khởi chạy Storefront với khách này</a>
            <button type="button" className="ui-button ui-button--primary" onClick={() => { setCreated(null); setState(initial); }}>Tạo thêm</button>
          </div>
          <details className="mt-4 text-xs text-muted">
            <summary className="cursor-pointer">Chi tiết nâng cao</summary>
            <p className="mt-1 font-mono">{created.id}</p>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Tạo khách hàng thử" description="Tạo khách hàng TEST để demo, QA và kiểm thử Sales / Care / Marketing." />
      <Section title="Định danh">
        <Field label="Họ tên"><input className="ui-input w-full" value={state.display_name} onChange={(event) => update({ display_name: event.target.value })} /></Field>
        <Field label="Email"><input className="ui-input w-full" value={state.email} onChange={(event) => update({ email: event.target.value })} /></Field>
        <Field label="Điện thoại"><input className="ui-input w-full" value={state.phone} onChange={(event) => update({ phone: event.target.value })} /></Field>
        <Field label="Ngôn ngữ"><input className="ui-input w-full" value={state.locale} onChange={(event) => update({ locale: event.target.value })} /></Field>
        <Field label="Múi giờ"><input className="ui-input w-full" value={state.timezone} onChange={(event) => update({ timezone: event.target.value })} /></Field>
      </Section>
      <Section title="Hồ sơ">
        <Field label="Phân khúc"><input className="ui-input w-full" value={state.segment} onChange={(event) => update({ segment: event.target.value })} /></Field>
        <Field label="Vòng đời"><input className="ui-input w-full" value={state.lifecycle} onChange={(event) => update({ lifecycle: event.target.value })} /></Field>
        <Field label="Thẻ (phân tách bằng dấu phẩy)"><input className="ui-input w-full" value={state.tags} onChange={(event) => update({ tags: event.target.value })} /></Field>
        <Field label="Nguồn tiếp cận"><input className="ui-input w-full" value={state.source} onChange={(event) => update({ source: event.target.value })} /></Field>
      </Section>
      <Section title="Đồng ý">
        {CHANNELS.map((channel) => (
          <label key={channel} className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={state.consent[channel]} onChange={(event) => update({ consent: { ...state.consent, [channel]: event.target.checked } })} />
            {channel === 'email' ? 'Email marketing' : channel === 'sms' ? 'SMS marketing' : channel === 'whatsapp' ? 'WhatsApp' : 'Tin nhắn giao dịch'}
          </label>
        ))}
      </Section>
      <details className="rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer font-medium text-ink">Hạt giống Sales (tùy chọn)</summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={state.salesEnabled} onChange={(event) => update({ salesEnabled: event.target.checked })} /> Bật hạt giống Sales</label>
          <Field label="Danh mục quan tâm"><input className="ui-input w-full" value={state.salesCategory} onChange={(event) => update({ salesCategory: event.target.value })} /></Field>
          <Field label="Ngân sách"><input className="ui-input w-full" value={state.salesBudget} onChange={(event) => update({ salesBudget: event.target.value })} /></Field>
          <Field label="Tiền tệ"><input className="ui-input w-full" value={state.salesCurrency} onChange={(event) => update({ salesCurrency: event.target.value })} /></Field>
          <Field label="Nhu cầu"><input className="ui-input w-full" value={state.salesUseCase} onChange={(event) => update({ salesUseCase: event.target.value })} /></Field>
        </div>
      </details>
      <details className="rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer font-medium text-ink">Hạt giống Đơn hàng (tùy chọn)</summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={state.orderEnabled} onChange={(event) => update({ orderEnabled: event.target.checked })} /> Tạo đơn hàng mẫu</label>
          <Field label="Mã đơn"><input className="ui-input w-full" value={state.orderReference} onChange={(event) => update({ orderReference: event.target.value })} /></Field>
          <Field label="Trạng thái"><input className="ui-input w-full" value={state.orderStatus} onChange={(event) => update({ orderStatus: event.target.value })} /></Field>
          <Field label="Tiền tệ"><input className="ui-input w-full" value={state.orderCurrency} onChange={(event) => update({ orderCurrency: event.target.value })} /></Field>
          <Field label="Tổng tiền"><input className="ui-input w-full" value={state.orderTotal} onChange={(event) => update({ orderTotal: event.target.value })} /></Field>
          <Field label="Mặt hàng (mỗi dòng một mặt hàng)"><textarea className="ui-input w-full" rows={3} value={state.orderItems} onChange={(event) => update({ orderItems: event.target.value })} /></Field>
        </div>
      </details>
      <details className="rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer font-medium text-ink">Hạt giống Hỗ trợ (tùy chọn)</summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={state.careEnabled} onChange={(event) => update({ careEnabled: event.target.checked })} /> Mở yêu cầu hỗ trợ</label>
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={state.careEscalation} onChange={(event) => update({ careEscalation: event.target.checked })} /> Yêu cầu chuyển nhân viên</label>
          <Field label="Chủ đề"><input className="ui-input w-full" value={state.careSubject} onChange={(event) => update({ careSubject: event.target.value })} /></Field>
          <Field label="Chủ đề FAQ trước đó"><input className="ui-input w-full" value={state.careFaq} onChange={(event) => update({ careFaq: event.target.value })} /></Field>
        </div>
      </details>
      <details className="rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer font-medium text-ink">Hạt giống Marketing (tùy chọn)</summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={state.marketingEnabled} onChange={(event) => update({ marketingEnabled: event.target.checked })} /> Bật hạt giống Marketing</label>
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={state.marketingSuppressed} onChange={(event) => update({ marketingSuppressed: event.target.checked })} /> Bị loại trừ (suppression)</label>
          <Field label="Ngày hoạt động cuối"><input className="ui-input w-full" value={state.marketingLastActive} onChange={(event) => update({ marketingLastActive: event.target.value })} /></Field>
          <Field label="Số ngày từ lần mua đã thanh toán"><input type="number" min={0} max={36500} step={1} className="ui-input w-full" value={state.marketingInactiveDays} onChange={(event) => update({ marketingInactiveDays: event.target.value })} /></Field>
          <Field label="Số đơn đã mua"><input type="number" min={1} max={1000000} step={1} className="ui-input w-full" value={state.marketingOrderCount} onChange={(event) => update({ marketingOrderCount: event.target.value })} /></Field>
          <Field label="Điều kiện chiến dịch"><input className="ui-input w-full" value={state.marketingCampaign} onChange={(event) => update({ marketingCampaign: event.target.value })} /></Field>
        </div>
      </details>
      {error ? <p role="alert" className="ui-state ui-state--error">{error}</p> : null}
      {preview ? (
        <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-surface p-4 text-xs text-ink">{JSON.stringify(preview, null, 2)}</pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-button ui-button--secondary" onClick={onPreview} disabled={busy}>Xem trước</button>
        <button type="button" className="ui-button ui-button--primary" onClick={() => void onCreate()} disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo khách hàng thử'}</button>
      </div>
    </div>
  );
}
