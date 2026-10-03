'use client';

import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { RunStoryDetail } from '../../../../components/runs/RunStoryDetail';

export default function RunStoryPage({ params }: { readonly params: { readonly runId: string } }) {
  return (
    <RequirePermission permission="run:read">
      <RunStoryDetail runId={params.runId} />
    </RequirePermission>
  );
}
