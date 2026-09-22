-- =============================================================================
-- GATE P0 — DURABLE POSTGRESQL FOUNDATION (PostgreSQL 16)
-- Owner: packages/database. Source of truth: implement/03 §1 DOMAIN 5 + §1.1,
-- §1.2, §2 (RLS), and implement/04 §4.2 (durable task / approval binding).
-- =============================================================================
-- PostgreSQL is the durable authority for idempotency, task state, approvals and
-- the append-only evidence/audit chains (BR-005, BR-006, NFR-002, NFR-003).
-- A cache (Redis) may front reservations and leases, but it never decides
-- idempotency and never becomes the schedule of record.
--
-- Rehearsal contract (packages/database/scripts/rehearse-migrations.mjs):
--   * Applied as ONE transaction per file, in lexical order, and then replayed;
--     this file carries no BEGIN/COMMIT of its own because the runner owns the
--     transaction boundary (a nested BEGIN/COMMIT would silently split it).
--   * Idempotent for a fresh database: every statement is IF NOT EXISTS,
--     CREATE OR REPLACE, or DROP ... IF EXISTS, so a replay is a no-op.
--   * Every object is schema-qualified with `agentos.`; the file writes no
--     session state (no SET/search_path) that could leak to the next file.
--
-- P0 boundary. Only the durable/runtime subset the Gate P0 engine needs is here:
-- the `agentos` schema + helpers, the FACT store `customers` and the evidence
-- ledger `evidences` (the pair that separates FACT from HYPOTHESIS), `actions`,
-- `approvals` plus the security-invoker `approval_queue` view,
-- `effect_reservations`, `platform_durable_tasks`, `evidence_records`,
-- `audit_records`, and `agent_run_logs`. The P1 canonical/business entities
-- (campaigns, segments, products, skus, prices, inventories, orders, invoices,
-- conversations, customers' identities/consents/events, leads, opportunities,
-- offers, recommendations, service_cases, agents, skills, workflows, decisions,
-- executions, outcomes, learnings) and every connector, credential, or seeded
-- business row stay out of migrations/ until a task that owns them lands their
-- DDL. Two foreign keys are therefore deferred on purpose and left as bare UUID
-- columns: `actions.decision_id` (decisions) and `approvals.campaign_id`
-- (campaigns).
--
-- Tenant isolation (NFR-006). Every table carries `tenant_id UUID NOT NULL`;
-- every intra-tenant relationship is a composite `(tenant_id, <ref>_id)` foreign
-- key onto the parent's `(tenant_id, id)` so a cross-tenant reference is refused
-- by the database itself (implement/03 §1.1); and the closing RLS block ENABLEs
-- and FORCEs `tenant_isolation_policy` on every table of the schema. The
-- predicate reads the transaction-local `app.current_tenant_id` bound by
-- `withTenantContext()` (src/rls.ts). An unbound or empty context resolves to
-- NULL/{} and denies reads and writes alike (§2).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. EXTENSION + SCHEMA
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS agentos;

-- `agentos.uuid_generate_v7()` needs `gen_random_bytes()` from pgcrypto. Install
-- it only when it is missing: the local/CI bootstrap already provides it
-- (docker/postgres/init.sql), and re-issuing CREATE EXTENSION would demand
-- database-level CREATE privilege from the migrating role for no gain.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
        CREATE EXTENSION pgcrypto;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. HELPERS
-- -----------------------------------------------------------------------------

-- Read path for the same transaction-local GUC the policies evaluate. The
-- policies inline the setting expression (a policy predicate cannot call a
-- function without paying for it on every row); this helper is the accessor for
-- application SQL. `missing_ok = true` yields NULL instead of raising when no
-- transaction has bound a context, so an unbound context stays a denied read.
CREATE OR REPLACE FUNCTION agentos.current_tenant_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;

-- UUID v7 identity factory (RFC 9562, time-ordered; implement/03 §1). Bytes 0-5
-- carry the big-endian Unix-millisecond timestamp, the high nibble of byte 6 is
-- the version, and byte 8 is masked to the RFC 4122 variant. The timestamp
-- prefix keeps primary-key inserts append-mostly and makes `ORDER BY id` equal
-- `ORDER BY created_at`. `tenant_id` is issued at tenant provisioning and is
-- never generated per row.
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
    b := SET_BYTE(b, 6, (7 << 4) | (GET_BYTE(b, 6) & 15));   -- version 7
    b := SET_BYTE(b, 8, (GET_BYTE(b, 8) & 63) | 128);        -- variant RFC 4122
    RETURN ENCODE(b, 'hex')::UUID;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Append-only guard (NFR-002). Installed as a BEFORE UPDATE OR DELETE trigger on
-- every immutable table (section 7); a mutation of a committed evidence/audit
-- row raises instead of silently rewriting the trail.
CREATE OR REPLACE FUNCTION agentos.prevent_immutable_table_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only and strictly immutable (NFR-002 Auditability Violation)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Durable workflow lifecycle (implement/04 §4.1). Closed set: 'UNKNOWN' is an
-- effect/reconciliation outcome, never a task state, so it is not a member.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'agentos' AND t.typname = 'task_lifecycle_state'
    ) THEN
        CREATE TYPE agentos.task_lifecycle_state AS ENUM (
            'queued', 'running', 'waiting', 'awaiting_human', 'completed', 'stopped', 'failed'
        );
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. FACT STORE + EPISTEMIC LEDGER (minimal P0 subset of implement/03 DOMAIN 1)
-- -----------------------------------------------------------------------------

-- `customers` is the System-of-Record FACT mirror. The P0 shape is deliberately
-- minimal and carries no derived attribute column, so a HYPOTHESIS can only be
-- persisted as an `evidences` row with taxonomy_type = 'HYPOTHESIS'; there is no
-- bare FACT column to write a hypothesis into (implement/03 §1.2).
CREATE TABLE IF NOT EXISTS agentos.customers (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    external_crm_id VARCHAR(128),
    primary_phone VARCHAR(64),
    primary_email VARCHAR(255),
    display_name VARCHAR(255),
    verification_status VARCHAR(32) NOT NULL DEFAULT 'unverified'
        CHECK (verification_status IN ('unverified', 'verified', 'vip')),
    customer_tier VARCHAR(32) NOT NULL DEFAULT 'standard',
    total_spent NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    order_count INT NOT NULL DEFAULT 0,
    last_interaction_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_customers_tenant_crm UNIQUE (tenant_id, external_crm_id),
    -- Tenant-scoped parent key for the composite foreign keys below (§1.1).
    CONSTRAINT uq_customers_tenant_id UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_search
    ON agentos.customers (tenant_id, primary_phone, primary_email);

-- `evidences` is the only home of HYPOTHESIS values and the provenance record of
-- FACTs. `taxonomy_type` is a closed five-value vocabulary; `source_uri`,
-- `source_version`, and `verified_by` are NOT NULL, so no claim enters the ledger
-- without naming its source and verifier. The table is append-only (section 7):
-- promoting a HYPOTHESIS to FACT appends a new row naming the validating SoR
-- record instead of mutating the hypothesis (§1.2 rule 2).
CREATE TABLE IF NOT EXISTS agentos.evidences (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    customer_id UUID,
    run_id VARCHAR(128) NOT NULL,
    taxonomy_type VARCHAR(32) NOT NULL
        CHECK (taxonomy_type IN ('FACT', 'SIGNAL', 'HYPOTHESIS', 'DECISION', 'ACTION')),
    claim TEXT NOT NULL,
    source_uri VARCHAR(255) NOT NULL,
    source_version VARCHAR(64) NOT NULL,
    conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Composite tenant-scoped FK: a customer reference from another tenant
    -- cannot satisfy (tenant_id, id) and is rejected with SQLSTATE 23503.
    CONSTRAINT fk_evidences_customer FOREIGN KEY (tenant_id, customer_id)
        REFERENCES agentos.customers (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_evidences_taxonomy
    ON agentos.evidences (tenant_id, customer_id, taxonomy_type);

-- -----------------------------------------------------------------------------
-- 3. ACTION + APPROVAL (implement/03 DOMAIN 4 Entities 23/24, implement/04 §4.2)
-- -----------------------------------------------------------------------------

-- A prepared outgoing command. `effect_key` is the deterministic idempotency
-- identity of the command and is unique per tenant. `action_revision` is a P0
-- addition over implement/03 §1: the canonical effect_key input set is
-- {tenant_id, skill_id, step_index, action_revision, request_id} (implement/04
-- §3.2.3), and the AUTH-4 MODIFY path increments the revision in place together
-- with `action_payload` / `effect_key` (implement/04 §4.2 step 4). Storing it
-- keeps the reviewed revision, the fixture business key (tenant_id, action_id,
-- action_revision), and the derived key auditable in one row.
CREATE TABLE IF NOT EXISTS agentos.actions (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    -- No FK yet: `decisions` is not part of the P0 durable subset. The FK lands
    -- with the decisions migration and is composite on (tenant_id, decision_id).
    decision_id UUID,
    skill_name VARCHAR(64) NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    action_revision INT NOT NULL DEFAULT 1 CHECK (action_revision >= 1),
    target_channel VARCHAR(32) NOT NULL,
    action_payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'authorized', 'dispatched', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_actions_tenant_effect UNIQUE (tenant_id, effect_key),
    -- Tenant-scoped parent key consumed by approvals and the resume path (§1.1).
    CONSTRAINT uq_actions_tenant_id UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_actions_status ON agentos.actions (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_decision ON agentos.actions (tenant_id, decision_id);

-- The SINGLE canonical human-authorization record (SCR-003, AUTH-4). One PENDING
-- row is inserted in the same transaction that parks the durable task in
-- `awaiting_human`; the row is the only resume authority, so an approval can
-- never be consumed twice. `approval_queue` (section 6) is a read-only view over
-- these rows — there is no second queue table to diverge from. This table stays
-- mutable: the SCR-003 decision moves PENDING -> decided exactly once.
CREATE TABLE IF NOT EXISTS agentos.approvals (
    id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    action_id UUID NOT NULL,
    -- No FK yet: `campaigns` is P1 business data. The FK lands composite with it.
    campaign_id UUID,
    effect_key VARCHAR(128) NOT NULL,
    authority_required VARCHAR(16) NOT NULL DEFAULT 'AUTH-4'
        CHECK (authority_required IN ('AUTH-4')),
    payload JSONB NOT NULL,
    reason TEXT NOT NULL,
    operator_id VARCHAR(128),
    decision VARCHAR(32) NOT NULL DEFAULT 'PENDING'
        CHECK (decision IN ('PENDING', 'APPROVED', 'REJECTED', 'MODIFIED', 'CANCELLED', 'EXPIRED')),
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    review_comment TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- One approval binding per effect revision: a confirmed-absent retry reuses
    -- this row (INSERT ... ON CONFLICT (tenant_id, effect_key) DO NOTHING) and
    -- never inserts a second authorization.
    CONSTRAINT uq_approvals_tenant_effect UNIQUE (tenant_id, effect_key),
    CONSTRAINT uq_approvals_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT ck_approvals_decided CHECK ((decision = 'PENDING') = (decided_at IS NULL)),
    CONSTRAINT ck_approvals_pause_pending CHECK (decision = 'PENDING' OR is_paused = FALSE),
    CONSTRAINT fk_approvals_action FOREIGN KEY (tenant_id, action_id)
        REFERENCES agentos.actions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending
    ON agentos.approvals (tenant_id, decision, created_at) WHERE decision = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_approvals_action ON agentos.approvals (tenant_id, action_id);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON agentos.approvals (tenant_id, run_id);

-- -----------------------------------------------------------------------------
-- 4. DURABLE EFFECT RESERVATION (BR-005, BR-006, NFR-003)
-- -----------------------------------------------------------------------------

-- The durable authority for at-most-once execution of a mutating effect. A cache
-- may front it, but this row decides: the primary key (tenant_id, effect_key)
-- makes two concurrent workers resolve to exactly one RESERVED outcome, and a
-- settlement is SUCCEEDED or FAILED only. An indeterminate outcome is never
-- written as a new status — the row stays RESERVED with `expires_at` bounding
-- how long the engine waits before escalating to a human (implement/04 §4.4).
-- `request_fingerprint` is the lowercase hex SHA-256 of the RFC 8785 canonical
-- request payload, so a replayed key carrying a different payload is detected as
-- a CONFLICT instead of being merged.
CREATE TABLE IF NOT EXISTS agentos.effect_reservations (
    tenant_id UUID NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    request_id VARCHAR(128) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    step_index INT NOT NULL,
    skill_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'RESERVED'
        CHECK (status IN ('RESERVED', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
    response_receipt JSONB,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '72 hours'),
    PRIMARY KEY (tenant_id, effect_key),
    CONSTRAINT uq_effect_reservation_request UNIQUE (tenant_id, request_id, skill_id, step_index)
);
CREATE INDEX IF NOT EXISTS idx_effect_reservations_expiry
    ON agentos.effect_reservations (tenant_id, status, expires_at) WHERE status = 'RESERVED';

-- -----------------------------------------------------------------------------
-- 5. DURABLE TASK, EVIDENCE CHAIN, AUDIT CHAIN (implement/03 DOMAIN 5)
-- -----------------------------------------------------------------------------

-- The durable workflow state that survives worker crashes and restarts, and the
-- schedule of record for resume/recovery: a leased-but-dead task is re-queued, a
-- failed task is retried only while retryable and under `max_retries`. Every
-- write is either an optimistic `task_version` update or a no-op (implement/04
-- §4.2). `last_error_class` accepts only the persisted classes RETRYABLE/FATAL —
-- 'UNKNOWN' stays a reconciliation state and is not representable here.
CREATE TABLE IF NOT EXISTS agentos.platform_durable_tasks (
    task_id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    correlation_id VARCHAR(64) NOT NULL,
    current_step INT NOT NULL DEFAULT 1,
    state agentos.task_lifecycle_state NOT NULL DEFAULT 'queued',
    task_version INT NOT NULL DEFAULT 1,
    lease_owner VARCHAR(64),
    lease_expires_at TIMESTAMPTZ,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    last_error_class VARCHAR(32) CHECK (last_error_class IN ('RETRYABLE', 'FATAL')),
    paused_for_approval_id UUID,
    state_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_platform_tasks_run UNIQUE (tenant_id, run_id),
    -- A task can only pause against an approval in its own tenant. Clearing the
    -- pause clears the pointer only; `tenant_id` is NOT NULL and is never nulled
    -- by the parent delete.
    CONSTRAINT fk_tasks_approval FOREIGN KEY (tenant_id, paused_for_approval_id)
        REFERENCES agentos.approvals (tenant_id, id) ON DELETE SET NULL (paused_for_approval_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_state
    ON agentos.platform_durable_tasks (tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_lease
    ON agentos.platform_durable_tasks (state, lease_expires_at) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_tasks_correlation
    ON agentos.platform_durable_tasks (tenant_id, correlation_id);

-- Evidence Records: the tamper-evident chain that links each mutating step to its
-- predecessor WITHIN a run — `previous_evidence_hash` is the predecessor's
-- `chain_hash`. `payload_sha256` is SHA-256 over the RFC 8785 canonical raw
-- payload; `chain_hash` covers (previous_evidence_hash | payload_sha256 |
-- effect_key | step_index); `signature` is the HMAC over `chain_hash`.
-- Append-only (section 7).
CREATE TABLE IF NOT EXISTS agentos.evidence_records (
    evidence_id VARCHAR(64) PRIMARY KEY,
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    correlation_id VARCHAR(64) NOT NULL,
    step_index INT NOT NULL,
    effect_key VARCHAR(128) NOT NULL,
    previous_evidence_hash CHAR(64) NOT NULL,
    payload_sha256 CHAR(64) NOT NULL,
    chain_hash CHAR(64) NOT NULL,
    signature CHAR(64) NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_evidence_records_chain UNIQUE (tenant_id, chain_hash)
);
CREATE INDEX IF NOT EXISTS idx_evidence_records_run
    ON agentos.evidence_records (tenant_id, run_id, step_index);

-- Agent Run Log: one append-only row per executed pipeline step (the 18-field
-- execution audit contract, implement/04 §6.1) plus `step_index`. `tenant_id`
-- leads the primary key, so the key is tenant-scoped by construction.
-- Append-only (section 7).
CREATE TABLE IF NOT EXISTS agentos.agent_run_logs (
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
    execution_status VARCHAR(32) NOT NULL
        CHECK (execution_status IN ('pending', 'executing', 'success', 'failed', 'denied', 'aborted')),
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
CREATE INDEX IF NOT EXISTS idx_agent_run_logs_tenant_agent
    ON agentos.agent_run_logs (tenant_id, agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_logs_entity
    ON agentos.agent_run_logs (tenant_id, customer_or_entity_id);

-- Audit Records: the canonical chained compliance log (GDPR Art. 30 / Taiwan
-- PDPA retention, implement/08 §4.1). Column names mirror the compliance audit
-- schema verbatim so the writer's INSERT is column-compatible; `timestamp` is the
-- audit event time and `chain_hash` links records WITHIN a tenant.
-- Append-only (section 7).
CREATE TABLE IF NOT EXISTS agentos.audit_records (
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
    execution_status VARCHAR(32) NOT NULL
        CHECK (execution_status IN ('pending', 'executing', 'success', 'failed', 'denied', 'aborted')),
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
CREATE INDEX IF NOT EXISTS idx_audit_records_tenant_run
    ON agentos.audit_records (tenant_id, run_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_audit_records_agent
    ON agentos.audit_records (tenant_id, agent_id, "timestamp" DESC);

-- -----------------------------------------------------------------------------
-- 6. SECURITY-INVOKER VIEW — SCR-003 APPROVAL QUEUE
-- -----------------------------------------------------------------------------

-- The queue is exactly the PENDING projection of `approvals`, ordered
-- oldest-first for the console. It is a VIEW, so it carries no policy of its
-- own: `security_invoker = true` makes the base table's row-level security
-- evaluate against the CALLING role, and a caller without a tenant context sees
-- nothing. There is exactly one storage object, so the queue and the resume path
-- can never disagree (no split-brain approvals).
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

-- -----------------------------------------------------------------------------
-- 7. APPEND-ONLY TRIGGERS (NFR-002)
-- -----------------------------------------------------------------------------

-- Immutable: `evidences`, `evidence_records`, `audit_records`, `agent_run_logs`.
-- Mutable by design and therefore excluded: `approvals` is the SCR-003 lifecycle
-- (PENDING -> decided exactly once, with `approval_queue` only a view over it),
-- and `platform_durable_tasks` / `effect_reservations` / `actions` / `customers`
-- are runtime and mirror state that legitimately changes.
DROP TRIGGER IF EXISTS trg_immutable_evidences ON agentos.evidences;
CREATE TRIGGER trg_immutable_evidences
    BEFORE UPDATE OR DELETE ON agentos.evidences
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

DROP TRIGGER IF EXISTS trg_immutable_evidence_records ON agentos.evidence_records;
CREATE TRIGGER trg_immutable_evidence_records
    BEFORE UPDATE OR DELETE ON agentos.evidence_records
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

DROP TRIGGER IF EXISTS trg_immutable_audit_records ON agentos.audit_records;
CREATE TRIGGER trg_immutable_audit_records
    BEFORE UPDATE OR DELETE ON agentos.audit_records
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

DROP TRIGGER IF EXISTS trg_immutable_agent_run_logs ON agentos.agent_run_logs;
CREATE TRIGGER trg_immutable_agent_run_logs
    BEFORE UPDATE OR DELETE ON agentos.agent_run_logs
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_immutable_table_modification();

-- -----------------------------------------------------------------------------
-- 8. ROW-LEVEL SECURITY (NFR-006)
-- -----------------------------------------------------------------------------

-- Enable AND force `tenant_isolation_policy` on every table of `agentos`, so the
-- coverage cannot drift when a later migration adds a table and re-runs this
-- block. FORCE means the policy also applies to the table owner; only a role
-- with BYPASSRLS (the migrator) can step outside it.
--
-- Predicate contract: the tenant context is a comma-separated list of UUIDs in
-- the transaction-local `app.current_tenant_id`. `string_to_array(...)::uuid[]`
-- keeps the comparison `uuid = ANY(uuid[])` (never `uuid = text`, which has no
-- operator). An unset setting yields NULL and an empty setting yields {}, so the
-- predicate is NULL/FALSE — the failure mode is deny, never allow.
DO $rls$
DECLARE
    target text;
    predicate text := 'tenant_id = ANY (string_to_array(current_setting(''app.current_tenant_id'', true), '','')::uuid[])';
BEGIN
    FOR target IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'agentos'
    LOOP
        EXECUTE format('ALTER TABLE agentos.%I ENABLE ROW LEVEL SECURITY;', target);
        EXECUTE format('ALTER TABLE agentos.%I FORCE ROW LEVEL SECURITY;', target);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON agentos.%I;', target);
        EXECUTE format(
            'CREATE POLICY tenant_isolation_policy ON agentos.%I AS PERMISSIVE FOR ALL '
            'USING (%s) WITH CHECK (%s);',
            target, predicate, predicate
        );
    END LOOP;
END
$rls$;

-- -----------------------------------------------------------------------------
-- 9. APPLICATION ROLE PRIVILEGES
-- -----------------------------------------------------------------------------

-- Privileges are the outer boundary and RLS is the inner one: `agentos_app`
-- (NOBYPASSRLS, created by docker/postgres/init-roles.sh) needs DML on the
-- durable objects before a policy can deny it anything. The grant is issued only
-- when that role exists and only for objects owned by the migrating role, so it
-- stays correct whether the migration runs as `postgres` or as a dedicated
-- migrator. `ALTER DEFAULT PRIVILEGES` for future objects remains the bootstrap's
-- job; the live RLS suite in src/rls.test.ts runs on this role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA agentos TO agentos_app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agentos TO agentos_app';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agentos TO agentos_app';
    END IF;
END $$;
