import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerOperationRoutes } from './operations.js';

const TENANT = 'tenant-operations';
const OPERATOR_TOKEN = 'operator-operations';
const RUN_READER_TOKEN = 'operator-operations-reader';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

function buildHarness() {
  const classifyRetry = vi.fn(async () => ({
    retryable: true as const,
    failure_class: 'PRE_DISPATCH_PROVIDER_REJECTION' as const,
    effect_key: 'effect-1',
  }));
  const retry = vi.fn(async () => ({
    run_id: 'run-1',
    task_version: 3,
    lifecycle_state: 'queued' as const,
    correlation_id: 'corr-operations',
    conversation_id: CONVERSATION_ID,
  }));
  const listRuns = vi.fn(async () => ({ items: [], next_cursor: null }));
  const runtime = {
    runs: { classifyRetry, retry, list: listRuns },
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-operations',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerOperationRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        {
          token: OPERATOR_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-1',
          permissions: ['run:retry'],
        },
        {
          token: RUN_READER_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-reader',
          permissions: ['run:read'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, classifyRetry, listRuns, retry };
}

describe('R13 retry response', () => {
  it('returns the durable conversation_id when the retried run is conversation-bound', async () => {
    const { app, retry } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/operations/runs/run-1/retry',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        payload: { reason: 'provider rejection was confirmed side-effect-free' },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        task_id: 'run-1',
        conversation_id: CONVERSATION_ID,
        status: 'accepted',
      });
      expect(retry).toHaveBeenCalledWith({
        tenant_id: TENANT,
        run_id: 'run-1',
        operator_id: 'operator-1',
        reason: 'provider rejection was confirmed side-effect-free',
      });
    } finally {
      await app.close();
    }
  });

  it('authenticates before reading retry input or classifying a run', async () => {
    const { app, classifyRetry } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/operations/runs/run-1/retry',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error_code).toBe('AUTHENTICATION_FAILED');
      expect(classifyRetry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
describe('GET /runs limit validation', () => {
  it('rejects non-integer and out-of-range limits before listing runs', async () => {
    const { app, listRuns } = buildHarness();
    try {
      for (const limit of ['abc', '0', '1000']) {
        const response = await app.inject({
          method: 'GET',
          url: `/runs?limit=${limit}`,
          headers: { authorization: `Bearer ${RUN_READER_TOKEN}` },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error_code).toBe('VALIDATION_FAILED');
      }
      expect(listRuns).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
