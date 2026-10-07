import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { Customer360Profile } from '../../../../components/customer/Customer360Profile';

export const metadata = { title: 'Hồ sơ khách hàng | AgentOS', description: 'Customer 360.' };

export default function CustomerDetailPage({ params }: { readonly params: { readonly id: string } }) {
  return (
    <RequirePermission permission="customer:read">
      <Customer360Profile customerId={params.id} />
    </RequirePermission>
  );
}
