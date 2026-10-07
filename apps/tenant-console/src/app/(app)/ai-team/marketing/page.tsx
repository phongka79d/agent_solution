import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { AiTeamConsole } from '../../../../components/ai-team/AiTeamConsole';

export const metadata = { title: 'Marketing AI Team | AgentOS' };

export default function MarketingAiTeamPage() {
  return <RequirePermission permission="telemetry:read"><AiTeamConsole domain="marketing" /></RequirePermission>;
}
