import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { AiTeamTabs } from '../../../../components/company/AiTeamDomain';
import { isAiTeamDomain } from '../domain-param';

export const metadata = { title: 'AI Team | AgentOS' };

export default function AiTeamDomainLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: { readonly domain: string };
}) {
  if (!isAiTeamDomain(params.domain)) notFound();
  return (
    <div className="space-y-6">
      <AiTeamTabs domain={params.domain} />
      {children}
    </div>
  );
}
