import { notFound } from 'next/navigation';
import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { AiTeamTry } from '../../../../../components/company/AiTeamDomain';
import { isAiTeamDomain } from '../../domain-param';

export const metadata = { title: 'Thử nghiệm AI Team | AgentOS' };

export default function AiTeamTryPage({ params }: { readonly params: { readonly domain: string } }) {
  if (!isAiTeamDomain(params.domain)) notFound();
  return (
    <RequirePermission permission="telemetry:read">
      <AiTeamTry domain={params.domain} />
    </RequirePermission>
  );
}
