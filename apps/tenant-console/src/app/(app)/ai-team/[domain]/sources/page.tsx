import { notFound } from 'next/navigation';
import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { AiTeamSources } from '../../../../../components/company/AiTeamDomain';
import { isAiTeamDomain } from '../../domain-param';

export const metadata = { title: 'Nguồn dữ liệu AI Team | AgentOS' };

export default function AiTeamSourcesPage({ params }: { readonly params: { readonly domain: string } }) {
  if (!isAiTeamDomain(params.domain)) notFound();
  return (
    <RequirePermission permission="telemetry:read">
      <AiTeamSources domain={params.domain} />
    </RequirePermission>
  );
}
