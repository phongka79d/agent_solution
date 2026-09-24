import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTenantContext } from '@agentos/database';
import { ErpRefusalError } from '@agentos/adapters';
import { listApprovedKnowledge } from '@agentos/core-engine';
import type { SkillToolInvocation, SkillToolPort } from '@agentos/skills';

import type { CareSkillOptions, VerifiedCustomerIdentity } from './types.js';

const ASSIGNABLE_AUTHORITIES: Readonly<Record<string, true>> = Object.freeze({
  'AUTH-0': true,
  'AUTH-1': true,
  'AUTH-2': true,
  'AUTH-3': true,
});

async function defaultFindVerifiedIdentity(
  tenantId: string,
  id: string,
): Promise<VerifiedCustomerIdentity | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, customer_id, verified_at FROM agentos.customer_identities
        WHERE tenant_id = $1 AND id = $2 AND verified_at IS NOT NULL`,
      [tenantId, id],
    );
    const row = result.rows[0] as VerifiedCustomerIdentity | undefined;
    return row ?? null;
  });
}

/** Canonical error thrown by the Care skill tool port. */
export class CareSkillToolError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CareSkillToolError';
    this.code = code;
  }
}

/**
 * Whether a failed connector read is a *confirmed* provider rejection (`PROVIDER_REJECTED`), which
 * is the only connector outcome that may be reported to a customer as "no such order". Every other
 * refusal — an indeterminate transport outcome, a missing authority, a resource the connector does
 * not carry — says nothing about whether the order exists.
 */
function isConfirmedProviderRejection(error: unknown): boolean {
  return (
    error instanceof ErpRefusalError && error.refusal_code === 'PROVIDER_REJECTED'
  );
}

interface FaqEntry {
  readonly faq_id: string;
  readonly question: string;
  readonly approved_answer: string;
  readonly source_file: string;
}

interface ParsedFaqCorpus {
  readonly entries: readonly FaqEntry[];
}

/** Parses markdown FAQs into structured Q&A records. */
function parseFaqMarkdown(content: string, source_file: string): ParsedFaqCorpus {
  // Strip frontmatter if present
  const body = content.replace(/^---[\s\S]*?---\r?\n/, '');
  const entries: FaqEntry[] = [];

  // Match headers: ## FAQ-1: Question or ### Question or Question / Answer blocks
  const sections = body.split(/(?=^#{1,4}\s+)/m);
  let idCounter = 1;

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length === 0) continue;

    const lines = trimmed.split(/\r?\n/);
    const headerLine = lines[0] ?? '';
    const headerMatch = /^#{1,4}\s+(?:([A-Za-z0-9_-]+):\s*)?(.*)$/.exec(headerLine);
    if (!headerMatch) continue;

    let faq_id = headerMatch[1]?.trim() || `faq-${idCounter++}`;
    let question = headerMatch[2]?.trim() || '';
    const remainingText = lines.slice(1).join('\n').trim();

    // Check if remaining text has explicit Q: / A:
    const qaMatch = /^\*\*?Q(?:uestion)?:\*\*?\s*(.*?)\r?\n\*\*?A(?:nswer)?:\*\*?\s*([\s\S]*)$/i.exec(remainingText);
    let approved_answer = remainingText;

    if (qaMatch) {
      if (qaMatch[1] && qaMatch[1].trim().length > 0) {
        question = qaMatch[1].trim();
      }
      approved_answer = (qaMatch[2] ?? '').trim();
    } else {
      // Remove any leading "A:" or "**Answer:**"
      approved_answer = approved_answer.replace(/^\*\*?A(?:nswer)?:\*\*?\s*/i, '').trim();
    }

    if (question.length > 0 && approved_answer.length > 0) {
      entries.push({
        faq_id,
        question,
        approved_answer,
        source_file,
      });
    }
  }

  return { entries };
}

/** Deterministic token-overlap scoring for query matching. */
function scoreFaqMatch(entry: FaqEntry, queryTokens: readonly string[], queryText: string): number {
  const qLower = entry.question.toLowerCase();
  const aLower = entry.approved_answer.toLowerCase();

  // Full phrase match in question gives maximum confidence
  if (qLower.includes(queryText)) {
    return 1.0;
  }

  // Count token matches
  let qMatches = 0;
  let aMatches = 0;
  for (const token of queryTokens) {
    if (qLower.includes(token)) qMatches++;
    else if (aLower.includes(token)) aMatches++;
  }

  if (queryTokens.length === 0) return 0;

  const qScore = qMatches / queryTokens.length;
  const aScore = (aMatches / queryTokens.length) * 0.4;
  const total = Math.min(1.0, qScore + aScore);

  return total;
}

/**
 * Creates the unified SkillToolPort for Customer Care.
 * Handles SecondBrain.FAQEngine and API-001.OrderConnector.
 */
export function createCareSkillToolPort(options: CareSkillOptions): SkillToolPort {
  const defaultKnowledgeRoot = fileURLToPath(new URL('../../../../../../packages/second-brain', import.meta.url));
  const knowledgeRoot = (options.env.CARE_KNOWLEDGE_ROOT?.trim() || defaultKnowledgeRoot);

  return {
    async invoke<TInput, TOutput>(invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
      if (!invocation.context || !Object.hasOwn(ASSIGNABLE_AUTHORITIES, invocation.context.granted_authority)) {
        throw new CareSkillToolError(
          'INVALID_CLEARANCE',
          `granted_authority '${invocation.context?.granted_authority}' is not an assignable authority; verdict-only values must be refused`,
        );
      }

      const binding = invocation.tool_binding;
      if (binding === 'SecondBrain.FAQEngine') {
        const input = invocation.input as { tenant_id?: string; query_text?: string; top_k?: number } | undefined;
        const query_text = (input?.query_text ?? '').toLowerCase().trim();

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
          } as TOutput;
        }

        const topK = Math.max(1, input?.top_k ?? 5);
        const topMatches = matching.slice(0, topK);
        const highestConfidence = Number(topMatches[0]!.score.toFixed(2));

        return {
          answers: topMatches.map((m) => m.faq),
          match_confidence: highestConfidence,
        } as TOutput;
      }

      if (binding === 'API-001.OrderConnector') {
        if (!options.erp_read) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'API-001 connector is not bound; declared refusal',
          );
        }

        const input = invocation.input as {
          readonly tenant_id: string;
          readonly order_identifier: string;
          readonly customer_id: string;
          readonly verification_reference: string;
          readonly verification_status: string;
        };

        // 1. Server-side verification FIRST (ZERO connector calls made if this fails)
        if (input.verification_status !== 'VERIFIED') {
          throw new CareSkillToolError(
            'IDENTITY_UNVERIFIED',
            'verification_status must be VERIFIED for order lookup',
          );
        }

        const identityResolver = options.find_verified_identity ?? defaultFindVerifiedIdentity;

        const identity = await identityResolver(input.tenant_id, input.verification_reference);
        if (
          !identity ||
          identity.verified_at === null ||
          identity.verified_at === undefined ||
          identity.customer_id !== input.customer_id
        ) {
          throw new CareSkillToolError(
            'IDENTITY_UNVERIFIED',
            'verification_reference does not resolve server-side to a verified identity matching customer_id',
          );
        }

        // 2. Connector read. A transport failure is NOT an authoritative absence: only a provider
        // that answered and rejected the key may be reported as `ORDER_NOT_FOUND`, because the
        // platform must never tell a customer an order does not exist on the strength of a call
        // that never completed (implement/06 §8, NFR-004).
        let readResult;
        try {
          readResult = await options.erp_read.read({
            tenant_id: input.tenant_id,
            resource: 'orders',
            key: input.order_identifier,
          });
        } catch (error) {
          if (isConfirmedProviderRejection(error)) {
            throw new CareSkillToolError(
              'ORDER_NOT_FOUND',
              `ORDER_NOT_FOUND: order ${input.order_identifier} not found in system of record`,
            );
          }

          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            `the order lookup for ${input.order_identifier} produced no confirmed outcome (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        }

        const order = readResult.value;
        if (!order || typeof order !== 'object') {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'Provider response did not contain an order object',
          );
        }

        // 3. Owner match (no existence disclosure on mismatch)
        if (order.customer_id !== input.customer_id) {
          throw new CareSkillToolError(
            'ORDER_NOT_FOUND',
            `ORDER_OWNER_MISMATCH: order ${input.order_identifier} not found for customer (no existence disclosure)`,
          );
        }

        // 4. Closed documented mapping to skill output DTO (no synthesized values)
        const order_id = typeof order.order_id === 'string' && order.order_id.trim().length > 0
          ? order.order_id.trim()
          : null;
        if (!order_id) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'Provider order missing authoritative order_id',
          );
        }

        const rawStatus = (order.fulfillment_status ?? order.status);
        const statusStr = typeof rawStatus === 'string' ? rawStatus.toUpperCase().trim() : '';
        let status: 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED' | null = null;
        if (statusStr === 'SHIPPED' || statusStr === 'FULFILLED') status = 'SHIPPED';
        else if (statusStr === 'DELIVERED' || statusStr === 'PAID') status = 'DELIVERED';
        else if (statusStr === 'PENDING') status = 'PENDING';
        else if (statusStr === 'PROCESSING') status = 'PROCESSING';
        else if (statusStr === 'CANCELLED' || statusStr === 'CANCELED') status = 'CANCELLED';
        else if (statusStr === 'RETURNED') status = 'RETURNED';

        if (!status) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            `Unmappable provider order status: ${String(rawStatus)}`,
          );
        }

        let line_items: Array<{
          sku_id: string;
          product_name: string;
          quantity: number;
          unit_price: number;
          currency: string;
        }>;

        if (Array.isArray(order.line_items) && order.line_items.length > 0) {
          line_items = order.line_items.map((item, idx) => {
            if (
              typeof item?.sku_id !== 'string' ||
              typeof item?.product_name !== 'string' ||
              typeof item?.quantity !== 'number' ||
              !Number.isInteger(item.quantity) ||
              typeof item?.unit_price !== 'number' ||
              typeof item?.currency !== 'string'
            ) {
              throw new CareSkillToolError(
                'AUTHORITATIVE_SOURCE_UNAVAILABLE',
                `Line item at index ${idx} missing required fields or has invalid types`,
              );
            }
            return {
              sku_id: item.sku_id,
              product_name: item.product_name,
              quantity: item.quantity,
              unit_price: item.unit_price,
              currency: item.currency,
            };
          });
        } else if (
          typeof order.sku_id === 'string' &&
          typeof order.product_name === 'string' &&
          typeof order.quantity === 'number' &&
          Number.isInteger(order.quantity) &&
          typeof order.unit_price === 'number' &&
          typeof order.currency === 'string'
        ) {
          line_items = [
            {
              sku_id: order.sku_id,
              product_name: order.product_name,
              quantity: order.quantity,
              unit_price: order.unit_price,
              currency: order.currency,
            },
          ];
        } else {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'Provider order missing mappable line items',
          );
        }

        const total_price = typeof order.total_price === 'number'
          ? order.total_price
          : (typeof order.total_amount === 'number' ? order.total_amount : null);
        if (total_price === null) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'Provider order missing authoritative total price',
          );
        }

        const currency = typeof order.currency === 'string' && order.currency.trim().length > 0
          ? order.currency.trim()
          : null;
        if (!currency) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'Provider order missing currency',
          );
        }

        const tracking_number = typeof order.tracking_number === 'string' && order.tracking_number.trim().length > 0
          ? order.tracking_number.trim()
          : null;

        const rawDate = typeof order.order_date === 'string'
          ? order.order_date
          : (typeof order.created_at === 'string' ? order.created_at : null);
        if (!rawDate || isNaN(Date.parse(rawDate))) {
          throw new CareSkillToolError(
            'AUTHORITATIVE_SOURCE_UNAVAILABLE',
            'Provider order missing or invalid order_date timestamp',
          );
        }
        const order_date = rawDate;

        return {
          order_id,
          status,
          line_items,
          total_price,
          currency,
          tracking_number,
          order_date,
        } as TOutput;
      }

      throw new CareSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        `No tool port binding exists for ${binding}`,
      );
    },
  };
}
