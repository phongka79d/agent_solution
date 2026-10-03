-- T4.5: durable, tenant-scoped promotion requests for draft-gated skills. A request is created by
-- a company operator, carries the server-computed evidence window, and is decided (APPROVED under
-- CAS on `autonomy_policies.policy_revision`, or REJECTED) by a distinct approver when tenant
-- governance demands one. The policy write, its policy event and this row's transition are applied
-- in one transaction by `P5AutonomyRepository.commitPromotionDecision`.
CREATE TABLE agentos.autonomy_promotion_requests (
  request_id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
  tenant_id UUID NOT NULL,
  skill_id VARCHAR(128) NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  required_authority VARCHAR(16) NOT NULL,
  requester_id VARCHAR(128) NOT NULL,
  approver_id VARCHAR(128),
  status VARCHAR(16) NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  code VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  evidence_window JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_window_ref VARCHAR(256) NOT NULL,
  expected_revision BIGINT,
  policy_revision BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMPTZ,
  CONSTRAINT fk_autonomy_promotion_requests_tenant
    FOREIGN KEY (tenant_id) REFERENCES agentos.tenants (tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_autonomy_promotion_requests_tenant
  ON agentos.autonomy_promotion_requests (tenant_id, status, created_at DESC);

SELECT agentos.apply_tenant_rls('agentos.autonomy_promotion_requests');
GRANT SELECT, INSERT, UPDATE ON agentos.autonomy_promotion_requests TO agentos_app;
REVOKE DELETE, TRUNCATE ON agentos.autonomy_promotion_requests FROM agentos_app;
