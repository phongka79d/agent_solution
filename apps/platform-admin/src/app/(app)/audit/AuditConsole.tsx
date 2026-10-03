'use client';

import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  SectionHeader,
  Select,
} from '@agentos/ui-foundation/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { auditActionLabel, auditActorKindLabel, auditReasonLabel } from '../../../lib/audit-format';

import { ApiError, listTenants, platformJson, type PlatformTenant } from '../../../lib/platform-client';

/** Chain verification state reported by the platform audit API (D9/§8.8). */
export type ChainStatus = 'VERIFIED' | 'FAILED' | 'UNCHECKED';

export interface AuditEvent {
  readonly event_id: string;
  readonly chain_seq: string;
  readonly prev_hash?: string;
  readonly hash?: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly scope: string;
  readonly action: string;
  readonly tenant_id: string | null;
  readonly target: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly before_state?: unknown;
  readonly after_state?: unknown;
  readonly correlation_id: string;
  readonly created_at: string;
}

export interface AuditPagePayload {
  readonly items?: readonly AuditEvent[];
  readonly next_cursor?: string | null;
  readonly chain_verified?: boolean;
  readonly chain_verification?: string;
  readonly verified?: boolean | string;
}

const CHAIN_LABELS: Readonly<Record<ChainStatus, string>> = {
  VERIFIED: 'Đã xác minh',
  FAILED: 'Lỗi',
  UNCHECKED: 'Chưa kiểm tra',
};

const CHAIN_STYLES: Readonly<Record<ChainStatus, string>> = {
  VERIFIED: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  FAILED: 'border-red-200 bg-red-50 text-red-800',
  UNCHECKED: 'border-slate-200 bg-slate-50 text-slate-700',
};

/**
 * Reads the chain verification verdict from whatever field the page payload carries. When the API
 * does not report a verdict the badge stays honest and reads "Chưa kiểm tra" instead of implying a
 * successful verification that never ran.
 */
export function chainStatusOf(payload: AuditPagePayload | null | undefined): ChainStatus {
  if (payload === null || payload === undefined) return 'UNCHECKED';
  const raw = payload.chain_verified ?? payload.chain_verification ?? payload.verified;
  if (raw === true) return 'VERIFIED';
  if (raw === false) return 'FAILED';
  if (typeof raw === 'string') {
    const normalized = raw.trim().toUpperCase();
    if (normalized === 'VERIFIED' || normalized === 'OK' || normalized === 'VALID') return 'VERIFIED';
    if (normalized === 'FAILED' || normalized === 'INVALID' || normalized === 'TAMPERED') return 'FAILED';
  }
  return 'UNCHECKED';
}

function ChainBadge({ payload }: { readonly payload: AuditPagePayload | null }) {
  const status = chainStatusOf(payload);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${CHAIN_STYLES[status]}`}
      aria-label={`Chuỗi kiểm toán: ${CHAIN_LABELS[status]}`}
    >
      Chuỗi kiểm toán: {CHAIN_LABELS[status]}
    </span>
  );
}

const OUTCOME_OPTIONS = ['SUCCESS', 'DENIED', 'FAILED', 'PENDING'];

function valueOf(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

interface Filters {
  readonly tenant_id: string;
  readonly actor: string;
  readonly action: string;
  readonly outcome: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_FILTERS: Filters = { tenant_id: '', actor: '', action: '', outcome: '', from: '', to: '' };

/** Applies the client-side filters to a loaded page. Company is also pushed to the server query. */
export function applyFilters(items: readonly AuditEvent[], filters: Filters): readonly AuditEvent[] {
  const actor = filters.actor.trim().toLowerCase();
  const action = filters.action.trim().toLowerCase();
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
  return items.filter((event) => {
    if (filters.tenant_id && event.tenant_id !== filters.tenant_id) return false;
    if (actor && !`${event.actor_id} ${event.actor_kind}`.toLowerCase().includes(actor)) return false;
    if (action && !event.action.toLowerCase().includes(action)) return false;
    if (filters.outcome && event.outcome !== filters.outcome) return false;
    const timestamp = Date.parse(event.created_at);
    if (from !== null && Number.isFinite(from) && (!Number.isFinite(timestamp) || timestamp < from)) return false;
    if (to !== null && Number.isFinite(to) && (!Number.isFinite(timestamp) || timestamp > to)) return false;
    return true;
  });
}

export function AuditConsole() {
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [payload, setPayload] = useState<AuditPagePayload | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [tenants, setTenants] = useState<readonly PlatformTenant[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [appending, setAppending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async (cursor: string | null, append: boolean, tenantId: string) => {
    if (append) setAppending(true);
    else setLoading(true);
    setFailed(null);
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (cursor) query.set('cursor', cursor);
      if (tenantId) query.set('tenant_id', tenantId);
      const page = await platformJson<AuditPagePayload>(`platform/audit?${query.toString()}`);
      const items = Array.isArray(page.items) ? page.items : [];
      setEvents((current) => (append ? [...current, ...items] : items));
      setPayload(page);
      setNextCursor(typeof page.next_cursor === 'string' && page.next_cursor.length > 0 ? page.next_cursor : null);
    } catch (error) {
      setFailed(error instanceof ApiError ? error.message : 'Không tải được nhật ký kiểm toán.');
    } finally {
      setLoading(false);
      setAppending(false);
    }
  }, []);

  useEffect(() => {
    void load(null, false, '');
    void listTenants().then(setTenants).catch(() => setTenants([]));
  }, [load]);

  const filtered = useMemo(() => applyFilters(events, filters), [events, filters]);

  const tenantOptions = useMemo(
    () => [{ value: '', label: 'Tất cả công ty' }, ...tenants.map((tenant) => ({ value: tenant.tenant_id, label: tenant.display_name || tenant.tenant_id }))],
    [tenants],
  );
  const tenantNames = useMemo(() => new Map(tenants.map((tenant) => [tenant.tenant_id, tenant.display_name])), [tenants]);
  // A company name when known; the raw id is technical detail, so it only appears monospaced.
  const companyCell = (tenantId: string | null | undefined): ReactNode => {
    if (!tenantId) return 'Nền tảng';
    const name = tenantNames.get(tenantId);
    return name ? name : <span className="font-mono text-xs">{tenantId}</span>;
  };

  function updateFilter(patch: Partial<Filters>): void {
    setFilters((current) => {
      const next = { ...current, ...patch };
      if (patch.tenant_id !== undefined && patch.tenant_id !== current.tenant_id) {
        void load(null, false, next.tenant_id);
      }
      return next;
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Nền tảng"
        title="Nhật ký kiểm toán"
        description="Mọi thay đổi quản trị trên nền tảng đều truy vết được: ai, làm gì, khi nào, vì sao."
        actions={<ChainBadge payload={payload} />}
      />

      <section className="ui-section-card p-4 sm:p-5" aria-label="Bộ lọc">
        <SectionHeader title="Bộ lọc" description="Lọc theo công ty, người thực hiện, hành động, thời gian và kết quả." />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm text-muted">
            Công ty
            <Select value={filters.tenant_id} options={tenantOptions} onChange={(event) => updateFilter({ tenant_id: event.target.value })} aria-label="Công ty" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Người thực hiện
            <Input value={filters.actor} placeholder="actor_id hoặc actor_kind" onChange={(event) => updateFilter({ actor: event.target.value })} aria-label="Người thực hiện" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Hành động
            <Input value={filters.action} placeholder="ví dụ: provider.update" onChange={(event) => updateFilter({ action: event.target.value })} aria-label="Hành động" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Kết quả
            <Select
              value={filters.outcome}
              options={[{ value: '', label: 'Tất cả kết quả' }, ...OUTCOME_OPTIONS.map((value) => ({ value, label: value }))]}
              onChange={(event) => updateFilter({ outcome: event.target.value })}
              aria-label="Kết quả"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Từ ngày
            <Input type="date" value={filters.from} max={today} onChange={(event) => updateFilter({ from: event.target.value })} aria-label="Từ ngày" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Đến ngày
            <Input type="date" value={filters.to} max={today} onChange={(event) => updateFilter({ to: event.target.value })} aria-label="Đến ngày" />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>Xóa bộ lọc</Button>
          <Button variant="secondary" size="sm" onClick={() => void load(null, false, filters.tenant_id)} disabled={loading}>Tải lại</Button>
          <span className="text-xs text-muted">Hiển thị {filtered.length} / {events.length} sự kiện đã tải.</span>
        </div>
      </section>

      <section className="ui-section-card" aria-label="Danh sách sự kiện">
        {failed !== null ? (
          <div className="p-5"><ErrorState message={failed} onRetry={() => void load(null, false, filters.tenant_id)} /></div>
        ) : loading ? (
          <div className="p-5"><LoadingState label="Đang tải nhật ký kiểm toán" /></div>
        ) : (
          <>
            <DataTable<AuditEvent>
              caption="Sự kiện kiểm toán"
              getRowKey={(row) => row.event_id}
              rows={filtered}
              empty={<EmptyState title="Chưa có sự kiện" description="Không có sự kiện nào khớp bộ lọc hiện tại." status="NO_DATA" />}
              columns={[
                { key: 'created_at', header: 'Thời điểm', render: (row) => new Date(row.created_at).toLocaleString('vi-VN') },
                { key: 'actor', header: 'Người thực hiện', render: (row) => <>{auditActorKindLabel(row.actor_kind)} · <span className="font-mono text-xs">{row.actor_id}</span></> },
                { key: 'action', header: 'Hành động', render: (row) => auditActionLabel(row.action) },
                { key: 'tenant_id', header: 'Công ty', render: (row) => companyCell(row.tenant_id) },
                { key: 'outcome', header: 'Kết quả' },
                {
                  key: 'detail',
                  header: '',
                  render: (row) => <Button variant="ghost" size="sm" onClick={() => setSelected(row)}>Chi tiết</Button>,
                },
              ]}
            />
            <div className="flex items-center justify-between gap-3 p-4">
              <span className="text-xs text-muted">
                {nextCursor === null ? 'Đã hết sự kiện.' : 'Còn sự kiện cũ hơn.'}
              </span>
              <Button
                variant="secondary"
                size="sm"
                loading={appending}
                disabled={nextCursor === null}
                onClick={() => { if (nextCursor) void load(nextCursor, true, filters.tenant_id); }}
              >
                Tải thêm
              </Button>
            </div>
          </>
        )}
      </section>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Chi tiết sự kiện kiểm toán"
        {...(selected === null ? {} : { description: auditActionLabel(selected.action) })}
      >
        {selected ? (
          <dl className="space-y-3 text-sm">
            <div><dt className="text-muted">Mã sự kiện</dt><dd className="font-mono text-xs text-ink">{selected.event_id}</dd></div>
            <div><dt className="text-muted">Chuỗi</dt><dd className="font-mono text-xs text-ink">#{selected.chain_seq}</dd></div>
            <div>
              <dt className="text-muted">Hành động</dt>
              <dd className="text-ink">
                {auditActionLabel(selected.action)}
                <details className="mt-1 text-xs text-muted">
                  <summary>Chi tiết kỹ thuật</summary>
                  <code className="font-mono">{selected.action}</code>
                </details>
              </dd>
            </div>
            <div><dt className="text-muted">Người thực hiện</dt><dd className="text-ink">{auditActorKindLabel(selected.actor_kind)} · <span className="font-mono text-xs">{selected.actor_id}</span></dd></div>
            <div><dt className="text-muted">Phạm vi</dt><dd className="text-ink">{selected.scope}</dd></div>
            <div><dt className="text-muted">Đối tượng</dt><dd className="font-mono text-xs text-ink">{selected.target ?? '—'}</dd></div>
            <div><dt className="text-muted">Công ty</dt><dd className="text-ink">{companyCell(selected.tenant_id)}</dd></div>
            <div><dt className="text-muted">Kết quả</dt><dd className="text-ink">{selected.outcome}</dd></div>
            <div><dt className="text-muted">Lý do</dt><dd className="text-ink">{auditReasonLabel(selected.reason)}</dd></div>
            <div><dt className="text-muted">Mã tương quan</dt><dd className="font-mono text-xs text-ink">{selected.correlation_id}</dd></div>
            <div>
              <dt className="text-muted">Trước (đã che thông tin nhạy cảm)</dt>
              <dd><pre className="mt-1 max-h-48 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs text-ink">{valueOf(selected.before_state)}</pre></dd>
            </div>
            <div>
              <dt className="text-muted">Sau (đã che thông tin nhạy cảm)</dt>
              <dd><pre className="mt-1 max-h-48 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs text-ink">{valueOf(selected.after_state)}</pre></dd>
            </div>
          </dl>
        ) : null}
      </Drawer>
    </div>
  );
}
