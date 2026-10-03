/**
 * Vietnamese Approval Console (`T6.8`, spec §7.7).
 *
 * Two tabs (Chờ duyệt / Đã xử lý) over the R14 queue and the decided history. Each card states in
 * one sentence what will happen, who requested it and when it expires; the drawer spells out what
 * will happen, a preview, the checks, the evidence and - for a modification - the before/after.
 * Decisions are Duyệt / Từ chối (reason required) / Yêu cầu sửa (structured fields). The payload
 * digest and raw JSON stay under "Chi tiết kỹ thuật".
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AdvancedDetails,
  Button,
  Drawer,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  KeyValueList,
  Modal,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
} from '@agentos/ui-foundation/react';
import { can } from '@agentos/ui-foundation/auth';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { ApiError } from '@agentos/ui-foundation';
import type { ApprovalQueueItem } from '@agentos/api-contract';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { QUICK_REJECTION_REASONS } from './types';
import type {
  ApprovalDecision,
  ApprovalItem,
  ApprovalStatus,
  ApprovalSummary,
  ApprovalTab,
  ModifyFields,
} from './types';

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  zalo: 'Zalo',
  messenger: 'Messenger',
  whatsapp: 'WhatsApp',
  web_chat: 'Web chat',
  web: 'Web chat',
  sms: 'SMS',
};

const DOMAIN_LABELS: Record<ApprovalSummary['domain'], string> = {
  marketing: 'Marketing',
  sales: 'Bán hàng',
  care: 'Chăm sóc khách hàng',
  platform: 'Nền tảng',
};
const REQUESTER_LABELS: Readonly<Record<string, string>> = {
  'agentos.unknown_agent': 'Trợ lý AgentOS',
};

function requestingAgentLabel(key: string): string {
  if (key.startsWith('skill.marketing.') || key.startsWith('skill.mkt.')) {
    return 'Chiến dịch Marketing';
  }
  return REQUESTER_LABELS[key] ?? 'Trợ lý AgentOS';
}

function channelLabel(channel: unknown): string {
  // Connector ids (e.g. a provider adapter code) are technical; only known channels get a name.
  const key = typeof channel === 'string' ? channel.toLowerCase() : '';
  return CHANNEL_LABELS[key] ?? 'kênh đã chọn';
}

function ModificationPreview({ value }: { readonly value: unknown }) {
  const channel = typeof value === 'object' && value !== null && 'channel' in value ? value.channel : null;
  const audience = typeof value === 'object' && value !== null && 'audience_size' in value ? value.audience_size : null;
  const message = typeof value === 'object' && value !== null && 'message' in value ? value.message : null;
  return (
    <KeyValueList
      items={[
        { key: 'channel', label: 'Kênh gửi', value: channel === null ? null : channelLabel(channel) },
        { key: 'audience', label: 'Số khách', value: typeof audience === 'number' ? String(audience) : null },
        { key: 'message', label: 'Nội dung', value: typeof message === 'string' ? message : null },
      ]}
    />
  );
}

/** One sentence stating what the approval will do. */
function cardSentence(item: ApprovalItem): string {
  const params = item.summary.params;
  switch (item.summary.titleKey) {
    case 'approvals.title.campaign': {
      const audience = params['audience_size'];
      const recipients = typeof audience === 'number' ? ` cho ${audience} khách` : '';
      return `Gửi chiến dịch “${String(params['campaign_name'] ?? 'không tên')}”${recipients} qua ${channelLabel(params['channel'])}`;
    }
    case 'approvals.title.customer':
      return `Gửi đề xuất cho khách hàng qua ${channelLabel(params['channel'])}`;
    case 'approvals.title.modify':
      return typeof params['campaign_name'] === 'string'
        ? `Điều chỉnh chiến dịch “${params['campaign_name']}” trước khi thực hiện`
        : 'Điều chỉnh đề xuất trước khi thực hiện';
    default:
      return 'Đề xuất hành động cần bạn phê duyệt trước khi thực hiện';
  }
}

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: 'Chờ phê duyệt',
  PAUSED: 'Tạm dừng',
  APPROVED: 'Đã duyệt',
  MODIFIED: 'Đã duyệt bản chỉnh sửa',
  REJECTED: 'Đã từ chối',
  CANCELLED: 'Đã hủy',
  EXPIRED: 'Hết hạn',
};

const STATUS_TONES: Record<ApprovalStatus, 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = {
  PENDING: 'warning',
  PAUSED: 'neutral',
  APPROVED: 'success',
  MODIFIED: 'info',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'danger',
};

function normalizeItem(raw: ApprovalQueueItem): ApprovalItem {
  const summary = raw.summary;
  const params: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(summary.params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params[key] = value;
    }
  }
  return {
    id: raw.approval_id,
    runId: raw.run_id,
    actionId: raw.action_id,
    effectKey: raw.effect_key,
    reason: raw.reason,
    payload: raw.payload,
    payloadSha256: raw.payload_sha256,
    status: raw.status,
    isPaused: raw.is_paused,
    createdAt: raw.created_at,
    decidedAt: raw.decided_at ?? undefined,
    decidedBy: raw.decided_by ?? undefined,
    decisionNotes: raw.decision_notes ?? undefined,
    summary: {
      titleKey: summary.title_key,
      params,
      requestingAgentKey: summary.requesting_agent_key,
      domain: summary.domain,
      campaignId: summary.campaign_id,
      customerId: summary.customer_id,
      risk: summary.risk,
      evidenceCount: summary.evidence_count,
      modification: summary.modification === null ? null : {
        before: summary.modification['before'] ?? null,
        after: summary.modification['after'] ?? null,
      },
      expiresAt: summary.expires_at,
    },
  };
}

function expiryLabel(expiresAt: string | null): string | null {
  if (expiresAt === null || expiresAt === '') return null;
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return null;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return 'Đã hết hạn';
  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours >= 24) return `Còn ${Math.floor(hours / 24)} ngày`;
  const minutes = Math.max(1, Math.floor(remainingMs / 60_000));
  return hours >= 1 ? `Còn ${hours} giờ` : `Còn ${minutes} phút`;
}

interface ApprovalCenterProps {
  readonly onSelectCustomer?: ((customerId: string) => void) | undefined;
  readonly initialApprovalId?: string | undefined;
}

type DecisionKind = 'APPROVE' | 'REJECT' | 'MODIFY' | 'PAUSE' | 'CANCEL';

export function ApprovalCenter({ initialApprovalId }: ApprovalCenterProps) {
  const [tab, setTab] = useState<ApprovalTab>('PENDING');
  const [items, setItems] = useState<readonly ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialApprovalId ?? null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [decisionKind, setDecisionKind] = useState<DecisionKind | null>(null);
  const [reason, setReason] = useState('');
  const [quickReason, setQuickReason] = useState('');
  const [modify, setModify] = useState<ModifyFields>({ channel: '', audienceSize: '', message: '' });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void tenantConsoleClient
      .getAuthSession()
      .then((current) => {
        if (active) setSession(current);
      })
      .catch(() => {
        if (active) setSession(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const loadQueue = useCallback(async (target: ApprovalTab) => {
    setLoading(true);
    setError(null);
    try {
      const page = await tenantConsoleClient.getApprovals({ status: target });
      setItems(page.items.map(normalizeItem));
    } catch (caught) {
      setError(caught);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue(tab);
  }, [tab, loadQueue]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const canDecide = can(session, 'approval:decide');

  const submitDecision = useCallback(
    async (item: ApprovalItem, decision: ApprovalDecision, rationale: string, modified?: Record<string, unknown>) => {
      await tenantConsoleClient.submitApprovalDecision(item.id, {
        decision,
        reason: rationale,
        expected_payload_sha256: item.payloadSha256,
        ...(modified === undefined ? {} : { modified_payload: modified }),
      });
    },
    [],
  );

  const runDecision = useCallback(
    async (item: ApprovalItem, decision: ApprovalDecision, rationale: string, modified?: Record<string, unknown>) => {
      setSubmitting(true);
      try {
        await submitDecision(item, decision, rationale, modified);
        setDecisionKind(null);
        setReason('');
        setQuickReason('');
        setModify({ channel: '', audienceSize: '', message: '' });
        setSelectedId(null);
        setBanner(
          decision === 'APPROVE'
            ? 'Đã duyệt · Đang kiểm tra lại nội dung và đồng ý trước khi gửi'
            : decision === 'REJECT'
              ? 'Đã từ chối · Đề xuất không được thực hiện'
              : decision === 'MODIFY'
                ? 'Đã duyệt bản chỉnh sửa · Đang kiểm tra lại nội dung và đồng ý trước khi gửi'
                : decision === 'PAUSE'
                  ? 'Đã tạm dừng đề xuất'
                  : 'Đã hủy đề xuất',
        );
        await loadQueue(tab);
      } catch (caught) {
        if (caught instanceof ApiError && (
          caught.error_code === 'APPROVAL_STALE_PAYLOAD' || caught.error_code === 'APPROVAL_NOT_CLAIMABLE'
        )) {
          setDecisionKind(null);
          setSelectedId(null);
          setBanner('Đề xuất đã thay đổi, cần xem lại');
          try {
            const current = await tenantConsoleClient.getApproval(item.id);
            const target = current.status === 'PENDING' || current.status === 'PAUSED' ? 'PENDING' : 'DECIDED';
            if (target === tab) {
              await loadQueue(target);
            } else {
              setTab(target);
            }
          } catch (refreshError) {
            setError(refreshError);
            setItems([]);
          }
        } else {
          setError(caught);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [submitDecision, loadQueue, tab],
  );

  function openDecision(kind: DecisionKind): void {
    setDecisionKind(kind);
    setReason('');
    setQuickReason('');
    setModify({ channel: '', audienceSize: '', message: '' });
  }

  function submitReject(): void {
    if (selected === null) return;
    const rationale = reason.trim() !== '' ? reason.trim() : QUICK_REJECTION_REASONS.find((r) => r.code === quickReason)?.label ?? '';
    if (rationale === '') return;
    void runDecision(selected, 'REJECT', rationale);
  }

  function submitModify(): void {
    if (selected === null) return;
    const modified: Record<string, unknown> = { ...selected.payload };
    if (modify.channel.trim() !== '') modified['channel'] = modify.channel.trim();
    if (modify.audienceSize.trim() !== '') modified['audience_size'] = Number(modify.audienceSize.trim());
    if (modify.message.trim() !== '') modified['message'] = modify.message.trim();
    void runDecision(
      selected,
      'MODIFY',
      reason.trim() !== '' ? reason.trim() : 'Yêu cầu điều chỉnh đề xuất',
      modified,
    );
  }

  const activeItems = items;

  function renderCards(): ReactNode {
    if (loading && activeItems.length === 0) {
      return <Skeleton variant="table" />;
    }
    if (error !== null && activeItems.length === 0) {
      return <ErrorBanner error={error} onRetry={() => void loadQueue(tab)} />;
    }
    if (activeItems.length === 0) {
      return tab === 'PENDING' ? (
        <EmptyState title="Không có đề xuất nào đang chờ" description="Khi AI cần bạn phê duyệt, đề xuất sẽ xuất hiện ở đây." />
      ) : (
        <EmptyState title="Chưa có đề xuất nào đã xử lý" description="Các đề xuất bạn đã duyệt hoặc từ chối sẽ hiển thị ở đây." />
      );
    }
    return (
      <ul className="space-y-3" role="list">
        {activeItems.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="ui-focus-ring w-full rounded-lg border p-4 text-left"
              onClick={() => setSelectedId(item.id)}
            >
              <div className="flex items-center justify-between gap-3">
                <StatusBadge code={item.status} tone={STATUS_TONES[item.status]} label={STATUS_LABELS[item.status]} />
                {expiryLabel(item.summary.expiresAt) !== null ? (
                  <span className="text-sm text-muted">{expiryLabel(item.summary.expiresAt)}</span>
                ) : null}
              </div>
              <p className="mt-2 font-medium">{cardSentence(item)}</p>
              <p className="text-sm text-muted">
                Yêu cầu bởi {requestingAgentLabel(item.summary.requestingAgentKey)} · {DOMAIN_LABELS[item.summary.domain]}
              </p>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-6">
      {banner !== null ? (
        <div role="status" className="rounded-lg border border-success p-3">
          {banner}
        </div>
      ) : null}

      <Tabs
        tabs={[
          { id: 'PENDING', label: 'Chờ duyệt', content: <div /> },
          { id: 'DECIDED', label: 'Đã xử lý', content: <div /> },
        ]}
        activeTabId={tab}
        onTabChange={(id) => setTab(id === 'DECIDED' ? 'DECIDED' : 'PENDING')}
      />

      {renderCards()}

      <Drawer
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected !== null ? cardSentence(selected) : ''}
        {...(selected === null ? {} : { description: STATUS_LABELS[selected.status] })}
      >
        {selected !== null ? (
          <div className="space-y-5">
            <section>
              <h3>Điều gì sẽ xảy ra</h3>
              <p>{cardSentence(selected)}</p>
            </section>

            <section>
              <h3>Xem trước</h3>
              <KeyValueList
                items={[
                  { key: 'agent', label: 'Người yêu cầu', value: requestingAgentLabel(selected.summary.requestingAgentKey) },
                  { key: 'domain', label: 'Lĩnh vực', value: DOMAIN_LABELS[selected.summary.domain] },
                  {
                    key: 'campaign',
                    label: 'Chiến dịch',
                    value:
                      selected.summary.params['campaign_name'] !== undefined
                        ? String(selected.summary.params['campaign_name'])
                        : null,
                  },
                  {
                    key: 'audience',
                    label: 'Số khách',
                    value:
                      selected.summary.params['audience_size'] !== undefined
                        ? String(selected.summary.params['audience_size'])
                        : null,
                  },
                  {
                    key: 'channel',
                    label: 'Kênh gửi',
                    value:
                      selected.summary.params['channel'] !== undefined
                        ? channelLabel(selected.summary.params['channel'])
                        : null,
                  },
                ]}
              />
            </section>

            <section>
              <h3>Kiểm tra</h3>
              <KeyValueList
                items={[
                  { key: 'risk', label: 'Mức rủi ro', value: selected.summary.risk === 'high' ? 'Cao' : selected.summary.risk === 'medium' ? 'Trung bình' : 'Thấp' },
                  { key: 'evidence', label: 'Bằng chứng', value: `${selected.summary.evidenceCount} mục` },
                  { key: 'expiry', label: 'Hạn xem xét', value: expiryLabel(selected.summary.expiresAt) ?? 'Không có' },
                ]}
              />
            </section>

            {selected.summary.modification !== null ? (
              <section>
                <h3>Thay đổi</h3>
                <h4>Trước</h4>
                <ModificationPreview value={selected.summary.modification.before} />
                <h4>Sau</h4>
                <ModificationPreview value={selected.summary.modification.after} />
              </section>
            ) : null}

            {selected.status === 'PENDING' && !selected.isPaused && canDecide ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void runDecision(selected, 'APPROVE', 'Đã phê duyệt qua bảng phê duyệt')} loading={submitting}>
                  Duyệt
                </Button>
                <Button variant="danger" onClick={() => openDecision('REJECT')}>
                  Từ chối
                </Button>
                <Button variant="secondary" onClick={() => openDecision('MODIFY')}>
                  Yêu cầu sửa
                </Button>
                <Button variant="ghost" onClick={() => void runDecision(selected, 'PAUSE', 'Tạm dừng để xem xét thêm')}>
                  Tạm dừng
                </Button>
                <Button variant="ghost" onClick={() => void runDecision(selected, 'CANCEL', 'Hủy đề xuất')}>
                  Hủy
                </Button>
              </div>
            ) : null}

            {selected.status !== 'PENDING' ? (
              <section>
                <h3>Kết quả</h3>
                <p>
                  {selected.status === 'APPROVED'
                    ? 'Đã duyệt · Đang kiểm tra lại nội dung và đồng ý trước khi gửi'
                    : selected.status === 'MODIFIED'
                      ? 'Đã duyệt bản chỉnh sửa · Đang kiểm tra lại nội dung và đồng ý trước khi gửi'
                      : STATUS_LABELS[selected.status]}
                </p>
                {selected.decidedBy !== undefined || selected.decisionNotes !== undefined ? (
                  <KeyValueList
                    items={[
                      { key: 'notes', label: 'Ghi chú', value: selected.decisionNotes ?? null },
                    ]}
                  />
                ) : null}
              </section>
            ) : null}

            <AdvancedDetails summary="Chi tiết kỹ thuật">
              <KeyValueList
                items={[
                  { key: 'digest', label: 'Mã băm nội dung (SHA-256)', value: selected.payloadSha256 },
                  { key: 'run', label: 'Mã phiên chạy', value: selected.runId },
                  { key: 'effect', label: 'Khóa hiệu lực', value: selected.effectKey ?? null },
                  { key: 'status', label: 'Trạng thái gốc', value: selected.status },
                  { key: 'by', label: 'Mã người xử lý', value: selected.decidedBy ?? null },
                  { key: 'reason', label: 'Lý do của chính sách', value: selected.reason !== '' ? selected.reason : null },
                ]}
              />
              <pre>{JSON.stringify(selected.payload, null, 2)}</pre>
              {selected.summary.modification !== null ? (
                <pre>{JSON.stringify(selected.summary.modification, null, 2)}</pre>
              ) : null}
            </AdvancedDetails>
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={decisionKind === 'REJECT'}
        onClose={() => setDecisionKind(null)}
        title="Từ chối đề xuất"
        description="Nêu lý do để AI cải thiện lần sau."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDecisionKind(null)}>
              Hủy
            </Button>
            <Button variant="danger" onClick={submitReject} loading={submitting} disabled={reason.trim() === '' && quickReason === ''}>
              Từ chối
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Lý do nhanh">
            <Select value={quickReason} onChange={(e) => setQuickReason(e.target.value)}>
              <option value="">Chọn lý do…</option>
              {QUICK_REJECTION_REASONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Hoặc nhập lý do">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Vì sao bạn từ chối?" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={decisionKind === 'MODIFY'}
        onClose={() => setDecisionKind(null)}
        title="Yêu cầu sửa đề xuất"
        description="Chỉnh những trường cần thay đổi, phần còn lại giữ nguyên."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDecisionKind(null)}>
              Hủy
            </Button>
            <Button onClick={submitModify} loading={submitting}>
              Gửi yêu cầu sửa
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Kênh gửi">
            <Input value={modify.channel} onChange={(e) => setModify({ ...modify, channel: e.target.value })} placeholder="Email, Zalo…" />
          </Field>
          <Field label="Số khách">
            <Input value={modify.audienceSize} onChange={(e) => setModify({ ...modify, audienceSize: e.target.value })} inputMode="numeric" />
          </Field>
          <Field label="Nội dung">
            <Input value={modify.message} onChange={(e) => setModify({ ...modify, message: e.target.value })} />
          </Field>
          <Field label="Ghi chú">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Mô tả ngắn thay đổi mong muốn" />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
