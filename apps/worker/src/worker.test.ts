import { describe, expect, it } from 'vitest';

import { DEPENDENCIES, startWorker } from './worker.js';

describe('startWorker', () => {
  it('starts with the allowed workspace packages and closes immediately', async () => {
    const worker = startWorker();

    expect(worker.dependencies).toEqual([...DEPENDENCIES]);
    expect(worker.dependencies).toEqual([
      '@agentos/core-engine',
      '@agentos/skills',
      '@agentos/adapters',
      '@agentos/database',
    ]);

    await expect(worker.close()).resolves.toBeUndefined();
  });
});
