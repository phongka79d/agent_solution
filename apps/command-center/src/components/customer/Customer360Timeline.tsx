/**
 * @file apps/command-center/src/components/customer/Customer360Timeline.tsx
 * Unified chronological event timeline for SCR-004: Customer 360.
 * Queries R15 GET /api/v1/customers/{customer_id}/timeline with cursor pagination.
 * Visibly distinguishes FACT, SIGNAL, HYPOTHESIS, DECISION, ACTION per FR-C360-003.
 * Renders ONLY returned data with explicit loading, empty, gaps, and error states.
 */
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { apiOrigin } from '../../lib/api-client';
import type {
  TimelineEvent,
  TimelineGap,
  CustomerProfile,
  EvidenceCard,
  EvidenceClassification,
} from './types';
import { EvidenceCardDrawer } from './EvidenceCardDrawer';

interface Customer360TimelineProps {
  readonly initialCustomerId?: string;
  readonly onCustomerIdChange?: (customerId: string) => void;
}

export function Customer360Timeline({
  initialCustomerId = '',
  onCustomerIdChange,
}: Customer360TimelineProps) {
  const [customerId, setCustomerId] = useState<string>(initialCustomerId);
  const [searchInput, setSearchInput] = useState<string>(initialCustomerId);

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
      setSearchInput(initialCustomerId);
    }
  }, [initialCustomerId, customerId]);

  // Normalize timeline item from R15 response. Drops malformed entries lacking stable fields.
  const normalizeEvent = (raw: Record<string, unknown>): TimelineEvent | null => {
    if (!raw || typeof raw !== 'object') return null;

    const rawEventId = raw.event_id ?? raw.eventId ?? raw.id;
    if (!rawEventId || (typeof rawEventId !== 'string' && typeof rawEventId !== 'number') || String(rawEventId).trim() === '') {
      return null;
    }
    const eventId = String(rawEventId).trim();

    const rawOccurredAt = raw.occurred_at ?? raw.occurredAt ?? raw.timestamp;
    if (!rawOccurredAt || (typeof rawOccurredAt !== 'string' && typeof rawOccurredAt !== 'number') || String(rawOccurredAt).trim() === '') {
      return null;
    const occurredAt = String(rawOccurredAt).trim();
    if (isNaN(Date.parse(occurredAt))) {
      return null;
    }
    const rawEventType = raw.event_type ?? raw.eventType ?? raw.name;
    if (!rawEventType || String(rawEventType).trim() === '') {
      return null;
    }
    const eventType = String(rawEventType).trim();

    const rawDomain = raw.domain ?? raw.module;
    const domain = rawDomain ? String(rawDomain).trim() : '';
    const stage = raw.stage ? String(raw.stage) : undefined;
    const summary = String(raw.summary || raw.description || raw.message || '');
    const sourceRecordId = raw.source_record_id ? String(raw.source_record_id) : raw.sourceRecordId ? String(raw.sourceRecordId) : undefined;

    let classification: EvidenceClassification | undefined = undefined;
    const rawClass = String(raw.classification || (raw.evidenceCard as Record<string, unknown>)?.classification || '');
    if (rawClass === 'FACT' || rawClass === 'SIGNAL' || rawClass === 'HYPOTHESIS' || rawClass === 'DECISION' || rawClass === 'ACTION') {
      classification = rawClass;
    }

    let evidenceCard: EvidenceCard | undefined = undefined;
    const rawCard = (raw.evidence_card || raw.evidenceCard || raw.evidence) as Record<string, unknown> | undefined;
    if (rawCard && typeof rawCard === 'object') {
      const cardClass = String(rawCard.classification || classification || '');
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
            : (validClass === 'HYPOTHESIS' ? 0.0 : 1.0);

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

        if (!classification) {
          classification = validClass;
        }
      }
    }

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
        const origin = apiOrigin();
        let url = `${origin}/api/v1/customers/${encodeURIComponent(targetId)}/timeline?limit=20`;
        if (cursor) {
          url += `&cursor=${encodeURIComponent(cursor)}`;
        }

        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!res.ok) {
          let errMsg = `Request failed: HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson.message) errMsg = errJson.message;
          } catch {
            // fallback
          }

          if (res.status === 403) {
            setErrorState({
              status: 403,
              type: 'permission_denied',
              message:
                'permission_denied: Cross-tenant or unverified private lookup refused. An authorized operator with a verified customer binding is required.',
            });
          } else if (res.status === 404) {
            setErrorState({
              status: 404,
              type: 'not_found',
              message: `Customer ${targetId} not found in this tenant.`,
            });
          } else {
            setErrorState({
              status: res.status,
              type: 'fail_closed',
              message: `dependency_unavailable: ${errMsg}`,
            });
          }
          return;
        }

        const data = await res.json();

        // Customer Profile info if provided by R15
        if (data.customer && typeof data.customer === 'object') {
          const c = data.customer as Record<string, unknown>;
          const custId = c.customer_id || c.customerId;
          if (custId) {
            setCustomerProfile({
              customerId: String(custId),
              name: c.name ? String(c.name) : undefined,
              tier: c.tier ? String(c.tier) : undefined,
              ltvTwd: typeof c.ltv_twd === 'number' ? c.ltv_twd : typeof c.ltvTwd === 'number' ? c.ltvTwd : undefined,
              aovTwd: typeof c.aov_twd === 'number' ? c.aov_twd : typeof c.aovTwd === 'number' ? c.aovTwd : undefined,
              churnRiskScore: typeof c.churn_risk_score === 'number' ? c.churn_risk_score : typeof c.churnRiskScore === 'number' ? c.churnRiskScore : undefined,
            });
          } else if (!append) {
            setCustomerProfile(null);
          }
        } else if (!append) {
          setCustomerProfile(null);
        }

        // Timeline events
        const rawEvents: Record<string, unknown>[] = Array.isArray(data.events)
          ? data.events
          : Array.isArray(data)
          ? data
          : [];

        const normalizedEvents = rawEvents
          .map(normalizeEvent)
          .filter((e): e is TimelineEvent => e !== null);

        if (append) {
          setEvents((prev) => [...prev, ...normalizedEvents]);
        } else {
          setEvents(normalizedEvents);
        }

        // Timeline gaps if instrumented
        if (Array.isArray(data.gaps)) {
          const mappedGaps: TimelineGap[] = data.gaps.map((g: Record<string, unknown>, idx: number) => ({
            gapId: String(g.gap_id || g.gapId || `gap-${idx}`),
            from: String(g.from || g.start || ''),
            to: String(g.to || g.end || ''),
            reason: String(g.reason || 'Data gap in telemetry stream'),
          }));
          setGaps(mappedGaps);
        } else if (!append) {
          setGaps([]);
        }

        setNextCursor(data.next_cursor || data.nextCursor || null);
      } catch (err: unknown) {
        setErrorState({
          type: 'dependency_unavailable',
          message: `fail_closed: ${(err as Error).message || 'Failed to reach gateway'}`,
        });
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

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchInput.trim();
    if (trimmed && trimmed !== customerId) {
      setCustomerId(trimmed);
      if (onCustomerIdChange) {
        onCustomerIdChange(trimmed);
      }
    }
  };

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
        return 'text-purple-300 border-purple-800 bg-purple-950/60';
      case 'SALES':
        return 'text-blue-300 border-blue-800 bg-blue-950/60';
      case 'COMMERCE':
        return 'text-emerald-300 border-emerald-800 bg-emerald-950/60';
      case 'SUPPORT':
        return 'text-amber-300 border-amber-800 bg-amber-950/60';
      default:
        return 'text-slate-300 border-slate-700 bg-slate-900';
    }
  };

  const getClassificationBadge = (classification: EvidenceClassification) => {
    switch (classification) {
      case 'FACT':
        return {
          label: 'FACT',
          badge: 'bg-emerald-950/80 text-emerald-300 border-emerald-700',
          title: 'Verified record from System of Record (SoR)',
        };
      case 'SIGNAL':
        return {
          label: 'SIGNAL',
          badge: 'bg-sky-950/80 text-sky-300 border-sky-700',
          title: 'Direct observed telemetry; not interpreted',
        };
      case 'HYPOTHESIS':
        return {
          label: 'HYPOTHESIS',
          badge: 'bg-amber-950/90 text-amber-300 border-amber-600 animate-pulse',
          title: 'AI model inference; NEVER ground truth',
        };
      case 'DECISION':
        return {
          label: 'DECISION',
          badge: 'bg-violet-950/80 text-violet-300 border-violet-700',
          title: 'Audited human or governance decision',
        };
      case 'ACTION':
        return {
          label: 'ACTION',
          badge: 'bg-teal-950/80 text-teal-300 border-teal-700',
          title: 'Executed external effect',
        };
    }
  };

  return (
    <div className="space-y-6">
      {/* Search & Header */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-100">SCR-004: Customer 360</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Ten-stage unified timeline & five-tier evidence separation (FR-C360-003).
            </p>
          </div>

          {/* Customer Search Bar */}
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2 w-full md:w-auto">
            <div className="relative flex-1 md:w-72">
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Enter customer ID (e.g. CUST-TW-88219)"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 outline-none focus:border-sky-500"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !searchInput.trim()}
              className="px-3.5 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
            >
              Lookup
            </button>
          </form>
        </div>

        {/* Customer Profile Banner (only rendered when returned) */}
        {customerProfile && (
          <div className="mt-4 pt-4 border-t border-slate-800/80 flex flex-wrap justify-between items-center gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-sm text-slate-100">
                {customerProfile.name || 'Customer'}
              </span>
              <span className="text-xs font-mono text-slate-400">
                ({customerProfile.customerId})
              </span>
              {customerProfile.tier && (
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700 rounded">
                  Tier: {customerProfile.tier}
                </span>
              )}
            </div>

            <div className="flex items-center gap-4 text-xs font-mono text-slate-400 flex-wrap">
              {customerProfile.ltvTwd !== undefined && (
                <span>
                  LTV: <strong className="text-slate-200">{customerProfile.ltvTwd.toLocaleString()} TWD</strong>
                </span>
              )}
              {customerProfile.aovTwd !== undefined && (
                <span>
                  AOV: <strong className="text-slate-200">{customerProfile.aovTwd.toLocaleString()} TWD</strong>
                </span>
              )}
              {customerProfile.churnRiskScore !== undefined && (
                <span>
                  Churn Risk:{' '}
                  <strong
                    className={
                      customerProfile.churnRiskScore > 0.5 ? 'text-rose-400' : 'text-emerald-400'
                    }
                  >
                    {customerProfile.churnRiskScore}
                  </strong>
                </span>
              )}

              <button
                type="button"
                onClick={() => {
                  setFocusedClassification(null);
                  setIsDrawerOpen(true);
                }}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-750 text-sky-400 border border-slate-700 rounded text-xs font-semibold transition-colors"
              >
                Evidence Cards ({allEvidenceCards.length})
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Content View */}
      {!customerId ? (
        <div className="p-12 text-center bg-slate-900/30 border border-dashed border-slate-800 rounded-2xl">
          <p className="text-sm font-semibold text-slate-300 mb-1">No Customer Selected</p>
          <p className="text-xs text-slate-500 font-mono">
            Enter a customer ID in the search box above or pass ?customer_id=... in the URL.
          </p>
        </div>
      ) : isLoading ? (
        <div className="p-12 text-center bg-slate-900/60 border border-slate-800 rounded-2xl">
          <div className="inline-block w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin mb-3"></div>
          <p className="text-xs text-slate-400 font-mono">
            loading: Fetching customer timeline from R15 GET /api/v1/customers/{customerId}/timeline…
          </p>
        </div>
      ) : errorState ? (
        <div
          className={`p-6 rounded-2xl border text-center ${
            errorState.type === 'permission_denied'
              ? 'bg-amber-950/40 border-amber-800 text-amber-200'
              : 'bg-rose-950/30 border-rose-800 text-rose-300'
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
            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 rounded text-xs font-semibold transition-colors"
          >
            Retry Timeline Read
          </button>
        </div>
      ) : events.length === 0 ? (
        <div className="p-12 text-center bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl">
          <p className="text-sm font-semibold text-slate-300 mb-1">Timeline Empty</p>
          <p className="text-xs text-slate-500 font-mono">
            empty: No recorded timeline events for customer {customerId}.
          </p>
        </div>
      ) : (
        /* Timeline Feed */
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-6">
          <div className="flex justify-between items-center pb-3 border-b border-slate-800">
            <h2 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Unified Chronological Timeline ({events.length} Events)
            </h2>
            <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
              <span>Ordering: (occurred_at, source_record_id, event_id)</span>
            </div>
          </div>

          {/* Gaps Notice if present */}
          {gaps.length > 0 && (
            <div className="space-y-2">
              {gaps.map((gap) => (
                <div
                  key={gap.gapId}
                  className="p-3 bg-amber-950/30 border border-dashed border-amber-800/80 rounded-xl text-xs font-mono text-amber-300 flex items-center justify-between"
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
                  <span className="text-[10px] text-amber-400/80">{gap.reason}</span>
                </div>
              ))}
            </div>
          )}

          {/* Event Items */}
          <div className="relative border-l border-slate-800 ml-4 space-y-6">
            {events.map((evt) => {
              const classification = evt.classification;
              const classMeta = classification ? getClassificationBadge(classification) : null;
              const isHypothesis = classification === 'HYPOTHESIS';

              return (
                <div
                  key={evt.eventId}
                  className={`relative pl-6 transition-all ${
                    isHypothesis
                      ? 'p-3 bg-amber-950/20 border border-amber-800/50 rounded-xl ml-2'
                      : ''
                  }`}
                >
                  {/* Timeline bullet dot */}
                  <span
                    className={`absolute -left-1.5 top-1.5 w-3 h-3 rounded-full border-2 border-slate-900 ${
                      isHypothesis ? 'bg-amber-400 animate-pulse' : 'bg-slate-600'
                    }`}
                  ></span>

                  {/* Header row */}
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {evt.domain ? (
                      <span
                        className={`px-2 py-0.5 text-[10px] font-mono font-semibold rounded border ${getDomainColor(
                          evt.domain
                        )}`}
                      >
                        {evt.domain}
                      </span>
                    ) : null}

                    {evt.stage && (
                      <span className="px-1.5 py-0.5 text-[10px] font-mono text-slate-300 bg-slate-800 rounded border border-slate-700">
                        {evt.stage}
                      </span>
                    )}

                    <span className="text-xs font-bold text-slate-100">{evt.eventType}</span>

                    {/* Exact Single Evidence Badge (FACT/SIGNAL/HYPOTHESIS/DECISION/ACTION) */}
                    {classMeta && (
                      <span
                        title={classMeta.title}
                        className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${classMeta.badge}`}
                      >
                        [{classMeta.label}]
                      </span>
                    )}

                    <span className="text-[11px] text-slate-400 font-mono ml-auto">
                      {new Date(evt.occurredAt).toLocaleString()}
                    </span>
                  </div>

                  {/* Hypothesis Warning: Visibly separate AI inference from ground truth */}
                  {isHypothesis && (
                    <div className="mb-2 text-[10px] font-mono text-amber-300 bg-amber-950/50 px-2.5 py-1 rounded border border-amber-700/60 inline-block">
                      AI MODEL INFERENCE: Subject to prediction variance; not factual ground truth.
                    </div>
                  )}

                  {/* Event summary */}
                  {evt.summary && <p className="text-xs text-slate-300 mb-2">{evt.summary}</p>}

                  {/* Evidence Card Snippet / Link */}
                  {evt.evidenceCard && (
                    <div className="mt-2 text-[11px] font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800 flex justify-between items-center gap-2 flex-wrap">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-slate-400">
                          Source: <strong className="text-slate-200">{evt.evidenceCard.sourceOfTruth}</strong>
                        </span>
                        <span className="text-slate-400">
                          Ref: <strong className="text-sky-400">{evt.evidenceCard.rawRecordRef.externalId}</strong>
                        </span>
                        {isHypothesis && (
                          <span className="text-amber-400 font-bold">
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
                        className="text-[11px] text-sky-400 hover:text-sky-300 underline font-semibold"
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
            <div className="pt-4 text-center border-t border-slate-800">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
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
