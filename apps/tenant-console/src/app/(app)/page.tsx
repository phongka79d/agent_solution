import { Suspense } from 'react';
import { CompanyOverview } from '../../components/company/CompanyOverview';

export const metadata = {
  title: 'Company Overview | AgentOS',
  description: 'Tenant-scoped observed work and capability boundaries.',
};

export default function RootPage() {
  return (
    <Suspense fallback={<div className="state-panel" aria-busy="true" aria-label="Loading company overview"><div className="h-3 w-40 animate-pulse rounded bg-brand-soft" /><div className="mt-3 h-3 max-w-xl animate-pulse rounded bg-surface-raised" /></div>}>
      <CompanyOverview />
    </Suspense>
  );
}
