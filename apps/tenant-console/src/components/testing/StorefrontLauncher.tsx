'use client';

import { useEffect, useState } from 'react';
import { LoadingState, PageHeader } from '@agentos/ui-foundation/react';
import { SalesTryChat } from './SalesTryChat';
import { getTestCustomer, TestLabError } from '../../lib/testing/test-lab-client';

/** Storefront preview bound to one TEST customer; the widget bearer stays server-side (T7.4). */
export function StorefrontLauncher({ customerId }: { readonly customerId: string }) {
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const customer = await getTestCustomer(customerId);
        setLabel(customer.display_name ?? 'Khách hàng thử');
      } catch (reason: unknown) {
        setError(reason instanceof TestLabError ? `Không tải được khách hàng (${reason.errorCode}).` : 'Không tải được khách hàng.');
      }
    })();
  }, [customerId]);

  if (error) return <p role="alert" className="ui-state ui-state--error">{error}</p>;
  if (label === null) return <LoadingState label="Đang chuẩn bị Storefront…" />;

  return (
    <div className="space-y-4">
      <PageHeader title="Storefront thử nghiệm" description={`Phiên khách hàng: ${label} (TEST)`} />
      <p className="text-sm text-muted">Phiên được cấp phía máy chủ cho đúng khách hàng TEST này; trình duyệt không giữ token.</p>
      <SalesTryChat customerId={customerId} customerLabel={label} />
    </div>
  );
}
