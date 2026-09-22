import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadApprovedDocuments } from './loader.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

describe('loadApprovedDocuments', () => {
  it('excludes the draft documents that ship with the package', async () => {
    await expect(loadApprovedDocuments(packageRoot)).resolves.toEqual([]);
  });

  it('returns only documents whose frontmatter status is approved', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'second-brain-'));

    try {
      await cp(packageRoot, sandbox, {
        recursive: true,
        filter: (source) => !/(?:node_modules|dist)[\\/]/.test(source),
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
});
