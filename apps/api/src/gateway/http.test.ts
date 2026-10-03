import { Writable } from 'node:stream';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { FAILURE_STATUS } from './contracts.js';
import { mapError, replyFailure } from './http.js';

const repositoryMappings = [
  ['PORT_UNBOUND', 'CAPABILITY_UNAVAILABLE', 503],
  ['LLM_CONFIG_INVALID', 'VALIDATION_FAILED', 400],
  ['CUSTOMER_LIST_CURSOR_INVALID', 'VALIDATION_FAILED', 400],
  ['CUSTOMER_LIST_LIMIT_INVALID', 'VALIDATION_FAILED', 400],
  ['CAMPAIGN_LIST_CURSOR_INVALID', 'VALIDATION_FAILED', 400],
  ['CAMPAIGN_LIST_LIMIT_INVALID', 'VALIDATION_FAILED', 400],
  ['CONVERSATION_NOT_FOUND', 'CONVERSATION_NOT_FOUND', 404],
  ['APPROVAL_ID_INVALID', 'VALIDATION_FAILED', 400],
  ['APPROVAL_LIMIT_INVALID', 'VALIDATION_FAILED', 400],
  ['APPROVAL_EXPIRY_LIMIT_INVALID', 'VALIDATION_FAILED', 400],
  ['APPROVAL_TENANT_ID_REQUIRED', 'VALIDATION_FAILED', 400],
  ['APPROVAL_NOT_FOUND', 'NOT_FOUND', 404],
  ['APPROVAL_ALREADY_DECIDED', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_BINDING_MISMATCH', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_ACTION_UNSTABLE', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_UNSTABLE', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_NOT_CLAIMABLE', 'APPROVAL_NOT_CLAIMABLE', 409],
  ['APPROVAL_EXPIRED', 'APPROVAL_EXPIRED', 409],
  ['APPROVAL_STALE_PAYLOAD', 'APPROVAL_STALE_PAYLOAD', 409],
  ['APPROVAL_DECISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_RESUME_EVENT_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_ACTION_DISPATCHED', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_IDENTITY_CHANGED', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_REVISION_INVALID', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_EFFECT_KEY_UNCHANGED', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_EFFECT_KEY_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
  ['APPROVAL_WRITE_LOST', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_INPUT_INVALID', 'VALIDATION_FAILED', 400],
  ['HANDOFF_TIMESTAMP_INVALID', 'VALIDATION_FAILED', 400],
  ['HANDOFF_SESSION_BINDING_INVALID', 'VALIDATION_FAILED', 400],
  ['HANDOFF_CUSTOMER_BINDING_INVALID', 'VALIDATION_FAILED', 400],
  ['HANDOFF_CONVERSATION_NOT_FOUND', 'NOT_FOUND', 404],
  ['HANDOFF_EFFECT_RESERVATION_NOT_FOUND', 'NOT_FOUND', 404],
  ['HANDOFF_RECEIPT_INVALID', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_QUEUE_TIMEOUT', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_EFFECT_BINDING_MISMATCH', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_TASK_NOT_ACTIVE', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_CHECKPOINT_MISMATCH', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_ALREADY_ACTIVE', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_CONVERSATION_NOT_AVAILABLE', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_EFFECT_RESERVATION_INVALID', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_QUEUE_STATE_INVALID', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_TASK_STATE_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_CONVERSATION_STATE_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_EFFECT_SETTLEMENT_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_STATE_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
  ['HANDOFF_EVIDENCE_PENDING', 'IDEMPOTENCY_CONFLICT', 409],
  ['TASK_REQUEUE_REASON_REQUIRED', 'VALIDATION_FAILED', 400],
  ['RUN_NOT_RECONCILABLE', 'RUN_NOT_RECONCILABLE', 409],
  ['TASK_ALREADY_TERMINAL', 'RUN_NOT_RETRYABLE', 409],
  ['RECONCILIATION_EVENT_CONFLICT', 'RUN_NOT_RECONCILABLE', 409],
  ['RUN_LOG_PROJECTION_INVALID', 'VALIDATION_FAILED', 400],
  ['PLATFORM_TENANT_ID_REQUIRED', 'VALIDATION_FAILED', 400],
  ['PLATFORM_USAGE_WINDOW_INVALID', 'VALIDATION_FAILED', 400],
  ['P5_PROVISIONING_EMPTY_RESULT', 'IDEMPOTENCY_CONFLICT', 409],
  ['P5_AUTONOMY_COMMIT_EMPTY', 'IDEMPOTENCY_CONFLICT', 409],
  ['P5_AUTONOMY_EVENT_EMPTY', 'IDEMPOTENCY_CONFLICT', 409],
  ['P5_AUTONOMY_CONTROL_EMPTY', 'IDEMPOTENCY_CONFLICT', 409],
  ['P5_COST_UNSTABLE', 'IDEMPOTENCY_CONFLICT', 409],
  ['P5_COST_USAGE_INVALID', 'VALIDATION_FAILED', 400],
] as const;

const postgresMappings = [
  ['42501', 'DEPENDENCY_MISCONFIGURED', 503],
  ['42883', 'DEPENDENCY_MISCONFIGURED', 503],
  ['22P02', 'VALIDATION_FAILED', 400],
] as const;

describe('gateway approval refusal mapping', () => {
  it('preserves the core REQUIRE_HUMAN_APPROVAL decision code', () => {
    const response = mapError(
      { name: 'SkillError', code: 'REQUIRE_HUMAN_APPROVAL' },
      'correlation-approval',
    );

    expect(response.error_code).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(response.correlation_id).toBe('correlation-approval');
  });
});

describe('gateway database refusal mapping', () => {
  it.each(postgresMappings)('maps PostgreSQL %s', (postgres_code, error_code, status) => {
    const response = mapError({ name: 'DatabaseError', code: postgres_code }, 'correlation-database');

    expect(response.error_code).toBe(error_code);
    expect(FAILURE_STATUS[response.error_code]).toBe(status);
  });

  it.each(repositoryMappings)('maps repository code %s', (repository_code, error_code, status) => {
    const response = mapError(new Error(`${repository_code}: repository refusal`), 'correlation-repository');

    expect(response.error_code).toBe(error_code);
    expect(FAILURE_STATUS[response.error_code]).toBe(status);
  });
});

describe('gateway refusal logging', () => {
  it('logs an unknown 5xx once with correlation and route but no request or error detail', async () => {
    const lines: string[] = [];
    const loggerStream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = Fastify({ logger: { level: 'error', stream: loggerStream } });
    app.setErrorHandler((error, _request, reply) =>
      replyFailure(reply, error, 'correlation-unknown-failure'),
    );
    app.post('/api/v1/items/:item_id', async () => {
      throw Object.assign(new Error('unexpected failure'), {
        detail: 'database-secret',
        body: 'request-secret',
      });
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/items/not-a-uuid?access_token=query-secret',
        payload: { customer_secret: 'body-secret' },
      });
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const errors = records.filter((record) => record['level'] === 50);

      expect(response.statusCode).toBe(500);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        correlation_id: 'correlation-unknown-failure',
        error_code: 'INTERNAL_ERROR',
        route: '/api/v1/items/:item_id',
        err: {
          name: 'Error',
          message: 'unexpected failure',
        },
      });
      expect(JSON.stringify(errors[0])).not.toContain('database-secret');
      expect(JSON.stringify(errors[0])).not.toContain('request-secret');
      expect(JSON.stringify(errors[0])).not.toContain('body-secret');
      expect(JSON.stringify(errors[0])).not.toContain('query-secret');
    } finally {
      await app.close();
    }
  });
});
