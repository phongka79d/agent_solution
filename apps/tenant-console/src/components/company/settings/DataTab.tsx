'use client';

import { can } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
} from '@agentos/ui-foundation/react';
import { useCallback, useEffect, useState } from 'react';

import type { CompanyOwnerInput, CompanyOwnerInputResolution } from '../../../lib/tenant-console-client';
import { tenantConsoleClient } from '../../../lib/tenant-console-client';
import { useSession } from '../../auth/SessionProvider';

const OWNER_INPUT_LABELS: Readonly<Record<string, string>> = {
  'ASM-001': 'settings.data.owner.label.ASM-001',
  'ASM-002': 'settings.data.owner.label.ASM-002',
  'ASM-003': 'settings.data.owner.label.ASM-003',
  'ASM-004': 'settings.data.owner.label.ASM-004',
  FLOOR_POLICY: 'settings.data.owner.label.FLOOR_POLICY',
  REFUND_POLICY: 'settings.data.owner.label.REFUND_POLICY',
  RETENTION_POLICY: 'settings.data.owner.label.RETENTION_POLICY',
  KPI_BASELINE: 'settings.data.owner.label.KPI_BASELINE',
  PROVIDER_CREDENTIALS: 'settings.data.owner.label.PROVIDER_CREDENTIALS',
  RESIDENCY_REGION: 'settings.data.owner.label.RESIDENCY_REGION',
  PROMOTION_LIMITS: 'settings.data.owner.label.PROMOTION_LIMITS',
  careOnboardingItinerary: 'settings.data.owner.label.careOnboardingItinerary',
};

const DATA_CLASS_LABELS: Readonly<Record<string, string>> = {
  PRODUCTION: 'data_class.production',
  DEMO: 'data_class.demo',
  TEST: 'data_class.test',
};

interface InputEditor {
  readonly mode: 'value' | 'reference';
  readonly json: string;
  readonly valueRef: string;
}

function isOwnerInputValue(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function initialEditor(inputId: string): InputEditor {
  return { mode: inputId === 'PROVIDER_CREDENTIALS' ? 'reference' : 'value', json: '{}', valueRef: '' };
}

function isConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if (!('status' in error)) return false;
  return error.status === 409 || error.status === 412;
}

function labelFor(inputId: string): string {
  const key = OWNER_INPUT_LABELS[inputId];
  return key === undefined ? t('settings.data.owner_inputs') : t(key);
}

export function DataTab() {
  const session = useSession();
  const canManageSettings = can(session, 'settings:manage');
  const canReadTestStatus = can(session, 'testdata:manage');
  const [items, setItems] = useState<readonly CompanyOwnerInput[]>([]);
  const [loading, setLoading] = useState(canManageSettings);
  const [loadFailed, setLoadFailed] = useState(false);
  const [testingStatus, setTestingStatus] = useState<{ readonly data_class: string; readonly enabled: boolean } | null>(null);
  const [testingStatusFailed, setTestingStatusFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<InputEditor | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const loadOwnerInputs = useCallback(async (): Promise<void> => {
    if (!canManageSettings) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await tenantConsoleClient.getCompanyOwnerInputs();
      setItems(response.items);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [canManageSettings]);

  useEffect(() => { void loadOwnerInputs(); }, [loadOwnerInputs]);

  const loadTestingStatus = useCallback(async (): Promise<void> => {
    if (!canReadTestStatus) return;
    setTestingStatusFailed(false);
    try {
      const response = await tenantConsoleClient.getTestingStatus();
      setTestingStatus({ data_class: response.data_class, enabled: response.enabled });
    } catch {
      setTestingStatusFailed(true);
    }
  }, [canReadTestStatus]);

  useEffect(() => { void loadTestingStatus(); }, [loadTestingStatus]);

  const resolve = async (item: CompanyOwnerInput): Promise<void> => {
    if (!canManageSettings || editor === null || editingId !== item.input_id) return;
    setSaveError(null);
    setConflict(false);
    let body: CompanyOwnerInputResolution;
    if (editor.mode === 'reference') {
      const valueRef = editor.valueRef.trim();
      if (valueRef.length === 0 || valueRef.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(valueRef)) {
        setSaveError('settings.data.owner.ref_required');
        return;
      }
      body = { value_ref: valueRef };
    } else {
      let value: unknown;
      try {
        value = JSON.parse(editor.json);
      } catch {
        setSaveError('settings.data.owner.invalid_json');
        return;
      }
      if (!isOwnerInputValue(value)) {
        setSaveError('settings.data.owner.invalid_json');
        return;
      }
      const propertyCount = Object.keys(value).length;
      const serialized = JSON.stringify(value);
      if (propertyCount === 0 || propertyCount > 128 || serialized === undefined || serialized.length > 32_768) {
        setSaveError('settings.data.owner.invalid_json');
        return;
      }
      body = { value };
    }

    setSubmitting(true);
    try {
      const response = await tenantConsoleClient.resolveCompanyOwnerInput(item.input_id, body, item.version);
      setItems((current) => current.map((candidate) => candidate.input_id === item.input_id ? response.input : candidate));
      setEditingId(null);
      setEditor(null);
    } catch (error) {
      if (isConflict(error)) setConflict(true);
      else setSaveError('settings.data.owner.save_error');
    } finally {
      setSubmitting(false);
    }
  };

  const retentionPolicy = items.find((item) => item.input_id === 'RETENTION_POLICY');

  if (!canManageSettings) {
    return <p className="rounded-lg border border-line bg-surface-muted p-3 text-sm text-muted" role="note">{t('settings.readonly.settings')}</p>;
  }

  return (
    <div className="space-y-6" data-testid="settings-data-tab">
      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{t('settings.data.class')}</h3>
          <p className="text-sm text-muted">{t('settings.data.class_note')}</p>
        </div>
        {testingStatus !== null ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-sm text-muted">{t('settings.data.class')}</dt><dd className="font-medium text-ink">{t(DATA_CLASS_LABELS[testingStatus.data_class] ?? 'common.empty')}</dd></div>
            <div>
              <dt className="text-sm text-muted">{t('settings.data.test_data')}</dt>
              <dd><label className="mt-1 flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={testingStatus.enabled} disabled readOnly />{t('settings.data.test_data_enabled')}</label></dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted" role="note">
            {testingStatusFailed || canReadTestStatus ? t('settings.data.test_data_unavailable') : t('settings.data.class_unavailable')}
          </p>
        )}
        <p className="text-sm text-muted" role="note">{t('settings.data.test_data_note')}</p>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{t('settings.data.retention')}</h3>
          <p className="text-sm text-muted">{t('settings.data.retention_note')}</p>
        </div>
        {loading ? <p className="text-sm text-muted">{t('common.loading')}</p> : loadFailed || retentionPolicy === undefined ? (
          <p className="text-sm text-muted" role="note">{t('settings.data.retention_unavailable')}</p>
        ) : retentionPolicy.status === 'RESOLVED' ? (
          <p className="text-sm text-ink">{t('owner_input.state.resolved')}</p>
        ) : (
          <p className="text-sm text-muted">{t('owner_input.state.unresolved')}</p>
        )}
</section>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{t('settings.data.owner_inputs')}</h3>
          <p className="text-sm text-muted">{t('settings.data.owner_inputs_description')}</p>
        </div>
        {loadFailed ? <ErrorState message={t('settings.data.owner.load_error')} onRetry={() => void loadOwnerInputs()} /> : null}
        {loading ? <LoadingState label={t('common.loading')} /> : null}
        {!loading && !loadFailed && items.length === 0 ? <EmptyState title={t('settings.data.owner.empty')} status="NO_DATA" /> : null}
        {!loading && !loadFailed ? (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.input_id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="font-medium text-ink">{labelFor(item.input_id)}</h4>
                    <p className="mt-1 text-sm text-muted">{t(`owner_input.state.${item.status.toLowerCase()}`)}</p>
                  </div>
                  {item.status === 'UNRESOLVED' && editingId !== item.input_id ? (
                    <Button size="sm" disabled={!canManageSettings} onClick={() => { setEditingId(item.input_id); setEditor(initialEditor(item.input_id)); setSaveError(null); }}>{t('settings.data.owner.resolve')}</Button>
                  ) : null}
                </div>
                {editingId === item.input_id && editor !== null ? (
                  <form className="mt-4 space-y-3 border-t border-line pt-4" onSubmit={(event) => { event.preventDefault(); void resolve(item); }}>
                    {item.input_id === 'PROVIDER_CREDENTIALS' ? null : (
                      <Field label={t('settings.data.owner.mode')}>
                        <Select
                          value={editor.mode}
                          options={[
                            { value: 'value', label: t('settings.data.owner.mode.value') },
                            { value: 'reference', label: t('settings.data.owner.mode.reference') },
                          ]}
                          onChange={(event) => setEditor({ ...editor, mode: event.target.value === 'reference' ? 'reference' : 'value' })}
                        />
                      </Field>
                    )}
                    {editor.mode === 'reference' ? (
                      <Field label={t('settings.data.owner.value_ref')}>
                        <Input value={editor.valueRef} maxLength={4096} onChange={(event) => setEditor({ ...editor, valueRef: event.target.value })} />
                      </Field>
                    ) : (
                      <Field label={t('settings.data.owner.value')} hint={t('settings.data.owner.value_hint')}>
                        <textarea className="min-h-32 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink" value={editor.json} maxLength={32_768} onChange={(event) => setEditor({ ...editor, json: event.target.value })} />
                      </Field>
                    )}
                    {saveError !== null ? <p className="text-sm text-danger" role="alert">{t(saveError)}</p> : null}
                    {conflict ? (
                      <div className="space-y-2" role="alert">
                        <p className="text-sm text-danger">{t('settings.data.owner.conflict')}</p>
                        <Button type="button" variant="secondary" size="sm" disabled={submitting} onClick={() => {
                          void loadOwnerInputs().then(() => {
                            setEditingId(null);
                            setEditor(null);
                            setConflict(false);
                          });
                        }}>{t('settings.action.reload')}</Button>
                      </div>
                    ) : null}
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" loading={submitting}>{t('settings.data.owner.save')}</Button>
                      <Button type="button" variant="secondary" size="sm" disabled={submitting} onClick={() => { setEditingId(null); setEditor(null); setSaveError(null); setConflict(false); }}>{t('settings.data.owner.cancel')}</Button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
