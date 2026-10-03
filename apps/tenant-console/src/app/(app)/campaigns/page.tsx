'use client';

import { RequirePermission } from '../../../components/auth/RequirePermission';
import { CampaignList } from '../../../components/campaigns/CampaignList';

export default function CampaignsPage() {
  return (
    <RequirePermission permissions={['campaign:draft', 'approval:read']}>
      <CampaignList />
    </RequirePermission>
  );
}
