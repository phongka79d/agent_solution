'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  SectionHeader,
  StatusBadge,
  Tabs,
} from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import {
  ApiError,
  changePlatformPassword,
  invitePlatformAdmin,
  listCompanies,
  listPlatformAdmins,
  listSkillCatalog,
  setSkillEntitlement,
  type PlatformAdmin,
  type PlatformAdminStatus,
  type PlatformCompany,
  type PlatformSkillCatalogEntry,
} from '../../lib/platform-client';
import { useSession } from '../auth/SessionProvider';

/** A read-only platform feature flag, resolved from the deployment environment on the server. */
export interface SettingsFeatureFlag {
  readonly key: string;
  readonly labelKey: string;
  readonly enabled: boolean;
}

export interface SettingsPageProps {
  /** `db` exposes the password form; `demo` explains that the demo store cannot change passwords (T9.2). */
  readonly authProvider: 'db' | 'demo';
  /** Session lifetime in seconds, mirrored from the server's session policy. */
  readonly sessionTtlSeconds: number;
  /** Platform feature flags; the UI never writes them (env-owned, T8.9). */
  readonly featureFlags: readonly SettingsFeatureFlag[];
}

interface EntitlementState {
  readonly enabled: boolean;
  readonly version: string;
}

function entitlementKey(tenantId: string, skillId: string): string {
  return `${tenantId}|${skillId}`;
}

function AccountTab({ authProvider }: { readonly authProvider: 'db' | 'demo' }) {
  const session = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = () => {
    if (submitting) return;
    setMessage(null);
    setFailure(null);
    if (currentPassword.length === 0 || newPassword.length === 0) {
      setFailure(t('platform.password_failed'));
      return;
    }
    setSubmitting(true);
    void changePlatformPassword(currentPassword, newPassword)
      .then(() => {
        setMessage(t('platform.password_changed'));
        setCurrentPassword('');
        setNewPassword('');
      })
      .catch(() => setFailure(t('platform.password_failed')))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="space-y-6">
      <section className="platform-card p-4 sm:p-5">
        <SectionHeader title={t('platform.account')} />
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.display_name')}</dt>
            <dd className="mt-1 text-sm text-ink">{session.identity.display_name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.email')}</dt>
            <dd className="mt-1 text-sm text-ink-body">{session.identity.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.scope')}</dt>
            <dd className="mt-1"><StatusBadge code="ACTIVE" label={t('platform.scope_platform')} /></dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.role')}</dt>
            <dd className="mt-1 text-sm text-ink-body">{t('platform.role_platform_admin')}</dd>
          </div>
        </dl>
      </section>
      <section className="platform-card p-4 sm:p-5">
        <SectionHeader title={t('platform.change_password')} />
        {authProvider === 'db' ? (
          <form
            className="mt-4 grid max-w-md gap-3"
            onSubmit={(event) => { event.preventDefault(); submit(); }}
          >
            <label className="text-xs font-medium text-ink-body">
              {t('platform.current_password')}
              <input
                className="ui-input mt-1 block w-full"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-ink-body">
              {t('platform.new_password')}
              <input
                className="ui-input mt-1 block w-full"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? t('common.loading') : t('platform.password_submit')}
              </Button>
              {message ? <span role="status" className="text-sm text-ink-body">{message}</span> : null}
              {failure ? <span role="alert" className="platform-alert platform-alert--danger text-sm">{failure}</span> : null}
            </div>
          </form>
        ) : (
          <p className="mt-3 text-sm text-ink-body" role="note">{t('platform.password_db_note')}</p>
        )}
      </section>
    </div>
  );
}

function adminStatusLabel(status: PlatformAdminStatus): string {
  switch (status) {
    case 'INVITED': return t('platform.admin_status_invited');
    case 'ACTIVE': return t('platform.admin_status_active');
    case 'DEACTIVATED': return t('platform.admin_status_deactivated');
  }
}

function AdminsTab() {
  const [admins, setAdmins] = useState<readonly PlatformAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 404: the API binds administrator management only with durable sign-in (not in demo mode).
  const [unavailable, setUnavailable] = useState(false);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listPlatformAdmins()
      .then((items) => {
        if (cancelled) return;
        setAdmins(items);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setUnavailable(true);
        else setFailed(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || email.trim().length === 0) return;
    setFailure(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await invitePlatformAdmin(email.trim());
      setEmail('');
      setMessage(t('platform.admin_invite_success'));
      void listPlatformAdmins()
        .then((items) => { setAdmins(items); setFailed(false); })
        .catch(() => setFailed(true));
    } catch {
      setFailure(t('platform.admin_invite_failed'));
    } finally {
      setSubmitting(false);
    }
  }

  const columns = useMemo(() => [
    {
      key: 'name',
      header: t('platform.display_name'),
      render: (row: PlatformAdmin) => row.display_name ?? t('platform.admin_name'),
    },
    { key: 'email', header: t('platform.admin_email'), render: (row: PlatformAdmin) => row.email },
    {
      key: 'status',
      header: t('platform.admin_status'),
      render: (row: PlatformAdmin) => adminStatusLabel(row.status),
    },
    {
      key: 'last-sign-in',
      header: t('platform.admin_last_sign_in'),
      render: (row: PlatformAdmin) => (
        <span className="text-xs text-muted">
          {row.last_sign_in_at ? new Date(row.last_sign_in_at).toLocaleString() : t('common.empty')}
        </span>
      ),
    },
  ], []);

  return (
    <div className="space-y-6">
      <section className="platform-card p-4 sm:p-5">
        <SectionHeader title={t('platform.tab_admins')} description={t('platform.admins_description')} />
      </section>
      {unavailable ? (
        <p role="note" className="platform-alert platform-alert--info text-sm">{t('platform.admins_unavailable')}</p>
      ) : (
        <section className="platform-card p-4 sm:p-5">
          <SectionHeader title={t('platform.invite_admin')} />
          <form className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => { void submitInvitation(event); }}>
            <label htmlFor="platform-admin-email" className="block max-w-lg flex-1 text-xs font-medium text-ink-body">
              {t('platform.admin_invite_email')}
              <input
                id="platform-admin-email"
                className="ui-input mt-1 block w-full"
                type="email"
                autoComplete="email"
                maxLength={320}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={submitting || email.trim().length === 0}>
              {submitting ? t('common.loading') : t('platform.admin_invite_submit')}
            </Button>
          </form>
          {message ? <p role="status" className="mt-3 text-sm text-ink-body">{message}</p> : null}
          {failure ? <p role="alert" className="platform-alert platform-alert--danger mt-3 text-sm">{failure}</p> : null}
        </section>
      )}
      {unavailable ? null : (
        <section aria-label={t('platform.tab_admins')} aria-busy={loading}>
          {failed ? (
            <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('platform.admins_load_failed')}</div>
          ) : loading ? (
            <>
              <p role="status" className="sr-only">{t('platform.admins_loading')}</p>
              <DataTable rows={[]} loading columns={columns} getRowKey={() => 'loading'} caption={t('platform.tab_admins')} />
            </>
          ) : (
            <DataTable
              rows={admins}
              columns={columns}
              getRowKey={(row) => row.user_id ?? `${row.email}|${row.created_at}`}
              caption={t('platform.tab_admins')}
              className="platform-card"
              empty={<EmptyState title={t('platform.admins_empty')} />}
            />
          )}
        </section>
      )}
    </div>
  );
}

function SkillCatalogTab() {
  const [catalog, setCatalog] = useState<readonly PlatformSkillCatalogEntry[]>([]);
  const [companies, setCompanies] = useState<readonly PlatformCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [entitlements, setEntitlements] = useState<Record<string, EntitlementState>>({});
  const [pending, setPending] = useState<Record<string, true>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([listSkillCatalog(), listCompanies()])
      .then(([nextCatalog, nextCompanies]) => {
        if (cancelled) return;
        setCatalog(nextCatalog);
        setCompanies(nextCompanies);
        setFailed(false);
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback((entry: PlatformSkillCatalogEntry, entitled: boolean) => {
    if (tenantId.length === 0) return;
    const key = entitlementKey(tenantId, entry.skill_id);
    if (pending[key]) return;
    setMessage(null);
    setFailure(null);
    setPending((current) => ({ ...current, [key]: true }));
    void setSkillEntitlement(entry.skill_id, tenantId, entitled, entitlements[key]?.version ?? null)
      .then((result) => {
        setEntitlements((current) => ({ ...current, [key]: { enabled: result.enabled, version: result.version } }));
        setMessage(t('platform.skill_entitlement_saved'));
      })
      .catch(() => setFailure(t('platform.skill_entitlement_failed')))
      .finally(() => setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      }));
  }, [entitlements, pending, tenantId]);

  const columns = useMemo(() => [
    {
      key: 'skill',
      header: t('platform.skill'),
      render: (row: PlatformSkillCatalogEntry) => (
        <span className="font-mono text-xs text-ink-body">
          {row.display_key}
          {row.retired ? <span className="ml-2 text-muted">({t('platform.skill_retired')})</span> : null}
        </span>
      ),
    },
    { key: 'domain', header: t('platform.skill_domain'), render: (row: PlatformSkillCatalogEntry) => row.domain },
    { key: 'authority', header: t('platform.skill_authority'), render: (row: PlatformSkillCatalogEntry) => <span className="font-mono text-xs">{row.required_authority}</span> },
    { key: 'effect', header: t('platform.skill_effect'), render: (row: PlatformSkillCatalogEntry) => row.effect_class },
    { key: 'version', header: t('platform.skill_contract_version'), render: (row: PlatformSkillCatalogEntry) => <span className="font-mono text-xs">{row.contract_version}</span> },
    { key: 'runs-24h', header: t('platform.skill_runs_24h'), numeric: true, render: (row: PlatformSkillCatalogEntry) => row.runs_24h },
    {
      key: 'success-rate-24h',
      header: t('platform.skill_success_rate_24h'),
      numeric: true,
      render: (row: PlatformSkillCatalogEntry) => row.success_rate_24h === null ? t('common.empty') : `${row.success_rate_24h.toFixed(1)}%`,
    },
    {
      key: 'p95-24h',
      header: t('platform.skill_p95_24h'),
      numeric: true,
      render: (row: PlatformSkillCatalogEntry) => row.p95_ms_24h === null ? t('common.empty') : `${row.p95_ms_24h} ms`,
    },
    {
      key: 'entitlement',
      header: t('platform.skill_entitlement'),
      render: (row: PlatformSkillCatalogEntry) => {
        const key = entitlementKey(tenantId, row.skill_id);
        const known = entitlements[key];
        const busy = pending[key] === true;
        return (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-body">
              {known ? (known.enabled ? t('platform.skill_entitled') : t('platform.skill_not_entitled')) : t('platform.skill_entitlement_unknown')}
            </span>
            <Button size="sm" variant="secondary" type="button" disabled={busy || tenantId.length === 0 || known?.enabled === true} onClick={() => toggle(row, true)}>{t('platform.skill_grant')}</Button>
            <Button size="sm" variant="secondary" type="button" disabled={busy || tenantId.length === 0 || known?.enabled === false} onClick={() => toggle(row, false)}>{t('platform.skill_revoke')}</Button>
          </div>
        );
      },
    },
  ], [entitlements, pending, tenantId, toggle]);

  return (
    <div className="space-y-6">
      <section className="platform-card p-4 sm:p-5">
        <SectionHeader title={t('platform.tab_skill_catalog')} description={t('platform.skill_catalog_description')} />
        <label className="mt-4 block max-w-sm text-xs font-medium text-ink-body">
          {t('platform.skill_company')}
          <select className="ui-input mt-1 block w-full" value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            <option value="">{t('platform.skill_select_company')}</option>
            {companies.map((company) => (
              <option key={company.tenant_id} value={company.tenant_id}>{company.display_name}</option>
            ))}
          </select>
        </label>
        {message ? <p role="status" className="mt-3 text-sm text-ink-body">{message}</p> : null}
        {failure ? <p role="alert" className="platform-alert platform-alert--danger mt-3 text-sm">{failure}</p> : null}
      </section>
      <section aria-label={t('platform.tab_skill_catalog')}>
        {failed ? (
          <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('platform.failed_load')}</div>
        ) : loading ? (
          <DataTable rows={[]} loading columns={columns} getRowKey={() => 'loading'} caption={t('platform.tab_skill_catalog')} />
        ) : catalog.length === 0 ? (
          <EmptyState title={t('common.empty')} />
        ) : (
          <DataTable rows={catalog} columns={columns} getRowKey={(row) => row.skill_id} caption={t('platform.tab_skill_catalog')} className="platform-card" empty={<EmptyState title={t('common.empty')} />} />
        )}
      </section>
    </div>
  );
}

function FeaturesTab({ featureFlags }: { readonly featureFlags: readonly SettingsFeatureFlag[] }) {
  const columns = useMemo(() => [
    { key: 'flag', header: t('platform.feature_flag'), render: (row: SettingsFeatureFlag) => t(row.labelKey) },
    {
      key: 'state',
      header: t('platform.feature_state'),
      render: (row: SettingsFeatureFlag) => (
        <span className="text-sm text-ink-body">{row.enabled ? t('platform.enabled') : t('platform.disabled')}</span>
      ),
    },
  ], []);
  return (
    <section className="platform-card p-4 sm:p-5">
      <SectionHeader title={t('platform.tab_features')} description={t('platform.features_description')} />
      <div className="mt-4">
        <DataTable rows={featureFlags} columns={columns} getRowKey={(row) => row.key} caption={t('platform.tab_features')} empty={<EmptyState title={t('common.empty')} />} />
      </div>
    </section>
  );
}

function SecurityTab({ authProvider, sessionTtlSeconds }: { readonly authProvider: 'db' | 'demo'; readonly sessionTtlSeconds: number }) {
  const minutes = Math.max(1, Math.round(sessionTtlSeconds / 60));
  return (
    <section className="platform-card p-4 sm:p-5">
      <SectionHeader title={t('platform.tab_security')} description={t('platform.security_description')} />
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.session_idle')}</dt>
          <dd className="mt-1 text-sm text-ink-body">{t('platform.minutes_value', { count: minutes })}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.session_absolute')}</dt>
          <dd className="mt-1 text-sm text-ink-body">{t('platform.policy_managed')}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.session_cookie')}</dt>
          <dd className="mt-1 text-sm text-ink-body">{t('platform.session_cookie_value')}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.csrf')}</dt>
          <dd className="mt-1 text-sm text-ink-body">{t('platform.csrf_value')}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">{t('platform.auth_provider')}</dt>
          <dd className="mt-1 text-sm text-ink-body">{authProvider === 'db' ? t('platform.auth_provider_db') : t('platform.auth_provider_demo')}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Platform settings surface (T8.9): account, administrators, skill catalog, features, security. */
export function SettingsPage({ authProvider, sessionTtlSeconds, featureFlags }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('nav.settings')} description={t('platform.settings_description')} />
      <Tabs
        defaultTabId="account"
        tabs={[
          { id: 'account', label: t('platform.tab_account'), content: <AccountTab authProvider={authProvider} /> },
          { id: 'admins', label: t('platform.tab_admins'), content: <AdminsTab /> },
          { id: 'skill-catalog', label: t('platform.tab_skill_catalog'), content: <SkillCatalogTab /> },
          { id: 'features', label: t('platform.tab_features'), content: <FeaturesTab featureFlags={featureFlags} /> },
          { id: 'security', label: t('platform.tab_security'), content: <SecurityTab authProvider={authProvider} sessionTtlSeconds={sessionTtlSeconds} /> },
        ]}
      />
    </div>
  );
}
