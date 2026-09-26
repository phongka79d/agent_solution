import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalDecision, ApprovalDetailResponse } from '../../gateway/contracts.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerApprovalRoutes } from './approvals.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';

interface QueuedDecisionResult {
  readonly approval_id: string;
  readonly task_id: string;
  readonly status: 'QUEUED';
  readonly queued_at: string;
}

const TENANT = 'tenant-a';
const OPERATOR_ID = 'operator-a';
const OPERATOR_TOKEN = 'operator-token-decide';
const READONLY_TOKEN = 'operator-token-readonly';
const NO_ID_TOKEN = 'operator-token-no-id';
const SESSION_TOKEN = 'session-token';
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const EFFECT_KEY = `${TENANT}:order.refund:${APPROVAL_ID}`;
const PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const QUEUED_TASK_ID = '33333333-3333-4333-8333-333333333333';
const QUEUED_AT = '2026-09-23T00:01:00.000Z';

function buildHarness(options?: {
  approvalDetail?: ApprovalDetailResponse | null;
  decideImpl?: (input: {
    tenant_id: string;
    approval_id: string;
    run_id: string;
    effect_key: string;
    expected_payload_sha256: string;
    decision: ApprovalDecision;
    operator_id: string;
    reason: string;
    modified_payload?: Record<string, unknown>;
  }) => Promise<QueuedDecisionResult>;
}) {
  const detail: ApprovalDetailResponse | null =
    options?.approvalDetail !== undefined
      ? options.approvalDetail
      : {
          approval_id: APPROVAL_ID,
          tenant_id: TENANT,
          run_id: RUN_ID,
          action_id: 'action-1',
          effect_key: EFFECT_KEY,
          payload: { order_id: 'ord-123', amount_cents: 5000 },
          reason: 'Refund exceeds automatic threshold',
          status: 'PENDING',
          is_paused: false,
          decided_by: null,
          decided_at: null,
          decision_notes: null,
          created_at: '2026-09-23T00:00:00.000Z',
          payload_sha256: PAYLOAD_SHA256,
          expires_at: null,
        };

  const decide = vi.fn(
    options?.decideImpl ??
      (async (input) => ({
        approval_id: input.approval_id,
        task_id: QUEUED_TASK_ID,
        status: 'QUEUED' as const,
        queued_at: QUEUED_AT,
      })),
  );

  const detailFn = vi.fn(async (tenant_id: string, approval_id: string) => {
    if (detail !== null && tenant_id === TENANT && approval_id === detail.approval_id) {
      return detail;
    }
    return null;
  });

  const auditRecord = vi.fn(async () => undefined);

  const runtime = {
    approvals: {
      list: vi.fn(),
      detail: detailFn,
      decide,
    },
    audit: { record: auditRecord },
    clock: () => new Date('2026-09-23T00:00:00.000Z'),
    ids: () => 'corr-approval-test',
  } as unknown as GatewayRuntime;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerApprovalRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        {
          token: OPERATOR_TOKEN,
          tenant_id: TENANT,
          operator_id: OPERATOR_ID,
          permissions: ['approval:decide', 'approval:read'],
        },
        {
          token: READONLY_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-ro',
          permissions: ['approval:read'],
        },
        {
          token: NO_ID_TOKEN,
          tenant_id: TENANT,
          operator_id: '',
          permissions: ['approval:decide', 'approval:read'],
        },
      ],
      sessions: [
        {
          token: SESSION_TOKEN,
          tenant_id: TENANT,
          conversation_id: '11111111-1111-4111-8111-111111111111',
          session_id: 'session-a',
          channel: 'WEB_CHAT',
        },
      ],
      widgets: [],
    }),
  });

  return { app, auditRecord, decide, detail, detailFn, runtime };
}

describe('POST /approvals/:approval_id/decision (R05 approvals.decide)', () => {
  it('queues a durable human decision with HTTP 202 and status QUEUED rather than deciding directly', async () => {
    const { app, auditRecord, decide, detail } = buildHarness();
    const payload = {
      decision: 'APPROVE',
      reason: 'Verified customer eligibility under warranty exception',
      expected_payload_sha256: PAYLOAD_SHA256,
    };

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/approvals/${APPROVAL_ID}/decision`,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        payload,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        approval_id: APPROVAL_ID,
        task_id: QUEUED_TASK_ID,
        status: 'QUEUED',
        queued_at: QUEUED_AT,
        correlation_id: 'corr-approval-test',
      });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith({
        tenant_id: TENANT,
        approval_id: APPROVAL_ID,
        run_id: RUN_ID,
        effect_key: EFFECT_KEY,
        expected_payload_sha256: PAYLOAD_SHA256,
        decision: 'APPROVE',
        operator_id: OPERATOR_ID,
        reason: 'Verified customer eligibility under warranty exception',
      });
      // The approval record remains PENDING and was not marked decided inline
      expect(detail?.status).toBe('PENDING');
      expect(detail?.decided_by).toBeNull();
      expect(detail?.decided_at).toBeNull();
      expect(detail?.decision_notes).toBeNull();
      expect(auditRecord).toHaveBeenCalledTimes(1);
      expect(auditRecord).toHaveBeenCalledWith({
        tenant_id: TENANT,
        correlation_id: 'corr-approval-test',
        operation: 'approvals.decision',
        principal_kind: 'OPERATOR',
        operator_id: OPERATOR_ID,
        outcome: 'ACCEPTED',
        detail: {
          approval_id: APPROVAL_ID,
          run_id: RUN_ID,
          effect_key: EFFECT_KEY,
          decision: 'APPROVE',
          expected_payload_sha256: PAYLOAD_SHA256,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('binds the decision to the authenticated operator principal and ignores any operator_id in the body', async () => {
    const { app, decide, detail } = buildHarness();
    const payload = {
      decision: 'REJECT',
      operator_id: 'spoofed-operator-id',
      reason: 'REJECT_POLICY_VIOLATION: Return policy window expired',
      expected_payload_sha256: PAYLOAD_SHA256,
    };

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/approvals/${APPROVAL_ID}/decision`,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        payload,
      });

      expect(response.statusCode).toBe(202);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith({
        tenant_id: TENANT,
        approval_id: APPROVAL_ID,
        run_id: RUN_ID,
        effect_key: EFFECT_KEY,
        expected_payload_sha256: PAYLOAD_SHA256,
        decision: 'REJECT',
        operator_id: OPERATOR_ID,
        reason: 'REJECT_POLICY_VIOLATION: Return policy window expired',
      });
      expect(detail?.status).toBe('PENDING');
      expect(detail?.decided_by).toBeNull();
      expect(detail?.decided_at).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('queues a MODIFY decision forwarding the reviewed digest and modified_payload', async () => {
    const { app, decide, detail } = buildHarness();
    const modified_payload = { order_id: 'ord-123', amount_cents: 2500, restock_fee_applied: true };
    const payload = {
      decision: 'MODIFY',
      reason: 'Approved partial refund minus restock fee',
      expected_payload_sha256: PAYLOAD_SHA256,
      modified_payload,
    };

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/approvals/${APPROVAL_ID}/decision`,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        payload,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        approval_id: APPROVAL_ID,
        status: 'QUEUED',
      });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith({
        tenant_id: TENANT,
        approval_id: APPROVAL_ID,
        run_id: RUN_ID,
        effect_key: EFFECT_KEY,
        expected_payload_sha256: PAYLOAD_SHA256,
        decision: 'MODIFY',
        operator_id: OPERATOR_ID,
        reason: 'Approved partial refund minus restock fee',
        modified_payload,
      });
      expect(detail?.status).toBe('PENDING');
      expect(detail?.decided_by).toBeNull();
      expect(detail?.decided_at).toBeNull();
    } finally {
      await app.close();
    }
  });

  describe('validation mapping', () => {
    it('rejects a non-object request body with HTTP 400 and VALIDATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: {
            authorization: `Bearer ${OPERATOR_TOKEN}`,
            'content-type': 'application/json',
          },
          payload: JSON.stringify(['not-a-json-object']),
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error_code: 'VALIDATION_FAILED',
          retryable: false,
        });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('rejects an unsupported decision verb with HTTP 400 and VALIDATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();
      const payload = {
        decision: 'EXECUTE',
        reason: 'Trying to execute directly',
        expected_payload_sha256: PAYLOAD_SHA256,
      };

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error_code: 'VALIDATION_FAILED',
          retryable: false,
        });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('rejects missing or empty reason with HTTP 400 and VALIDATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const missing = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: { decision: 'APPROVE', expected_payload_sha256: PAYLOAD_SHA256 },
        });
        const whitespace = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: { decision: 'APPROVE', reason: '   ', expected_payload_sha256: PAYLOAD_SHA256 },
        });

        expect(missing.statusCode).toBe(400);
        expect(missing.json().error_code).toBe('VALIDATION_FAILED');
        expect(whitespace.statusCode).toBe(400);
        expect(whitespace.json().error_code).toBe('VALIDATION_FAILED');
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('rejects missing or empty expected_payload_sha256 with HTTP 400 and VALIDATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const missing = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: { decision: 'APPROVE', reason: 'Verified' },
        });
        const empty = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: { decision: 'APPROVE', reason: 'Verified', expected_payload_sha256: '' },
        });

        expect(missing.statusCode).toBe(400);
        expect(missing.json().error_code).toBe('VALIDATION_FAILED');
        expect(empty.statusCode).toBe(400);
        expect(empty.json().error_code).toBe('VALIDATION_FAILED');
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('rejects a MODIFY decision without modified_payload with HTTP 400 and VALIDATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: {
            decision: 'MODIFY',
            reason: 'Changing payload',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error_code).toBe('VALIDATION_FAILED');
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('rejects non-MODIFY decisions with modified_payload present with HTTP 400 and VALIDATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: {
            decision: 'APPROVE',
            reason: 'Approved with superfluous payload',
            expected_payload_sha256: PAYLOAD_SHA256,
            modified_payload: { unexpected: true },
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error_code).toBe('VALIDATION_FAILED');
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  });

  describe('conflict mapping', () => {
    it('maps APPROVAL_STALE_PAYLOAD repository conflict to HTTP 409', async () => {
      const { app, decide } = buildHarness();
      decide.mockRejectedValueOnce(
        new Error('APPROVAL_STALE_PAYLOAD: the reviewed payload digest does not match current state'),
      );

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: {
            decision: 'APPROVE',
            reason: 'Verified',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error_code: 'APPROVAL_STALE_PAYLOAD',
          retryable: false,
        });
      } finally {
        await app.close();
      }
    });

    it('maps APPROVAL_NOT_CLAIMABLE repository conflict to HTTP 409', async () => {
      const { app, decide } = buildHarness();
      decide.mockRejectedValueOnce(
        new Error('APPROVAL_NOT_CLAIMABLE: approval is no longer pending or is held by another worker'),
      );

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: {
            decision: 'APPROVE',
            reason: 'Verified',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error_code: 'APPROVAL_NOT_CLAIMABLE',
          retryable: false,
        });
      } finally {
        await app.close();
      }
    });
  });

  describe('refusal mapping', () => {
    it('refuses unauthenticated requests with HTTP 401 and AUTHENTICATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          payload: {
            decision: 'APPROVE',
            reason: 'Unauthenticated attempt',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error_code: 'AUTHENTICATION_FAILED',
          retryable: false,
        });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('refuses operator missing approval:decide permission with HTTP 403 and INSUFFICIENT_AUTHORITY without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${READONLY_TOKEN}` },
          payload: {
            decision: 'APPROVE',
            reason: 'Readonly operator trying to decide',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          error_code: 'INSUFFICIENT_AUTHORITY',
          retryable: false,
        });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('refuses non-operator session principals with HTTP 403 and INSUFFICIENT_AUTHORITY without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${SESSION_TOKEN}` },
          payload: {
            decision: 'APPROVE',
            reason: 'Customer session trying to decide approval',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          error_code: 'INSUFFICIENT_AUTHORITY',
          retryable: false,
        });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('refuses operator principal without operator identifier with HTTP 401 and AUTHENTICATION_FAILED without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/approvals/${APPROVAL_ID}/decision`,
          headers: { authorization: `Bearer ${NO_ID_TOKEN}` },
          payload: {
            decision: 'APPROVE',
            reason: 'Operator missing id trying to decide',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error_code: 'AUTHENTICATION_FAILED',
          retryable: false,
        });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('refuses non-existent approval with HTTP 404 and NOT_FOUND without queueing', async () => {
      const { app, decide } = buildHarness();

      try {
        const response = await app.inject({
          method: 'POST',
          url: '/approvals/99999999-9999-4999-8999-999999999999/decision',
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
          payload: {
            decision: 'APPROVE',
            reason: 'Approval does not exist',
            expected_payload_sha256: PAYLOAD_SHA256,
          },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({
          error_code: 'NOT_FOUND',
          retryable: false,
        });
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  });
});
