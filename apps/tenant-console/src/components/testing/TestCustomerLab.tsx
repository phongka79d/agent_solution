'use client';

import { useCallback, useEffect, useState } from 'react';
import { DataClassBadge, EmptyState, LoadingState, PageHeader } from '@agentos/ui-foundation/react';
import {
  deleteTestCustomer,
  getTestingStatus,
  listTestCustomers,
  resetTestData,
  TestLabError,
  type TestCustomer,
} from '../../lib/testing/test-lab-client';

export function TestCustomerLab() {
  const [items, setItems] = useState<TestCustomer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (append = false): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await listTestCustomers({ limit: 50, ...(append && cursor ? { cursor } : {}), ...(search.trim() ? { search: search.trim() } : {}) });
      setItems((previous) => (append ? [...previous, ...page.items.filter((item) => !previous.some((old) => old.id === item.id))] : [...page.items]));
      setCursor(page.next_cursor);
    } catch (reason: unknown) {
      setError(reason instanceof TestLabError ? `Không tải được khách hàng thử (${reason.errorCode}).` : 'Không tải được khách hàng thử.');
    } finally {
      setLoading(false);
    }
  }, [cursor, search]);

  useEffect(() => {
    void (async () => {
      try {
        const status = await getTestingStatus();
        setEnabled(status.enabled);
      } catch {
        setEnabled(false);
      }
    })();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  async function onDelete(id: string): Promise<void> {
    if (!window.confirm('Xóa khách hàng thử này?')) return;
    try {
      await deleteTestCustomer(id);
      setItems((previous) => previous.filter((item) => item.id !== id));
      setNotice('Đã xóa khách hàng thử.');
    } catch (reason: unknown) {
      setError(reason instanceof TestLabError ? `Không xóa được (${reason.errorCode}).` : 'Không xóa được khách hàng thử.');
    }
  }

  if (enabled === false) {
    return (
      <div className="space-y-4">
        <PageHeader title="Phòng thử nghiệm" description="Tạo và quản lý khách hàng TEST." />
        <p className="ui-state ui-state--error">Phòng thử nghiệm chỉ khả dụng cho công ty DEMO/TEST hoặc khi bật dữ liệu thử.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Phòng thử nghiệm" description="Tạo và quản lý khách hàng TEST cho demo, QA và kiểm thử." />
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="ui-input"
          placeholder="Tìm theo tên, email, điện thoại…"
          aria-label="Tìm khách hàng thử"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <a className="ui-button ui-button--primary" href="/testing/customers/new">Tạo khách hàng thử</a>
        <ResetDialog />
      </div>
      {notice ? <p role="status" className="ui-state ui-state--success">{notice}</p> : null}
      {error ? <p role="alert" className="ui-state ui-state--error">{error}</p> : null}
      {loading && items.length === 0 ? <LoadingState label="Đang tải khách hàng thử…" /> : items.length === 0 ? (
        <EmptyState title="Chưa có khách hàng thử" description="Tạo khách hàng TEST đầu tiên để bắt đầu." />
      ) : (
        <section aria-label="Danh sách khách hàng thử" className="ui-section-card overflow-x-auto p-0" tabIndex={0}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="p-3">Tên</th>
                <th className="p-3">Liên hệ</th>
                <th className="p-3">Loại</th>
                <th className="p-3">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-line align-top">
                  <td className="p-3"><a className="text-primary underline" href={`/testing/customers/${encodeURIComponent(item.id)}`}>{item.display_name ?? 'Khách hàng thử'}</a></td>
                  <td className="p-3 text-muted">{item.primary_email ?? item.primary_phone ?? '—'}</td>
                  <td className="p-3"><DataClassBadge code={item.data_class} /></td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-2">
                      <a className="text-xs text-primary underline" href={`/customers/${encodeURIComponent(item.id)}`}>Customer360</a>
                      <a className="text-xs text-primary underline" href={`/testing/customers/${encodeURIComponent(item.id)}/storefront`}>Storefront</a>
                      <a className="text-xs text-primary underline" href={`/testing/customers/${encodeURIComponent(item.id)}`}>Thao tác</a>
                      <button type="button" className="text-xs text-danger underline" onClick={() => void onDelete(item.id)}>Xóa</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor ? <button type="button" className="ui-button ui-button--secondary m-3" onClick={() => void load(true)}>Xem thêm</button> : null}
        </section>
      )}
    </div>
  );
}

export function ResetDialog() {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Readonly<Record<string, number>> | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function dryRun(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await resetTestData(true);
      setCounts(result.counts);
      setToken(result.confirm_token ?? null);
      setOpen(true);
    } catch (reason: unknown) {
      setError(reason instanceof TestLabError ? `Không chạy được kiểm tra (${reason.errorCode}).` : 'Không chạy được kiểm tra.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (typed.trim().toUpperCase() !== 'RESET' || token === null) return;
    setBusy(true);
    setError(null);
    try {
      await resetTestData(false, token);
      setDone(true);
      setOpen(false);
    } catch (reason: unknown) {
      setError(reason instanceof TestLabError ? `Không đặt lại được (${reason.errorCode}).` : 'Không đặt lại được dữ liệu.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ui-button ui-button--secondary" onClick={() => void dryRun()} disabled={busy}>Đặt lại dữ liệu thử nghiệm</button>
      {done ? <p role="status" className="ui-state ui-state--success">Đã đặt lại dữ liệu thử nghiệm.</p> : null}
      {error && !open ? <p role="alert" className="ui-state ui-state--error">{error}</p> : null}
      {open ? (
        <div role="dialog" aria-label="Xác nhận đặt lại dữ liệu thử nghiệm" className="ui-section-card p-4">
          <h2 className="font-semibold text-ink">Đặt lại dữ liệu thử nghiệm</h2>
          <p className="mt-1 text-sm text-muted">Chỉ xóa thực thể TEST; cấu hình công ty được giữ nguyên.</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-ink">
            {counts ? Object.entries(counts).map(([key, value]) => <li key={key}>{key}: {value}</li>) : null}
          </ul>
          <label className="mt-3 block text-sm text-muted">Nhập <span className="font-mono">RESET</span> để xác nhận
            <input className="ui-input mt-1 w-full" value={typed} onChange={(event) => setTyped(event.target.value)} />
          </label>
          {error ? <p role="alert" className="ui-state ui-state--error mt-2">{error}</p> : null}
          <div className="mt-3 flex gap-2">
            <button type="button" className="ui-button ui-button--danger" onClick={() => void confirm()} disabled={busy || typed.trim().toUpperCase() !== 'RESET'}>Xác nhận đặt lại</button>
            <button type="button" className="ui-button ui-button--secondary" onClick={() => setOpen(false)} disabled={busy}>Hủy</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
