import { SettingsPage as SettingsContent } from '../../../components/platform/PlatformPages';

export const metadata = {
  title: 'Settings | AgentOS Platform',
  description: 'Account and read-only platform configuration.',
};

export default function SettingsRoute() {
  return <SettingsContent />;
}
