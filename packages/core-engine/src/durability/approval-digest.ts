/**
 * @file Canonical AUTH-4 approval payload digest (workflow §15).
 *
 * The approval binds the skill input that survives schema validation, not the orchestrator's
 * dispatch envelope or policy metadata. The schema normalizer is supplied by the policy boundary;
 * the skill runtime calls this with input it has already normalized.
 */

import type { ActionDraft } from '../contracts/types.js';
import { sha256CanonicalJson } from './canonical-json.js';

export const APPROVAL_DIGEST_VERSION = 1 as const;

export type ApprovalPayloadNormalizer = (
  skill_id: string,
  input: Record<string, unknown>,
) => unknown;

/**
 * Projects an action payload onto the input fields the skill runtime receives.
 *
 * Policy annotations live on `ActionDraft`, outside `payload`; the server-resolved effect key is
 * the only envelope field historically echoed inside that payload.
 */
export function approvalPayloadInput(
  action: Pick<ActionDraft, 'skill_id' | 'payload'>,
  normalizeInput?: ApprovalPayloadNormalizer,
): unknown {
  const payload = action.payload;
  const input = Object.hasOwn(payload, 'effect_key')
    ? (() => {
        const { effect_key: _effectKey, ...rest } = payload;
        void _effectKey;
        return rest;
      })()
    : payload;
  return normalizeInput ? normalizeInput(action.skill_id, input) : input;
}

/** Computes the versioned AUTH-4 digest over one action's normalized skill input. */
export function approvalPayloadDigest(
  action: Pick<ActionDraft, 'skill_id' | 'payload'>,
  normalizeInput?: ApprovalPayloadNormalizer,
): string {
  if (typeof action.skill_id !== 'string' || action.skill_id.trim().length === 0) {
    throw new Error('APPROVAL_SKILL_ID_REQUIRED: approval digest requires the registered skill id.');
  }
  if (typeof action.payload !== 'object' || action.payload === null || Array.isArray(action.payload)) {
    throw new Error('APPROVAL_PAYLOAD_INVALID: approval digest requires an object payload.');
  }

  return sha256CanonicalJson(approvalPayloadInput(action, normalizeInput));
}
