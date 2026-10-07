import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readCompose() {
  return readFile(join(repoRoot, 'docker-compose.yml'), 'utf8');
}

describe('docker compose invariants', () => {
  it('binds every published port to the documented loopback default', async () => {
    const compose = await readCompose();
    assert.doesNotMatch(compose, /0\.0\.0\.0/);

    const portMappings = compose
      .split('\n')
      .filter((line) => /^\s+-\s+"[^"\n]+:\d+:\d+"\s*$/.test(line));
    assert.ok(portMappings.length > 0, 'compose must publish at least one port');
    for (const mapping of portMappings) {
      assert.match(mapping, /\$\{BIND_ADDRESS:-127\.0\.0\.1\}:/);
    }
  });

  it('provides the approved knowledge root to the API service', async () => {
    const compose = await readCompose();
    const apiBlock = compose.match(/\r?\n  api:\r?\n([\s\S]*?)(?=\r?\n  worker:\r?\n)/)?.[1];
    assert.ok(apiBlock, 'api service block must be present');
    assert.match(apiBlock, /^\s+KNOWLEDGE_ROOT:\s+\$\{KNOWLEDGE_ROOT:-/m);
  });

  it('keeps browser session keys distinct per service', async () => {
    const compose = await readCompose();
    assert.match(compose, /NEXTAUTH_SECRET:\s+\$\{TENANT_NEXTAUTH_SECRET:\?TENANT_NEXTAUTH_SECRET is required\}/);
    assert.match(
      compose,
      /NEXTAUTH_SECRET:\s+\$\{PLATFORM_NEXTAUTH_SECRET:\?PLATFORM_NEXTAUTH_SECRET is required\}/,
    );
    assert.doesNotMatch(compose, /NEXTAUTH_SECRET:\s+\$\{NEXTAUTH_SECRET:/);
  });
});
