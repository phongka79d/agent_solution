'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RequirePermission } from '../../../components/auth/RequirePermission';
import { StatusBadge, EmptyState, PageHeader } from '@agentos/ui-foundation/react';

type Campaign = { readonly run_id?: string | null; readonly campaign_id?: string | null; readonly name?: string | null; readonly objective?: string | null; readonly lifecycle_state?: string; readonly created_at?: string | null; readonly dispatch?: { readonly status?: string } };

const lifecycleLabel: Record<string, string> = {
  draft: 'Nháp', in_review: 'Đang rà soát', brand_audit: 'Đang rà soát', awaiting_approval: 'Chờ phê duyệt', approved: 'Đã duyệt', in_flight: 'Gửi đi',
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try { const value: unknown = await response.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

function CampaignsContent() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch('/api/v1/campaigns?limit=100', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(async (response) => {
      const payload = await readJson(response);
      if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : 'Không thể tải chiến dịch.');
      const rows = Array.isArray(payload.items) ? payload.items : [];
      if (active) setItems(rows.filter((item): item is Campaign => !!item && typeof item === 'object'));
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Không thể tải chiến dịch.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <div className="space-y-6"><PageHeader title="Chiến dịch" description="Theo dõi bản nháp và trạng thái phê duyệt của Marketing." actions={<Link className="ui-button ui-button--primary" href="/campaigns/new">Tạo bản nháp</Link>} />
    {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
    {loading ? <p aria-busy="true">Đang tải…</p> : items.length === 0 ? <EmptyState status="NO_DATA" title="Chưa có dữ liệu" description="Chưa có chiến dịch nào được tạo." /> : <div className="grid gap-4 md:grid-cols-2">{items.map((item, index) => { const state = item.lifecycle_state ?? 'unknown'; return <Link key={item.run_id ?? item.campaign_id ?? `campaign-${index}`} href={item.run_id ? `/campaigns/${encodeURIComponent(item.run_id)}` : '/campaigns'} className="rounded-xl border border-line bg-surface p-5 hover:border-primary"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-ink">{item.name ?? item.objective ?? 'Chiến dịch'}</h2><p className="mt-1 text-sm text-muted">{item.objective ?? 'Chưa có mục tiêu'}</p></div><StatusBadge code={state === 'approved' ? 'ACTIVE' : state === 'awaiting_approval' ? 'APPROVAL_PENDING' : state === 'in_flight' ? 'NOT_INTEGRATED' : 'UNKNOWN'} label={lifecycleLabel[state] ?? 'Chưa phân loại'} /></div><p className="mt-4 text-xs text-muted">Gửi đi: Chưa tích hợp</p></Link>; })}</div>}
  </div>;
}

export default function CampaignsPage() { return <RequirePermission permissions={['campaign:draft', 'approval:read']}><CampaignsContent /></RequirePermission>; }
