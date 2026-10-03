import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { TestCustomerLab } from '../../../../components/testing/TestCustomerLab';

export const metadata = { title: 'Phòng thử nghiệm | AgentOS', description: 'Tạo và quản lý khách hàng TEST.' };

export default function TestingCustomersPage() {
  return (
    <RequirePermission permission="testdata:manage">
      <TestCustomerLab />
    </RequirePermission>
  );
}
