import { notFound } from 'next/navigation';
import { SubscriptionsPage } from '../../../components/platform/PlatformPages';
export const metadata = { title: 'Subscriptions | AgentOS Platform' };
export default function SubscriptionsRoute() {
  if (process.env.PLATFORM_FEATURE_SUBSCRIPTIONS !== 'true') notFound();
  return <SubscriptionsPage />;
}
