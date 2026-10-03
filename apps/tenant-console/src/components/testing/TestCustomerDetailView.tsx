'use client';

import { useCallback, useEffect, useState } from 'react';
import { DataClassBadge, LoadingState, PageHeader } from '@agentos/ui-foundation/react';
import {
  deleteTestCustomer,
  getTestCustomer,
  TestLabError,
  testCustomerConsent,
  testCustomerEvent,
  testCustomerHandoffRequest,
  testCustomerOrder,
  testCustomerSupportRequest,
  type TestCustomerDetail,
} from '../../lib/testing/test-lab-client';

export function TestCustomerDetailView({ customerId }: { readonly customerId: string }) {
  const [customer, setCustomer] = useState<TestCustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setCustomer(await getTestCustomer(customerId));
    } catch (reason: unknown) {
      setError(reason instanceof TestLabError ? `Không tải được khách hàng thử (${reason.errorCode}).` : 'Không tải được khách hàng thử.');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, message: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (reason: unknown) {
      setError(reason instanceof TestLabError ? `Thao tác thất bại (${reason.errorCode}).` : 'Thao tác thất bại.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Đang tải khách hàng thử…" />;
  if (!customer) return <p role="alert" className="ui-state ui-state--error">{error ?? 'Không tìm thấy khách hàng thử.'}</p>;

  return (
    <div className="space-y-4">
      <PageHeader title={customer.display_name ?? 'Khách hàng thử'} description="Khách hàng thuộc phòng thử nghiệm (TEST)." />
      <div className="flex flex-wrap items-center gap-2">
        <DataClassBadge code={customer.data_class} />
        <a className="ui-button ui-button--secondary" href={`/customers/${encodeURIComponent(customer.id)}`}>Mở Customer360</a>
        <a className="ui-button ui-button--secondary" href={`/testing/customers/${encodeURIComponent(customer.id)}/storefront`}>Khởi chạy Storefront</a>
      </div>
      {notice ? <p role="status" className="ui-state ui-state--success">{notice}</p> : null}
      {error ? <p role="alert" className="ui-state ui-state--error">{error}</p> : null}
      <section aria-label="Thao tác nhanh" className="ui-section-card p-4">
        <h2 className="font-semibold text-ink">Thao tác nhanh</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerEvent(customer.id, { event_name: 'marketing_signal', channel: 'web', payload: { signal: 'manual_test' } }), 'Đã gửi tín hiệu Marketing.')}>Gửi tín hiệu Marketing</button>
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerEvent(customer.id, { event_name: 'product_view', channel: 'web' }), 'Đã tạo sự kiện xem sản phẩm.')}>Tạo sự kiện xem sản phẩm</button>
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerEvent(customer.id, { event_name: 'cart_add', channel: 'web' }), 'Đã tạo sự kiện giỏ hàng.')}>Tạo sự kiện giỏ hàng</button>
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerEvent(customer.id, { event_name: 'purchase', channel: 'web' }), 'Đã tạo sự kiện mua hàng.')}>Tạo sự kiện mua hàng</button>
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerOrder(customer.id, { total_amount: 250000, currency: 'VND', status: 'paid' }), 'Đã tạo đơn hàng mẫu.')}>Tạo đơn hàng mẫu</button>
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerSupportRequest(customer.id, { subject: 'Yêu cầu hỗ trợ thử nghiệm', priority: 'P3' }), 'Đã tạo yêu cầu hỗ trợ.')}>Tạo yêu cầu hỗ trợ</button>
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerHandoffRequest(customer.id, { escalation_reason: 'Cần nhân viên hỗ trợ', channel: 'web' }), 'Đã yêu cầu nhân viên.')}>Yêu cầu nhân viên</button>
          <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void run(() => testCustomerConsent(customer.id, { consent_type: 'marketing_messaging', channel: 'email', is_granted: false }), 'Đã thu hồi đồng ý Email.')}>Thu hồi đồng ý Email</button>
          <button type="button" className="ui-button ui-button--danger" disabled={busy} onClick={() => { if (window.confirm('Xóa khách hàng thử này?')) void run(() => deleteTestCustomer(customer.id), 'Đã xóa khách hàng thử.'); }}>Xóa khách hàng thử</button>
        </div>
      </section>
      <section aria-label="Chi tiết khách hàng thử" className="ui-section-card p-4 text-sm">
        <p className="text-muted">Email: <span className="text-ink">{customer.primary_email ?? '—'}</span></p>
        <p className="text-muted">Điện thoại: <span className="text-ink">{customer.primary_phone ?? '—'}</span></p>
        <p className="text-muted">Đồng ý: <span className="text-ink">{customer.consents.map((consent) => `${consent.consent_type}=${consent.is_granted ? 'granted' : 'denied'}`).join(', ') || '—'}</span></p>
        <p className="text-muted">Đơn hàng: <span className="text-ink">{customer.orders.length}</span></p>
        <p className="text-muted">Sự kiện: <span className="text-ink">{customer.events.length}</span></p>
        <p className="text-muted">Hỗ trợ: <span className="text-ink">{customer.service_cases.length}</span></p>
      </section>
    </div>
  );
}
