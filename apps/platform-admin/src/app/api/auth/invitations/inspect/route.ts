import { apiUrl } from '../../../../../lib/auth/demo-provider';
import { authGateResponse } from '../../../../../lib/auth/selection';
import { jsonResponse, mutationProtection } from '../../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

const MAXIMUM_TOKEN_LENGTH = 512;

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

/** Public invitation inspection for the platform-console accept page. */
export async function POST(request: Request): Promise<Response> {
  const gate = authGateResponse();
  if (gate) return gate;
  const guard = mutationProtection(request);
  if (guard) return guard;

  const body = await readJson(request);
  const token = isPlainRecord(body) && typeof body['token'] === 'string' ? body['token'].trim() : '';
  if (token.length === 0 || token.length > MAXIMUM_TOKEN_LENGTH) {
    return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
  }

  const target = apiUrl('/auth/invitations/inspect');
  if (!target) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);

  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    payload = await response.json();
  } catch {
    return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  }
  if (response.status === 422) return jsonResponse({ error: 'INVITATION_INVALID' }, 422);
  if (!response.ok) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 502);
  return jsonResponse(payload, 200);
}
