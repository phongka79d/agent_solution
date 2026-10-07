import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { AiTeamConsole } from '../../../../components/ai-team/AiTeamConsole';

export const metadata = { title: 'Sales AI Team | AgentOS' };

export default function SalesAiTeamPage() {
  return <RequirePermission permission="telemetry:read"><AiTeamConsole domain="sales" /></RequirePermission>;
}
