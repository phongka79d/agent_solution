-- Additional platform-only diagnostic projections for run detail (T8.3 / §11.2).
-- These functions expose identifiers and allowlisted decision metadata only; task payloads,
-- provider receipts, audit payloads and evidence payloads remain private.

DROP FUNCTION agentos.platform_list_runs(UUID, TEXT, TEXT, INT, TIMESTAMPTZ);
CREATE FUNCTION agentos.platform_list_runs(
  p_tenant_id UUID DEFAULT NULL,
  p_state TEXT DEFAULT NULL,
  p_domain TEXT DEFAULT NULL,
  p_limit INT DEFAULT 50,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  run_id VARCHAR(64),
  domain TEXT,
  current_step INT,
  state TEXT,
  failure_class TEXT,
  retry_eligible BOOLEAN,
  attempts INT,
  max_retries INT,
  duration_ms BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  correlation_id VARCHAR(64)
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    t.tenant_id,
    ten.display_name,
    t.run_id,
    CASE COALESCE(
      NULLIF(t.state_payload->>'domain', ''),
      NULLIF(t.state_payload->'signal'->'payload'->>'module', ''),
      NULLIF(t.state_payload->'plan'->>'domain', '')
    )
      WHEN 'care' THEN 'support'
      WHEN 'support' THEN 'support'
      WHEN 'sales' THEN 'sales'
      WHEN 'marketing' THEN 'marketing'
      ELSE 'unknown'
    END AS domain,
    t.current_step,
    t.state::TEXT,
    t.last_error_class,
    (t.state = 'failed'
      AND t.last_error_class = 'RETRYABLE'
      AND t.retry_count < t.max_retries) AS retry_eligible,
    t.retry_count,
    t.max_retries,
    (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::BIGINT AS duration_ms,
    t.created_at,
    t.updated_at,
    t.correlation_id
  FROM agentos.platform_durable_tasks AS t
  JOIN agentos.tenants AS ten ON ten.tenant_id = t.tenant_id
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN jsonb_typeof(t.state_payload #> '{signal,subject,conversation_id}') = 'string'
        AND jsonb_typeof(t.state_payload #> '{signal,payload,conversation_id}') = 'string'
        AND NULLIF(t.state_payload->'signal'->'subject'->>'conversation_id', '')
          = t.state_payload->'signal'->'payload'->>'conversation_id'
      THEN t.state_payload->'signal'->'subject'->>'conversation_id'
      ELSE NULL
    END AS conversation_id
  ) AS conversation ON TRUE
  WHERE (p_tenant_id IS NULL OR t.tenant_id = p_tenant_id)
    AND (p_state IS NULL OR t.state::TEXT = p_state)
    AND (p_before IS NULL OR t.created_at < p_before)
    AND (
      p_domain IS NULL
      OR (CASE COALESCE(
            NULLIF(t.state_payload->>'domain', ''),
            NULLIF(t.state_payload->'signal'->'payload'->>'module', ''),
            NULLIF(t.state_payload->'plan'->>'domain', '')
          )
            WHEN 'care' THEN 'support'
            WHEN 'support' THEN 'support'
            WHEN 'sales' THEN 'sales'
            WHEN 'marketing' THEN 'marketing'
            ELSE 'unknown'
          END) = p_domain
    )
    AND (
      NULLIF(BTRIM(p_search), '') IS NULL
      OR POSITION(LOWER(BTRIM(p_search)) IN LOWER(t.run_id)) > 0
      OR POSITION(LOWER(BTRIM(p_search)) IN LOWER(t.correlation_id)) > 0
      OR POSITION(LOWER(BTRIM(p_search)) IN LOWER(COALESCE(conversation.conversation_id, ''))) > 0
    )
  ORDER BY t.created_at DESC, t.run_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;

DROP FUNCTION agentos.platform_run_detail(UUID, VARCHAR);
CREATE FUNCTION agentos.platform_run_detail(
  p_tenant_id UUID,
  p_run_id VARCHAR(64)
)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  run_id VARCHAR(64),
  domain TEXT,
  correlation_id VARCHAR(64),
  current_step INT,
  state TEXT,
  task_version INT,
  failure_class TEXT,
  retry_eligible BOOLEAN,
  attempts INT,
  max_retries INT,
  lease_expires_at TIMESTAMPTZ,
  duration_ms BIGINT,
  stage_event_count BIGINT,
  evidence_count BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  lease_owner VARCHAR(64),
  conversation_id TEXT,
  error_code TEXT,
  cost_breakdown JSONB,
  input_tokens_total BIGINT,
  output_tokens_total BIGINT,
  cached_tokens_total BIGINT
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    t.tenant_id,
    ten.display_name,
    t.run_id,
    CASE COALESCE(
      NULLIF(t.state_payload->>'domain', ''),
      NULLIF(t.state_payload->'signal'->'payload'->>'module', ''),
      NULLIF(t.state_payload->'plan'->>'domain', '')
    )
      WHEN 'care' THEN 'support'
      WHEN 'support' THEN 'support'
      WHEN 'sales' THEN 'sales'
      WHEN 'marketing' THEN 'marketing'
      ELSE 'unknown'
    END AS domain,
    t.correlation_id,
    t.current_step,
    t.state::TEXT,
    t.task_version,
    t.last_error_class,
    (t.state = 'failed'
      AND t.last_error_class = 'RETRYABLE'
      AND t.retry_count < t.max_retries) AS retry_eligible,
    t.retry_count,
    t.max_retries,
    t.lease_expires_at,
    (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::BIGINT AS duration_ms,
    (SELECT COUNT(*) FROM agentos.run_stage_events AS e
      WHERE e.tenant_id = t.tenant_id AND e.run_id = t.run_id)::BIGINT AS stage_event_count,
    (SELECT COUNT(*) FROM agentos.evidence_records AS ev
      WHERE ev.tenant_id = t.tenant_id AND ev.run_id = t.run_id)::BIGINT AS evidence_count,
    t.created_at,
    t.updated_at,
    t.lease_owner,
    CASE
      WHEN jsonb_typeof(t.state_payload #> '{signal,subject,conversation_id}') = 'string'
        AND jsonb_typeof(t.state_payload #> '{signal,payload,conversation_id}') = 'string'
        AND NULLIF(t.state_payload->'signal'->'subject'->>'conversation_id', '')
          = t.state_payload->'signal'->'payload'->>'conversation_id'
      THEN t.state_payload->'signal'->'subject'->>'conversation_id'
      ELSE NULL
    END AS conversation_id,
    NULLIF(t.error_details->>'code', '') AS error_code,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'currency', totals.currency,
        'cost_recorded', totals.cost_recorded,
        'record_count', totals.record_count,
        'cost_total', totals.cost_total
      ) ORDER BY totals.cost_recorded DESC, totals.currency NULLS FIRST)
      FROM (
        SELECT
          (cost.cost_status = 'RECORDED') AS cost_recorded,
          CASE WHEN cost.cost_status = 'RECORDED' THEN cost.currency ELSE NULL END AS currency,
          COUNT(*)::BIGINT AS record_count,
          SUM(CASE WHEN cost.cost_status = 'RECORDED' THEN cost.estimated_cost_amount END)::TEXT AS cost_total
        FROM agentos.token_cost_records AS cost
        WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
        GROUP BY
          cost.cost_status,
          CASE WHEN cost.cost_status = 'RECORDED' THEN cost.currency ELSE NULL END
      ) AS totals
    ), '[]'::jsonb) AS cost_breakdown,
    COALESCE((
      SELECT SUM(COALESCE(cost.input_tokens, 0))::BIGINT
      FROM agentos.token_cost_records AS cost
      WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
    ), 0)::BIGINT AS input_tokens_total,
    COALESCE((
      SELECT SUM(COALESCE(cost.output_tokens, 0))::BIGINT
      FROM agentos.token_cost_records AS cost
      WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
    ), 0)::BIGINT AS output_tokens_total,
    COALESCE((
      SELECT SUM(COALESCE(cost.cached_tokens, 0))::BIGINT
      FROM agentos.token_cost_records AS cost
      WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
    ), 0)::BIGINT AS cached_tokens_total
  FROM agentos.platform_durable_tasks AS t
  JOIN agentos.tenants AS ten ON ten.tenant_id = t.tenant_id
  WHERE t.tenant_id = p_tenant_id AND t.run_id = p_run_id
$$;

CREATE FUNCTION agentos.platform_run_trace_details(
  p_tenant_id UUID,
  p_run_id VARCHAR(64)
)
RETURNS TABLE (
  stages JSONB,
  provider_calls JSONB,
  steps JSONB,
  audit_entries JSONB,
  approvals JSONB,
  handoffs JSONB,
  effect_keys JSONB,
  approval_id UUID,
  evidence_refs JSONB
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'stage', stage.stage::TEXT,
        'status', stage.status,
        'started_at', stage.started_at,
        'completed_at', stage.completed_at,
        'duration_ms', stage.duration_ms,
        'agent_code', stage.agent_code,
        'skill_id', stage.skill_id,
        'summary_key', stage.summary_key,
        'error_class', stage.error_class,
        'detail',
          CASE WHEN jsonb_typeof(stage.detail) = 'object' THEN
            COALESCE((
              SELECT jsonb_object_agg(item.key, item.value)
              FROM jsonb_each(stage.detail) AS item
              WHERE item.key = ANY(CASE stage.stage::TEXT
                WHEN 'SIGNAL' THEN ARRAY['event_type', 'channel', 'domain']
                WHEN 'CONTEXT' THEN ARRAY['customer_verified', 'takeover_active', 'data_class']
                WHEN 'HYPOTHESIS' THEN ARRAY['intent', 'confidence', 'provider_call_index']
                WHEN 'DECISION' THEN ARRAY['target_agent', 'routing_reason_key']
                WHEN 'ACTION' THEN ARRAY['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status']
                WHEN 'APPROVAL' THEN ARRAY['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status']
                WHEN 'EXECUTION' THEN ARRAY['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status']
                WHEN 'EVIDENCE' THEN ARRAY['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status']
                WHEN 'OUTCOME' THEN ARRAY['outcome_kind', 'outcome_watch_id']
                WHEN 'LEARNING' THEN ARRAY['outcome_kind', 'outcome_watch_id']
                ELSE ARRAY[]::TEXT[]
              END)
                AND jsonb_typeof(item.value) IN ('string', 'boolean', 'number')
            ), '{}'::jsonb)
            || CASE
              WHEN stage.stage::TEXT = 'PLAN' AND jsonb_typeof(stage.detail->'steps') = 'array' THEN
                jsonb_build_object('steps', COALESCE((
                  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'agent', CASE WHEN jsonb_typeof(plan.value->'agent') IN ('string', 'boolean')
                      THEN plan.value->'agent' END,
                    'skill', CASE WHEN jsonb_typeof(plan.value->'skill') IN ('string', 'boolean')
                      THEN plan.value->'skill' END,
                    'authority', CASE WHEN jsonb_typeof(plan.value->'authority') IN ('string', 'boolean')
                      THEN plan.value->'authority' END,
                    'mutating', CASE WHEN jsonb_typeof(plan.value->'mutating') IN ('string', 'boolean')
                      THEN plan.value->'mutating' END
                  )))
                  FROM jsonb_array_elements(stage.detail->'steps') AS plan(value)
                  WHERE jsonb_typeof(plan.value) = 'object'
                ), '[]'::jsonb))
              ELSE '{}'::jsonb
            END
          ELSE '{}'::jsonb END,
        'evidence_refs', COALESCE((
          SELECT jsonb_agg(evidence.evidence_id ORDER BY evidence.created_at, evidence.evidence_id)
          FROM agentos.evidence_records AS evidence
          WHERE evidence.tenant_id = stage.tenant_id
            AND evidence.run_id = stage.run_id
            AND evidence.step_index = stage.step_index
        ), '[]'::jsonb)
      ) ORDER BY stage.attempt_ordinal, stage.started_at, stage.step_index)
      FROM agentos.run_stage_results AS stage
      WHERE stage.tenant_id = p_tenant_id AND stage.run_id = p_run_id
    ), '[]'::jsonb) AS stages,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'provider', call.provider,
        'model', call.model,
        'outcome', call.observed_status,
        'latency_ms', call.latency_ms,
        'input_tokens', call.prompt_tokens,
        'output_tokens', call.completion_tokens,
        'cached_tokens', call.cached_tokens,
        'estimated_cost_amount', call.estimated_cost_amount::TEXT,
        'currency', call.currency,
        'cost_status', call.cost_status
      ) ORDER BY call.step_index, call.stage, call.call_index)
      FROM agentos.provider_call_ledger AS call
      WHERE call.tenant_id = p_tenant_id AND call.run_id = p_run_id
    ), '[]'::jsonb) AS provider_calls,
    COALESCE((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'step_index', log.step_index,
        'agent', log.agent_id,
        'skill', log.skill,
        'tool_binding', log.tool,
        'authority', log.authority,
        'autonomy_decision', CASE WHEN jsonb_typeof(log.decision) = 'object' THEN
          jsonb_strip_nulls(jsonb_build_object(
            'planned_authority', CASE WHEN jsonb_typeof(log.decision->'planned_authority') = 'string'
              THEN log.decision->'planned_authority' END,
            'outcome', CASE WHEN jsonb_typeof(log.decision->'outcome') = 'string'
              THEN log.decision->'outcome' END,
            'autonomy_decision', CASE WHEN jsonb_typeof(log.decision->'autonomy_decision') = 'string'
              THEN log.decision->'autonomy_decision' END,
            'reason_key', CASE WHEN jsonb_typeof(log.decision->'reason_key') = 'string'
              THEN log.decision->'reason_key' END,
            'error_code', CASE WHEN jsonb_typeof(log.decision->'error_code') = 'string'
              THEN log.decision->'error_code' END,
            'policy_event_ref', autonomy.event_id::TEXT,
            'policy_version', COALESCE(
              NULLIF(log.decision->>'policy_version', ''),
              autonomy.policy_version
            ),
            'policy_state', autonomy.to_state,
            'policy_trigger', autonomy.trigger,
            'policy_audit_ref', autonomy.audit_ref
          )) ELSE '{}'::jsonb END,
        'execution_status', log.execution_status,
        'effect_key', NULLIF(log.action->>'effect_key', ''),
        'reservation_status', reservation.status,
        'receipt_ref', evidence.evidence_id,
        'error_code', NULLIF(log.error->>'code', '')
      )) ORDER BY log.step_index, log.started_at)
      FROM agentos.agent_run_logs AS log
      LEFT JOIN LATERAL (
        SELECT effect.status
          FROM agentos.effect_reservations AS effect
         WHERE effect.tenant_id = log.tenant_id
           AND effect.run_id = log.run_id
           AND effect.effect_key = NULLIF(log.action->>'effect_key', '')
         ORDER BY effect.expires_at DESC
         LIMIT 1
      ) AS reservation ON TRUE
      LEFT JOIN LATERAL (
        SELECT record.evidence_id
          FROM agentos.evidence_records AS record
         WHERE record.tenant_id = log.tenant_id
           AND record.run_id = log.run_id
           AND record.effect_key = NULLIF(log.action->>'effect_key', '')
         ORDER BY record.created_at DESC, record.evidence_id DESC
         LIMIT 1
      ) AS evidence ON TRUE
      LEFT JOIN LATERAL (
        SELECT event.event_id, event.policy_version, event.to_state, event.trigger, event.audit_ref
          FROM agentos.autonomy_policy_events AS event
         WHERE event.tenant_id = log.tenant_id
           AND event.skill_id = log.skill
           AND (NULLIF(log.decision->>'policy_version', '') IS NULL
             OR event.policy_version = log.decision->>'policy_version')
           AND event.occurred_at <= log.started_at
         ORDER BY event.occurred_at DESC, event.event_id DESC
         LIMIT 1
      ) AS autonomy ON TRUE
      WHERE log.tenant_id = p_tenant_id AND log.run_id = p_run_id
    ), '[]'::jsonb) AS steps,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'audit_ref', audit.id::TEXT,
        'created_at', audit."timestamp",
        'agent', audit.agent_id,
        'skill', audit.skill,
        'tool_binding', audit.tool,
        'authority', audit.authority,
        'execution_status', audit.execution_status
      ) ORDER BY audit."timestamp", audit.id)
      FROM agentos.audit_records AS audit
      WHERE audit.tenant_id = p_tenant_id AND audit.run_id = p_run_id
    ), '[]'::jsonb) AS audit_entries,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'approval_id', approval.id::TEXT,
        'status', approval.decision,
        'effect_key', approval.effect_key,
        'created_at', approval.created_at
      ) ORDER BY approval.created_at, approval.id)
      FROM agentos.approvals AS approval
      WHERE approval.tenant_id = p_tenant_id AND approval.run_id = p_run_id
    ), '[]'::jsonb) AS approvals,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'handoff_id', handoff.id::TEXT,
        'status', handoff.status,
        'effect_key', handoff.effect_key,
        'created_at', handoff.created_at,
        'conversation_id', handoff.conversation_id::TEXT
      ) ORDER BY handoff.created_at, handoff.id)
      FROM agentos.care_handoffs AS handoff
      WHERE handoff.tenant_id = p_tenant_id AND handoff.run_id = p_run_id
    ), '[]'::jsonb) AS handoffs,
    COALESCE((
      SELECT jsonb_agg(effect_key ORDER BY effect_key)
      FROM (
        SELECT DISTINCT keys.effect_key
        FROM (
          SELECT NULLIF(log.action->>'effect_key', '') AS effect_key
          FROM agentos.agent_run_logs AS log
          WHERE log.tenant_id = p_tenant_id AND log.run_id = p_run_id
          UNION ALL
          SELECT NULLIF(task.state_payload->'pending_action'->>'effect_key', '')
        ) AS keys
        WHERE keys.effect_key IS NOT NULL
      ) AS unique_effects
    ), '[]'::jsonb) AS effect_keys,
    task.paused_for_approval_id AS approval_id,
    COALESCE((
      SELECT jsonb_agg(evidence.evidence_id ORDER BY evidence.created_at, evidence.evidence_id)
      FROM agentos.evidence_records AS evidence
      WHERE evidence.tenant_id = task.tenant_id AND evidence.run_id = task.run_id
    ), '[]'::jsonb) AS evidence_refs
  FROM agentos.platform_durable_tasks AS task
  WHERE task.tenant_id = p_tenant_id AND task.run_id = p_run_id
$$;

REVOKE ALL ON FUNCTION agentos.platform_list_runs(UUID, TEXT, TEXT, INT, TIMESTAMPTZ, TEXT) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_run_detail(UUID, VARCHAR) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_run_trace_details(UUID, VARCHAR) FROM PUBLIC, agentos_app;
GRANT USAGE ON SCHEMA agentos TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_list_runs(UUID, TEXT, TEXT, INT, TIMESTAMPTZ, TEXT) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_run_detail(UUID, VARCHAR) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_run_trace_details(UUID, VARCHAR) TO agentos_platform;
