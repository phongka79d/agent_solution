import {
  MarketingRuntimeError,
  type MarketingBrandAuditInput,
  type MarketingBrandAuditOutput,
  type MarketingKnowledgeDocument,
} from './contracts.js';

/**
 * Known instruction override, prompt injection, and jailbreak patterns.
 * Note: Pattern matching is an explicit defense-in-depth screening layer.
 */
const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /ignore\s+(all\s+)?(previous|prior|above|system|policy|authority|tool)\s+(instructions|prompts|rules|directives)?/i,
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /ignore\s+(system|policy|authority|tools?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|system|policy|authority|tool)\s+(instructions|prompts|rules|directives)?/i,
  /disregard\s+(system|policy|authority|tools?)/i,
  /override\s+(all\s+)?(previous|prior|above|system|policy|authority|tool)\s*(instructions|prompts|rules|directives)?/i,
  /override\s+(system|policy|authority|tools?)/i,
  /forget\s+(all\s+)?(previous|prior|above|system|policy|authority)\s+(instructions|prompts|rules|directives)?/i,
  /bypass\s+(all\s+)?(safety|guardrails?|filters?|rules?|restrictions?|policy|authority|tools?)/i,
  /bypass\s+(system|policy|authority|tools?)/i,
  /you\s+are\s+now\s+(in\s+)?(developer\s+mode|dan|unfiltered|jailbroken)/i,
  /system\s+prompt\s*:\s*override/i,
  /<\|(?:im_start|im_end|system|user|assistant)\|>/i,
  /\[SYSTEM_OVERRIDE\]/i,
  /\bDAN\s+Mode\b/i,
]);

/** Screens untrusted text for instruction override attempts. */
export function screenMarketingUntrustedInput(text: string, fieldName: string): string {
  if (typeof text !== 'string') {
    throw new MarketingRuntimeError('INVALID_INPUT', `${fieldName} must be a string`);
  }

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      throw new MarketingRuntimeError(
        'PROMPT_INJECTION_BLOCKED',
        `Prompt injection or instruction override detected in ${fieldName} matching ${pattern}`,
      );
    }
  }

  return text;
}

/** Extracts explicit prohibited phrases from approved brand/prohibited-claims.md content. */
export function extractProhibitedPhrases(content: string): readonly string[] {
  if (typeof content !== 'string') {
    return [];
  }

  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const lines = body.split(/\r?\n/);
  const phrases: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch) {
      const phraseMatch = bulletMatch[1];
      if (phraseMatch === undefined) continue;
      const phrase = phraseMatch.trim().replace(/^[`'"]|[`'"]$/g, '');
      if (
        phrase.length > 0 &&
        !phrase.toLowerCase().includes('placeholder') &&
        !phrase.toLowerCase().includes('status is draft')
      ) {
        phrases.push(phrase);
      }
    } else if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      for (const cell of cells) {
        if (!cell.startsWith('---') && !cell.toLowerCase().includes('claim') && !cell.toLowerCase().includes('rule')) {
          const phrase = cell.replace(/^[`'"]|[`'"]$/g, '');
          if (phrase.length > 0) {
            phrases.push(phrase);
          }
        }
      }
    }
  }

  return Object.freeze(phrases);
}

/** Deterministic MKT-04 brand compliance auditor. */
export function auditMarketingBrand(
  input: MarketingBrandAuditInput,
  approvedDocs: readonly MarketingKnowledgeDocument[],
): MarketingBrandAuditOutput {
  if (!input || typeof input.tenant_id !== 'string' || input.tenant_id.trim().length === 0) {
    throw new MarketingRuntimeError('INVALID_INPUT', 'tenant_id must be a non-empty string');
  }
  if (typeof input.draft_text !== 'string' || input.draft_text.trim().length === 0) {
    throw new MarketingRuntimeError('INVALID_INPUT', 'draft_text must be a non-empty string');
  }
  screenMarketingUntrustedInput(input.draft_text, 'draft_text');
  for (const [fieldName, value] of [
    ['subject', input.subject],
    ['title', input.title],
    ['headline', input.headline],
    ['cta_text', input.cta_text],
    ['preheader', input.preheader],
  ] as const) {
    if (value !== undefined) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new MarketingRuntimeError('INVALID_INPUT', `${fieldName} must be a non-empty string when supplied`);
      }
      screenMarketingUntrustedInput(value, fieldName);
    }
  }

  const prohibitedClaimsDoc = approvedDocs.find(
    (doc) => doc.path === 'brand/prohibited-claims.md',
  );

  if (!prohibitedClaimsDoc || !prohibitedClaimsDoc.content || prohibitedClaimsDoc.content.trim().length === 0) {
    throw new MarketingRuntimeError(
      'MISSING_APPROVED_POLICY_DOC',
      'Required approved policy document brand/prohibited-claims.md is missing, unapproved, or empty for compliance analysis.',
    );
  }

  const prohibitedPhrases = extractProhibitedPhrases(prohibitedClaimsDoc.content);
  if (prohibitedPhrases.length === 0) {
    throw new MarketingRuntimeError(
      'MISSING_APPROVED_POLICY_DOC',
      'Approved document brand/prohibited-claims.md contains no extractable prohibited claims; refusing compliance audit to fail closed.',
    );
  }

  const violations: {
    rule_id: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING';
    snippet: string;
    suggestion: string;
  }[] = [];

  const auditedFields = [
    ['draft_text', input.draft_text],
    ['subject', input.subject],
    ['title', input.title],
    ['headline', input.headline],
    ['cta_text', input.cta_text],
    ['preheader', input.preheader],
  ] as const;

  for (let i = 0; i < prohibitedPhrases.length; i++) {
    const phrase = prohibitedPhrases[i];
    if (phrase === undefined) continue;
    const phraseLower = phrase.toLowerCase();
    for (const [fieldName, fieldValue] of auditedFields) {
      if (fieldValue === undefined) continue;
      const matchIndex = fieldValue.toLowerCase().indexOf(phraseLower);
      if (matchIndex === -1) continue;
      const snippet = fieldValue.slice(matchIndex, matchIndex + phrase.length);
      violations.push({
        rule_id: `RULE_PROHIBITED_CLAIM_${i + 1}_${fieldName}`,
        severity: 'BLOCKING',
        snippet,
        suggestion: `Remove or replace prohibited claim from ${fieldName}: "${phrase}".`,
      });
    }
  }

  const compliant = violations.length === 0;

  return {
    compliant,
    violations: Object.freeze(violations),
    confidence_score: compliant ? 1.0 : 0.95,
  };
}
