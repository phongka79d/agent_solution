import { t } from '@agentos/ui-foundation/i18n';
import type { CompanyActivityItem } from '../../lib/types/tenant-console';

const ACTIVITY_KEYS: Readonly<Record<string, string>> = {
  RUN_COMPLETED: 'overview.activity.run_completed',
  RUN_STAGE_ENTERED: 'overview.activity.run_stage_entered',
  APPROVAL_DECIDED: 'overview.activity.approval_decided',
  RUN_FAILED: 'overview.activity.run_failed',
  RUN_NEEDS_RECONCILIATION: 'overview.activity.run_needs_reconciliation',
  RUN_WAITING_FOR_APPROVAL: 'overview.activity.run_waiting_for_approval',
  RUN_STOPPED: 'overview.activity.run_stopped',
  RUN_OUTCOME: 'overview.activity.run_outcome',
};

/** Business copy uses the localized team, never technical run IDs from sentence params. */
export function companyActivitySentence(item: Pick<CompanyActivityItem, 'kind' | 'domain'>): string {
  const agent = item.domain === 'marketing' || item.domain === 'sales' || item.domain === 'care'
    ? t(`aiTeam.${item.domain}.name`)
    : t('nav.overview');
  return t(ACTIVITY_KEYS[item.kind] ?? 'overview.activity.other', { agent });
}
