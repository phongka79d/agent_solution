/**
 * @file Deterministic harness for the skill-runtime suites. Excluded from the package build.
 *
 * The authority and effect-identity seams are supplied independently so tests assert the dispatch
 * contract. Canonical JSON is shared with durable writers: a test double must never derive a
 * different digest for the same payload.
 */

import { createHash } from 'node:crypto';

import type { AssignableAuthority } from '@agentos/core-engine/contracts';

import { canonicalizeJson } from '@agentos/core-engine/canonical-json';

import {
  ORCHESTRATOR_BROKER,
  type EffectKeyIdentity,
  type ISkillContract,
  type PlatformSkillDependencies,
  type SkillAuthorityDecision,
  type SkillDispatchRequest,
  type SkillToolInvocation,
} from '../contracts/index.js';
import { createSkillRegistry, type SkillRegistry } from '../registry.js';
import {
  createSkillRuntimeEngine,
  type SkillRuntimeEngine,
  type SkillRuntimeOptions,
} from '../runtime/index.js';
import { fixtureRow } from './rows.js';

/** The four assignable clearances, ranked. AUTH-4/AUTH-5 are deliberately absent (SRS §12). */
const ASSIGNABLE_RANK: Readonly<Record<string, number>> = Object.freeze({
  'AUTH-0': 0,
  'AUTH-1': 1,
  'AUTH-2': 2,
  'AUTH-3': 3,
});

/** Lower-case hex SHA-256, the shape every durable digest and effect key is stored in. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Independent BR-005 derivation: only the five immutable identity fields take part. */
export function testEffectKey(identity: EffectKeyIdentity): string {
  return sha256Hex(canonicalizeJson(identity));
}

/** Payload digest using the shared RFC 8785 canonical bytes and SHA-256. */
export function testDigest(payload: unknown): string {
  return sha256Hex(canonicalizeJson(payload));
}

/** Independent canonical gate: branch order and refusal codes mirror implement/04 §3.2.1. */
export function testAuthorityVerdict(granted: unknown, required: unknown): SkillAuthorityDecision {
  const grantedRank = typeof granted === 'string' ? ASSIGNABLE_RANK[granted] : undefined;
  const absent = granted === undefined || granted === null || granted === '';

  if (grantedRank === undefined) {
    return {
      verdict: 'DENIED',
      granted: null,
      required: null,
      errorCode: absent ? 'CLEARANCE_REQUIRED' : 'INVALID_CLEARANCE',
      reason: 'the grant is not an assignable clearance',
      rankCompared: false,
    };
  }
  if (required === 'AUTH-5') {
    return {
      verdict: 'DENIED',
      granted: granted as AssignableAuthority,
      required: 'AUTH-5',
      errorCode: 'PROHIBITED_ACTION',
      reason: 'AUTH-5 is a terminal hard deny',
      rankCompared: false,
    };
  }
  if (required === 'AUTH-4') {
    return {
      verdict: 'AWAITING_HUMAN_APPROVAL',
      granted: granted as AssignableAuthority,
      required: 'AUTH-4',
      errorCode: null,
      reason: 'AUTH-4 is an approval route',
      rankCompared: false,
    };
  }
  const requiredRank = typeof required === 'string' ? ASSIGNABLE_RANK[required] : undefined;
  if (requiredRank === undefined) {
    return {
      verdict: 'DENIED',
      granted: granted as AssignableAuthority,
      required: null,
      errorCode: 'INVALID_AUTHORITY_REQUIREMENT',
      reason: 'the requirement is outside the vocabulary',
      rankCompared: false,
    };
  }
  if (grantedRank < requiredRank) {
    return {
      verdict: 'DENIED',
      granted: granted as AssignableAuthority,
      required: required as 'AUTH-0',
      errorCode: 'INSUFFICIENT_AUTHORITY',
      reason: 'the grant does not cover the requirement',
      rankCompared: true,
    };
  }
  return {
    verdict: 'AUTO_APPROVED',
    granted: granted as AssignableAuthority,
    required: required as 'AUTH-0',
    errorCode: null,
    reason: 'the grant covers the requirement',
    rankCompared: true,
  };
}

/** Everything a runtime suite needs to observe one engine. */
export interface SkillHarness {
  readonly engine: SkillRuntimeEngine;
  readonly registry: SkillRegistry;
  readonly dependencies: PlatformSkillDependencies;
  /** Every invocation that reached the adapter seam, in order. */
  readonly invocations: SkillToolInvocation[];
  /** Every identity handed to the effect-key seam, in order. */
  readonly effectKeyIdentities: EffectKeyIdentity[];
}

/**
 * Builds an engine over one fixture row with fully injected seams.
 *
 * @param options Row and engine overrides, plus the adapter response.
 * @returns The engine and the observations its seams recorded.
 */
export function createHarness(
  options: {
    readonly row?: Partial<ISkillContract>;
    readonly engine?: Partial<SkillRuntimeOptions>;
    readonly respond?: (invocation: SkillToolInvocation) => Promise<unknown>;
  } = {},
): SkillHarness {
  const registry = createSkillRegistry();
  const invocations: SkillToolInvocation[] = [];
  const effectKeyIdentities: EffectKeyIdentity[] = [];

  const dependencies: PlatformSkillDependencies = {
    tools: {
      async invoke<TInput, TOutput>(invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
        invocations.push(invocation as SkillToolInvocation);
        const respond = options.respond ?? (async () => ({ sku_id: 'SKU-1' }));
        return (await respond(invocation as SkillToolInvocation)) as TOutput;
      },
    },
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
  };

  registry.register(fixtureRow(options.row, dependencies.tools));

  let tick = 0;
  const engine = createSkillRuntimeEngine({
    registry,
    deriveEffectKey: (identity) => {
      effectKeyIdentities.push(identity);
      return testEffectKey(identity);
    },
    evaluateAuthority: testAuthorityVerdict,
    approvalDigest: ({ payload }) => testDigest(payload),
    now: () => {
      tick += 5;
      return tick;
    },
    random: () => 0,
    sleep: async () => undefined,
    ...options.engine,
  });

  return { engine, registry, dependencies, invocations, effectKeyIdentities };
}

/** A dispatch envelope for the fixture row, with every server-resolved field present. */
export function dispatchRequest(
  overrides: Partial<SkillDispatchRequest> = {},
): SkillDispatchRequest {
  return {
    broker: ORCHESTRATOR_BROKER,
    skill_id: 'skill.test.fixture',
    run_id: 'run-1',
    tenant_id: 'tenant-1',
    correlation_id: 'corr-1',
    caller_agent: 'CS-01',
    granted_authority: 'AUTH-1',
    request_id: 'req-1',
    step_index: 0,
    action_revision: 1,
    input: { tenant_id: 'tenant-1', sku_id: 'SKU-1' },
    ...overrides,
  };
}
