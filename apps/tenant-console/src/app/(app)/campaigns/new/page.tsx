'use client';

import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { CampaignWizard } from '../../../../components/campaigns/CampaignWizard';

export default function NewCampaignPage() {
  return (
    <RequirePermission permission="campaign:draft">
      <CampaignWizard />
    </RequirePermission>
  );
}
