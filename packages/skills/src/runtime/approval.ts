/**
 * @file Approval binding for the `AUTH-4` route (BR-007, implement/05 §1.2, §2, §8.1).
 *
 * An approval authorizes one action, keyed by `(tenant_id, run_id, effect_key, payload_digest)`.
 * The digest is over the schema-normalized skill input that will execute; envelope identity and
 * policy metadata are not skill input.
 */

import { SkillError, type ApprovalDigestFn, type SkillDispatchRequest } from '../contracts/index.js';

/**
 * Verifies that the bound approval covers exactly the payload in hand.
 *
 * @param skill_id The row being dispatched.
 * @param normalized_input The payload produced by the row's own validator.
 * @param request The dispatch envelope carrying the approval binding.
 * @returns The claimed approval id.
 * @throws {SkillError} `APPROVAL_REQUIRED` without a bound approval, or
 *   `APPROVAL_PAYLOAD_MISMATCH` when the approval covers a different payload.
 */
export function assertApprovalCoversPayload(params: {
  readonly skill_id: string;
  readonly normalized_input: unknown;
  readonly request: SkillDispatchRequest;
  readonly approvalDigest: ApprovalDigestFn;
}): string {
  const { skill_id, normalized_input, request, approvalDigest } = params;

  if (request.approval_id === undefined || request.approval_id.length === 0) {
    throw new SkillError(
      'APPROVAL_REQUIRED',
      'the row prepares an action but never executes it without a human approval bound to this run and effect key; route through the SCR-003 gate (BR-007)',
      skill_id,
    );
  }

  if (typeof normalized_input !== 'object' || normalized_input === null || Array.isArray(normalized_input)) {
    throw new SkillError(
      'APPROVAL_PAYLOAD_MISMATCH',
      `approval ${request.approval_id} cannot cover a non-object payload (BR-007)`,
      skill_id,
    );
  }
  const payload: Record<string, unknown> = { ...normalized_input };
  if (approvalDigest({ skill_id, payload }) !== request.approval_payload_digest) {
    throw new SkillError(
      'APPROVAL_PAYLOAD_MISMATCH',
      `approval ${request.approval_id} covers a different payload digest; a modified payload requires a new authorization before dispatch (BR-007)`,
      skill_id,
    );
  }

  return request.approval_id;
}
