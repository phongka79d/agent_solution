'use client';

import { can } from '@agentos/ui-foundation/auth';
import { describeApiError } from '@agentos/ui-foundation/errors';
import { t } from '@agentos/ui-foundation/i18n';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  SectionHeader,
  Select,
  Skeleton,
  Tabs,
  Toast,
} from '@agentos/ui-foundation/react';
import { useEffect, useRef, useState } from 'react';

import type {
  CompanyLlmResponse,
  CompanyLlmUpdateRequest,
  CompanyProfileResponse,
  CompanyProfileUpdateRequest,
  GovernanceSettingsResponse,
  LlmProbeResult,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from '../auth/SessionProvider';
import { SettingsAuditTab } from './settings/SettingsAuditTab';
import { SettingsUsersTab } from './settings/SettingsUsersTab';
import { DataTab } from './settings/DataTab';
import { HistoryDrawer } from './settings/HistoryDrawer';
import { SecurityTab } from './settings/SecurityTab';

const LOCALE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function asConflict(error: unknown): boolean {
  const candidate = error as { readonly status?: unknown; readonly error_code?: unknown; readonly code?: unknown } | null;
  if (candidate === null || typeof candidate !== 'object') return false;
  if (candidate.status === 409 || candidate.status === 412) return true;
  const code = candidate.error_code ?? candidate.code;
  return code === 'VERSION_CONFLICT' || code === 'CONFLICT' || code === 'PRECONDITION_FAILED';
}

/** Blocks accidental navigation away while a settings form holds unsaved edits. */
function useUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

function ReadOnlyNotice({ messageKey }: { readonly messageKey: string }) {
  return (
    <p className="rounded-lg border border-line bg-surface-muted p-3 text-sm text-muted" role="note">
      {t(messageKey)}
    </p>
  );
}

interface SettingsFormProps {
  readonly canManage: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

interface ProfileFormState {
  readonly company_name: string;
  readonly industry: string;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly voice: string;
  readonly prohibited_claims_url: string;
  readonly logo_url: string;
}

function profileState(profile: CompanyProfileResponse): ProfileFormState {
  return {
    company_name: profile.company_name,
    industry: profile.industry ?? '',
    locale: profile.locale,
    timezone: profile.timezone,
    currency: profile.currency,
    voice: profile.brand_profile.voice ?? '',
    prohibited_claims_url: profile.brand_profile.prohibited_claims_url ?? '',
    logo_url: profile.brand_profile.logo_url ?? '',
  };
}

function validateProfile(form: ProfileFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = form.company_name.trim();
  if (name.length < 1 || name.length > 128) errors.company_name = t('settings.validation.company_name');
  if (form.industry.trim().length > 128) errors.industry = t('settings.validation.industry');
  if (!LOCALE_RE.test(form.locale.trim())) errors.locale = t('settings.validation.locale');
  if (!isTimezone(form.timezone.trim())) errors.timezone = t('settings.validation.timezone');
  if (!CURRENCY_RE.test(form.currency.trim().toUpperCase())) errors.currency = t('settings.validation.currency');
  if (form.prohibited_claims_url.trim() !== '' && !isHttpsUrl(form.prohibited_claims_url.trim())) {
    errors.prohibited_claims_url = t('settings.validation.url');
  }
  if (form.logo_url.trim() !== '' && !isHttpsUrl(form.logo_url.trim())) errors.logo_url = t('settings.validation.url');
  return errors;
}

function profileBody(form: ProfileFormState): CompanyProfileUpdateRequest {
  const voice = form.voice.trim();
  const prohibited = form.prohibited_claims_url.trim();
  const logo = form.logo_url.trim();
  return {
    company_name: form.company_name.trim(),
    industry: form.industry.trim() === '' ? null : form.industry.trim(),
    locale: form.locale.trim(),
    timezone: form.timezone.trim(),
    currency: form.currency.trim().toUpperCase(),
    brand_profile: {
      ...(voice === '' ? {} : { voice }),
      ...(prohibited === '' ? {} : { prohibited_claims_url: prohibited }),
      ...(logo === '' ? {} : { logo_url: logo }),
    },
  };
}

function ProfileForm({ canManage, onDirtyChange }: SettingsFormProps) {
  const [profile, setProfile] = useState<CompanyProfileResponse | null>(null);
  const [form, setForm] = useState<ProfileFormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = (): void => {
    setLoading(true);
    setLoadError(null);
    void tenantConsoleClient.getCompanyProfile().then((response) => {
      setProfile(response);
      setForm(profileState(response));
    }).catch((caught: unknown) => setLoadError(caught)).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const dirty = profile !== null && form !== null && JSON.stringify(profileState(profile)) !== JSON.stringify(form);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useUnloadGuard(dirty);

  if (loading) return <Skeleton variant="card" />;
  if (loadError !== null) return <ErrorBanner error={loadError} onRetry={load} />;
  if (profile === null || form === null) return <Skeleton variant="card" />;

  const applyErrors = (): boolean => {
    const found = validateProfile(form);
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const save = async (): Promise<void> => {
    if (!applyErrors()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await tenantConsoleClient.updateCompanyProfile(profileBody(form), profile.version);
      setProfile(response);
      setForm(profileState(response));
      setSaved(true);
    } catch (caught) {
      if (asConflict(caught)) setConflict(true);
      else setSaveError(caught);
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]): void => {
    setForm((previous) => previous === null ? previous : { ...previous, [key]: value });
    setSaved(false);
  };

  return (
    <div className="space-y-5" data-testid="settings-profile-form">
      {saved ? <Toast tone="success" message={t('settings.saved')} onDismiss={() => setSaved(false)} /> : null}
      {saveError !== null ? <ErrorBanner error={saveError} /> : null}
      {!canManage ? <ReadOnlyNotice messageKey="settings.readonly.settings" /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.field.company_name')} error={errors.company_name}>
          <Input value={form.company_name} disabled={!canManage} onChange={(event) => set('company_name', event.target.value)} />
        </Field>
        <Field label={t('settings.field.industry')} error={errors.industry}>
          <Input value={form.industry} disabled={!canManage} onChange={(event) => set('industry', event.target.value)} />
        </Field>
        <Field label={t('settings.field.locale')} error={errors.locale}>
          <Input value={form.locale} disabled={!canManage} onChange={(event) => set('locale', event.target.value)} />
        </Field>
        <Field label={t('settings.field.timezone')} error={errors.timezone}>
          <Input value={form.timezone} disabled={!canManage} onChange={(event) => set('timezone', event.target.value)} />
        </Field>
        <Field label={t('settings.field.currency')} error={errors.currency}>
          <Input value={form.currency} disabled={!canManage} onChange={(event) => set('currency', event.target.value)} />
        </Field>
        <Field label={t('settings.field.voice')}>
          <Input value={form.voice} disabled={!canManage} onChange={(event) => set('voice', event.target.value)} />
        </Field>
        <Field label={t('settings.field.prohibited_claims_url')} error={errors.prohibited_claims_url}>
          <Input value={form.prohibited_claims_url} disabled={!canManage} onChange={(event) => set('prohibited_claims_url', event.target.value)} />
        </Field>
        <Field label={t('settings.field.logo_url')} error={errors.logo_url}>
          <Input value={form.logo_url} disabled={!canManage} onChange={(event) => set('logo_url', event.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={!canManage || !dirty} loading={saving} onClick={() => void save()}>{t('settings.action.save')}</Button>
        {dirty ? <span className="text-sm text-muted">{t('settings.dirty')}</span> : null}
      </div>
      <ConfirmDialog
        open={conflict}
        title={t('settings.conflict.title')}
        description={t('settings.conflict.body')}
        confirmLabel={t('settings.action.reload')}
        onConfirm={() => { setConflict(false); load(); }}
        onCancel={() => setConflict(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

interface GovernanceFormState {
  readonly require_distinct_approver: boolean;
  readonly approval_expiry_hours: string;
  readonly takeover_lease_seconds: string;
}

function governanceState(settings: GovernanceSettingsResponse): GovernanceFormState {
  return {
    require_distinct_approver: settings.require_distinct_approver,
    approval_expiry_hours: String(settings.approval_expiry_hours),
    takeover_lease_seconds: String(settings.takeover_lease_seconds),
  };
}

function validateGovernance(form: GovernanceFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const hours = Number(form.approval_expiry_hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    errors.approval_expiry_hours = t('settings.validation.number_range', { min: 1, max: 720 });
  }
  const lease = Number(form.takeover_lease_seconds);
  if (!Number.isInteger(lease) || lease < 30 || lease > 600) {
    errors.takeover_lease_seconds = t('settings.validation.number_range', { min: 30, max: 600 });
  }
  return errors;
}

function GovernanceForm({ canManage, onDirtyChange }: SettingsFormProps) {
  const [settings, setSettings] = useState<GovernanceSettingsResponse | null>(null);
  const [form, setForm] = useState<GovernanceFormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = (): void => {
    setLoading(true);
    setLoadError(null);
    void tenantConsoleClient.getCompanyGovernance().then((response) => {
      setSettings(response);
      setForm(governanceState(response));
    }).catch((caught: unknown) => setLoadError(caught)).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const dirty = settings !== null && form !== null && JSON.stringify(governanceState(settings)) !== JSON.stringify(form);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useUnloadGuard(dirty);

  if (loading) return <Skeleton variant="card" />;
  if (loadError !== null) return <ErrorBanner error={loadError} onRetry={load} />;
  if (settings === null || form === null) return <Skeleton variant="card" />;

  const save = async (): Promise<void> => {
    const found = validateGovernance(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await tenantConsoleClient.updateCompanyGovernance({
        require_distinct_approver: form.require_distinct_approver,
        approval_expiry_hours: Number(form.approval_expiry_hours),
        takeover_lease_seconds: Number(form.takeover_lease_seconds),
      }, settings.version);
      setSettings(response);
      setForm(governanceState(response));
      setSaved(true);
    } catch (caught) {
      if (asConflict(caught)) setConflict(true);
      else setSaveError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="settings-governance-form">
      {saved ? <Toast tone="success" message={t('settings.saved')} onDismiss={() => setSaved(false)} /> : null}
      {saveError !== null ? <ErrorBanner error={saveError} /> : null}
      {!canManage ? <ReadOnlyNotice messageKey="settings.readonly.settings" /> : null}
      <label className="flex items-center gap-3 text-sm text-ink">
        <input
          type="checkbox"
          checked={form.require_distinct_approver}
          disabled={!canManage}
          onChange={(event) => { setForm({ ...form, require_distinct_approver: event.target.checked }); setSaved(false); }}
        />
        {t('settings.field.require_distinct_approver')}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.field.approval_expiry_hours')} error={errors.approval_expiry_hours}>
          <Input
            type="number"
            min={1}
            max={720}
            value={form.approval_expiry_hours}
            disabled={!canManage}
            onChange={(event) => { setForm({ ...form, approval_expiry_hours: event.target.value }); setSaved(false); }}
          />
        </Field>
        <Field label={t('settings.field.takeover_lease_seconds')} error={errors.takeover_lease_seconds}>
          <Input
            type="number"
            min={30}
            max={600}
            value={form.takeover_lease_seconds}
            disabled={!canManage}
            onChange={(event) => { setForm({ ...form, takeover_lease_seconds: event.target.value }); setSaved(false); }}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={!canManage || !dirty} loading={saving} onClick={() => void save()}>{t('settings.action.save')}</Button>
        {dirty ? <span className="text-sm text-muted">{t('settings.dirty')}</span> : null}
      </div>
      <ConfirmDialog
        open={conflict}
        title={t('settings.conflict.title')}
        description={t('settings.conflict.body')}
        confirmLabel={t('settings.action.reload')}
        onConfirm={() => { setConflict(false); load(); }}
        onCancel={() => setConflict(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI / LLM
// ---------------------------------------------------------------------------

interface LlmFormState {
  readonly mode: 'INHERIT' | 'CUSTOM';
  readonly provider_id: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: string;
  readonly structured_mode: 'json_object' | 'json_schema';
  readonly monthly_token_budget: string;
  readonly api_key: string;
}

function llmState(config: CompanyLlmResponse): LlmFormState {
  return {
    mode: config.mode,
    provider_id: config.provider_id ?? '',
    base_url: config.base_url ?? '',
    reasoning_model: config.reasoning_model ?? '',
    fast_model: config.fast_model ?? '',
    timeout_ms: config.timeout_ms === null ? '' : String(config.timeout_ms),
    structured_mode: config.structured_mode ?? 'json_object',
    monthly_token_budget: config.monthly_token_budget === null ? '' : String(config.monthly_token_budget),
    api_key: '',
  };
}

function validateLlm(form: LlmFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.mode === 'CUSTOM') {
    if (form.provider_id.trim().length === 0 || form.provider_id.trim().length > 128) errors.provider_id = t('settings.validation.required');
    if (!isHttpsUrl(form.base_url.trim())) errors.base_url = t('settings.validation.url');
    if (form.reasoning_model.trim().length === 0) errors.reasoning_model = t('settings.validation.required');
    if (form.fast_model.trim().length === 0) errors.fast_model = t('settings.validation.required');
    const timeout = Number(form.timeout_ms);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
      errors.timeout_ms = t('settings.validation.number_range', { min: 1000, max: 120000 });
    }
  }
  if (form.monthly_token_budget.trim() !== '') {
    const budget = Number(form.monthly_token_budget);
    if (!Number.isInteger(budget) || budget <= 0) errors.monthly_token_budget = t('settings.validation.number_range', { min: 1, max: 1000000000 });
  }
  if (form.api_key.trim().length > 512) errors.api_key = t('settings.validation.number_range', { min: 1, max: 512 });
  return errors;
}

function LlmForm({ canManage, onDirtyChange }: SettingsFormProps) {
  const [config, setConfig] = useState<CompanyLlmResponse | null>(null);
  const [form, setForm] = useState<LlmFormState | null>(null);
  const [baseline, setBaseline] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [probe, setProbe] = useState<LlmProbeResult | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = (): void => {
    setLoading(true);
    setLoadError(null);
    void tenantConsoleClient.getCompanyLlm().then((response) => {
      setConfig(response);
      const next = llmState(response);
      setForm(next);
      setBaseline(JSON.stringify(next));
    }).catch((caught: unknown) => setLoadError(caught)).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const dirty = form !== null && (JSON.stringify({ ...form, api_key: '' }) !== baseline || form.api_key.trim() !== '');
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useUnloadGuard(dirty);

  if (loading) return <Skeleton variant="card" />;
  if (loadError !== null) return <ErrorBanner error={loadError} onRetry={load} />;
  if (config === null || form === null) return <Skeleton variant="card" />;

  const set = <K extends keyof LlmFormState>(key: K, value: LlmFormState[K]): void => {
    setForm((previous) => previous === null ? previous : { ...previous, [key]: value });
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    const found = validateLlm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setSaveError(null);
    const budget = form.monthly_token_budget.trim() === '' ? {} : { monthly_token_budget: Number(form.monthly_token_budget) };
    const body: CompanyLlmUpdateRequest = form.mode === 'INHERIT'
      ? { mode: 'INHERIT', ...budget }
      : {
          mode: 'CUSTOM',
          provider_id: form.provider_id.trim(),
          base_url: form.base_url.trim(),
          reasoning_model: form.reasoning_model.trim(),
          fast_model: form.fast_model.trim(),
          timeout_ms: Number(form.timeout_ms),
          structured_mode: form.structured_mode,
          ...budget,
          ...(form.api_key.trim() === '' ? {} : { api_key: form.api_key }),
        };
    try {
      const response = await tenantConsoleClient.updateCompanyLlm(body, config.config_version);
      setConfig(response);
      const next = llmState(response);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setSaved(true);
    } catch (caught) {
      if (asConflict(caught)) setConflict(true);
      else setSaveError(caught);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setProbe(null);
    try {
      setProbe(await tenantConsoleClient.testCompanyLlm());
    } catch (caught) {
      setProbe({ outcome: 'FAIL', latency_ms: null, http_status: null, error_class: describeApiError(caught).code });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="settings-llm-form">
      {saved ? <Toast tone="success" message={t('settings.saved')} onDismiss={() => setSaved(false)} /> : null}
      {saveError !== null ? <ErrorBanner error={saveError} /> : null}
      {!canManage ? <ReadOnlyNotice messageKey="settings.readonly.llm" /> : null}
      <Field label={t('settings.field.llm_mode')}>
        <Select
          value={form.mode}
          disabled={!canManage}
          options={[
            { value: 'INHERIT', label: t('settings.llm.mode.inherit') },
            { value: 'CUSTOM', label: t('settings.llm.mode.custom') },
          ]}
          onChange={(event) => set('mode', event.target.value as LlmFormState['mode'])}
        />
      </Field>
      {form.mode === 'INHERIT' ? (
        <p className="text-sm text-muted">{t('settings.ai.inherit_note')}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.field.llm_provider_id')} error={errors.provider_id}>
            <Input value={form.provider_id} disabled={!canManage} onChange={(event) => set('provider_id', event.target.value)} />
          </Field>
          <Field label={t('settings.field.llm_base_url')} error={errors.base_url}>
            <Input value={form.base_url} disabled={!canManage} onChange={(event) => set('base_url', event.target.value)} />
          </Field>
          <Field label={t('settings.field.llm_reasoning_model')} error={errors.reasoning_model}>
            <Input value={form.reasoning_model} disabled={!canManage} onChange={(event) => set('reasoning_model', event.target.value)} />
          </Field>
          <Field label={t('settings.field.llm_fast_model')} error={errors.fast_model}>
            <Input value={form.fast_model} disabled={!canManage} onChange={(event) => set('fast_model', event.target.value)} />
          </Field>
          <Field label={t('settings.field.llm_timeout_ms')} error={errors.timeout_ms}>
            <Input type="number" min={1000} max={120000} value={form.timeout_ms} disabled={!canManage} onChange={(event) => set('timeout_ms', event.target.value)} />
          </Field>
          <Field label={t('settings.field.llm_structured_mode')}>
            <Select
              value={form.structured_mode}
              disabled={!canManage}
              options={[
                { value: 'json_object', label: 'json_object' },
                { value: 'json_schema', label: 'json_schema' },
              ]}
              onChange={(event) => set('structured_mode', event.target.value as LlmFormState['structured_mode'])}
            />
          </Field>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.field.llm_budget')} error={errors.monthly_token_budget}>
          <Input type="number" min={1} value={form.monthly_token_budget} disabled={!canManage} onChange={(event) => set('monthly_token_budget', event.target.value)} />
        </Field>
        <Field label={t('settings.field.llm_api_key')} error={errors.api_key} hint={t('settings.llm.secret.write_only')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={form.api_key}
            disabled={!canManage}
            onChange={(event) => set('api_key', event.target.value)}
          />
        </Field>
      </div>
      <p className="text-sm text-muted">
        {config.secret_configured ? t('settings.llm.secret.configured') : t('settings.llm.secret.none')}
      </p>
      {probe === null ? null : (
        <Toast
          tone={probe.outcome === 'PASS' ? 'success' : 'danger'}
          message={probe.outcome === 'PASS' ? t('settings.ai.test.pass') : t('settings.ai.test.fail')}
          onDismiss={() => setProbe(null)}
        />
      )}
      <div className="flex items-center gap-3">
        <Button disabled={!canManage || !dirty} loading={saving} onClick={() => void save()}>{t('settings.action.save')}</Button>
        <Button variant="secondary" disabled={!canManage} loading={testing} onClick={() => void runTest()}>{t('settings.action.test')}</Button>
        {dirty ? <span className="text-sm text-muted">{t('settings.dirty')}</span> : null}
      </div>
      <ConfirmDialog
        open={conflict}
        title={t('settings.conflict.title')}
        description={t('settings.conflict.body')}
        confirmLabel={t('settings.action.reload')}
        onConfirm={() => { setConflict(false); load(); }}
        onCancel={() => setConflict(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const session = useSession();
  const canManageSettings = can(session, 'settings:manage');
  const canManageLlm = can(session, 'llm:manage');
  const [activeTab, setActiveTab] = useState('profile');
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const requestTab = (tabId: string): void => {
    if (dirtyRef.current && tabId !== activeTab) {
      setPendingTab(tabId);
      return;
    }
    setActiveTab(tabId);
  };

  const confirmDiscard = (): void => {
    if (pendingTab !== null) setActiveTab(pendingTab);
    setPendingTab(null);
    setDirty(false);
    setRenderKey((value) => value + 1);
  };

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t('nav.settings')} title={t('settings.title')} description={t('settings.description')} />
      <Tabs
        activeTabId={activeTab}
        onTabChange={requestTab}
        tabs={[
          {
            id: 'profile',
            label: t('settings.tab.profile'),
            content: (
              <section className="ui-section-card">
                <SectionHeader
                  title={t('settings.profile.title')}
                  description={t('settings.profile.description')}
                  action={<HistoryDrawer scope="company.profile" />}
                />
                <div className="p-5"><ProfileForm key={renderKey} canManage={canManageSettings} onDirtyChange={setDirty} /></div>
              </section>
            ),
          },
          {
            id: 'approvals',
            label: t('settings.tab.approvals'),
            content: (
              <section className="ui-section-card">
                <SectionHeader
                  title={t('settings.approvals.title')}
                  description={t('settings.approvals.description')}
                  action={<HistoryDrawer scope="company.governance" />}
                />
                <div className="p-5"><GovernanceForm key={renderKey} canManage={canManageSettings} onDirtyChange={setDirty} /></div>
              </section>
            ),
          },
          {
            id: 'ai',
            label: t('settings.tab.ai'),
            content: (
              <section className="ui-section-card">
                <SectionHeader
                  title={t('settings.ai.title')}
                  description={t('settings.ai.description')}
                  action={<HistoryDrawer scope="company.llm" />}
                />
                <div className="p-5"><LlmForm key={renderKey} canManage={canManageLlm} onDirtyChange={setDirty} /></div>
              </section>
            ),
          },
          {
            id: 'data',
            label: t('settings.tab.data'),
            content: (
              <section className="ui-section-card">
                <SectionHeader title={t('settings.data.title')} description={t('settings.data.description')} />
                <div className="p-5"><DataTab /></div>
              </section>
            ),
          },
          {
            id: 'security',
            label: t('settings.tab.security'),
            content: (
              <section className="ui-section-card">
                <SectionHeader title={t('settings.security.title')} description={t('settings.security.description')} />
                <div className="p-5"><SecurityTab /></div>
              </section>
            ),
          },
          {
            id: 'users',
            label: t('settings.tab.users'),
            content: (
              <section className="ui-section-card p-5">
                <SettingsUsersTab />
              </section>
            ),
          },
          {
            id: 'audit',
            label: t('settings.tab.audit'),
            content: (
              <section className="ui-section-card p-5">
                <SettingsAuditTab />
              </section>
            ),
          },
        ]}
      />
      <ConfirmDialog
        open={pendingTab !== null}
        tone="danger"
        title={t('settings.discard.title')}
        description={t('settings.discard.body')}
        confirmLabel={t('settings.discard.confirm')}
        onConfirm={confirmDiscard}
        onCancel={() => setPendingTab(null)}
      />
    </div>
  );
}
