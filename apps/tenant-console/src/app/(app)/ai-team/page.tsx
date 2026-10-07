import { RequirePermission } from '../../../components/auth/RequirePermission';
import { AiTeamConsole } from '../../../components/ai-team/AiTeamConsole';

export const metadata = { title: 'AI Team | AgentOS' };

export default function AiTeamPage() {
  return <RequirePermission permission="telemetry:read"><AiTeamConsole /></RequirePermission>;
}
