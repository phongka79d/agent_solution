'use client';

import { PageHeader } from '@agentos/ui-foundation/react';
import { RequirePermission } from '../../../components/auth/RequirePermission';
import { ApprovalCenter } from '../../../components/approvals/ApprovalCenter';

export default function ApprovalsPage() {
  return (
    <RequirePermission permission="approval:read">
      <main className="space-y-6" aria-label="Danh sách phê duyệt">
        <PageHeader title="Phê duyệt" description="Xem xét các đề xuất trước khi chúng có thể tạo tác động." />
        <ApprovalCenter />
      </main>
    </RequirePermission>
  );
}
