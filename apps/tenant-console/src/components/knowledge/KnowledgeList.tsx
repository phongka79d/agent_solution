'use client';

import { t } from '@agentos/ui-foundation/i18n';
import { StatusBadge } from '@agentos/ui-foundation/react';
import {
  KNOWLEDGE_NAMESPACES,
  KNOWLEDGE_STATUSES,
  namespaceLabel,
  statusBadge,
  statusLabel,
  typeLabel,
  type KnowledgeDocument,
} from './types';

interface KnowledgeListProps {
  readonly items: readonly KnowledgeDocument[];
  readonly selectedId: string | null;
  readonly onSelect: (document: KnowledgeDocument) => void;
  readonly onEdit: (document: KnowledgeDocument) => void;
  readonly onReview: (document: KnowledgeDocument) => void;
  readonly onArchive: (document: KnowledgeDocument) => void;
  readonly onRetry?: (() => void) | undefined;
  readonly canApprove: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('vi-VN');
}

function usedByLabel(document: KnowledgeDocument): string {
  if (document.status !== 'AVAILABLE') return t('knowledge.used_by_none');
  const agents = document.agents ?? [];
  return agents.length === 0 ? t('knowledge.no_agents') : agents.join(', ');
}

const COLUMNS = [
  'knowledge.column.title',
  'knowledge.column.type',
  'knowledge.column.namespace',
  'knowledge.column.status',
  'knowledge.column.owner',
  'knowledge.column.updated',
  'knowledge.column.used_by',
  'knowledge.column.actions',
] as const;

export function KnowledgeList({
  items,
  selectedId,
  onSelect,
  onEdit,
  onReview,
  onArchive,
  onRetry,
  canApprove,
  isLoading,
  error,
}: KnowledgeListProps) {
  if (isLoading && items.length === 0) {
    return <p aria-busy="true" className="text-sm text-muted">{t('knowledge.loading')}</p>;
  }
  if (error && items.length === 0) {
    return (
      <div role="alert" className="space-y-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
        <p>{error}</p>
        {onRetry ? (
          <button type="button" className="ui-button ui-button--secondary ui-button--sm" onClick={onRetry}>
            {t('knowledge.retry')}
          </button>
        ) : null}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted">
        {t('knowledge.no_filter_match')}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto" tabIndex={0}>
      <table className="ui-data-table w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted">
            {COLUMNS.map((key) => (
              <th key={key} scope="col" className="p-3">{t(key)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((document) => {
            const selected = document.document_id === selectedId;
            return (
              <tr
                key={document.document_id}
                className={selected ? 'bg-primary/5' : undefined}
                data-status={document.status}
              >
                <td className="p-3">
                  <button
                    type="button"
                    className="text-left font-medium text-ink underline-offset-2 hover:underline"
                    onClick={() => onSelect(document)}
                    aria-pressed={selected}
                  >
                    {document.title}
                  </button>
                  <span className="block text-xs text-muted">v{document.version}</span>
                </td>
                <td className="p-3">{typeLabel(document.type)}</td>
                <td className="p-3">{namespaceLabel(document.namespace)}</td>
                <td className="p-3">
                  <StatusBadge code={statusBadge(document.status)} label={statusLabel(document.status)} />
                </td>
                <td className="p-3">{document.created_by}</td>
                <td className="p-3">{formatDate(document.updated_at)}</td>
                <td className="p-3">{usedByLabel(document)}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    {(document.status === 'DRAFT' || document.status === 'APPROVED' || document.status === 'ARCHIVED') && (
                      <button
                        type="button"
                        className="ui-button ui-button--ghost ui-button--sm"
                        onClick={() => onEdit(document)}
                      >
                        {t('knowledge.edit')}
                      </button>
                    )}
                    {document.status === 'REVIEW' && (
                      <button
                        type="button"
                        className="ui-button ui-button--secondary ui-button--sm"
                        onClick={() => onReview(document)}
                      >
                        {t('knowledge.review')}
                      </button>
                    )}
                    {document.status !== 'ARCHIVED' && (
                      <button
                        type="button"
                        className="ui-button ui-button--ghost ui-button--sm"
                        onClick={() => onArchive(document)}
                      >
                        {t('knowledge.archive')}
                      </button>
                    )}
                    {canApprove && document.status === 'REVIEW' ? (
                      <button
                        type="button"
                        className="ui-button ui-button--primary ui-button--sm"
                        onClick={() => onReview(document)}
                      >
                        {t('knowledge.approve')}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function KnowledgeFilters({
  namespace,
  status,
  onNamespace,
  onStatus,
}: {
  readonly namespace: string;
  readonly status: string;
  readonly onNamespace: (value: string) => void;
  readonly onStatus: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="text-sm">
        <span className="block text-xs uppercase text-muted">{t('knowledge.filter.namespace')}</span>
        <select
          className="ui-input ui-select ui-focus-ring mt-1"
          value={namespace}
          onChange={(event) => onNamespace(event.target.value)}
        >
          <option value="">{t('knowledge.filter.all')}</option>
          {KNOWLEDGE_NAMESPACES.map((value) => (
            <option key={value} value={value}>{namespaceLabel(value)}</option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="block text-xs uppercase text-muted">{t('knowledge.filter.status')}</span>
        <select
          className="ui-input ui-select ui-focus-ring mt-1"
          value={status}
          onChange={(event) => onStatus(event.target.value)}
        >
          <option value="">{t('knowledge.filter.all')}</option>
          {KNOWLEDGE_STATUSES.map((value) => (
            <option key={value} value={value}>{statusLabel(value)}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
