'use client';

import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@agentos/ui-foundation';
import { AdvancedDetails, EmptyState, LoadingState, Tabs } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { Customer360Timeline } from './Customer360Timeline';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function money(value: unknown, fallbackCurrency: string | null = null): { readonly amount: number; readonly currency: string } | null {
  if (typeof value === 'number' && Number.isFinite(value) && fallbackCurrency) return { amount: value, currency: fallbackCurrency };
  const source = record(value);
  const amount = typeof source.amount === 'number' ? source.amount : typeof source.value === 'number' ? source.value : null;
  const currency = stringValue(source.currency) ?? stringValue(source.currency_code) ?? fallbackCurrency;
  return amount !== null && currency ? { amount, currency } : null;
}

function formatMoney(value: { readonly amount: number; readonly currency: string }): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: value.currency }).format(value.amount);
  } catch {
    return `${value.amount.toLocaleString()} ${value.currency}`;
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface Customer360ProfileProps {
  readonly customerId: string;
}

export function Customer360Profile({ customerId }: Customer360ProfileProps) {
  const [profile, setProfile] = useState<JsonRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setProfile(null);
    setNotFound(false);
    setError(null);
    void tenantConsoleClient.getCustomerProfile(customerId).then((payload) => {
      if (!active) return;
      setProfile(record(payload));
    }).catch((reason: unknown) => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 404) setNotFound(true);
      else setError(reason instanceof Error ? reason.message : 'Không thể tải hồ sơ khách hàng.');
    }).finally(() => {
      if (active) setLoading(false);
    });
  }, [customerId]);

  const customer = useMemo(() => record(profile?.customer ?? profile), [profile]);
  const name = stringValue(customer.display_name) ?? stringValue(customer.name) ?? 'Khách hàng';
  const email = stringValue(customer.email) ?? stringValue(customer.verified_email) ?? stringValue(customer.email_masked);
  const phone = stringValue(customer.phone) ?? stringValue(customer.verified_phone) ?? stringValue(customer.phone_masked);
  const tier = stringValue(customer.tier) ?? stringValue(customer.customer_tier);
  const classificationSource = customer.classifications ?? customer.classification;
  const classifications = (Array.isArray(classificationSource) ? classificationSource : classificationSource ? [classificationSource] : []).map((item) => String(item));
  const ltv = money(customer.total_spent ?? customer.ltv ?? customer.ltv_amount, stringValue(customer.currency) ?? stringValue(customer.ltv_currency) ?? 'VND') ?? (typeof customer.ltv_twd === 'number' ? { amount: customer.ltv_twd, currency: 'TWD' } : null);
  const aov = money(customer.aov ?? customer.aov_amount, stringValue(customer.aov_currency) ?? (typeof customer.aov_twd === 'number' ? 'TWD' : null)) ?? (typeof customer.aov_twd === 'number' ? { amount: customer.aov_twd, currency: 'TWD' } : null);

  if (loading) return <LoadingState label="Đang tải hồ sơ khách hàng…" />;
  if (notFound) return <EmptyState title="Chưa có dữ liệu" description="Không tìm thấy hồ sơ khách hàng trong không gian làm việc này." />;
  if (error) return <p role="alert" className="rounded-md border border-danger p-4 text-danger">{error}</p>;

  const emptyTab = <EmptyState title="Chưa có dữ liệu" />;
  const marketingItems = list(customer.campaign_engagement).length ? list(customer.campaign_engagement) : list(customer.marketing);
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="ui-section-card p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold text-ink">{name}</h1><p className="mt-1 text-sm text-muted">Hồ sơ khách hàng</p><div className="mt-3 flex flex-wrap gap-2 text-sm text-muted">{email ? <span>{email}</span> : null}{phone ? <span>{phone}</span> : null}{tier ? <span className="rounded-full border border-line px-2 py-0.5">{tier}</span> : null}</div>{classifications.length ? <div className="mt-3 flex flex-wrap gap-2">{classifications.map((classification) => <span key={classification} className="rounded-full border border-line px-2 py-0.5 text-xs">{classification === 'HYPOTHESIS' ? 'Dự đoán' : classification === 'FACT' ? 'Đã xác thực' : classification === 'SIGNAL' ? 'Tín hiệu' : 'Chưa phân loại'}</span>)}</div> : null}</div><div className="flex flex-wrap gap-4 text-sm">{ltv ? <span>LTV: <strong>{formatMoney(ltv)}</strong></span> : null}{aov ? <span>AOV: <strong>{formatMoney(aov)}</strong></span> : null}</div></div></header>
      <Tabs tabs={[
        { id: 'orders', label: 'Đơn hàng', content: list(customer.orders).length ? <ListItems values={list(customer.orders)} /> : emptyTab },
        { id: 'conversations', label: 'Hội thoại', content: list(customer.conversations).length ? <ListItems values={list(customer.conversations)} /> : emptyTab },
        { id: 'marketing', label: 'Marketing', content: marketingItems.length ? <ListItems values={marketingItems} /> : emptyTab },
        { id: 'suggestions', label: 'Gợi ý', content: list(customer.recommendations).length ? <ListItems values={list(customer.recommendations)} /> : emptyTab },
        { id: 'support', label: 'Hỗ trợ', content: list(customer.service_cases).length ? <ListItems values={list(customer.service_cases)} /> : emptyTab },
      ]} />
      <Customer360Timeline initialCustomerId={customerId} />
      <AdvancedDetails summary="Chi tiết kỹ thuật"><dl className="grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-muted">customer_id</dt><dd>{customerId}</dd></div>{stringValue(customer.tenant_id) ? <div><dt className="text-muted">tenant_id</dt><dd>{customer.tenant_id as string}</dd></div> : null}</dl></AdvancedDetails>
    </div>
  );
}

function formatListItemText(value: unknown): string {
  if (typeof value === 'string') return value;
  const item = record(value);
  if (item.order_number) {
    const amount = item.total_amount ? ` - ${Number(item.total_amount).toLocaleString()} ${item.currency ?? 'VND'}` : '';
    const status = item.status ? ` (${item.status})` : '';
    return `Đơn hàng #${item.order_number}${amount}${status}`;
  }
  if (item.conversation_id) {
    const channel = item.channel ? `[${item.channel}]` : '';
    const state = item.state ? ` (${item.state})` : '';
    return `Hội thoại #${item.conversation_id} ${channel}${state}`;
  }
  if (item.subject || item.case_number) {
    const caseNum = item.case_number ? `#${item.case_number} ` : '';
    const subject = item.subject ? String(item.subject) : 'Yêu cầu hỗ trợ';
    const state = item.state ? ` (${item.state})` : '';
    return `${caseNum}${subject}${state}`;
  }
  if (item.reason || item.recommendation_type) {
    return String(item.reason ?? item.recommendation_type);
  }
  if (item.conversion_type || item.campaign_id) {
    const type = item.conversion_type ? String(item.conversion_type) : 'Chiến dịch';
    const rev = item.gross_revenue ? ` (${Number(item.gross_revenue).toLocaleString()} VND)` : '';
    return `${type}${rev}`;
  }
  return String(item.title ?? item.name ?? item.id ?? 'Mục dữ liệu');
}

function ListItems({ values }: { readonly values: readonly unknown[] }) {
  return <ul className="space-y-2">{values.map((value, index) => {
    const item = record(value);
    const classification = stringValue(item.classification);
    return <li key={index} className="rounded border border-line p-3 text-sm">{classification === 'HYPOTHESIS' ? <span className="mr-2 rounded-full border border-line px-2 py-0.5 text-xs">Dự đoán</span> : null}{formatListItemText(value)}</li>;
  })}</ul>;
}
