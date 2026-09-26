/**
 * @file Generic Domain Policy Engine Adapter (implement/04 §3.2, implement/08 §1.2, §7.1).
 *
 * Invariant:
 * Adapts the canonical PolicyEnforcementPoint (PEP) without domain-specific data.
 * 1. `validateAction` validates action drafts against injected skill schemas, rejecting
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
  type ConsentSource,
  type PendingApprovalRequest,
  type PolicyActionProposal,
  type PolicyEnforcementOptions,
  type PolicyRegistryAgent,
  type PolicyRegistrySkill,
  type PolicyRegistryPort,
  type PolicySecurityContext,
} from '@agentos/core-engine';

export interface DomainPolicyEngineOptions {
  readonly skills: Readonly<Record<string, PolicyRegistrySkill>>;
  readonly allowed_payload_fields: Readonly<Record<string, Readonly<Record<string, true>>>>;
  readonly pep?: PolicyEnforcementPoint | undefined;
  readonly resolveGrant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  readonly defaultGrant?: ((agent_id: string) => AssignableAuthority | null) | undefined;
  readonly approvals?: ApprovalQueuePort | undefined;
  readonly consent?: ConsentSource | undefined;
  readonly auditSecret?: string | undefined;
  readonly audit?: PolicyEnforcementOptions['audit'] | undefined;
  readonly now?: (() => Date) | undefined;
}

export class DomainPolicyEngine implements IPolicyEngine {
  protected readonly skills: Readonly<Record<string, PolicyRegistrySkill>>;
  protected readonly allowedPayloadFields: Readonly<Record<string, Readonly<Record<string, true>>>>;
  protected readonly pep: PolicyEnforcementPoint;
  protected readonly resolveGrantFn: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
  protected readonly agentGrantCache = new Map<string, AssignableAuthority>();

  constructor(options: DomainPolicyEngineOptions) {
    this.skills = options.skills;
    this.allowedPayloadFields = options.allowed_payload_fields;

    const defaultGrant = options.defaultGrant;
    this.resolveGrantFn = options.resolveGrant ?? (async (_tenant_id, agent_id) => {
      if (defaultGrant) {
        return defaultGrant(agent_id);
      }
      return null;
    });

    if (options.pep) {
      this.pep = options.pep;
    } else {
      const self = this;
      const registryPort: PolicyRegistryPort = {
        getSkill(skill_id: string): PolicyRegistrySkill | undefined {
          return self.skills[skill_id];
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
        ...(options.consent ? { consent: options.consent } : {}),
        ...(options.audit ? { audit: options.audit } : {}),
        ...(options.auditSecret ? { auditSecret: options.auditSecret } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
  }

  async validateAction(action: ActionDraft, context: HydratedContext): Promise<ActionDraft> {
    const allowedFields = this.allowedPayloadFields[action.skill_id];
    if (!allowedFields) {
      throw new OrchestratorError(
        'UNKNOWN_SKILL',
        `UNKNOWN_SKILL: skill '${action.skill_id}' is not registered in schema.`,
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
    const assertedTenant = payload.tenant_id;
    if (assertedTenant && assertedTenant !== context.tenant_id) {
      throw new OrchestratorError(
        'CROSS_TENANT_ASSERTION',
        `CROSS_TENANT_ASSERTION: payload tenant '${String(assertedTenant)}' does not match context tenant '${context.tenant_id}'.`,
      );
    }

    // Customer identity assertion
    const skill = this.skills[action.skill_id];
    if (skill?.requires_verified_identity) {
      if (!context.customer) {
        throw new OrchestratorError(
          'IDENTITY_UNVERIFIED',
          `IDENTITY_UNVERIFIED: ${action.skill_id} requires a server-verified customer binding.`,
        );
      }
      const assertedCustomer = payload.customer_id;
      if (assertedCustomer && assertedCustomer !== context.customer.customer_id) {
        throw new OrchestratorError(
          'CROSS_CUSTOMER_ASSERTION',
          `CROSS_CUSTOMER_ASSERTION: payload customer '${String(assertedCustomer)}' does not match verified '${context.customer.customer_id}'.`,
        );
      }
    } else {
      const assertedCustomer = payload.customer_id;
      if (assertedCustomer) {
        if (!context.customer || assertedCustomer !== context.customer.customer_id) {
          throw new OrchestratorError(
            'CROSS_CUSTOMER_ASSERTION',
            `CROSS_CUSTOMER_ASSERTION: payload customer '${String(assertedCustomer)}' does not match verified '${context.customer?.customer_id ?? 'none'}'.`,
          );
        }
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
      takeover_active: Boolean(context.working_memory?.takeover_active),
      ...(context.customer?.customer_id ? { verified_customer_id: context.customer.customer_id } : {}),
    };

    const proposal: PolicyActionProposal = {
      skill_id: action.skill_id,
      tool_name: action.adapter_target,
      payload: action.payload,
      required_authority: action.required_authority,
      ...(action.action_revision > 0 ? { retry_attempt: action.action_revision } : {}),
      ...(action.approval_id === undefined ? {} : { approval_id: action.approval_id }),
    };

    const decision = await this.pep.enforce(secContext, proposal);

    if (decision.verdict === 'AUTO_APPROVED') {
      return {
        verdict: 'AUTO_APPROVED',
        reason: decision.reason,
        ...(action.approval_id === undefined ? {} : { approval_id: action.approval_id }),
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
