'use client';

import { can } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
  SectionHeader,
} from '@agentos/ui-foundation/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CompanyAuditEvent, CompanyAuditPage } from '../../../lib/tenant-console-client';
import { tenantConsoleClient } from '../../../lib/tenant-console-client';
import { useSession } from '../../auth/SessionProvider';

type ChainStatus = 'VERIFIED' | 'FAILED' | 'UNCHECKED';

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
 * Reads the chain verdict from the payload when the API reports one; a payload without a verdict is
 * shown as "Chưa kiểm tra" rather than claiming a verification that never ran.
 */
export function chainStatusOf(payload: CompanyAuditPage | null | undefined): ChainStatus {
  if (payload === null || payload === undefined) return 'UNCHECKED';
  const raw = payload.chain_verified ?? payload.chain_verification ?? payload.verified;
  if (raw === true) return 'VERIFIED';
  if (raw === false) return 'FAILED';
  if (typeof raw === 'string') {
    const normalized = raw.trim().toUpperCase();
    if (['VERIFIED', 'OK', 'VALID'].includes(normalized)) return 'VERIFIED';
    if (['FAILED', 'INVALID', 'TAMPERED'].includes(normalized)) return 'FAILED';
  }
  return 'UNCHECKED';
}

interface Filters {
  readonly actor: string;
  readonly action: string;
  readonly outcome: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_FILTERS: Filters = { actor: '', action: '', outcome: '', from: '', to: '' };

export function applyCompanyAuditFilters(items: readonly CompanyAuditEvent[], filters: Filters): readonly CompanyAuditEvent[] {
  const actor = filters.actor.trim().toLowerCase();
  const action = filters.action.trim().toLowerCase();
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : Number.NaN;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : Number.NaN;
  return items.filter((event) => {
    if (actor && !`${event.actor_id} ${event.actor_kind}`.toLowerCase().includes(actor)) return false;
    if (action && !event.action.toLowerCase().includes(action)) return false;
    if (filters.outcome && event.outcome !== filters.outcome) return false;
    const timestamp = Date.parse(event.created_at);
    if (Number.isFinite(from) && (!Number.isFinite(timestamp) || timestamp < from)) return false;
    if (Number.isFinite(to) && (!Number.isFinite(timestamp) || timestamp > to)) return false;
    return true;
  });
}

function valueOf(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

export function SettingsAuditTab() {
  const session = useSession();
  const allowed = can(session, 'settings:manage');
  const [events, setEvents] = useState<readonly CompanyAuditEvent[]>([]);
  const [payload, setPayload] = useState<CompanyAuditPage | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<CompanyAuditEvent | null>(null);
  const [loading, setLoading] = useState(allowed);
  const [appending, setAppending] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    if (append) setAppending(true);
    else setLoading(true);
    setFailed(false);
    try {
      const page = await tenantConsoleClient.getCompanyAudit({ limit: 50, ...(cursor ? { cursor } : {}) });
      const items = Array.isArray(page.items) ? page.items : [];
      setEvents((current) => (append ? [...current, ...items] : items));
      setPayload(page);
      setNextCursor(typeof page.next_cursor === 'string' && page.next_cursor.length > 0 ? page.next_cursor : null);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setAppending(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    void load(null, false);
  }, [allowed, load]);

  const filtered = useMemo(() => applyCompanyAuditFilters(events, filters), [events, filters]);
  const chain = chainStatusOf(payload);
  const today = new Date().toISOString().slice(0, 10);

  if (!allowed) {
    return <EmptyState title={t('auth.forbidden')} description="Bạn cần quyền quản lý cài đặt để xem nhật ký." status="NOT_INTEGRATED" />;
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Nhật ký kiểm toán"
        description="Mọi thay đổi quản trị của công ty đều được ghi lại và truy vết."
        action={
          <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${CHAIN_STYLES[chain]}`}>
            Chuỗi kiểm toán: {CHAIN_LABELS[chain]}
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm text-muted">
          Người thực hiện
          <Input value={filters.actor} aria-label="Người thực hiện" onChange={(event) => setFilters((current) => ({ ...current, actor: event.target.value }))} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Hành động
          <Input value={filters.action} aria-label="Hành động" onChange={(event) => setFilters((current) => ({ ...current, action: event.target.value }))} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Kết quả
          <Select
            value={filters.outcome}
            aria-label="Kết quả"
            options={[
              { value: '', label: 'Tất cả kết quả' },
              { value: 'SUCCESS', label: 'SUCCESS' },
              { value: 'DENIED', label: 'DENIED' },
              { value: 'FAILED', label: 'FAILED' },
            ]}
            onChange={(event) => setFilters((current) => ({ ...current, outcome: event.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Từ ngày
          <Input type="date" value={filters.from} max={today} aria-label="Từ ngày" onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Đến ngày
          <Input type="date" value={filters.to} max={today} aria-label="Đến ngày" onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>Xóa bộ lọc</Button>
        <Button variant="secondary" size="sm" onClick={() => void load(null, false)} disabled={loading}>Tải lại</Button>
        <span className="text-xs text-muted">Hiển thị {filtered.length} / {events.length} sự kiện đã tải.</span>
      </div>

      {failed ? (
        <ErrorState message="Không tải được nhật ký kiểm toán." onRetry={() => void load(null, false)} />
      ) : loading ? (
        <LoadingState label={t('common.loading')} />
      ) : (
        <>
          <DataTable<CompanyAuditEvent>
            caption="Nhật ký kiểm toán"
            getRowKey={(row) => row.event_id}
            rows={filtered}
            empty={<EmptyState title="Chưa có sự kiện" description="Không có sự kiện nào khớp bộ lọc hiện tại." status="NO_DATA" />}
            columns={[
              { key: 'created_at', header: 'Thời điểm', render: (row) => new Date(row.created_at).toLocaleString('vi-VN') },
              { key: 'actor', header: 'Người thực hiện', render: (row) => `${row.actor_id} (${row.actor_kind})` },
              { key: 'action', header: 'Hành động' },
              { key: 'outcome', header: 'Kết quả' },
              { key: 'detail', header: '', render: (row) => <Button variant="ghost" size="sm" onClick={() => setSelected(row)}>Chi tiết</Button> },
            ]}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">{nextCursor === null ? 'Đã hết sự kiện.' : 'Còn sự kiện cũ hơn.'}</span>
            <Button variant="secondary" size="sm" loading={appending} disabled={nextCursor === null} onClick={() => { if (nextCursor) void load(nextCursor, true); }}>
              Tải thêm
            </Button>
          </div>
        </>
      )}

      <Drawer open={selected !== null} onClose={() => setSelected(null)} title="Chi tiết sự kiện kiểm toán" {...(selected === null ? {} : { description: selected.action })}>
        {selected ? (
          <dl className="space-y-3 text-sm">
            <div><dt className="text-muted">Hành động</dt><dd className="text-ink">{selected.action}</dd></div>
            <div><dt className="text-muted">Người thực hiện</dt><dd className="text-ink">{selected.actor_id} ({selected.actor_kind})</dd></div>
            <div><dt className="text-muted">Đối tượng</dt><dd className="text-ink">{selected.target ?? '—'}</dd></div>
            <div><dt className="text-muted">Kết quả</dt><dd className="text-ink">{selected.outcome}</dd></div>
            <div><dt className="text-muted">Lý do</dt><dd className="text-ink">{selected.reason ?? '—'}</dd></div>
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
