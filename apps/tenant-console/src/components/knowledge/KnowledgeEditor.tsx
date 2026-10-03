'use client';

import { useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { Button, Drawer, Field, Input, Select } from '@agentos/ui-foundation/react';
import {
  KNOWLEDGE_NAMESPACES,
  KNOWLEDGE_TEMPLATES,
  KNOWLEDGE_TYPES,
  knowledgeRequest,
  namespaceLabel,
  slugify,
  templateById,
  typeLabel,
  type KnowledgeDocument,
  type KnowledgeNamespace,
  type KnowledgeType,
} from './types';

interface KnowledgeEditorProps {
  /** Editing an existing document when non-null; otherwise creating a new draft. */
  readonly document: KnowledgeDocument | null;
  readonly open: boolean;
  /** Optional template preselected when creating a new document. */
  readonly templateId?: string | undefined;
  readonly onClose: () => void;
  readonly onSaved: (document: KnowledgeDocument, submitted: boolean) => void;
}

interface EditorState {
  readonly namespace: KnowledgeNamespace;
  readonly type: KnowledgeType;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
}

const EMPTY_STATE: EditorState = {
  namespace: 'company',
  type: 'FAQ',
  slug: '',
  title: '',
  body: '',
};

function initialise(document: KnowledgeDocument | null, templateId?: string): EditorState {
  if (document === null) {
    const template = templateId === undefined ? undefined : templateById(templateId);
    if (template === undefined) return EMPTY_STATE;
    return {
      namespace: template.namespace,
      type: template.type,
      slug: slugify(template.title),
      title: template.title,
      body: template.body,
    };
  }
  return {
    namespace: document.namespace,
    type: document.type,
    slug: document.slug,
    title: document.title,
    body: document.body,
  };
}

export function KnowledgeEditor({ document, open, templateId, onClose, onSaved }: KnowledgeEditorProps) {
  const [state, setState] = useState<EditorState>(() => initialise(document, templateId));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);

  useEffect(() => {
    if (open) {
      setState(initialise(document, templateId));
      setError(null);
      setSaving(null);
    }
  }, [open, document, templateId]);

  function applyTemplate(id: string): void {
    const template = templateById(id);
    if (template === undefined) return;
    setState({
      namespace: template.namespace,
      type: template.type,
      slug: slugify(template.title),
      title: template.title,
      body: template.body,
    });
  }

  async function persist(submit: boolean): Promise<void> {
    const title = state.title.trim();
    const body = state.body;
    if (title.length === 0) {
      setError(t('knowledge.title_required'));
      return;
    }
    const slug = state.slug.trim() || slugify(title) || 'tai-lieu';
    setSaving(submit ? 'submit' : 'draft');
    setError(null);
    try {
      const payload = { namespace: state.namespace, type: state.type, slug, title, body };
      const saved = document === null
        ? await knowledgeRequest<KnowledgeDocument>('/api/v1/knowledge/documents', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
        : await knowledgeRequest<KnowledgeDocument>(`/api/v1/knowledge/documents/${document.document_id}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
          });
      if (submit) {
        const submitted = await knowledgeRequest<KnowledgeDocument>(
          `/api/v1/knowledge/documents/${saved.document_id}/submit`,
          { method: 'POST' },
        );
        onSaved(submitted, true);
      } else {
        onSaved(saved, false);
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('knowledge.save_error'));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={document === null ? t('knowledge.create_title') : t('knowledge.edit_title')}
      description={t('knowledge.editor_hint')}
      className="ui-drawer__panel--wide"
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving !== null}>{t('knowledge.cancel')}</Button>
          <Button variant="ghost" loading={saving === 'draft'} onClick={() => void persist(false)}>
            {t('knowledge.save_draft')}
          </Button>
          <Button variant="primary" loading={saving === 'submit'} onClick={() => void persist(true)}>
            {t('knowledge.submit')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {document === null ? (
          <Field label={t('knowledge.field.template')} hint={t('knowledge.field.template_hint')}>
            <Select defaultValue="" onChange={(event) => applyTemplate(event.target.value)}>
              <option value="" disabled>{t('knowledge.field.template_choose')}</option>
              {KNOWLEDGE_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>{template.label}</option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label={t('knowledge.field.title')}>
          <Input
            value={state.title}
            onChange={(event) => setState((prev) => ({ ...prev, title: event.target.value }))}
            placeholder={t('knowledge.title_placeholder')}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('knowledge.field.namespace')}>
            <Select
              value={state.namespace}
              onChange={(event) => setState((prev) => ({ ...prev, namespace: event.target.value as KnowledgeNamespace }))}
            >
              {KNOWLEDGE_NAMESPACES.map((value) => (
                <option key={value} value={value}>{namespaceLabel(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('knowledge.field.type')}>
            <Select
              value={state.type}
              onChange={(event) => setState((prev) => ({ ...prev, type: event.target.value as KnowledgeType }))}
            >
              {KNOWLEDGE_TYPES.map((value) => (
                <option key={value} value={value}>{typeLabel(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('knowledge.field.slug')} hint={t('knowledge.field.slug_hint')}>
            <Input
              value={state.slug}
              onChange={(event) => setState((prev) => ({ ...prev, slug: event.target.value }))}
              placeholder={t('knowledge.slug_placeholder')}
            />
          </Field>
        </div>
        <Field label={t('knowledge.field.body')}>
          <textarea
            className="ui-input ui-focus-ring min-h-[18rem] font-mono text-sm"
            value={state.body}
            aria-label={t('knowledge.field.body')}
            onChange={(event) => setState((prev) => ({ ...prev, body: event.target.value }))}
          />
        </Field>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      </div>
    </Drawer>
  );
}
