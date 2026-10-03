-- Persist AI Team activation state and an append-only transition history.
ALTER TABLE agentos.agents
  ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'NOT_ACTIVATED'
    CHECK (activation_status IN ('NOT_ACTIVATED', 'ACTIVE', 'PAUSED'));

UPDATE agentos.agents
   SET activation_status = CASE WHEN is_active THEN 'ACTIVE' ELSE 'NOT_ACTIVATED' END;

CREATE TABLE agentos.agent_activation_events (
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  event_id UUID NOT NULL DEFAULT agentos.uuid_generate_v7(),
  domain TEXT NOT NULL CHECK (domain IN ('sales', 'care', 'marketing')),
  action TEXT NOT NULL CHECK (action IN ('ACTIVATE', 'PAUSE', 'RESUME')),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  from_capability_status TEXT,
  to_capability_status TEXT NOT NULL CHECK (to_capability_status IN ('ENABLED', 'DISABLED')),
  from_agent_statuses JSONB NOT NULL,
  to_agent_status TEXT NOT NULL CHECK (to_agent_status IN ('ACTIVE', 'PAUSED')),
  correlation_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, event_id)
);

SELECT agentos.apply_tenant_rls('agentos.agent_activation_events');
GRANT SELECT, INSERT ON agentos.agent_activation_events TO agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.agent_activation_events FROM agentos_app;
