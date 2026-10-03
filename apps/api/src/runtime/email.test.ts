import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFileEmailSender } from './email.js';

describe('createFileEmailSender', () => {
  it('refuses profiles other than local and CI', () => {
    expect(() => createFileEmailSender({ appEnv: 'production', outboxDir: '/tmp/email-outbox' }))
      .toThrow('EMAIL_TRANSPORT=file is available only when APP_ENV is local or ci');
  });

  it('writes the invitation link only to a private outbox file', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'agentos-email-outbox-'));
    const invitationUrl = 'http://localhost:3000/accept-invite?token=single-use-test-token';
    try {
      const sender = createFileEmailSender({ appEnv: 'ci', outboxDir });
      await sender.sendInvitation({
        to: 'onboarding@example.invalid',
        tenant_id: '11111111-1111-4111-8111-111111111111',
        role_bundle: 'COMPANY_ADMIN',
        scope: 'company',
        invitation_url: invitationUrl,
        expires_at: '2030-01-01T00:00:00.000Z',
      });

      const [filename] = await readdir(outboxDir);
      if (filename === undefined) throw new Error('invitation outbox file is missing');
      expect(filename).toMatch(/^invitation-[0-9a-f-]+\.json$/);
      const path = join(outboxDir, filename);
      const message = JSON.parse(await readFile(path, 'utf8'));
      expect(message).toMatchObject({ to: 'onboarding@example.invalid', invitation_url: invitationUrl });
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(outboxDir, { recursive: true, force: true });
    }
  });
});
