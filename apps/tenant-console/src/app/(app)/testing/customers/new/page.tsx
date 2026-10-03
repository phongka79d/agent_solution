import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { TestCustomerForm } from '../../../../../components/testing/TestCustomerForm';

export const metadata = { title: 'Tạo khách hàng thử | AgentOS', description: 'Tạo khách hàng TEST.' };

export default function NewTestCustomerPage() {
  return (
    <RequirePermission permission="testdata:manage">
      <TestCustomerForm />
    </RequirePermission>
  );
}
