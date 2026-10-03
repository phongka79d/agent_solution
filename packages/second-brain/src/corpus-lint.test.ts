import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const corpusRoot = fileURLToPath(new URL('../demo/novamart', import.meta.url));

/**
 * The customer-facing namespaces whose approved documents feed agent answers.
 * Engineering-only corpora (marketing/sales operator playbooks) are intentionally
 * out of scope for this lint; the notes that used to live in the corpus now live in
 * `docs/demo/knowledge-notes.md`.
 */
const CUSTOMER_FACING_NAMESPACES = ['customer-care', 'product', 'policy'] as const;

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

interface InternalPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

const INTERNAL_PATTERNS: readonly InternalPattern[] = [
  { name: 'skill identifier', pattern: /\bskill\.[a-z0-9_]+/i },
  { name: 'authority code', pattern: /\bAUTH-[0-9]\b/ },
  { name: 'provenance field', pattern: /\bsource_version\b/ },
  {
    name: 'permission name',
    pattern: /\b(?:campaign|conversation|approval|run|telemetry|customer|platform):[a-z_]+/i,
  },
  { name: 'internal agent code', pattern: /\b(?:MKT|CS|ASM|API|CARE)[-_]?\d{2,3}\b/ },
  { name: 'internal route code', pattern: /\bR0[1-9]\b/ },
  {
    name: 'internal lifecycle code',
    pattern: /\b(?:CONVERSATION_LOCKED|CARE_ONBOARDING[A-Z_]*|awaiting_human)\b/,
  },
  {
    name: 'internal module name',
    pattern:
      /\b(?:RevenueOrchestrator|PolicyEnforcementPoint|DomainPolicyEngine|OpenAICompatibleLLMAdapter|Core\.LLMContentEngine|SecondBrain\.[A-Za-z]+|[A-Za-z]+AgentRuntime)\b/,
  },
];

describe('NovaMart customer-facing corpus hygiene', () => {
  for (const namespace of CUSTOMER_FACING_NAMESPACES) {
    it(`keeps ${namespace} documents free of internal identifiers`, async () => {
      const entries = await readdir(join(corpusRoot, namespace));
      const documents = entries.filter((entry) => entry.endsWith('.md')).sort();
      expect(documents.length).toBeGreaterThan(0);

      for (const document of documents) {
        const raw = await readFile(join(corpusRoot, namespace, document), 'utf8');
        // Strip approved-provenance frontmatter so only customer-facing prose is linted.
        const body = raw.replace(FRONTMATTER_PATTERN, '');
        for (const { name, pattern } of INTERNAL_PATTERNS) {
          const match = body.match(pattern);
          expect(
            match,
            `${namespace}/${document} leaks a ${name} ("${match?.[0] ?? ''}")`,
          ).toBeNull();
        }
      }
    });
  }

  it('preserves the customer-facing FAQ identifiers and return-policy answer', async () => {
    const faq = await readFile(join(corpusRoot, 'customer-care', 'faq.md'), 'utf8');
    expect(faq).toContain('## FAQ-1: What is your return policy?');
    expect(faq).toContain('14-day unopened return policy');
  });
});
