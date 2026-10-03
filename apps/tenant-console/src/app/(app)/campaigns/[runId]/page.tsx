'use client';

import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { CampaignDetailView } from '../../../../components/campaigns/CampaignDetailView';

export default function CampaignDetailPage({ params }: { readonly params: { readonly runId: string } }) {
  return (
    <RequirePermission permissions={['campaign:draft', 'approval:read']}>
      <CampaignDetailView runId={params.runId} />
    </RequirePermission>
  );
}
