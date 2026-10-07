import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listApprovedKnowledge } from '@agentos/core-engine';
import type { SkillToolInvocation } from '@agentos/skills';

import { CareSkillToolError } from './errors.js';
import { parseFaqMarkdown, scoreFaqMatch } from './faq-parser.js';

function firstNonEmptyString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readFaqQuery(input: Record<string, unknown>): string {
  // A classifier may populate query_text with only its label (for example, "FAQ"). Prefer the
  // server-extracted question/customer message so retrieval is grounded in what the customer asked.
  const extractedValues = [
    'extracted_query',
    'question',
    'customer_message',
    'customerMessage',
    'message',
    'content',
  ]
    .map((key) => input[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  const queryText = firstNonEmptyString(input, ['query_text']);
  const candidates = queryText === undefined ? extractedValues : [...extractedValues, queryText];
  return candidates.find((value) => !/^(faq|faq[_-]search)$/i.test(value)) ?? candidates[0] ?? '';
}

/** Handles the approved SecondBrain FAQ lookup without changing the tool-port contract. */
export async function handleFaqEngine<TOutput>(
  invocation: SkillToolInvocation<unknown>,
  knowledgeRoot: string,
): Promise<TOutput> {
  const input = (invocation.input ?? {}) as Record<string, unknown>;
  const query_text = readFaqQuery(input).toLowerCase().trim();

  // 1. Approve-filtered corpus check
  let approvedDocs: readonly { path: string; status: string }[];
  try {
    approvedDocs = await listApprovedKnowledge(knowledgeRoot);
  } catch {
    throw new CareSkillToolError('CORPUS_UNAVAILABLE', `Knowledge corpus unavailable at ${knowledgeRoot}`);
  }

  const approvedFaq = approvedDocs.find(
    (doc) => doc.path === 'customer-care/faq.md' && doc.status === 'approved',
  );

  if (!approvedFaq) {
    throw new CareSkillToolError(
      'CORPUS_UNAVAILABLE',
      'No approved customer-care/faq.md document found in second-brain corpus',
    );
  }

  // 2. Read and parse approved FAQ
  let rawContent: string;
  try {
    rawContent = await readFile(join(knowledgeRoot, approvedFaq.path), 'utf8');
  } catch {
    throw new CareSkillToolError('CORPUS_UNAVAILABLE', `Could not read approved FAQ file at ${approvedFaq.path}`);
  }

  const corpus = parseFaqMarkdown(rawContent, approvedFaq.path);
  const source_version = createHash('sha256').update(rawContent).digest('hex');
  if (corpus.entries.length === 0) {
    throw new CareSkillToolError('CORPUS_UNAVAILABLE', 'Approved FAQ file contains no parseable entries');
  }

  // 3. Deterministic search
  const tokens = query_text
    .split(/[\s,?.!;:()\[\]{}"']+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const scored = corpus.entries.map((faq) => ({
    faq,
    score: scoreFaqMatch(faq, tokens, query_text),
  }));

  const matching = scored
    .filter((item) => item.score > 0.25)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.faq.faq_id.localeCompare(b.faq.faq_id);
    });

  if (matching.length === 0) {
    return {
      answers: [],
      match_confidence: 0,
      source_version,
    } as TOutput;
  }

  const rawTopK = input['top_k'];
  const topK = typeof rawTopK === 'number' && Number.isInteger(rawTopK) && rawTopK > 0 ? rawTopK : 5;
  const topMatches = matching.slice(0, topK);
  const highestConfidence = Number(topMatches[0]!.score.toFixed(2));

  return {
    answers: topMatches.map((m) => m.faq),
    match_confidence: highestConfidence,
    source_version,
  } as TOutput;
}
