import { isAbsolute, normalize } from 'node:path';
import type { KnowledgeDocumentNamespace } from '@agentos/database';
import { KnowledgeStore, type AvailableKnowledgeDocument } from '../shared/knowledge-store.js';
import {
  type MarketingKnowledgeDocument,
  type MarketingKnowledgePort,
  MarketingRuntimeError,
} from './contracts.js';

/**
 * Safe canonical allowlist limited strictly to the 5 approved marketing knowledge documents.
 */
export const MARKETING_APPROVED_DOCUMENT_ALLOWLIST = Object.freeze([
  'brand/voice.md',
  'brand/terminology.md',
  'brand/prohibited-claims.md',
  'marketing/playbook.md',
  'marketing/content-guidelines.md',
] as const);

export type MarketingApprovedDocumentPath =
  (typeof MARKETING_APPROVED_DOCUMENT_ALLOWLIST)[number];

const ALLOWLIST_LOOKUP: Record<string, true> = {
  'brand/voice.md': true,
  'brand/terminology.md': true,
  'brand/prohibited-claims.md': true,
  'marketing/playbook.md': true,
  'marketing/content-guidelines.md': true,
};


/**
 * Known instruction override, prompt injection, and jailbreak patterns.
 * Note: Pattern matching is an explicit defense-in-depth screening layer
 * and does not constitute a full security boundary against novel adversarial attacks.
 */
const INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /override\s+(previous|prior|above|system)\s+instructions/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /bypass\s+(all\s+)?(safety|guardrails?|filters?|rules?|restrictions?)/i,
  /you\s+are\s+now\s+(in\s+)?(developer\s+mode|dan|unfiltered|jailbroken)/i,
  /system\s+prompt\s*:\s*override/i,
  /<\|(?:im_start|im_end|system|user|assistant)\|>/i,
  /\[SYSTEM_OVERRIDE\]/i,
  /\bDAN\s+Mode\b/i,
]);

/**
 * Screens untrusted content for instruction override / prompt injection.
 * Throws a MarketingRuntimeError when injection or override patterns are detected.
 *
 * @param text The raw document or untrusted content to screen.
 * @returns The validated content if no injection pattern is detected.
 * @throws MarketingRuntimeError('INJECTION_DETECTED', ...) when screening fails.
 */
export function screenMarketingUntrustedContent(text: string): string {
  if (typeof text !== 'string') {
    throw new MarketingRuntimeError(
      'INVALID_CONTENT',
      'Content to screen must be a string',
    );
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      throw new MarketingRuntimeError(
        'INJECTION_DETECTED',
        `Prompt injection or instruction override detected in knowledge content matching ${pattern}`,
      );
    }
  }

  return text;
}


export interface MarketingKnowledgePortOptions {
  readonly knowledge_store?: Pick<KnowledgeStore, 'listAvailable'>;
}

/** Creates a Marketing knowledge port that exposes only tenant-scoped AVAILABLE database rows. */
export function createMarketingKnowledgePort(
  options: MarketingKnowledgePortOptions = {},
): MarketingKnowledgePort {
  const knowledgeStore = options.knowledge_store ?? new KnowledgeStore();
  return {
    async readApproved(tenant_id: string, path: string): Promise<MarketingKnowledgeDocument> {
      if (typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
        throw new MarketingRuntimeError('INVALID_TENANT', 'Tenant ID must be a non-empty string');
      }
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new MarketingRuntimeError('INVALID_PATH', 'Document path must be a non-empty string');
      }
      if (
        isAbsolute(path)
        || path.includes('..')
        || path.startsWith('/')
        || path.startsWith('\\')
        || path.includes('\\')
        || path.includes(':')
      ) {
        throw new MarketingRuntimeError('PATH_NOT_ALLOWED', `Path traversal or absolute path rejected: '${path}'`);
      }

      const normalizedPath = normalize(path).replace(/\\/g, '/');
      if (!ALLOWLIST_LOOKUP[normalizedPath]) {
        throw new MarketingRuntimeError(
          'PATH_NOT_ALLOWED',
          `Path '${normalizedPath}' is not in the marketing approved document allowlist`,
        );
      }
      const separator = normalizedPath.indexOf('/');
      const namespace = normalizedPath.slice(0, separator) as KnowledgeDocumentNamespace;
      const slug = normalizedPath.slice(separator + 1).replace(/\.md$/, '');

      let availableDocs: readonly AvailableKnowledgeDocument[];
      try {
        availableDocs = await knowledgeStore.listAvailable(tenant_id, namespace);
      } catch (error) {
        throw new MarketingRuntimeError(
          'CORPUS_UNAVAILABLE',
          `Failed to list available knowledge documents: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const document = availableDocs.find((item) => item.slug === slug);
      if (!document) {
        throw new MarketingRuntimeError(
          'DOCUMENT_NOT_APPROVED',
          `Document '${normalizedPath}' is not AVAILABLE in the tenant knowledge store`,
        );
      }

      screenMarketingUntrustedContent(document.body);
      return {
        path: normalizedPath,
        version: document.content_sha256,
        content: document.body,
      };
    },
  };
}
