import { createHash } from 'node:crypto';

export interface AuditSpec {
  readonly mask_pii_fields?: readonly string[];
}

const REDACTED = '[REDACTED]';
const DATABASE_IDENTIFIER_LIMIT = 64;
const HASH_PREFIX = 'sha256:';
const HASH_HEX_LENGTH = DATABASE_IDENTIFIER_LIMIT - HASH_PREFIX.length;
const SAFE_IDENTIFIERS: Record<string, true> = {
  run_id: true,
  tenant_id: true,
  agent_id: true,
};
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /\+?\d(?:[\s().-]*\d){9,}/g;

function isSensitiveKey(key: string, inContext: boolean): boolean {
  const normalized = key.toLowerCase().replace(/[\s-]+/g, '_');
  if (
    normalized.startsWith('verified_')
    || /(?:^|_)(?:email|e_mail|phone|telephone|mobile|address)(?:_|$)/.test(normalized)
  ) {
    return true;
  }
  return inContext && /(?:^|_)(?:spend|spent|spending)(?:_|$)/.test(normalized);
}

function hashIdentifier(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  // customer_or_entity_id is VARCHAR(64); retain 228 bits plus an algorithm marker.
  return `${HASH_PREFIX}${digest.slice(0, HASH_HEX_LENGTH)}`;
}

/**
 * Returns a detached, JSON-safe audit projection: fields named by `audit_spec.mask_pii_fields`
 * are masked; identifier values are stable SHA-256 tokens; sensitive context fields and embedded
 * email/phone values are removed before either append-only audit writer sees the record.
 */
export function redactForAudit<T extends object>(record: T, auditSpec?: AuditSpec): T {
  const maskedFields = new Set((auditSpec?.mask_pii_fields ?? []).map(
    (field) => field.toLowerCase().replace(/[\s-]+/g, '_'),
  ));
  const seen = new WeakMap<object, unknown>();

  const visit = (value: unknown, key: string | undefined, inContext: boolean, root: boolean): unknown => {
    if (typeof value === 'string') {
      const normalized = key?.toLowerCase();
      if (
        normalized !== undefined
        && (normalized === 'id' || normalized === 'ids'
          || /(?:_id|_ids|_identifier|_identifiers)$/.test(normalized))
      ) {
        // A safe identifier is returned verbatim: its digits would otherwise be mangled by the
        // phone-number scrub below, corrupting the append-only row's identity key.
        return SAFE_IDENTIFIERS[normalized] === true ? value : hashIdentifier(value);
      }
      const timestampField = key !== undefined
        && /(?:^|_)(?:at|timestamp|date|time)$/.test(key.toLowerCase());
      return timestampField ? value : value.replace(EMAIL, REDACTED).replace(PHONE, REDACTED);
    }
    if (value === null || typeof value !== 'object') return value;
    const previous = seen.get(value);
    if (previous !== undefined) return previous;

    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value, result);
      for (const entry of value) result.push(visit(entry, key, inContext, false));
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [field, fieldValue] of Object.entries(value)) {
      const normalized = field.toLowerCase().replace(/[\s-]+/g, '_');
      const childContext = inContext || (root && field === 'context');
      if (maskedFields.has(normalized)) {
        result[field] = REDACTED;
      } else if (isSensitiveKey(field, childContext)) {
        continue;
      } else {
        result[field] = visit(fieldValue, field, childContext, false);
      }
    }
    return result;
  };

  return visit(record, undefined, false, true) as T;
}
