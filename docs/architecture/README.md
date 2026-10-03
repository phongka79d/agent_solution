# Architecture documentation

Use the canonical blueprints below for architecture decisions and boundaries.

- [Project structure](../../implement/02-project-structure.md) — target monorepo layout and dependency rules.
- [Platform architecture](../../plans/platform/architecture.md) — runtime boundaries and orchestration design.
- [Data and knowledge](../../plans/platform/data-and-knowledge.md) — Customer 360 and knowledge ownership.
- [Workflows and handoffs](../../plans/platform/workflows-and-handoffs.md) — durable state, authority, and human handoff.
- [API and integrations](../../plans/platform/api-and-integrations.md) — wire contracts and adapter boundaries.
- [SRS](../../De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md) — requirements authority.

The [Docker topology](../../docker-compose.yml), [Dockerfiles](../../docker/), and [CI workflow](../../.github/workflows/production-pipeline.yml) are operational anchors.

## Retained legacy tables (kept for roadmap)

These tables were superseded by newer schemas but are deliberately **not dropped**: they are
retained for the roadmap and will only be removed by an explicit, announced migration.
They carry no production write path today.

| Table | Superseded by / note |
|---|---|
| `skills` | deprecated by `skill_catalog` (T4.2) |
| `invoices` | roadmap: billing and revenue reconciliation |
| `leads` | roadmap: pre-opportunity pipeline |
| `opportunities` | roadmap: sales pipeline stages |
| `offers` | roadmap: promotions and offer management |
| `workflows` | roadmap: durable workflow authoring |
| `decisions` | roadmap: decision/audit analytics |
| `executions` | roadmap: execution receipts and replay |
| `learnings` | roadmap: model/agent learning loop |

## Current runtime and database inventory

The company and platform consoles call their server-side BFF routes, which proxy to the API gateway. The API composes route handlers and database repositories; the worker composes the durable-task runtime and skill gate (`apps/tenant-console/src/app/api/v1/[...path]/route.ts`, `apps/platform-admin/src/app/api/v1/[...path]/route.ts`, `apps/api/src/server.ts`, `apps/api/src/runtime/composition.ts`, `apps/worker/src/index.ts`, `apps/worker/src/runtime/skill-availability.ts`).

```text
Company browser -> tenant BFF (`apps/tenant-console/src/app/api/v1/[...path]/route.ts`) ─┐
Platform browser -> platform BFF (`apps/platform-admin/src/app/api/v1/[...path]/route.ts`) ─┴-> API (`apps/api/src/server.ts`)
API composition (`apps/api/src/runtime/composition.ts`) -> durable task admission (`packages/database/src/repositories/run-admission.ts`)
PostgreSQL task state -> worker claims (`packages/database/src/repositories/durable-workflows.ts`, `apps/worker/src/index.ts`)
Worker -> skill availability gate (`apps/worker/src/runtime/skill-availability.ts`)
```

The page and operation routes are indexed in the [root README](../../README.md); reconcile requests are implemented in `apps/platform-admin/src/components/operations/api.ts`.

### SQL migrations 0023–0048

These are the checked-in SQL migration files in that version range (`packages/database/migrations/`):

- [0023_schema_ledger_reader.sql](../../packages/database/migrations/0023_schema_ledger_reader.sql), [0024_campaign_run_link.sql](../../packages/database/migrations/0024_campaign_run_link.sql), [0025_run_response_kind.sql](../../packages/database/migrations/0025_run_response_kind.sql), [0026_conversation_message_delivery.sql](../../packages/database/migrations/0026_conversation_message_delivery.sql), [0027_approval_digest_version.sql](../../packages/database/migrations/0027_approval_digest_version.sql), [0028_tenant_states_data_class.sql](../../packages/database/migrations/0028_tenant_states_data_class.sql), [0029_platform_audit_events.sql](../../packages/database/migrations/0029_platform_audit_events.sql)
- [0030_tenant_secrets.sql](../../packages/database/migrations/0030_tenant_secrets.sql), [0031_governance_settings_writable.sql](../../packages/database/migrations/0031_governance_settings_writable.sql), [0032_llm_provider_configs.sql](../../packages/database/migrations/0032_llm_provider_configs.sql), [0033_connector_bindings.sql](../../packages/database/migrations/0033_connector_bindings.sql), [0034_agent_activation.sql](../../packages/database/migrations/0034_agent_activation.sql), [0035_platform_active_tenants.sql](../../packages/database/migrations/0035_platform_active_tenants.sql), [0036_knowledge.sql](../../packages/database/migrations/0036_knowledge.sql)
- [0037_autonomy_policy_cas.sql](../../packages/database/migrations/0037_autonomy_policy_cas.sql), [0038_run_stage_results.sql](../../packages/database/migrations/0038_run_stage_results.sql), [0039_test_data_class.sql](../../packages/database/migrations/0039_test_data_class.sql), [0040_worker_heartbeats.sql](../../packages/database/migrations/0040_worker_heartbeats.sql), [0041_identity.sql](../../packages/database/migrations/0041_identity.sql), [0042_skill_catalog.sql](../../packages/database/migrations/0042_skill_catalog.sql), [0043_platform_run_projections.sql](../../packages/database/migrations/0043_platform_run_projections.sql)
- [0044_auth_membership_password.sql](../../packages/database/migrations/0044_auth_membership_password.sql), [0045_test_data_enabled.sql](../../packages/database/migrations/0045_test_data_enabled.sql), [0046_autonomy_promotion_requests.sql](../../packages/database/migrations/0046_autonomy_promotion_requests.sql), [0047_platform_usage_v2.sql](../../packages/database/migrations/0047_platform_usage_v2.sql), [0048_invitations_admin.sql](../../packages/database/migrations/0048_invitations_admin.sql)

### Environment and test-data controls

- `AUTH_PROVIDER` selects `demo` or `db` and defaults to `demo`; `db` requires `DATABASE_URL` (`apps/api/src/runtime/composition.ts`, `.env.example`).
- `SESSION_SECRET` signs API sessions and is required separately from `JWT_SECRET` (`apps/api/src/runtime/composition.ts`, `apps/api/src/gateway/principal.ts`, `.env.example`).
- The `ENCRYPTION_KEY_AES256` cipher encrypts provider secrets persisted by `SecretRepository`; `ENCRYPTION_KEY_AES256_PREVIOUS` optionally supports decryption with the prior key (`packages/core-engine/src/secrets/cipher.ts`, `packages/database/src/repositories/secrets.ts`, `packages/database/migrations/0030_tenant_secrets.sql`).
- `OPENAI_API_KEY` and `OPENAI_BASE_URL` are server-only environment settings (`.env.example`).
- `DEMO_TENANT_NAME` is an optional demo-company display name with fallback `Demo` (`apps/api/src/runtime/composition.ts`).
- `PLATFORM_FEATURE_SUBSCRIPTIONS=true` enables the subscriptions navigation and page; a disabled route is not found (`apps/platform-admin/src/app/(app)/layout.tsx`, `apps/platform-admin/src/app/(dashboard)/subscriptions/page.tsx`).
- Test-data enablement is persisted as `tenant_governance_settings.test_data_enabled`, not set through an environment variable. `DEMO` and `TEST` tenants are allowed directly; other data classes need the setting enabled, and the test routes require `testdata:manage` (`packages/database/migrations/0045_test_data_enabled.sql`, `apps/api/src/routes/v1/testing.ts`, `apps/api/src/gateway/contracts.ts`).
- The `OPENAI_BASE_URL` fallback and stored LLM provider URLs are checked by `assertSafeProviderUrl`; plain HTTP is allowed only for the local stub hosts when `APP_ENV=local|ci`, while other endpoints must be HTTPS with a publicly routable host (`.env.example`, `packages/core-engine/src/llm/url-guard.ts`, `packages/core-engine/src/llm/resolver.ts`).

### Skill availability gate

The worker composes the skill gate from tenant settings, catalog, connector bindings, agent assignments and activation, autonomy, breakers, and owner inputs (`apps/worker/src/runtime/skill-availability.ts`). The gate's explicit refusal reasons are (`packages/skills/src/runtime/availability.ts`, exercised by `packages/skills/src/runtime/availability.test.ts`):

| Reason | Gate condition |
|---|---|
| `DISABLED_BY_TENANT` | Tenant skill setting is absent or disabled. |
| `NOT_ENTITLED` | Catalog entry is absent, retired, or not entitled. |
| `CONNECTOR_UNBOUND` | A required connector has no binding. |
| `CONNECTOR_UNHEALTHY` | The binding is degraded/disabled, or its check fails. |
| `NO_ASSIGNED_AGENT` | No agent is assigned to the skill. |
| `AGENT_INACTIVE` | No assigned agent is active, or the activation read fails. |
| `PARKED_UNTIL_PROMOTED` | Autonomy parks the skill until human promotion. |
| `AUTONOMY_PAUSED` | Tenant autonomy is paused or its kill switch applies. |
| `BREAKER_OPEN` | The guarded dependency circuit breaker is open. |
| `OWNER_INPUT_UNRESOLVED` | A required owner input is unresolved. |

`OK` is returned only when the availability checks pass; infrastructure read failures fail closed under the corresponding gate reason (`packages/skills/src/runtime/availability.ts`, `packages/skills/src/runtime/availability.test.ts`).

Draft-gated Marketing actions wait before any effect reservation or dispatch. Their checkpoint
retains the pending action with `wait_reason: OTHER` so company attention can surface
`PARKED_DRAFT`; only `RECONCILE` waits are eligible for the effect sweeper. A draft admission
is not evidence that a provider call failed or applied an effect.

