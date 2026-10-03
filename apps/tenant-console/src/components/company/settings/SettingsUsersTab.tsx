'use client';

import { ApiError } from '@agentos/ui-foundation';
import { can } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { Button, ConfirmDialog, Field, Input, SectionHeader, Select } from '@agentos/ui-foundation/react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import {
  tenantConsoleClient,
  type CompanyUserRecord,
  type CompanyUserRole,
  type CompanyUserStatus,
} from '../../../lib/tenant-console-client';
import { useSession } from '../../auth/SessionProvider';

const ROLE_OPTIONS: readonly { readonly value: CompanyUserRole; readonly label: string }[] = [
  { value: 'COMPANY_ADMIN', label: t('settings.users.role.company_admin') },
  { value: 'OPERATOR', label: t('settings.users.role.operator') },
  { value: 'VIEWER', label: t('settings.users.role.viewer') },
];

const STATUS_KEYS: Readonly<Record<CompanyUserStatus, string>> = {
  INVITED: 'settings.users.status.invited',
  ACTIVE: 'settings.users.status.active',
  DEACTIVATED: 'settings.users.status.deactivated',
};

export function SettingsUsersTab() {
  const session = useSession();
  const canManage = can(session, 'settings:manage');
  const [users, setUsers] = useState<readonly CompanyUserRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 404: user management is bound only with durable sign-in (unavailable in demo mode).
  const [unavailable, setUnavailable] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<CompanyUserRole>('OPERATOR');
  const [pendingDeactivation, setPendingDeactivation] = useState<CompanyUserRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await tenantConsoleClient.getCompanyUsers();
      setUsers(response.items);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404) setUnavailable(true);
      else setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) void loadUsers();
  }, [canManage, loadUsers]);

  const changeRole = async (user: CompanyUserRecord, role_bundle: CompanyUserRole) => {
    setActionError(false);
    setNotice('');
    try {
      const updated = await tenantConsoleClient.updateCompanyUser({ user_id: user.user_id, role_bundle });
      setUsers((current) => current.map((item) => item.user_id === updated.user_id ? updated : item));
      setNotice(t('settings.users.updated'));
    } catch {
      setActionError(true);
      await loadUsers();
    }
  };

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setActionError(false);
    setNotice('');
    try {
      await tenantConsoleClient.inviteCompanyUser(email.trim(), inviteRole);
      setEmail('');
      setNotice(t('settings.users.invite_sent'));
      await loadUsers();
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const resendInvitation = async (user: CompanyUserRecord) => {
    setBusy(true);
    setActionError(false);
    setNotice('');
    try {
      await tenantConsoleClient.inviteCompanyUser(user.email, user.role_bundle);
      setNotice(t('settings.users.invite_resent'));
      await loadUsers();
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (!pendingDeactivation) return;
    setBusy(true);
    setActionError(false);
    setNotice('');
    try {
      const updated = await tenantConsoleClient.updateCompanyUser({
        user_id: pendingDeactivation.user_id,
        status: 'DEACTIVATED',
      });
      setUsers((current) => current.map((item) => item.user_id === updated.user_id ? updated : item));
      setPendingDeactivation(null);
      setNotice(t('settings.users.updated'));
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return <p className="text-sm text-muted" role="note">{t('settings.users.readonly')}</p>;
  }

  if (unavailable) {
    return (
      <div className="space-y-5">
        <SectionHeader title={t('settings.users.title')} description={t('settings.users.description')} />
        <p className="text-sm text-muted" role="note">{t('settings.users.unavailable')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHeader title={t('settings.users.title')} description={t('settings.users.description')} />
      <form className="grid gap-3 rounded-lg border border-default p-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end" onSubmit={submitInvite}>
        <Field label={t('settings.users.invite_email')}>
          <Input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
        </Field>
        <Field label={t('settings.users.role')}>
          <Select value={inviteRole} onChange={(event) => {
            const role = ROLE_OPTIONS.find((option) => option.value === event.currentTarget.value)?.value;
            if (role !== undefined) setInviteRole(role);
          }}>
            {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <Button type="submit" disabled={busy}>{t('settings.users.invite')}</Button>
      </form>

      {notice ? <p className="text-sm text-success" role="status">{notice}</p> : null}
      {actionError ? <p className="text-sm text-danger" role="alert">{t('settings.users.action_error')}</p> : null}
      {loadError ? <p className="text-sm text-danger" role="alert">{t('settings.users.load_error')}</p> : null}
      {loading ? <p className="text-sm text-muted" aria-busy="true">{t('common.loading')}</p> : null}
      {!loading && !loadError ? (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead><tr className="border-b border-default text-xs text-muted">
              <th className="px-3 py-2 font-medium">{t('settings.users.name')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.users.email')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.users.role')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.users.status')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.users.last_sign_in')}</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">{t('settings.users.change_role')}</span></th>
            </tr></thead>
            <tbody className="divide-y divide-default">
              {users.map((user) => (
                <tr key={user.user_id}>
                  <td className="px-3 py-3">{user.display_name || user.email}</td>
                  <td className="px-3 py-3">{user.email}</td>
                  <td className="px-3 py-3">
                    <Select
                      aria-label={`${t('settings.users.change_role')}: ${user.email}`}
                      disabled={user.status !== 'ACTIVE'}
                      value={user.role_bundle}
                      onChange={(event) => {
                        const role = ROLE_OPTIONS.find((option) => option.value === event.currentTarget.value)?.value;
                        if (role !== undefined) void changeRole(user, role);
                      }}
                    >
                      {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </Select>
                  </td>
                  <td className="px-3 py-3">{t(STATUS_KEYS[user.status])}</td>
                  <td className="px-3 py-3">{user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : t('common.empty')}</td>
                  <td className="px-3 py-3 text-right">
                    {user.status === 'INVITED' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => { void resendInvitation(user); }}
                      >
                        {t('settings.users.resend_invitation')}
                      </Button>
                    ) : user.status === 'ACTIVE' ? (
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => setPendingDeactivation(user)}
                      >
                        {t('settings.users.deactivate')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {users.length === 0 ? <tr><td className="px-3 py-4 text-muted" colSpan={6}>{t('common.empty')}</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingDeactivation !== null}
        tone="danger"
        title={t('settings.users.deactivate_title')}
        description={t('settings.users.deactivate_body')}
        confirmLabel={t('settings.users.deactivate_confirm')}
        busy={busy}
        onConfirm={() => { void deactivate(); }}
        onCancel={() => setPendingDeactivation(null)}
      />
    </div>
  );
}
