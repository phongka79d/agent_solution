import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The 21 canonical second-brain documents across the 8 enterprise folders.
 * Paths are POSIX-relative to the knowledge root and are the only readable set.
 */
const CANONICAL_DOCUMENT_PATHS = [
  'company/company.md',
  'company/positioning.md',
  'customer/customer.md',
  'customer/segmentation.md',
  'product/products.md',
  'product/pricing.md',
  'product/promotion-policy.md',
  'brand/voice.md',
  'brand/terminology.md',
  'brand/prohibited-claims.md',
  'marketing/playbook.md',
  'marketing/content-guidelines.md',
  'marketing/campaign-rules.md',
  'sales/sales-playbook.md',
  'sales/qualification.md',
  'sales/objection-handling.md',
  'customer-care/faq.md',
  'customer-care/support-policy.md',
  'customer-care/escalation.md',
  'policy/authority.md',
  'policy/approval.md',
];

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const STATUS_PATTERN = /^status:[ \t]*(\S.*?)[ \t]*$/m;

/**
 * Loads knowledge documents that are safe to ingest: only documents whose
 * frontmatter declares `status: approved` are returned, so a placeholder or draft
 * can never become agent knowledge by accident.
 *
 * @param rootDir - Root directory of the canonical knowledge folders.
 * @returns The approved documents with their POSIX-relative path and status.
 * @throws Error When a canonical document is missing or unreadable.
 */
export async function loadApprovedDocuments(
  rootDir: string,
): Promise<readonly { path: string; status: string }[]> {
  const approved: { path: string; status: string }[] = [];

  for (const relativePath of CANONICAL_DOCUMENT_PATHS) {
    const source = await readFile(join(rootDir, relativePath), 'utf8');
    const frontmatter = FRONTMATTER_PATTERN.exec(source);
    const statusLine = frontmatter === null ? null : STATUS_PATTERN.exec(frontmatter[1] ?? '');

    if (statusLine?.[1] === 'approved') {
      approved.push({ path: relativePath, status: 'approved' });
    }
  }

  return approved;
}
