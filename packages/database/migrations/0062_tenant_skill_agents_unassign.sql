-- 0062: let a company remove an agent from a skill (T4.4 "assign").
--
-- 0042 revoked DELETE on agentos.tenant_skill_agents from agentos_app together with the other
-- per-tenant skill tables, but an assignment row has no "inactive" state: the only way to unassign
-- an agent is to delete its row, and SkillCatalogRepository.replaceAgents does exactly that before
-- re-inserting the requested set. Every PUT /skills/{id}/agents therefore failed with
-- "permission denied for table tenant_skill_agents".
--
-- Scope stays narrow: tenant RLS (apply_tenant_rls) still confines every delete to the bound
-- tenant, the ceiling trigger still refuses agents outside the contract, each replacement is
-- audited with its before/after set, and TRUNCATE stays revoked. Settings and test results keep
-- their no-delete policy.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    GRANT DELETE ON agentos.tenant_skill_agents TO agentos_app;
  END IF;
END
$$;
