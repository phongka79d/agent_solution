import { cleanup, render, screen } from '@testing-library/react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionProvider } from '../../auth/SessionProvider';
import { SecurityTab } from './SecurityTab';

const session: AuthSession = {
  identity: { user_id: 'user-1', email: 'user@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'admin', scope: 'company' },
  permissions: ['settings:manage'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

afterEach(cleanup);

describe('SecurityTab', () => {
  it('shows the current session expiry and clearly marks unavailable session controls', () => {
    render(<SessionProvider session={session}><SecurityTab /></SessionProvider>);

    expect(screen.getByText(new Date(session.expires_at).toLocaleString())).toBeTruthy();
    expect(screen.getByText(t('settings.security.active_sessions_unavailable'))).toBeTruthy();
    expect(screen.getByText(t('settings.security.other_sessions_note'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('settings.security.other_sessions') })).toBeNull();
  });
});
