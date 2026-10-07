import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const UI_API_PORT = 3199;
export const UI_API_BASE_URL = `http://127.0.0.1:${UI_API_PORT}`;

export const DEMO_ACCOUNTS = {
  company: {
    email: 'company.admin@example.test',
    password: 'company-password-123',
  },
  platform: {
    email: 'platform.admin@example.test',
    password: 'platform-password-123',
  },
} as const;

const DEMO_TENANT_ID = '99999999-9999-4999-8999-999999999999';

type Audience = keyof typeof DEMO_ACCOUNTS;
type Session = {
  readonly token: string;
  readonly audience: Audience;
  readonly expires_at: string;
  readonly identity: {
    readonly user_id: string;
    readonly email: string;
    readonly display_name: string;
  };
  readonly membership: {
    readonly tenant_id: string;
    readonly tenant_name: string | null;
    readonly role: string;
    readonly scope: Audience;
  };
  readonly permissions: readonly string[];
};

const sessions = new Map<string, Session>();

const COMPANY_PERMISSIONS = [
  'campaign:draft',
  'conversation:takeover',
  'customer:read',
  'run:read',
  'telemetry:read',
  'approval:read',
  'approval:decide',
] as const;
const PLATFORM_PERMISSIONS = [
  'platform:admin',
  'run:read',
  'run:retry',
  'run:reconcile',
  'telemetry:read',
] as const;


function sessionFor(audience: Audience, token: string, email: string): Session {
  const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return audience === 'company'
    ? {
        token,
        audience,
        expires_at,
        identity: { user_id: 'demo-company-admin', email, display_name: 'Company Admin' },
        membership: { tenant_id: DEMO_TENANT_ID, tenant_name: 'Demo company', role: 'company_admin', scope: audience },
        permissions: COMPANY_PERMISSIONS,
      }
    : {
        token,
        audience,
        expires_at,
        identity: { user_id: 'demo-platform-admin', email, display_name: 'Platform Admin' },
        membership: { tenant_id: DEMO_TENANT_ID, tenant_name: 'Demo company', role: 'platform_admin', scope: audience },
        permissions: PLATFORM_PERMISSIONS,
      };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function tokenFrom(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
}

function sessionFrom(request: IncomingMessage, audience?: Audience): Session | undefined {
  const token = tokenFrom(request);
  const session = token === undefined ? undefined : sessions.get(token);
  return session !== undefined && (audience === undefined || session.audience === audience) ? session : undefined;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const companyOverview = {
  metrics: { runs: 12, completed_runs: 9, revenue: 4200 },
  attention: [],
  agents: [
    { domain: 'marketing', status: 'ACTIVE', enabled: true, readiness: 'READY', runs_today: 4 },
    { domain: 'sales', status: 'ACTIVE', enabled: true, readiness: 'READY', runs_today: 3 },
    { domain: 'care', status: 'ACTIVE', enabled: true, readiness: 'READY', runs_today: 5 },
  ],
  activity: [],
};

const platformTenant = {
  tenant_id: DEMO_TENANT_ID,
  display_name: 'Demo company',
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00.000Z',
  enabled_modules: ['marketing', 'sales', 'care'],
};

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', UI_API_BASE_URL);
  if (request.method === 'POST' && url.pathname === '/api/v1/demo/login') {
    const body = await requestBody(request);
    const audience = body.audience === 'company' || body.audience === 'platform' ? body.audience : undefined;
    const account = audience === undefined ? undefined : DEMO_ACCOUNTS[audience];
    if (audience === undefined || account === undefined || body.email !== account.email || body.password !== account.password) {
      json(response, 401, { error: 'AUTHENTICATION_FAILED' });
      return;
    }
    const token = randomBytes(32).toString('base64url');
    const session = sessionFor(audience, token, account.email);
    sessions.set(token, session);
    json(response, 200, { access_token: token, ...session });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/demo/session') {
    const session = sessionFrom(request);
    if (session === undefined) {
      json(response, 401, { error: 'AUTHENTICATION_FAILED' });
      return;
    }
    const { token: _token, ...withoutToken } = session;
    json(response, 200, withoutToken);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/demo/logout') {
    const token = tokenFrom(request);
    json(response, 200, { revoked: token === undefined ? false : sessions.delete(token) });
    return;
  }

  const companySession = sessionFrom(request, 'company');
  if (request.method === 'GET' && companySession !== undefined) {
    if (url.pathname === '/api/v1/company/overview') {
      json(response, 200, companyOverview);
      return;
    }
    if (url.pathname === '/api/v1/company/attention') {
      json(response, 200, { items: companyOverview.attention });
      return;
    }
    if (url.pathname === '/api/v1/company/ai-team') {
      json(response, 200, { agents: companyOverview.agents });
      return;
    }
    if (url.pathname === '/api/v1/company/activity') {
      json(response, 200, { items: companyOverview.activity, next_cursor: null });
      return;
    }
  }

  const platformSession = sessionFrom(request, 'platform');
  if (request.method === 'GET' && platformSession !== undefined) {
    if (url.pathname === '/api/v1/platform/tenants') {
      json(response, 200, { items: [platformTenant] });
      return;
    }
    if (url.pathname === `/api/v1/platform/tenants/${DEMO_TENANT_ID}/readiness`) {
      json(response, 200, {
        tenant_id: DEMO_TENANT_ID,
        capability_count: 3,
        capability_statuses: { marketing: 'READY', sales: 'READY', care: 'READY' },
        connector_count: 0,
        connector_statuses: {},
        owner_input_count: 0,
        owner_input_statuses: {},
        workspace_status: 'READY',
        residency_status: 'READY',
      });
      return;
    }
    if (url.pathname === '/api/v1/platform/usage') {
      json(response, 200, {
        items: [{ tenant_id: DEMO_TENANT_ID, runs_count: 12, token_cost_records_count: 0, estimated_cost_total: '0', input_tokens_total: 0, output_tokens_total: 0, cached_tokens_total: 0 }],
      });
      return;
    }
    if (url.pathname === '/api/v1/platform/providers') {
      json(response, 200, { items: [{ provider: 'demo', configured: true, mode: 'DEMO_MOCK' }] });
      return;
    }
  }

  json(response, sessionFrom(request) === undefined ? 401 : 404, { error: 'NOT_FOUND' });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await mkdir(resolve('test-results/ui'), { recursive: true });
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => json(response, 500, { error: 'STUB_FAILURE' }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(UI_API_PORT, '127.0.0.1', () => resolveListen());
  });
  return async () => {
    sessions.clear();
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  };
}

