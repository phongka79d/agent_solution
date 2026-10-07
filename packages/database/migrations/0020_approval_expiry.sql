-- B67: approvals are bounded human decisions. Reads and decisions treat a pending row past
-- expires_at as EXPIRED; a later sweeper may persist the same transition in bulk.
ALTER TABLE agentos.approvals
  ADD COLUMN expires_at TIMESTAMPTZ NOT NULL
    DEFAULT (CURRENT_TIMESTAMP + INTERVAL '72 hours');

CREATE INDEX idx_approvals_expiry
  ON agentos.approvals (tenant_id, expires_at)
  WHERE decision = 'PENDING';

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
    a.decision        AS status,
    a.is_paused       AS is_paused,
    a.operator_id     AS decided_by,
    a.decided_at      AS decided_at,
    a.review_comment  AS decision_notes,
    a.created_at      AS created_at
FROM agentos.approvals a
WHERE a.decision = 'PENDING'
  AND a.expires_at > CURRENT_TIMESTAMP;
