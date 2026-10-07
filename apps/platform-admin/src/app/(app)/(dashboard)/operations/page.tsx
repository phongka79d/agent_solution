/**
 * SCR-002: Agent Operations Console route.
 */

import { AgentOperationsConsole } from '../../../../components/operations/AgentOperationsConsole';

export const metadata = {
  title: 'Operations | AgentOS Platform',
  description: 'Tenant-scoped run history, trace inspection, and safe retry controls.',
};

export default function OperationsPage() {
  return <AgentOperationsConsole />;
}
