/**
 * @file Invitation redemption from the tenant console (T9.3, workflow §4).
 *
 * The accept page is the one company-console surface reachable before sign-in: it carries a
 * single-use token in its URL, inspects it to render the invitation, and lets the invitee choose a
 * password. Accepting activates the membership; the invitee then signs in normally. A token that is
 * unknown, expired or already consumed is refused with one `INVITATION_INVALID` response, so the
 * endpoint reveals nothing about whether an address has an account.
 */
import type { FastifyInstance } from 'fastify';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime, InvitationAcceptPort } from '../../gateway/ports.js';
import { MINIMUM_AUTH_PASSWORD_LENGTH } from '../../runtime/db-auth.js';

export interface InvitationRoutesDependencies {
  readonly invitationAccept: InvitationAcceptPort;
  readonly runtime: GatewayRuntime;
}

const MAXIMUM_DISPLAY_NAME_LENGTH = 200;

const MAXIMUM_TOKEN_LENGTH = 512;
const MAXIMUM_PASSWORD_LENGTH = 512;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseToken(body: unknown): string {
  if (!isPlainRecord(body)) fail('VALIDATION_FAILED', 'an invitation token is required');
  const token = body['token'];
  if (typeof token !== 'string' || token.trim().length === 0 || token.length > MAXIMUM_TOKEN_LENGTH) {
    fail('VALIDATION_FAILED', 'an invitation token is required');
  }
  return token.trim();
}

function parseAcceptBody(body: unknown): { readonly token: string; readonly password: string; readonly display_name?: string } {
  const token = parseToken(body);
  const password = isPlainRecord(body) ? body['password'] : undefined;
  const rawDisplayName = isPlainRecord(body) ? body['display_name'] : undefined;
  if (
    typeof password !== 'string' ||
    password.length < MINIMUM_AUTH_PASSWORD_LENGTH ||
    password.length > MAXIMUM_PASSWORD_LENGTH
  ) {
    fail('VALIDATION_FAILED', 'a password of at least the minimum length is required');
  }
  if (
    rawDisplayName !== undefined &&
    (typeof rawDisplayName !== 'string' || rawDisplayName.trim().length > MAXIMUM_DISPLAY_NAME_LENGTH)
  ) {
    fail('VALIDATION_FAILED', 'display_name must be a string no longer than 200 characters');
  }
  const display_name = typeof rawDisplayName === 'string' && rawDisplayName.trim().length > 0
    ? rawDisplayName.trim()
    : undefined;
  return { token, password, ...(display_name === undefined ? {} : { display_name }) };
}

/** Registers the public invitation inspect/accept routes. */
export function registerInvitationRoutes(app: FastifyInstance, deps: InvitationRoutesDependencies): void {
  app.post('/auth/invitations/inspect', async (request, reply) => {
    try {
      const token = parseToken(request.body);
      const invitation = await deps.invitationAccept.inspect(token);
      if (invitation === null) fail('INVITATION_INVALID', 'the invitation is no longer valid');
      return reply.code(200).send(invitation);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.post('/auth/invitations/accept', async (request, reply) => {
    try {
      const { token, password, display_name } = parseAcceptBody(request.body);
      const accepted = await deps.invitationAccept.accept({
        token,
        password,
        ...(display_name === undefined ? {} : { display_name }),
      });
      if (accepted === null) fail('INVITATION_INVALID', 'the invitation is no longer valid');
      return reply.code(200).send({ accepted: true, tenant_id: accepted.tenant_id, scope: accepted.scope });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });
}
