import { RequirePermission } from '../../../components/auth/RequirePermission';
import { ExecutiveDashboard } from '../../../components/executive/ExecutiveDashboard';

export const metadata = {
  title: 'Executive Telemetry & Indicators | AgentOS',
  description: 'Tenant-scoped real-time indicators, revenue attribution streaming, and operational anomaly feed.',
};

export default function AnalyticsRoute() {
  return (
    <RequirePermission permission="telemetry:read">
      <ExecutiveDashboard />
    </RequirePermission>
  );
}
