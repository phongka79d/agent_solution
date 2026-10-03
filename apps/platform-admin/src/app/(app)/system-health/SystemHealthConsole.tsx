'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

type HealthState = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'NOT_CHECKED';
type Probe = { readonly state?: HealthState; readonly error_code?: string };
type HealthPayload = {
  readonly observed_at?: string;
  readonly state?: HealthState;
  readonly probes?: {
    readonly api?: Probe;
    readonly database?: Probe;
    readonly redis?: Probe;
    readonly qdrant?: Probe;
    readonly workers?: Probe & { readonly items?: readonly { readonly worker_id?: string; readonly heartbeat_at?: string; readonly age_seconds?: number | null }[] };
    readonly queue?: Probe & { readonly depth?: number | null; readonly oldest_queued_age_seconds?: number | null; readonly expired_leases?: number | null };
    readonly migrations?: Probe & { readonly applied_count?: number; readonly latest_applied?: string | null; readonly applied?: readonly string[] };
    readonly llm?: Probe & { readonly last_probe?: Readonly<Record<string, unknown>> | null };
    readonly connectors?: Probe & { readonly companies?: readonly Readonly<Record<string, unknown>>[] };
  };
};

const STATE_LABELS: Readonly<Record<HealthState, string>> = {
  HEALTHY: 'Hoạt động',
  DEGRADED: 'Suy giảm',
  FAILED: 'Lỗi',
  NOT_CHECKED: 'Chưa kiểm tra',
};

function Status({ state }: { readonly state?: HealthState | undefined }) {
  const normalized = state !== undefined && Object.hasOwn(STATE_LABELS, state) ? state : 'NOT_CHECKED';
  const style = normalized === 'HEALTHY'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : normalized === 'DEGRADED'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : normalized === 'FAILED'
        ? 'border-red-200 bg-red-50 text-red-800'
        : 'border-slate-200 bg-slate-50 text-slate-700';
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>{STATE_LABELS[normalized]}</span>;
}

function Card({ title, probe, children }: { readonly title: string; readonly probe?: Probe | undefined; readonly children?: ReactNode }) {
  return (
    <section className="ui-section-card p-4 sm:p-5" aria-label={title}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <Status state={probe?.state} />
      </div>
      {children ? <div className="mt-3 text-sm leading-6 text-muted">{children}</div> : null}
      {probe?.error_code ? <p className="mt-2 text-xs text-muted">Mã kỹ thuật: {probe.error_code}</p> : null}
    </section>
  );
}

function displayValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
}

function ageLabel(seconds: number | null | undefined): string {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? `${seconds} giây`
    : 'Chưa có dữ liệu';
}

export function SystemHealthConsole() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/v1/platform/health', { credentials: 'same-origin', cache: 'no-store' });
      const payload: unknown = await response.json();
      if (!response.ok || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('health unavailable');
      }
      setHealth(payload as HealthPayload);
    } catch {
      setError('Không tải được tình trạng hệ thống. Vui lòng thử lại.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const probes = health?.probes;
  const lastLlmProbe = probes?.llm?.last_probe;
  const connectors = probes?.connectors?.companies ?? [];
  const workers = probes?.workers?.items ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Tình trạng hệ thống</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Theo dõi dịch vụ, hàng đợi và các lần kiểm tra kết nối gần nhất.</p>
        </div>
        <button type="button" onClick={() => { void refresh(); }} disabled={loading} className="ui-button-secondary">
          {loading ? 'Đang cập nhật…' : 'Làm mới'}
        </button>
      </header>

      {health ? <div className="flex flex-wrap items-center gap-3" aria-live="polite">
        <span className="text-sm font-medium text-ink">Tổng quan</span>
        <Status state={health.state} />
        <span className="text-xs text-muted">Cập nhật lúc {health.observed_at ? new Date(health.observed_at).toLocaleString('vi-VN') : '—'}</span>
      </div> : null}
      {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div> : null}
      {!health && loading ? <p className="ui-section-card p-5 text-sm text-muted" role="status">Đang kiểm tra tình trạng hệ thống…</p> : null}

      {health && probes ? <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Card title="API" probe={probes.api} />
          <Card title="Cơ sở dữ liệu" probe={probes.database} />
          <Card title="Redis" probe={probes.redis} />
          <Card title="Qdrant" probe={probes.qdrant} />
          <Card title="Worker" probe={probes.workers}>
            {workers.length === 0 ? 'Chưa ghi nhận worker.' : workers.map((worker) => (
              <p key={worker.worker_id ?? worker.heartbeat_at}>
                {worker.worker_id ?? 'Worker'} · nhịp gần nhất {ageLabel(worker.age_seconds)}
              </p>
            ))}
          </Card>
          <Card title="Hàng đợi" probe={probes.queue}>
            <p>{probes.queue?.depth ?? '—'} tác vụ đang chờ</p>
            <p>Tác vụ chờ lâu nhất: {ageLabel(probes.queue?.oldest_queued_age_seconds)}</p>
            <p>Lease hết hạn: {probes.queue?.expired_leases ?? '—'}</p>
          </Card>
          <Card title="Lịch sử di trú cơ sở dữ liệu" probe={probes.migrations}>
            <p>{probes.migrations?.applied_count ?? 0} di trú đã áp dụng</p>
            <p>Gần nhất: {probes.migrations?.latest_applied ?? 'Chưa có dữ liệu'}</p>
          </Card>
          <Card title="Nhà cung cấp AI" probe={probes.llm}>
            {lastLlmProbe ? <>
              <p>Nhà cung cấp: {displayValue(lastLlmProbe['provider_id'])}</p>
              <p>Kiểm tra gần nhất: {displayValue(lastLlmProbe['tested_at'])}</p>
              <p>Kết quả: {displayValue(lastLlmProbe['outcome'])}</p>
            </> : 'Chưa có lần kiểm tra nào.'}
          </Card>
        </div>

        <Card title="Kiểm tra kết nối theo công ty" probe={probes.connectors}>
          {connectors.length === 0 ? <p>Chưa có kết quả kiểm tra kết nối.</p> : <ul className="space-y-2">
            {connectors.map((connector, index) => <li key={`${displayValue(connector['tenant_id'])}:${displayValue(connector['connector_id'])}:${displayValue(connector['probe_name'])}:${index}`} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{displayValue(connector['company'])}</span>
              <span>{displayValue(connector['connector_id'])} · {displayValue(connector['probe_name'])}</span>
              <Status state={connector['outcome'] === 'PASS' ? 'HEALTHY' : connector['outcome'] === 'FAIL' ? 'FAILED' : 'NOT_CHECKED'} />
              <span>{displayValue(connector['probed_at'])}</span>
            </li>)}
          </ul>}
        </Card>
      </> : null}
    </div>
  );
}
