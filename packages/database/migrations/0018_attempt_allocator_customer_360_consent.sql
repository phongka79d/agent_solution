-- M8: serialize attempt ordinal allocation and make Customer 360 consent fail closed.
-- Requires 0017_restrict_tenant_shell_provisioning.sql.

-- `nextAttemptOrdinal()` is called before stage events are appended, so a MAX(event) query
-- cannot serialize two callers. This row is the durable per-run allocation cursor; the repository
-- locks the owning durable task while seeding a cursor from legacy events, then increments it
-- atomically for every subsequent allocation.
CREATE TABLE agentos.run_attempt_ordinals (
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    last_ordinal INT NOT NULL,

    CONSTRAINT pk_run_attempt_ordinals PRIMARY KEY (tenant_id, run_id),
    CONSTRAINT fk_run_attempt_ordinals_run
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES agentos.platform_durable_tasks (tenant_id, run_id)
        ON DELETE CASCADE,
    CONSTRAINT ck_run_attempt_ordinals_positive CHECK (last_ordinal >= 1)
);

ALTER TABLE agentos.run_attempt_ordinals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.run_attempt_ordinals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON agentos.run_attempt_ordinals
    AS PERMISSIVE
    FOR ALL
    USING (
        tenant_id = ANY (
            string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
        )
    )
    WITH CHECK (
        tenant_id = ANY (
            string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
        )
    );

GRANT SELECT, INSERT, UPDATE ON agentos.run_attempt_ordinals TO agentos_app;

-- A single opt-in must not override an opt-out on another relevant channel. `BOOL_AND` is
-- deliberately fail closed: consent is true only when every recorded marketing decision is granted
-- and carries no opt-out marker; suppression is true when any channel is revoked or opted out.
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
        CASE
            WHEN BOOL_OR(NOT cons.is_granted OR cons.opt_out_timestamp IS NOT NULL) THEN FALSE
            ELSE BOOL_AND(cons.is_granted)
        END                                                    AS consent_marketing,
        MAX(cons.updated_at)                                   AS consent_updated_at,
        BOOL_OR(NOT cons.is_granted OR cons.opt_out_timestamp IS NOT NULL) AS suppression_active
    FROM agentos.consents cons
    WHERE cons.tenant_id = c.tenant_id
      AND cons.customer_id = c.id
      AND cons.consent_type = 'marketing_messaging'
) consent ON TRUE;
