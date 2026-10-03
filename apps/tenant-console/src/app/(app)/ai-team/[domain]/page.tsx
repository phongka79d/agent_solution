import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { AiTeamDomainOverview } from '../../../../components/company/AiTeamDomain';
import { isAiTeamDomain } from '../domain-param';
import { notFound } from 'next/navigation';

export const metadata = { title: 'AI Team | AgentOS' };

export default function AiTeamDomainOverviewPage({ params }: { readonly params: { readonly domain: string } }) {
  if (!isAiTeamDomain(params.domain)) notFound();
  return (
    <RequirePermission permission="telemetry:read">
      <AiTeamDomainOverview domain={params.domain} />
    </RequirePermission>
  );
}
