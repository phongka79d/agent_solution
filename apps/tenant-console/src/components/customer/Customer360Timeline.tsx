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
import type { CustomerTimelineEntry } from '../../lib/types/tenant-console';
import type { TimelineEvent, TimelineGap } from './types';
import { AdvancedDetails, StatusBadge } from '@agentos/ui-foundation/react';


// Codes from the event stream and the five-source Customer 360 projection are technical data.
// Keep their Vietnamese presentation separate so an unknown code never becomes a visible label.
const TIMELINE_LABELS: Readonly<Record<string, string>> = {
  event: 'Sự kiện',
  conversation: 'Hội thoại',
  order: 'Đơn hàng',
  campaign_engagement: 'Tương tác chiến dịch',
  service_case: 'Yêu cầu hỗ trợ',
  marketing: 'Tiếp thị',
  sales: 'Bán hàng',
  commerce: 'Thương mại',
  care: 'Chăm sóc khách hàng',
  support: 'Hỗ trợ',
  orchestrator: 'Điều phối',
  session: 'Phiên truy cập',
  'session.start': 'Bắt đầu phiên truy cập',
  'session.end': 'Kết thúc phiên truy cập',
  view: 'Xem',
  product_view: 'Xem sản phẩm',
  'product.view': 'Xem sản phẩm',
  search: 'Tìm kiếm',
  'search.query': 'Tìm kiếm',
  click: 'Nhấp chuột',
  'element.click': 'Nhấp chuột',
  chat: 'Trò chuyện',
  message_received: 'Nhận tin nhắn',
  'message.received': 'Nhận tin nhắn',
  add_to_cart: 'Thêm vào giỏ hàng',
  'add to cart': 'Thêm vào giỏ hàng',
  cart_add: 'Thêm vào giỏ hàng',
  'cart.add': 'Thêm vào giỏ hàng',
  'cart.remove': 'Xóa khỏi giỏ hàng',
  checkout: 'Thanh toán',
  'checkout.start': 'Bắt đầu thanh toán',
  purchase: 'Mua hàng',
  'order.placed': 'Đặt hàng',
  order_placed: 'Đặt hàng',
  delivery: 'Giao hàng',
  review: 'Đánh giá',
  repurchase: 'Mua lại',
  quote_accepted: 'Chấp nhận báo giá',
  ticket_resolved_fcr: 'Giải quyết yêu cầu ngay lần đầu',
  web: 'Trò chuyện trên web',
  web_chat: 'Trò chuyện trên web',
  email: 'Thư điện tử',
  sms: 'Tin nhắn điện thoại',
  phone: 'Cuộc gọi',
  zalo: 'Zalo',
  messenger: 'Messenger',
  whatsapp: 'WhatsApp',
  line: 'Line',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  pos: 'Cửa hàng',
  open: 'Đang mở',
  paused_takeover: 'Nhân viên đang tiếp quản',
  closed: 'Đã đóng',
  draft: 'Bản nháp',
  pending_payment: 'Chờ thanh toán',
  paid: 'Đã thanh toán',
  fulfilled: 'Đã hoàn tất',
  cancelled: 'Đã hủy',
  new: 'Mới tiếp nhận',
  classified: 'Đã phân loại',
  assigned: 'Đã phân công',
  in_progress: 'Đang xử lý',
  waiting_customer: 'Chờ khách hàng phản hồi',
  resolved: 'Đã giải quyết',
};

function timelineLabel(code: string, fallback: string): string {
  const key = code.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TIMELINE_LABELS, key)
    ? TIMELINE_LABELS[key] ?? fallback
    : fallback;
}

function isTechnicalTimelineText(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.]*$/.test(value)
    || /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(value)
    || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(value);
}

function timelineEventTitle(event: TimelineEvent): string {
  const kind = event.domain.toUpperCase();
  if (kind === 'ORDER' || kind === 'SERVICE_CASE') {
    // Order numbers and support subjects are human content, unlike event/channel codes.
    return isTechnicalTimelineText(event.eventType)
      ? timelineLabel(event.eventType, timelineLabel(kind, 'Sự kiện'))
      : event.eventType;
  }
  return timelineLabel(event.eventType, 'Sự kiện');
}

function timelineSummary(summary: string): string {
  return summary.split(' · ').map((part) => timelineLabel(
    part,
    isTechnicalTimelineText(part) ? 'Xem chi tiết kỹ thuật để biết thêm thông tin.' : part,
  )).join(' · ');
}

interface Customer360TimelineProps {
  readonly initialCustomerId?: string | undefined;
  /**
   * Chronology items already merged by the profile projection (conversations, orders, campaign
   * engagement, support cases). They are merged with the event stream here, so the tab shows one
   * chronology across all five sources.
   */
  readonly sources?: readonly unknown[] | undefined;
}

function sourceEvent(value: unknown, index: number): TimelineEvent {
  const item = typeof value === 'object' && value !== null ? value : {};
  const occurredAt = 'occurred_at' in item && typeof item.occurred_at === 'string' ? item.occurred_at : '';
  const rawClass = 'classification' in item && typeof item.classification === 'string' ? item.classification.toUpperCase() : '';
  const classification: EvidenceClassification | undefined =
    rawClass === 'FACT' || rawClass === 'SIGNAL' || rawClass === 'HYPOTHESIS' || rawClass === 'DECISION' || rawClass === 'ACTION'
      ? rawClass
      : undefined;
  const kind = 'kind' in item && typeof item.kind === 'string' ? item.kind : '';
  const itemId = 'item_id' in item && typeof item.item_id === 'string' ? item.item_id : index;
  return {
    eventId: `source-${kind}-${itemId}`,
    domain: kind,
    eventType: 'title' in item && typeof item.title === 'string' ? item.title : 'Sự kiện',
    summary: 'summary' in item && typeof item.summary === 'string' ? item.summary : '',
    occurredAt,
    ...(classification === undefined ? {} : { classification }),
  };
}

function normalizeEvent(entry: CustomerTimelineEntry): TimelineEvent {
  return {
    eventId: entry.event_id,
    domain: entry.domain ?? '',
    eventType: entry.canonical_event ?? entry.event_type,
    occurredAt: entry.occurred_at,
    stage: entry.stage,
    summary: entry.summary ?? '',
    classification: entry.classification,
    ...(entry.source_record_id === undefined ? {} : { sourceRecordId: entry.source_record_id }),
    ...(entry.evidence_reference === undefined ? {} : { evidenceReference: entry.evidence_reference }),
  };
}

export function Customer360Timeline({
  initialCustomerId = '',
  sources = [],
}: Customer360TimelineProps) {
  const [customerId, setCustomerId] = useState<string>(initialCustomerId);

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

  const [advanced, setAdvanced] = useState(false);

  // Sync prop changes
  useEffect(() => {
    if (initialCustomerId && initialCustomerId !== customerId) {
      setCustomerId(initialCustomerId);
    }
  }, [initialCustomerId, customerId]);

  // Fetch timeline from R15 GET /api/v1/customers/{customer_id}/timeline
  const fetchTimeline = useCallback(
    async (targetId: string, cursor?: string | null, append = false) => {
      if (!targetId.trim()) {
        setEvents([]);
        setGaps([]);
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

        const normalizedEvents = data.items.map(normalizeEvent);
        const entryGaps = data.items.flatMap((entry): TimelineGap[] =>
          entry.gap_reason === undefined ? [] : [{
            gapId: entry.event_id,
            from: entry.occurred_at,
            to: entry.occurred_at,
            reason: entry.gap_reason,
          }],
        );

        if (append) {
          setEvents((previous) => [...previous, ...normalizedEvents]);
          setGaps((previous) => [...previous, ...entryGaps]);
        } else {
          setEvents(normalizedEvents);
          setGaps(entryGaps);
        }
        setNextCursor(data.next_cursor);
      } catch (err: unknown) {
        const status = err instanceof ApiError ? err.status : undefined;
        if (status === 403) {
          setErrorState({
            status,
            type: 'permission_denied',
            message: 'Bạn không có quyền xem dòng thời gian của khách hàng này.',
          });
        } else if (status === 404) {
          setErrorState({
            status,
            type: 'not_found',
            message: 'Không tìm thấy khách hàng này trong công ty của bạn.',
          });
        } else {
          setErrorState({
            ...(status === undefined ? {} : { status }),
            type: 'dependency_unavailable',
            message: 'Hệ thống tạm thời không tải được dữ liệu. Vui lòng thử lại.',
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

  // One chronology across the stored event stream and the profile's merged sources, newest first.
  const mergedEvents = [
    ...events,
    ...sources.map(sourceEvent),
  ].sort((left, right) => {
    const leftAt = Number.isFinite(Date.parse(left.occurredAt)) ? Date.parse(left.occurredAt) : 0;
    const rightAt = Number.isFinite(Date.parse(right.occurredAt)) ? Date.parse(right.occurredAt) : 0;
    return rightAt - leftAt;
  });

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
          title: 'Bản ghi đã xác thực từ hệ thống nguồn',
        };
      case 'SIGNAL':
        return {
          label: 'Tín hiệu',
          badge: 'tenant-evidence-badge--info',
          title: 'Dữ liệu quan sát trực tiếp, chưa được diễn giải',
        };
      case 'HYPOTHESIS':
        return {
          label: 'Dự đoán',
          badge: 'tenant-evidence-badge--warning',
          title: 'Suy luận của mô hình AI, không phải sự thật đã xác thực',
        };
      case 'DECISION':
        return {
          label: 'Quyết định',
          badge: 'tenant-evidence-badge--ai',
          title: 'Quyết định đã được kiểm toán của con người hoặc chính sách',
        };
      case 'ACTION':
        return {
          label: 'Hành động',
          badge: 'tenant-evidence-badge--success',
          title: 'Tác động đã thực hiện ra hệ thống bên ngoài',
        };
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="ui-section-card p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold text-ink">Dòng thời gian</h1>
            <p className="mt-1 text-xs leading-5 text-muted">Dòng thời gian khách hàng đã xác minh, phân tách năm mức bằng chứng.</p>
          </div>
          {customerId ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-low px-3 py-2 text-xs">
              <button
                type="button"
                aria-pressed={advanced}
                onClick={() => setAdvanced((value) => !value)}
                className="ui-button ui-button--secondary ui-button--sm"
              >
                Dòng thời gian nâng cao
              </button>
              <span className="font-semibold text-ink">Hồ sơ khách hàng đã xác minh</span>
              <AdvancedDetails summary="Chi tiết kỹ thuật"><code className="font-mono text-muted">{customerId}</code></AdvancedDetails>
            </div>
          ) : <StatusBadge code="NO_DATA" label="Chọn một khách hàng đã xác minh" />}
        </div>

      </div>

      {/* Main Content View */}
      {!customerId ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface-low p-12 text-center">
          <p className="mb-1 text-sm font-semibold text-ink">Chưa chọn khách hàng</p>
          <p className="text-xs text-muted">
            Mở dòng thời gian từ hội thoại hoặc yêu cầu phê duyệt của khách hàng đã xác minh.
          </p>
        </div>
      ) : isLoading ? (
        <div className="rounded-2xl border border-line bg-surface p-12 text-center">
          <div className="mb-3 inline-block h-6 w-6 animate-spin rounded-full border-2 border-info border-t-transparent"></div>
          <p className="text-xs text-muted">Đang tải dòng thời gian khách hàng…</p>
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
              ? 'Không có quyền truy cập'
              : errorState.type === 'not_found'
              ? 'Không tìm thấy khách hàng'
              : 'Không tải được dòng thời gian'}
          </p>
          <p className="text-xs mb-4 break-words">{errorState.message}</p>
          <button
            type="button"
            onClick={() => fetchTimeline(customerId)}
            className="ui-button ui-button--secondary rounded px-3.5 py-1.5 text-xs"
          >
            Thử lại
          </button>
        </div>
      ) : mergedEvents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface-low p-12 text-center">
          <p className="mb-1 text-sm font-semibold text-ink">Chưa có sự kiện</p>
          <p className="text-xs text-muted">Khách hàng này chưa có sự kiện nào được ghi nhận.</p>
        </div>
      ) : (
        /* Timeline Feed */
        <div className="tenant-timeline-panel">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-ink">
              Dòng thời gian ({mergedEvents.length} sự kiện)
            </h2>
          </div>

          {/* Gaps Notice if present */}
          {gaps.length > 0 && (
            <div className="space-y-2">
              {gaps.map((gap) => (
                <div
                  key={gap.gapId}
                  className="flex items-center justify-between rounded-xl border border-dashed border-warning-border bg-warning-bg p-3 text-xs text-warning"
                >
                  <div>
                    <strong className="block text-xs">Dòng thời gian bị gián đoạn</strong>
                    <span>
                      Thiếu dữ liệu từ{' '}
                      {gap.from && !isNaN(Date.parse(gap.from))
                        ? new Date(gap.from).toLocaleString('vi-VN')
                        : '—'}{' '}
                      đến{' '}
                      {gap.to && !isNaN(Date.parse(gap.to))
                        ? new Date(gap.to).toLocaleString('vi-VN')
                        : '—'}
                    </span>
                  </div>
                  <div>
                    <p className="text-xs text-warning">Một số sự kiện thiếu thông tin nên không hiển thị đầy đủ.</p>
                    <AdvancedDetails summary="Chi tiết kỹ thuật">
                      <code className="font-mono text-xs text-warning">{gap.reason}</code>
                    </AdvancedDetails>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Event Items */}
          <div className="tenant-timeline-list">
            {mergedEvents.map((evt) => {
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
                        {timelineLabel(evt.domain, 'Hoạt động khác')}
                      </span>
                    ) : null}

                    {evt.stage && (
                      <span className="rounded border border-line bg-neutral-bg px-1.5 py-0.5 text-[10px] font-mono text-muted">
                        {timelineLabel(evt.stage, 'Chưa xác định giai đoạn')}
                      </span>
                    )}

                    <span className="text-xs font-bold text-ink">{timelineEventTitle(evt)}</span>

                    {advanced ? (
                      <span
                        title={classMeta?.title ?? 'Phân loại chưa được xác định'}
                        className={`rounded border px-2 py-0.5 text-[10px] font-mono font-bold ${classMeta?.badge ?? 'border-neutral-border bg-neutral-bg text-muted'}`}
                      >
                        [{classMeta?.label ?? 'Chưa phân loại'}]
                      </span>
                    ) : null}

                    <span className="ml-auto text-[11px] font-mono text-muted">
                      {evt.occurredAt && Number.isFinite(Date.parse(evt.occurredAt)) ? new Date(evt.occurredAt).toLocaleString('vi-VN') : '—'}
                    </span>
                  </div>

                  {/* Hypothesis Warning: Visibly separate AI inference from ground truth */}
                  {isHypothesis && (
                    <div className="mb-2 inline-block rounded border border-warning-border bg-warning-bg px-2.5 py-1 text-[10px] font-mono text-warning">
                      Dự đoán của AI có thể thay đổi; không phải dữ kiện đã xác thực.
                    </div>
                  )}

                  {/* Event summary */}
                  {evt.summary && <p className="mb-2 text-xs text-ink-body">{timelineSummary(evt.summary)}</p>}
                  <AdvancedDetails summary="Chi tiết kỹ thuật">
                    <code className="font-mono text-xs text-muted">
                      {evt.domain} · {evt.stage} · {evt.eventType}
                      {evt.summary ? ` · ${evt.summary}` : ''}
                      {evt.evidenceReference ? ` · ${evt.evidenceReference}` : ''}
                    </code>
                  </AdvancedDetails>

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
                {isLoadingMore ? 'Đang tải sự kiện trước đó…' : 'Tải thêm sự kiện'}
              </button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
