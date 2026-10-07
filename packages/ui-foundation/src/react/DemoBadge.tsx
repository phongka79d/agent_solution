import type { StatusBadgeProps } from './StatusBadge.js';
import { StatusBadge } from './StatusBadge.js';

export type DemoBadgeProps = Omit<StatusBadgeProps, 'code' | 'tone'>;

export function DemoBadge(props: DemoBadgeProps) {
  return <StatusBadge {...props} code="DEMO_MOCK" />;
}
