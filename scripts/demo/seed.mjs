#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isMainModule } from './lib/main-module.mjs';

const requireDatabaseDependency = createRequire(new URL('../../packages/database/package.json', import.meta.url));
export const NOVAMART_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const DEMO_IDEMPOTENCY_KEY = 'a9f4074913447922c5577959b02c1b0c934e7f77694473284f22382b621b6064';
const DEMO_REQUEST_FINGERPRINT = 'e3d62b23859d8d9b5835f81e567683226c077103b0a4d098007e3d97028f789a';
const PACK_URL = new URL('../../services/mock-erp/src/demo/novamart.json', import.meta.url);
const COUNTS = Object.freeze({ products: 24, skus: 28, customers: 12, orders: 20, events: 53, segments: 2, campaigns: 1, engagement_events: 8, cases: 4 });
const AGENTS = Object.freeze([
  ...Array.from({ length: 6 }, (_, i) => `MKT-0${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `SAL-0${i + 1}`),
  'CS-01', 'CS-02',
]);
const CASE_STATES = Object.freeze({ open: 'NEW', awaiting_human: 'WAITING_CUSTOMER', resolved: 'RESOLVED', closed: 'CLOSED' });
const CASE_PRIORITIES = Object.freeze({ urgent: 'P1', high: 'P2', normal: 'P3', low: 'P4' });

export function mapDemoServiceCase(item) {
  const state = CASE_STATES[item?.status];
  const priority = CASE_PRIORITIES[item?.priority];
  if (!state || !priority || typeof item?.escalated !== 'boolean') {
    throw new Error('DEMO_PACK_INVALID: service case state, priority, or escalation flag');
  }
  return {
    id: stableUuid('case', item.case_id),
    tenant_id: NOVAMART_TENANT_ID,
    customer_id: item.customer_id,
    order_id: item.order_id ? stableUuid('order', item.order_id) : null,
    case_number: item.case_id,
    state,
    priority,
    category: item.escalated ? 'escalated' : 'demo',
    assigned_human_id: item.escalated ? (item.handoff_status ?? 'awaiting_human') : null,
    subject: item.subject,
    created_at: item.created_at,
  };
}

export function validateDemoEnvironment(env) {
  if (env.DEMO_MODE !== 'true' || !['local', 'ci'].includes(env.APP_ENV)) {
    throw new Error('DEMO_SEED_FORBIDDEN: DEMO_MODE=true and APP_ENV=local|ci are required');
  }
  if (env.DEMO_TENANT_ID !== NOVAMART_TENANT_ID) {
    throw new Error('DEMO_TENANT_MISMATCH: the canonical NovaMart tenant is required');
  }
  if (typeof env.DATABASE_URL !== 'string' || env.DATABASE_URL.trim() === '') {
    throw new Error('DATABASE_URL_REQUIRED: no database configured for demo seed');
  }
}

export function validateDemoPack(pack) {
  if (!pack || pack.pack_version !== 'novamart-demo-v1' || pack.tenant_id !== NOVAMART_TENANT_ID || pack.demo_as_of !== '2026-09-28T00:00:00Z') {
    throw new Error('DEMO_PACK_INVALID: provenance or tenant mismatch');
  }
  for (const [name, count] of Object.entries(COUNTS)) {
    if (!Array.isArray(pack[name]) || pack[name].length !== count || pack[name].some((row) => row.tenant_id !== NOVAMART_TENANT_ID)) {
      throw new Error(`DEMO_PACK_INVALID: ${name} count or tenant mismatch`);
    }
  }
  const codes = new Set(pack.customers.map((customer) => customer.customer_code));
  if (codes.size !== 12 || Array.from({ length: 12 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`).some((code) => !codes.has(code))) {
    throw new Error('DEMO_PACK_INVALID: customer codes');
  }
  const byCode = Object.fromEntries(pack.customers.map((customer) => [customer.customer_code, customer]));
  const inactive = pack.segments.find((segment) => segment.segment_id === 'inactive90');
  const order = pack.orders.find((item) => item.order_number === 'ORD-DEMO-005');
  const canceled = pack.orders.find((item) => item.order_number === 'ORD-DEMO-017');
  const laptop = pack.skus.find((sku) => sku.sku_code === 'NM-L01-BLK');
  if (byCode.C05.customer_tier !== 'GOLD' || byCode.C05.consent?.email_marketing !== true || byCode.C05.last_paid_purchase_at !== '2026-05-31T00:00:00Z'
    || byCode.C05.web_chat_identity?.verified !== true || byCode.C08.consent?.email_marketing !== false
    || byCode.C12.consent?.email_marketing !== false || byCode.C12.consent?.service_chat !== false || byCode.C12.web_chat_identity?.verified !== false
    || inactive?.member_customer_ids?.length !== 1 || inactive.member_customer_ids[0] !== byCode.C05.customer_id
    || !inactive.excluded_customer_ids?.includes(byCode.C08.customer_id) || !inactive.excluded_customer_ids?.includes(byCode.C12.customer_id)
    || order?.customer_id !== byCode.C05.customer_id || order.status !== 'DELIVERED' || order.delivered_at !== '2026-06-02T00:00:00Z'
    || canceled?.customer_id !== byCode.C05.customer_id || canceled.status !== 'CANCELLED'
    || laptop?.available_quantity !== 5 || laptop?.quantity_reserved !== 1) {
    throw new Error('DEMO_PACK_INVALID: canonical scenario facts');
  }
  const mappedCases = pack.cases.map(mapDemoServiceCase);
  if (!mappedCases.some((c) => c.customer_id === byCode.C05.customer_id && c.state === 'WAITING_CUSTOMER' && c.priority === 'P2' && c.category === 'escalated' && c.assigned_human_id === 'awaiting_human')) {
    throw new Error('DEMO_PACK_INVALID: canonical escalated case missing');
  }
  for (const row of Object.values(COUNTS).flatMap((_, index) => pack[Object.keys(COUNTS)[index]])) {
    if (row.tenant_id !== NOVAMART_TENANT_ID) throw new Error('DEMO_PACK_INVALID: cross-tenant row');
  }
  return pack;
}

export function stableUuid(kind, key) {
  const hash = createHash('sha256').update(`novamart-demo-v1:${kind}:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function loadDemoPack() {
  return validateDemoPack(JSON.parse(await readFile(PACK_URL, 'utf8')));
}

const json = (value) => JSON.stringify(value);

async function seedRows(client, pack) {
  const tenant = NOVAMART_TENANT_ID;
  const query = (text, values) => client.query(text, values);
  for (const customer of pack.customers) {
    await query(`INSERT INTO agentos.customers (id,tenant_id,external_crm_id,primary_phone,primary_email,display_name,verification_status,customer_tier,metadata,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (tenant_id,external_crm_id) DO NOTHING`,
      [customer.customer_id, tenant, customer.customer_code, customer.phone, customer.email, customer.name,
        customer.identity_verified ? 'verified' : 'unverified', customer.customer_tier,
        json({ demo_pack: pack.pack_version, last_paid_purchase_at: customer.last_paid_purchase_at }), pack.demo_as_of]);
    const identity = customer.web_chat_identity;
    await query(`INSERT INTO agentos.customer_identities (id,tenant_id,customer_id,channel_type,channel_identifier,identifier_hash,is_primary,verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7) ON CONFLICT (tenant_id,channel_type,channel_identifier) DO NOTHING`,
      [stableUuid('identity', customer.customer_code), tenant, customer.customer_id, identity.channel,
        identity.channel_identifier, createHash('sha256').update(identity.channel_identifier).digest('hex'),
        identity.verified ? identity.verified_at : null]);
    for (const [channel, granted] of [['email', customer.consent.email_marketing], ['web_chat', customer.consent.service_chat]]) {
      await query(`INSERT INTO agentos.consents (id,tenant_id,customer_id,consent_type,channel,is_granted,opt_in_method,opt_in_timestamp,opt_out_timestamp,evidence_text)
        VALUES ($1,$2,$3,$4,$5,$6,'web_form',$7,$8,$9) ON CONFLICT (tenant_id,customer_id,channel,consent_type) DO NOTHING`,
        [stableUuid('consent', `${customer.customer_code}:${channel}`), tenant, customer.customer_id,
          channel === 'email' ? 'marketing_messaging' : 'order_updates', channel, granted, customer.consent.updated_at,
          granted ? null : customer.consent.updated_at, `synthetic:${pack.pack_version}`]);
    }
  }
  for (const product of pack.products) {
    await query(`INSERT INTO agentos.products (id,tenant_id,external_product_code,name,category,brand,description,is_active,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (tenant_id,external_product_code) DO NOTHING`,
      [stableUuid('product', product.product_id), tenant, product.product_id, product.name, product.category,
        product.brand, product.description, product.is_active, json({ demo_pack: pack.pack_version, attributes: product.attributes })]);
  }
  for (const sku of pack.skus) {
    const skuId = stableUuid('sku', sku.sku_code);
    await query(`INSERT INTO agentos.skus (id,tenant_id,product_id,sku_code,variant_name,attributes,is_active)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (tenant_id,sku_code) DO NOTHING`,
      [skuId, tenant, stableUuid('product', sku.product_id), sku.sku_code, sku.variant_name, json(sku.attributes), sku.is_active]);
    await query(`INSERT INTO agentos.prices (id,tenant_id,sku_id,currency,list_price,cost_of_goods,minimum_margin_rate,floor_price,floor_price_source,floor_price_synced_at,effective_from)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (tenant_id,sku_id,effective_from) DO NOTHING`,
      [stableUuid('price', sku.sku_code), tenant, skuId, sku.currency, sku.list_price, sku.cost_of_goods,
        sku.minimum_margin_rate, sku.floor_price, sku.floor_price_source, sku.floor_price_synced_at, pack.demo_as_of]);
    for (const warehouse of sku.warehouse_breakdown) {
      await query(`INSERT INTO agentos.inventories (id,tenant_id,sku_id,warehouse_code,quantity_on_hand,quantity_reserved,last_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,sku_id,warehouse_code) DO NOTHING`,
        [stableUuid('inventory', `${sku.sku_code}:${warehouse.warehouse_id}`), tenant, skuId, warehouse.warehouse_id,
          warehouse.physical_qty, warehouse.reserved_qty, pack.demo_as_of]);
    }
  }
  for (const order of pack.orders) {
    await query(`INSERT INTO agentos.orders (id,tenant_id,customer_id,order_number,status,currency,subtotal_amount,total_amount,items,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10) ON CONFLICT (tenant_id,order_number) DO NOTHING`,
      [stableUuid('order', order.order_number), tenant, order.customer_id, order.order_number, order.mirror_status,
        order.currency, order.total_amount, order.total_amount, json(order.line_items), order.order_date]);
  }
  for (const event of pack.events) {
    await query(`INSERT INTO agentos.customer_events (id,tenant_id,customer_id,session_id,event_name,source_event_id,channel,payload,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (tenant_id,source_event_id) DO NOTHING`,
      [stableUuid('event', event.event_id), tenant, event.customer_id, event.session_id, event.event_type,
        event.event_id, event.channel, json({ sku_id: event.sku_id, product_id: event.product_id, category: event.category, query: event.query }), event.occurred_at]);
  }
  for (const segment of pack.segments) {
    await query(`INSERT INTO agentos.segments (id,tenant_id,name,description,filter_rules,member_count,last_computed_at,created_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7) ON CONFLICT (id) DO NOTHING`,
      [stableUuid('segment', segment.segment_id), tenant, segment.name, segment.classification,
        json({ ...segment.criteria, segment_id: segment.segment_id, member_customer_ids: segment.member_customer_ids,
          excluded_customer_ids: segment.excluded_customer_ids }), segment.member_customer_ids.length, segment.created_at]);
  }
  for (const campaign of pack.campaigns) {
    await query(`INSERT INTO agentos.campaigns (id,tenant_id,segment_id,name,objective,channels,budget_limit,target_count,authority_level,status,schedule,created_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT (id) DO NOTHING`,
      [stableUuid('campaign', campaign.campaign_id), tenant, stableUuid('segment', campaign.segment_id), campaign.name,
        campaign.objective, json([campaign.channel]), campaign.budget_limit, campaign.max_audience_cap,
        campaign.required_authority, campaign.status, json({ locale: campaign.locale, min_days_inactive: campaign.min_days_inactive }), campaign.created_at]);
  }
  for (const engagement of pack.engagement_events) {
    await query(`INSERT INTO agentos.customer_events (id,tenant_id,customer_id,session_id,event_name,source_event_id,channel,payload,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (tenant_id,source_event_id) DO NOTHING`,
      [stableUuid('engagement', engagement.engagement_id), tenant, engagement.customer_id,
        `campaign:${engagement.campaign_id}`, `ext.marketing.${engagement.event_type}`, engagement.engagement_id,
        engagement.channel, json({ campaign_id: engagement.campaign_id }), engagement.occurred_at]);
  }
  for (const item of pack.cases) {
    const mapped = mapDemoServiceCase(item);
    await query(`INSERT INTO agentos.service_cases (id,tenant_id,customer_id,order_id,case_number,state,priority,category,assigned_human_id,subject,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (tenant_id,case_number) DO UPDATE SET state=EXCLUDED.state,priority=EXCLUDED.priority,category=EXCLUDED.category,assigned_human_id=EXCLUDED.assigned_human_id`,
      [mapped.id, tenant, mapped.customer_id, mapped.order_id, mapped.case_number,
        mapped.state, mapped.priority, mapped.category, mapped.assigned_human_id, mapped.subject, mapped.created_at]);
  }
  for (const code of AGENTS) {
    await query(`INSERT INTO agentos.agents (tenant_id,code,name,domain,assigned_authority,is_active)
      VALUES ($1,$2,$2,$3,$4,TRUE) ON CONFLICT (tenant_id,code) DO UPDATE SET assigned_authority=EXCLUDED.assigned_authority,is_active=TRUE`,
      [tenant, code, code.startsWith('MKT') ? 'marketing' : code.startsWith('SAL') ? 'sales' : 'support',
        demoAuthorityFor(code)]);
  }
  await promoteDemoSkills(query, tenant);
}

/**
 * The authority each demo agent is activated with.
 *
 * Sales agents hold AUTH-3 so the guarded advisory chain (catalog → stock → owner-approved quote →
 * recommendation) can complete without a human in the loop; `skill.sales.send_message`,
 * `skill.sales.create_cart` and `skill.sales.create_order` still require their own gates. Marketing
 * dispatch stays at AUTH-3 for MKT-05 so `skill.mkt.dispatch_campaign` (AUTH-4) pauses for an
 * approval instead of sending.
 */
function demoAuthorityFor(code) {
  if (code === 'CS-02') return 'AUTH-1';
  if (code.startsWith('MKT')) return code === 'MKT-05' ? 'AUTH-3' : 'AUTH-2';
  return 'AUTH-3';
}

/** The six canonical low-risk skills a demo run may execute without a human approval. */
const DEMO_PROMOTED_SKILLS = Object.freeze([
  'skill.sales.check_stock',
  'skill.sales.search_product',
  'skill.sales.retrieve_customer',
  'skill.care.search_faq',
  'skill.mkt.segment_audience',
  'skill.mkt.generate_content',
]);

/**
 * Promotes the canonical low-risk skills for this demo tenant.
 *
 * Controlled autonomy otherwise parks every listed skill as a draft, which would stop the demo at
 * its first read. Only the six promotable skills are moved; never-promotable actions (cart, order,
 * message, campaign dispatch, retention/return) keep their MINIMUM gate and still need their own
 * approval. The promotion is idempotent and records its demo provenance.
 */
async function promoteDemoSkills(query, tenant) {
  await query(
    `UPDATE agentos.autonomy_policies
        SET state = 'PROMOTED',
            previous_approved_state = 'MINIMUM',
            approver_id = 'novamart-demo-operator',
            reason = 'DEMO_PROMOTION',
            provenance = provenance || '{"promotion":"novamart-demo-v1"}'::jsonb,
            effective_at = CURRENT_TIMESTAMP,
            rollback_state = 'MINIMUM'
      WHERE tenant_id = $1
        AND skill_id = ANY($2::text[])
        AND state <> 'PROMOTED'`,
    [tenant, DEMO_PROMOTED_SKILLS],
  );
}


export async function seedNovaMart(env = process.env) {
  validateDemoEnvironment(env);
  const pack = await loadDemoPack();
  const { Client } = requireDatabaseDependency('pg');
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE agentos_app');
      await client.query('SET LOCAL search_path TO agentos, public');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [NOVAMART_TENANT_ID]);
      await client.query('SET LOCAL ROLE agentos_platform');
      const bootstrap = await client.query(
        'SELECT agentos.provision_tenant_shell_for_id($1::uuid,$2::char(64),$3::char(64),$4::varchar(128)) AS tenant_id',
        [NOVAMART_TENANT_ID, DEMO_IDEMPOTENCY_KEY, DEMO_REQUEST_FINGERPRINT, 'NovaMart Demo'],
      );
      await client.query('SET LOCAL ROLE agentos_app');
      if (bootstrap.rows[0]?.tenant_id !== NOVAMART_TENANT_ID) {
        throw new Error('DEMO_TENANT_MISMATCH: bootstrap returned a different tenant');
      }
      await seedRows(client, pack);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
  return { tenant_id: NOVAMART_TENANT_ID, counts: COUNTS, agent_count: AGENTS.length };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch { /* ignore if .env is missing */ }
  }
  seedNovaMart().then(({ tenant_id, counts, agent_count }) => {
    console.log(`NovaMart demo seeded for ${tenant_id}: ${JSON.stringify(counts)}, agents=${agent_count}`);
  }).catch((error) => {
    console.error(error instanceof Error && /^(DEMO_|DATABASE_URL_REQUIRED)/.test(error.message)
      ? error.message : 'DEMO_SEED_FAILED: database or schema write refused');
    process.exitCode = 1;
  });
}
