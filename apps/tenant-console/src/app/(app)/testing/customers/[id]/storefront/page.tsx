import { RequirePermission } from '../../../../../../components/auth/RequirePermission';
import { StorefrontLauncher } from '../../../../../../components/testing/StorefrontLauncher';

export const metadata = { title: 'Storefront thử nghiệm | AgentOS', description: 'Khởi chạy Storefront cho khách hàng TEST.' };

export default async function TestCustomerStorefrontPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="testdata:manage">
      <StorefrontLauncher customerId={id} />
    </RequirePermission>
  );
}
