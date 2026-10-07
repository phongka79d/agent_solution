import { RequirePermission } from '../../../components/auth/RequirePermission';
import { CustomerList } from '../../../components/customer/CustomerList';

export const metadata = { title: 'Khách hàng | AgentOS', description: 'Hồ sơ khách hàng.' };

export default function CustomersPage() {
  return (
    <RequirePermission permission="customer:read">
      <CustomerList />
    </RequirePermission>
  );
}
