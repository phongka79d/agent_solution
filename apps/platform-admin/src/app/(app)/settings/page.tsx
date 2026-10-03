import {
  SettingsPage as SettingsContent,
  type SettingsFeatureFlag,
} from '../../../components/platform/SettingsPage';
import { SESSION_TTL_SECONDS } from '../../../lib/auth/session';

export const metadata = {
  title: 'Settings | AgentOS Platform',
  description: 'Account, administrators, skill catalog, feature flags and session policy.',
};

const featureFlags: readonly SettingsFeatureFlag[] = [
  {
    key: 'PLATFORM_FEATURE_SUBSCRIPTIONS',
    labelKey: 'platform.feature_subscriptions',
    enabled: process.env.PLATFORM_FEATURE_SUBSCRIPTIONS === 'true',
  },
];

export default function SettingsRoute() {
  return (
    <SettingsContent
      authProvider={process.env.AUTH_PROVIDER === 'db' ? 'db' : 'demo'}
      sessionTtlSeconds={SESSION_TTL_SECONDS}
      featureFlags={featureFlags}
    />
  );
}
