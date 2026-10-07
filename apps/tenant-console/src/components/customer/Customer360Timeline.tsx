/**
 * Unified chronological event timeline for SCR-004: Customer 360.
 * Queries R15 GET /api/v1/customers/{customer_id}/timeline with cursor pagination.
 * Visibly distinguishes FACT, SIGNAL, HYPOTHESIS, DECISION, ACTION per FR-C360-003.
 * Renders ONLY returned data with explicit loading, empty, gaps, and error states.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { ApiError } from '@agentos/ui-foundation';
import type { EvidenceClassification } from '@agentos/ui-foundation';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import type {
  TimelineEvent,
  TimelineGap,
  CustomerProfile,
  EvidenceCard,
} from './types';
import { EvidenceCardDrawer } from './EvidenceCardDrawer';
import { AdvancedDetails, StatusBadge } from '@agentos/ui-foundation/react';

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

interface Customer360TimelineProps {
  readonly initialCustomerId?: string | undefined;
}

export function Customer360Timeline({
  initialCustomerId = '',
}: Customer360TimelineProps) {
  const [customerId, setCustomerId] = useState<string>(initialCustomerId);

  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [events, setEvents] = useState<readonly TimelineEvent[]>([]);
  const [gaps, setGaps] = useState<readonly TimelineGap[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errorState, setErrorState] = useState<{
    readonly status?: number;
    readonly message: string;
    readonly type: 'permission_denied' | 'dependency_unavailable' | 'not_found' | 'fail_closed';
  } | null>(null);

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [focusedClassification, setFocusedClassification] = useState<EvidenceClassification | null>(
    null
  );

  // Sync prop changes
  useEffect(() => {
    if (initialCustomerId && initialCustomerId !== customerId) {
      setCustomerId(initialCustomerId);
    }
  }, [initialCustomerId, customerId]);

  // Normalize timeline item from R15 response. Drops malformed entries lacking stable fields.
  const normalizeEvent = (raw: Record<string, unknown>, index: number): TimelineEvent => {
    const rawEventId = raw.event_id ?? raw.eventId ?? raw.id;
    const eventId = rawEventId !== undefined && rawEventId !== null && String(rawEventId).trim()
      ? String(rawEventId).trim()
      : `event-${index}`;
    const rawOccurredAt = raw.occurred_at ?? raw.occurredAt ?? raw.timestamp;
    const occurredAt = rawOccurredAt !== undefined && rawOccurredAt !== null ? String(rawOccurredAt).trim() : '';
    const rawEventType = raw.canonical_event ?? raw.event_type ?? raw.eventType ?? raw.name;
    const eventType = rawEventType !== undefined && rawEventType !== null && String(rawEventType).trim()
      ? String(rawEventType).trim()
      : 'Sự kiện';
    const rawDomain = raw.domain ?? raw.module;
    const domain = rawDomain ? String(rawDomain).trim() : '';
    const stage = raw.stage ? String(raw.stage) : undefined;
    const summary = String(raw.summary || raw.description || raw.message || '');
    const sourceRecordId = raw.source_record_id ? String(raw.source_record_id) : raw.sourceRecordId ? String(raw.sourceRecordId) : undefined;

    let classification: EvidenceClassification | undefined;
    const rawClass = String(raw.classification || (raw.evidenceCard as Record<string, unknown>)?.classification || '').toUpperCase();
    if (rawClass === 'FACT' || rawClass === 'SIGNAL' || rawClass === 'HYPOTHESIS' || rawClass === 'DECISION' || rawClass === 'ACTION') {
      classification = rawClass;
    }

    let evidenceCard: EvidenceCard | undefined = undefined;
    const rawCard = (raw.evidence_card || raw.evidenceCard || raw.evidence) as Record<string, unknown> | undefined;
    if (rawCard && typeof rawCard === 'object') {
      const cardClass = String(rawCard.classification || classification || '').toUpperCase();
      const validClass: EvidenceClassification | undefined =
        cardClass === 'FACT' || cardClass === 'SIGNAL' || cardClass === 'HYPOTHESIS' || cardClass === 'DECISION' || cardClass === 'ACTION'
          ? (cardClass as EvidenceClassification)
          : undefined;

      if (validClass) {
        const rawRef = ((rawCard.raw_record_ref || rawCard.rawRecordRef) && typeof (rawCard.raw_record_ref || rawCard.rawRecordRef) === 'object'
          ? (rawCard.raw_record_ref || rawCard.rawRecordRef)
          : {}) as Record<string, unknown>;
        const rawEvidenceId = rawCard.evidence_id || rawCard.evidenceId;
        const evidenceId = rawEvidenceId ? String(rawEvidenceId) : eventId;
        const cardEventType = String(rawCard.event_type || rawCard.eventType || eventType);
        const sourceOfTruth = String(rawCard.source_of_truth || rawCard.sourceOfTruth || '');
        const confidenceScore =
          typeof rawCard.confidence_score === 'number'
            ? rawCard.confidence_score
            : typeof rawCard.confidenceScore === 'number'
            ? rawCard.confidenceScore
            : validClass === 'HYPOTHESIS' ? 0.0 : 1.0;

        evidenceCard = {
          evidenceId,
          eventId: String(rawCard.event_id || rawCard.eventId || eventId),
          eventType: cardEventType,
          classification: validClass,
          sourceOfTruth,
          confidenceScore,
          rawRecordRef: {
            system: rawRef.system ? String(rawRef.system) : '',
            externalId: rawRef.external_id ? String(rawRef.external_id) : rawRef.externalId ? String(rawRef.externalId) : sourceRecordId || '',
            verifiedAt: rawRef.verified_at ? String(rawRef.verified_at) : rawRef.verifiedAt ? String(rawRef.verifiedAt) : '',
          },
          payload: (rawCard.payload && typeof rawCard.payload === 'object' ? rawCard.payload : {}) as Record<string, unknown>,
        };
        classification = classification ?? validClass;
      }
    }

    const evidenceReference = raw.evidence_reference
      ? String(raw.evidence_reference)
      : raw.evidenceReference
      ? String(raw.evidenceReference)
      : undefined;

    return {
      eventId,
      domain,
      stage,
      eventType,
      summary,
      occurredAt,
      sourceRecordId,
      classification,
      evidenceCard,
      evidenceReference,
    };
  };


  // Fetch timeline from R15 GET /api/v1/customers/{customer_id}/timeline
  const fetchTimeline = useCallback(
    async (targetId: string, cursor?: string | null, append = false) => {
      if (!targetId.trim()) {
        setEvents([]);
        setGaps([]);
        setCustomerProfile(null);
        setNextCursor(null);
        setErrorState(null);
        return;
      }

      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        setErrorState(null);
      }

      try {
        const data = await tenantConsoleClient.getCustomerTimeline(targetId, {
          limit: 20,
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        });

        // Customer Profile info if provided by R15
        if (data.customer && typeof data.customer === 'object') {
          const c = data.customer as Record<string, unknown>;
          const custId = c.customer_id || c.customerId;
          if (custId) {
            const ltvRaw = (c.ltv || c.ltv_amount) as Record<string, unknown> | number | undefined;
            const aovRaw = (c.aov || c.aov_amount) as Record<string, unknown> | number | undefined;
            const ltvAmount = typeof ltvRaw === 'number' ? ltvRaw : ltvRaw && typeof ltvRaw.amount === 'number' ? ltvRaw.amount : ltvRaw && typeof ltvRaw.value === 'number' ? ltvRaw.value : undefined;
            const ltvCurrency = ltvRaw && typeof ltvRaw === 'object' && typeof ltvRaw.currency === 'string' ? ltvRaw.currency : typeof c.ltv_currency === 'string' ? c.ltv_currency : typeof c.ltv_twd === 'number' ? 'TWD' : undefined;
            const aovAmount = typeof aovRaw === 'number' ? aovRaw : aovRaw && typeof aovRaw.amount === 'number' ? aovRaw.amount : aovRaw && typeof aovRaw.value === 'number' ? aovRaw.value : undefined;
            const aovCurrency = aovRaw && typeof aovRaw === 'object' && typeof aovRaw.currency === 'string' ? aovRaw.currency : typeof c.aov_currency === 'string' ? c.aov_currency : typeof c.aov_twd === 'number' ? 'TWD' : undefined;
            setCustomerProfile({
              customerId: String(custId),
              ...(c.name ? { name: String(c.name) } : {}),
              ...(c.tier ? { tier: String(c.tier) } : {}),
              ...(ltvAmount !== undefined && ltvCurrency ? { ltv: { amount: ltvAmount, currency: ltvCurrency } } : {}),
              ...(aovAmount !== undefined && aovCurrency ? { aov: { amount: aovAmount, currency: aovCurrency } } : {}),
              ...(typeof c.ltv_twd === 'number' ? { ltvTwd: c.ltv_twd } : typeof c.ltvTwd === 'number' ? { ltvTwd: c.ltvTwd } : {}),
              ...(typeof c.aov_twd === 'number' ? { aovTwd: c.aov_twd } : typeof c.aovTwd === 'number' ? { aovTwd: c.aovTwd } : {}),
              ...(typeof c.churn_risk_score === 'number' ? { churnRiskScore: c.churn_risk_score } : typeof c.churnRiskScore === 'number' ? { churnRiskScore: c.churnRiskScore } : {}),
            });
          } else if (!append) {
            setCustomerProfile(null);
          }
        } else if (!append) {
          setCustomerProfile(null);
        }

        // Timeline events
        // Timeline events (R15 items or legacy events/entries)
        const rawEvents: Record<string, unknown>[] = Array.isArray(data.items)
          ? data.items
          : Array.isArray(data.events)
          ? data.events
          : Array.isArray(data.entries)
          ? data.entries
          : Array.isArray(data)
          ? data
          : [];

        const normalizedEvents = rawEvents.map((item, index) => normalizeEvent(item, index));

        if (append) {
          setEvents((prev) => [...prev, ...normalizedEvents]);
        } else {
          setEvents(normalizedEvents);
        }

        // Timeline gaps if instrumented
        // Timeline gaps if instrumented or detected in entries
        const explicitGaps: TimelineGap[] = Array.isArray(data.gaps)
          ? data.gaps.map((g: Record<string, unknown>, idx: number) => ({
              gapId: String(g.gap_id || g.gapId || `gap-${idx}`),
              from: String(g.from || g.start || ''),
              to: String(g.to || g.end || ''),
              reason: String(g.reason || 'Data gap in telemetry stream'),
            }))
          : [];
        const entryGaps: TimelineGap[] = [];
        for (let idx = 0; idx < rawEvents.length; idx++) {
          const item = rawEvents[idx];
          if (item && typeof item === 'object' && item.gap_reason) {
            entryGaps.push({
              gapId: String(item.event_id || `gap-entry-${idx}`),
              from: String(item.occurred_at || ''),
              to: String(item.occurred_at || ''),
              reason: String(item.gap_reason),
            });
          }
        }
        const combinedGaps = [...explicitGaps, ...entryGaps];
        if (combinedGaps.length > 0) {
          setGaps(combinedGaps);
        } else if (!append) {
          setGaps([]);
        }

        setNextCursor(data.next_cursor || data.nextCursor || null);
      } catch (err: unknown) {
        const status = err instanceof ApiError ? err.status : undefined;
        const message = err instanceof Error ? err.message : 'Failed to reach gateway';
        if (status === 403) {
          setErrorState({
            status,
            type: 'permission_denied',
            message: 'permission_denied: Cross-tenant or unverified private lookup refused.',
          });
        } else if (status === 404) {
          setErrorState({
            status,
            type: 'not_found',
            message: 'Customer ' + targetId + ' not found in this tenant.',
          });
        } else {
          setErrorState({
            ...(status === undefined ? {} : { status }),
            type: 'dependency_unavailable',
            message: 'fail_closed: ' + message,
          });
        }
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    if (customerId) {
      fetchTimeline(customerId);
    }
  }, [customerId, fetchTimeline]);


  const handleLoadMore = () => {
    if (nextCursor && customerId && !isLoadingMore) {
      fetchTimeline(customerId, nextCursor, true);
    }
  };

  // Collect all available evidence cards from events
  const allEvidenceCards = events
    .map((e) => e.evidenceCard)
    .filter((e): e is EvidenceCard => Boolean(e));

  const getDomainColor = (domain?: string) => {
    switch ((domain || '').toUpperCase()) {
      case 'MARKETING':
        return 'tenant-domain-badge--ai';
      case 'SALES':
        return 'tenant-domain-badge--info';
      case 'COMMERCE':
        return 'tenant-domain-badge--success';
      case 'SUPPORT':
        return 'tenant-domain-badge--warning';
      default:
        return 'tenant-domain-badge--neutral';
    }
  };

  const getClassificationBadge = (classification: EvidenceClassification) => {
    switch (classification) {
      case 'FACT':
        return {
          label: 'Đã xác thực',
          badge: 'tenant-evidence-badge--success',
          title: 'Verified record from System of Record (SoR)',
        };
      case 'SIGNAL':
        return {
          label: 'Tín hiệu',
          badge: 'tenant-evidence-badge--info',
          title: 'Direct observed telemetry; not interpreted',
        };
      case 'HYPOTHESIS':
        return {
          label: 'Dự đoán',
          badge: 'tenant-evidence-badge--warning',
          title: 'AI model inference; NEVER ground truth',
        };
      case 'DECISION':
        return {
          label: 'Quyết định',
          badge: 'tenant-evidence-badge--ai',
          title: 'Audited human or governance decision',
        };
      case 'ACTION':
        return {
          label: 'Hành động',
          badge: 'tenant-evidence-badge--success',
          title: 'Executed external effect',
        };
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="ui-section-card p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold text-ink">Customer 360</h1>
            <p className="mt-1 text-xs leading-5 text-muted">Verified customer timeline with five-tier evidence separation.</p>
          </div>
          {customerId ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-low px-3 py-2 text-xs">
              <span className="font-semibold text-ink">Verified customer record</span>
              <AdvancedDetails summary="Chi tiết kỹ thuật"><code className="font-mono text-muted">{customerId}</code></AdvancedDetails>
            </div>
          ) : <StatusBadge code="NO_DATA" label="Select a verified customer" />}
        </div>

        {/* Customer Profile Banner (only rendered when returned) */}
        {customerProfile && (
          <div className="tenant-customer-profile">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">
                {customerProfile.name || 'Customer'}
              </span>
              <AdvancedDetails summary="Chi tiết kỹ thuật"><span className="text-xs font-mono text-muted">customer_id: {customerProfile.customerId}</span></AdvancedDetails>
              {customerProfile.tier ? (
                <span className="tenant-evidence-badge tenant-evidence-badge--neutral">
                  Tier: {customerProfile.tier}
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-muted">
              {customerProfile.ltv ? (
                <span>
                  LTV: <strong className="text-ink">{formatMoney(customerProfile.ltv.amount, customerProfile.ltv.currency)}</strong>
                </span>
              ) : customerProfile.ltvTwd !== undefined ? (
                <span>
                  LTV: <strong className="text-ink">{customerProfile.ltvTwd.toLocaleString()} TWD</strong>
                </span>
              ) : null}
              {customerProfile.aov ? (
                <span>
                  AOV: <strong className="text-ink">{formatMoney(customerProfile.aov.amount, customerProfile.aov.currency)}</strong>
                </span>
              ) : customerProfile.aovTwd !== undefined ? (
                <span>
                  AOV: <strong className="text-ink">{customerProfile.aovTwd.toLocaleString()} TWD</strong>
                </span>
              ) : null}
              {customerProfile.churnRiskScore !== undefined ? (
                <span>
                  Churn Risk:{' '}
                  <strong className={customerProfile.churnRiskScore > 0.5 ? 'text-danger' : 'text-success'}>
                    {customerProfile.churnRiskScore}
                  </strong>
                </span>
              ) : null}

              <button
                type="button"
                onClick={() => {
                  setFocusedClassification(null);
                  setIsDrawerOpen(true);
                }}
                className="ui-button ui-button--secondary ui-button--sm"
              >
                Evidence Cards ({allEvidenceCards.length})
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Content View */}
      {!customerId ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface-low p-12 text-center">
          <p className="mb-1 text-sm font-semibold text-ink">No Customer Selected</p>
          <p className="text-xs font-mono text-muted">
            Select a verified customer from an authorized approval or conversation record. Direct URL customer IDs are ignored.
          </p>
        </div>
      ) : isLoading ? (
        <div className="rounded-2xl border border-line bg-surface p-12 text-center">
          <div className="mb-3 inline-block h-6 w-6 animate-spin rounded-full border-2 border-info border-t-transparent"></div>
          <p className="text-xs font-mono text-muted">
            loading: Fetching customer timeline from R15 GET /api/v1/customers/{customerId}/timeline…
          </p>
        </div>
      ) : errorState ? (
        <div
          className={`p-6 rounded-2xl border text-center ${
            errorState.type === 'permission_denied'
              ? 'bg-warning-bg border-warning-border text-warning'
              : 'bg-danger-bg border-danger-border text-danger'
          }`}
        >
          <p className="text-sm font-bold mb-1">
            {errorState.type === 'permission_denied'
              ? 'permission_denied: Access Refused'
              : errorState.type === 'not_found'
              ? 'Customer Not Found'
              : 'fail_closed: Timeline Retrieval Failed'}
          </p>
          <p className="text-xs font-mono mb-4 break-words">{errorState.message}</p>
          <button
            type="button"
            onClick={() => fetchTimeline(customerId)}
            className="ui-button ui-button--secondary rounded px-3.5 py-1.5 text-xs"
          >
            Retry Timeline Read
          </button>
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface-low p-12 text-center">
          <p className="mb-1 text-sm font-semibold text-ink">Timeline Empty</p>
          <p className="text-xs font-mono text-muted">
            empty: No recorded timeline events for customer {customerId}.
          </p>
        </div>
      ) : (
        /* Timeline Feed */
        <div className="tenant-timeline-panel">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-ink">
              Unified Chronological Timeline ({events.length} Events)
            </h2>
            <div className="flex items-center gap-2 text-[10px] font-mono text-muted">
              <span>Ordering: (occurred_at, source_record_id, event_id)</span>
            </div>
          </div>

          {/* Gaps Notice if present */}
          {gaps.length > 0 && (
            <div className="space-y-2">
              {gaps.map((gap) => (
                <div
                  key={gap.gapId}
                  className="flex items-center justify-between rounded-xl border border-dashed border-warning-border bg-warning-bg p-3 text-xs font-mono text-warning"
                >
                  <div>
                    <strong className="block text-[11px] uppercase">Timeline Gap Detected:</strong>
                    <span>
                      Missing telemetry from{' '}
                      {gap.from && !isNaN(Date.parse(gap.from))
                        ? new Date(gap.from).toLocaleString()
                        : gap.from || '—'}{' '}
                      to{' '}
                      {gap.to && !isNaN(Date.parse(gap.to))
                        ? new Date(gap.to).toLocaleString()
                        : gap.to || '—'}
                    </span>
                  </div>
                  <span className="text-[10px] text-warning/80">{gap.reason}</span>
                </div>
              ))}
            </div>
          )}

          {/* Event Items */}
          <div className="tenant-timeline-list">
            {events.map((evt) => {
              const classification = evt.classification;
              const classMeta = classification ? getClassificationBadge(classification) : null;
              const isFact = classification === 'FACT';
              const isHypothesis = classification === 'HYPOTHESIS';
              const isNonFact = classification !== undefined && !isFact;

              return (
                <div
                  key={evt.eventId}
                  className={`tenant-timeline-event ${
                    isHypothesis
                      ? 'tenant-timeline-event--hypothesis'
                      : isFact
                      ? 'tenant-timeline-event--fact'
                      : isNonFact
                      ? 'tenant-timeline-event--other'
                      : ''
                  }`}
                >
                  {/* Timeline bullet dot */}
                  <span
                    className={`absolute -left-1.5 top-1.5 w-3 h-3 rounded-full border-2 border-surface ${
                      isHypothesis ? 'bg-warning animate-pulse' : isFact ? 'bg-success' : 'bg-neutral'
                    }`}
                  ></span>

                  {/* Header row */}
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {evt.domain ? (
                      <span
                        className={`tenant-domain-badge ${getDomainColor(evt.domain)}`}
                      >
                        {evt.domain}
                      </span>
                    ) : null}

                    {evt.stage && (
                      <span className="rounded border border-line bg-neutral-bg px-1.5 py-0.5 text-[10px] font-mono text-muted">
                        {evt.stage}
                      </span>
                    )}

                    <span className="text-xs font-bold text-ink">{evt.eventType}</span>

                    <span
                      title={classMeta?.title ?? 'Phân loại chưa được xác định'}
                      className={`rounded border px-2 py-0.5 text-[10px] font-mono font-bold ${classMeta?.badge ?? 'border-neutral-border bg-neutral-bg text-muted'}`}
                    >
                      [{classMeta?.label ?? 'Chưa phân loại'}]
                    </span>

                    <span className="ml-auto text-[11px] font-mono text-muted">
                      {evt.occurredAt && Number.isFinite(Date.parse(evt.occurredAt)) ? new Date(evt.occurredAt).toLocaleString() : '—'}
                    </span>
                  </div>

                  {/* Hypothesis Warning: Visibly separate AI inference from ground truth */}
                  {isHypothesis && (
                    <div className="mb-2 inline-block rounded border border-warning-border bg-warning-bg px-2.5 py-1 text-[10px] font-mono text-warning">
                      AI MODEL INFERENCE: Subject to prediction variance; not factual ground truth.
                    </div>
                  )}

                  {/* Event summary */}
                  {evt.summary && <p className="mb-2 text-xs text-ink-body">{evt.summary}</p>}

                  {/* Evidence Card Snippet / Link */}
                  {evt.evidenceCard && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-low p-2.5 text-[11px] font-mono">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-muted">
                          Source: <strong className="text-ink">{evt.evidenceCard.sourceOfTruth}</strong>
                        </span>
                        <AdvancedDetails summary="Nguồn dữ liệu">
                          <span className="text-muted">system: {evt.evidenceCard.rawRecordRef.system || '—'} · external_id: {evt.evidenceCard.rawRecordRef.externalId || '—'}</span>
                        </AdvancedDetails>
                        {isHypothesis && (
                          <span className="font-bold text-warning">
                            Confidence: {Math.round(evt.evidenceCard.confidenceScore * 100)}%
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setFocusedClassification(evt.evidenceCard?.classification || null);
                          setIsDrawerOpen(true);
                        }}
                        className="text-[11px] font-semibold text-interactive underline hover:text-interactive-secondary"
                      >
                        Inspect Evidence Card →
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Cursor Pagination: Load More */}
          {nextCursor && (
            <div className="border-t border-line pt-4 text-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="ui-button ui-button--secondary rounded-lg px-4 py-2 text-xs disabled:opacity-50"
              >
                {isLoadingMore ? 'Loading Older Events…' : 'Load More Timeline Events (Cursor)'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Slide-out Drawer */}
      <EvidenceCardDrawer
        evidenceCards={allEvidenceCards}
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        focusedClassification={focusedClassification}
      />
    </div>
  );
}
