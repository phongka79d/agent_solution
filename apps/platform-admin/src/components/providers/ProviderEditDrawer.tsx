'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Drawer, Field, Input, Select } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import type { PlatformLlmProvider, ProviderUpsertInput } from '../../lib/platform-client';

export interface ProviderDraft {
  readonly provider_id: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: string;
  readonly structured_mode: 'json_object' | 'json_schema';
  readonly is_default: boolean;
  readonly api_key: string;
}

const EMPTY_DRAFT: ProviderDraft = {
  provider_id: '',
  display_name: '',
  base_url: '',
  reasoning_model: '',
  fast_model: '',
  timeout_ms: '30000',
  structured_mode: 'json_object',
  is_default: false,
  api_key: '',
};

export function draftFromProvider(provider: PlatformLlmProvider): ProviderDraft {
  return {
    provider_id: provider.provider_id,
    display_name: provider.display_name,
    base_url: provider.base_url,
    reasoning_model: provider.reasoning_model,
    fast_model: provider.fast_model,
    timeout_ms: String(provider.timeout_ms),
    structured_mode: provider.structured_mode,
    is_default: provider.is_default,
    api_key: '',
  };
}

/**
 * Non-reversible local preview of a key the operator just typed. It exists so the operator can
 * confirm the value they pasted; stored keys are never fingerprinted or displayed by this console.
 */
export function fingerprintOf(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `#${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export interface ProviderDraftSubmit {
  readonly provider_id: string;
  readonly input: ProviderUpsertInput;
}

export interface ProviderEditDrawerProps {
  readonly open: boolean;
  readonly provider: PlatformLlmProvider | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (submit: ProviderDraftSubmit) => void;
}

export function ProviderEditDrawer({ open, provider, saving, error, onClose, onSubmit }: ProviderEditDrawerProps) {
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(provider === null ? EMPTY_DRAFT : draftFromProvider(provider));
    setValidation(null);
  }, [open, provider]);

  function update<K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const timeoutMs = Number(draft.timeout_ms);
    if (draft.provider_id.trim().length === 0 || draft.display_name.trim().length === 0
      || draft.base_url.trim().length === 0 || draft.reasoning_model.trim().length === 0
      || draft.fast_model.trim().length === 0) {
      setValidation(t('platform.provider_save_failed'));
      return;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      setValidation(t('platform.provider_save_failed'));
      return;
    }
    setValidation(null);
    onSubmit({
      provider_id: draft.provider_id.trim(),
      input: {
        display_name: draft.display_name.trim(),
        base_url: draft.base_url.trim(),
        reasoning_model: draft.reasoning_model.trim(),
        fast_model: draft.fast_model.trim(),
        timeout_ms: timeoutMs,
        structured_mode: draft.structured_mode,
        is_default: draft.is_default,
        ...(draft.api_key.length > 0 ? { api_key: draft.api_key } : {}),
      },
    });
  }

  const editing = provider !== null;
  const message = validation ?? error;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? t('platform.edit_provider') : t('platform.add_provider')}
      description={t('platform.providers_description')}
      actions={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>{t('platform.cancel')}</Button>
          <Button type="submit" form="provider-edit-form" loading={saving}>{t('platform.save')}</Button>
        </>
      }
    >
      <form id="provider-edit-form" className="space-y-4" onSubmit={submit}>
        {!editing ? (
          <Field label={t('platform.provider_id')} hint="a-zA-Z0-9._-">
            <Input
              value={draft.provider_id}
              onChange={(event) => update('provider_id', event.target.value)}
              autoComplete="off"
              required
            />
          </Field>
        ) : (
          <Field label={t('platform.provider_id')}>
            <Input value={draft.provider_id} readOnly disabled />
          </Field>
        )}
        <Field label={t('platform.provider_display_name')}>
          <Input value={draft.display_name} onChange={(event) => update('display_name', event.target.value)} required />
        </Field>
        <Field label={t('platform.base_url')} hint={t('platform.providers_description')}>
          <Input value={draft.base_url} onChange={(event) => update('base_url', event.target.value)} required />
        </Field>
        <Field label={t('platform.reasoning_model')}>
          <Input value={draft.reasoning_model} onChange={(event) => update('reasoning_model', event.target.value)} required />
        </Field>
        <Field label={t('platform.fast_model')}>
          <Input value={draft.fast_model} onChange={(event) => update('fast_model', event.target.value)} required />
        </Field>
        <Field label={t('platform.timeout_ms')}>
          <Input
            type="number"
            min={1000}
            max={120000}
            step={1000}
            value={draft.timeout_ms}
            onChange={(event) => update('timeout_ms', event.target.value)}
            required
          />
        </Field>
        <Field label={t('platform.structured_mode')}>
          <Select
            value={draft.structured_mode}
            options={[
              { value: 'json_object', label: t('platform.structured_json_object') },
              { value: 'json_schema', label: t('platform.structured_json_schema') },
            ]}
            onChange={(event) => update('structured_mode', event.target.value as ProviderDraft['structured_mode'])}
          />
        </Field>
        <Field
          label={t('platform.api_key')}
          hint={t('platform.providers_write_only_note')}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={draft.api_key}
            placeholder={t('platform.api_key_placeholder')}
            onChange={(event) => update('api_key', event.target.value)}
          />
        </Field>
        <p className="text-xs text-muted" aria-live="polite">
          {editing && provider !== null && provider.secret_configured
            ? t('platform.api_key_configured')
            : t('platform.api_key_missing')}
          {draft.api_key.length > 0
            ? ` · ${t('platform.api_key_fingerprint')}: ${fingerprintOf(draft.api_key)}`
            : ''}
        </p>
        {message ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{message}</div> : null}
      </form>
    </Drawer>
  );
}
