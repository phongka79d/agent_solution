import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOperationsConsole } from './AgentOperationsConsole';
import { RetryRunModal } from './RetryRunModal';
import type { AgentRunProjection } from './types';
const mocks = vi.hoisted(() => ({ getRuns: vi.fn(), retryRun: vi.fn() }));
vi.mock('../../lib/admin-operations-client', () => ({ adminOperationsClient: mocks }));

const { getRuns, retryRun } = mocks;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const run = (id: string): AgentRunProjection => ({ run_id: id, agent_id: 'agent', state: 'completed', task_version: 1, retry_count: 0, last_error_class: null });

describe('operations regressions', () => {
  beforeEach(() => { getRuns.mockReset(); retryRun.mockReset(); });

  it('appends cursor pages instead of replacing the first page', async () => {
    getRuns.mockResolvedValueOnce({ items: [run('first-run')], next_cursor: 'cursor-2', total_count: 2 }).mockResolvedValueOnce({ items: [run('second-run')], next_cursor: null, total_count: 2 });
    const user = userEvent.setup();
    render(<AgentOperationsConsole />);
    await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /Next Page/ }));
    await waitFor(() => expect(screen.getByText('second-r...')).toBeTruthy());
    expect(screen.getByText('first-ru...')).toBeTruthy();
  });

  it('does not report retry success when the API rejects', async () => {
    retryRun.mockRejectedValue(new Error('API failed'));
    const onSuccess = vi.fn();
    render(<RetryRunModal run={{ ...run('failed-run'), state: 'failed', last_error_class: 'FAIL_CLOSED' }} isOpen onClose={vi.fn()} onSuccess={onSuccess} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Execute Retry' }));
    await waitFor(() => expect(screen.getByText('API failed')).toBeTruthy());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText(/Task accepted/)).toBeNull();
  });
});
