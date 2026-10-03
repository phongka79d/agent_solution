-- Match the platform API's local/CI-only HTTP provider allowlist for stack LLM stubs.
ALTER TABLE agentos.platform_llm_providers
  DROP CONSTRAINT platform_llm_providers_base_url_check,
  ADD CONSTRAINT platform_llm_providers_base_url_check CHECK (
    base_url ~ '^https://'
    OR base_url ~ '^http://(llm-stub|localhost|127[.]0[.]0[.]1|host[.]docker[.]internal)(:[0-9]{1,5})?(/[^?#]*)?$'
    OR base_url ~ '^http://\[::1\](:[0-9]{1,5})?(/[^?#]*)?$'
  );

ALTER TABLE agentos.tenant_llm_configs
  DROP CONSTRAINT tenant_llm_configs_base_url_check,
  ADD CONSTRAINT tenant_llm_configs_base_url_check CHECK (
    base_url IS NULL
    OR base_url ~ '^https://'
    OR base_url ~ '^http://(llm-stub|localhost|127[.]0[.]0[.]1|host[.]docker[.]internal)(:[0-9]{1,5})?(/[^?#]*)?$'
    OR base_url ~ '^http://\[::1\](:[0-9]{1,5})?(/[^?#]*)?$'
  );
