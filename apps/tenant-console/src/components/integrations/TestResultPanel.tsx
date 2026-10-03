'use client';

import { t } from '@agentos/ui-foundation/i18n';
import { AdvancedDetails, KeyValueList, Skeleton, StatusBadge } from '@agentos/ui-foundation/react';
import { statusView } from '@agentos/ui-foundation/status';

import type { ConnectorProbeResult } from '../../lib/types/tenant-console';
import { checkErrorKey, PROBE_LABEL_KEYS, OTHER_PROBE_LABEL_KEY } from './groups';

export interface TestResultPanelProps {
  readonly result: ConnectorProbeResult | null;
  readonly pending: boolean;
  readonly error: unknown;
}

/** Renders the catalog-declared checks; raw probe codes stay inside "Chi tiết kỹ thuật". */
export function TestResultPanel({ result, pending, error }: TestResultPanelProps) {
  if (pending) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">{t('integrations.test.running')}</p>
        <Skeleton variant="text" lines={2} />
      </div>
    );
  }
  if (error !== null && error !== undefined) {
    return <p className="text-sm text-red-700">{t('integrations.test.failed_summary')}</p>;
  }
  if (result === null) return null;

  const passed = result.outcome === 'PASS';
  return (
    <div className="space-y-3" data-testid="integration-test-results">
      <p className={['text-sm font-medium', passed ? 'text-emerald-700' : 'text-red-700'].join(' ')}>
        {passed ? t('integrations.test.passed_summary') : t('integrations.test.failed_summary')}
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {result.checks.map((check) => {
          const view = statusView('probe', check.outcome);
          const reasonKey = checkErrorKey(check);
          return (
            <li key={check.probe} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="flex flex-col">
                <span className="text-sm text-ink">{t(PROBE_LABEL_KEYS[check.probe] ?? OTHER_PROBE_LABEL_KEY)}</span>
                {reasonKey !== null ? <span className="text-xs text-red-700">{t(reasonKey)}</span> : null}
              </div>
              <div className="flex items-center gap-3">
                {check.latency_ms !== null && check.latency_ms > 0 ? (
                  <span className="text-xs text-muted">{`${t('integrations.test.latency')}: ${check.latency_ms}`}</span>
                ) : null}
                <StatusBadge tone={view.tone} label={t(view.label_key)} />
              </div>
            </li>
          );
        })}
      </ul>
      <AdvancedDetails summary={t('integrations.action.advanced')}>
        <KeyValueList
          items={result.checks.map((check) => ({
            key: check.probe,
            label: check.probe,
            value: [
              `outcome=${check.outcome}`,
              check.http_status === null ? 'http_status=null' : `http_status=${check.http_status}`,
              check.error_class === null ? 'error_class=null' : `error_class=${check.error_class}`,
            ].join(' · '),
          }))}
        />
      </AdvancedDetails>
    </div>
  );
}
