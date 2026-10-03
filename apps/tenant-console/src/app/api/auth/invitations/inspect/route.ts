import { apiV1Url, fetchJson } from '../../../../../lib/auth/demo-provider';
import { isAuthEnabled, jsonResponse, mutationGuard } from '../../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

const MAXIMUM_TOKEN_LENGTH = 512;

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * Inspects an invitation before the invitee chooses a password (T9.3). Public and read-only: it
 * returns the invited address and company so the page can show what is being accepted, and a single
 * `INVITATION_INVALID` for a link that is unknown, expired or already used.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthEnabled()) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
  const guard = mutationGuard(request);
  if (guard) return guard;

  const body = await readJson(request);
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (token.length === 0 || token.length > MAXIMUM_TOKEN_LENGTH) {
    return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
  }

  let response: Response;
  let payload: unknown;
  try {
    ({ response, payload } = await fetchJson(fetch, apiV1Url('/auth/invitations/inspect'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }));
  } catch {
    return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  }
  if (response.status === 422) return jsonResponse({ error: 'INVITATION_INVALID' }, 422);
  if (!response.ok) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  return jsonResponse(payload, 200);
}
