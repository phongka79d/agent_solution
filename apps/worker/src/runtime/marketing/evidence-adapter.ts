import {
  EvidenceRepository,
  type AppendEvidenceInput,
  type AuditRecordInput,
  type ImmutableEvidenceRecord,
} from '@agentos/database';
import {
  MarketingRuntimeError,
  type MarketingAuditPort,
  type MarketingAuditRecord,
  type MarketingEvidence,
  type MarketingEvidenceClass,
  type MarketingInvocationContext,
} from './contracts.js';

export type AppendCanonicalEvidence = (
  input: AppendEvidenceInput,
) => Promise<ImmutableEvidenceRecord>;

export interface MarketingEvidencePort {
  /** Persists one invocation bundle as one canonical evidence-chain row. */
  readonly append: (
    evidence: readonly MarketingEvidence[],
    context: MarketingInvocationContext,
    effectKey: string,
  ) => Promise<string>;
}

export interface MarketingEvidenceAdapterOptions {
  readonly append?: AppendCanonicalEvidence;
  readonly repository?: Pick<EvidenceRepository, 'appendEvidence'>;
  readonly secret?: string;
}

const KNOWN_MARKETING_CLASSES: Record<MarketingEvidenceClass, true> = Object.freeze({
  FACT: true,
  SIGNAL: true,
  HYPOTHESIS: true,
  APPROVED_KNOWLEDGE: true,
  DECISION: true,
  DRAFT: true,
} as const);

function assertKnownClass(classification: MarketingEvidenceClass): void {
  if (!KNOWN_MARKETING_CLASSES[classification]) {
    throw new MarketingRuntimeError(
      'EVIDENCE_CLASS_UNSUPPORTED',
      `Unknown Marketing evidence classification '${classification}'`,
    );
  }
}

function assertEvidenceBundle(
  evidence: readonly MarketingEvidence[],
  context: MarketingInvocationContext,
  effectKey: string,
): void {
  if (evidence.length === 0) {
    throw new MarketingRuntimeError(
      'EVIDENCE_INVALID',
      'A Marketing invocation must provide at least one evidence record',
    );
  }
  if (!Number.isInteger(context.step_index) || context.step_index < 1) {
    throw new MarketingRuntimeError(
      'EVIDENCE_CONTEXT_INVALID',
      'Marketing evidence persistence requires a positive integer server step_index',
    );
  }
  const evidenceIds = new Set<string>();
  for (const item of evidence) {
    if (
      item.evidence_id.trim().length === 0 ||
      item.source_uri.trim().length === 0 ||
      item.source_version.trim().length === 0 ||
      item.claim.trim().length === 0
    ) {
      throw new MarketingRuntimeError(
        'EVIDENCE_INVALID',
        'Marketing evidence requires non-empty evidence_id, source, version, and claim',
      );
    }
    if (evidenceIds.has(item.evidence_id)) {
      throw new MarketingRuntimeError(
        'EVIDENCE_DUPLICATE_ID',
        `Marketing evidence bundle contains duplicate evidence_id '${item.evidence_id}'`,
      );
    }
    evidenceIds.add(item.evidence_id);
    if (
      item.tenant_id !== context.tenant_id ||
      item.run_id !== context.run_id ||
      item.correlation_id !== context.correlation_id ||
      item.effect_key !== effectKey
    ) {
      throw new MarketingRuntimeError(
        'EVIDENCE_CONTEXT_MISMATCH',
        'Every Marketing evidence record must match the server-resolved invocation identity',
      );
    }
    assertKnownClass(item.classification);
  }
}

/**
 * Creates the append-only canonical evidence boundary. Marketing epistemic classes are preserved
 * verbatim inside the hashed bundle payload; none is promoted, downgraded, or renamed.
 */
export function createMarketingEvidencePort(
  options: MarketingEvidenceAdapterOptions = {},
): MarketingEvidencePort {
  const repository = options.repository ?? new EvidenceRepository();
  const append = options.append ?? ((input: AppendEvidenceInput) => repository.appendEvidence(input));

  return {
    async append(evidence, context, effectKey): Promise<string> {
      assertEvidenceBundle(evidence, context, effectKey);
      const payload: Record<string, unknown> = {
        type: 'marketing.evidence_bundle',
        evidence: evidence.map((item) => ({ ...item })),
      };
      const input: AppendEvidenceInput = {
        tenant_id: context.tenant_id,
        run_id: context.run_id,
        correlation_id: context.correlation_id,
        step_index: context.step_index,
        effect_key: effectKey,
        payload,
        ...(options.secret !== undefined ? { secret: options.secret } : {}),
      };
      const persisted = await append(input);
      return persisted.evidence_id;
    },
  };
}

export type AppendCanonicalAudit = (record: AuditRecordInput) => Promise<void>;
export type MapMarketingAudit = (record: MarketingAuditRecord) => AuditRecordInput;

export interface MarketingAuditAdapterOptions {
  /** Explicit canonical mapper supplied by the composition root; no fields are invented here. */
  readonly map: MapMarketingAudit;
  /** Canonical append function, normally bound to AuditRepository.append. */
  readonly append: AppendCanonicalAudit;
}

/**
 * Bridges Marketing audit records only when the composition root supplies a complete canonical
 * mapping. This adapter deliberately has no default mapper or repository fallback because the
 * Marketing-local record does not contain every canonical audit column.
 */
export function createMarketingAuditPort(
  options: MarketingAuditAdapterOptions,
): MarketingAuditPort {
  if (typeof options?.map !== 'function' || typeof options.append !== 'function') {
    throw new MarketingRuntimeError(
      'AUDIT_MAPPING_REQUIRED',
      'Marketing audit persistence requires an explicit canonical mapper and append function',
    );
  }
  return {
    async append(record): Promise<void> {
      const canonical = options.map(record);
      if (
        canonical.tenant_id !== record.tenant_id ||
        canonical.run_id !== record.run_id ||
        canonical.skill !== record.skill_id
      ) {
        throw new MarketingRuntimeError(
          'AUDIT_CONTEXT_MISMATCH',
          'Canonical Marketing audit mapping changed tenant, run, or skill identity',
        );
      }
      await options.append(canonical);
    },
  };
}
