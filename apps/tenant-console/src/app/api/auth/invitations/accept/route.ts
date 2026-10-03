import { apiV1Url, fetchJson } from '../../../../../lib/auth/demo-provider';
import { isAuthEnabled, jsonResponse, mutationGuard } from '../../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

const MINIMUM_PASSWORD_LENGTH = 12;
const MAXIMUM_PASSWORD_LENGTH = 512;
const MAXIMUM_TOKEN_LENGTH = 512;
const MAXIMUM_DISPLAY_NAME_LENGTH = 200;

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * Public invitation redemption (T9.3). The accept page is reachable before sign-in, so this route
 * carries no session: it forwards the token, chosen password, and optional display name to the API.
 * A refused token is reported as one `INVITATION_INVALID`, telling the page nothing about the
 * address behind it.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthEnabled()) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
  const guard = mutationGuard(request);
  if (guard) return guard;

  const body = await readJson(request);
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  const password = typeof record.password === 'string' ? record.password : '';
  const rawDisplayName = record['display_name'];
  if (
    token.length === 0 ||
    token.length > MAXIMUM_TOKEN_LENGTH ||
    password.length < MINIMUM_PASSWORD_LENGTH ||
    password.length > MAXIMUM_PASSWORD_LENGTH ||
    (rawDisplayName !== undefined &&
      (typeof rawDisplayName !== 'string' || rawDisplayName.trim().length > MAXIMUM_DISPLAY_NAME_LENGTH))
  ) {
    return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
  }
  const display_name = typeof rawDisplayName === 'string' && rawDisplayName.trim().length > 0
    ? rawDisplayName.trim()
    : undefined;

  let response: Response;
  try {
    ({ response } = await fetchJson(fetch, apiV1Url('/auth/invitations/accept'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        password,
        ...(display_name === undefined ? {} : { display_name }),
      }),
    }));
  } catch {
    return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  }
  if (response.status === 422) return jsonResponse({ error: 'INVITATION_INVALID' }, 422);
  if (!response.ok) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  return jsonResponse({ accepted: true }, 200);
}
