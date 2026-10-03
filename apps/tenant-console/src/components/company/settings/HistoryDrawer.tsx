'use client';

import { can } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { Button, Drawer, EmptyState, ErrorState, LoadingState } from '@agentos/ui-foundation/react';
import { useCallback, useEffect, useState } from 'react';

import type { CompanyAuditEvent } from '../../../lib/tenant-console-client';
import { tenantConsoleClient } from '../../../lib/tenant-console-client';
import { useSession } from '../../auth/SessionProvider';

interface HistoryDrawerProps {
  readonly scope: string;
}

function formatTime(value: string): string {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? '—' : instant.toLocaleString();
}

function formatAuditState(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? '—';
  } catch {
    return '—';
  }
}

export function HistoryDrawer({ scope }: HistoryDrawerProps) {
  const session = useSession();
  const allowed = can(session, 'settings:manage');
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<readonly CompanyAuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await tenantConsoleClient.getCompanyAudit({ limit: 25, scope });
      setEvents(Array.isArray(page.items) ? page.items : []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (open && allowed) void load();
  }, [open, allowed, load]);

  if (!allowed) return null;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{t('settings.action.history')}</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t('settings.history.title')}>
        <div className="space-y-4">
          {failed ? <ErrorState message={t('settings.history.load_error')} onRetry={() => void load()} /> : null}
          {loading ? <LoadingState label={t('common.loading')} /> : null}
          {!loading && !failed && events.length === 0 ? <EmptyState title={t('settings.history.empty')} status="NO_DATA" /> : null}
          {!loading && !failed && events.length > 0 ? (
            <ol className="space-y-3">
              {events.map((event) => (
                <li key={event.event_id} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <strong className="text-sm text-ink">{event.action}</strong>
                    <time className="text-xs text-muted" dateTime={event.created_at}>{formatTime(event.created_at)}</time>
                  </div>
                  <dl className="mt-2 space-y-1 text-sm">
                    <div><dt className="inline text-muted">{t('settings.history.actor')}: </dt><dd className="inline text-ink">{event.actor_id} ({event.actor_kind})</dd></div>
                    {event.target ? <div><dt className="inline text-muted">{t('settings.history.target')}: </dt><dd className="inline text-ink">{event.target}</dd></div> : null}
                    {event.reason ? <div><dt className="inline text-muted">{t('settings.history.reason')}: </dt><dd className="inline text-ink">{event.reason}</dd></div> : null}
                    <div>
                      <dt className="text-muted">{t('settings.history.before')}</dt>
                      <dd><pre className="mt-1 max-h-32 overflow-auto rounded bg-surface-muted p-2 font-mono text-xs text-ink">{formatAuditState(event.before_state)}</pre></dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t('settings.history.after')}</dt>
                      <dd><pre className="mt-1 max-h-32 overflow-auto rounded bg-surface-muted p-2 font-mono text-xs text-ink">{formatAuditState(event.after_state)}</pre></dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          ) : null}
          {!loading && !failed ? <Button variant="secondary" size="sm" onClick={() => void load()}>{t('settings.action.reload')}</Button> : null}
        </div>
      </Drawer>
    </>
  );
}
