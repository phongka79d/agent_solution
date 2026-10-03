import { apiUrl } from '../../../../../lib/auth/demo-provider';
import { authGateResponse } from '../../../../../lib/auth/selection';
import { jsonResponse, mutationProtection } from '../../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

const MINIMUM_PASSWORD_LENGTH = 12;
const MAXIMUM_PASSWORD_LENGTH = 512;
const MAXIMUM_TOKEN_LENGTH = 512;
const MAXIMUM_DISPLAY_NAME_LENGTH = 200;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Public redemption of a platform administrator invitation. */
export async function POST(request: Request): Promise<Response> {
  const gate = authGateResponse();
  if (gate) return gate;
  const guard = mutationProtection(request);
  if (guard) return guard;

  const body = await readJson(request);
  const token = isPlainRecord(body) && typeof body['token'] === 'string' ? body['token'].trim() : '';
  const password = isPlainRecord(body) && typeof body['password'] === 'string' ? body['password'] : '';
  const rawDisplayName = isPlainRecord(body) ? body['display_name'] : undefined;
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

  const displayName = typeof rawDisplayName === 'string' && rawDisplayName.trim().length > 0
    ? rawDisplayName.trim()
    : undefined;
  const target = apiUrl('/auth/invitations/accept');
  if (!target) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);

  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        password,
        ...(displayName === undefined ? {} : { display_name: displayName }),
      }),
    });
  } catch {
    return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  }
  if (response.status === 422) return jsonResponse({ error: 'INVITATION_INVALID' }, 422);
  if (!response.ok) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  return jsonResponse({ accepted: true }, 200);
}
