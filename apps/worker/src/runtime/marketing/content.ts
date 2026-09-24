import { createHash } from 'node:crypto';
import {
  type MarketingBrandAuditInput,
  type MarketingBrandAuditOutput,
  type MarketingContentInput,
  type MarketingContentOutput,
  type MarketingKnowledgeDocument,
  MarketingRuntimeError,
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

/**
 * Screens untrusted text for prompt injection or system/policy/authority override instructions.
 * Throws MarketingRuntimeError('PROMPT_INJECTION_BLOCKED', ...) when an injection pattern is detected.
 */
export function screenMarketingUntrustedInput(text: string, fieldName: string): string {
  if (typeof text !== 'string') {
    throw new MarketingRuntimeError(
      'INVALID_INPUT',
      `${fieldName} must be a string`,
    );
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

/**
 * Deterministic MKT-03 content generator.
 * Generates channel-specific draft content derived strictly from campaign_theme and product_skus.
 * Avoids inventing offers, prices, or policy claims, and explicitly marks content as a DRAFT.
 */
export function generateMarketingContent(
  input: MarketingContentInput,
  _approvedDocs: readonly MarketingKnowledgeDocument[],
  idFactory?: () => string,
): MarketingContentOutput {
  if (!input || typeof input.tenant_id !== 'string' || input.tenant_id.trim().length === 0) {
    throw new MarketingRuntimeError('INVALID_INPUT', 'tenant_id must be a non-empty string');
  }
  if (typeof input.campaign_theme !== 'string' || input.campaign_theme.trim().length === 0) {
    throw new MarketingRuntimeError('INVALID_INPUT', 'campaign_theme must be a non-empty string');
  }
  screenMarketingUntrustedInput(input.campaign_theme, 'campaign_theme');

  const validChannels = [
    'LINE_FLEX',
    'WHATSAPP_TEMPLATE',
    'EMAIL_HTML',
    'SMS_TEXT',
    'ZALO_ZNS',
    'TIKTOK_CARD',
    'MESSENGER_GENERIC',
    'INSTAGRAM_DIRECT',
  ] as const;

  if (!validChannels.includes(input.channel as (typeof validChannels)[number])) {
    throw new MarketingRuntimeError('INVALID_CHANNEL', `Unsupported marketing channel: ${input.channel}`);
  }

  const validLocales = ['zh-TW', 'en-US', 'vi-VN', 'ja-JP'] as const;
  if (!validLocales.includes(input.locale)) {
    throw new MarketingRuntimeError('INVALID_LOCALE', `Unsupported locale: ${input.locale}`);
  }

  const theme = input.campaign_theme.trim();
  const draft_id = typeof idFactory === 'function'
    ? idFactory()
    : `draft-${input.tenant_id}-${createHash('sha256')
        .update(`${input.tenant_id}:${input.channel}:${input.locale}:${theme}`)
        .digest('hex')
        .slice(0, 12)}`;

  const skus = Array.isArray(input.product_skus) && input.product_skus.length > 0
    ? input.product_skus
    : [];

  let headline: string;
  let body_content: string;
  let cta_text: string;

  switch (input.locale) {
    case 'zh-TW':
      headline = theme;
      body_content = skus.length > 0
        ? `針對「${theme}」的主題草案內容，包含產品項目：${skus.join('、')}。`
        : `針對「${theme}」的主題草案內容。`;
      cta_text = '了解更多';
      break;
    case 'vi-VN':
      headline = theme;
      body_content = skus.length > 0
        ? `Nội dung bản nháp cho chiến dịch ${theme}, bao gồm sản phẩm: ${skus.join(', ')}.`
        : `Nội dung bản nháp cho chiến dịch ${theme}.`;
      cta_text = 'Tìm hiểu thêm';
      break;
    case 'ja-JP':
      headline = theme;
      body_content = skus.length > 0
        ? `「${theme}」のキャンペーン下書きコンテンツ（対象SKU: ${skus.join('、')}）。`
        : `「${theme}」のキャンペーン下書きコンテンツ。`;
      cta_text = '詳細を見る';
      break;
    case 'en-US':
    default:
      headline = theme;
      body_content = skus.length > 0
        ? `Draft campaign content for ${theme}, featuring products: ${skus.join(', ')}.`
        : `Draft campaign content for ${theme}.`;
      cta_text = 'Learn More';
      break;
  }

  let channel_payload: MarketingContentOutput['channel_payload'];

  switch (input.channel) {
    case 'LINE_FLEX':
      channel_payload = {
        channel_type: input.channel,
        line_flex_container: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [{ type: 'text', text: headline, weight: 'bold' }],
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [{ type: 'text', text: body_content, wrap: true }],
          },
        },
      };
      break;
    case 'WHATSAPP_TEMPLATE':
      channel_payload = {
        channel_type: input.channel,
        whatsapp_template: {
          template_name: 'draft_campaign_notification',
          parameters: [headline, body_content, cta_text],
        },
      };
      break;
    case 'ZALO_ZNS':
      channel_payload = {
        channel_type: input.channel,
        zalo_zns_template: {
          template_id: 'draft_campaign_zns',
          template_data: { headline, body: body_content },
        },
      };
      break;
    case 'MESSENGER_GENERIC':
    case 'INSTAGRAM_DIRECT':
    case 'TIKTOK_CARD':
      channel_payload = {
        channel_type: input.channel,
        meta_generic_card: {
          title: headline,
          subtitle: body_content,
        },
      };
      break;
    case 'EMAIL_HTML':
    case 'SMS_TEXT':
    default:
      channel_payload = {
        channel_type: input.channel,
      };
      break;
  }

  return {
    draft_id,
    headline,
    body_content,
    cta_text,
    channel_payload,
  };
}

/**
 * Extracts explicit prohibited phrases from approved brand/prohibited-claims.md content.
 */
export function extractProhibitedPhrases(content: string): readonly string[] {
  if (typeof content !== 'string') {
    return [];
  }

  // Strip YAML frontmatter
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

/**
 * Deterministic MKT-04 brand compliance auditor.
 * Validates draft_text against approved brand policy docs (specifically brand/prohibited-claims.md).
 * Fails closed if the required approved policy document is absent or empty.
 */
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

  const lowerDraft = input.draft_text.toLowerCase();

  for (let i = 0; i < prohibitedPhrases.length; i++) {
    const phrase = prohibitedPhrases[i];
    if (phrase === undefined) continue;
    const phraseLower = phrase.toLowerCase();
    const matchIndex = lowerDraft.indexOf(phraseLower);
    if (matchIndex !== -1) {
      const snippet = input.draft_text.slice(matchIndex, matchIndex + phrase.length);
      violations.push({
        rule_id: `RULE_PROHIBITED_CLAIM_${i + 1}`,
        severity: 'BLOCKING',
        snippet,
        suggestion: `Remove or replace prohibited claim: "${phrase}".`,
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
