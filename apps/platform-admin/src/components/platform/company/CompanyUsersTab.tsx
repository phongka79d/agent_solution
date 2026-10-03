'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Button, ConfirmDialog, Field, Input, SectionHeader } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import {
  deactivateCompanyUser,
  inviteCompanyAdmin,
  listCompanyUsers,
  resendCompanyUserInvitation,
  type PlatformCompanyUser,
} from '../../../lib/platform-client';

export function maskCompanyEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex === email.length - 1) return '***';
  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  return `${localPart.slice(0, 1)}***@${domain}`;
}

export function CompanyUsersTab({ companyId, canManage }: { readonly companyId: string; readonly canManage: boolean }) {
  const [users, setUsers] = useState<readonly PlatformCompanyUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [email, setEmail] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [pendingDeactivation, setPendingDeactivation] = useState<PlatformCompanyUser | null>(null);
  const [notice, setNotice] = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setUsers(await listCompanyUsers(companyId));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    if (canManage) void loadUsers();
  }, [canManage, loadUsers]);

  const inviteAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusyUserId('invite');
    setActionError(false);
    setNotice('');
    try {
      await inviteCompanyAdmin(companyId, email.trim());
      setEmail('');
      setNotice(t('platform.users.invite_sent'));
      await loadUsers();
    } catch {
      setActionError(true);
    } finally {
      setBusyUserId(null);
    }
  };

  const resend = async (user: PlatformCompanyUser) => {
    setBusyUserId(user.user_id);
    setActionError(false);
    setNotice('');
    try {
      await resendCompanyUserInvitation(companyId, user.email, user.role_bundle);
      setNotice(t('platform.users.resend_sent'));
      await loadUsers();
    } catch {
      setActionError(true);
    } finally {
      setBusyUserId(null);
    }
  };

  const deactivate = async () => {
    if (pendingDeactivation === null) return;
    setBusyUserId(pendingDeactivation.user_id);
    setActionError(false);
    setNotice('');
    try {
      await deactivateCompanyUser(companyId, pendingDeactivation.user_id);
      setPendingDeactivation(null);
      setNotice(t('platform.users.deactivated'));
      await loadUsers();
    } catch {
      setActionError(true);
    } finally {
      setBusyUserId(null);
    }
  };

  if (!canManage) return <p className="text-sm text-muted" role="note">{t('platform.users.readonly')}</p>;

  return (
    <div className="space-y-5">
      <SectionHeader title={t('platform.users.title')} />
      <form className="grid gap-3 rounded-lg border border-default p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" onSubmit={inviteAdmin}>
        <Field label={t('platform.users.invite_email')}>
          <Input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
        </Field>
        <Button type="submit" disabled={busyUserId !== null}>{t('platform.users.invite')}</Button>
      </form>
      {notice ? <p className="text-sm text-success" role="status">{notice}</p> : null}
      {actionError ? <p className="text-sm text-danger" role="alert">{t('platform.users.action_error')}</p> : null}
      {loadError ? <p className="text-sm text-danger" role="alert">{t('settings.users.load_error')}</p> : null}
      {loading ? <p className="text-sm text-muted" aria-busy="true">{t('common.loading')}</p> : null}
      {!loading && !loadError ? (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead><tr className="border-b border-default text-xs text-muted">
              <th className="px-3 py-2 font-medium">{t('settings.users.name')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.users.email')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.users.role')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.users.status')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.users.last_sign_in')}</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">{t('platform.actions')}</span></th>
            </tr></thead>
            <tbody className="divide-y divide-default">
              {users.map((user) => (
                <tr key={user.user_id}>
                  <td className="px-3 py-3">{user.display_name || user.email}</td>
                  <td className="px-3 py-3">{maskCompanyEmail(user.email)}</td>
                  <td className="px-3 py-3">{t(`settings.users.role.${user.role_bundle.toLowerCase()}`)}</td>
                  <td className="px-3 py-3">{t(`settings.users.status.${user.status.toLowerCase()}`)}</td>
                  <td className="px-3 py-3">{user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : t('common.empty')}</td>
                  <td className="px-3 py-3 text-right">
                    {user.status === 'INVITED' ? (
                      <Button size="sm" variant="secondary" disabled={busyUserId !== null} onClick={() => void resend(user)}>
                        {t('platform.users.resend')}
                      </Button>
                    ) : null}
                    {user.status === 'ACTIVE' ? (
                      <Button size="sm" variant="danger" disabled={busyUserId !== null} onClick={() => setPendingDeactivation(user)}>
                        {t('platform.users.deactivate')}
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
        title={t('platform.users.deactivate_title')}
        description={t('platform.users.deactivate_body')}
        confirmLabel={t('platform.users.deactivate_confirm')}
        busy={busyUserId !== null}
        onConfirm={() => { void deactivate(); }}
        onCancel={() => setPendingDeactivation(null)}
      />
    </div>
  );
}
