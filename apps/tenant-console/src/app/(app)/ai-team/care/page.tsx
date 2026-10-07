import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { AiTeamConsole } from '../../../../components/ai-team/AiTeamConsole';

export const metadata = { title: 'Care AI Team | AgentOS' };

export default function CareAiTeamPage() {
  return <RequirePermission permission="telemetry:read"><AiTeamConsole domain="care" /></RequirePermission>;
}
