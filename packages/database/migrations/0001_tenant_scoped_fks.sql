-- ============================================================================
-- TENANT-SCOPED FOREIGN KEYS (NFR-006 - zero data bleeding)
-- Schema: agentos
-- Requires: 0000_agentos_schema.sql, executed in the SAME transaction.
-- Convention: spec section 1.1.
-- ============================================================================
--
-- 0000 declares every intra-tenant relationship as `REFERENCES parent(id)`, which proves
-- only that the id exists somewhere in the parent table - never *whose* row it is. RLS does
-- not close that gap: a policy filters the row being read or written, never the row being
-- referenced. Each relationship is therefore re-declared over the pair
-- `(tenant_id, <ref>_id)` -> `parent (tenant_id, id)`: both columns must resolve to one
-- parent row, so a cross-tenant reference cannot satisfy the constraint and the database
-- rejects it with SQLSTATE 23503 (foreign_key_violation).
--
-- Mechanics, applied to every single-column FK declared in 0000 (35 relationships, covering
-- all 15 referenced parents and including the two deferred constraints fk_cases_evidence
-- and fk_cases_outcome):
--
--   1. Each referenced parent exposes `UNIQUE (tenant_id, id)`. `id` is already the primary
--      key, so the pair is a superset key: one extra index per parent, no new failure mode.
--   2. The single-column FK is dropped by its PostgreSQL default name
--      `{table}_{column}_fkey` and re-added under the SAME name, so the upgrade is
--      name-preserving: constraint names cited by operators, logs, and tests keep resolving
--      to the same relationship.
--   3. `MATCH SIMPLE` is explicit. A NULL referencing column short-circuits the check, so
--      nullable FKs stay nullable; only `tenant_id` is NOT NULL, and it always is.
--   4. The ON DELETE action is preserved verbatim. For SET NULL the target column list is
--      spelled out - a bare composite `ON DELETE SET NULL` would try to null `tenant_id` as
--      well and fail its NOT NULL constraint - so the action applies to the referencing
--      column only.
--
-- Not upgraded: `campaigns.approval_id` is a plain UUID column in 0000 (an approval binds to
-- an action through `effect_key`), so there is no constraint to replace. Nothing else about
-- the tables changes here: no column, row, policy, or index is touched beyond the keys below.

-- ----------------------------------------------------------------------------
-- STEP 1: every referenced parent exposes the tenant-scoped key (tenant_id, id)
-- ----------------------------------------------------------------------------

ALTER TABLE agentos.customers     ADD CONSTRAINT uq_customers_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.products      ADD CONSTRAINT uq_products_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.skus          ADD CONSTRAINT uq_skus_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.orders        ADD CONSTRAINT uq_orders_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.conversations ADD CONSTRAINT uq_conversations_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.leads         ADD CONSTRAINT uq_leads_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.segments      ADD CONSTRAINT uq_segments_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.workflows     ADD CONSTRAINT uq_workflows_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.agents        ADD CONSTRAINT uq_agents_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.decisions     ADD CONSTRAINT uq_decisions_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.actions       ADD CONSTRAINT uq_actions_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.campaigns     ADD CONSTRAINT uq_campaigns_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.evidences     ADD CONSTRAINT uq_evidences_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.outcomes      ADD CONSTRAINT uq_outcomes_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agentos.approvals     ADD CONSTRAINT uq_approvals_tenant_id UNIQUE (tenant_id, id);

-- ----------------------------------------------------------------------------
-- STEP 2: upgrade every single-column intra-tenant FK to its composite form
-- ----------------------------------------------------------------------------

ALTER TABLE agentos.customer_identities
    DROP CONSTRAINT customer_identities_customer_id_fkey,
    ADD  CONSTRAINT customer_identities_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.consents
    DROP CONSTRAINT consents_customer_id_fkey,
    ADD  CONSTRAINT consents_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.customer_events
    DROP CONSTRAINT customer_events_customer_id_fkey,
    ADD  CONSTRAINT customer_events_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (customer_id);

ALTER TABLE agentos.skus
    DROP CONSTRAINT skus_product_id_fkey,
    ADD  CONSTRAINT skus_product_id_fkey FOREIGN KEY (tenant_id, product_id)
         REFERENCES agentos.products (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.prices
    DROP CONSTRAINT prices_sku_id_fkey,
    ADD  CONSTRAINT prices_sku_id_fkey FOREIGN KEY (tenant_id, sku_id)
         REFERENCES agentos.skus (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.inventories
    DROP CONSTRAINT inventories_sku_id_fkey,
    ADD  CONSTRAINT inventories_sku_id_fkey FOREIGN KEY (tenant_id, sku_id)
         REFERENCES agentos.skus (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.orders
    DROP CONSTRAINT orders_customer_id_fkey,
    ADD  CONSTRAINT orders_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.invoices
    DROP CONSTRAINT invoices_order_id_fkey,
    ADD  CONSTRAINT invoices_order_id_fkey FOREIGN KEY (tenant_id, order_id)
         REFERENCES agentos.orders (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.conversations
    DROP CONSTRAINT conversations_customer_id_fkey,
    ADD  CONSTRAINT conversations_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.conversation_messages
    DROP CONSTRAINT conversation_messages_conversation_id_fkey,
    ADD  CONSTRAINT conversation_messages_conversation_id_fkey FOREIGN KEY (tenant_id, conversation_id)
         REFERENCES agentos.conversations (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.leads
    DROP CONSTRAINT leads_customer_id_fkey,
    ADD  CONSTRAINT leads_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.opportunities
    DROP CONSTRAINT opportunities_lead_id_fkey,
    ADD  CONSTRAINT opportunities_lead_id_fkey FOREIGN KEY (tenant_id, lead_id)
         REFERENCES agentos.leads (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (lead_id),
    DROP CONSTRAINT opportunities_customer_id_fkey,
    ADD  CONSTRAINT opportunities_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.campaigns
    DROP CONSTRAINT campaigns_segment_id_fkey,
    ADD  CONSTRAINT campaigns_segment_id_fkey FOREIGN KEY (tenant_id, segment_id)
         REFERENCES agentos.segments (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (segment_id);

ALTER TABLE agentos.recommendations
    DROP CONSTRAINT recommendations_customer_id_fkey,
    ADD  CONSTRAINT recommendations_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION,
    DROP CONSTRAINT recommendations_product_id_fkey,
    ADD  CONSTRAINT recommendations_product_id_fkey FOREIGN KEY (tenant_id, product_id)
         REFERENCES agentos.products (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION,
    DROP CONSTRAINT recommendations_sku_id_fkey,
    ADD  CONSTRAINT recommendations_sku_id_fkey FOREIGN KEY (tenant_id, sku_id)
         REFERENCES agentos.skus (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION,
    DROP CONSTRAINT recommendations_converted_order_id_fkey,
    ADD  CONSTRAINT recommendations_converted_order_id_fkey FOREIGN KEY (tenant_id, converted_order_id)
         REFERENCES agentos.orders (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.service_cases
    DROP CONSTRAINT service_cases_customer_id_fkey,
    ADD  CONSTRAINT service_cases_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION,
    DROP CONSTRAINT service_cases_conversation_id_fkey,
    ADD  CONSTRAINT service_cases_conversation_id_fkey FOREIGN KEY (tenant_id, conversation_id)
         REFERENCES agentos.conversations (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (conversation_id),
    DROP CONSTRAINT service_cases_order_id_fkey,
    ADD  CONSTRAINT service_cases_order_id_fkey FOREIGN KEY (tenant_id, order_id)
         REFERENCES agentos.orders (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (order_id),
    DROP CONSTRAINT fk_cases_evidence,
    ADD  CONSTRAINT fk_cases_evidence FOREIGN KEY (tenant_id, evidence_id)
         REFERENCES agentos.evidences (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (evidence_id),
    DROP CONSTRAINT fk_cases_outcome,
    ADD  CONSTRAINT fk_cases_outcome FOREIGN KEY (tenant_id, outcome_id)
         REFERENCES agentos.outcomes (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (outcome_id);

ALTER TABLE agentos.decisions
    DROP CONSTRAINT decisions_workflow_id_fkey,
    ADD  CONSTRAINT decisions_workflow_id_fkey FOREIGN KEY (tenant_id, workflow_id)
         REFERENCES agentos.workflows (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE,
    DROP CONSTRAINT decisions_agent_id_fkey,
    ADD  CONSTRAINT decisions_agent_id_fkey FOREIGN KEY (tenant_id, agent_id)
         REFERENCES agentos.agents (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.actions
    DROP CONSTRAINT actions_decision_id_fkey,
    ADD  CONSTRAINT actions_decision_id_fkey FOREIGN KEY (tenant_id, decision_id)
         REFERENCES agentos.decisions (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE;

ALTER TABLE agentos.approvals
    DROP CONSTRAINT approvals_action_id_fkey,
    ADD  CONSTRAINT approvals_action_id_fkey FOREIGN KEY (tenant_id, action_id)
         REFERENCES agentos.actions (tenant_id, id) MATCH SIMPLE ON DELETE CASCADE,
    DROP CONSTRAINT approvals_campaign_id_fkey,
    ADD  CONSTRAINT approvals_campaign_id_fkey FOREIGN KEY (tenant_id, campaign_id)
         REFERENCES agentos.campaigns (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.executions
    DROP CONSTRAINT executions_action_id_fkey,
    ADD  CONSTRAINT executions_action_id_fkey FOREIGN KEY (tenant_id, action_id)
         REFERENCES agentos.actions (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (action_id);

ALTER TABLE agentos.evidences
    DROP CONSTRAINT evidences_customer_id_fkey,
    ADD  CONSTRAINT evidences_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.outcomes
    DROP CONSTRAINT outcomes_campaign_id_fkey,
    ADD  CONSTRAINT outcomes_campaign_id_fkey FOREIGN KEY (tenant_id, campaign_id)
         REFERENCES agentos.campaigns (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION,
    DROP CONSTRAINT outcomes_order_id_fkey,
    ADD  CONSTRAINT outcomes_order_id_fkey FOREIGN KEY (tenant_id, order_id)
         REFERENCES agentos.orders (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION,
    DROP CONSTRAINT outcomes_customer_id_fkey,
    ADD  CONSTRAINT outcomes_customer_id_fkey FOREIGN KEY (tenant_id, customer_id)
         REFERENCES agentos.customers (tenant_id, id) MATCH SIMPLE ON DELETE NO ACTION;

ALTER TABLE agentos.pending_outcome_attributions
    DROP CONSTRAINT pending_outcome_attributions_outcome_id_fkey,
    ADD  CONSTRAINT pending_outcome_attributions_outcome_id_fkey FOREIGN KEY (tenant_id, outcome_id)
         REFERENCES agentos.outcomes (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (outcome_id);

ALTER TABLE agentos.platform_durable_tasks
    DROP CONSTRAINT platform_durable_tasks_paused_for_approval_id_fkey,
    ADD  CONSTRAINT platform_durable_tasks_paused_for_approval_id_fkey FOREIGN KEY (tenant_id, paused_for_approval_id)
         REFERENCES agentos.approvals (tenant_id, id) MATCH SIMPLE ON DELETE SET NULL (paused_for_approval_id);
