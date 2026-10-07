/**
 * Internal chain primitives and verification for the append-only evidence/audit repositories.
 *
 * The façade in `audit-evidence.ts` keeps the public repository path and re-exports the symbols
 * consumed by package callers. This module owns the byte-level chain contract and reports.
 */

import { createHash, createHmac } from 'node:crypto';

import { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js';
import type { AuditRecord, AuditRecordInput, ImmutableEvidenceRecord } from './audit-evidence.js';

export const AUDIT_HMAC_SECRET_ENV = 'AUDIT_HMAC_SECRET';
export const GENESIS_HASH = '0'.repeat(64);

const SHA256_HEX = /^[0-9a-f]{64}$/;
export const AUDIT_TIMESTAMP_UTC_ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const EVIDENCE_RECORDS = 'agentos.evidence_records';
const AUDIT_RECORDS = 'agentos.audit_records';

/* ------------------------------------------------------------------------------------------------
 * Chain primitives (implement/04 §6.1 step 2-3, implement/08 §4.2)
 * ---------------------------------------------------------------------------------------------- */

/** Digests a UTF-8 string with SHA-256: the byte contract of both chain formulas. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Resolves the audit signing secret and fails closed when it is absent (§04 §6.1 step 3, §08 §4.2).
 *
 * Local for the same leaf-package reason as the chain formulas, with the same name and semantics as
 * `durability/evidence.ts` so a composition root can inject one secret into both.
 *
 * @param secret Explicit secret; when omitted the process environment is read.
 * @returns The secret to sign with.
 * @throws Error `AUDIT_SECRET_MISSING` when no secret is configured. The value itself is never
 *   echoed into the message.
 */
export function requireAuditHmacSecret(secret?: string): string {
  const resolved = secret ?? process.env[AUDIT_HMAC_SECRET_ENV];

  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new Error(
      'AUDIT_SECRET_MISSING: AUDIT_HMAC_SECRET is required to sign evidence records and to verify ' +
        'the chains that carry them; an unsigned chain is not an audit chain (NFR-002).',
    );
  }

  return resolved;
}

/**
 * Validates one digest column before it is written or hashed.
 *
 * @param value Candidate digest.
 * @param column Column the digest belongs to, for the refusal message.
 * @param code Error code to raise.
 * @returns The validated digest.
 * @throws Error `<code>` when the value is not a bare lowercase 64-character hex SHA-256.
 */
export function assertSha256Digest(value: unknown, column: string, code: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new Error(
      `${code}: ${column} must be a bare lowercase 64-character hex SHA-256 digest (no prefix, no ` +
        'uppercase); a digest in any other spelling cannot be compared with a recomputed one ' +
        '(implement/04 §6.1, implement/08 §4.2).',
    );
  }

  return value;
}

/**
 * Extends the per-run evidence chain (§04 §6.1 step 2).
 *
 * @param params.previous_evidence_hash Predecessor's `chain_hash`; {@link GENESIS_HASH} for the
 *   first record of a run.
 * @param params.payload_sha256 Digest of the canonical payload.
 * @param params.effect_key Deterministic key of the step that produced the record.
 * @param params.step_index Step ordinal inside the run.
 * @returns `chain_hash` as 64 lower-case hexadecimal characters.
 * @throws Error `EVIDENCE_INPUT_INVALID` for a malformed digest, a blank `effect_key` or an ordinal
 *   that is not a non-negative integer.
 */
export function evidenceChainHash(params: {
  previous_evidence_hash: string;
  payload_sha256: string;
  effect_key: string;
  step_index: number;
}): string {
  assertSha256Digest(params.previous_evidence_hash, 'previous_evidence_hash', 'EVIDENCE_INPUT_INVALID');
  assertSha256Digest(params.payload_sha256, 'payload_sha256', 'EVIDENCE_INPUT_INVALID');

  if (typeof params.effect_key !== 'string' || params.effect_key.trim().length === 0) {
    throw new Error(
      'EVIDENCE_INPUT_INVALID: evidence cannot be chained without the effect_key that binds the ' +
        'record to one action (BR-010).',
    );
  }

  if (!Number.isInteger(params.step_index) || params.step_index < 0) {
    throw new Error(
      `EVIDENCE_INPUT_INVALID: step_index must be a non-negative integer; received ` +
        `${String(params.step_index)}.`,
    );
  }

  return sha256Hex(
    `${params.previous_evidence_hash}|${params.payload_sha256}|${params.effect_key}|${params.step_index}`,
  );
}

/**
 * Signs an evidence chain hash with HMAC-SHA256 (§04 §6.1 step 3, non-repudiation).
 *
 * @param chain_hash The `chain_hash` to sign.
 * @param secret Explicit secret; when omitted the process environment is read.
 * @returns The `signature` column value: 64 lower-case hexadecimal characters.
 * @throws Error `EVIDENCE_INPUT_INVALID` for a malformed `chain_hash`, or `AUDIT_SECRET_MISSING`
 *   when no signing secret is configured.
 */
export function signEvidenceChainHash(chain_hash: string, secret?: string): string {
  assertSha256Digest(chain_hash, 'chain_hash', 'EVIDENCE_INPUT_INVALID');

  return createHmac('sha256', requireAuditHmacSecret(secret)).update(chain_hash, 'utf8').digest('hex');
}

/**
 * Projects an audit record onto the hashed payload (§08 §4.2): the 18 mapped fields and nothing
 * else.
 *
 * `step_index` and the operational `started_at` / `completed_at` renderings are deliberately absent
 * — `audit_records` stores no `step_index`, and the event time enters the hash through the
 * `timestamp` argument. An absent nullable field is normalized to `null` here so the hashed value is
 * exactly the value the row stores, which is what lets a verifier reproduce the digest from a read
 * row.
 *
 * @param record The canonical run record about to be appended.
 * @returns The exact value to pass as `payload` to {@link auditChainHash}.
 */
export function buildAuditPayload(record: AuditRecordInput): Record<string, unknown> {
  return {
    run_id: record.run_id,
    tenant_id: record.tenant_id,
    agent_id: record.agent_id,
    customer_or_entity_id: record.customer_or_entity_id,
    trigger: record.trigger,
    context: record.context,
    skill: record.skill,
    tool: record.tool,
    decision: record.decision,
    authority: record.authority,
    approval: record.approval ?? null,
    action: record.action,
    execution_status: record.execution_status,
    evidence: record.evidence,
    outcome: record.outcome ?? null,
    latency_ms: record.latency_ms,
    cost: record.cost,
    error: record.error ?? null,
  };
}

/**
 * Extends the per-tenant audit chain (§08 §4.2) over the UTF-8 byte contract
 * `prev_hash + "|" + CanonicalJSON(payload) + "|" + timestamp`.
 *
 * @param params.prev_hash Tenant predecessor hash; {@link GENESIS_HASH} for the tenant's first
 *   record.
 * @param params.payload Sanitized payload; use {@link buildAuditPayload}.
 * @param params.timestamp Audit event time as the writer stores it: UTC ISO-8601 with milliseconds.
 * @returns `chain_hash` as 64 lower-case hexadecimal characters.
 * @throws Error `AUDIT_INPUT_INVALID` for a malformed predecessor hash or timestamp, or
 *   `CANONICAL_JSON_INVALID` when the payload is not canonicalizable.
 */
export function auditChainHash(params: {
  prev_hash: string;
  payload: Record<string, unknown>;
  timestamp: string;
}): string {
  assertSha256Digest(params.prev_hash, 'prev_hash', 'AUDIT_INPUT_INVALID');

  if (typeof params.timestamp !== 'string' || !AUDIT_TIMESTAMP_UTC_ISO_MS.test(params.timestamp)) {
    throw new Error(
      'AUDIT_INPUT_INVALID: timestamp must be UTC ISO-8601 with milliseconds ' +
        '(YYYY-MM-DDTHH:MM:SS.sssZ) so writer and verifier hash identical bytes; received ' +
        `${String(params.timestamp)}.`,
    );
  }

  return sha256Hex(`${params.prev_hash}|${canonicalizeJson(params.payload)}|${params.timestamp}`);
}
/* ------------------------------------------------------------------------------------------------
 * Chain verification (implement/04 §6.1, implement/08 §4.2, TC-ORC-007)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every way a stored chain can fail verification. Each one is a defect a reader can prove from the
 * rows alone, never a hypothesis about the writer's intent:
 *
 *  * `GENESIS_MISSING` / `GENESIS_FORK` — the scope has no record linked to {@link GENESIS_HASH}, or
 *    more than one, so the chain has no single origin.
 *  * `CHAIN_FORK` — two records claim the same predecessor, which is what the writer's per-scope
 *    serialization exists to prevent.
 *  * `MISSING_PREDECESSOR` — a record links to a hash no stored row carries: the linked ancestor is
 *    gone, which is the proof that an interior row was deleted or never written.
 *  * `CHAIN_HASH_DUPLICATE` — two rows share a `chain_hash`, which the `UNIQUE (tenant_id, chain_hash)`
 *    constraint forbids: the rows did not come from the writer.
 *  * `DIGEST_INVALID` — a digest column does not hold a lowercase SHA-256, so nothing can be
 *    recomputed from it.
 *  * `PAYLOAD_DIGEST_MISMATCH` — `payload_sha256` is not the digest of the stored `raw_payload`:
 *    the payload was edited.
 *  * `CHAIN_HASH_MISMATCH` — the stored `chain_hash` is not what the row's own fields reproduce, so
 *    a linked field was edited without re-hashing (or the row was written by hand).
 *  * `SIGNATURE_INVALID` — the HMAC over the stored `chain_hash` does not verify with the configured
 *    secret, which is what a recomputed forgery cannot reproduce.
 *  * `STEP_ORDER_INVALID` — the run's `step_index` decreases along the chain, so the links and the
 *    step order disagree.
 *  * `TIMESTAMP_INVALID` — an audit `timestamp` cannot be rendered as the byte contract the hash was
 *    computed over, so the record cannot be verified at all.
 */
export type ChainBreakKind =
  | 'GENESIS_MISSING'
  | 'GENESIS_FORK'
  | 'CHAIN_FORK'
  | 'MISSING_PREDECESSOR'
  | 'CHAIN_HASH_DUPLICATE'
  | 'DIGEST_INVALID'
  | 'PAYLOAD_DIGEST_MISMATCH'
  | 'CHAIN_HASH_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'STEP_ORDER_INVALID'
  | 'TIMESTAMP_INVALID';

/** One defect found while verifying a chain. */
export interface ChainBreak {
  readonly kind: ChainBreakKind;
  /** `evidence_id` of the offending record, or `null` when the break concerns the chain as a whole. */
  readonly record: string | null;
  /**
   * 0-based index of the record in the order it was read back (ascending `step_index` for evidence,
   * ascending `chain_seq` for audit), or `-1` for a break that belongs to no single record.
   */
  readonly row: number;
  readonly detail: string;
}

/** Outcome of verifying one chain: the records read, the ones proven, and every defect found. */
export interface ChainReport {
  readonly valid: boolean;
  /** Records read back from the store. */
  readonly records: number;
  /** Records reached from the genesis link whose every digest reproduced. */
  readonly verified: number;
  /** `chain_hash` of the last reachable record; `null` when nothing is reachable. */
  readonly head_hash: string | null;
  readonly breaks: readonly ChainBreak[];
}

/** Verification of one run's evidence chain. */
export interface EvidenceChainReport extends ChainReport {
  readonly tenant_id: string;
  readonly run_id: string;
}

/** Verification of one tenant's audit chain. */
export interface AuditChainReport extends ChainReport {
  readonly tenant_id: string;
}

/** One record's place in its scope's chain, as the walk needs it. */
interface ChainLink {
  readonly record: string;
  readonly prev_hash: string;
  readonly chain_hash: string;
}

/** The chain the walk is verifying, named the way its refusals and breaks name it. */
interface ChainScope {
  readonly table: string;
  readonly scope: string;
  readonly reference: string;
}

/** Records reachable from the genesis link, in link order, plus the linkage defects found. */
interface ChainWalk {
  readonly order: readonly number[];
  readonly breaks: readonly ChainBreak[];
}

/**
 * Walks a chain from its genesis record and reports every linkage defect.
 *
 * The walk follows links, not the order rows were read in: `previous_evidence_hash` (evidence) and
 * `prev_hash` (audit) are the authority on order, which is why a deleted interior row shows up as an
 * orphan whose predecessor hash is absent rather than as a plausible-looking shorter chain.
 *
 * @param links The scope's records, in read order.
 * @param scope Table and identity the messages name.
 * @returns The reachable order and the breaks; a break never invalidates the walk itself.
 */
function walkChain(links: readonly ChainLink[], scope: ChainScope): ChainWalk {
  const breaks: ChainBreak[] = [];
  const byChainHash = new Map<string, number>();
  const children = new Map<string, number[]>();

  links.forEach((link, index) => {
    if (byChainHash.has(link.chain_hash)) {
      breaks.push({
        kind: 'CHAIN_HASH_DUPLICATE',
        record: link.record,
        row: index,
        detail:
          `two records of ${scope.scope} carry chain_hash ${link.chain_hash}; ${scope.table} is ` +
          `UNIQUE (tenant_id, chain_hash), so these rows were not written by the chain writer ` +
          `(${scope.reference}).`,
      });
    } else {
      byChainHash.set(link.chain_hash, index);
    }

    const siblings = children.get(link.prev_hash);

    if (siblings === undefined) {
      children.set(link.prev_hash, [index]);
    } else {
      siblings.push(index);
    }
  });

  const roots = children.get(GENESIS_HASH) ?? [];

  if (roots.length === 0) {
    breaks.push({
      kind: 'GENESIS_MISSING',
      record: null,
      row: -1,
      detail:
        `no record of ${scope.scope} links to the genesis digest ${GENESIS_HASH}, so the chain has ` +
        `no verified origin (${scope.reference}).`,
    });
  }

  for (const [prev_hash, holders] of children) {
    for (const index of holders.slice(1)) {
      const link = links[index];
      if (link === undefined) continue;

      breaks.push({
        kind: prev_hash === GENESIS_HASH ? 'GENESIS_FORK' : 'CHAIN_FORK',
        record: link.record,
        row: index,
        detail:
          `record ${link.record} of ${scope.scope} is a second child of predecessor ` +
          `${prev_hash}; a chain link has exactly one successor, so this append forked the chain ` +
          `(${scope.reference}).`,
      });
    }
  }

  const order: number[] = [];
  const visited = new Set<number>();
  let current = roots[0];

  while (current !== undefined && !visited.has(current)) {
    const link = links[current];
    if (link === undefined) break;

    visited.add(current);
    order.push(current);

    const next = (children.get(link.chain_hash) ?? []).find(
      (candidate) => !visited.has(candidate),
    );

    current = next;
  }

  links.forEach((link, index) => {
    if (visited.has(index) || byChainHash.has(link.prev_hash) || link.prev_hash === GENESIS_HASH) {
      return;
    }

    breaks.push({
      kind: 'MISSING_PREDECESSOR',
      record: link.record,
      row: index,
      detail:
        `record ${link.record} of ${scope.scope} links to predecessor ${link.prev_hash}, which no ` +
        `stored row carries; the linked ancestor is missing, so the chain is incomplete ` +
        `(${scope.reference}).`,
    });
  });

  return { order, breaks };
}

/** The row index of a chain-hash lookup, or `-1`; keeps the per-record checks readable. */
function reachedPositions(order: readonly number[]): ReadonlySet<number> {
  return new Set(order);
}

/**
 * How many of the records the walk reached reproduced every digest they were read back with: the
 * `verified` count is about proof, so a record that cannot be reached from the genesis link never
 * counts, however intact its own bytes are.
 */
function reproducedCount(order: readonly number[], reproduced: ReadonlySet<number>): number {
  let count = 0;

  for (const row of order) {
    if (reproduced.has(row)) {
      count += 1;
    }
  }

  return count;
}

/**
 * Recomputes one evidence record's `payload_sha256` from the payload it stores (implement/04 §6.1
 * step 1-2).
 *
 * The digest is taken over the canonical rendering of the stored `raw_payload`, never over the
 * stored `payload_sha256`: the stored column is exactly what an edit would change, so it may be
 * compared with a recomputation but never used as one.
 *
 * @param record The stored record.
 * @param row 0-based read position of the record, for the break.
 * @param scope Table and identity the break names.
 * @param breaks Collector the break is appended to.
 * @returns The recomputed digest, or `null` when the record could not be recomputed (a break was
 * appended instead).
 */
function recomputedPayloadDigest(
  record: ImmutableEvidenceRecord,
  row: number,
  scope: ChainScope,
  breaks: ChainBreak[],
): string | null {
  let recomputed: string;

  try {
    recomputed = sha256CanonicalJson(record.raw_payload);
  } catch (error) {
    breaks.push({
      kind: 'PAYLOAD_DIGEST_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `the stored raw_payload of evidence record ${record.evidence_id} has no canonical form (` +
        `${error instanceof Error ? error.message : String(error)}), so the bytes that were digested ` +
        `cannot be reproduced (${scope.reference}).`,
    });

    return null;
  }

  if (recomputed !== record.payload_sha256) {
    breaks.push({
      kind: 'PAYLOAD_DIGEST_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `evidence record ${record.evidence_id} stores payload_sha256 ${record.payload_sha256} but ` +
        `its canonical raw_payload digests to ${recomputed}; the payload was edited after it was ` +
        `signed (${scope.reference}).`,
    });

    return null;
  }

  return recomputed;
}

/**
 * Recomputes one evidence record's `chain_hash` from its own fields (implement/04 §6.1 step 2).
 *
 * The predecessor digest that enters the formula is the one the record stores, so a rewritten link
 * is reported here instead of being silently followed.
 *
 * @param record The stored record.
 * @param payload_sha256 The digest recomputed from `raw_payload`.
 * @param row 0-based read position of the record, for the break.
 * @param scope Table and identity the break names.
 * @param breaks Collector the break is appended to.
 * @returns The recomputed `chain_hash`, or `null` when the record could not be recomputed (a break
 * was appended instead).
 */
function recomputedChainHash(
  record: ImmutableEvidenceRecord,
  payload_sha256: string,
  row: number,
  scope: ChainScope,
  breaks: ChainBreak[],
): string | null {
  let recomputed: string;

  try {
    recomputed = evidenceChainHash({
      previous_evidence_hash: record.previous_evidence_hash,
      payload_sha256,
      effect_key: record.effect_key,
      step_index: record.step_index,
    });
  } catch (error) {
    breaks.push({
      kind: 'CHAIN_HASH_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `evidence record ${record.evidence_id} cannot be re-hashed (` +
        `${error instanceof Error ? error.message : String(error)}), so the link it carries cannot ` +
        `be reproduced (${scope.reference}).`,
    });

    return null;
  }

  if (recomputed !== record.chain_hash) {
    breaks.push({
      kind: 'CHAIN_HASH_MISMATCH',
      record: record.evidence_id,
      row,
      detail:
        `evidence record ${record.evidence_id} stores chain_hash ${record.chain_hash} but its own ` +
        `fields reproduce ${recomputed}; a hashed field was edited, or the row was written by hand ` +
        `(${scope.reference}).`,
    });

    return null;
  }

  return recomputed;
}

/**
 * Verifies one run's evidence chain (TC-ORC-007, `E2E-OFF-TRACE` step 3).
 *
 * Every stored record is recomputed: `payload_sha256` from the canonical `raw_payload`, `chain_hash`
 * from `previous | payload_sha256 | effect_key | step_index`, and `signature` as the HMAC over the
 * stored `chain_hash`. A record that no longer reproduces is reported, and the walk reports a
 * deleted interior row as a missing predecessor — the report names what is broken instead of
 * truncating the trace at the break.
 *
 * @param records The run's records, as {@link EvidenceRepository} reads them.
 * @param params Scope and signing secret; the secret is required, because a verifier that cannot
 *   verify signatures may not report `valid`.
 * @returns The report; `valid` is `true` only when no break was found.
 * @throws Error `AUDIT_SECRET_MISSING` when no signing secret is configured.
 */
export function verifyEvidenceChain(
  records: readonly ImmutableEvidenceRecord[],
  params: { readonly tenant_id: string; readonly run_id: string; readonly secret?: string },
): EvidenceChainReport {
  const secret = requireAuditHmacSecret(params.secret);
  const scope: ChainScope = {
    table: EVIDENCE_RECORDS,
    scope: `run ${params.run_id} of tenant ${params.tenant_id}`,
    reference: 'implement/04 §6.1',
  };

  const links: ChainLink[] = records.map((record) => ({
    record: record.evidence_id,
    prev_hash: record.previous_evidence_hash,
    chain_hash: record.chain_hash,
  }));

  const walk = walkChain(links, scope);
  const breaks: ChainBreak[] = [...walk.breaks];
  const reached = reachedPositions(walk.order);
  const reproduced = new Set<number>();

  records.forEach((record, row) => {
    const digests = [
      ['previous_evidence_hash', record.previous_evidence_hash],
      ['payload_sha256', record.payload_sha256],
      ['chain_hash', record.chain_hash],
      ['signature', record.signature],
    ] as const;

    let wellFormed = true;

    for (const [column, value] of digests) {
      if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        wellFormed = false;
        breaks.push({
          kind: 'DIGEST_INVALID',
          record: record.evidence_id,
          row,
          detail:
            `evidence record ${record.evidence_id} stores ${column} = ${String(value)}, which is not ` +
            `a lowercase SHA-256; no digest of this row can be recomputed (${scope.reference}).`,
        });
      }
    }

    if (!wellFormed) {
      return;
    }

    const payload_sha256 = recomputedPayloadDigest(record, row, scope, breaks);

    if (payload_sha256 === null) {
      return;
    }

    const chain_hash = recomputedChainHash(record, payload_sha256, row, scope, breaks);

    if (chain_hash === null) {
      return;
    }

    const signature = createHmac('sha256', secret).update(record.chain_hash, 'utf8').digest('hex');

    if (signature !== record.signature) {
      breaks.push({
        kind: 'SIGNATURE_INVALID',
        record: record.evidence_id,
        row,
        detail:
          `the signature of evidence record ${record.evidence_id} does not verify with the ` +
          `configured ${AUDIT_HMAC_SECRET_ENV}; the stored chain_hash was not signed by this ` +
          `chain's signer, so the record is not non-repudiable (${scope.reference}).`,
      });

      return;
    }

    if (reached.has(row)) {
      reproduced.add(row);
    }
  });

  let previous_step_index: number | null = null;
  let head_hash: string | null = null;

  for (const row of walk.order) {
    // `walk.order` holds read positions of `records` by construction; the guard keeps the walk total.
    const record = records[row];

    if (record === undefined) {
      continue;
    }

    if (previous_step_index !== null && record.step_index < previous_step_index) {
      breaks.push({
        kind: 'STEP_ORDER_INVALID',
        record: record.evidence_id,
        row,
        detail:
          `evidence record ${record.evidence_id} is step ${record.step_index}, which precedes step ` +
          `${previous_step_index} earlier in the run's chain; the links and the step order disagree ` +
          `(${scope.reference}).`,
      });
    }

    previous_step_index = record.step_index;
    head_hash = record.chain_hash;
  }

  return {
    valid: breaks.length === 0,
    records: records.length,
    verified: reproducedCount(walk.order, reproduced),
    head_hash,
    breaks,
    tenant_id: params.tenant_id,
    run_id: params.run_id,
  };
}

/**
 * Verifies one tenant's audit chain (TC-ORC-007, implement/08 §4.2).
 *
 * Every stored record is re-hashed with {@link auditChainHash} over {@link buildAuditPayload} and
 * the event time the record publishes: the chain is the whole integrity mechanism of
 * `audit_records`, because the migration gives that table no signature column, so a record whose
 * fields no longer reproduce its `chain_hash` is reported as `CHAIN_HASH_MISMATCH` and a record
 * whose event time is not the UTC-millisecond rendering the writer hashed is reported as
 * `TIMESTAMP_INVALID` rather than verified with different bytes. The records are read in database
 * `chain_seq` order, while the walk itself follows links, so a deleted interior record appears as a
 * missing predecessor and a second child of one predecessor as a fork.
 *
 * @param records The tenant's records, as {@link AuditRepository} reads them.
 * @param params Scope the breaks name.
 * @returns The report; `valid` is `true` only when no break was found.
 */
export function verifyAuditChain(
  records: readonly AuditRecord[],
  params: { readonly tenant_id: string },
): AuditChainReport {
  const scope: ChainScope = {
    table: AUDIT_RECORDS,
    scope: `tenant ${params.tenant_id}`,
    reference: 'implement/08 §4.2',
  };

  const walk = walkChain(
    records.map((record) => ({
      record: record.id,
      prev_hash: record.prev_hash,
      chain_hash: record.chain_hash,
    })),
    scope,
  );

  const breaks: ChainBreak[] = [...walk.breaks];
  const reached = reachedPositions(walk.order);
  const reproduced = new Set<number>();

  records.forEach((record, row) => {
    const digests = [
      ['prev_hash', record.prev_hash],
      ['chain_hash', record.chain_hash],
    ] as const;

    let wellFormed = true;

    for (const [column, value] of digests) {
      if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        wellFormed = false;
        breaks.push({
          kind: 'DIGEST_INVALID',
          record: record.id,
          row,
          detail:
            `audit record ${record.id} stores ${column} = ${String(value)}, which is not a lowercase ` +
            `SHA-256; no digest of this row can be recomputed (${scope.reference}).`,
        });
      }
    }

    if (!wellFormed) {
      return;
    }

    if (typeof record.timestamp !== 'string' || !AUDIT_TIMESTAMP_UTC_ISO_MS.test(record.timestamp)) {
      breaks.push({
        kind: 'TIMESTAMP_INVALID',
        record: record.id,
        row,
        detail:
          `audit record ${record.id} renders its event time as ${String(record.timestamp)}, which is ` +
          `not UTC ISO-8601 with milliseconds; the writer and the verifier would hash different ` +
          `bytes, so the record cannot be verified (${scope.reference}).`,
      });

      return;
    }

    let recomputed: string;

    try {
      recomputed = auditChainHash({
        prev_hash: record.prev_hash,
        payload: buildAuditPayload(record),
        timestamp: record.timestamp,
      });
    } catch (error) {
      breaks.push({
        kind: 'CHAIN_HASH_MISMATCH',
        record: record.id,
        row,
        detail:
          `audit record ${record.id} cannot be re-hashed (` +
          `${error instanceof Error ? error.message : String(error)}), so the link it carries ` +
          `cannot be reproduced (${scope.reference}).`,
      });

      return;
    }

    if (recomputed !== record.chain_hash) {
      breaks.push({
        kind: 'CHAIN_HASH_MISMATCH',
        record: record.id,
        row,
        detail:
          `audit record ${record.id} stores chain_hash ${record.chain_hash} but its own fields ` +
          `reproduce ${recomputed}; a hashed field was edited after the row was appended ` +
          `(${scope.reference}).`,
      });

      return;
    }

    if (reached.has(row)) {
      reproduced.add(row);
    }
  });

  let head_hash: string | null = null;

  for (const row of walk.order) {
    const record = records[row];

    if (record !== undefined) {
      head_hash = record.chain_hash;
    }
  }

  return {
    valid: breaks.length === 0,
    records: records.length,
    verified: reproducedCount(walk.order, reproduced),
    head_hash,
    breaks,
    tenant_id: params.tenant_id,
  };
}
