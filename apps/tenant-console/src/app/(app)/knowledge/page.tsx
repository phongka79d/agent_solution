'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { EmptyState, PageHeader } from '@agentos/ui-foundation/react';
import { can } from '@agentos/ui-foundation/auth';
import { RequirePermission } from '../../../components/auth/RequirePermission';
import { useSession } from '../../../components/auth/SessionProvider';
import { KnowledgeEditor } from '../../../components/knowledge/KnowledgeEditor';
import { KnowledgeFilters, KnowledgeList } from '../../../components/knowledge/KnowledgeList';
import { KnowledgeReviewDrawer } from '../../../components/knowledge/KnowledgeReviewDrawer';
import {
  KNOWLEDGE_TEMPLATES,
  knowledgeRequest,
  type KnowledgeDocument,
  type KnowledgeUsage,
} from '../../../components/knowledge/types';

interface ListResponse {
  readonly items?: readonly KnowledgeDocument[];
  readonly next_cursor?: string | null;
}

function KnowledgeContent() {
  const session = useSession();
  const canApprove = can(session, 'knowledge:approve');

  const [items, setItems] = useState<readonly KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [namespace, setNamespace] = useState('');
  const [status, setStatus] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeDocument | null>(null);
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const [reviewing, setReviewing] = useState<KnowledgeDocument | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (namespace.length > 0) params.set('namespace', namespace);
      if (status.length > 0) params.set('status', status);
      const payload = await knowledgeRequest<ListResponse>(`/api/v1/knowledge/documents?${params.toString()}`);
      const rows = Array.isArray(payload.items) ? payload.items : [];
      setItems(rows);
      const available = rows.filter((row) => row.status === 'AVAILABLE');
      const usage = await Promise.all(available.map(async (row) => {
        try {
          return await knowledgeRequest<KnowledgeUsage>(`/api/v1/knowledge/documents/${row.document_id}/usage`);
        } catch {
          return null;
        }
      }));
      const byId = new Map(available.map((row, index) => [row.document_id, usage[index]?.agents ?? []]));
      setItems(rows.map((row) => (byId.has(row.document_id) ? { ...row, agents: byId.get(row.document_id) } : row)));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('knowledge.load_error'));
    } finally {
      setLoading(false);
    }
  }, [namespace, status]);

  useEffect(() => { void load(); }, [load]);

  // APPROVED is transient: the indexer makes the document AVAILABLE within seconds. Refresh until
  // it settles so the page never shows a stale "Đã duyệt" for a document the AI already uses.
  const awaitingIndex = items.some((row) => row.status === 'APPROVED');
  useEffect(() => {
    if (!awaitingIndex) return undefined;
    const timer = setTimeout(() => { void load(); }, 3_000);
    return () => clearTimeout(timer);
  }, [awaitingIndex, items, load]);

  function openCreate(template: string | undefined): void {
    setEditing(null);
    setTemplateId(template);
    setEditorOpen(true);
  }

  async function archive(document: KnowledgeDocument): Promise<void> {
    try {
      await knowledgeRequest(`/api/v1/knowledge/documents/${document.document_id}/archive`, { method: 'POST' });
      await load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('knowledge.action_error'));
    }
  }

  const hasFilters = namespace.length > 0 || status.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('knowledge.eyebrow')}
        title={t('knowledge.title')}
        description={t('knowledge.description')}
        actions={(
          <button type="button" className="ui-button ui-button--primary" onClick={() => openCreate(undefined)}>
            {t('knowledge.add')}
          </button>
        )}
      />
      <KnowledgeFilters
        namespace={namespace}
        status={status}
        onNamespace={setNamespace}
        onStatus={setStatus}
      />
      {error && items.length > 0 ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      ) : null}
      {items.length === 0 && !loading && !hasFilters ? (
        <EmptyState
          status="NO_DATA"
          title={t('knowledge.empty_title')}
          description={t('knowledge.empty_description')}
          action={(
            <div className="flex flex-wrap gap-2">
              {KNOWLEDGE_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="ui-button ui-button--secondary ui-button--sm"
                  onClick={() => openCreate(template.id)}
                >
                  {template.label}
                </button>
              ))}
            </div>
          )}
        />
      ) : (
        <KnowledgeList
          items={items}
          selectedId={reviewing?.document_id ?? null}
          canApprove={canApprove}
          isLoading={loading}
          error={error}
          onRetry={() => void load()}
          onSelect={(document) => { setReviewing(document); setReviewOpen(true); }}
          onEdit={(document) => { setEditing(document); setTemplateId(undefined); setEditorOpen(true); }}
          onReview={(document) => { setReviewing(document); setReviewOpen(true); }}
          onArchive={(document) => void archive(document)}
        />
      )}
      <KnowledgeEditor
        open={editorOpen}
        document={editing}
        templateId={templateId}
        onClose={() => setEditorOpen(false)}
        onSaved={() => { setEditorOpen(false); void load(); }}
      />
      <KnowledgeReviewDrawer
        open={reviewOpen}
        document={reviewing}
        canApprove={canApprove}
        canManage
        onClose={() => setReviewOpen(false)}
        onDecided={() => { setReviewOpen(false); void load(); }}
      />
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <RequirePermission permission="knowledge:manage">
      <KnowledgeContent />
    </RequirePermission>
  );
}
