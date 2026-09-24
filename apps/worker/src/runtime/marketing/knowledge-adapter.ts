import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listApprovedKnowledge } from '@agentos/core-engine';
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

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const STATUS_PATTERN = /^status:[ \t]*(\S.*?)[ \t]*$/m;

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
  readonly root_dir?: string;
  readonly listApproved?: (
    rootDir: string,
  ) => Promise<readonly { path: string; status: string }[]>;
  readonly readFile?: (
    path: string,
    encoding: 'utf8',
  ) => Promise<string>;
}

/**
 * Creates a MarketingKnowledgePort bound to a knowledge root.
 * Validates tenant binding, enforces canonical allowlist, requires approved frontmatter,
 * computes deterministic content version hash from exact approved source bytes,
 * and screens content for instruction override before returning.
 */
export function createMarketingKnowledgePort(
  options: MarketingKnowledgePortOptions = {},
): MarketingKnowledgePort {
  const defaultRootDir = fileURLToPath(
    new URL('../../../../../packages/second-brain', import.meta.url),
  );
  const rootDir = options.root_dir ?? defaultRootDir;
  const listApproved = options.listApproved ?? listApprovedKnowledge;
  const readFile = options.readFile ?? fsReadFile;

  return {
    async readApproved(
      tenant_id: string,
      path: string,
    ): Promise<MarketingKnowledgeDocument> {
      // 1. Validate tenant binding
      if (!tenant_id || typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
        throw new MarketingRuntimeError(
          'INVALID_TENANT',
          'Tenant ID must be a non-empty string',
        );
      }

      // 2. Validate path
      if (!path || typeof path !== 'string' || path.trim().length === 0) {
        throw new MarketingRuntimeError(
          'INVALID_PATH',
          'Document path must be a non-empty string',
        );
      }

      // Reject traversal, absolute paths, drive-qualified paths, and non-canonical separators before normalization.
      if (
        isAbsolute(path) ||
        path.includes('..') ||
        path.startsWith('/') ||
        path.startsWith('\\') ||
        path.includes('\\') ||
        path.includes(':')
      ) {
        throw new MarketingRuntimeError(
          'PATH_NOT_ALLOWED',
          `Path traversal or absolute path rejected: '${path}'`,
        );
      }

      // Canonical POSIX normalization
      const normalizedPath = normalize(path).replace(/\\/g, '/');

      // 3. Safe canonical allowlist verification
      if (!ALLOWLIST_LOOKUP[normalizedPath]) {
        throw new MarketingRuntimeError(
          'PATH_NOT_ALLOWED',
          `Path '${normalizedPath}' is not in the marketing approved document allowlist`,
        );
      }

      // 4. Verify document is approved in Second Brain corpus via listApproved
      let approvedDocs: readonly { path: string; status: string }[];
      try {
        approvedDocs = await listApproved(rootDir);
      } catch (error) {
        throw new MarketingRuntimeError(
          'CORPUS_UNAVAILABLE',
          `Failed to list approved knowledge documents from root '${rootDir}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const isDocumentApproved = approvedDocs.some(
        (doc) => doc.path === normalizedPath && doc.status === 'approved',
      );

      if (!isDocumentApproved) {
        throw new MarketingRuntimeError(
          'DOCUMENT_NOT_APPROVED',
          `Document '${normalizedPath}' is not approved or is draft in second-brain corpus`,
        );
      }

      // 5. Read physical file content
      const fullPath = join(rootDir, normalizedPath);
      let source: string;
      try {
        source = await readFile(fullPath, 'utf8');
      } catch (error) {
        throw new MarketingRuntimeError(
          'DOCUMENT_UNREADABLE',
          `Failed to read approved document '${normalizedPath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 6. Direct frontmatter verification: status must be approved
      const frontmatterMatch = FRONTMATTER_PATTERN.exec(source);
      const statusMatch =
        frontmatterMatch === null
          ? null
          : STATUS_PATTERN.exec(frontmatterMatch[1] ?? '');

      if (statusMatch?.[1] !== 'approved') {
        throw new MarketingRuntimeError(
          'DOCUMENT_NOT_APPROVED',
          `Document '${normalizedPath}' frontmatter status is '${statusMatch?.[1] ?? 'missing'}', expected 'approved'`,
        );
      }

      // 7. Screen untrusted content for prompt injection / instruction override
      screenMarketingUntrustedContent(source);

      // 8. Deterministic version hash of exact approved source bytes
      const version = createHash('sha256').update(source, 'utf8').digest('hex');

      return {
        path: normalizedPath,
        version,
        content: source,
      };
    },
  };
}
