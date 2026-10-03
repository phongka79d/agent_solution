'use client';

import { t } from '@agentos/ui-foundation/i18n';
import { Button, ErrorBanner, Field, Input, Modal, Select, Toast } from '@agentos/ui-foundation/react';
import { useEffect, useState } from 'react';

import type {
  CompanyConnectorItem,
  ConnectorBinding,
  ConnectorProbeResult,
  ConnectorUpdateRequest,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { fieldsFor } from './groups';
import { TestResultPanel } from './TestResultPanel';

export interface ConnectModalProps {
  readonly open: boolean;
  readonly item: CompanyConnectorItem | null;
  readonly onClose: () => void;
  readonly onSaved: (connectorId: string, binding: ConnectorBinding) => void;
}

function initialValues(item: CompanyConnectorItem): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fieldsFor(item)) {
    const current = item.binding?.config[field.key];
    values[field.key] = typeof current === 'string' ? current : '';
  }
  return values;
}

/** Catalog-driven connect/reconfigure form; the secret input is write-only and never echoed back. */
export function ConnectModal({ open, item, onClose, onSaved }: ConnectModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const [binding, setBinding] = useState<ConnectorBinding | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState<ConnectorProbeResult | null>(null);
  const [testError, setTestError] = useState<unknown>(null);

  useEffect(() => {
    if (!open || item === null) return;
    setValues(initialValues(item));
    setBinding(item.binding);
    setSecret('');
    setSaved(false);
    setSaveError(null);
    setTestResult(null);
    setTestError(null);
  }, [open, item]);

  if (item === null) return null;

  const fields = fieldsFor(item);
  const missingRequired = fields.some((field) => field.required && (values[field.key] ?? '').length === 0);
  const canTest = item.integrated && item.probes.length > 0 && binding !== null;

  async function save(): Promise<void> {
    if (item === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const config: Record<string, unknown> = {};
      for (const field of fields) {
        const value = values[field.key] ?? '';
        if (value.length > 0) config[field.key] = value;
      }
      const body: ConnectorUpdateRequest = secret.length > 0 ? { config, secret } : { config };
      const response = await tenantConsoleClient.updateCompanyIntegration(
        item.connector_id,
        body,
        binding?.version ?? 1,
      );
      setBinding(response.binding);
      setSecret('');
      setSaved(true);
      onSaved(item.connector_id, response.binding);
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  }

  async function runTest(): Promise<void> {
    if (item === null) return;
    setTestPending(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await tenantConsoleClient.testCompanyIntegration(item.connector_id);
      setTestResult(result);
      setBinding(result.binding);
      onSaved(item.connector_id, result.binding);
    } catch (error) {
      setTestError(error);
    } finally {
      setTestPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('integrations.connect.title', { name: t(item.display_key) })}
      description={t('integrations.connect.description')}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={saving} disabled={missingRequired} onClick={() => void save()}>
            {t('integrations.action.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {fields.map((field) => {
          const labelKey = `integrations.field.${field.key}`;
          const label = t(labelKey);
          const fieldLabel = label === labelKey ? t('integrations.field.other') : label;
          if (field.enumValues.length > 0) {
            return (
              <Field key={field.key} label={fieldLabel}>
                <Select
                  value={values[field.key] ?? ''}
                  onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
                  options={field.enumValues.map((value) => {
                    const optionKey = `integrations.auth.${value.toLowerCase()}`;
                    const optionLabel = t(optionKey);
                    return { value, label: optionLabel === optionKey ? t('integrations.field.other') : optionLabel };
                  })}
                />
              </Field>
            );
          }
          return (
            <Field key={field.key} label={fieldLabel}>
              <Input
                value={values[field.key] ?? ''}
                inputMode={field.format === 'uri' ? 'url' : undefined}
                onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
              />
            </Field>
          );
        })}
        <Field label={t('integrations.secret.label')} hint={t('integrations.secret.hint')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
        <p className="text-sm text-muted">
          {binding?.secret
            ? `${t('integrations.secret.fingerprint')}: ${binding.secret.fingerprint} · ••••${binding.secret.last4}`
            : t('integrations.secret.none')}
        </p>
        {saved ? <Toast tone="success" message={t('integrations.connect.saved')} /> : null}
        {saveError === null ? null : <ErrorBanner error={saveError} />}
        <div className="space-y-3">
          <Button variant="secondary" loading={testPending} disabled={!canTest} onClick={() => void runTest()}>
            {t('integrations.action.test_connection')}
          </Button>
          <TestResultPanel result={testResult} pending={testPending} error={testError} />
        </div>
      </div>
    </Modal>
  );
}
