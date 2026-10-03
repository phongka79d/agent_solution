import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { scanLiveArtifacts } from './scan-artifacts.mjs';
import { parseEnvFile } from './preflight.mjs';

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentos-live-scan-'));
  temporaryDirectories.push(root);
  const envFile = join(root, 'live.env');
  const artifactsDir = join(root, 'artifacts');
  await mkdir(artifactsDir);
  await writeFile(envFile, [
    'DATABASE_URL=postgresql://agent:db-secret-value@127.0.0.1/agentos_live_test',
    'OPENAI_API_KEY=provider-secret-value',
    'APP_ENV=local',
  ].join('\n'));
  return { root, envFile, artifactsDir };
}

describe('live artifact secret scan', () => {
  it('scans nested artifacts and passes when no configured secrets are present', async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.artifactsDir, 'nested'));
    await writeFile(join(fixture.artifactsDir, 'nested', 'report.txt'), 'redacted test report');

    assert.deepEqual(await scanLiveArtifacts(fixture), { filesScanned: 1 });
  });

  it('fails on a secret hit without including the secret value in the error', async () => {
    const fixture = await makeFixture();
    const secret = 'provider-secret-value';
    await writeFile(join(fixture.artifactsDir, 'trace.txt'), `provider response: ${secret}`);

    await assert.rejects(scanLiveArtifacts(fixture), (error) => {
      assert.match(error.message, /trace\.txt/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  });

  it('detects encoded sensitive values using the shared redaction rules', async () => {
    const fixture = await makeFixture();
    const envFile = await readFile(fixture.envFile, 'utf8');
    const databaseUrl = parseEnvFile(envFile).DATABASE_URL;
    await writeFile(join(fixture.artifactsDir, 'encoded.txt'), encodeURIComponent(databaseUrl));

    await assert.rejects(scanLiveArtifacts(fixture), /encoded\.txt/);
  });

  it('requires at least one scannable secret value from the env file', async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.envFile, 'APP_ENV=local\nDEMO_MODE=true\n');
    await assert.rejects(scanLiveArtifacts(fixture), /no scannable secret values/);
  });
});
