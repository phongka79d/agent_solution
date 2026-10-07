import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { signMockRequest } from '@agentos/adapters';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { DEMO_TENANT_ID, type DemoCredentialStore } from '../../runtime/demo-auth.js';
import { nodeHmacSha256Hex } from '../../runtime/adapters.js';

type DemoEnvironment = Readonly<Record<string, string | undefined>>;

interface WidgetMintDependencies {
  readonly demoAuth: DemoCredentialStore;
  readonly runtime: GatewayRuntime;
  /** Read environment at request time so a long-lived process cannot pin stale demo gating. */
  readonly env?: () => DemoEnvironment;
}

interface CatalogItem {
  readonly sku_id: string;
  readonly name: string;
  readonly brand: string;
  readonly category: string;
  readonly use_case: string;
  readonly description: string;
  readonly currency: string;
  readonly list_price: number;
  readonly is_active: true;
}

/** Customer personas that may be minted by the local/CI demo widget launcher. */
const DEMO_PERSONA_SESSIONS = Object.freeze({
  C05: 'sess-novamart-c05',
  C06: 'sess-novamart-c06',
} as const);

type DemoPersona = keyof typeof DEMO_PERSONA_SESSIONS;

function isDemoPersona(value: string): value is DemoPersona {
  return Object.hasOwn(DEMO_PERSONA_SESSIONS, value);
}

function sessionIdForPersona(persona: unknown): string {
  if (persona === undefined || persona === 'anonymous') return `demo-anon-${randomUUID()}`;
  if (typeof persona !== 'string' || !isDemoPersona(persona)) {
    fail('VALIDATION_FAILED', 'the demo persona is not supported');
  }
  return DEMO_PERSONA_SESSIONS[persona];
}

function requireDemoEnvironment(env: DemoEnvironment): void {
  if (env.DEMO_MODE !== 'true' || !['local', 'ci'].includes(env.APP_ENV ?? '')) {
    fail('CAPABILITY_NOT_ENABLED', 'the demo widget is available only in local or CI demo mode');
  }
}

function requireCanonicalDemoTenant(tenant_id: string): void {
  if (tenant_id !== DEMO_TENANT_ID) {
    fail('AUTHENTICATION_FAILED', 'the demo widget is restricted to the canonical demo tenant');
  }
}

function projectCatalogItem(value: unknown): CatalogItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const sku_id = typeof item['sku_id'] === 'string' && item['sku_id'].trim().length > 0
    ? item['sku_id'].trim()
    : (typeof item['sku'] === 'string' && item['sku'].trim().length > 0 ? item['sku'].trim() : null);
  const name = typeof item['name'] === 'string' && item['name'].trim().length > 0 ? item['name'].trim() : null;
  const currency = typeof item['currency'] === 'string' && item['currency'].trim().length > 0 ? item['currency'].trim() : null;
  const list_price = typeof item['list_price'] === 'number' && Number.isFinite(item['list_price'])
    ? item['list_price']
    : (typeof item['original_list_price'] === 'number' && Number.isFinite(item['original_list_price']) ? item['original_list_price'] : null);

  if (!sku_id || !name || !currency || list_price === null || list_price < 0 || item['is_active'] !== true) {
    return null;
  }
  const brand = typeof item['brand'] === 'string' && item['brand'].trim().length > 0 ? item['brand'].trim() : 'general';
  const category = typeof item['category'] === 'string' && item['category'].trim().length > 0 ? item['category'].trim() : 'general';
  const use_case = typeof item['use_case'] === 'string' && item['use_case'].trim().length > 0 ? item['use_case'].trim() : 'general';
  const description = typeof item['description'] === 'string' && item['description'].trim().length > 0 ? item['description'].trim() : name;

  return {
    sku_id,
    name,
    brand,
    category,
    use_case,
    description,
    currency,
    list_price,
    is_active: true,
  };
}

/** An operator may launch only a fresh anonymous session or a seeded, verified C05/C06 persona. */
export function registerDemoWidgetRoutes(app: FastifyInstance, deps: WidgetMintDependencies): void {
  app.post('/demo/widget-session', { preHandler: authenticate({ credentials: deps.demoAuth, runtime: deps.runtime }) },
    async (request, reply) => {
      try {
        const env = deps.env?.() ?? process.env;
        const principal = requireOperator(request, 'conversation:takeover');
        requireDemoEnvironment(env);
        requireCanonicalDemoTenant(principal.tenant_id);
        const allowed = (env.DEMO_WIDGET_ORIGINS ?? '').split(',').map((value) => value.trim());
        const origin = request.headers.origin;
        if (typeof origin !== 'string' || !allowed.includes(origin) || !/^https?:\/\/[^/]+$/.test(origin)) {
          fail('AUTHENTICATION_FAILED', 'this origin is not approved for the demo widget');
        }
        const body = request.body;
        if (typeof body !== 'object' || body === null || Array.isArray(body) ||
          Object.keys(body).some((key) => key !== 'persona')) {
          fail('VALIDATION_FAILED', 'only a demo persona may be selected');
        }
        const persona = 'persona' in body ? body.persona : undefined;
        const session_id = sessionIdForPersona(persona);
        const issued = deps.demoAuth.issueWidget(session_id, origin);
        return reply.code(201).header('cache-control', 'no-store').send(issued);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    });
  app.get('/demo/catalog', { preHandler: authenticate({ credentials: deps.demoAuth, runtime: deps.runtime }) },
    async (request, reply) => {
      try {
        const env = deps.env?.() ?? process.env;
        const principal = requireOperator(request, 'conversation:takeover');
        requireDemoEnvironment(env);
        requireCanonicalDemoTenant(principal.tenant_id);
        const secret = env.MOCK_SECRET_KEY;
        const configured = env.ERP_API_BASE_URL;
        if (!secret || !configured || env.MOCK_ERP_ENABLED !== 'true') {
          fail('CAPABILITY_NOT_ENABLED', 'demo catalog source is not configured');
        }
        const base = new URL(configured);
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
          fail('CAPABILITY_NOT_ENABLED', 'demo catalog source is invalid');
        }
        const catalogPath = configured.endsWith('/api/v1') ? '/catalog/items' : '/api/v1/catalog/items';
        const catalogUrl = new URL(`${configured.replace(/\/+$/, '')}${catalogPath}`);
        const response = await fetch(catalogUrl.toString(), {
          headers: {
            'x-tenant-id': principal.tenant_id,
            'x-mock-signature': signMockRequest(
              secret,
              'GET',
              catalogUrl.pathname,
              '',
              nodeHmacSha256Hex,
            ),
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) fail('CAPABILITY_NOT_ENABLED', 'demo catalog source is unavailable');
        const data: unknown = await response.json();
        if (typeof data !== 'object' || data === null || !('items' in data) || !Array.isArray(data.items)) {
          fail('CAPABILITY_NOT_ENABLED', 'demo catalog response is invalid');
        }
        const envelope = data as Record<string, unknown>;
        const items = (data.items as unknown[]).map(projectCatalogItem).filter((item): item is CatalogItem => item !== null);
        if (items.length === 0) fail('CAPABILITY_NOT_ENABLED', 'demo catalog contains no active products');
        const snapshot_at = typeof envelope.snapshot_at === 'string' && envelope.snapshot_at.length > 0 ? envelope.snapshot_at : undefined;
        return reply.code(200).header('cache-control', 'no-store').send({
          items,
          ...(snapshot_at === undefined ? {} : { snapshot_at }),
        });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    });
}
