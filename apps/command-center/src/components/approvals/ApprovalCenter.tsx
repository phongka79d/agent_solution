/**
 * @file apps/command-center/src/components/approvals/ApprovalCenter.tsx
 * Main screen component for SCR-003: Approval Center.
 * Handles R14 GET /api/v1/approvals?status=PENDING, supplemental GET /api/v1/approvals/{id},
 * and POST /api/v1/approvals/{id}/decision with the 5 standardized governance decisions.
 */
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { apiOrigin } from '../../lib/api-client';
import type {
  ApprovalItem,
  ApprovalDecision,
  ApprovalDecisionResponse,
  ApprovalStatus,
  ApiErrorResponse,
} from './types';
import { ApprovalQueueList } from './ApprovalQueueList';
import { ApprovalPayloadDiffModal } from './ApprovalPayloadDiffModal';

interface ApprovalCenterProps {
  readonly initialOperatorId?: string | undefined;
  readonly operatorId?: string | undefined;
  readonly onSelectCustomer?: ((customerId: string) => void) | undefined;
}

export function ApprovalCenter({
  initialOperatorId,
  operatorId: propOperatorId,
  onSelectCustomer,
}: ApprovalCenterProps) {
  const [items, setItems] = useState<Record<string, ApprovalItem>>({});
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [operatorId, setOperatorId] = useState<string>(() => {
    return (
      propOperatorId?.trim() ||
      initialOperatorId?.trim() ||
      (typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('operator_id')?.trim() ||
          new URLSearchParams(window.location.search).get('operatorId')?.trim() ||
          ''
        : '')
    );
  });
  const [isLoading, setIsLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  useEffect(() => {
    const fromContext =
      propOperatorId?.trim() ||
      initialOperatorId?.trim() ||
      (typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('operator_id')?.trim() ||
          new URLSearchParams(window.location.search).get('operatorId')?.trim() ||
          ''
        : '');
    if (fromContext && fromContext !== operatorId) {
      setOperatorId(fromContext);
    }
  }, [propOperatorId, initialOperatorId, operatorId]);
  // Normalizes an approval object from R14 list or supplemental detail read
  const normalizeApprovalItem = useCallback((raw: Record<string, unknown>): ApprovalItem => {
    const id = String(raw.approval_id || raw.id || '');
    const runId = String(raw.run_id || raw.runId || '');
    const actionId = raw.action_id ? String(raw.action_id) : undefined;
    const tenantId = raw.tenant_id ? String(raw.tenant_id) : undefined;
    const agentId = String(raw.agent_id || raw.agentId || 'AGENT-UNKNOWN');
    const effectKey = raw.effect_key ? String(raw.effect_key) : undefined;
    const title = String(raw.title || `Review: ${agentId} Action`);
    const reason = String(raw.reason || raw.risk_reason || raw.riskReason || 'AUTH-4 operation requires human sign-off');
    const rawPayload = (raw.payload && typeof raw.payload === 'object' ? raw.payload : {}) as Record<string, unknown>;
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
      effectKey,
      title,
      reason,
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
      const origin = apiOrigin();
      const res = await fetch(`${origin}/api/v1/approvals?status=PENDING`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-operator-id': operatorId.trim(),
        },
      });

      if (!res.ok) {
        let errMessage = `HTTP ${res.status}: ${res.statusText}`;
        try {
          const errData = (await res.json()) as ApiErrorResponse;
          if (errData.message) {
            errMessage = errData.message;
          }
        } catch {
          // fallback to status text
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`permission_denied: ${errMessage}`);
        }
        throw new Error(errMessage);
      }

      const data = await res.json();
      const rawList: Record<string, unknown>[] = Array.isArray(data)
        ? data
        : Array.isArray(data.items)
        ? data.items
        : [];

      const mapped: Record<string, ApprovalItem> = {};
      for (const raw of rawList) {
        const item = normalizeApprovalItem(raw);
        if (item.id) {
          mapped[item.id] = item;
        }
      }

      setItems(mapped);
    } catch (err: unknown) {
      setQueueError((err as Error).message || 'Failed to connect to gateway');
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
        const origin = apiOrigin();
        const res = await fetch(`${origin}/api/v1/approvals/${encodeURIComponent(id)}`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });

        if (res.ok) {
          const detail = await res.json();
          const normalized = normalizeApprovalItem(detail);
          setItems((prev) => ({
            ...prev,
            [id]: normalized,
          }));
        }
      } catch {
        // If supplemental detail read fails, the list-level item remains in view
      }
    },
    [normalizeApprovalItem]
  );

  // Submit decision to POST /api/v1/approvals/{id}/decision
  const handleSubmitDecision = useCallback(
    async (
      id: string,
      decision: ApprovalDecision,
      reason: string,
      expectedPayloadSha256: string,
      modifiedPayload?: Record<string, unknown>
    ): Promise<ApprovalDecisionResponse> => {
      if (!operatorId || !operatorId.trim()) {
        throw new Error('permission_denied: Cannot submit decision without verified operator identity.');
      }

      const origin = apiOrigin();

      const requestBody: {
        decision: ApprovalDecision;
        operator_id: string;
        reason: string;
        expected_payload_sha256: string;
        modified_payload?: Record<string, unknown>;
      } = {
        decision,
        operator_id: operatorId,
        reason,
        expected_payload_sha256: expectedPayloadSha256,
      };

      // modified_payload ONLY included when decision is MODIFY
      if (decision === 'MODIFY' && modifiedPayload) {
        requestBody.modified_payload = modifiedPayload;
      }

      const res = await fetch(`${origin}/api/v1/approvals/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        let errBody: ApiErrorResponse = { message: `Request failed with status ${res.status}` };
        try {
          errBody = (await res.json()) as ApiErrorResponse;
        } catch {
          // fallback
        }
        const errorToThrow = new Error(errBody.message || `Decision failed with status ${res.status}`) as Error & {
          status?: number | undefined;
          isConflict?: boolean | undefined;
          correlation_id?: string | undefined;
          error_code?: string | undefined;
        };
        errorToThrow.status = res.status;
        errorToThrow.isConflict = res.status === 409;
        if (errBody.correlation_id !== undefined) {
          errorToThrow.correlation_id = errBody.correlation_id;
        }
        if (errBody.error_code !== undefined) {
          errorToThrow.error_code = errBody.error_code;
        }
        throw errorToThrow;
      }

      const responseReceipt = (await res.json()) as ApprovalDecisionResponse;

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
    [operatorId]
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
        className="p-8 rounded-2xl border border-rose-800 bg-rose-950/40 text-center max-w-2xl mx-auto my-12"
      >
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-900/60 text-rose-300 mb-4 border border-rose-700 font-mono text-sm font-bold">
          403
        </div>
        <h2 className="text-base font-semibold text-rose-200 mb-2">
          permission_denied: Operator Identifier Required
        </h2>
        <p className="text-xs text-rose-300 font-mono max-w-lg mx-auto leading-relaxed">
          Access refused: Governance approval review requires an authenticated operator session from context input. No verified operator_id was provided.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900/60 border border-slate-800 p-5 rounded-2xl">
        <div>
          <h1 className="text-xl font-bold text-slate-100">SCR-003: Approval Center</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Mandatory human-in-the-loop checkpoint for high-risk AUTH-4 operations.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 bg-amber-950/70 border border-amber-700/80 rounded-full text-xs font-mono text-amber-300">
              Awaiting Sign-off: <strong>{awaitingHumanCount}</strong>
            </span>
            <span className="px-2.5 py-1 bg-sky-950/70 border border-sky-700/80 rounded-full text-xs font-mono text-sky-300">
              Paused: <strong>{pausedCount}</strong>
            </span>
            {queuedCount > 0 && (
              <span className="px-2.5 py-1 bg-purple-950/70 border border-purple-700/80 rounded-full text-xs font-mono text-purple-300">
                Queued: <strong>{queuedCount}</strong>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs font-mono bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
            <span className="text-slate-400">Operator:</span>
            <input
              type="text"
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value)}
              className="bg-transparent border-none text-slate-200 outline-none w-28 font-mono text-xs"
              title="Operator ID sent to decision endpoint"
            />
          </div>

          <button
            type="button"
            onClick={fetchQueue}
            disabled={isLoading}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Refreshing…' : 'Refresh Queue'}
          </button>
        </div>
      </div>

      {/* Main List */}
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

      {/* Modal / Diff Inspector */}
      <ApprovalPayloadDiffModal
        item={selectedItem}
        operatorId={operatorId}
        onClose={() => setSelectedItemId(null)}
        onSubmitDecision={handleSubmitDecision}
        onViewCustomer={onSelectCustomer}
      />
    </div>
  );
}
