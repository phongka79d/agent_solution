/**
 * @file Care Policy Engine Adapter (implement/04 §3.2, implement/08 §1.2, §7.1).
 *
 * Invariant:
 * The Care policy engine adapts the canonical PolicyEnforcementPoint (PEP).
 * 1. `validateAction` validates action drafts against registered skill schemas, rejecting
 *    any unknown fields (fail closed) and asserting server-bound tenant and customer identity.
 * 2. `evaluateAuthority` re-reads the assigned authority grant from `agentos.agents.assigned_authority`
 *    for the run's agent, enforces takeover supremacy and AUTH-5 terminal deny, and returns
 *    the canonical `ApprovalGateResult` verdict (`AUTO_APPROVED` | `AWAITING_HUMAN_APPROVAL` | `DENIED`).
 */

import { randomUUID } from 'node:crypto';
import type {
  ActionDraft,
  ApprovalGateResult,
  AssignableAuthority,
  HydratedContext,
  IPolicyEngine,
} from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import {
  PolicyEnforcementPoint,
  type ApprovalQueuePort,
  type PendingApprovalRequest,
  type PolicyActionProposal,
  type PolicyRegistryAgent,
  type PolicyRegistryPort,
  type PolicyRegistrySkill,
  type PolicySecurityContext,
} from '@agentos/core-engine';

/** Allowed fields in action payloads per skill, using static Record lookup */
const ALLOWED_PAYLOAD_FIELDS: Readonly<Record<string, Readonly<Record<string, true>>>> = Object.freeze({
  'skill.care.lookup_order': Object.freeze({
    order_id: true,
    order_identifier: true,
    customer_id: true,
    verification_reference: true,
    verification_status: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.search_faq': Object.freeze({
    query: true,
    query_text: true,
    category: true,
    top_k: true,
    limit: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.track_shipping': Object.freeze({
    tracking_number: true,
    carrier: true,
    order_identifier: true,
    order_id: true,
    customer_id: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.manage_case': Object.freeze({
    action: true,
    case_id: true,
    customer_id: true,
    priority: true,
    notes: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.initiate_return': Object.freeze({
    order_identifier: true,
    order_id: true,
    customer_id: true,
    items: true,
    reason: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.escalate_to_human': Object.freeze({
    reason: true,
    summary: true,
    urgency: true,
    session_id: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.analyze_churn_risk': Object.freeze({
    customer_id: true,
    signals: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.issue_retention_offer': Object.freeze({
    customer_id: true,
    offer_type: true,
    discount_rate: true,
    catalog_ref_id: true,
    proposed_price: true,
    tenant_id: true,
    effect_key: true,
  }),
});

/** Canonical skill definitions for Customer Care from packages/skills/src/platform/care/*.ts */
const CARE_SKILLS: Readonly<Record<string, PolicyRegistrySkill>> = Object.freeze({
  'skill.care.lookup_order': {
    skill_id: 'skill.care.lookup_order',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 2000,
  },
  'skill.care.search_faq': {
    skill_id: 'skill.care.search_faq',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 1500,
  },
  'skill.care.track_shipping': {
    skill_id: 'skill.care.track_shipping',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 2000,
  },
  'skill.care.manage_case': {
    skill_id: 'skill.care.manage_case',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 3000,
  },
  'skill.care.initiate_return': {
    skill_id: 'skill.care.initiate_return',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-4',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 3000,
  },
  'skill.care.escalate_to_human': {
    skill_id: 'skill.care.escalate_to_human',
    allowed_agents: Object.freeze(['CS-01', 'CS-02']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 2000,
  },
  'skill.care.analyze_churn_risk': {
    skill_id: 'skill.care.analyze_churn_risk',
    allowed_agents: Object.freeze(['CS-02']),
    required_authority: 'AUTH-1',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'HYPOTHESIS',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 2500,
  },
  'skill.care.issue_retention_offer': {
    skill_id: 'skill.care.issue_retention_offer',
    allowed_agents: Object.freeze(['CS-02']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: true,
    idempotent: false,
    epistemic_class: 'DECISION',
    write_target: 'FACT',
    requires_consent: true,
    requires_verified_identity: true,
    timeout_ms: 3000,
  },
});

export interface CarePolicyEngineOptions {
  readonly pep?: PolicyEnforcementPoint | undefined;
  readonly resolveGrant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  readonly approvals?: ApprovalQueuePort | undefined;
  readonly auditSecret?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export class CarePolicyEngine implements IPolicyEngine {
  private readonly pep: PolicyEnforcementPoint;
  private readonly resolveGrantFn: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
  private readonly agentGrantCache = new Map<string, AssignableAuthority>();

  constructor(options: CarePolicyEngineOptions = {}) {
    this.resolveGrantFn = options.resolveGrant ?? (async (_tenant_id, agent_id) => {
      // Default agent authority in Care domain for unconfigured test engines
      if (agent_id === 'CS-01') return 'AUTH-2';
      if (agent_id === 'CS-02') return 'AUTH-1';
      return null;
    });

    if (options.pep) {
      this.pep = options.pep;
    } else {
      const self = this;
      const registryPort: PolicyRegistryPort = {
        getSkill(skill_id: string): PolicyRegistrySkill | undefined {
          return CARE_SKILLS[skill_id];
        },
        getAgent(agent_id: string): PolicyRegistryAgent | undefined {
          const cached = self.agentGrantCache.get(agent_id);
          if (cached) {
            return {
              agent_id,
              assigned_authority: cached,
            };
          }
          return undefined;
        },
      };

      const defaultApprovals: ApprovalQueuePort = options.approvals ?? {
        async createOrReadPending(_req: PendingApprovalRequest): Promise<{ readonly approval_id: string }> {
          return { approval_id: `appr_${randomUUID().slice(0, 8)}` };
        },
      };

      this.pep = new PolicyEnforcementPoint({
        registry: registryPort,
        approvals: defaultApprovals,
        ...(options.auditSecret ? { auditSecret: options.auditSecret } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
  }

  async validateAction(action: ActionDraft, context: HydratedContext): Promise<ActionDraft> {
    const allowedFields = ALLOWED_PAYLOAD_FIELDS[action.skill_id];
    if (!allowedFields) {
      throw new OrchestratorError(
        'UNKNOWN_SKILL',
        `UNKNOWN_SKILL: skill '${action.skill_id}' is not registered in Customer Care schema.`,
      );
    }

    // Reject unknown payload fields
    const payload = action.payload ?? {};
    for (const key of Object.keys(payload)) {
      if (!Object.prototype.hasOwnProperty.call(allowedFields, key)) {
        throw new OrchestratorError(
          'POLICY_INPUT_INVALID',
          `POLICY_INPUT_INVALID: unknown field '${key}' in payload for skill '${action.skill_id}'.`,
        );
      }
    }

    // Tenant binding assertion
    if (action.tenant_id !== context.tenant_id) {
      throw new OrchestratorError(
        'CROSS_TENANT_ASSERTION',
        `CROSS_TENANT_ASSERTION: action tenant '${action.tenant_id}' does not match context tenant '${context.tenant_id}'.`,
      );
    }

    // Customer identity assertion
    if (action.skill_id === 'skill.care.lookup_order') {
      if (!context.customer) {
        throw new OrchestratorError(
          'IDENTITY_UNVERIFIED',
          'IDENTITY_UNVERIFIED: skill.care.lookup_order requires a server-verified customer binding.',
        );
      }
      const assertedCustomer = payload.customer_id;
      if (assertedCustomer && assertedCustomer !== context.customer.customer_id) {
        throw new OrchestratorError(
          'CROSS_CUSTOMER_ASSERTION',
          `CROSS_CUSTOMER_ASSERTION: payload customer '${String(assertedCustomer)}' does not match verified '${context.customer.customer_id}'.`,
        );
      }
    }

    return action;
  }

  async evaluateAuthority(action: ActionDraft, context: HydratedContext): Promise<ApprovalGateResult> {
    // 1. Terminal deny for AUTH-5
    if (action.required_authority === 'AUTH-5') {
      return {
        verdict: 'DENIED',
        reason: 'PROHIBITED_ACTION: action required authority is AUTH-5 which is strictly prohibited.',
      };
    }

    // 2. Takeover supremacy: active human takeover suppresses actions
    if (context.working_memory.takeover_active && action.mutating) {
      return {
        verdict: 'DENIED',
        reason: 'HUMAN_TAKEOVER: human operator holds active session lock; autonomous actions denied.',
      };
    }

    // 3. Re-read assigned authority grant for agent
    const freshGrant = await this.resolveGrantFn(context.tenant_id, action.agent_id);
    if (!freshGrant) {
      return {
        verdict: 'DENIED',
        reason: `UNKNOWN_AGENT: no authority grant resolved for agent '${action.agent_id}'.`,
      };
    }
    this.agentGrantCache.set(action.agent_id, freshGrant);

    // 4. Delegate to PolicyEnforcementPoint
    const secContext: PolicySecurityContext = {
      tenant_id: context.tenant_id,
      agent_id: action.agent_id,
      run_id: action.run_id,
      request_id: action.request_id,
      correlation_id: context.correlation_id,
      session_id: context.working_memory.session_id,
      takeover_active: context.working_memory.takeover_active,
      ...(context.customer?.customer_id ? { verified_customer_id: context.customer.customer_id } : {}),
    };

    const proposal: PolicyActionProposal = {
      skill_id: action.skill_id,
      tool_name: action.adapter_target,
      payload: action.payload,
      required_authority: action.required_authority,
      ...(action.action_revision > 0 ? { retry_attempt: action.action_revision } : {}),
    };

    const decision = await this.pep.enforce(secContext, proposal);

    if (decision.verdict === 'AUTO_APPROVED') {
      return {
        verdict: 'AUTO_APPROVED',
        reason: decision.reason,
        ...(decision.approvalTicketId ? { approval_id: decision.approvalTicketId } : {}),
      };
    }

    if (decision.verdict === 'AWAITING_HUMAN_APPROVAL') {
      return {
        verdict: 'AWAITING_HUMAN_APPROVAL',
        reason: decision.reason,
        ...(decision.approvalTicketId ? { approval_id: decision.approvalTicketId } : {}),
      };
    }

    return {
      verdict: 'DENIED',
      reason: decision.reason,
    };
  }
}
