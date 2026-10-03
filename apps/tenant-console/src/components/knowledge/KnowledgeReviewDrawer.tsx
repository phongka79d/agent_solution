'use client';

import { useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { Button, Drawer } from '@agentos/ui-foundation/react';
import {
  diffLines,
  knowledgeRequest,
  statusLabel,
  typeLabel,
  type KnowledgeDocument,
  type KnowledgeVersion,
} from './types';

interface KnowledgeReviewDrawerProps {
  readonly open: boolean;
  readonly document: KnowledgeDocument | null;
  readonly canApprove: boolean;
  readonly canManage: boolean;
  readonly onClose: () => void;
  readonly onDecided: (document: KnowledgeDocument, action: 'approve' | 'reject') => void;
}

export function KnowledgeReviewDrawer({
  open,
  document,
  canApprove,
  canManage,
  onClose,
  onDecided,
}: KnowledgeReviewDrawerProps) {
  const documentId = document?.document_id ?? null;
  const [versions, setVersions] = useState<readonly KnowledgeVersion[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (!open || documentId === null) return undefined;
    let active = true;
    setReason('');
    setError(null);
    setVersions([]);
    void knowledgeRequest<readonly KnowledgeVersion[]>(`/api/v1/knowledge/documents/${documentId}/versions`)
      .then((rows) => {
        if (active) setVersions(Array.isArray(rows) ? rows : []);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t('knowledge.versions_error'));
      });
    return () => { active = false; };
  }, [open, documentId]);

  async function decide(action: 'approve' | 'reject'): Promise<void> {
    if (document === null) return;
    if (action === 'reject' && reason.trim().length === 0) {
      setError(t('knowledge.reject_reason_required'));
      return;
    }
    setBusy(action);
    setError(null);
    try {
      const body = action === 'reject' ? { reason: reason.trim() } : undefined;
      const updated = await knowledgeRequest<KnowledgeDocument>(
        `/api/v1/knowledge/documents/${document.document_id}/${action}`,
        { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      );
      onDecided(updated, action);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('knowledge.action_error'));
    } finally {
      setBusy(null);
    }
  }

  const current = versions.find((version) => version.version === document?.version)
    ?? versions[versions.length - 1];
  const previous = versions
    .filter((version) => version.version < (current?.version ?? 0))
    .sort((a, b) => b.version - a.version)[0];
  const rows = current === undefined ? [] : diffLines(previous?.body ?? '', current.body);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={document?.title ?? t('knowledge.review')}
      {...(document === null ? {} : { description: `${typeLabel(document.type)} · ${statusLabel(document.status)} · v${document.version}` })}
      className="ui-drawer__panel--wide"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy !== null}>{t('knowledge.close')}</Button>
          {canManage ? (
            <Button variant="danger" loading={busy === 'reject'} onClick={() => void decide('reject')}>
              {t('knowledge.reject')}
            </Button>
          ) : null}
          {canApprove ? (
            <Button variant="primary" loading={busy === 'approve'} onClick={() => void decide('approve')}>
              {t('knowledge.approve')}
            </Button>
          ) : null}
        </>
      )}
    >
      <div className="space-y-4">
        {canManage ? (
          <label className="block text-sm">
            <span className="block text-xs uppercase text-muted">{t('knowledge.reject_reason_hint')}</span>
            <textarea
              className="ui-input ui-focus-ring mt-1 min-h-[4rem]"
              value={reason}
              aria-label={t('knowledge.reject_reason')}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        ) : null}
        <div>
          <h3 className="text-sm font-semibold text-ink">{t('knowledge.diff_title')}</h3>
          {previous === undefined ? (
            <p className="mt-2 text-sm text-muted">{t('knowledge.diff_first_version')}</p>
          ) : null}
          <pre className="mt-2 max-h-[28rem] overflow-auto rounded-lg border border-line bg-surface p-3 text-xs leading-5">
            <code>
              {rows.map((row, index) => (
                <span
                  key={`${index}-${row.kind}`}
                  className={
                    row.kind === 'add'
                      ? 'block bg-success/10 text-success'
                      : row.kind === 'remove'
                        ? 'block bg-danger/10 text-danger'
                        : 'block text-muted'
                  }
                >
                  {row.kind === 'add' ? '+ ' : row.kind === 'remove' ? '- ' : '  '}
                  {row.value}
                </span>
              ))}
            </code>
          </pre>
        </div>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      </div>
    </Drawer>
  );
}
