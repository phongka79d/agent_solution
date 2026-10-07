'use client';

import { useEffect, useState } from 'react';
import { EmptyState, LoadingState, PageHeader } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

type Customer = { readonly id: string; readonly name: string; readonly detail: string | null };

function customer(value: unknown): Customer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.customer_id === 'string' ? item.customer_id : typeof item.id === 'string' ? item.id : null;
  if (!id) return null;
  const nested = item.profile && typeof item.profile === 'object' && !Array.isArray(item.profile) ? item.profile as Record<string, unknown> : {};
  return { id, name: typeof item.name === 'string' ? item.name : typeof nested.name === 'string' ? nested.name : 'Khách hàng', detail: typeof item.email === 'string' ? item.email : typeof item.phone === 'string' ? item.phone : null };
}

export function CustomerList() {
  const [items, setItems] = useState<Customer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(append = false): Promise<void> {
    if (append) setMore(true); else setLoading(true);
    setError(null);
    try {
      const payload = await tenantConsoleClient.getCustomers({ limit: 50, ...(append && cursor ? { cursor } : {}) });
      const next = (Array.isArray(payload.items) ? payload.items : []).map(customer).filter((value): value is Customer => value !== null);
      setItems((previous) => append ? [...previous, ...next.filter((item) => !previous.some((old) => old.id === item.id))] : next);
      const nextCursor = payload.next_cursor ?? payload.nextCursor;
      setCursor(typeof nextCursor === 'string' && nextCursor ? nextCursor : null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Không thể tải danh sách khách hàng.');
    } finally { setLoading(false); setMore(false); }
  }

  useEffect(() => { void load(); }, []);
  if (loading) return <LoadingState label="Đang tải khách hàng…" />;
  return (
    <div className="space-y-8">
      <PageHeader title="Khách hàng" description="Hồ sơ và hoạt động khách hàng trong không gian làm việc." />
      {error ? <p role="alert" className="ui-state ui-state--error">{error}</p> : null}
      {items.length === 0 ? (
        <EmptyState title="Chưa có dữ liệu" />
      ) : (
        <section className="ui-section-card p-5" aria-label="Danh sách khách hàng">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-md border border-line bg-surface p-4 transition-shadow hover:shadow-sm">
                <a className="block ui-focus-ring rounded-sm" href={`/customers/${encodeURIComponent(item.id)}`}>
                  <h2 className="font-medium text-ink">{item.name}</h2>
                  {item.detail ? <p className="mt-1 text-sm text-muted">{item.detail}</p> : null}
                </a>
              </li>
            ))}
          </ul>
          {cursor ? <button type="button" className="ui-button ui-button--secondary mt-4" onClick={() => void load(true)} disabled={more}>{more ? 'Đang tải…' : 'Xem thêm'}</button> : null}
        </section>
      )}
    </div>
  );
}
