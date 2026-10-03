import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notFound: vi.fn((): never => { throw new Error('NEXT_NOT_FOUND'); }),
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));

import SubscriptionsRoute from './page';

const originalFlag = process.env.PLATFORM_FEATURE_SUBSCRIPTIONS;

afterEach(() => {
  cleanup();
  if (originalFlag === undefined) delete process.env.PLATFORM_FEATURE_SUBSCRIPTIONS;
  else process.env.PLATFORM_FEATURE_SUBSCRIPTIONS = originalFlag;
  vi.clearAllMocks();
});

describe('SubscriptionsRoute', () => {
  it('returns not found while subscriptions are disabled', () => {
    delete process.env.PLATFORM_FEATURE_SUBSCRIPTIONS;

    expect(() => SubscriptionsRoute()).toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it('renders subscriptions when the feature is enabled', () => {
    process.env.PLATFORM_FEATURE_SUBSCRIPTIONS = 'true';

    render(<SubscriptionsRoute />);

    expect(screen.getByRole('heading', { name: 'Gói dịch vụ' })).toBeTruthy();
  });
});
