import type { SkillToolInvocation } from '@agentos/skills';

import type { AvailableKnowledgeDocument, KnowledgeStore } from '../../shared/knowledge-store.js';
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

/** Handles the current AVAILABLE FAQ revision without changing the tool-port contract. */
export async function handleFaqEngine<TOutput>(
  invocation: SkillToolInvocation<unknown>,
  knowledge: Pick<KnowledgeStore, 'listAvailable'>,
): Promise<TOutput> {
  const input = (invocation.input ?? {}) as Record<string, unknown>;
  const tenant_id = input['tenant_id'];
  if (typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
    throw new CareSkillToolError('INVALID_TENANT', 'FAQ lookup requires a non-empty server-bound tenant ID');
  }
  const contextTenant = invocation.context?.tenant_id;
  if (typeof contextTenant !== 'string' || contextTenant.trim().length === 0 || tenant_id.trim() !== contextTenant.trim()) {
    throw new CareSkillToolError('TENANT_SCOPE_MISMATCH', 'FAQ lookup tenant must match the server-resolved execution tenant');
  }
  const query_text = readFaqQuery(input).toLowerCase().trim();

  let availableDocs: readonly AvailableKnowledgeDocument[];
  try {
    availableDocs = await knowledge.listAvailable(tenant_id, 'customer-care');
  } catch {
    throw new CareSkillToolError('CORPUS_UNAVAILABLE', 'Available customer-care knowledge is unavailable');
  }
  if (availableDocs.length === 0) {
    throw new CareSkillToolError('CORPUS_UNAVAILABLE', 'No available customer-care FAQ document found');
  }
  const faqDocuments = availableDocs
    .map((document) => ({
      document,
      entries: parseFaqMarkdown(document.body, `${document.namespace}/${document.slug}`).entries,
    }))
    .filter(({ entries }) => entries.length > 0);
  if (faqDocuments.length === 0) {
    throw new CareSkillToolError('CORPUS_UNAVAILABLE', 'Available FAQ document contains no parseable entries');
  }

  const tokens = query_text
    .split(/[\s,?.!;:()\[\]{}"']+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const scored = faqDocuments.flatMap(({ document, entries }) => entries.map((faq) => ({
    document,
    faq,
    score: scoreFaqMatch(faq, tokens, query_text),
  })));
  const matching = scored
    .filter((item) => item.score > 0.25)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const documentOrder = a.document.document_id.localeCompare(b.document.document_id);
      if (documentOrder !== 0) return documentOrder;
      return a.faq.faq_id.localeCompare(b.faq.faq_id);
    });

  if (matching.length === 0) {
    return {
      answers: [],
      match_confidence: 0,
      source_version: faqDocuments[0]!.document.content_sha256,
    } as TOutput;
  }

  const sourceDocument = matching[0]!.document;
  const topK = Math.max(1, typeof input['top_k'] === 'number' ? input['top_k'] : 5);
  const topMatches = matching
    .filter((item) => item.document.document_id === sourceDocument.document_id)
    .slice(0, topK);
  const highestConfidence = Number(topMatches[0]!.score.toFixed(2));

  return {
    answers: topMatches.map((item) => item.faq),
    match_confidence: highestConfidence,
    source_version: sourceDocument.content_sha256,
  } as TOutput;
}
