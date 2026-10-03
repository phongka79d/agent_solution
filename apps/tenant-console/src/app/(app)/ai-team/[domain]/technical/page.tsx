import { notFound } from 'next/navigation';
import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { AiTeamTechnicalPanel } from '../../../../../components/company/AiTeamDomain';
import { isAiTeamDomain } from '../../domain-param';

export const metadata = { title: 'Chi tiết AI Team | AgentOS' };

export default function AiTeamTechnicalPage({ params }: { readonly params: { readonly domain: string } }) {
  if (!isAiTeamDomain(params.domain)) notFound();
  return (
    <RequirePermission permission="telemetry:read">
      <AiTeamTechnicalPanel domain={params.domain} />
    </RequirePermission>
  );
}
