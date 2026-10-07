import { t } from '@agentos/ui-foundation/i18n';
import { EmptyState, PageHeader } from '@agentos/ui-foundation/react';
import { RequirePermission } from '../../../components/auth/RequirePermission';

export const metadata = {
  title: 'Knowledge | AgentOS',
  description: 'Tenant knowledge availability.',
};

function KnowledgeContent() {
  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t('auth.company_workspace')} title={t('knowledge.title')} description={t('knowledge.description')} />
      <EmptyState title={t('knowledge.empty')} description={t('knowledge.description')} status="NOT_INTEGRATED" />
    </div>
  );
}

export default function KnowledgePage() {
  return <RequirePermission permission="telemetry:read"><KnowledgeContent /></RequirePermission>;
}
