/**
 * R19 — operator-only Marketing campaign draft admission.
 *
 * This route admits a bounded draft request into the durable Marketing workflow. It never executes
 * a Marketing skill and never sends a campaign; the worker owns the later evidence, AUTH-4 pause,
 * and dispatch refusal/approval path.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator, requirePrincipal } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type { TaskAcceptedResponse, TaskStoredState } from '../../gateway/contracts.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { toCampaignProjection } from '../../projections/campaigns.js';
import { campaignsListRouteSchema } from './openapi-schemas.js';

const CAMPAIGN_DRAFT_SKILL = 'campaign.draft';
const CAMPAIGN_DRAFT_ENTRY_SKILL = 'skill.mkt.generate_content';
const CAMPAIGN_EVENT_TYPE = 'campaign.requested';
/**
 * The channel an operator campaign draft is admitted under. It is the Marketing domain contract's
 * own source channel (the worker's `MARKETING_SIGNAL_SOURCE_CHANNELS`), never a browser `WEB_CHAT`
 * turn: an operator command is not a customer conversation and must not be admitted as one.
 */
const CAMPAIGN_SOURCE_CHANNEL = 'MARKETING_CAMPAIGN' as const;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_SEGMENT_ID_LENGTH = 128;
const MAX_OBJECTIVE_LENGTH = 128;
const MAX_CAMPAIGN_NAME_LENGTH = 120;
const MAX_INSTRUCTION_LENGTH = 2000;
const MAX_CONSTRAINT_TEXT_LENGTH = 256;
const MAX_PROHIBITED_CLAIMS = 20;

const CONTENT_CHANNELS: Record<string, true> = {
  LINE_FLEX: true,
  WHATSAPP_TEMPLATE: true,
  EMAIL_HTML: true,
  SMS_TEXT: true,
  ZALO_ZNS: true,
  TIKTOK_CARD: true,
  MESSENGER_GENERIC: true,
  INSTAGRAM_DIRECT: true,
};
const CONTENT_LOCALES: Record<string, true> = {
  'zh-TW': true,
  'en-US': true,
  'vi-VN': true,
  'ja-JP': true,
};
const CONTENT_CONSTRAINT_KEYS: Record<string, true> = {
  channel: true,
  locale: true,
  tone: true,
  max_length: true,
  prohibited_claims: true,
};

const CAMPAIGN_DRAFT_FIELDS: Record<string, true> = {
  idempotency_key: true,
  segment_id: true,
  name: true,
  objective: true,
  instruction: true,
  content_constraints: true,
};


export interface CampaignRouteDeps {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
}

interface CampaignDraftInput {
  readonly segment_id: string;
  readonly name: string;
  readonly objective: string;
  readonly instruction?: string;
  readonly content_constraints?: Record<string, unknown>;
}


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('VALIDATION_FAILED', `${field} is required and must be a non-empty string`);
  }
  if (value.length > maxLength) {
    fail('VALIDATION_FAILED', `${field} exceeds the ${String(maxLength)} character limit`);
  }
  return value.trim();
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('VALIDATION_FAILED', `${field} must be a non-empty string when supplied`);
  }
  if (value.length > maxLength) {
    fail('VALIDATION_FAILED', `${field} exceeds the ${String(maxLength)} character limit`);
  }
  return value.trim();
}

function validateContentConstraints(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    fail('VALIDATION_FAILED', 'content_constraints must be a JSON object');
  }

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(CONTENT_CONSTRAINT_KEYS, key)) {
      fail('VALIDATION_FAILED', `content_constraints.${key} is not supported`);
    }
  }

  const channel = value['channel'];
  if (channel !== undefined && (typeof channel !== 'string' || !Object.hasOwn(CONTENT_CHANNELS, channel))) {
    fail('VALIDATION_FAILED', 'content_constraints.channel is not a supported Marketing content channel');
  }

  const locale = value['locale'];
  if (locale !== undefined && (typeof locale !== 'string' || !Object.hasOwn(CONTENT_LOCALES, locale))) {
    fail('VALIDATION_FAILED', 'content_constraints.locale is not a supported Marketing locale');
  }

  const tone = value['tone'];
  if (tone !== undefined && (typeof tone !== 'string' || tone.trim().length === 0 || tone.length > MAX_CONSTRAINT_TEXT_LENGTH)) {
    fail('VALIDATION_FAILED', 'content_constraints.tone must be a bounded non-empty string');
  }

  const maxLength = value['max_length'];
  if (
    maxLength !== undefined &&
    (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 10000)
  ) {
    fail('VALIDATION_FAILED', 'content_constraints.max_length must be an integer between 1 and 10000');
  }

  const prohibitedClaims = value['prohibited_claims'];
  if (prohibitedClaims !== undefined) {
    if (
      !Array.isArray(prohibitedClaims) ||
      prohibitedClaims.length > MAX_PROHIBITED_CLAIMS ||
      prohibitedClaims.some(
        (claim) => typeof claim !== 'string' || claim.trim().length === 0 || claim.length > MAX_CONSTRAINT_TEXT_LENGTH,
      )
    ) {
      fail('VALIDATION_FAILED', 'content_constraints.prohibited_claims must contain at most 20 bounded strings');
    }
  }

  return {
    ...value,
    ...(typeof tone === 'string' ? { tone: tone.trim() } : {}),
    ...(Array.isArray(prohibitedClaims)
      ? { prohibited_claims: prohibitedClaims.map((claim) => (claim as string).trim()) }
      : {}),
  };
}

function validateDraftBody(body: unknown): {
  readonly idempotency_key: string;
  readonly input: CampaignDraftInput;
} {
  if (!isPlainRecord(body)) {
    fail('VALIDATION_FAILED', 'the request body must be a JSON object');
  }

  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(CAMPAIGN_DRAFT_FIELDS, key)) fail('VALIDATION_FAILED', `${key} is not a supported campaign draft field`);
  }

  const idempotency_key = requiredString(body, 'idempotency_key', MAX_IDEMPOTENCY_KEY_LENGTH);
  const segment_id = requiredString(body, 'segment_id', MAX_SEGMENT_ID_LENGTH);
  const name = requiredString(body, 'name', MAX_CAMPAIGN_NAME_LENGTH);
  const objective = requiredString(body, 'objective', MAX_OBJECTIVE_LENGTH).toLowerCase();
  const instruction = optionalString(body, 'instruction', MAX_INSTRUCTION_LENGTH);
  const content_constraints = validateContentConstraints(body['content_constraints']);

  return {
    idempotency_key,
    input: {
      segment_id,
      name,
      objective,
      ...(instruction === undefined ? {} : { instruction }),
      ...(content_constraints === undefined ? {} : { content_constraints }),
    },
  };
}

function wireStatusOf(state: TaskStoredState): TaskAcceptedResponse['status'] {
  return state === 'queued' ? 'accepted' : state;
}

function acceptedFromReceipt(receipt: Record<string, unknown>): TaskAcceptedResponse {
  const task_id = receipt['task_id'];
  const task_version = receipt['task_version'];
  const correlation_id = receipt['correlation_id'];
  if (typeof task_id !== 'string' || typeof task_version !== 'number' || typeof correlation_id !== 'string') {
    fail('INTERNAL_ERROR', 'the durable campaign receipt is incomplete and cannot be returned');
  }

  const status = receipt['status'];
  return {
    task_id,
    conversation_id: null,
    status:
      status === 'accepted' || status === 'running' || status === 'waiting' || status === 'awaiting_human' ||
      status === 'in_flight' || status === 'IN_FLIGHT' ||
      status === 'completed' || status === 'stopped' || status === 'failed'
        ? status === 'IN_FLIGHT' ? 'in_flight' : status
        : 'accepted',
    task_version,
    correlation_id,
  };
}

function receiptForStarted(started: {
  readonly run_id: string;
  readonly task_version: number;
  readonly correlation_id: string;
  readonly lifecycle_state: TaskStoredState;
}): Record<string, unknown> {
  return {
    task_id: started.run_id,
    conversation_id: null,
    status: wireStatusOf(started.lifecycle_state),
    task_version: started.task_version,
    correlation_id: started.correlation_id,
  };
}

function campaignProjectionPort(runtime: GatewayRuntime) {
  if (runtime.companyCrm === undefined) {
    fail('CAPABILITY_NOT_ENABLED', 'the company CRM projection is not configured');
  }
  return runtime.companyCrm;
}

function requireCampaignReader(request: FastifyRequest) {
  const principal = requirePrincipal(request);
  if (
    principal.kind !== 'OPERATOR' ||
    (!principal.permissions.includes('campaign:draft') && !principal.permissions.includes('approval:read'))
  ) {
    fail('INSUFFICIENT_AUTHORITY', 'this operation requires campaign:draft or approval:read');
  }
  return principal;
}

function queryString(request: FastifyRequest, key: string): string | undefined {
  if (typeof request.query !== 'object' || request.query === null || Array.isArray(request.query)) return undefined;
  const value = (request.query as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return undefined;
}

async function handleCampaignList(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CampaignRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  try {
    const principal = requireCampaignReader(request);
    const rawLimit = queryString(request, 'limit');
    const cursor = queryString(request, 'cursor');
    const page = await campaignProjectionPort(runtime).listCampaigns({
      tenant_id: principal.tenant_id,
      ...(cursor === undefined ? {} : { cursor }),
      ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    });
    await runtime.audit.record({
      tenant_id: principal.tenant_id,
      correlation_id: correlationIdOf(request, runtime),
      operation: 'GET /api/v1/campaigns',
      principal_kind: principal.kind,
      outcome: 'ACCEPTED',
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      detail: { result_count: page.items.length },
    });
    return reply.code(200).send({ items: page.items.map(toCampaignProjection), next_cursor: page.next_cursor });
  } catch (error) {
    return replyFailure(reply, error, correlationIdOf(request, runtime));
  }
}

async function handleCampaignDetail(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CampaignRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  try {
    const principal = requireCampaignReader(request);
    const run_id = typeof request.params === 'object' && request.params !== null
      ? (request.params as Record<string, unknown>)['runId']
      : undefined;
    if (typeof run_id !== 'string' || run_id.length === 0) fail('VALIDATION_FAILED', 'runId is required in the path');
    const row = await campaignProjectionPort(runtime).getCampaign(principal.tenant_id, run_id);
    if (row === null) fail('NOT_FOUND', 'the campaign run was not found');
    await runtime.audit.record({
      tenant_id: principal.tenant_id,
      correlation_id: correlationIdOf(request, runtime),
      operation: 'GET /api/v1/campaigns/{runId}',
      principal_kind: principal.kind,
      outcome: 'ACCEPTED',
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      detail: { run_id },
    });
    return reply.code(200).send(toCampaignProjection(row));
  } catch (error) {
    return replyFailure(reply, error, correlationIdOf(request, runtime));
  }
}
async function handleCampaignSegments(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CampaignRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  try {
    const principal = requireCampaignReader(request);
    const segments = await campaignProjectionPort(runtime).listCampaignSegments(principal.tenant_id);
    await runtime.audit.record({
      tenant_id: principal.tenant_id,
      correlation_id: correlationIdOf(request, runtime),
      operation: 'GET /api/v1/campaigns/segments',
      principal_kind: principal.kind,
      outcome: 'ACCEPTED',
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      detail: { result_count: segments.length },
    });
    return reply.code(200).send({ segments });
  } catch (error) {
    return replyFailure(reply, error, correlationIdOf(request, runtime));
  }
}


export function registerCampaignRoutes(app: FastifyInstance, deps: CampaignRouteDeps): void {
  const preHandler = authenticate(deps);

  app.get('/campaigns', { preHandler, schema: campaignsListRouteSchema }, (request, reply) => handleCampaignList(request, reply, deps));
  app.get('/campaigns/segments', { preHandler }, (request, reply) => handleCampaignSegments(request, reply, deps));

  app.get<{ Params: { runId: string } }>(
    '/campaigns/:runId',
    { preHandler },
    (request, reply) => handleCampaignDetail(request, reply, deps),
  );

  app.post('/campaigns/drafts', { preHandler }, async (request: FastifyRequest, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);

    try {
      const principal = requireOperator(request, 'campaign:draft');
      if (principal.operator_id === undefined || principal.operator_id.length === 0) {
        fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
      }

      const { idempotency_key, input } = validateDraftBody(request.body);
      const segments = await campaignProjectionPort(runtime).listCampaignSegments(principal.tenant_id);
      const segment = segments.find((candidate) => candidate.segment_id === input.segment_id);
      if (segment === undefined) {
        fail('VALIDATION_FAILED', 'Phân khúc chiến dịch không hợp lệ.');
      }
      const payload: Record<string, unknown> = {
        module: 'marketing',
        skill_id: CAMPAIGN_DRAFT_ENTRY_SKILL,
        input,
      };
      const effect_key = runtime.effects.computeEffectKey({
        tenant_id: principal.tenant_id,
        skill_id: CAMPAIGN_DRAFT_SKILL,
        step_index: 0,
        action_revision: 0,
        request_id: idempotency_key,
      });
      const request_fingerprint = runtime.effects.computeRequestFingerprint(payload);

      const stored = await runtime.receipts.receiptFor(principal.tenant_id, effect_key);
      if (stored !== null) {
        if (stored['request_fingerprint'] !== request_fingerprint) {
          fail('IDEMPOTENCY_CONFLICT', 'this idempotency key was already claimed for a different campaign draft');
        }
        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'campaigns.drafts',
          principal_kind: principal.kind,
          operator_id: principal.operator_id,
          outcome: 'ACCEPTED',
          detail: { replay: true, effect_key },
        });
        return reply.code(202).send(acceptedFromReceipt(stored));
      }

      const campaign_id = runtime.ids();
      const channel = input.content_constraints?.['channel'];
      const started = await runtime.runs.start({
        tenant_id: principal.tenant_id,
        correlation_id,
        request_id: idempotency_key,
        admission_skill_id: CAMPAIGN_DRAFT_SKILL,
        source_channel: CAMPAIGN_SOURCE_CHANNEL,
        event_type: CAMPAIGN_EVENT_TYPE,
        session_id: principal.operator_id,
        channel_type: CAMPAIGN_SOURCE_CHANNEL,
        channel_identifier: principal.operator_id,
        payload,
        campaign: {
          campaign_id,
          name: input.name,
          objective: input.objective,
          channels: typeof channel === 'string' ? [channel] : ['EMAIL_HTML'],
          audience_count: segment.audience_count,
        },
      });

      const receipt = started.receipt ?? receiptForStarted(started);
      if (receipt['request_fingerprint'] !== undefined && receipt['request_fingerprint'] !== request_fingerprint) {
        fail('IDEMPOTENCY_CONFLICT', 'this idempotency key was already claimed for a different campaign draft');
      }
      const storedReceipt =
        receipt['request_fingerprint'] === request_fingerprint
          ? receipt
          : { ...receipt, request_fingerprint };

      if (started.admission !== 'REPLAY') {
        await runtime.receipts.storeReceipt(principal.tenant_id, effect_key, storedReceipt);
      }

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id,
        operation: 'campaigns.drafts',
        principal_kind: principal.kind,
        operator_id: principal.operator_id,
        outcome: 'ACCEPTED',
        detail: {
          run_id: started.run_id,
          effect_key,
          segment_id: input.segment_id,
          objective: input.objective,
          replay: started.admission === 'REPLAY',
        },
      });

      return reply.code(202).send(acceptedFromReceipt(storedReceipt));
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}
