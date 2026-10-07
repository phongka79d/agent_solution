import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadApprovedDocuments } from './loader.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const novamartDemoRoot = fileURLToPath(new URL('../demo/novamart', import.meta.url));

const EXPECTED_CANONICAL_PATHS = [
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
] as const;

describe('loadApprovedDocuments', () => {
  it('excludes the draft documents that ship with the package', async () => {
    await expect(loadApprovedDocuments(packageRoot)).resolves.toEqual([]);
  });

  it('returns only documents whose frontmatter status is approved', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'second-brain-'));

    try {
      await cp(packageRoot, sandbox, {
        recursive: true,
        filter: (source) => !/(?:^|[\\/])(?:node_modules|dist)(?:[\\/]|$)/.test(source),
      });

      await writeFile(
        join(sandbox, 'company', 'company.md'),
        '---\nstatus: approved\n---\n\n# company\n\nApproved fixture.\n',
        'utf8',
      );

      await expect(loadApprovedDocuments(sandbox)).resolves.toEqual([
        { path: 'company/company.md', status: 'approved' },
      ]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  describe('NovaMart approved corpus preflight', () => {
    it('loads all 21 canonical NovaMart relative paths with status approved and synthetic provenance', async () => {
      const approved = await loadApprovedDocuments(novamartDemoRoot);

      expect(approved).toHaveLength(21);
      expect(approved).toEqual(
        EXPECTED_CANONICAL_PATHS.map((path) => ({
          path,
          status: 'approved',
        })),
      );

      for (const relativePath of EXPECTED_CANONICAL_PATHS) {
        const raw = await readFile(join(novamartDemoRoot, relativePath), 'utf8');
        expect(raw).toMatch(/^---\r?\n[\s\S]*?\r?\n---/);
        expect(raw).toContain('status: approved');
        expect(raw).toContain('owner: novamart-demo-operator');
        expect(raw).toContain('source_version: novamart-demo-v1');
        expect(raw).toContain('approved_at: 2026-09-28T00:00:00Z');
        expect(raw).toContain('tenant_id: 99999999-9999-4999-8999-999999999999');
        expect(raw).toContain('synthetic: true');
      }
    });

    it('verifies customer-care/faq.md contains exact FAQ-1 heading and deterministic SHA-256 source hash', async () => {
      const faqPath = join(novamartDemoRoot, 'customer-care', 'faq.md');
      const faqSource = await readFile(faqPath, 'utf8');
      const faqSha256 = createHash('sha256').update(faqSource, 'utf8').digest('hex');

      expect(faqSource).toContain('## FAQ-1: What is your return policy?');
      expect(faqSource).toContain('14-day unopened return policy');
      expect(faqSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(createHash('sha256').update(await readFile(faqPath, 'utf8'), 'utf8').digest('hex')).toBe(
        faqSha256,
      );
    });

    it('excludes tampered draft documents in a temporary copy while keeping the default package root draft-only', async () => {
      await expect(loadApprovedDocuments(packageRoot)).resolves.toEqual([]);

      const sandbox = await mkdtemp(join(tmpdir(), 'novamart-preflight-'));
      try {
        await cp(novamartDemoRoot, sandbox, { recursive: true });
        const tamperedFaqPath = join(sandbox, 'customer-care', 'faq.md');
        const originalFaq = await readFile(tamperedFaqPath, 'utf8');
        await writeFile(
          tamperedFaqPath,
          originalFaq.replace('status: approved', 'status: draft'),
          'utf8',
        );

        const loaded = await loadApprovedDocuments(sandbox);
        expect(loaded).toHaveLength(20);
        expect(loaded.some((doc) => doc.path === 'customer-care/faq.md')).toBe(false);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    });
  });
});
