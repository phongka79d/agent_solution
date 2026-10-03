import { notFound } from 'next/navigation';
import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { AiTeamSkillsPanel } from '../../../../../components/company/AiTeamSkillsPanel';
import { isAiTeamDomain } from '../../domain-param';

export const metadata = { title: 'Kỹ năng AI Team | AgentOS' };

export default function AiTeamSkillsPage({ params }: { readonly params: { readonly domain: string } }) {
  if (!isAiTeamDomain(params.domain)) notFound();
  return (
    <RequirePermission permission="telemetry:read">
      <AiTeamSkillsPanel domain={params.domain} />
    </RequirePermission>
  );
}
