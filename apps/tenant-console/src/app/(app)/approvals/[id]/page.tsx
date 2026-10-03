'use client';

import { PageHeader } from '@agentos/ui-foundation/react';
import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { ApprovalCenter } from '../../../../components/approvals/ApprovalCenter';

export default function ApprovalDetailPage({ params }: { readonly params: { readonly id: string } }) {
  return (
    <RequirePermission permission="approval:read">
      <section className="space-y-6" aria-label="Chi tiết phê duyệt">
        <PageHeader title="Chi tiết phê duyệt" description={`Xem xét đề xuất ${params.id}.`} />
        <ApprovalCenter initialApprovalId={params.id} />
      </section>
    </RequirePermission>
  );
}
