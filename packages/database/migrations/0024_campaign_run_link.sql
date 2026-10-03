ALTER TABLE agentos.campaigns
    ADD COLUMN run_id VARCHAR(64);

ALTER TABLE agentos.campaigns
    ADD CONSTRAINT campaigns_run_id_fkey
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES agentos.platform_durable_tasks (tenant_id, run_id)
        MATCH SIMPLE ON DELETE NO ACTION;

CREATE UNIQUE INDEX uq_campaigns_tenant_run
    ON agentos.campaigns (tenant_id, run_id)
    WHERE run_id IS NOT NULL;
