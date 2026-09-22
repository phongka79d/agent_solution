# Database & Memory Schema Specification

> **BLUEPRINT STATUS — target design; NOT IMPLEMENTED, DEPLOYED, MEASURED, or runtime evidence.**
> This document refines SRS §14 / §19 and names target DDL, RLS, Redis, Qdrant, memory, and migration contracts.
> Every SQL, JSON, TypeScript, and shell block is a **target snippet**, not a file that currently exists.


## 1. PostgreSQL DDL Schema (28 Canonical Entities + 1 Child Entity + 3 Audit Tables + 3 Runtime Tables + 2 Views)

The data layer implements the 28 canonical entities defined in Section 14 of the SRS across 4 functional domains, plus the child, runtime, and projection objects consumed by the Core Engine:

| Object Class | Count | Where |
|---|---|---|
| Canonical entities (SRS §14, Entities 1 - 28) | 28 | §1 DDL — DOMAIN 1 - DOMAIN 4 |
| Child entity (`conversation_messages`, Entity 11.1) | 1 | §1 DDL — DOMAIN 3 |
| Audit tables (`audit_records`, `evidence_records`, `agent_run_logs`) | 3 | §1 DDL — DOMAIN 5 |
| Runtime tables (`platform_durable_tasks`, `pending_outcome_attributions`, `effect_reservations`) | 3 | §1 DDL — DOMAIN 5 |
| SCR-003 queue view (`approval_queue`, over the single canonical `approvals` table) | 1 view | §1 DDL — DOMAIN 5 |
| Customer 360 projection view (`customer_360_profiles`) | 1 | §1 DDL — DOMAIN 5 |
| Composite tenant-scoped FK convention + negative tests | — | §1.1 |
| Epistemic (FACT / HYPOTHESIS) write boundary + SoR-mirror protection | — | §1.2 |

**Ordinal vs physical order.** Entity numbers in this document are the **SRS §14 ordinals** and are the only canonical cross-reference (Campaign = 14, Segment = 15). Physical DDL order inside the listing below is **dependency order**, not the SRS ordinal: `segments` (SRS Entity 15) is created before `campaigns` (SRS Entity 14) because `campaigns.segment_id` references it. Physical order MUST NOT be read as an ordinal anywhere in this pack.

There is exactly **one** approval model in this schema: the canonical entity `approvals` (Entity 24). `approval_queue` is a read-only view over its `PENDING` rows for SCR-003; no second queue table exists, so a resume can never be double-booked against two stores.

To guarantee total multi-tenant data isolation (NFR-006), **every single table — canonical, child, runtime, and audit — includes a mandatory `tenant_id UUID NOT NULL` column**, typed exactly as `UUID` everywhere. `tenant_id` is never a slug, integer, or free-form string, and it is never nullable.

**Identifier convention.** Surrogate primary keys are **UUID v7 (RFC 9562, time-ordered)**, produced by `agentos.uuid_generate_v7()` (defined below). UUID v7 keeps the high 48 bits as a Unix-millisecond timestamp, so B-tree inserts stay append-mostly and `ORDER BY id` is also `ORDER BY created_at`. Tables whose identity is a natural composite business key (for example `agent_run_logs`) instead declare `tenant_id` as the **leading** column of the primary key, so every key is tenant-scoped by construction.

Foreign keys enforce referential integrity within tenant boundaries — see §1.1 for the composite `(tenant_id, id)` convention that makes cross-tenant references structurally impossible.

```sql
-- ============================================================================
-- AGENTOS DATABASE INITIALIZATION SCRIPT (POSTGRESQL 16)
-- Schema: agentos
-- Compliance: NFR-001, NFR-002, NFR-003, NFR-006, BR-001..010
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS agentos;
SET search_path TO agentos, public;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ----------------------------------------------------------------------------
-- UUID v7 IDENTITY FACTORY (RFC 9562, time-ordered)
-- ----------------------------------------------------------------------------
-- PostgreSQL 16 ships no native uuidv7(), so this helper composes one from a
-- 48-bit Unix-millisecond timestamp plus 74 bits of CSPRNG entropy: bytes 0-5
-- carry the big-endian timestamp, the high nibble of byte 6 is the version (7),
-- and byte 8 is masked to the RFC 4122 variant (10xxxxxx). The timestamp prefix
-- keeps primary-key inserts append-mostly and makes `ORDER BY id` equivalent to
-- `ORDER BY created_at`. `tenant_id` values are UUID v7 issued at tenant
-- provisioning and are never generated per row.
CREATE OR REPLACE FUNCTION agentos.uuid_generate_v7()
RETURNS UUID AS $$
DECLARE
    ts_ms BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
    b BYTEA := gen_random_bytes(16);
BEGIN
    b := SET_BYTE(b, 0, ((ts_ms >> 40) & 255)::INT);
    b := SET_BYTE(b, 1, ((ts_ms >> 32) & 255)::INT);
    b := SET_BYTE(b, 2, ((ts_ms >> 24) & 255)::INT);
    b := SET_BYTE(b, 3, ((ts_ms >> 16) & 255)::INT);
    b := SET_BYTE(b, 4, ((ts_ms >>  8) & 255)::INT);
    b := SET_BYTE(b, 5, ( ts_ms        & 255)::INT);
    b := SET_BYTE(b, 6, (7 << 4) | (GET_BYTE(b, 6) & 15));   -- version  7
    b := SET_BYTE(b, 8, (GET_BYTE(b, 8) & 63) | 128);        -- variant  RFC 4122
    RETURN ENCODE(b, 'hex')::UUID;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ----------------------------------------------------------------------------
-- DOMAIN 1: CUSTOMER & IDENTITY (Entities 1 - 4)
-- ----------------------------------------------------------------------------

-- Entity 1: Customer (Master customer record across channels)
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    external_crm_id VARCHAR(128),
    primary_phone VARCHAR(64),
    primary_email VARCHAR(255),
    display_name VARCHAR(255),
    verification_status VARCHAR(32) NOT NULL DEFAULT 'unverified', -- 'unverified', 'verified', 'vip'
    customer_tier VARCHAR(32) NOT NULL DEFAULT 'standard',
    total_spent NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    order_count INT NOT NULL DEFAULT 0,
    last_interaction_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_customers_tenant_crm UNIQUE (tenant_id, external_crm_id)
);
CREATE INDEX idx_customers_tenant_search ON customers (tenant_id, primary_phone, primary_email);

-- Entity 2: Customer Identity (Channel identifier mappings: LINE UID, WhatsApp, Web UUID)
CREATE TABLE customer_identities (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    channel_type VARCHAR(32) NOT NULL, -- 'line', 'whatsapp', 'web', 'zalo', 'phone', 'email'
    channel_identifier VARCHAR(255) NOT NULL, -- Platform specific UID
    identifier_hash VARCHAR(128) NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_identities_tenant_channel UNIQUE (tenant_id, channel_type, channel_identifier)
);
CREATE INDEX idx_identities_customer ON customer_identities (tenant_id, customer_id);

-- Entity 3: Consent (Legal tracking for marketing, contact & data retention - BR-004)
CREATE TABLE consents (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    consent_type VARCHAR(64) NOT NULL, -- 'marketing_messaging', 'order_updates', 'analytics'
    channel VARCHAR(32) NOT NULL, -- 'line', 'whatsapp', 'email', 'sms'
    is_granted BOOLEAN NOT NULL DEFAULT FALSE,
    opt_in_method VARCHAR(64) NOT NULL, -- 'web_form', 'chat_optin', 'pos_checkbox'
    opt_in_timestamp TIMESTAMPTZ NOT NULL,
    opt_out_timestamp TIMESTAMPTZ,
    evidence_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_consents_customer_channel_type UNIQUE (tenant_id, customer_id, channel, consent_type)
);
CREATE INDEX idx_consents_status ON consents (tenant_id, customer_id, is_granted);

-- Entity 4: Customer Event (Real-time behavioral stream: view, cart, click - API-002)
CREATE TABLE customer_events (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    session_id VARCHAR(128) NOT NULL,
    event_name VARCHAR(64) NOT NULL, -- API-002 canonical vocabulary: 'session','product_view','search','click','add_to_cart','checkout','purchase' (owned by ./06-api-and-connectors-spec.md); platform extension events use the 'ext.<domain>.<name>' form (see §8)
    source_event_id VARCHAR(128) NOT NULL, -- immutable event identity supplied by the source (client/provider); the dedupe key for replayed or late delivery (API-002, §8)
    channel VARCHAR(32) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_customer_events_source UNIQUE (tenant_id, source_event_id)
);
CREATE INDEX idx_customer_events_tenant_cust ON customer_events (tenant_id, customer_id, occurred_at DESC);
CREATE INDEX idx_customer_events_session ON customer_events (tenant_id, session_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- DOMAIN 2: COMMERCE & FULFILLMENT (Entities 5 - 10)
-- ----------------------------------------------------------------------------

-- Entity 5: Product (Canonical catalog synced from ERP/PIM API-001)
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    external_product_code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(128),
    brand VARCHAR(128),
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_products_tenant_code UNIQUE (tenant_id, external_product_code)
);
CREATE INDEX idx_products_tenant_active ON products (tenant_id, is_active);

-- Entity 6: SKU (Stock Keeping Units for product variants)
CREATE TABLE skus (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku_code VARCHAR(64) NOT NULL,
    variant_name VARCHAR(128) NOT NULL,
    barcode VARCHAR(64),
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"color": "black", "size": "M"}
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_skus_tenant_code UNIQUE (tenant_id, sku_code)
);
CREATE INDEX idx_skus_product ON skus (tenant_id, product_id);

-- Entity 7: Price (SoR pricing mirror; provenance-tagged - BR-001, BR-003)
-- [OWNER-DECISION-REQUIRED][README §8.1] Two floor-ownership models remain open; this DDL
-- does not decide between them and no query may assume either one is final:
--   Candidate A - source-supplied floor (this table's mirror shape): the authoritative source
--     (ERP/policy pricing service, API-001) supplies `floor_price` + `floor_price_source`; the
--     platform validates presence, freshness, tenant binding, and provenance, and refuses a
--     missing or unapproved provenance.
--   Candidate B - platform-derived floor: the platform derives the floor from owner-approved
--     policy inputs using a documented formula. The illustrative local arithmetic in `02` and
--     `08` (`Math.ceil((C + L + D_cap)/(1-r))`) is a competing candidate, not a canonical
--     formula, and MUST NOT be treated as one here.
-- Ownership, formula/mode, rounding, currency, staleness, and provenance stay unresolved until
-- the Solution Architect and Business/Finance record the decision. Interim safety rule: no
-- price-bearing action may dispatch without an owner-approved, provenance-bearing floor decision.
-- Missing or unapproved provenance is `P_FLOOR_UNAVAILABLE`, and this schema invents no numeric default.
-- `minimum_margin_rate` is a policy mirror for binding only; it is NOT used by this DDL to derive `floor_price`.
CREATE TABLE prices (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    sku_id UUID NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
    currency VARCHAR(8) NOT NULL DEFAULT 'TWD',
    list_price NUMERIC(12, 2) NOT NULL,
    cost_of_goods NUMERIC(12, 2) NOT NULL,
    minimum_margin_rate NUMERIC(5, 4) NOT NULL CHECK (minimum_margin_rate >= 0.0000 AND minimum_margin_rate < 1.0000), -- policy mirror, informational only (see conflict note above); not used to derive floor_price
    floor_price NUMERIC(12, 2) NOT NULL,              -- floor value per the OWNER-DECISION-REQUIRED ownership model (README §8.1); never AI-generated
    floor_price_source VARCHAR(128) NOT NULL,         -- floor provenance; e.g. 'erp:pricing-service/v3' (BR-003). Missing provenance refuses a price-bearing dispatch.
    floor_price_synced_at TIMESTAMPTZ NOT NULL,       -- staleness is evaluated against this, not against row creation
    effective_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    effective_to TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_prices_tenant_sku_active UNIQUE (tenant_id, sku_id, effective_from)
);
CREATE INDEX idx_prices_sku ON prices (tenant_id, sku_id);

-- Entity 8: Inventory (Authoritative real-time warehouse inventory)
CREATE TABLE inventories (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    sku_id UUID NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
    warehouse_code VARCHAR(64) NOT NULL DEFAULT 'DEFAULT',
    quantity_on_hand INT NOT NULL DEFAULT 0,
    quantity_reserved INT NOT NULL DEFAULT 0,
    quantity_available INT GENERATED ALWAYS AS (quantity_on_hand - quantity_reserved) STORED,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_inventory_tenant_sku_wh UNIQUE (tenant_id, sku_id, warehouse_code)
);
CREATE INDEX idx_inventories_available ON inventories (tenant_id, sku_id, quantity_available);

-- Entity 9: Order (Draft and confirmed transaction records)
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    order_number VARCHAR(64) NOT NULL,
    effect_key VARCHAR(128), -- Idempotency token (NFR-003)
    status VARCHAR(32) NOT NULL DEFAULT 'draft', -- 'draft', 'pending_payment', 'paid', 'fulfilled', 'cancelled'
    currency VARCHAR(8) NOT NULL DEFAULT 'TWD',
    subtotal_amount NUMERIC(14, 2) NOT NULL,
    discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(14, 2) NOT NULL,
    payment_method VARCHAR(32), -- 'ecpay_credit', 'cvs_cod', 'stripe', 'line_pay'
    shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
    items JSONB NOT NULL, -- Array of item snapshots (sku_id, quantity, unit_price, applied_discount)
    created_by_agent VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_orders_tenant_number UNIQUE (tenant_id, order_number),
    CONSTRAINT uq_orders_tenant_effect UNIQUE (tenant_id, effect_key)
);
CREATE INDEX idx_orders_customer ON orders (tenant_id, customer_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders (tenant_id, status);

-- Entity 10: Invoice (Tax invoice and accounting ledger synchronization)
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    invoice_number VARCHAR(64) NOT NULL,
    einvoice_carrier_type VARCHAR(32), -- Taiwan e-invoice carrier (Mobile barcode, Citizen ID)
    einvoice_carrier_number VARCHAR(64),
    tax_amount NUMERIC(14, 2) NOT NULL,
    total_with_tax NUMERIC(14, 2) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(32) NOT NULL DEFAULT 'issued',
    CONSTRAINT uq_invoices_tenant_number UNIQUE (tenant_id, invoice_number)
);
CREATE INDEX idx_invoices_order ON invoices (tenant_id, order_id);

-- ----------------------------------------------------------------------------
-- DOMAIN 3: ENGAGEMENT & LIFECYCLE (Entities 11 - 18)
-- ----------------------------------------------------------------------------

-- Entity 11: Conversation (Omnichannel chat session root)
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID REFERENCES customers(id),
    channel VARCHAR(32) NOT NULL,
    external_thread_id VARCHAR(128) NOT NULL,
    active_agent VARCHAR(64) NOT NULL DEFAULT 'auto',
    state VARCHAR(32) NOT NULL DEFAULT 'open', -- 'open', 'paused_takeover', 'closed'
    takeover_operator_id VARCHAR(128),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_conversations_tenant_thread UNIQUE (tenant_id, channel, external_thread_id)
);
CREATE INDEX idx_conversations_active ON conversations (tenant_id, state, last_message_at DESC);

-- Entity 11.1: Conversation Message (Child entity storing individual turn dialogues, token usage & metadata)
CREATE TABLE conversation_messages (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type VARCHAR(32) NOT NULL CHECK (sender_type IN ('customer', 'agent', 'operator', 'system')),
    sender_id VARCHAR(128) NOT NULL, -- e.g. customer_id, agent code 'SAL-01', operator UUID
    content TEXT NOT NULL,
    content_type VARCHAR(32) NOT NULL DEFAULT 'text', -- 'text', 'image', 'carousel', 'quick_reply'
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_conversation_messages_turn ON conversation_messages (tenant_id, conversation_id, created_at ASC);

-- Entity 12: Lead (Prospect qualification with Reason & Evidence - FR-SAL-001)
CREATE TABLE leads (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID REFERENCES customers(id),
    customer_type VARCHAR(32) NOT NULL DEFAULT 'new', -- 'new', 'returning'
    needs_summary TEXT,
    interested_products JSONB NOT NULL DEFAULT '[]'::jsonb,
    readiness_score INT NOT NULL DEFAULT 0, -- 0 to 100
    recent_behavior JSONB NOT NULL DEFAULT '{}'::jsonb,
    purchase_history_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    opportunity_potential NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    qualification_status VARCHAR(32) NOT NULL DEFAULT 'unqualified', -- 'unqualified', 'nurturing', 'qualified', 'converted'
    reason TEXT NOT NULL,
    evidence JSONB NOT NULL,
    assigned_agent VARCHAR(64) NOT NULL DEFAULT 'SAL-01',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_leads_qualification ON leads (tenant_id, qualification_status, readiness_score DESC);

-- Entity 13: Opportunity (High-probability deal pipeline)
CREATE TABLE opportunities (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    stage VARCHAR(32) NOT NULL DEFAULT 'discovery', -- 'discovery', 'proposal', 'negotiation', 'closed_won', 'closed_lost'
    expected_revenue NUMERIC(14, 2) NOT NULL,
    probability NUMERIC(4, 2) NOT NULL DEFAULT 0.20,
    close_date_target DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_opportunities_stage ON opportunities (tenant_id, stage);

-- Entity 15: Segment (Behavioral and RFM audience cohorts).
-- SRS §14 ordinal = 15. It is listed before Campaign (Entity 14) only because
-- `campaigns.segment_id` references this table; physical order is dependency order.
CREATE TABLE segments (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    filter_rules JSONB NOT NULL, -- Dynamic SQL/AST criteria
    member_count INT NOT NULL DEFAULT 0,
    last_computed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_segments_tenant ON segments (tenant_id, name);

-- Entity 14: Campaign (Marketing outreach lifecycle - MKT-05, AUTH-4).
-- SRS §14 ordinal = 14; created after Segment (Entity 15) solely because of the FK above.
CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    segment_id UUID REFERENCES segments(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    objective VARCHAR(64) NOT NULL,
    channels JSONB NOT NULL, -- e.g. ["line", "whatsapp"]
    content_bundle JSONB NOT NULL DEFAULT '{}'::jsonb,
    budget_limit NUMERIC(12, 2) NOT NULL,
    spent_budget NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    target_count INT NOT NULL DEFAULT 0,
    authority_level VARCHAR(16) NOT NULL DEFAULT 'AUTH-4',
    approval_id UUID,
    status VARCHAR(32) NOT NULL DEFAULT 'draft', -- 'draft', 'awaiting_approval', 'approved', 'running', 'completed'
    schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_campaigns_status ON campaigns (tenant_id, status);
CREATE INDEX idx_campaigns_segment ON campaigns (tenant_id, segment_id);

-- Entity 16: Offer (Discount policies, capped coupons - BR-001, BR-002)
CREATE TABLE offers (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    offer_type VARCHAR(32) NOT NULL, -- 'percentage', 'fixed_amount', 'free_shipping'
    discount_value NUMERIC(10, 2) NOT NULL,
    max_discount_cap NUMERIC(10, 2) NOT NULL, -- D_cap
    min_order_value NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    p_floor_constraint NUMERIC(12, 2) NOT NULL, -- floor constraint value under the OWNER-DECISION-REQUIRED ownership model (README §8.1); mirrored or derived per the recorded decision, never defaulted or generated locally
    p_floor_source VARCHAR(128) NOT NULL,       -- floor provenance (required before any price-bearing dispatch; missing provenance refuses the action)
    applicable_skus JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_quota INT NOT NULL,
    claimed_count INT NOT NULL DEFAULT 0,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_offers_tenant_code UNIQUE (tenant_id, code)
);
CREATE INDEX idx_offers_validity ON offers (tenant_id, status, valid_from, valid_to);

-- Entity 17: Recommendation (Product recommendation with 7 mandatory fields - FR-SAL-003)
CREATE TABLE recommendations (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    product_id UUID NOT NULL REFERENCES products(id),
    sku_id UUID REFERENCES skus(id),
    recommendation_type VARCHAR(32) NOT NULL, -- 'cross_sell', 'upsell', 'replenishment'
    reason TEXT NOT NULL,
    evidence JSONB NOT NULL,
    eligibility JSONB NOT NULL,
    confidence NUMERIC(4, 3) NOT NULL, -- 0.000 to 1.000
    expected_outcome JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'proposed', -- 'proposed', 'accepted', 'dismissed', 'converted'
    presented_at TIMESTAMPTZ,
    converted_order_id UUID REFERENCES orders(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_recommendations_cust ON recommendations (tenant_id, customer_id, created_at DESC);

-- Entity 18: Service Case (Customer support ticket - CS-01)
-- Canonical state contract = the 7 SRS §8 states, and nothing else. Reopening is an ACTION,
-- not a state: `REOPEN` transitions RESOLVED | CLOSED -> IN_PROGRESS while preserving the
-- Case ID, SLA history, and evidence. No `REOPENED` row value exists in this contract.
-- Canonical priority contract = P1..P4 (P1 = urgent/highest ... P4 = lowest), matching the
-- Customer Care module definition; a single vocabulary is shared by DB, skill contract, and UI.
CREATE TABLE service_cases (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    case_number VARCHAR(64) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'NEW' CHECK (state IN ('NEW', 'CLASSIFIED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED')),
    priority VARCHAR(2) NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1', 'P2', 'P3', 'P4')), -- P1 urgent, P2 high, P3 medium, P4 low
    category VARCHAR(64) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    assigned_agent VARCHAR(64) NOT NULL DEFAULT 'CS-01',
    assigned_human_id VARCHAR(128),
    evidence_id UUID,
    outcome_id UUID,
    sla_due_at TIMESTAMPTZ,
    sla_history JSONB NOT NULL DEFAULT '[]'::jsonb, -- append-only SLA windows [{opened_at, due_at, closed_at?, reason}]; REOPEN appends a fresh window (§9)
    reopen_count INT NOT NULL DEFAULT 0,            -- incremented ONLY by the REOPEN action; never a state value (§9)
    reopened_at TIMESTAMPTZ,                        -- most recent REOPEN time; NULL when never reopened
    case_version INT NOT NULL DEFAULT 1 CHECK (case_version > 0), -- compare-and-set for transitions, assignment and REOPEN (§9)
    resolution TEXT,
    satisfaction_score INT, -- 1 to 5
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_cases_tenant_number UNIQUE (tenant_id, case_number),
    CONSTRAINT ck_cases_reopen_pair CHECK ((reopen_count = 0) = (reopened_at IS NULL)) -- reopen bookkeeping is paired: a reopen always stamps both fields (§9)
);
CREATE INDEX idx_service_cases_state ON service_cases (tenant_id, state, priority);

-- ----------------------------------------------------------------------------
-- DOMAIN 4: GOVERNANCE & INTELLIGENCE (Entities 19 - 28)
-- ----------------------------------------------------------------------------

-- Entity 19: Agent (Registry of 13 system agents)
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    code VARCHAR(32) NOT NULL, -- 'SAL-01', 'MKT-01', 'CS-01', 'SUPERVISOR'
    name VARCHAR(128) NOT NULL,
    domain VARCHAR(32) NOT NULL, -- 'marketing', 'sales', 'support', 'orchestration'
    assigned_authority VARCHAR(16) NOT NULL DEFAULT 'AUTH-1' CHECK (assigned_authority IN ('AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3')), -- agents are only ever GRANTED autonomous clearance AUTH-0..AUTH-3; AUTH-4 is an approval queue and AUTH-5 is a deny verdict, neither is assignable (see §08 1.1)
    system_prompt_version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_agents_tenant_code UNIQUE (tenant_id, code)
);

-- Entity 20: Skill (Executable atomic tool contract registry - SRS §11 canonical fields)
-- Every SRS §11 obligation is persisted as a queryable column, not prose: the runtime in §05
-- reads `retry_policy` / `audit_spec` / `test_cases` from this row, so a skill cannot be
-- registered without a structured retry contract, an audit contract, and mandatory test cases.
CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    name VARCHAR(64) NOT NULL, -- canonical Skill ID from 05, e.g. 'skill.sales.check_price'; mapped to runtime skill_id
    purpose TEXT NOT NULL, -- SRS §11 field 2 (Purpose)
    required_authority VARCHAR(16) NOT NULL CHECK (required_authority IN ('AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3', 'AUTH-4')), -- AUTH-4 = must pass the approvals gate; AUTH-5 is never a requirement, only a deny verdict
    allowed_agents VARCHAR(64)[] NOT NULL DEFAULT '{}',
    connector_name VARCHAR(64),
    validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    input_schema JSONB NOT NULL,
    output_schema JSONB NOT NULL,
    epistemic_class VARCHAR(16) NOT NULL DEFAULT 'FACT' CHECK (epistemic_class IN ('FACT', 'SIGNAL', 'HYPOTHESIS', 'DECISION', 'ACTION')), -- FR-C360-003: a HYPOTHESIS-producing skill may never write to an SoR mirror (§1.2)
    is_idempotent BOOLEAN NOT NULL DEFAULT TRUE,
    retry_policy JSONB NOT NULL DEFAULT '{}'::jsonb, -- {max_retries, initial_interval_ms, backoff_multiplier, retry_on_timeout, non_retryable_errors}
    timeout_ms INT NOT NULL DEFAULT 5000,
    audit_spec JSONB NOT NULL DEFAULT '{}'::jsonb, -- {log_level, mask_pii_fields, evidence_card, record_latency}
    test_cases JSONB NOT NULL DEFAULT '[]'::jsonb, -- SRS §11 field 11: [{test_id, category, scenario, expected_outcome, required}]
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_skills_tenant_name UNIQUE (tenant_id, name),
    CONSTRAINT ck_skills_retry_policy CHECK (retry_policy ? 'max_retries'),
    CONSTRAINT ck_skills_audit_spec CHECK (audit_spec ? 'evidence_card'),
    CONSTRAINT ck_skills_test_cases CHECK (jsonb_typeof(test_cases) = 'array' AND jsonb_array_length(test_cases) > 0)
);

-- Entity 21: Workflow (Durable multi-step orchestrations)
CREATE TABLE workflows (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    workflow_name VARCHAR(128) NOT NULL,
    correlation_id VARCHAR(128) NOT NULL,
    current_step INT NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'running', -- 'running', 'waiting_approval', 'completed', 'failed'
    context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);
CREATE INDEX idx_workflows_correlation ON workflows (tenant_id, correlation_id);

-- Entity 22: Decision (Algorithmic choices logged with reasoning)
CREATE TABLE decisions (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    workflow_id UUID REFERENCES workflows(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id),
    decision_type VARCHAR(64) NOT NULL,
    reason TEXT NOT NULL,
    evidence JSONB NOT NULL,
    chosen_action VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_decisions_tenant_agent ON decisions (tenant_id, agent_id, created_at DESC);
CREATE INDEX idx_decisions_workflow ON decisions (tenant_id, workflow_id);

-- Entity 23: Action (Prepared outgoing commands awaiting dispatch)
CREATE TABLE actions (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    decision_id UUID REFERENCES decisions(id) ON DELETE CASCADE,
    skill_name VARCHAR(64) NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    target_channel VARCHAR(32) NOT NULL,
    action_payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending', -- 'pending', 'authorized', 'dispatched', 'failed'
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_actions_tenant_effect UNIQUE (tenant_id, effect_key)
);
CREATE INDEX idx_actions_status ON actions (tenant_id, status);
CREATE INDEX idx_actions_decision ON actions (tenant_id, decision_id);

-- Entity 24: Approval (the SINGLE canonical human-authorization record - SCR-003, AUTH-4)
-- One row is created PENDING when the orchestrator pauses for AUTH-4, and it is the only
-- object that authorizes a resume. `approval_queue` (DOMAIN 5) is a read-only VIEW over the
-- PENDING rows; there is no second queue table. The resume path updates this row
-- (decision + decided_by + decided_at) in the SAME transaction that re-activates the durable
-- task, so an approval can never be consumed twice or resume a task against stale state.
-- SCR-003 verbs map as: Approve -> decision APPROVED; Reject -> REJECTED; Modify -> MODIFIED
-- (payload delta captured in `review_comment` + `payload`); Pause -> `is_paused = TRUE`
-- (still PENDING, not decided); Cancel -> CANCELLED.
CREATE TABLE approvals (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL, -- orchestrator run that must resume on approval
    action_id UUID NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id),
    effect_key VARCHAR(128) NOT NULL, -- deterministic binding to the proposed action (BR-005)
    authority_required VARCHAR(16) NOT NULL DEFAULT 'AUTH-4' CHECK (authority_required IN ('AUTH-4')),
    payload JSONB NOT NULL, -- proposed action payload shown to the approver
    reason TEXT NOT NULL, -- why the approval gate fired (policy/threshold citation)
    operator_id VARCHAR(128),
    decision VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING', 'APPROVED', 'REJECTED', 'MODIFIED', 'CANCELLED', 'EXPIRED')),
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    review_comment TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_approvals_tenant_effect UNIQUE (tenant_id, effect_key), -- one approval binding per effect revision; a confirmed-absent retry reuses this row and never inserts another
    CONSTRAINT ck_approvals_decided CHECK ((decision = 'PENDING') = (decided_at IS NULL)),
    CONSTRAINT ck_approvals_pause_pending CHECK (decision = 'PENDING' OR is_paused = FALSE)
);
CREATE INDEX idx_approvals_pending ON approvals (tenant_id, decision, created_at) WHERE decision = 'PENDING';
CREATE INDEX idx_approvals_action ON approvals (tenant_id, action_id);
CREATE INDEX idx_approvals_run ON approvals (tenant_id, run_id);

-- Entity 25: Execution (Physical external network dispatches with 72h permanent audit)
CREATE TABLE executions (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    action_id UUID REFERENCES actions(id) ON DELETE SET NULL,
    effect_key VARCHAR(128) NOT NULL,
    run_id VARCHAR(128) NOT NULL,
    adapter_name VARCHAR(64) NOT NULL,
    request_payload JSONB NOT NULL,
    response_payload JSONB,
    http_status INT,
    latency_ms INT NOT NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    estimated_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0.000000,
    status VARCHAR(32) NOT NULL, -- 'success', 'retryable_error', 'fatal_error'
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_executions_tenant_effect UNIQUE (tenant_id, effect_key)
);
CREATE INDEX idx_executions_tenant_run ON executions (tenant_id, run_id);
CREATE INDEX idx_executions_action ON executions (tenant_id, action_id);

-- Entity 26: Evidence (Audit trail for grounding facts, signals & hypotheses - FR-C360-003)
CREATE TABLE evidences (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID REFERENCES customers(id),
    run_id VARCHAR(128) NOT NULL,
    taxonomy_type VARCHAR(32) NOT NULL, -- 'FACT', 'SIGNAL', 'HYPOTHESIS', 'DECISION', 'ACTION'
    claim TEXT NOT NULL,
    source_uri VARCHAR(255) NOT NULL, -- e.g. 'sor:erp/orders/ORD-991', 'second_brain:/product/pricing.md'
    source_version VARCHAR(64) NOT NULL,
    conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_evidences_taxonomy ON evidences (tenant_id, customer_id, taxonomy_type);

-- Entity 27: Outcome (Real quantitative business metrics reconciled with SoR)
CREATE TABLE outcomes (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    campaign_id UUID REFERENCES campaigns(id),
    order_id UUID REFERENCES orders(id),
    customer_id UUID REFERENCES customers(id),
    conversion_type VARCHAR(64) NOT NULL, -- 'order_placed', 'quote_accepted', 'ticket_resolved_fcr'
    gross_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    net_margin NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    ai_cost_attributed NUMERIC(10, 6) NOT NULL DEFAULT 0.000000,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_outcomes_tenant_type ON outcomes (tenant_id, conversion_type, recorded_at DESC);

-- Entity 28: Learning (Model weight adjustments, prompt optimizations, and lessons learned)
CREATE TABLE learnings (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    agent_code VARCHAR(32) NOT NULL,
    topic VARCHAR(128) NOT NULL,
    observation TEXT NOT NULL,
    correction_applied TEXT NOT NULL,
    metric_impact JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_learnings_agent ON learnings (tenant_id, agent_code, is_active);

-- Deferred Foreign Key Constraints across domains
ALTER TABLE service_cases 
    ADD CONSTRAINT fk_cases_evidence FOREIGN KEY (evidence_id) REFERENCES evidences(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_cases_outcome FOREIGN KEY (outcome_id) REFERENCES outcomes(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- DOMAIN 5: CUSTOMER360 PROJECTION VIEW, AUDIT & RUNTIME TABLES
-- These objects are the persistence contract of the Core Engine (§04): the
-- 11-stage lifecycle reads the projection at CONTEXT and writes the
-- append-only chains, durable task, effect reservation, outcome watcher, and approval lifecycle.
-- RLS is not declared inline: the §2 auto-policy DO block enables and FORCEs
-- `tenant_isolation_policy` on every table of the `agentos` schema, so the tables
-- below are covered by construction. The views (`customer_360_profiles`,
-- `approval_queue`) are not tables and instead inherit isolation from their base
-- tables via `security_invoker = true`.
-- ----------------------------------------------------------------------------

-- View 1: Customer 360 Projection (Entity 1 (`customers`) + Entity 2 (`customer_identities`)
-- + Entity 3 (`consents`) consolidated into the single FACT read model consumed by
-- orchestrator context hydration (FR-C360-001, §04 5.1).
--   * FACT semantics: only VERIFIED contact handles are released. `verified_phone`
--     and `verified_email` stay NULL unless an identity row is verified, or the
--     customer carries `verification_status IN ('verified','vip')`. An unverified
--     handle can therefore never be promoted into a FACT by this projection.
--   * `line_user_id` is exposed for channel identity resolution only (the
--     orchestrator binds it as its 4th lookup predicate); it is an identifier,
--     never a contactable channel.
--   * `rfm_segment_hypothesis` is DERIVED, not FACT. It is computed from mirrored
--     transaction aggregates and tenant-configurable thresholds, so it is emitted under an
--     explicit `_hypothesis` suffix and must never be written back to `customers` or any other
--     SoR mirror (§1.2, FR-C360-003). Consumers that need a durable derived attribute persist it
--     as an `evidences` row with `taxonomy_type = 'HYPOTHESIS'`.
--   * `consent_marketing` defaults to FALSE when no marketing consent row exists
--     (fail-closed, BR-004) and `suppression_active` flips TRUE on the first
--     revocation, so the orchestrator can refuse outreach deterministically.
CREATE OR REPLACE VIEW agentos.customer_360_profiles
WITH (security_invoker = true) AS
SELECT
    c.id          AS customer_id,
    c.tenant_id   AS tenant_id,
    COALESCE(ident.verified_phone, CASE WHEN c.verification_status IN ('verified', 'vip') THEN c.primary_phone END) AS verified_phone,
    COALESCE(ident.verified_email, CASE WHEN c.verification_status IN ('verified', 'vip') THEN c.primary_email END) AS verified_email,
    c.total_spent AS total_spent,
    c.order_count AS order_count,
    CASE
        WHEN c.order_count = 0 OR c.last_interaction_at IS NULL              THEN 'NEW'
        WHEN c.last_interaction_at >= NOW() - INTERVAL '30 days'
             AND c.order_count >= 3 AND c.total_spent >= 10000               THEN 'CHAMPION'
        WHEN c.last_interaction_at >= NOW() - INTERVAL '30 days'             THEN 'PROMISING'
        WHEN c.order_count >= 3 AND c.total_spent >= 10000                   THEN 'AT_RISK'
        ELSE 'HIBERNATING'
    END           AS rfm_segment_hypothesis,
    COALESCE(consent.consent_marketing, FALSE)   AS consent_marketing,
    consent.consent_updated_at                   AS consent_updated_at,
    COALESCE(consent.suppression_active, FALSE)  AS suppression_active,
    ident.line_user_id AS line_user_id,
    c.created_at  AS created_at
FROM agentos.customers c
LEFT JOIN LATERAL (
    SELECT
        MAX(ci.channel_identifier) FILTER (WHERE ci.channel_type = 'phone' AND ci.verified_at IS NOT NULL) AS verified_phone,
        MAX(ci.channel_identifier) FILTER (WHERE ci.channel_type = 'email' AND ci.verified_at IS NOT NULL) AS verified_email,
        MAX(ci.channel_identifier) FILTER (WHERE ci.channel_type = 'line')                                  AS line_user_id
    FROM agentos.customer_identities ci
    WHERE ci.tenant_id = c.tenant_id
      AND ci.customer_id = c.id
) ident ON TRUE
LEFT JOIN LATERAL (
    SELECT
        BOOL_OR(cons.is_granted)     AS consent_marketing,
        MAX(cons.updated_at)         AS consent_updated_at,
        BOOL_OR(NOT cons.is_granted) AS suppression_active
    FROM agentos.consents cons
    WHERE cons.tenant_id = c.tenant_id
      AND cons.customer_id = c.id
      AND cons.consent_type = 'marketing_messaging'
) consent ON TRUE;

-- Audit Table 1: Agent Run Log (18-field execution audit contract, §04 6.1).
-- One row per executed pipeline step, appended when the step completes. `tenant_id`
-- leads the primary key so the key is tenant-scoped and index-local.
CREATE TABLE agent_run_logs (
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    agent_id VARCHAR(32) NOT NULL,
    customer_or_entity_id VARCHAR(64) NOT NULL,
    trigger VARCHAR(128) NOT NULL,
    context JSONB NOT NULL,
    skill VARCHAR(64) NOT NULL,
    step_index INT NOT NULL DEFAULT 1,
    tool VARCHAR(64) NOT NULL,
    decision JSONB NOT NULL,
    authority VARCHAR(16) NOT NULL,
    approval JSONB,
    action JSONB NOT NULL,
    execution_status VARCHAR(32) NOT NULL CHECK (execution_status IN ('pending', 'executing', 'success', 'failed', 'denied', 'aborted')),
    evidence JSONB NOT NULL,
    outcome JSONB,
    latency_ms INT NOT NULL,
    cost JSONB NOT NULL,
    error JSONB,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, run_id, skill, step_index)
);
CREATE INDEX idx_agent_run_logs_tenant_agent ON agent_run_logs (tenant_id, agent_id, started_at DESC);
CREATE INDEX idx_agent_run_logs_entity ON agent_run_logs (tenant_id, customer_or_entity_id);

-- View 2: Approval Queue (SCR-003 human-in-the-loop gate, AUTH-4).
-- This is a VIEW, not a table: the canonical mutable state lives in `approvals` (Entity 24),
-- and the queue is exactly its PENDING projection, ordered oldest-first for the console.
-- §04 `logPendingApproval` INSERTs into `approvals`; the SCR-003 console decides a row there
-- and §04 `resumeTask` flips it transactionally with the task transition. Because there is one
-- storage object, the queue and the resume path can never disagree (no split-brain approvals).
CREATE OR REPLACE VIEW agentos.approval_queue
WITH (security_invoker = true) AS
SELECT
    a.id              AS approval_id,
    a.tenant_id       AS tenant_id,
    a.run_id          AS run_id,
    a.action_id       AS action_id,
    a.effect_key      AS effect_key,
    a.payload         AS payload,
    a.reason          AS reason,
    a.decision        AS status,        -- PENDING | APPROVED | REJECTED | MODIFIED | CANCELLED | EXPIRED
    a.is_paused       AS is_paused,
    a.operator_id     AS decided_by,
    a.decided_at      AS decided_at,
    a.review_comment  AS decision_notes,
    a.created_at      AS created_at
FROM agentos.approvals a
WHERE a.decision = 'PENDING';

-- Runtime Table 1: Pending Outcome Attribution (§04 step [10. OUTCOME]).
-- One watcher row per mutating execution. It binds the deterministic `effect_key` to the run
-- that must later claim the asynchronous business result (order settled, payment received, cart
-- cleared, CSAT scored) and expires on a bounded observation window so unattributed executions
-- become measurable instead of silently lost. `tenant_id` is mandatory and RLS-covered.
CREATE TABLE pending_outcome_attributions (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    skill_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'OBSERVING' CHECK (status IN ('OBSERVING', 'ATTRIBUTED', 'UNATTRIBUTED', 'EXPIRED')),
    outcome_id UUID REFERENCES outcomes(id) ON DELETE SET NULL,
    observation_window_hours INT NOT NULL DEFAULT 72,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '72 hours'),
    attributed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_pending_outcome_effect UNIQUE (tenant_id, effect_key)
);
CREATE INDEX idx_pending_outcome_run ON pending_outcome_attributions (tenant_id, run_id);
CREATE INDEX idx_pending_outcome_expiry ON pending_outcome_attributions (tenant_id, status, expires_at) WHERE status = 'OBSERVING';

-- Runtime Table 2: Effect Reservations (durable idempotency + call reservation).
-- Layer-1 reservation lives in Redis (`tenant:{tid}:effect:{effect_key}`, 72 h). Redis is a
-- cache, not a system of record: when it is unavailable, or when the 72 h window has lapsed,
-- this table is the durable authority that still guarantees at-most-once execution (BR-005,
-- BR-006, NFR-003). `request_id` + `request_fingerprint` make the reservation auditable against
-- the immutable request identity it was derived from.
CREATE TABLE effect_reservations (
    tenant_id UUID NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    request_id VARCHAR(128) NOT NULL,          -- immutable inbound identity (signal_id / message_id / webhook delivery id)
    request_fingerprint CHAR(64) NOT NULL,     -- SHA-256 of the RFC 8785 canonical request payload
    run_id VARCHAR(64) NOT NULL,
    step_index INT NOT NULL,
    skill_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
    response_receipt JSONB,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '72 hours'),
    PRIMARY KEY (tenant_id, effect_key),
    CONSTRAINT uq_effect_reservation_request UNIQUE (tenant_id, request_id, skill_id, step_index)
);
CREATE INDEX idx_effect_reservations_expiry ON effect_reservations (tenant_id, status, expires_at) WHERE status = 'RESERVED';

-- Runtime Table 3: Platform Durable Tasks (§04 4.1 FSM).
-- The durable workflow state that survives worker crashes and restarts. It is the schedule of
-- record for resume/recovery: a leased-but-dead task is re-queued, and a failed task is retried
-- only while retryable and under `max_retries` (§04 4.4). `tenant_id` is UUID and leads every
-- index, matching the platform-wide tenant type contract.
CREATE TYPE task_lifecycle_state AS ENUM (
    'queued', 'running', 'waiting', 'awaiting_human', 'completed', 'stopped', 'failed'
);
CREATE TABLE platform_durable_tasks (
    task_id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    correlation_id VARCHAR(64) NOT NULL,
    current_step INT NOT NULL DEFAULT 1,
    state task_lifecycle_state NOT NULL DEFAULT 'queued',
    task_version INT NOT NULL DEFAULT 1,
    lease_owner VARCHAR(64),
    lease_expires_at TIMESTAMPTZ,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    last_error_class VARCHAR(32), -- 'RETRYABLE' | 'FATAL' | NULL; only RETRYABLE failures are re-queued
    paused_for_approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL,
    state_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_platform_tasks_run UNIQUE (tenant_id, run_id)
);
CREATE INDEX idx_tasks_tenant_state ON platform_durable_tasks (tenant_id, state);
CREATE INDEX idx_tasks_lease ON platform_durable_tasks (state, lease_expires_at) WHERE state IN ('queued', 'running');
CREATE INDEX idx_tasks_correlation ON platform_durable_tasks (tenant_id, correlation_id);

-- Audit Table 2: Evidence Records (cryptographically chained, append-only).
-- §04 6.1 writes one row per mutating step; `previous_evidence_hash` links each
-- record to its predecessor within the run, forming the tamper-evident chain.
CREATE TABLE evidence_records (
    evidence_id VARCHAR(64) PRIMARY KEY,
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    correlation_id VARCHAR(64) NOT NULL,
    step_index INT NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    previous_evidence_hash CHAR(64) NOT NULL, -- chain link to the predecessor's chain_hash
    payload_sha256 CHAR(64) NOT NULL,         -- SHA-256(RFC 8785 canonical raw_payload)
    chain_hash CHAR(64) NOT NULL,             -- SHA-256(previous_evidence_hash | payload_sha256 | effect_key | step_index)
    signature CHAR(64) NOT NULL,              -- HMAC-SHA256 over chain_hash
    raw_payload JSONB NOT NULL,               -- RFC 8785 canonical payload, stored verbatim
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_evidence_records_chain UNIQUE (tenant_id, chain_hash)
);
CREATE INDEX idx_evidence_records_run ON evidence_records (tenant_id, run_id, step_index);

-- Audit Table 3: Audit Records (canonical 18-field chained compliance log, §08 4.1).
-- Deliberately distinct from `agent_run_logs`: this is the GDPR Art. 30 / Taiwan
-- PDPA retention record, chained by `chain_hash` (§08 4.2). Column names mirror the
-- §08 4.1 audit schema verbatim so the compliance writer's INSERT is
-- column-compatible; `timestamp` is the audit event time.
CREATE TABLE audit_records (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    run_id VARCHAR(64) NOT NULL,
    tenant_id UUID NOT NULL,
    agent_id VARCHAR(32) NOT NULL,
    customer_or_entity_id VARCHAR(64) NOT NULL,
    trigger VARCHAR(128) NOT NULL,
    context JSONB NOT NULL,
    skill VARCHAR(64) NOT NULL,
    tool VARCHAR(64) NOT NULL,
    decision JSONB NOT NULL,
    authority VARCHAR(16) NOT NULL,
    approval JSONB,
    action JSONB NOT NULL,
    execution_status VARCHAR(32) NOT NULL CHECK (execution_status IN ('pending', 'executing', 'success', 'failed', 'denied', 'aborted')),
    evidence JSONB NOT NULL,
    outcome JSONB,
    latency_ms INT NOT NULL,
    cost JSONB NOT NULL,
    error JSONB,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    prev_hash CHAR(64) NOT NULL,
    chain_hash CHAR(64) NOT NULL,
    CONSTRAINT uq_audit_records_chain UNIQUE (tenant_id, chain_hash)
);
CREATE INDEX idx_audit_records_tenant_run ON audit_records (tenant_id, run_id, "timestamp" DESC);
CREATE INDEX idx_audit_records_agent ON audit_records (tenant_id, agent_id, "timestamp" DESC);

-- ============================================================================
-- IMMUTABLE AUDIT TRIGGERS (NFR-002 AUDITABILITY)
-- ============================================================================

-- Prevents UPDATE or DELETE on immutable audit trails
CREATE OR REPLACE FUNCTION agentos.prevent_immutable_table_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only and strictly immutable (NFR-002 Auditability Violation)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_immutable_evidences
    BEFORE UPDATE OR DELETE ON evidences
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

CREATE TRIGGER trg_immutable_executions
    BEFORE UPDATE OR DELETE ON executions
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

CREATE TRIGGER trg_immutable_decisions
    BEFORE UPDATE OR DELETE ON decisions
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

-- DOMAIN 5 append-only chains. `approvals` is intentionally excluded: it is the mutable
-- SCR-003 lifecycle whose rows move PENDING -> decided exactly once (and `approval_queue`
-- is only a view over it, so it inherits this mutability through its base table).
-- `platform_durable_tasks` and `effect_reservations` are likewise mutable runtime state.
CREATE TRIGGER trg_immutable_evidence_records
    BEFORE UPDATE OR DELETE ON evidence_records
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

CREATE TRIGGER trg_immutable_audit_records
    BEFORE UPDATE OR DELETE ON audit_records
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

CREATE TRIGGER trg_immutable_agent_run_logs
    BEFORE UPDATE OR DELETE ON agent_run_logs
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();
```

---

### 1.1. Composite Tenant-Scoped Foreign Keys (Cross-Tenant Referential Integrity)

`REFERENCES parent(id)` proves only that the `id` exists somewhere in that table. It says nothing about *whose* row it is, and RLS does not close the gap: a policy filters the row being read or written, never the row being referenced. One wrong join key — or a payload carrying another tenant's `customer_id` — would silently link tenant A's order to tenant B's customer and poison the Customer 360 FACT store. The constraint below moves that guarantee into the schema, where a bug cannot bypass it.

**Convention.** Every intra-tenant relationship is declared over the pair `(tenant_id, <ref>_id)` referencing the parent's `(tenant_id, id)`. Both columns must resolve to a single parent row, so a cross-tenant reference cannot satisfy the constraint and is rejected by the database itself.

```sql
-- 1. Parents expose a tenant-scoped unique key. `id` is already unique, so
--    (tenant_id, id) is a superset key costing one extra index per parent table.
ALTER TABLE agentos.customers     ADD CONSTRAINT uq_customers_tenant_id     UNIQUE (tenant_id, id);
ALTER TABLE agentos.orders        ADD CONSTRAINT uq_orders_tenant_id        UNIQUE (tenant_id, id);
ALTER TABLE agentos.skus          ADD CONSTRAINT uq_skus_tenant_id          UNIQUE (tenant_id, id);
ALTER TABLE agentos.products      ADD CONSTRAINT uq_products_tenant_id      UNIQUE (tenant_id, id);
ALTER TABLE agentos.conversations ADD CONSTRAINT uq_conversations_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.campaigns     ADD CONSTRAINT uq_campaigns_tenant_id     UNIQUE (tenant_id, id);
ALTER TABLE agentos.actions       ADD CONSTRAINT uq_actions_tenant_id       UNIQUE (tenant_id, id);
ALTER TABLE agentos.agents        ADD CONSTRAINT uq_agents_tenant_id        UNIQUE (tenant_id, id);
ALTER TABLE agentos.workflows     ADD CONSTRAINT uq_workflows_tenant_id     UNIQUE (tenant_id, id);
-- ... one statement per table that is the target of a composite FK.

-- 2. Children reference the pair, never the bare id. The single-column FKs
--    declared in §1 are upgraded in place.
ALTER TABLE agentos.customer_identities
    DROP CONSTRAINT customer_identities_customer_id_fkey,
    ADD  CONSTRAINT fk_identities_customer FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE agentos.orders
    DROP CONSTRAINT orders_customer_id_fkey,
    ADD  CONSTRAINT fk_orders_customer FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id);
```

The DDL in §1 declares the entity graph with single-column `REFERENCES` for readability; this tenant-scoping migration runs immediately afterwards, before the first tenant row is written. `packages/database/migrations/0001_tenant_scoped_fks.sql` is its durable home under the package owner in `02` §5 and executes inside the same migration transaction that created the schema.

**Negative tests are mandatory.** A green happy path proves nothing here — a *missing* foreign key also accepts every legal insert. The suite must assert each cross-tenant case below by inserting an otherwise-valid row whose tenant differs from the referenced row's tenant, and must observe SQLSTATE `23503`:

| Test | Scenario | Expected Assertion |
|---|---|---|
| `TC-RLS-FK-001` | Insert an `orders` row with `tenant_id = B` whose `customer_id` belongs to tenant A. | `23503 foreign_key_violation`; row rejected. |
| `TC-RLS-FK-002` | Update `customer_identities.customer_id` to a customer owned by another tenant. | `23503 foreign_key_violation`; UPDATE rejected. |
| `TC-RLS-FK-003` | Insert a `recommendations` row referencing another tenant's `product_id`. | `23503 foreign_key_violation`; row rejected. |
| `TC-RLS-FK-004` | Insert a `service_cases` row referencing another tenant's `conversation_id`. | `23503 foreign_key_violation`; row rejected. |
| `TC-RLS-FK-005` | Regression control: the same insert with a same-tenant reference. | Row accepted — proves the constraint does not over-block. |

---

### 1.2. Epistemic Write Boundary and SoR-Mirror Protection

`[SRS-MUST][SRS §5 / FR-C360-003]` AI hypotheses must never be written back as customer facts (SRS §5: "Giả thuyết AI không được ghi ngược thành Customer Fact"). This table is the persistence-side enforcement contract for that rule; the runtime guard lives in `./04-core-engine-and-orchestrator.md` §1.1 invariant 2 and §3.3 `enforceEpistemicSeparation()`.

| Value class | Persisted in | May be written by | Write-back to an SoR mirror or `customers` FACT |
|---|---|---|---|
| `FACT` | `customers` and SoR-mirror tables (`products`, `skus`, `prices`, `inventories`, `orders`, `invoices`); only explicitly sourced FACT fields of the mixed-class `customer_360_profiles` read projection | the owning SoR sync/adapter path only; the projection is not a FACT write target | n/a — AI writers are not present in these mirror write paths |
| `SIGNAL` | `customer_events`, `conversations`/`conversation_messages` | API-002 ingestion and channel adapters | never |
| `HYPOTHESIS` | `evidences` rows with `taxonomy_type = 'HYPOTHESIS'`; derived projections that carry the `_hypothesis` suffix (`customer_360_profiles.rfm_segment_hypothesis`, `leads` scoring fields, `segments` membership, `recommendations`) | hypothesis-producing skills and the orchestrator | **refused** — a HYPOTHESIS value MUST NOT be promoted to FACT or written into any SoR mirror without authoritative SoR validation |
| `DECISION` | `decisions`, `approvals`, `campaigns`, `offers`, `service_cases` | orchestrator/policy engine, human approval | n/a (no SoR mirror) |
| `ACTION` | `actions`, `executions` | orchestrator effect pipeline | n/a (no SoR mirror) |

**Enforcement rules.**

1. A derived attribute is persisted with an explicit `_hypothesis` suffix or an `evidences` row of class `HYPOTHESIS` — never as a bare FACT column. The `customer_360_profiles` view exposes `rfm_segment_hypothesis` for exactly this reason.
2. Promotion from `HYPOTHESIS` to `FACT` requires a System-of-Record validation record (an `evidences` row whose `source_uri` names the SoR record and whose `verified_by` names the validating component); there is no direct-write path from an AI skill into a mirror table.
3. `skills.epistemic_class` declares the class a skill produces; a `HYPOTHESIS`-class skill is registered with no SoR-mirror write capability, and the PEP refuses a call whose declared class does not match its connector binding.
4. Raw conversation text is never promoted into long-term FACT or Organizational Knowledge (SRS §16); it stays in `conversation_messages` under the retention decision of ASM-005 (§7).

---

## 2. Row-Level Security (RLS) Policy Implementation

To satisfy **NFR-006 (Zero Data Bleeding)**, Row-Level Security is strictly enabled and forced across every table in the `agentos` schema — the 28 canonical tables, the child table `conversation_messages`, and the DOMAIN 5 audit/runtime tables (`audit_records`, `evidence_records`, `agent_run_logs`, `platform_durable_tasks`, `pending_outcome_attributions`, `effect_reservations`). The two views (`customer_360_profiles`, `approval_queue`) are not tables and therefore carry no policy of their own; both are declared `WITH (security_invoker = true)` so the policies of their base tables are evaluated against the calling role. Queries that omit a valid tenant context return 0 rows (default deny) or throw an error.

**Predicate contract.** The tenant context is a comma-separated list of UUIDs stored in `app.current_tenant_id`, parsed with `string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]`. The explicit `::uuid[]` cast is what keeps the predicate type-correct: `tenant_id` is `UUID`, the parsed value is `UUID[]`, so PostgreSQL resolves `uuid = ANY(uuid[])` and never has to resolve `uuid = text` (which has no operator and would raise `operator does not exist: uuid = text`). An unset setting yields `NULL`, and an empty setting yields the empty array — both make `= ANY(...)` evaluate to NULL/FALSE, so the failure mode is deny, never allow.

```sql
-- ============================================================================
-- ROW-LEVEL SECURITY CONFIGURATION (NFR-006)
-- ============================================================================

-- Function to apply RLS policies automatically to all tables in schema
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'agentos'
    LOOP
        -- Enable and force RLS on table
        EXECUTE format('ALTER TABLE agentos.%I ENABLE ROW LEVEL SECURITY;', tbl);
        EXECUTE format('ALTER TABLE agentos.%I FORCE ROW LEVEL SECURITY;', tbl);

        -- Drop existing policy if present
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON agentos.%I;', tbl);

        -- Create strictly scoped tenant policy for SELECT, INSERT, UPDATE, DELETE (PERMISSIVE model).
        -- `string_to_array(...)::uuid[]` keeps the comparison uuid = uuid (never uuid = text),
        -- and an unset/empty setting resolves to NULL/{} = default deny.
        EXECUTE format('
            CREATE POLICY tenant_isolation_policy ON agentos.%I
            AS PERMISSIVE
            FOR ALL
            USING (tenant_id = ANY (string_to_array(current_setting(''app.current_tenant_id'', true), '','')::uuid[]))
            WITH CHECK (tenant_id = ANY (string_to_array(current_setting(''app.current_tenant_id'', true), '','')::uuid[]));
        ', tbl);
    END LOOP;
END $$;
```

### TypeScript Database Connection Context Wrapper (`packages/database/src/rls.ts`)

```typescript
import { Pool, PoolClient } from 'pg';

export const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: Number(process.env.DATABASE_POOL_MIN || 5),
  max: Number(process.env.DATABASE_POOL_MAX || 20),
});

/**
 * Executes a callback within a scoped database transaction where the
 * PostgreSQL session variable `app.current_tenant_id` is guaranteed.
 *
 * This wrapper is the ONLY sanctioned way to touch tenant data. It is the
 * canonical binder referenced by every repository, skill, and Core Engine writer
 * (§04 5.1 / 6.1), so a query that is executed outside of it simply returns zero
 * rows instead of leaking another tenant's rows.
 *
 * @param tenantId - The authenticated UUID of the tenant (UUID v7 string)
 * @param callback - Function executing queries within the scoped connection
 */
export async function withTenantContext<T>(
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!tenantId) {
    throw new Error('TENANT_CONTEXT_REQUIRED: refusing to open an unscoped database transaction (NFR-006).');
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // Bind the transaction-local RLS context.
    // `set_config(name, value, is_local)` is the parameterised form of `SET LOCAL`
    // and the only way to bind the tenant UUID as a placeholder: PostgreSQL's
    // extended query protocol rejects `SET LOCAL ... = $1` (SET accepts no
    // parameters), so `SELECT set_config(...)` is used instead.
    // `is_local = true` scopes the value to this transaction: PostgreSQL resets it
    // at COMMIT/ROLLBACK, so a connection returned to the pool can never carry the
    // previous tenant's context (the property the transaction-pooling mode relies on).
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## 3. Redis Schema & Mutex Key Specifications

Redis 7.2 serves as Layer 1 (Working Memory) and the distributed concurrency coordinator. All keys are prefixed by `tenant:{tenant_id}` to prevent cross-tenant cache contamination.

### Key Naming Conventions

| Key Pattern | Data Type | TTL | Purpose |
|---|---|---|---|
| `tenant:{tid}:session:{sid}:mutex` | String | 30 seconds | Prevents multiple AI agents from replying concurrently to the same customer. |
| `tenant:{tid}:session:{sid}:takeover_lock` | String | 60 seconds, renewed every 30 seconds (extend request 1–300 seconds) | Human operator override lease (SCR-005). Pauses all automated agent execution; expiry or explicit resume releases control. The wire contract is authoritative; a crashed console cannot hold a conversation indefinitely. |
| `tenant:{tid}:effect:{effect_key}` | String (JSON) | 259,200s (72h) | Distributed idempotency record. Holds payload hash and execution status (NFR-003). |
| `tenant:{tid}:task:{run_id}:lease` | String | 30 seconds, renewed at TTL/3 | Durable-task worker lease fast path (§04 4.3). The authoritative schedule of record is `platform_durable_tasks`; a Redis flush loses no task, and `task.claim` re-validates ownership. |
| `tenant:{tid}:ratelimit:{entity}:{window}` | Integer | Window expiry | Sliding window token counter for rate limiting (e.g. 100 req/min). `[PROVISIONAL][ASM-002]` — the quoted rate is illustrative, not an approved policy value. |
| `tenant:{tid}:wm:{sid}` | List / Hash | 2 hours `[PROVISIONAL][ASM-005]` | Transient prompt scratchpad and dialog turn state (Memory Layer 1). Keyed by the unique server-issued `session_id` (`{sid}`), never by an unverified customer handle; the Core Engine hydrator reads exactly this key (§04 5.1 `fetchWorkingMemory`, §7). |

### Distributed Mutex Lock Acquisition & Release (Lua Scripts)

```typescript
import Redis from 'ioredis';

export const redisClient = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
});

/**
 * Atomically acquires a session mutex using Redis SET NX PX.
 */
export async function acquireSessionMutex(
  tenantId: string,
  sessionId: string,
  lockOwnerToken: string,
  ttlMs: number = 30000
): Promise<boolean> {
  const key = `tenant:${tenantId}:session:${sessionId}:mutex`;
  const result = await redisClient.set(key, lockOwnerToken, 'PX', ttlMs, 'NX');
  return result === 'OK';
}

/**
 * Atomically releases the session mutex only if the caller owns the lock token.
 */
export async function releaseSessionMutex(
  tenantId: string,
  sessionId: string,
  lockOwnerToken: string
): Promise<boolean> {
  const key = `tenant:${tenantId}:session:${sessionId}:mutex`;
  const luaReleaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  const result = await redisClient.eval(luaReleaseScript, 1, key, lockOwnerToken);
  return result === 1;
}
```

### Idempotency Key Engine (`effect_key` with 72-Hour TTL)

```typescript
import { createHash } from 'crypto';

export interface IdempotencyReservation {
  isNew: boolean;
  status: 'PENDING' | 'RESOLVED';
  cachedResponse?: unknown;
}

/**
 * Reserves or checks an effect_key within Redis for 72 hours (259,200 seconds).
 * Ensures that redundant webhooks or retried requests execute at most once (NFR-003).
 */
export async function reserveEffectKey(
  tenantId: string,
  effectKey: string,
  payload: unknown
): Promise<IdempotencyReservation> {
  const key = `tenant:${tenantId}:effect:${effectKey}`;
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const initialValue = JSON.stringify({
    status: 'PENDING',
    hash: payloadHash,
    createdAt: new Date().toISOString(),
  });

  // Atomic SET NX with 72h TTL (259,200 seconds)
  const setSuccess = await redisClient.set(key, initialValue, 'EX', 259200, 'NX');

  if (setSuccess === 'OK') {
    return { isNew: true, status: 'PENDING' };
  }

  // Key already exists: check payload consistency
  const existingRaw = await redisClient.get(key);
  if (!existingRaw) {
    return { isNew: true, status: 'PENDING' };
  }

  const existing = JSON.parse(existingRaw) as { status: 'PENDING' | 'RESOLVED'; hash: string; response?: unknown };
  if (existing.hash !== payloadHash) {
    throw new Error(`IDEMPOTENCY_CONFLICT: Key '${effectKey}' was already used with a different request payload.`);
  }

  return {
    isNew: false,
    status: existing.status,
    cachedResponse: existing.response,
  };
}
```

---

## 4. Qdrant Vector Collection Schema (Second Brain 8-Folder Hierarchy)

The Second Brain knowledge architecture organizes approved company policies, playbooks, and catalogs into 8 discrete namespaces:
1. `company`
2. `customer`
3. `product`
4. `brand`
5. `marketing`
6. `sales`
7. `customer-care`
8. `policy`

### Qdrant Collection Configuration & Ingestion Schema (Hybrid Search: Dense + Sparse)

The knowledge collection utilizes **Hybrid Search** combining dense vectors (1536 dimensions, text-embedding-3-small) for conceptual semantic search and sparse vectors (BM25/SPLADE) for exact SKU codes, technical specifications, and legal terminology. Each point stores rich JSON payload metadata for strict filtering on `tenant_id` and `document_status = 'approved'`.

```json
{
  "collection_name": "second_brain_knowledge",
  "vectors": {
    "dense": {
      "size": 1536,
      "distance": "Cosine",
      "on_disk": true
    }
  },
  "sparse_vectors": {
    "sparse_text": {
      "index": {
        "on_disk": true
      }
    }
  },
  "hnsw_config": {
    "m": 16,
    "ef_construct": 100,
    "full_scan_threshold": 10000
  },
  "optimizers_config": {
    "indexing_threshold": 20000
  }
}
```

### Required Payload Indexes in Qdrant

```bash
# Execute via Qdrant REST API to enable sub-millisecond filtering
curl -X PUT "http://localhost:6333/collections/second_brain_knowledge/index" \
  -H "api-key: qdrant_dev_secret_api_key" \
  -H "Content-Type: application/json" \
  -d '{ "field_name": "tenant_id", "field_schema": "keyword" }'

curl -X PUT "http://localhost:6333/collections/second_brain_knowledge/index" \
  -H "api-key: qdrant_dev_secret_api_key" \
  -H "Content-Type: application/json" \
  -d '{ "field_name": "namespace", "field_schema": "keyword" }'

curl -X PUT "http://localhost:6333/collections/second_brain_knowledge/index" \
  -H "api-key: qdrant_dev_secret_api_key" \
  -H "Content-Type: application/json" \
  -d '{ "field_name": "document_status", "field_schema": "keyword" }'

curl -X PUT "http://localhost:6333/collections/second_brain_knowledge/index" \
  -H "api-key: qdrant_dev_secret_api_key" \
  -H "Content-Type: application/json" \
  -d '{ "field_name": "file_path", "field_schema": "keyword" }'
```

### Strict Multi-Tenant Vector Search Query Example

Every vector retrieval strictly filters by `tenant_id` and enforces `document_status = "approved"`. Unapproved drafts are strictly excluded from agent retrieval context.

```typescript
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

export interface KnowledgeChunkPayload {
  tenant_id: string;
  namespace: 'company' | 'customer' | 'product' | 'brand' | 'marketing' | 'sales' | 'customer-care' | 'policy';
  file_path: string;
  source_version: string;
  document_status: 'draft' | 'review' | 'approved';
  owner: string;
  heading: string;
  chunk_index: number;
  text_content: string;
  updated_at: string;
}

/**
 * Searches Second Brain knowledge with strict tenant isolation and approval enforcement.
 */
export async function searchSecondBrain(
  tenantId: string,
  namespace: KnowledgeChunkPayload['namespace'],
  queryVector: number[],
  limit: number = 3
) {
  return await qdrant.search('second_brain_knowledge', {
    vector: queryVector,
    limit,
    filter: {
      must: [
        { key: 'tenant_id', match: { value: tenantId } },
        { key: 'namespace', match: { value: namespace } },
        { key: 'document_status', match: { value: 'approved' } }, // Anti-hallucination rule
      ],
    },
    with_payload: true,
  });
}
```

## 5. Canonical Entity, Field, and Evidence Catalog `[SRS-MUST][SRS §14 / owner: 03]`

The DDL above is the target persistence contract. The canonical ordinal is the SRS ordinal; implementation summaries MUST NOT introduce a second numbering system. In particular, `Campaign` is Entity 14 and `Segment` is Entity 15. Every object is tenant-scoped, and every cross-entity reference uses the composite tenant-safe convention in §1.1.

| Entity | Target table/object | Primary identity | Required identity/lifecycle rule | Value class / owner |
|---|---|---|---|---|
| Customer | `customers` | `(tenant_id,id)` | SoR-mirrored identity; immutable source identity | FACT / `03` |
| Customer Identity | `customer_identities` | `(tenant_id,id)` | normalized identifier plus verification provenance | FACT / `03` |
| Consent | `consents` | `(tenant_id,id)` | append history; current status cannot erase prior consent | FACT / `03` |
| Customer Event | `customer_events` | `(tenant_id,id)` | immutable event with `occurred_at`, source, idempotency | SIGNAL / `03` |
| Product | `products` | `(tenant_id,id)` | catalog identity from SoR; no AI-created SKU | FACT / `03` |
| SKU | `skus` | `(tenant_id,id)` | product child identity; source reference required | FACT / `03` |
| Price | `prices` | `(tenant_id,id)` | effective-dated SoR mirror with floor provenance | FACT / `03` |
| Inventory | `inventories` | `(tenant_id,id)` | source and observed time required; stale values cannot authorize | FACT / `03` |
| Order | `orders` | `(tenant_id,id)` | effect/SoR reference and immutable order identity | FACT / `03` |
| Invoice | `invoices` | `(tenant_id,id)` | SoR receipt reference; append financial history | FACT / `03` |
| Conversation | `conversations` | `(tenant_id,id)` | session/channel mutex and lifecycle state | SIGNAL / `03` |
| Lead | `leads` | `(tenant_id,id)` | score carries reason/evidence and inference class | HYPOTHESIS / `03` |
| Opportunity | `opportunities` | `(tenant_id,id)` | stage transitions audited; revenue is SoR-backed when actual | HYPOTHESIS/FACT / `03` |
| Campaign | `campaigns` | `(tenant_id,id)` | draft → approval → dispatch lifecycle; AUTH-4 route where required | DECISION / `03` |
| Segment | `segments` | `(tenant_id,id)` | derived membership is recomputable and not FACT | HYPOTHESIS / `03` |
| Offer | `offers` | `(tenant_id,id)` | policy-bound, floor-provenance-bearing, quota audited | DECISION / `03` |
| Recommendation | `recommendations` | `(tenant_id,id)` | reason/evidence required; no inference promoted to FACT | HYPOTHESIS / `03` |
| Service Case | `service_cases` | `(tenant_id,id)` | seven stored states plus `REOPEN` action | DECISION / `03` |
| Agent | `agents` | `(tenant_id,id)` | only AUTH-0..AUTH-3 assigned grants | DECISION / `03` |
| Skill | `skills` | `(tenant_id,id)` | exactly 23 platform registry rows; required AUTH-4 routes approval | DECISION / `03` + `05` |
| Workflow | `workflows` | `(tenant_id,id)` | durable versioned definition and state | DECISION / `03` + `04` |
| Decision | `decisions` | `(tenant_id,id)` | reason, evidence, policy version, verdict | DECISION / `03` + `08` |
| Action | `actions` | `(tenant_id,id)` | payload digest/effect key before dispatch | ACTION / `03` + `04` |
| Approval | `approvals` | `(tenant_id,id)` | one-time binding to run/effect; PENDING queue view | DECISION / `03` + `07` |
| Execution | `executions` | `(tenant_id,id)` | provider receipt/status; UNKNOWN reconciles | ACTION / `03` + `06` |
| Evidence | `evidences` | `(tenant_id,id)` | source URI/version and explicit `taxonomy_type`; immutable grounding record | FACT/SIGNAL/HYPOTHESIS/DECISION/ACTION / `03` |
| Outcome | `outcomes` | `(tenant_id,id)` | attributed to effect/run with source evidence | FACT / `03` + `04` |
| Learning | `learnings` | `(tenant_id,id)` | versioned observations and outcome references; activation is audited and retention-owned | HYPOTHESIS / `03` + `04` |

Required fields are immutable where they identify a source record, tenant, subject, event time, effect key, or evidence predecessor. Updates to mutable workflow/approval state MUST be versioned and audited. Raw conversation text and `HYPOTHESIS` values MUST NOT be promoted to long-term FACT or Organizational Knowledge without authoritative validation.

## 6. Tenant, Subject, and Memory Isolation Matrix `[SRS-MUST][SRS §9, §14, §19 / NFR-006]`

| Boundary | Required binding | Missing binding behavior |
|---|---|---|
| PostgreSQL | `tenant_id`, RLS session context, composite tenant-scoped FKs | transaction rejected; context reset between requests |
| Customer/session | verified `customer_id` or unique server-issued `session_id` | private lookup refused; anonymous session gets isolated bucket |
| Redis | `tenant:{tenant_id}:...` plus session/customer suffix | key operation refused; no global fallback |
| Qdrant | `tenant_id`, approved namespace/document filter | retrieval unavailable/refused; no unfiltered search |
| API/event | signed/authenticated tenant context and idempotency key | 401/403/409; no agent routing |

## 7. Five-Layer Memory Contract `[SRS-MUST][SRS §16; §10 / NFR-005, NFR-006]`

| Layer | Target storage/key | Writer / reader | Lifetime / retention owner | Allowed content |
|---|---|---|---|---|
| Working Memory | Redis `tenant:{tid}:wm:{session_id}` | orchestrator / current run | session TTL `[PROVISIONAL][ASM-005]` | current turn, unresolved task, bounded scratch data |
| Customer Context | PostgreSQL projections + scoped cache | context aggregator / authorized skills and UI | tenant policy `[UNCONFIRMED][ASM-005]` | verified customer FACTs, consent, relevant events |
| Organizational Knowledge | Qdrant approved namespace payloads | knowledge ingestion / all retrieval skills | document owner `[UNCONFIRMED][ASM-005]` | approved policy, product, brand, playbook facts |
| Agent Operational Memory | PostgreSQL/Redis run summaries | orchestrator / supervisor and agent runtime | operational retention `[UNCONFIRMED][ASM-005]` | tool outcomes, failure patterns, run metadata |
| Learning Memory | `learnings` observations linked to immutable `evidences`/`outcomes` | outcome attribution / future evaluation | Business/Finance + Data owner `[UNCONFIRMED][ASM-005]` | validated outcome signals and versioned hypotheses; activation changes audited |

Raw conversation and HYPOTHESIS content stays in its declared short-lived/evidence class. It MUST NOT silently become FACT or Organizational Knowledge.

## 8. Ten-Stage Timeline Projection `[SRS-MUST][SRS §5 / FR-C360-002; §15 / API-002 / owner: 03]`

The Customer 360 projection exposes the unified stages `View`, `Search`, `Click`, `Chat`, `Add to cart`, `Purchase`, `Delivery`, `Support`, `Review`, and `Repurchase`. API-002 keeps the seven SRS canonical events `session`, `product_view`, `search`, `click`, `add_to_cart`, `checkout`, and `purchase`; the remaining timeline stages are derived from source events/SoR records.

| Timeline stage | Canonical event/source mapping | Required projection fields |
|---|---|---|
| View | `product_view` / `customer_events` | `occurred_at`, `source_record_id`, ordering key, dedup key |
| Search | `search` / `customer_events` | same |
| Click | `click` / `customer_events` | same |
| Chat | `session` + conversation/message records | same plus `conversation_id` |
| Add to cart | `add_to_cart` / cart boundary | same plus `cart_id` |
| Purchase | `purchase` or `checkout` resolved by API-001 order | same plus `order_id` |
| Delivery | order/shipment provider event | same plus `shipment_id` |
| Support | service case/conversation event | same plus `case_id` |
| Review | review provider/SoR event | same plus `review_id` |
| Repurchase | subsequent order joined to prior customer/SKU | same plus source order reference |

Ordering uses `(occurred_at, source_record_id, event_id)`; deduplication uses the source event id or deterministic source-record key. Late events are retained and reprojected; replay is idempotent. SCR-004 reads this projection and labels FACT/SIGNAL/HYPOTHESIS/DECISION/ACTION distinctly.

## 9. Service Case FSM and Migration Contract `[SRS-MUST][SRS §8 / owner: 03]`

Stored states are exactly `NEW`, `CLASSIFIED`, `ASSIGNED`, `IN_PROGRESS`, `WAITING_CUSTOMER`, `RESOLVED`, and `CLOSED`. `REOPEN` is an action/event, not an eighth stored state: `RESOLVED` or `CLOSED` → `IN_PROGRESS`, incrementing `reopen_count`, recording `reopened_at`, appending SLA history and evidence. Illegal transitions fail with a domain error and create no state mutation. The downstream `REOPENED` proposal remains a known propagation conflict in plans/testcases and is not adopted here.

The seven baseline states come from SRS §8; the allowed edges and `REOPEN` below are blueprint refinements. Every change requires the same tenant/customer binding, the expected `case_version`, an authorized owner, and an audit/evidence reference. Successful changes increment `case_version`; stale versions return conflict without another transition.

| Current state | Allowed action → next state | Required input / retained history |
|---|---|---|
| `NEW` | classify → `CLASSIFIED` | recognized intent/category, priority, source conversation |
| `CLASSIFIED` | assign → `ASSIGNED` | agent or human owner and SLA policy reference |
| `ASSIGNED` | begin work → `IN_PROGRESS` | accepting owner and start timestamp |
| `IN_PROGRESS` | request customer input → `WAITING_CUSTOMER`; resolve → `RESOLVED` | question or resolution plus evidence; SLA accounting retained |
| `WAITING_CUSTOMER` | receive input → `IN_PROGRESS`; resolve → `RESOLVED` | source reply or evidenced resolution; no timeout-implied success |
| `RESOLVED` | close → `CLOSED`; `REOPEN` → `IN_PROGRESS` | closure decision or reopen reason/new SLA window |
| `CLOSED` | `REOPEN` → `IN_PROGRESS` | reopen reason, same case/customer/order identity and history |

Assignment, priority, and evidence updates may leave state unchanged but still require the expected version and audit. Every unlisted transition is `INVALID_FSM_TRANSITION`; a duplicate transition request returns its recorded result, while a new request with an obsolete version conflicts. No state transition creates an order/refund or bypasses its separate approval contract.

Migration order is extension/schema → tables/keys → indexes → RLS enable/force → policies → canonical registry seeds → derived views/backfills. Each migration is transactional where PostgreSQL permits; append-only audit/evidence cannot be destructively rolled back. Partial migration recovery resumes from the last committed version, with operator-reviewed compensating migration for irreversible append-only writes. The authoritative runtime task state is the stored `task_lifecycle_state` enum (`queued`, `running`, `waiting`, `awaiting_human`, `completed`, `stopped`, `failed`); `UNKNOWN` is an effect/reconciliation outcome represented by `waiting` plus an open `effect_reservations` row, not a stored task enum value.

### 9.1 Canonical persistence objects and projections `[BLUEPRINT][SRS §14, §17]`

The 28 canonical SRS entities remain `customers` through `learnings` in §1. DOMAIN 5 objects are additional runtime/audit projections, not replacement entities. Entity 26 is `evidences` (grounding taxonomy); `evidence_records` is the separate immutable per-run cryptographic payload chain keyed by `evidence_id`. Entity 27 is `outcomes`; `pending_outcome_attributions` is its observation watcher. Entity 28 is `learnings`; there is no `learning_records` table or alias.

The same rule applies to `agent_run_logs` versus `audit_records`: the former is the per-step six-status operational run log; the latter is the canonical 18-field compliance chain. A route, UI, skill, or test MUST identify which object it reads or writes; no alias may create a second writer or bypass tenant/RLS/append-only rules.

Registry serialization maps runtime `skill_id` to `skills.name`, `tool_binding` to `skills.connector_name`, and enablement to `skills.is_active`; the other §05 contract fields retain their names. Seeds use the 23 canonical dot-notated IDs, never a second hyphenated registry.

Wire projections are explicit: stored conversation `open`/`paused_takeover`/`closed` maps to `ACTIVE`/`HUMAN_TAKEOVER`/`CLOSED`; stored task `queued` maps to R02/R03 `accepted` while R16 reports `queued`. Other task states keep their spelling. Approval `PENDING` with `is_paused=TRUE` renders `PAUSED` and stays undecided; the task remains `awaiting_human`. These projections do not add stored enum values.


## 10. Verification Scenarios `[BLUEPRINT][SRS §14, §19 / NFR-003, NFR-006]`

Future verification MUST cover cross-tenant composite-FK rejection; RLS context reset; memory-layer separation and expiry; ten-stage timeline reconstruction with late/replayed events; refusal to promote HYPOTHESIS to FACT; every legal/illegal Service Case transition including REOPEN; migration ordering and partial recovery; and uniqueness of tenant/effect/idempotency keys. These scenarios are `[NOT-RUNTIME-EVIDENCE]` until executed against the future runtime.
