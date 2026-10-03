import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { TestCustomerDetailView } from '../../../../../components/testing/TestCustomerDetailView';

export const metadata = { title: 'Khách hàng thử | AgentOS', description: 'Thao tác khách hàng TEST.' };

export default async function TestCustomerDetailPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="testdata:manage">
      <TestCustomerDetailView customerId={id} />
    </RequirePermission>
  );
}
