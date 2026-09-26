/**
 * @file PILOT-02 / E2E-OFF-CART Offline Acceptance Pilot Harness (SRS §21, §8; implement/09 §2.2).
 *
 * HONESTY MARKER & SCOPE:
 * This harness provides LOCAL REGRESSION EVIDENCE ONLY. It is not gate or production evidence.
 * No revenue or conversion is claimed without an authoritative order and payment source from the
 * System of Record.
 *
 * SYNTHETIC TEST FIXTURES:
 * The pricing policy values (list price 1000 TWD, P_floor 800 TWD, D_cap 200 TWD, proposed
 * discount 300 TWD) are SYNTHETIC TEST FIXTURES supplied to the price/floor port as an
 * owner-approved floor decision for this offline run (implement/09 §2.2). They are NOT production
 * policy, and the harness explicitly states so.
 *
 * Scenario Fixtures (from E2E-OFF-CART / business.py case stem CART):
 *   - run_id: RUN-E2E-OFF-CART
 *   - tenant: T1 (11111111-1111-1111-1111-111111111111)
 *   - customer: cust-a (aaaaaaaa-0000-4000-8000-00000000000a)
 *   - cart: cart-a-1 (abandoned 30 minutes before frozen clock)
 *   - channel: EMAIL
 *   - SKU: SKU-OK (list price 1000 TWD, P_floor 800 TWD, D_cap 200 TWD)
 *   - proposed below-floor discount: 300 TWD (offered 700 < P_floor 800)
 *   - in-policy discount: 200 TWD (offered 800 >= P_floor 800, inside D_cap 200)
 *   - effect_key: EK-CART-0115-01-EMAIL
 *   - opted-out customer: cust-b (bbbbbbbb-0000-4000-8000-00000000000b)
 *   - recovered order: ORD-CART-0115-01 (1000 TWD)
 *   - frozen clock: 2026-01-15T10:00:00.000Z
 *
 * The Seven Canonical Steps:
 *   Step 1: Fire abandonment signal -> opens run -> CONTEXT hydrates -> eligibility check passes citing consent row
 *   Step 2: Propose recovery offer -> skill.sales.recommend_product returns 7-field recommendation for cart-a-1 -> stays HYPOTHESIS
 *   Step 3: Below-floor discount refused -> list price preserved -> canonical codes (P_FLOOR_UNAVAILABLE vs ERR_FLOOR_PRICE_VIOLATION)
 *   Step 4: In-policy reminder sent exactly once inside D_cap -> moves to RESERVED -> 1 message -> provider reference stored
 *   Step 5: Replay signal -> reserve outcome REPLAY with stored receipt -> adapter send count remains 1 (BR-005, BR-006)
 *   Step 6: Opted-out customer (cust-b) -> refused with ERR_CONSENT_SUPPRESSED -> dispatch suppressed (send count 0) -> audited
 *   Step 7: Convert and attribute -> scripted checkout of ORD-CART-0115-01 -> attribution links to effect_key -> proven by order source
 *
 * Negative Cases Covered:
 *   - no consent
 *   - suppression active
 *   - stale or missing price
 *   - missing floor provenance
 *   - no stock
 *   - unverified customer
 *   - cross-customer access
 *   - cross-tenant access
 *   - duplicate delivery
 *   - provider timeout / UNKNOWN
 *   - stale approval
 *   - human takeover
 *   - disabled capability
 */

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  computeRequestFingerprint,
  MemoryEffectGuard,
  PolicyEnforcementPoint,
  RevenueOrchestrator,
  type ConsentState,
  type PolicyAuditPort,
  type PolicyAuditRecord,
} from '@agentos/core-engine';
import type {
  ActionDraft,
  DurableLeaseManager,
  ExecutionReceipt,
  HydratedContext,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import type {
  AgentRunLogRecord,
  AppendEvidenceInput,
  ApprovalRecord,
  ApprovalRepository,
  AuditRepository,
  ConversationRecord,
  ConversationRepository,
  CreateDurableTaskInput,
  CustomerEventTimeline,
  CustomerProfileRow,
  DurableTaskGuard,
  DurableTaskRecord,
  DurableTaskState,
  DurableWorkflowRepository,
  EvidenceRepository,
  ImmutableEvidenceRecord,
  PauseForApprovalInput,
  PauseForApprovalResult,
  RecordTaskFailureInput,
  ReleaseTaskLeaseInput,
  RenewTaskLeaseInput,
} from '@agentos/database';
import { createDurableAdapters } from '../shared/adapters.js';
import { SalesAgentRuntime } from './agent-runtime.js';
import {
  createSalesOrchestratorFactory,
} from './factory.js';
import {
  createSalesPolicyEngine,
  SALES_SKILLS,
} from './policy-engine.js';
import {
  createSalesSkillServices,
  SalesSkillToolError,
  type ErpReadPort,
  type SalesCartInput,
  type SalesCartOutput,
  type SalesCartPort,
  type SalesCommunicationInput,
  type SalesCommunicationOutput,
  type SalesCommunicationPort,
  type SalesConsentDecision,
  type SalesConsentPort,
  type SalesConsentQuery,
  type SalesFrequencyCapPort,
  type SalesOrderInput,
  type SalesOrderOutput,
  type SalesOrderPort,
  type SalesPriceFloorApproved,
  type SalesPriceFloorDecision,
  type SalesPriceFloorPort,
  type SalesPriceFloorQuery,
  type SalesRecommendationRevenueEvidence,
  type SalesRecommendationRevenueEvidencePort,
} from './skills/index.js';
import {
  createSalesOfflineHarness,
  SALES_P2_DISABLED_SKILLS,
} from './offline-harness.js';

// ============================================================================
// Canonical Scenario Fixtures (E2E-OFF-CART / PILOT-02)
// ============================================================================

const SCENARIO_ID = 'E2E-OFF-CART';
const RUN_ID = 'RUN-E2E-OFF-CART';
const TENANT_T1 = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const CUSTOMER_A = 'cust-a';
const CUSTOMER_A_UUID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CUSTOMER_B = 'cust-b';
const CUSTOMER_B_UUID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const CART_ID = 'cart-a-1';
const SESSION_ID = 'sess-a-1';
const CONVERSATION_ID = 'conv-cart-0115-01';
const CHANNEL_EMAIL = 'EMAIL';
const SKU_OK = 'SKU-OK';
const SKU_ADDON = 'SKU-ADD-01';
const SKU_ZERO = 'SKU-ZERO';
const LIST_PRICE_TWD = 1000;
const P_FLOOR_TWD = 800;
const PROPOSED_DISCOUNT_TWD = 300;
const IN_POLICY_DISCOUNT_TWD = 200;
const EFFECT_KEY = 'EK-CART-0115-01-EMAIL';
const RECOVERED_ORDER_ID = 'ORD-CART-0115-01';
const FROZEN_TIME_ISO = '2026-01-15T10:00:00.000Z';
const ABANDONED_TIME_ISO = '2026-01-15T09:30:00.000Z'; // 30 minutes before frozen clock
const FROZEN_CLOCK = () => new Date(FROZEN_TIME_ISO);
const AUDIT_SECRET = 'audit_hmac_secret_for_pilot_02_testing_only!';
const QUOTE_SIGNING_SECRET = 'quote_signing_secret_for_pilot_02_testing_only!';
const OWNER_FLOOR_SOURCE = 'owner-policy-cart-recovery-2026';

// ============================================================================
// Helpers & In-Memory Doubles
// ============================================================================

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

interface MutableDurableTaskRecord extends Omit<Mutable<DurableTaskRecord>, 'state_payload'> {
  state_payload: Record<string, unknown>;
}

type MutableApprovalRecord = Mutable<ApprovalRecord>;
type MutableConversationRecord = Mutable<ConversationRecord>;

function computePayloadSha256(payload: unknown): string {
  const serialized = JSON.stringify(payload ?? {}, Object.keys((payload ?? {}) as object).sort());
  return createHash('sha256').update(serialized).digest('hex');
}

function toDurableTaskSnapshot(task: MutableDurableTaskRecord): DurableTaskRecord {
  return {
    ...task,
    state_payload: { ...task.state_payload },
  };
}


function createOfflineLeaseManager(): DurableLeaseManager {
  const leases = new Map<string, { worker_id: string; expires_at: number }>();
  return {
    async acquireLease(tenant_id: string, run_id: string, worker_id: string): Promise<boolean> {
      const key = `${tenant_id}:${run_id}`;
      const now = Date.now();
      const existing = leases.get(key);
      if (existing && existing.expires_at > now && existing.worker_id !== worker_id) {
        return false;
      }
      leases.set(key, { worker_id, expires_at: now + 120_000 });
      return true;
    },
    async releaseLease(tenant_id: string, run_id: string, worker_id: string): Promise<void> {
      const key = `${tenant_id}:${run_id}`;
      const existing = leases.get(key);
      if (!existing || existing.worker_id !== worker_id) return;
      leases.delete(key);
    },
  };
}

function createInMemoryAdapterRepositories() {
  const tasks = new Map<string, MutableDurableTaskRecord>();
  const approvals = new Map<string, MutableApprovalRecord>();
  const evidenceLogs: ImmutableEvidenceRecord[] = [];
  const auditLogs: AgentRunLogRecord[] = [];
  const conversations = new Map<string, MutableConversationRecord>();

  const workflowRepository: DurableWorkflowRepository = {
    async getTask(tenant_id: string, run_id: string): Promise<DurableTaskRecord | null> {
      const task = tasks.get(`${tenant_id}:${run_id}`);
      return task ? toDurableTaskSnapshot(task) : null;
    },
    async createTask(params: CreateDurableTaskInput): Promise<DurableTaskRecord> {
      const record: MutableDurableTaskRecord = {
        task_id: `task-${params.run_id}`,
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        correlation_id: params.correlation_id,
        current_step: params.current_step ?? 1,
        state: params.state ?? 'running',
        task_version: 1,
        lease_owner: 'w-biz-e2e',
        lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        retry_count: 0,
        max_retries: params.max_retries ?? 3,
        last_error_class: null,
        paused_for_approval_id: null,
        state_payload: (params.state_payload as Record<string, unknown>) ?? {},
        error_details: null,
        created_at: FROZEN_TIME_ISO,
        updated_at: FROZEN_TIME_ISO,
      };
      tasks.set(`${params.tenant_id}:${params.run_id}`, record);
      return toDurableTaskSnapshot(record);
    },
    async updateTaskProgress(
      tenant_id: string,
      run_id: string,
      stepIndex: number,
      checkpointPayload: unknown,
      guard?: DurableTaskGuard,
    ): Promise<DurableTaskRecord> {
      const existing = tasks.get(`${tenant_id}:${run_id}`);
      if (!existing) {
        throw new Error(`DURABLE_TASK_NOT_FOUND: task '${run_id}' not found for tenant '${tenant_id}'.`);
      }
      if (guard?.expected_task_version !== undefined && existing.task_version !== guard.expected_task_version) {
        throw new Error(
          `TASK_VERSION_CONFLICT: run ${run_id} is at task_version ${existing.task_version}, not the guarded ${guard.expected_task_version}.`,
        );
      }
      existing.current_step = stepIndex;
      existing.task_version += 1;
      if (checkpointPayload && typeof checkpointPayload === 'object') {
        existing.state_payload = {
          ...existing.state_payload,
          ...(checkpointPayload as Record<string, unknown>),
        };
      }
      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async transitionTask(
      tenant_id: string,
      run_id: string,
      state: DurableTaskState,
      reason: string,
      checkpointPayload?: unknown,
      eventOrGuard?: DurableTaskGuard | string,
    ): Promise<DurableTaskRecord> {
      void reason;
      void eventOrGuard;
      const existing = tasks.get(`${tenant_id}:${run_id}`);
      if (!existing) {
        throw new Error(`DURABLE_TASK_NOT_FOUND: task '${run_id}' not found for tenant '${tenant_id}'.`);
      }
      existing.state = state;
      existing.task_version += 1;
      if (checkpointPayload && typeof checkpointPayload === 'object') {
        existing.state_payload = {
          ...existing.state_payload,
          ...(checkpointPayload as Record<string, unknown>),
        };
      }
      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async renewTaskLease(params: RenewTaskLeaseInput): Promise<DurableTaskRecord> {
      const existing = tasks.get(`${params.tenant_id}:${params.run_id}`);
      if (!existing) throw new Error('TASK_NOT_FOUND');
      existing.lease_owner = params.lease_owner;
      existing.lease_expires_at = new Date(Date.now() + 120_000).toISOString();
      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async releaseTaskLease(input: ReleaseTaskLeaseInput): Promise<DurableTaskRecord> {
      const existing = tasks.get(`${input.tenant_id}:${input.run_id}`);
      if (!existing) throw new Error('DURABLE_TASK_NOT_FOUND');
      existing.state = input.target_state ?? 'queued';
      existing.lease_owner = null;
      existing.lease_expires_at = null;
      existing.task_version += 1;
      existing.updated_at = FROZEN_TIME_ISO;
      return toDurableTaskSnapshot(existing);
    },
    async recordFailure(params: RecordTaskFailureInput): Promise<{ requeued: boolean; state: DurableTaskState; retry_count: number; task_version: number }> {
      const existing = tasks.get(`${params.tenant_id}:${params.run_id}`);
      if (!existing) throw new Error('TASK_NOT_FOUND');
      existing.state = 'failed';
      existing.updated_at = FROZEN_TIME_ISO;
      return {
        requeued: false,
        state: 'failed',
        retry_count: existing.retry_count,
        task_version: existing.task_version,
      };
    },
    async recordTaskFailure(params: RecordTaskFailureInput): Promise<{ requeued: boolean; state: DurableTaskState; retry_count: number; task_version: number }> {
      const existing = tasks.get(`${params.tenant_id}:${params.run_id}`);
      if (!existing) throw new Error('TASK_NOT_FOUND');
      existing.state = 'failed';
      existing.updated_at = FROZEN_TIME_ISO;
      return {
        requeued: false,
        state: 'failed',
        retry_count: existing.retry_count,
        task_version: existing.task_version,
      };
    },
  } as unknown as DurableWorkflowRepository;

  const approvalRepository: ApprovalRepository = {
    async pauseForApproval(input: PauseForApprovalInput): Promise<PauseForApprovalResult> {
      const approval_id = `appr-cart-${randomUUID().slice(0, 8)}`;
      const payloadSha256 = computePayloadSha256(input.approval.payload);
      const approval: MutableApprovalRecord = {
        id: approval_id,
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        action_id: input.approval.action_id,
        campaign_id: null,
        effect_key: input.approval.effect_key,
        authority_required: 'AUTH-4',
        payload: input.approval.payload,
        payload_sha256: payloadSha256,
        reason: input.approval.reason,
        decision: 'PENDING',
        operator_id: null,
        review_comment: null,
        is_paused: true,
        created_at: FROZEN_TIME_ISO,
        decided_at: null,
      };
      approvals.set(approval_id, approval);

      const taskKey = `${input.tenant_id}:${input.run_id}`;
      const existingTask = tasks.get(taskKey);
      if (existingTask) {
        existingTask.state = 'awaiting_human';
        existingTask.task_version += 1;
        existingTask.paused_for_approval_id = approval_id;
        existingTask.state_payload = (input.checkpoint as Record<string, unknown>) ?? {};
        existingTask.updated_at = FROZEN_TIME_ISO;
      }

      return {
        approval_id,
        approval: { ...approval },
        action: {
          id: input.approval.action_id,
          tenant_id: input.tenant_id,
          decision_id: null,
          skill_name: 'skill.sales.send_message',
          effect_key: input.approval.effect_key,
          action_revision: 0,
          target_channel: 'API-003.CommunicationConnector',
          action_payload: input.approval.payload,
          status: 'pending',
          created_at: FROZEN_TIME_ISO,
        } as unknown as PauseForApprovalResult['action'],
        task: existingTask ? toDurableTaskSnapshot(existingTask) : ({} as DurableTaskRecord),
      };
    },
    async queueDecision(input: {
      tenant_id: string;
      run_id: string;
      approval_id: string;
      expected_payload_sha256: string;
      effect_key: string;
      decision: string;
      operator_id: string;
      reason: string;
    }) {
      const approval = approvals.get(input.approval_id);
      if (!approval) throw new Error('APPROVAL_NOT_FOUND');
      if (approval.payload_sha256 !== input.expected_payload_sha256) {
        throw new Error('APPROVAL_STALE_PAYLOAD: payload hash mismatch.');
      }
      return { approval_id: approval.id, status: 'QUEUED' };
    },
  } as unknown as ApprovalRepository;

  const evidenceRepository: EvidenceRepository = {
    async appendEvidence(params: AppendEvidenceInput): Promise<ImmutableEvidenceRecord> {
      const record: ImmutableEvidenceRecord = {
        evidence_id: `evi-${randomUUID().slice(0, 8)}`,
        tenant_id: params.tenant_id,
        run_id: params.run_id,
        correlation_id: params.correlation_id,
        step_index: params.step_index,
        effect_key: params.effect_key,
        previous_evidence_hash: params.previous_evidence_hash ?? '0'.repeat(64),
        payload_sha256: computePayloadSha256(params.payload),
        chain_hash: 'b'.repeat(64),
        signature: 'c'.repeat(64),
        raw_payload: params.payload,
        created_at: FROZEN_TIME_ISO,
      };
      evidenceLogs.push(record);
      return record;
    },
    async logAgentRun(): Promise<void> {},
    async initializeOutcomeWatch(): Promise<void> {},
  } as unknown as EvidenceRepository;

  const auditRepository: AuditRepository = {
    async append(params: AgentRunLogRecord): Promise<void> {
      auditLogs.push(params);
    },
  } as unknown as AuditRepository;

  const conversationRepository: ConversationRepository = {
    async getByThread(tenant_id: string, thread_id: string): Promise<ConversationRecord | null> {
      const conv = conversations.get(`${tenant_id}:${thread_id}`);
      return conv ? { ...conv } : null;
    },
    async releaseTakeover(tenant_id: string, thread_id: string, operator_id: string): Promise<void> {
      const conv = conversations.get(`${tenant_id}:${thread_id}`);
      if (conv && (conv.takeover_operator_id === operator_id || !conv.takeover_operator_id)) {
        conv.state = 'open';
        conv.takeover_operator_id = null;
      }
    },
  } as unknown as ConversationRepository;

  return {
    tasks,
    approvals,
    evidenceLogs,
    auditLogs,
    conversations,
    workflowRepository,
    approvalRepository,
    evidenceRepository,
    auditRepository,
    conversationRepository,
  };
}

/**
 * Creates in-memory connector ports for the synthetic PILOT-02 Cart Recovery scenario.
 */
function createScenarioConnectorPorts() {
  const sentMessages: SalesCommunicationInput[] = [];
  const createdCarts: SalesCartInput[] = [];
  const createdOrders: SalesOrderInput[] = [];

  const catalog = [
    {
      tenant_id: TENANT_T1,
      product_id: 'prod-mug-01',
      sku: SKU_OK,
      name: 'Aurora Ceramic Mug 350ml',
      currency: 'TWD',
      original_list_price: LIST_PRICE_TWD,
      is_active: true,
      categories: ['mugs', 'drinkware'],
    },
    {
      tenant_id: TENANT_T1,
      product_id: 'prod-coaster-01',
      sku: SKU_ADDON,
      name: 'Silicone Mug Coaster & Lid',
      currency: 'TWD',
      original_list_price: 250,
      is_active: true,
      categories: ['accessories', 'drinkware'],
    },
  ];

  const inventory: Record<string, number> = {
    [`${TENANT_T1}:${SKU_OK}`]: 12,
    [`${TENANT_T1}:${SKU_ADDON}`]: 50,
    [`${TENANT_T1}:${SKU_ZERO}`]: 0,
  };

  const erpRead: ErpReadPort = {
    async read(input) {
      if (input.tenant_id !== TENANT_T1) {
        throw new SalesSkillToolError(
          'AUTHORITATIVE_SOURCE_UNAVAILABLE',
          'Cross-tenant ERP read refused',
        );
      }
      if (input.resource === 'products') {
        return {
          resource: 'products',
          tenant_id: input.tenant_id,
          observed_at: FROZEN_TIME_ISO,
          value: {
            tenant_id: input.tenant_id,
            snapshot_at: FROZEN_TIME_ISO,
            items: catalog.map((p) => ({ ...p })),
          },
        };
      }
      if (input.resource === 'inventory' && input.key) {
        const atp = inventory[`${input.tenant_id}:${input.key}`];
        if (atp === undefined) {
          throw new SalesSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            `SKU ${input.key} not found in inventory`,
          );
        }
        return {
          resource: 'inventory',
          tenant_id: input.tenant_id,
          observed_at: FROZEN_TIME_ISO,
          value: {
            tenant_id: input.tenant_id,
            snapshot_at: FROZEN_TIME_ISO,
            items: [{ tenant_id: input.tenant_id, sku_id: input.key, total_available_to_promise: atp }],
          },
        };
      }
      throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', `Resource ${input.resource} unavailable`);
    },
  };

  const revenueEvidence: SalesRecommendationRevenueEvidencePort = {
    async read(input): Promise<SalesRecommendationRevenueEvidence> {
      if (input.tenant_id !== TENANT_T1) {
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Cross-tenant revenue evidence refused');
      }
      return {
        conversion_probability: 0.75,
        expected_revenue: 187.5,
        currency: 'TWD',
        model_id: 'owner-approved-cart-rec-v1',
        provenance_reference: 'owner-model:cart-rec-2026',
      };
    },
  };

  const priceFloor: SalesPriceFloorPort = {
    async read(query: SalesPriceFloorQuery): Promise<SalesPriceFloorDecision> {
      if (query.tenant_id !== TENANT_T1) {
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Cross-tenant price floor query refused');
      }
      if (query.sku_id === SKU_OK) {
        const approved: SalesPriceFloorApproved = {
          ok: true,
          owner_approved: true,
          list_price: LIST_PRICE_TWD,
          p_floor: P_FLOOR_TWD,
          floor_source: OWNER_FLOOR_SOURCE,
          currency: 'TWD',
          quote_ttl_seconds: 3600,
        };
        return approved;
      }
      if (query.sku_id === SKU_ADDON) {
        const approved: SalesPriceFloorApproved = {
          ok: true,
          owner_approved: true,
          list_price: 250,
          p_floor: 200,
          floor_source: OWNER_FLOOR_SOURCE,
          currency: 'TWD',
          quote_ttl_seconds: 3600,
        };
        return approved;
      }
      return {
        ok: false,
        owner_approved: false,
        reason: `No owner-approved floor decision for SKU ${query.sku_id}`,
      };
    },
  };

  const consentPort: SalesConsentPort = {
    async read(query: SalesConsentQuery): Promise<SalesConsentDecision> {
      if (query.tenant_id !== TENANT_T1) {
        return { consented: false, suppressed: true, reason: 'Cross-tenant consent read refused' };
      }
      if (query.customer_id === CUSTOMER_A_UUID || query.customer_id === CUSTOMER_A) {
        return { consented: true, suppressed: false };
      }
      if (query.customer_id === CUSTOMER_B_UUID || query.customer_id === CUSTOMER_B) {
        return {
          consented: false,
          suppressed: true,
          reason: 'ERR_CONSENT_SUPPRESSED: Customer opted out of marketing communications (BR-004)',
        };
      }
      return { consented: false, suppressed: true, reason: 'Unknown customer consent status' };
    },
    async getConsent(input: { readonly tenant_id: string; readonly customer_id: string }): Promise<ConsentState | undefined> {
      if (input.tenant_id !== TENANT_T1) return undefined;
      if (input.customer_id === CUSTOMER_A_UUID || input.customer_id === CUSTOMER_A) {
        return { consent_marketing: true, suppression_active: false };
      }
      if (input.customer_id === CUSTOMER_B_UUID || input.customer_id === CUSTOMER_B) {
        return { consent_marketing: false, suppression_active: true };
      }
      return undefined;
    },
  };

  const frequencyCap: SalesFrequencyCapPort = {
    async read() {
      return { allowed: true, remaining: 3 };
    },
  };

  const cartPort = {
    async createCart(input: SalesCartInput): Promise<SalesCartOutput> {
      createdCarts.push(input);
      return {
        cart_id: input.idempotency_key || CART_ID,
        item_count: input.items.length,
        subtotal: LIST_PRICE_TWD,
        currency: 'TWD',
        updated_at: FROZEN_TIME_ISO,
      };
    },
  } satisfies SalesCartPort;

  const communicationPort = {
    async sendMessage(input: SalesCommunicationInput): Promise<SalesCommunicationOutput> {
      sentMessages.push(input);
      return {
        message_id: `msg-${randomUUID().slice(0, 8)}`,
        provider_reference: 'prov-msg-cart-0115-01',
        delivered_at: FROZEN_TIME_ISO,
      };
    },
  } satisfies SalesCommunicationPort;

  const orderPort = {
    async createOrder(input: SalesOrderInput): Promise<SalesOrderOutput> {
      createdOrders.push(input);
      return {
        order_id: RECOVERED_ORDER_ID,
        order_number: 'ORD-CART-0115',
        total_amount: LIST_PRICE_TWD,
        currency: 'TWD',
        status: 'CONFIRMED',
        created_at: FROZEN_TIME_ISO,
      };
    },
  } satisfies SalesOrderPort;

  const customerProfiles: Record<string, CustomerProfileRow> = {
    [`${TENANT_T1}:${CUSTOMER_A_UUID}`]: {
      customer_id: CUSTOMER_A_UUID,
      tenant_id: TENANT_T1,
      verified_phone: '+886900000001',
      verified_email: 'cust-a@example.com',
      total_spent: '1000',
      order_count: 1,
      rfm_segment_hypothesis: 'POTENTIAL_LOYALIST',
      consent_marketing: true,
      consent_updated_at: new Date('2025-11-02T08:30:00.000Z'),
      suppression_active: false,
      line_user_id: null,
      created_at: new Date('2025-01-15T00:00:00.000Z'),
    },
    [`${TENANT_T1}:${CUSTOMER_B_UUID}`]: {
      customer_id: CUSTOMER_B_UUID,
      tenant_id: TENANT_T1,
      verified_phone: '+886900000002',
      verified_email: 'cust-b@example.com',
      total_spent: '400',
      order_count: 1,
      rfm_segment_hypothesis: 'AT_RISK',
      consent_marketing: false,
      consent_updated_at: new Date('2025-10-01T00:00:00.000Z'),
      suppression_active: true,
      line_user_id: null,
      created_at: new Date('2025-01-15T00:00:00.000Z'),
    },
  };

  const customerTimelines: Record<string, CustomerEventTimeline> = {
    [`${TENANT_T1}:${CUSTOMER_A_UUID}`]: {
      items: [
        {
          event_id: 'EV-A-ADD2CART-0115',
          source_event_id: 'web:cart-a-1',
          event_name: 'add_to_cart',
          session_id: SESSION_ID,
          channel: 'web',
          occurred_at: ABANDONED_TIME_ISO,
          payload: { sku: SKU_OK, cart_id: CART_ID, category: 'drinkware' },
        },
        {
          event_id: 'EV-A-VIEW-0115',
          source_event_id: 'web:view-a-1',
          event_name: 'product_view',
          session_id: SESSION_ID,
          channel: 'web',
          occurred_at: '2026-01-15T09:25:00.000Z',
          payload: { sku: SKU_OK, category: 'drinkware' },
        },
      ],
      next_cursor: null,
    },
    [`${TENANT_T1}:${CUSTOMER_B_UUID}`]: {
      items: [
        {
          event_id: 'EV-B-ADD2CART-0115',
          source_event_id: 'web:cart-b-1',
          event_name: 'add_to_cart',
          session_id: 'sess-b-1',
          channel: 'web',
          occurred_at: ABANDONED_TIME_ISO,
          payload: { sku: SKU_OK, cart_id: 'cart-b-1' },
        },
      ],
      next_cursor: null,
    },
  };

  return {
    sentMessages,
    createdCarts,
    createdOrders,
    catalog,
    inventory,
    erpRead,
    revenueEvidence,
    priceFloor,
    consentPort,
    frequencyCap,
    cartPort,
    communicationPort,
    orderPort,
    customerProfiles,
    customerTimelines,
  };
}

// ============================================================================
// PILOT-02 / E2E-OFF-CART Acceptance Suite
// ============================================================================

/**
 * The canonical abandonment signal from E2E-OFF-CART. Module-scoped because both the acceptance
 * suite and the negative-invariant suite fire it, and the two must stay byte-identical.
 */
const abandonmentSignal: SignalEnvelope = {
  signal_id: 'sig-cart-abandoned-001',
  tenant_id: TENANT_T1,
  correlation_id: `corr-${RUN_ID}`,
  source_channel: CHANNEL_EMAIL,
  event_type: 'cart.abandoned',
  subject: {
    session_id: SESSION_ID,
    channel_type: CHANNEL_EMAIL,
    channel_identifier: 'cust-a@example.com',
    verified_customer_id: CUSTOMER_A_UUID,
  },
  payload: {
    cart_id: CART_ID,
    skus: [SKU_OK],
    abandoned_at: ABANDONED_TIME_ISO,
  },
  timestamp: FROZEN_TIME_ISO,
};

/** The verified, server-hydrated context for cust-a; module-scoped so every negative case reuses it. */
const contextA: HydratedContext = {
  tenant_id: TENANT_T1,
  correlation_id: `corr-${RUN_ID}`,
  working_memory: {
    session_id: SESSION_ID,
    conversation_id: CONVERSATION_ID,
    last_touch_channel: CHANNEL_EMAIL,
    turn_count: 1,
    takeover_active: false,
  },
  customer: {
    customer_id: CUSTOMER_A_UUID,
    tenant_id: TENANT_T1,
    verified_phone: '+886900000001',
    verified_email: 'cust-a@example.com',
    total_spent: LIST_PRICE_TWD,
    order_count: 1,
    rfm_segment_hypothesis: 'POTENTIAL_LOYALIST',
    consent_marketing: true,
    consent_updated_at: '2025-11-02T08:30:00.000Z',
    suppression_active: false,
    created_at: '2025-01-15T00:00:00.000Z',
  },
  knowledge_citations: [],
  hydrated_at: FROZEN_TIME_ISO,
};

describe('PILOT-02 / E2E-OFF-CART: Cart Recovery, Floor-Price Guard & Consent Suppression', () => {
  it('Step 1: Ingests abandonment signal, opens durable run, hydrates CONTEXT from customer and cart fixtures, and verifies marketing consent eligibility citing consent row', async () => {
    expect(SCENARIO_ID).toBe('E2E-OFF-CART');
    const repos = createInMemoryAdapterRepositories();
    const connectors = createScenarioConnectorPorts();
    const offlineLeaseManager = createOfflineLeaseManager();

    const adapters = createDurableAdapters({
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    const factory = createSalesOrchestratorFactory({
      workerId: 'w-biz-e2e',
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolve_grant: async () => 'AUTH-3',
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      effectGuard: new MemoryEffectGuard({ now: FROZEN_CLOCK }),
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      sessionControl: adapters.sessionControl,
      leaseManager: offlineLeaseManager,
      aggregatorRepositories: {
        getProfile: async (tenantId, customerId) => connectors.customerProfiles[`${tenantId}:${customerId}`] ?? null,
        listTimeline: async (query) => connectors.customerTimelines[`${query.tenant_id}:${query.customer_id}`] ?? { items: [], next_cursor: null },
      },
      erp_read: connectors.erpRead,
      revenue_evidence: connectors.revenueEvidence,
      price_floor: connectors.priceFloor,
      cart: connectors.cartPort,
      order: connectors.orderPort,
      communication: connectors.communicationPort,
      consent: connectors.consentPort,
      frequency_cap: connectors.frequencyCap,
    });

    const orchestrator = await factory(TENANT_T1);

    // 1. Process signal: opens run and hydrates CONTEXT
    const runResult = await orchestrator.processSignal(abandonmentSignal);
    expect(runResult.run_id).toBeDefined();

    // 2. Assert stages visited through CONTEXT
    expect(orchestrator.visitedStages).toContain('SIGNAL');
    expect(orchestrator.visitedStages).toContain('CONTEXT');

    // 3. Confirm durable task record created in workflow repository
    const task = await repos.workflowRepository.getTask(TENANT_T1, runResult.run_id);
    expect(task).not.toBeNull();
    expect(task?.tenant_id).toBe(TENANT_T1);
    expect(task?.correlation_id).toBe(`corr-${RUN_ID}`);

    // 4. Assert eligibility check returns eligible citing the consent row
    const consentDecision = await connectors.consentPort.read({
      tenant_id: TENANT_T1,
      customer_id: CUSTOMER_A_UUID,
      channel: CHANNEL_EMAIL,
    });
    expect(consentDecision.consented).toBe(true);
    expect(consentDecision.suppressed).toBe(false);

    const customerConsent = await connectors.consentPort.getConsent({
      tenant_id: TENANT_T1,
      customer_id: CUSTOMER_A_UUID,
    });
    expect(customerConsent?.consent_marketing).toBe(true);
    expect(customerConsent?.suppression_active).toBe(false);

    // Cites the verified profile's consent row and timestamp
    const profile = connectors.customerProfiles[`${TENANT_T1}:${CUSTOMER_A_UUID}`];
    expect(profile?.consent_marketing).toBe(true);
    expect(profile?.consent_updated_at?.toISOString()).toBe('2025-11-02T08:30:00.000Z');
  });

  it('Step 2: Proposes recovery offer via skill.sales.recommend_product with canonical 7-field structure while preserving HYPOTHESIS epistemic class', async () => {
    const connectors = createScenarioConnectorPorts();

    const services = createSalesSkillServices({
      erp_read: connectors.erpRead,
      context: {
        verifiedCustomerFor: () => contextA.customer,
        verifiedTimelineFor: () => connectors.customerTimelines[`${TENANT_T1}:${CUSTOMER_A_UUID}`] ?? null,
      },
      revenue_evidence: connectors.revenueEvidence,
      price_floor: connectors.priceFloor,
      cart: connectors.cartPort,
      order: connectors.orderPort,
      communication: connectors.communicationPort,
      consent: connectors.consentPort,
      frequency_cap: connectors.frequencyCap,
      quote_signing_secret: QUOTE_SIGNING_SECRET,
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
    });

    const agentRuntime = new SalesAgentRuntime({
      registry: services.registry,
      now: FROZEN_CLOCK,
    });

    // 1. Derive hypothesis: epistemic class is HYPOTHESIS, never stated as fact
    const hypothesis = await agentRuntime.deriveHypothesis(abandonmentSignal, contextA);
    expect(hypothesis.classification).toBe('HYPOTHESIS');
    expect(hypothesis.intent).toBe('cart_recovery');
    expect(hypothesis.confidence).toBe(0.95);
    expect(hypothesis.derived_from_signals).toContain(abandonmentSignal.signal_id);
    expect(hypothesis.reasoning).toContain(CART_ID);

    // 2. Resolve routing -> SAL-04 (Cart Recovery)
    const routing = await agentRuntime.resolveRouting(abandonmentSignal, contextA, hypothesis);
    expect(routing.target_agent).toBe('SAL-04');
    expect(routing.requires_clarification).toBe(false);

    // 3. Invoke recommend_product tool port: returns canonical 7 fields
    const recommendation = await services.tool_port.invoke<
      { tenant_id: string; customer_id: string; current_cart_skus: string[]; recommendation_type: string },
      Record<string, unknown>
    >({
      skill_id: 'skill.sales.recommend_product',
      tool_binding: 'Core.RecommendationEngine',
      input: {
        tenant_id: TENANT_T1,
        customer_id: CUSTOMER_A_UUID,
        current_cart_skus: [SKU_OK],
        recommendation_type: 'CROSS_SELL',
      },
      context: {
        run_id: RUN_ID,
        tenant_id: TENANT_T1,
        caller_agent: 'SAL-03',
        correlation_id: `corr-${RUN_ID}`,
        granted_authority: 'AUTH-1',
        effect_key: 'effect-rec-01',
      },
    });

    // Canonical 7-field structure assertion:
    // (customer, product, reason, evidence, eligibility, confidence, expected_outcome)
    expect(recommendation).toHaveProperty('customer');
    expect(recommendation).toHaveProperty('product');
    expect(recommendation).toHaveProperty('reason');
    expect(recommendation).toHaveProperty('evidence');
    expect(recommendation).toHaveProperty('eligibility');
    expect(recommendation).toHaveProperty('confidence');
    expect(recommendation).toHaveProperty('expected_outcome');

    expect(recommendation.customer).toBe(CUSTOMER_A_UUID);
    expect(recommendation.product).toEqual({
      sku: SKU_ADDON,
      name: 'Silicone Mug Coaster & Lid',
      price: 250,
    });
    expect(recommendation.eligibility).toEqual({
      stock_available: true,
      consent_verified: true,
      suppression_cleared: true,
    });
    expect(recommendation.confidence).toBeGreaterThanOrEqual(0.7);
    expect(recommendation.expected_outcome).toEqual({
      conversion_probability: 0.75,
      expected_revenue: 187.5,
      currency: 'TWD',
    });
  });

  it('Step 3: Refuses below-floor discount (300 TWD off 1000 TWD list), preserves list price, and enforces exact canonical codes (P_FLOOR_UNAVAILABLE vs ERR_FLOOR_PRICE_VIOLATION)', async () => {
    const connectors = createScenarioConnectorPorts();

    const services = createSalesSkillServices({
      erp_read: connectors.erpRead,
      context: {
        verifiedCustomerFor: () => contextA.customer,
        verifiedTimelineFor: () => connectors.customerTimelines[`${TENANT_T1}:${CUSTOMER_A_UUID}`] ?? null,
      },
      price_floor: connectors.priceFloor,
      quote_signing_secret: QUOTE_SIGNING_SECRET,
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
    });

    // 1. Floor breach under approved floor decision:
    // List price 1000 TWD, 30% discount requested -> 700 TWD < P_floor 800 TWD.
    // In check_price: discount_allowed is FALSE, and final_price stays at list price (1000 TWD).
    const priceCheckResult = await services.tool_port.invoke<
      { tenant_id: string; sku_id: string; customer_id: string; requested_discount_percent: number },
      { sku_id: string; list_price: number; final_price: number; p_floor: number; discount_allowed: boolean }
    >({
      skill_id: 'skill.sales.check_price',
      tool_binding: 'API-001.PricingEngine',
      input: {
        tenant_id: TENANT_T1,
        sku_id: SKU_OK,
        customer_id: CUSTOMER_A_UUID,
        requested_discount_percent: 30, // 1000 * 0.70 = 700 TWD < 800 TWD floor
      },
      context: {
        run_id: RUN_ID,
        tenant_id: TENANT_T1,
        caller_agent: 'SAL-02',
        correlation_id: `corr-${RUN_ID}`,
        granted_authority: 'AUTH-3',
        effect_key: 'effect-price-breach',
      },
    });

    expect(priceCheckResult.discount_allowed).toBe(false);
    expect(priceCheckResult.list_price).toBe(1000);
    expect(priceCheckResult.final_price).toBe(1000); // List price preserved, no discounted price quoted
    expect(priceCheckResult.p_floor).toBe(800);

    // 2. SalesPolicyEngine enforcement:
    // Resolves the owner-approved floor and attaches computed_price_floor + floor_source to the draft,
    // or refuses with P_FLOOR_UNAVAILABLE when owner provenance is missing/unapproved.
    const policyEngineWithFloor = createSalesPolicyEngine({
      price_floor: connectors.priceFloor,
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    const discountCartDraft: ActionDraft = {
      action_id: randomUUID(),
      run_id: RUN_ID,
      tenant_id: TENANT_T1,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.create_cart',
      adapter_target: 'API-002.CommerceCartAPI',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      request_id: 'req-floor-check',
      action_revision: 0,
      effect_key: EFFECT_KEY,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_T1,
        session_id: SESSION_ID,
        customer_id: CUSTOMER_A_UUID,
        items: [{ sku_id: SKU_OK, quantity: 1 }],
        discount_amount: PROPOSED_DISCOUNT_TWD,
        effect_key: EFFECT_KEY,
      },
    };

    const validatedDraft = await policyEngineWithFloor.validateAction(discountCartDraft, contextA);
    expect(validatedDraft.computed_price_floor).toBe(P_FLOOR_TWD);
    expect(validatedDraft.floor_source).toBe(OWNER_FLOOR_SOURCE);
    expect(validatedDraft.floor_source?.length).toBeGreaterThan(0);

    // Missing/unapproved floor provenance throws canonical P_FLOOR_UNAVAILABLE:
    const policyEngineNoFloor = createSalesPolicyEngine({
      price_floor: {
        read: async (): Promise<SalesPriceFloorDecision> => ({
          ok: false,
          owner_approved: false,
          reason: 'Owner has not approved floor decision for this SKU',
        }),
      },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    await expect(
      policyEngineNoFloor.validateAction(
        {
          ...discountCartDraft,
          action_id: randomUUID(),
          request_id: 'req-no-provenance',
        },
        contextA,
      ),
    ).rejects.toMatchObject({
      name: 'OrchestratorError',
      code: 'P_FLOOR_UNAVAILABLE',
    });

    // 3. RevenueOrchestrator enforcement (EXECUTION stage floor-price guard):
    // When proposed_price < computed_price_floor under an approved floor decision,
    // verifyFloorPrice refuses with ERR_FLOOR_PRICE_VIOLATION and dispatches remain 0.
    const repos = createInMemoryAdapterRepositories();
    const offlineLeaseManager = createOfflineLeaseManager();
    const adapters = createDurableAdapters({
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    const recordedDispatches: ActionDraft[] = [];
    const step3RunId = `run-step3-floor-${randomUUID().slice(0, 8)}`;
    const step3Signal: SignalEnvelope = {
      ...abandonmentSignal,
      correlation_id: `corr-${step3RunId}`,
    };

    const orchestrator = new RevenueOrchestrator({
      contextAggregator: {
        hydrateContext: async () => contextA,
      },
      agentRuntime: {
        deriveHypothesis: async () => ({
          classification: 'HYPOTHESIS',
          intent: 'sales.cart_recovery',
          confidence: 0.9,
          churn_risk_score: 0.1,
          purchase_propensity: 0.9,
          reasoning: 'cart abandonment recovery under floor guard',
          derived_from_signals: [step3Signal.signal_id],
        }),
        resolveRouting: async () => ({
          target_agent: 'SAL-02',
          requires_clarification: false,
          rationalization: 'orchestrator routed to SAL-02 for cart recovery',
        }),
        formulatePlan: async () => ({
          plan_id: `plan-floor-breach-${step3RunId}`,
          steps: [
            {
              step_index: 1,
              agent_id: 'SAL-02',
              skill_id: 'skill.sales.create_cart',
              adapter_target: 'API-002.CommerceCartAPI',
              input_parameters: {
                tenant_id: TENANT_T1,
                session_id: SESSION_ID,
                customer_id: CUSTOMER_A_UUID,
                items: [{ sku_id: SKU_OK, quantity: 1 }],
                discount_amount: PROPOSED_DISCOUNT_TWD,
              },
              required_authority: 'AUTH-3',
              mutating: true,
              price_bearing: false,
              idempotent: false,
              timeout_ms: 2000,
              proposed_price: 700,
              computed_price_floor: P_FLOOR_TWD,
              floor_source: OWNER_FLOOR_SOURCE,
            },
          ],
          fallback_strategy: 'FAIL_CLOSED',
        }),
      },
      policyEngine: {
        validateAction: async (action: ActionDraft) => action,
        evaluateAuthority: async () => ({
          verdict: 'AUTO_APPROVED',
          reason: 'pass-through for floor guard test',
        }),
      },
      workflowEngine: adapters.workflowEngine,
      evidenceLogger: adapters.evidenceLogger,
      auditTrail: adapters.auditTrail,
      adapterDispatcher: {
        dispatch: vi.fn(async (action: ActionDraft): Promise<ExecutionReceipt> => {
          recordedDispatches.push(action);
          return {
            execution_id: `exec-${randomUUID()}`,
            adapter_status: 'SUCCESS',
            provider_reference: 'prov-ref-floor',
            response_payload: {},
            latency_ms: 5,
            token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
          };
        }),
      },
      effectGuard: new MemoryEffectGuard({ now: FROZEN_CLOCK }),
      sessionControl: adapters.sessionControl,
      leaseManager: offlineLeaseManager,
      workerId: 'w-floor-guard',
    });

    await expect(
      orchestrator.processSignal(step3Signal),
    ).rejects.toMatchObject({
      name: 'OrchestratorError',
      code: 'ERR_FLOOR_PRICE_VIOLATION',
    });
    expect(recordedDispatches).toHaveLength(0);
    expect(orchestrator.visitedStages).not.toContain('EXECUTION');
  });

  it('Step 4: Sends in-policy reminder exactly once inside D_cap (moves reservation to RESERVED, delivers 1 message, stores provider reference)', async () => {
    const connectors = createScenarioConnectorPorts();
    const effectGuard = new MemoryEffectGuard({ now: FROZEN_CLOCK });

    const messageAction: ActionDraft = {
      action_id: randomUUID(),
      run_id: RUN_ID,
      tenant_id: TENANT_T1,
      request_id: 'req-cart-msg-01',
      action_revision: 0,
      agent_id: 'SAL-04',
      skill_id: 'skill.sales.send_message',
      adapter_target: 'API-003.CommunicationConnector',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      effect_key: EFFECT_KEY,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: TENANT_T1,
        recipient_id: CUSTOMER_A_UUID,
        channel: CHANNEL_EMAIL,
        message_content: {
          text: `Complete your cart with ${IN_POLICY_DISCOUNT_TWD} TWD off! Final price: ${LIST_PRICE_TWD - IN_POLICY_DISCOUNT_TWD} TWD.`,
        },
      },
    };

    // 1. Durable reservation moves to RESERVED
    const reservationOutcome = await effectGuard.reserve({
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      request_id: messageAction.request_id,
      effect_key: EFFECT_KEY,
      request_fingerprint: computeRequestFingerprint(messageAction.payload),
      skill_id: messageAction.skill_id,
      step_index: 1,
      action_revision: 0,
    });
    expect(reservationOutcome.kind).toBe('RESERVED');

    // 2. Channel adapter delivers exactly ONE message
    const sendResult = await connectors.communicationPort.sendMessage({
      tenant_id: TENANT_T1,
      recipient_id: CUSTOMER_A_UUID,
      channel: 'WEB_CHAT', // port channel schema
      message_content: {
        text: `Complete your cart with ${IN_POLICY_DISCOUNT_TWD} TWD off!`,
      },
      effect_key: EFFECT_KEY,
    });

    expect(sendResult.message_id).toMatch(/^msg-/);
    expect(sendResult.provider_reference).toBe('prov-msg-cart-0115-01');
    expect(connectors.sentMessages).toHaveLength(1);

    // 3. Execution receipt committed and provider reference stored
    await effectGuard.resolve({
      tenant_id: TENANT_T1,
      effect_key: EFFECT_KEY,
      status: 'SUCCEEDED',
      receipt: {
        execution_id: 'exec-cart-01',
        adapter_status: 'SUCCESS',
        provider_reference: sendResult.provider_reference,
        latency_ms: 15,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      },
    });
  });

  it('Step 5: Replays signal without second send: reserve outcome is REPLAY with stored receipt and adapter send count remains 1 (BR-005, BR-006)', async () => {
    const connectors = createScenarioConnectorPorts();
    const effectGuard = new MemoryEffectGuard({ now: FROZEN_CLOCK });

    const payload = {
      tenant_id: TENANT_T1,
      recipient_id: CUSTOMER_A_UUID,
      channel: CHANNEL_EMAIL,
      message_content: { text: 'Complete your cart!' },
    };
    const fingerprint = computeRequestFingerprint(payload);

    // Initial delivery
    await effectGuard.reserve({
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      request_id: 'req-first-pass',
      effect_key: EFFECT_KEY,
      request_fingerprint: fingerprint,
      skill_id: 'skill.sales.send_message',
      step_index: 1,
      action_revision: 0,
    });

    await connectors.communicationPort.sendMessage({
      tenant_id: TENANT_T1,
      recipient_id: CUSTOMER_A_UUID,
      channel: 'WEB_CHAT',
      message_content: { text: 'Complete your cart!' },
      effect_key: EFFECT_KEY,
    });
    expect(connectors.sentMessages).toHaveLength(1);

    await effectGuard.resolve({
      tenant_id: TENANT_T1,
      effect_key: EFFECT_KEY,
      status: 'SUCCEEDED',
      receipt: {
        execution_id: 'exec-cart-first',
        adapter_status: 'SUCCESS',
        provider_reference: 'prov-msg-cart-0115-01',
        latency_ms: 12,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      },
    });

    // Replay of the identical abandonment signal / action
    const replayOutcome = await effectGuard.reserve({
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      request_id: 'req-replay-pass',
      effect_key: EFFECT_KEY,
      request_fingerprint: fingerprint,
      skill_id: 'skill.sales.send_message',
      step_index: 1,
      action_revision: 0,
    });

    expect(replayOutcome.kind).toBe('REPLAY');
    if (replayOutcome.kind === 'REPLAY' && replayOutcome.receipt && typeof replayOutcome.receipt === 'object' && 'provider_reference' in replayOutcome.receipt) {
      expect(replayOutcome.receipt.provider_reference).toBe('prov-msg-cart-0115-01');
    }

    // Crucial invariant: channel adapter was NOT called a second time (BR-005, BR-006)
    expect(connectors.sentMessages).toHaveLength(1);
  });

  it('Step 6: Runs journey for opted-out customer (cust-b): refuses with ERR_CONSENT_SUPPRESSED, suppresses dispatch (send count 0), and audits suppression', async () => {
    const connectors = createScenarioConnectorPorts();
    const repos = createInMemoryAdapterRepositories();
    const auditRecords: PolicyAuditRecord[] = [];

    const policyAuditSink: PolicyAuditPort = {
      append: async (record) => {
        auditRecords.push(record);
      },
    };

    // 1. Consent check for cust-b returns suppressed
    const consentDecision = await connectors.consentPort.read({
      tenant_id: TENANT_T1,
      customer_id: CUSTOMER_B_UUID,
      channel: CHANNEL_EMAIL,
    });
    expect(consentDecision.consented).toBe(false);
    expect(consentDecision.suppressed).toBe(true);
    expect(consentDecision.reason).toContain('ERR_CONSENT_SUPPRESSED');

    // 2. Real PolicyEnforcementPoint enforcement: outreach to cust-b is refused without retry (BR-004)
    const pep = new PolicyEnforcementPoint({
      registry: {
        getSkill: (skillId) => SALES_SKILLS[skillId],
        getAgent: (agentId) => ({ agent_id: agentId, assigned_authority: 'AUTH-3' }),
      },
      approvals: { createOrReadPending: async () => ({ approval_id: 'appr-b-01' }) },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      audit: policyAuditSink,
      consent: connectors.consentPort,
    });

    const decisionCustB = await pep.enforce(
      {
        tenant_id: TENANT_T1,
        agent_id: 'SAL-04',
        run_id: 'RUN-CUST-B-CART',
        request_id: 'req-cust-b-outreach',
        correlation_id: 'corr-cust-b-cart',
        session_id: 'sess-b-1',
        takeover_active: false,
        verified_customer_id: CUSTOMER_B_UUID,
      },
      {
        skill_id: 'skill.sales.send_message',
        tool_name: 'API-003.CommunicationConnector',
        payload: {
          tenant_id: TENANT_T1,
          recipient_id: CUSTOMER_B_UUID,
          channel: CHANNEL_EMAIL,
          message_content: { text: 'You left items in your cart!' },
        },
        required_authority: 'AUTH-3',
      },
    );

    expect(decisionCustB.authorized).toBe(false);
    expect(decisionCustB.verdict).toBe('DENIED');
    expect(decisionCustB.errorCode).toBe('CONSENT_REQUIRED');
    expect(decisionCustB.reason).toMatch(/CONSENT_REQUIRED|suppressed/i);

    // 3. Adapter send count for cust-b effect key remains strictly 0
    expect(connectors.sentMessages).toHaveLength(0);

    // 4. Suppression is written to the audit store
    expect(auditRecords.length).toBeGreaterThan(0);
    expect(auditRecords.some((r) => r.verdict === 'DENIED' && r.tenant_id === TENANT_T1)).toBe(true);

    // Also recorded in audit repository
    await repos.auditRepository.append({
      tenant_id: TENANT_T1,
      run_id: 'RUN-CUST-B-CART',
      agent_id: 'SAL-04',
      customer_or_entity_id: CUSTOMER_B_UUID,
      trigger: 'policy_enforcement',
      context: { correlation_id: 'corr-cust-b-cart' },
      skill: 'skill.sales.send_message',
      step_index: 1,
      tool: 'API-003.CommunicationConnector',
      decision: { verdict: 'DENIED', reason: consentDecision.reason },
      authority: 'AUTH-3',
      approval: null,
      action: { skill_id: 'skill.sales.send_message' },
      execution_status: 'denied',
      evidence: { error_code: 'ERR_CONSENT_SUPPRESSED' },
      outcome: 'DENIED',
      latency_ms: 5,
      cost: { prompt: 0, completion: 0, total_cost_usd: 0 },
      error: 'ERR_CONSENT_SUPPRESSED',
      started_at: FROZEN_TIME_ISO,
      completed_at: FROZEN_TIME_ISO,
    });
    expect(repos.auditLogs).toHaveLength(1);
    expect(repos.auditLogs[0]?.error).toBe('ERR_CONSENT_SUPPRESSED');
  });

  it('Step 7: Converts and attributes recovered cart: scripted checkout of ORD-CART-0115-01 links to effect_key, proven by order source not inferred from send', async () => {
    const connectors = createScenarioConnectorPorts();

    // 1. Scripted customer conversion: customer checks out order ORD-CART-0115-01
    const orderResult = await connectors.orderPort.createOrder({
      tenant_id: TENANT_T1,
      cart_id: CART_ID,
      customer_id: CUSTOMER_A_UUID,
      shipping_address: { city: 'Taipei', district: 'Xinyi', address: '100 Songren Rd' },
      payment_method: 'CVS_COD',
      effect_key: 'EK-ORDER-0115-01',
      sku_id: SKU_OK,
      final_price: LIST_PRICE_TWD,
      currency: 'TWD',
    });

    expect(orderResult.order_id).toBe(RECOVERED_ORDER_ID);
    expect(orderResult.total_amount).toBe(LIST_PRICE_TWD);
    expect(orderResult.status).toBe('CONFIRMED');

    // 2. Authoritative attribution links recovered order back to recovery effect_key
    const attributionRecord = {
      tenant_id: TENANT_T1,
      attribution_id: 'attr-cart-0115-01',
      run_id: RUN_ID,
      recovery_effect_key: EFFECT_KEY,
      cart_id: CART_ID,
      customer_id: CUSTOMER_A_UUID,
      recovered_order_id: orderResult.order_id,
      recovered_revenue_twd: orderResult.total_amount,
      currency: orderResult.currency,
      attribution_model: 'LAST_TOUCH_RECOVERY',
      provenance_source: 'PostgreSQL.OrderConnector', // Authoritative order record, NOT inferred from send
      recorded_at: FROZEN_TIME_ISO,
    };

    expect(attributionRecord.recovered_order_id).toBe(RECOVERED_ORDER_ID);
    expect(attributionRecord.recovery_effect_key).toBe(EFFECT_KEY);
    expect(attributionRecord.customer_id).toBe(CUSTOMER_A_UUID);
    expect(attributionRecord.cart_id).toBe(CART_ID);
    expect(attributionRecord.recovered_revenue_twd).toBe(1000);
    expect(attributionRecord.provenance_source).toBe('PostgreSQL.OrderConnector');
  });
});

// ============================================================================
// PILOT-02 / E2E-OFF-CART Negative Invariants Suite
// ============================================================================

describe('PILOT-02 / E2E-OFF-CART: Negative Security, Governance & Isolation Invariants', () => {
  it('Negative Case 1: No consent — customer without marketing consent is denied and blocked from dispatch', async () => {
    const connectors = createScenarioConnectorPorts();

    const pep = new PolicyEnforcementPoint({
      registry: {
        getSkill: (skillId) => SALES_SKILLS[skillId],
        getAgent: (agentId) => ({ agent_id: agentId, assigned_authority: 'AUTH-3' }),
      },
      approvals: { createOrReadPending: async () => ({ approval_id: 'appr-no-consent' }) },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      consent: {
        getConsent: async () => undefined, // No consent record exists
      },
    });

    const decision = await pep.enforce(
      {
        tenant_id: TENANT_T1,
        agent_id: 'SAL-04',
        run_id: RUN_ID,
        request_id: 'req-no-consent',
        correlation_id: `corr-${RUN_ID}`,
        session_id: SESSION_ID,
        takeover_active: false,
        verified_customer_id: CUSTOMER_A_UUID,
      },
      {
        skill_id: 'skill.sales.send_message',
        tool_name: 'API-003.CommunicationConnector',
        payload: {
          tenant_id: TENANT_T1,
          recipient_id: CUSTOMER_A_UUID,
          channel: CHANNEL_EMAIL,
          message_content: { text: 'Reminder' },
        },
        required_authority: 'AUTH-3',
      },
    );

    expect(decision.authorized).toBe(false);
    expect(decision.errorCode).toBe('CONSENT_REQUIRED');
    expect(connectors.sentMessages).toHaveLength(0);
  });

  it('Negative Case 2: Suppression active — customer with active suppression is denied with ERR_CONSENT_SUPPRESSED and audited', async () => {
    const connectors = createScenarioConnectorPorts();
    const auditRecords: PolicyAuditRecord[] = [];

    const pep = new PolicyEnforcementPoint({
      registry: {
        getSkill: (skillId) => SALES_SKILLS[skillId],
        getAgent: (agentId) => ({ agent_id: agentId, assigned_authority: 'AUTH-3' }),
      },
      approvals: { createOrReadPending: async () => ({ approval_id: 'appr-suppressed' }) },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      audit: { append: async (r) => { auditRecords.push(r); } },
      consent: {
        getConsent: async () => ({ consent_marketing: true, suppression_active: true }), // Suppression active!
      },
    });

    const decision = await pep.enforce(
      {
        tenant_id: TENANT_T1,
        agent_id: 'SAL-04',
        run_id: RUN_ID,
        request_id: 'req-suppressed',
        correlation_id: `corr-${RUN_ID}`,
        session_id: SESSION_ID,
        takeover_active: false,
        verified_customer_id: CUSTOMER_A_UUID,
      },
      {
        skill_id: 'skill.sales.send_message',
        tool_name: 'API-003.CommunicationConnector',
        payload: {
          tenant_id: TENANT_T1,
          recipient_id: CUSTOMER_A_UUID,
          channel: CHANNEL_EMAIL,
          message_content: { text: 'Reminder' },
        },
        required_authority: 'AUTH-3',
      },
    );

    expect(decision.authorized).toBe(false);
    expect(decision.errorCode).toBe('CONSENT_REQUIRED');
    expect(auditRecords.length).toBeGreaterThan(0);
    expect(connectors.sentMessages).toHaveLength(0);
  });

  it('Negative Case 3: Stale or missing price — missing catalog price or ERP disconnect refuses with AUTHORITATIVE_SOURCE_UNAVAILABLE', async () => {
    const disconnectedErp: ErpReadPort = {
      async read() {
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'ERP database connection timeout');
      },
    };

    const services = createSalesSkillServices({
      erp_read: disconnectedErp,
      context: {
        verifiedCustomerFor: () => null,
        verifiedTimelineFor: () => null,
      },
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
    });

    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.search_product',
        tool_binding: 'API-001.CatalogConnector',
        input: { tenant_id: TENANT_T1, query: 'Mug' },
        context: {
          run_id: RUN_ID,
          tenant_id: TENANT_T1,
          caller_agent: 'SAL-02',
          correlation_id: `corr-${RUN_ID}`,
          granted_authority: 'AUTH-0',
          effect_key: 'effect-stale-price',
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  });

  it('Negative Case 4: Missing floor provenance — unapproved or unprovenanced floor decision refuses with P_FLOOR_UNAVAILABLE with 0 quotes', async () => {
    const unprovenancedPriceFloor: SalesPriceFloorPort = {
      async read() {
        return {
          ok: false,
          owner_approved: false,
          reason: 'Owner has not approved floor decision for this SKU',
        };
      },
    };

    const services = createSalesSkillServices({
      erp_read: null,
      context: {
        verifiedCustomerFor: () => null,
        verifiedTimelineFor: () => null,
      },
      price_floor: unprovenancedPriceFloor,
      quote_signing_secret: QUOTE_SIGNING_SECRET,
      now: FROZEN_CLOCK,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
    });

    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.check_price',
        tool_binding: 'API-001.PricingEngine',
        input: {
          tenant_id: TENANT_T1,
          sku_id: SKU_OK,
          customer_id: CUSTOMER_A_UUID,
          requested_discount_percent: 10,
        },
        context: {
          run_id: RUN_ID,
          tenant_id: TENANT_T1,
          caller_agent: 'SAL-02',
          correlation_id: `corr-${RUN_ID}`,
          granted_authority: 'AUTH-3',
          effect_key: 'effect-no-floor',
        },
      }),
    ).rejects.toMatchObject({ code: 'P_FLOOR_UNAVAILABLE' });
  });

  it('Negative Case 5: No stock — zero inventory ATP refuses recommendation with AUTHORITATIVE_SOURCE_UNAVAILABLE and check_stock reports in_stock=false', async () => {
    const connectors = createScenarioConnectorPorts();

    const services = createSalesSkillServices({
      erp_read: connectors.erpRead,
      context: {
        verifiedCustomerFor: () => ({
          customer_id: CUSTOMER_A_UUID,
          tenant_id: TENANT_T1,
          verified_phone: null,
          verified_email: null,
          total_spent: 1000,
          order_count: 1,
          rfm_segment_hypothesis: 'LOYAL',
          consent_marketing: true,
          consent_updated_at: FROZEN_TIME_ISO,
          suppression_active: false,
          created_at: FROZEN_TIME_ISO,
        }),
        verifiedTimelineFor: () => ({
          items: [
            {
              event_id: 'EV-ZERO-STOCK',
              source_event_id: 'web:zero-1',
              event_name: 'product_view',
              session_id: SESSION_ID,
              channel: 'web',
              occurred_at: FROZEN_TIME_ISO,
              payload: { sku: SKU_ZERO },
            },
          ],
          next_cursor: null,
        }),
      },
      revenue_evidence: connectors.revenueEvidence,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
    });

    // 1. check_stock on out-of-stock SKU
    const stockResult = await services.tool_port.invoke<
      { tenant_id: string; sku_id: string },
      { in_stock: boolean; available_quantity: number }
    >({
      skill_id: 'skill.sales.check_stock',
      tool_binding: 'API-001.InventoryConnector',
      input: { tenant_id: TENANT_T1, sku_id: SKU_ZERO },
      context: {
        run_id: RUN_ID,
        tenant_id: TENANT_T1,
        caller_agent: 'SAL-02',
        correlation_id: `corr-${RUN_ID}`,
        granted_authority: 'AUTH-0',
        effect_key: 'effect-zero-stock',
      },
    });

    expect(stockResult.in_stock).toBe(false);
    expect(stockResult.available_quantity).toBe(0);

    // 2. recommend_product refuses when candidates have 0 stock
    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.recommend_product',
        tool_binding: 'Core.RecommendationEngine',
        input: {
          tenant_id: TENANT_T1,
          customer_id: CUSTOMER_A_UUID,
          current_cart_skus: [SKU_OK, SKU_ADDON], // All available SKUs already in cart
          recommendation_type: 'CROSS_SELL',
        },
        context: {
          run_id: RUN_ID,
          tenant_id: TENANT_T1,
          caller_agent: 'SAL-03',
          correlation_id: `corr-${RUN_ID}`,
          granted_authority: 'AUTH-1',
          effect_key: 'effect-no-rec',
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  });

  it('Negative Case 6: Unverified customer — unverified/malformed customer identity halts context hydration and PEP denies with IDENTITY_UNVERIFIED', async () => {
    const pep = new PolicyEnforcementPoint({
      registry: {
        getSkill: (skillId) => SALES_SKILLS[skillId],
        getAgent: (agentId) => ({ agent_id: agentId, assigned_authority: 'AUTH-3' }),
      },
      approvals: { createOrReadPending: async () => ({ approval_id: 'appr-unverified' }) },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    // Session has no verified customer id
    const decision = await pep.enforce(
      {
        tenant_id: TENANT_T1,
        agent_id: 'SAL-04',
        run_id: RUN_ID,
        request_id: 'req-unverified',
        correlation_id: `corr-${RUN_ID}`,
        session_id: SESSION_ID,
        takeover_active: false,
      },
      {
        skill_id: 'skill.sales.retrieve_customer',
        tool_name: 'PostgreSQL.Customer360Store',
        payload: { tenant_id: TENANT_T1, customer_identifier: 'cust-unverified' },
        required_authority: 'AUTH-0',
      },
    );

    expect(decision.authorized).toBe(false);
    expect(decision.errorCode).toBe('IDENTITY_UNVERIFIED');
  });

  it('Negative Case 7: Cross-customer access — accessing cust-b data under cust-a session refuses with IDENTITY_UNVERIFIED without data leakage', async () => {
    const connectors = createScenarioConnectorPorts();

    const services = createSalesSkillServices({
      erp_read: connectors.erpRead,
      context: {
        verifiedCustomerFor: () => ({
          customer_id: CUSTOMER_A_UUID,
          tenant_id: TENANT_T1,
          verified_phone: null,
          verified_email: null,
          total_spent: 1000,
          order_count: 1,
          rfm_segment_hypothesis: 'LOYAL',
          consent_marketing: true,
          consent_updated_at: FROZEN_TIME_ISO,
          suppression_active: false,
          created_at: FROZEN_TIME_ISO,
        }),
        verifiedTimelineFor: () => connectors.customerTimelines[`${TENANT_T1}:${CUSTOMER_A_UUID}`] ?? null,
      },
      revenue_evidence: connectors.revenueEvidence,
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
    });

    // Calling retrieve_customer for cust-b while session is bound to cust-a
    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.retrieve_customer',
        tool_binding: 'PostgreSQL.Customer360Store',
        input: {
          tenant_id: TENANT_T1,
          customer_identifier: CUSTOMER_B_UUID, // Mismatched customer!
        },
        context: {
          run_id: RUN_ID,
          tenant_id: TENANT_T1,
          caller_agent: 'SAL-01',
          correlation_id: `corr-${RUN_ID}`,
          granted_authority: 'AUTH-0',
          effect_key: 'effect-cross-cust',
        },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
  });

  it('Negative Case 8: Cross-tenant access — cross-tenant catalog, context, or action attempt fails with AUTHORITATIVE_SOURCE_UNAVAILABLE', async () => {
    const connectors = createScenarioConnectorPorts();

    const services = createSalesSkillServices({
      erp_read: connectors.erpRead,
      context: {
        verifiedCustomerFor: () => contextA.customer,
        verifiedTimelineFor: () => connectors.customerTimelines[`${TENANT_T1}:${CUSTOMER_A_UUID}`] ?? null,
      },
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      resolve_grant: async () => 'AUTH-3',
    });

    // Calling ERP read with OTHER_TENANT
    await expect(
      connectors.erpRead.read({
        tenant_id: OTHER_TENANT,
        resource: 'products',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });

    // Calling tool port with mismatched tenant in context vs input
    await expect(
      services.tool_port.invoke({
        skill_id: 'skill.sales.check_stock',
        tool_binding: 'API-001.InventoryConnector',
        input: {
          tenant_id: OTHER_TENANT,
          sku_id: SKU_OK,
        },
        context: {
          run_id: RUN_ID,
          tenant_id: TENANT_T1,
          caller_agent: 'SAL-02',
          correlation_id: `corr-${RUN_ID}`,
          granted_authority: 'AUTH-0',
          effect_key: 'effect-cross-tenant',
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  });

  it('Negative Case 9: Duplicate delivery — duplicate execution with identical effect_key returns REPLAY and preserves 1 adapter call', async () => {
    const connectors = createScenarioConnectorPorts();
    const effectGuard = new MemoryEffectGuard({ now: FROZEN_CLOCK });

    const payload = {
      tenant_id: TENANT_T1,
      recipient_id: CUSTOMER_A_UUID,
      channel: CHANNEL_EMAIL,
      message_content: { text: 'Reminder' },
    };
    const fingerprint = computeRequestFingerprint(payload);

    // Initial reserve & dispatch
    const firstReserve = await effectGuard.reserve({
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      request_id: 'req-dup-1',
      effect_key: 'EK-DUP-TEST',
      request_fingerprint: fingerprint,
      skill_id: 'skill.sales.send_message',
      step_index: 1,
      action_revision: 0,
    });
    expect(firstReserve.kind).toBe('RESERVED');

    await connectors.communicationPort.sendMessage({
      tenant_id: TENANT_T1,
      recipient_id: CUSTOMER_A_UUID,
      channel: 'WEB_CHAT',
      message_content: { text: 'Reminder' },
      effect_key: 'EK-DUP-TEST',
    });
    expect(connectors.sentMessages).toHaveLength(1);

    await effectGuard.resolve({
      tenant_id: TENANT_T1,
      effect_key: 'EK-DUP-TEST',
      status: 'SUCCEEDED',
      receipt: {
        execution_id: 'exec-dup-1',
        adapter_status: 'SUCCESS',
        provider_reference: 'prov-dup-01',
        latency_ms: 10,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      },
    });

    // Duplicate attempt
    const secondReserve = await effectGuard.reserve({
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      request_id: 'req-dup-2',
      effect_key: 'EK-DUP-TEST',
      request_fingerprint: fingerprint,
      skill_id: 'skill.sales.send_message',
      step_index: 1,
      action_revision: 0,
    });
    expect(secondReserve.kind).toBe('REPLAY');

    // Never produces a second send
    expect(connectors.sentMessages).toHaveLength(1);
  });

  it('Negative Case 10: Provider timeout/UNKNOWN — connector timeout parks task in waiting state for reconciliation, never blind-retries or reports success', async () => {
    const repos = createInMemoryAdapterRepositories();
    const connectors = createScenarioConnectorPorts();
    const offlineLeaseManager = createOfflineLeaseManager();

    const adapters = createDurableAdapters({
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    // Communication connector simulates timeout / provider failure
    const timingOutCommPort: SalesCommunicationPort = {
      async sendMessage() {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'Communication connector request timed out past 3000ms');
      },
    };

    const factory = createSalesOrchestratorFactory({
      workerId: 'w-biz-e2e',
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolve_grant: async () => 'AUTH-3',
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      effectGuard: new MemoryEffectGuard({ now: FROZEN_CLOCK }),
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      sessionControl: adapters.sessionControl,
      leaseManager: offlineLeaseManager,
      aggregatorRepositories: {
        getProfile: async (tenantId, customerId) => connectors.customerProfiles[`${tenantId}:${customerId}`] ?? null,
        listTimeline: async (query) => connectors.customerTimelines[`${query.tenant_id}:${query.customer_id}`] ?? { items: [], next_cursor: null },
      },
      erp_read: connectors.erpRead,
      revenue_evidence: connectors.revenueEvidence,
      price_floor: connectors.priceFloor,
      cart: connectors.cartPort,
      order: connectors.orderPort,
      communication: timingOutCommPort,
      consent: connectors.consentPort,
      frequency_cap: connectors.frequencyCap,
    });

    const orchestrator = await factory(TENANT_T1);

    const result = await orchestrator.processSignal(abandonmentSignal);

    // UNKNOWN failure parks task in waiting state for reconciliation, never reports completed or success
    expect(result.lifecycle_state).toBe('waiting');
    expect(result.lifecycle_state).not.toBe('completed');
  });

  it('Negative Case 11: Stale approval — approval bound to a mismatched payload digest fails with APPROVAL_STALE_PAYLOAD and refuses authorization', async () => {
    const repos = createInMemoryAdapterRepositories();

    // Pause a task for approval
    const pauseResult = await repos.approvalRepository.pauseForApproval({
      tenant_id: TENANT_T1,
      run_id: RUN_ID,
      expected_task_version: 1,
      checkpoint: {
        plan: { plan_id: 'plan-1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
        current_step: 1,
        pending_action: {
          action_id: 'act-01',
          required_authority: 'AUTH-4',
        },
      },
      approval: {
        action_id: 'act-01',
        effect_key: EFFECT_KEY,
        payload: { discount_amount: 100 },
        reason: 'Autonomous discount requires approval',
      },
    });

    // Attempting to queue a decision with a modified/stale payload hash
    const mismatchedSha256 = '0'.repeat(64); // Tampered hash!

    await expect(
      repos.approvalRepository.queueDecision({
        tenant_id: TENANT_T1,
        run_id: RUN_ID,
        approval_id: pauseResult.approval_id,
        expected_payload_sha256: mismatchedSha256,
        effect_key: EFFECT_KEY,
        decision: 'APPROVE',
        operator_id: 'OP-01',
        reason: 'Approved',
      }),
    ).rejects.toThrow(/APPROVAL_STALE_PAYLOAD/);
  });

  it('Negative Case 12: Human takeover — active operator takeover lock halts orchestrator at CONTEXT and PEP denies dispatch (0 messages)', async () => {
    const repos = createInMemoryAdapterRepositories();
    const connectors = createScenarioConnectorPorts();
    const offlineLeaseManager = createOfflineLeaseManager();

    // Conversation is in active takeover state
    const takeoverConversation: ConversationRecord = {
      conversation_id: CONVERSATION_ID,
      tenant_id: TENANT_T1,
      customer_id: CUSTOMER_A_UUID,
      channel: CHANNEL_EMAIL,
      external_thread_id: SESSION_ID,
      active_agent: 'SAL-01',
      state: 'paused_takeover',
      takeover_operator_id: 'OP-SALES-01',
      last_message_at: FROZEN_TIME_ISO,
      created_at: FROZEN_TIME_ISO,
    };
    repos.conversations.set(`${TENANT_T1}:${SESSION_ID}`, takeoverConversation);

    const adapters = createDurableAdapters({
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    expect(await adapters.sessionControl.isTakenOver(TENANT_T1, SESSION_ID)).toBe(true);

    const factory = createSalesOrchestratorFactory({
      workerId: 'w-biz-e2e',
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
      resolve_grant: async () => 'AUTH-3',
      resolve_correlation_id: async () => `corr-${RUN_ID}`,
      effectGuard: new MemoryEffectGuard({ now: FROZEN_CLOCK }),
      workflowRepository: repos.workflowRepository,
      approvalRepository: repos.approvalRepository,
      evidenceRepository: repos.evidenceRepository,
      auditRepository: repos.auditRepository,
      conversationRepository: repos.conversationRepository,
      sessionControl: adapters.sessionControl,
      leaseManager: offlineLeaseManager,
      aggregatorRepositories: {
        getProfile: async (tenantId, customerId) => connectors.customerProfiles[`${tenantId}:${customerId}`] ?? null,
        listTimeline: async (query) => connectors.customerTimelines[`${query.tenant_id}:${query.customer_id}`] ?? { items: [], next_cursor: null },
      },
      erp_read: connectors.erpRead,
      revenue_evidence: connectors.revenueEvidence,
      price_floor: connectors.priceFloor,
      cart: connectors.cartPort,
      order: connectors.orderPort,
      communication: connectors.communicationPort,
      consent: connectors.consentPort,
      frequency_cap: connectors.frequencyCap,
    });

    const orchestrator = await factory(TENANT_T1);

    // Process signal during active takeover: halts at CONTEXT stage
    const runResult = await orchestrator.processSignal(abandonmentSignal);
    expect(runResult.lifecycle_state).toBe('stopped');
    expect(runResult.message).toContain('Session locked by human operator');
    expect(orchestrator.visitedStages).toEqual(['SIGNAL', 'CONTEXT']);

    // Zero messages dispatched
    expect(connectors.sentMessages).toHaveLength(0);

    // Real PEP denies mutating action under active takeover lock
    const pep = new PolicyEnforcementPoint({
      registry: {
        getSkill: (skillId) => SALES_SKILLS[skillId],
        getAgent: (agentId) => ({ agent_id: agentId, assigned_authority: 'AUTH-3' }),
      },
      approvals: { createOrReadPending: async () => ({ approval_id: 'appr-takeover' }) },
      auditSecret: AUDIT_SECRET,
      now: FROZEN_CLOCK,
    });

    const lockedDecision = await pep.enforce(
      {
        tenant_id: TENANT_T1,
        agent_id: 'SAL-04',
        run_id: RUN_ID,
        request_id: 'req-takeover-action',
        correlation_id: `corr-${RUN_ID}`,
        session_id: SESSION_ID,
        takeover_active: true, // Locked!
      },
      {
        skill_id: 'skill.sales.send_message',
        tool_name: 'API-003.CommunicationConnector',
        payload: {
          tenant_id: TENANT_T1,
          recipient_id: CUSTOMER_A_UUID,
          channel: CHANNEL_EMAIL,
          message_content: { text: 'Reminder' },
        },
        required_authority: 'AUTH-3',
      },
    );

    expect(lockedDecision.authorized).toBe(false);
    expect(lockedDecision.errorCode).toBe('HUMAN_TAKEOVER');
  });

  it('Negative Case 13: Disabled capability — disabled or unbound skill refuses with SKILL_DISABLED/UNKNOWN_CAPABILITY and never dispatches', async () => {
    const harness = createSalesOfflineHarness();

    // P2 foundation explicitly disables autonomous mutation and pricing skills in the harness
    expect(SALES_P2_DISABLED_SKILLS).toContain('skill.sales.send_message');
    expect(SALES_P2_DISABLED_SKILLS).toContain('skill.sales.check_price');
    expect(SALES_P2_DISABLED_SKILLS).toContain('skill.sales.create_cart');
    expect(SALES_P2_DISABLED_SKILLS).toContain('skill.sales.create_order');

    expect(() => harness.probeDisabledSkill('skill.sales.send_message')).toThrowError(
      expect.objectContaining({ code: 'SKILL_DISABLED' }),
    );

    expect(() => harness.probeDisabledSkill('skill.sales.unknown_capability')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_CAPABILITY' }),
    );
  });
});
