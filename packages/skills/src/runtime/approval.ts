/**
 * @file Approval binding for the `AUTH-4` route (BR-007, implement/05 §1.2, §2, §8.1).
 *
 * An approval authorizes one action, keyed by `(tenant_id, run_id, effect_key, payload_digest)`.
 * The digest is taken over the **normalized** payload — defaults applied, unknown keys stripped —
 * because that is the payload the approval recorded and the one that will be executed, so validator
 * behaviour can never make an approved digest unmatchable. An approver who modified the payload
 * changes the digest, and dispatch stays blocked until the action is re-authorized.
 */

import { SkillError, type PayloadDigestFn, type SkillDispatchRequest } from '../contracts/index.js';

/**
 * Verifies that the bound approval covers exactly the payload in hand.
 *
 * @param skill_id The row being dispatched.
 * @param normalized_input The payload produced by the row's own validator.
 * @param request The dispatch envelope carrying the approval binding.
 * @param digestPayload The injected canonical digest (RFC 8785 + SHA-256).
 * @returns The claimed approval id.
 * @throws {SkillError} `APPROVAL_REQUIRED` without a bound approval, or
 *   `APPROVAL_PAYLOAD_MISMATCH` when the approval covers a different payload.
 */
export function assertApprovalCoversPayload(params: {
  readonly skill_id: string;
  readonly normalized_input: unknown;
  readonly request: SkillDispatchRequest;
  readonly digestPayload: PayloadDigestFn;
}): string {
  const { skill_id, normalized_input, request, digestPayload } = params;

  if (request.approval_id === undefined || request.approval_id.length === 0) {
    throw new SkillError(
      'APPROVAL_REQUIRED',
      'the row prepares an action but never executes it without a human approval bound to this run and effect key; route through the SCR-003 gate (BR-007)',
      skill_id,
    );
  }

  if (digestPayload(normalized_input) !== request.approval_payload_digest) {
    throw new SkillError(
      'APPROVAL_PAYLOAD_MISMATCH',
      `approval ${request.approval_id} covers a different payload digest; a modified payload requires a new authorization before dispatch (BR-007)`,
      skill_id,
    );
  }

  return request.approval_id;
}
