import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../../auth/SessionProvider';

const mocks = vi.hoisted(() => ({
  getCompanyOwnerInputs: vi.fn(),
  resolveCompanyOwnerInput: vi.fn(),
  getTestingStatus: vi.fn(),
}));

vi.mock('../../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { DataTab } from './DataTab';

const session: AuthSession = {
  identity: { user_id: 'owner-1', email: 'owner@example.test', display_name: 'Chủ cửa hàng' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'admin', scope: 'company' },
  permissions: ['settings:manage'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

const itinerary = { input_id: 'careOnboardingItinerary', status: 'UNRESOLVED' as const, version: 1, resolved_at: null };

function renderTab() {
  return render(<SessionProvider session={session}><DataTab /></SessionProvider>);
}

beforeEach(() => {
  mocks.getCompanyOwnerInputs.mockResolvedValue({ items: [itinerary] });
  mocks.resolveCompanyOwnerInput.mockResolvedValue({ input: { ...itinerary, status: 'RESOLVED', version: 2, resolved_at: '2026-10-01T12:00:00.000Z' } });
  mocks.getTestingStatus.mockResolvedValue({ tenant_id: 'tenant-1', data_class: 'PRODUCTION', enabled: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DataTab', () => {
  it('shows an unresolved handoff itinerary and resolves it with its loaded version', async () => {
    const user = userEvent.setup();
    renderTab();

    const itineraryHeading = await screen.findByRole('heading', { name: t('settings.data.owner.label.careOnboardingItinerary') });
    const itineraryCard = itineraryHeading.closest('li');
    if (itineraryCard === null) throw new Error('Expected the itinerary list item');
    expect(within(itineraryCard).getByText(t('owner_input.state.unresolved'))).toBeTruthy();
    await user.click(within(itineraryCard).getByRole('button', { name: t('settings.data.owner.resolve') }));
    await user.clear(within(itineraryCard).getByLabelText(t('settings.data.owner.value')));
    await user.click(within(itineraryCard).getByLabelText(t('settings.data.owner.value')));
    await user.paste('{"handoff":"owner decision"}');
    await user.click(within(itineraryCard).getByRole('button', { name: t('settings.data.owner.save') }));

    await waitFor(() => expect(mocks.resolveCompanyOwnerInput).toHaveBeenCalledWith(
      'careOnboardingItinerary',
      { value: { handoff: 'owner decision' } },
      1,
    ));
    expect(await within(itineraryCard).findByText(t('owner_input.state.resolved'))).toBeTruthy();
    expect(mocks.getTestingStatus).not.toHaveBeenCalled();
  });

  it('requires credential values to be entered as a reference', async () => {
    const user = userEvent.setup();
    mocks.getCompanyOwnerInputs.mockResolvedValue({ items: [{ input_id: 'PROVIDER_CREDENTIALS', status: 'UNRESOLVED', version: 3, resolved_at: null }] });
    renderTab();

    const credentialHeading = await screen.findByRole('heading', { name: t('settings.data.owner.label.PROVIDER_CREDENTIALS') });
    const credentialCard = credentialHeading.closest('li');
    if (credentialCard === null) throw new Error('Expected the credentials list item');
    await user.click(within(credentialCard).getByRole('button', { name: t('settings.data.owner.resolve') }));
    expect(within(credentialCard).queryByLabelText(t('settings.data.owner.value'))).toBeNull();
    await user.type(within(credentialCard).getByLabelText(t('settings.data.owner.value_ref')), 'vault://provider/credential');
    await user.click(within(credentialCard).getByRole('button', { name: t('settings.data.owner.save') }));

    await waitFor(() => expect(mocks.resolveCompanyOwnerInput).toHaveBeenCalledWith(
      'PROVIDER_CREDENTIALS',
      { value_ref: 'vault://provider/credential' },
      3,
    ));
  });
});
