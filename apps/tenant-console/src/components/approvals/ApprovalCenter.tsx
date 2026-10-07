/**
 * Main screen component for SCR-003: Approval Center.
 * Handles the R14 approval queue, supplemental detail, and decision contracts.
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ApiError } from '@agentos/ui-foundation';
import { can, type AuthSession } from '@agentos/ui-foundation/auth';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import type {
  ApprovalItem,
  ApprovalDecision,
  ApprovalDecisionResponse,
  ApprovalStatus,
} from './types';
import { ApprovalQueueList } from './ApprovalQueueList';
import { ApprovalPayloadDiffModal } from './ApprovalPayloadDiffModal';


function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `approval-decision-${crypto.randomUUID()}`;
  }
  return `approval-decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function decisionKey(id: string, decision: ApprovalDecision): string {
  return `${id}:${decision}`;
}

interface ApprovalCenterProps {
  readonly onSelectCustomer?: ((customerId: string) => void) | undefined;
  readonly initialApprovalId?: string | undefined;
}

export function ApprovalCenter({ onSelectCustomer, initialApprovalId }: ApprovalCenterProps) {
  const [items, setItems] = useState<Record<string, ApprovalItem>>({});

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [operatorId, setOperatorId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [requireDistinctApprover, setRequireDistinctApprover] = useState(false);
  const decisionKeysRef = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    void tenantConsoleClient.getAuthSession()
      .then((currentSession) => {
        if (!active) return;
        setSession(currentSession);
        void tenantConsoleClient.getCompanyGovernance()
          .then((governance) => {
            if (active) setRequireDistinctApprover(governance.require_distinct_approver === true);
          })
          .catch(() => {
            if (active) setRequireDistinctApprover(false);
          });
        if (!can(currentSession, 'approval:read')) {
          setQueueError('permission_denied: the current session cannot read approvals.');
          setOperatorId('');
          return;
        }
        if (!currentSession.identity.user_id.trim()) {
          setQueueError('permission_denied: authenticated identity is unavailable.');
          setOperatorId('');
          return;
        }
        setOperatorId(currentSession.identity.user_id);
      })
      .catch(() => {
        if (!active) return;
        setSession(null);
        setQueueError('permission_denied: sign in with an authorized session.');
        setOperatorId('');
      });
    return () => { active = false; };
  }, []);
  // Normalizes an approval object from R14 list or supplemental detail read
  const normalizeApprovalItem = useCallback((raw: Record<string, unknown>): ApprovalItem => {
    const id = String(raw.approval_id || raw.id || '');
    const runId = String(raw.run_id || raw.runId || '');
    const actionId = raw.action_id ? String(raw.action_id) : undefined;
    const tenantId = raw.tenant_id ? String(raw.tenant_id) : undefined;
    const agentId = String(raw.agent_id || raw.agentId || raw.requesting_agent_id || 'AGENT-UNKNOWN');
    const requestingAgentName = typeof raw.requesting_agent_name === 'string'
      ? raw.requesting_agent_name
      : typeof raw.agent_name === 'string' ? raw.agent_name : undefined;
    const domain = typeof raw.domain === 'string' ? raw.domain : undefined;
    const effectKey = raw.effect_key ? String(raw.effect_key) : undefined;
    const authority = typeof raw.authority === 'string'
      ? raw.authority
      : typeof raw.required_authority === 'string' ? raw.required_authority : undefined;
    const title = String(raw.title || raw.what || `Review: ${agentId} Action`);
    const reason = String(raw.reason || raw.why || raw.risk_reason || raw.riskReason || 'Human review is required before this action.');
    const rawPayload = (raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {}) as Record<string, unknown>;
    const context = raw.context ?? raw.context_data;
    const evidence = Array.isArray(raw.evidence) ? raw.evidence : Array.isArray(raw.evidence_ids) ? raw.evidence_ids : undefined;
    const payloadSha256 = String(raw.payload_sha256 || raw.payloadSha256 || '');
    const isPaused = Boolean(raw.is_paused ?? raw.isPaused ?? false);

    let status: ApprovalStatus = 'AWAITING_HUMAN';
    if (isPaused || raw.status === 'PAUSED') {
      status = 'PAUSED';
    } else if (raw.status === 'APPROVED') {
      status = 'APPROVED';
    } else if (raw.status === 'REJECTED') {
      status = 'REJECTED';
    } else if (raw.status === 'MODIFIED') {
      status = 'MODIFIED';
    } else if (raw.status === 'CANCELLED') {
      status = 'CANCELLED';
    } else if (raw.status === 'QUEUED') {
      status = 'QUEUED';
    }

    const createdAt = raw.created_at ? String(raw.created_at) : raw.createdAt ? String(raw.createdAt) : '';
    const expiresAt = raw.expires_at ? String(raw.expires_at) : raw.expiresAt ? String(raw.expiresAt) : undefined;
    const queuedAt = raw.queued_at ? String(raw.queued_at) : raw.queuedAt ? String(raw.queuedAt) : undefined;
    const decidedAt = raw.decided_at ? String(raw.decided_at) : undefined;
    const decidedBy = raw.decided_by ? String(raw.decided_by) : undefined;
    const decisionNotes = raw.decision_notes ? String(raw.decision_notes) : undefined;
    const customerId =
      typeof rawPayload.customer_id === 'string'
        ? rawPayload.customer_id
        : typeof rawPayload.customerId === 'string'
        ? rawPayload.customerId
        : undefined;

    return {
      id,
      runId,
      actionId,
      tenantId,
      agentId,
      ...(requestingAgentName === undefined ? {} : { requestingAgentName }),
      ...(domain === undefined ? {} : { domain }),
      effectKey,
      ...(authority === undefined ? {} : { authority }),
      title,
      reason,
      ...(context === undefined ? {} : { context }),
      ...(evidence === undefined ? {} : { evidence }),
      payload: rawPayload,
      payloadSha256,
      status,
      isPaused,
      createdAt,
      expiresAt,
      queuedAt,
      decidedAt,
      decidedBy,
      decisionNotes,
      customerId,
    };
  }, []);

  // Fetch pending queue from authoritative R14 route: GET /api/v1/approvals?status=PENDING
  const fetchQueue = useCallback(async () => {
    if (!operatorId.trim()) {
      return;
    }
    setIsLoading(true);
    setQueueError(null);

    try {
      const data = await tenantConsoleClient.getApprovals(
        { status: 'PENDING' },
      );
      const rawData: unknown = data;
      const rawList: Record<string, unknown>[] = [];
      if (Array.isArray(rawData)) {
        for (const raw of rawData) {
          if (raw && typeof raw === 'object') rawList.push(raw as Record<string, unknown>);
        }
      } else if (rawData && typeof rawData === 'object' && 'items' in rawData && Array.isArray(rawData.items)) {
        for (const raw of rawData.items) {
          if (raw && typeof raw === 'object') rawList.push(raw as Record<string, unknown>);
        }
      }

      const mapped: Record<string, ApprovalItem> = {};
      for (const raw of rawList) {
        const item = normalizeApprovalItem(raw);
        if (item.id) {
          mapped[item.id] = item;
        }
      }

      setItems(mapped);
    } catch (err: unknown) {
      const message = err instanceof ApiError && (err.status === 401 || err.status === 403)
        ? `permission_denied: ${err.message}`
        : err instanceof Error
        ? err.message
        : 'Failed to connect to gateway';
      setQueueError(message);
    } finally {
      setIsLoading(false);
    }

  }, [operatorId, normalizeApprovalItem]);

  // Initial load
  useEffect(() => {
    if (operatorId.trim()) {
      fetchQueue();
    }
  }, [operatorId, fetchQueue]);

  // Fetch supplemental detail when an item is selected (§8.2.1 GET /api/v1/approvals/{id})
  const handleSelectItem = useCallback(
    async (id: string) => {
      setSelectedItemId(id);

      try {
        const detail = await tenantConsoleClient.getApproval(id);
        const normalized = normalizeApprovalItem(detail as unknown as Record<string, unknown>);
        setItems((prev) => ({
          ...prev,
          [id]: normalized,
        }));
      } catch {
        // If supplemental detail read fails, the list-level item remains in view
      }
    },
    [normalizeApprovalItem]
  );
  useEffect(() => {
    if (!initialApprovalId || selectedItemId === initialApprovalId) return;
    void handleSelectItem(initialApprovalId);
  }, [handleSelectItem, initialApprovalId, selectedItemId]);

  // Submit decision to POST /api/v1/approvals/{id}/decision
  const handleSubmitDecision = useCallback(
    async (
      id: string,
      decision: ApprovalDecision,
      reason: string,
      expectedPayloadSha256: string,
      modifiedPayload?: Record<string, unknown>
    ): Promise<ApprovalDecisionResponse> => {
      if (!operatorId || !operatorId.trim() || !can(session, 'approval:decide')) {
        throw new Error('permission_denied: this session cannot submit approval decisions.');
      }
      if (!expectedPayloadSha256.trim()) {
        throw new Error('The reviewed payload digest is unavailable. Review the approval detail before deciding.');
      }

      const requestBody = {
        decision,
        reason,
        expected_payload_sha256: expectedPayloadSha256,
        ...(decision === 'MODIFY' && modifiedPayload ? { modified_payload: modifiedPayload } : {}),
      };
      const key = decisionKey(id, decision);
      const idempotencyKey = decisionKeysRef.current.get(key) ?? newIdempotencyKey();
      decisionKeysRef.current.set(key, idempotencyKey);

      const responseReceipt = await tenantConsoleClient.submitApprovalDecision(
        id,
        requestBody,
        { headers: { 'Idempotency-Key': idempotencyKey, 'x-idempotency-key': idempotencyKey } },
      );

      // Update local item status based on server receipt.
      // R05 queue-first contract returns status 'QUEUED' and queued_at.
      // Do NOT claim decided_at or decided_by: the decision is enqueued for durable
      // worker handoff and must not render a fake final decision.
      setItems((prev) => {
        const existing = prev[id];
        if (!existing) return prev;

        const nextStatus: ApprovalStatus = responseReceipt.status;

        return {
          ...prev,
          [id]: {
            ...existing,
            status: nextStatus,
            queuedAt: responseReceipt.queued_at,
            payload: decision === 'MODIFY' && modifiedPayload ? modifiedPayload : existing.payload,
          },
        };
      });

      return responseReceipt;
    },
[operatorId, session]
  );

  const itemList = Object.values(items);
  const selectedItem = selectedItemId ? items[selectedItemId] ?? null : null;

  const awaitingHumanCount = itemList.filter((i) => i.status === 'AWAITING_HUMAN' && !i.isPaused).length;
  const pausedCount = itemList.filter((i) => i.isPaused || i.status === 'PAUSED').length;
  const queuedCount = itemList.filter((i) => i.status === 'QUEUED').length;
  if (!operatorId || !operatorId.trim()) {
    return (
      <div
        data-testid="approval-center-unavailable"
        role="alert"
        className="ui-state ui-state--error mx-auto my-12 max-w-2xl text-center"
      >
        <div className="tenant-code-badge mx-auto mb-4" aria-hidden="true">403</div>
        <h2 className="text-base font-semibold text-ink mb-2">
          Không thể xác thực người phê duyệt
        </h2>
        <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted">
          Phiên đăng nhập không cung cấp danh tính người phê duyệt đã xác thực.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="ui-section-card p-5">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-headline-lg font-semibold text-ink">SCR-003: Approval Center</h2>
            <p className="mt-1 text-sm text-muted">
              Mandatory human-in-the-loop checkpoint for high-risk AUTH-4 operations.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tenant-summary-badge tenant-summary-badge--warning">
                Awaiting Sign-off: <strong>{awaitingHumanCount}</strong>
              </span>
              <span className="tenant-summary-badge tenant-summary-badge--info">
                Paused: <strong>{pausedCount}</strong>
              </span>
              {queuedCount > 0 ? (
                <span className="tenant-summary-badge tenant-summary-badge--ai">
                  Queued: <strong>{queuedCount}</strong>
                </span>
              ) : null}
            </div>

            <div className="tenant-operator" aria-label="Verified operator identity">
              <span>Operator:</span>
              <strong title="Resolved from the authenticated session">{operatorId}</strong>
            </div>

            <button type="button" onClick={fetchQueue} disabled={isLoading} className="ui-button ui-button--secondary ui-button--sm">
              {isLoading ? 'Refreshing…' : 'Refresh Queue'}
            </button>
          </div>
        </div>
        {requireDistinctApprover ? (
          <div role="note" className="tenant-notice tenant-notice--warning mt-4">
            Người phê duyệt phải khác người soạn
          </div>
        ) : null}
      </div>

      <div className="max-w-5xl">
        <ApprovalQueueList
          items={itemList}
          selectedId={selectedItemId}
          onSelect={handleSelectItem}
          isLoading={isLoading}
          error={queueError}
          onRetry={fetchQueue}
        />
      </div>

      <ApprovalPayloadDiffModal
        item={selectedItem}
        requireDistinctApprover={requireDistinctApprover}
        onClose={() => setSelectedItemId(null)}
        onSubmitDecision={handleSubmitDecision}
        onViewCustomer={onSelectCustomer}
      />
    </div>
  );

}
