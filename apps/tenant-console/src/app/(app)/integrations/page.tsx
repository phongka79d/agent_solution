import { RequirePermission } from '../../../components/auth/RequirePermission';
import { IntegrationsPage } from '../../../components/company/IntegrationsPage';

export const metadata = { title: 'Integrations | AgentOS' };

export default function IntegrationsRoute() {
  return <RequirePermission permission="telemetry:read"><IntegrationsPage /></RequirePermission>;
}
