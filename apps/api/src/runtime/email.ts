/**
 * @file Local/CI outbound email transports (T9.3).
 *
 * Invitation tokens are single-use credentials. The default log-only transport records no recipient
 * or invitation URL; the explicit file transport is restricted to local/CI and writes a private
 * outbox record for deterministic integration tests.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { EmailSenderPort } from '../gateway/ports.js';

export interface LogOnlyEmailSenderOptions {
  /** Sink for the delivery line; defaults to stdout for the local/CI process. */
  readonly log?: (message: string) => void;
}

export interface FileEmailSenderOptions {
  readonly appEnv: string | undefined;
  readonly outboxDir: string;
}

/** Builds the log-only transport. It never emits a recipient or invitation URL. */
export function createLogOnlyEmailSender(options: LogOnlyEmailSenderOptions = {}): EmailSenderPort {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  return {
    async sendInvitation(input) {
      log(`invitation email queued (${input.scope ?? 'company'} scope)`);
    },
  };
}

/**
 * Writes invitation messages to a local/CI-only outbox. The raw single-use token exists only in
 * the private outbox file and is never sent to process logs.
 */
export function createFileEmailSender(options: FileEmailSenderOptions): EmailSenderPort {
  if (options.appEnv !== 'local' && options.appEnv !== 'ci') {
    throw new Error('EMAIL_TRANSPORT=file is available only when APP_ENV is local or ci');
  }
  if (options.outboxDir.trim().length === 0) {
    throw new Error('EMAIL_OUTBOX_DIR is required for the file email transport');
  }
  const outboxDir = resolve(options.outboxDir);

  return {
    async sendInvitation(input) {
      await mkdir(outboxDir, { recursive: true, mode: 0o700 });
      const payload = {
        to: input.to,
        tenant_id: input.tenant_id,
        role_bundle: input.role_bundle,
        scope: input.scope ?? 'company',
        invitation_url: input.invitation_url,
        expires_at: input.expires_at,
      };
      await writeFile(
        join(outboxDir, `invitation-${randomUUID()}.json`),
        `${JSON.stringify(payload)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    },
  };
}
