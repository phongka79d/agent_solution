# Demo and exported artifacts

The presentation source and generated PDFs are grouped here. The PDFs are preserved artifacts; regenerate them only through the checked-in exporter.

- [Executive presentation source](presentation/index.html)
- [Technical specification source](presentation/tech_spec.html)
- [PDF exports](exports/)
- [Export script](presentation/export_pdf.py)
- [Overlap checker](presentation/check_pdf_overlap.py)

The [root README](../../README.md) provides the role-based reading guide. Requirements remain in the [root SRS](../../De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md), not in the exported artifacts.

## NovaMart live demo runbook

The demo is local/CI-only. It is intentionally fail-closed: `DEMO_MODE=true` is accepted only with
`APP_ENV=local|ci`, the canonical tenant
`99999999-9999-4999-8999-999999999999`, both account emails and passwords, and dedicated cookie
signing keys.
### Preflight order

```bash
cp .env.example .env
pnpm demo:preflight
pnpm demo:seed
pnpm demo:smoke
```

`demo:preflight` validates the NovaMart pack, tenant, mock ERP boundary, database URL, widget
origins, account credentials, email shape, and cookie-key length without printing secret values.
`demo:seed` is idempotent and requires the isolated demo database to be migrated. `demo:smoke`
requires API/worker/console services already running and exercises company login, widget minting,
catalog reads, storefront receipt streaming, readiness, conversations, approvals, and campaign-draft
admission.

### One-command lifecycle

After preparing `.env`, bring up the Compose stack, wait for healthy services, run
the bootstrap migration, then run preflight, seed, and offline smoke in order; the
completion summary prints the console URLs:

```bash
pnpm demo:up
pnpm demo:up -- --env-file .env.demo
pnpm demo:up -- --live   # DEMO_PROVIDER_MODE=live: preflight and smoke require and exercise the provider
```

The default env file is `.env`. Tear the stack down while keeping named volumes,
or remove them explicitly:

```bash
pnpm demo:down
pnpm demo:down -- --env-file .env.demo --volumes
```

The commands do not print demo account values; the completion summary lists only
the account environment-variable names.

### Compose

For direct Compose commands, `.env` is used by default. When using another file,
pass `--env-file` explicitly so Compose up/down resolve the same values.
The host-run API and worker use `PLATFORM_DATABASE_URL`; Compose configures the matching
internal URL from `PLATFORM_ROLE_PASSWORD`. If `PLATFORM_DATABASE_URL` is unset, platform
transactions fall back to `DATABASE_URL` for legacy databases. Configure the dedicated login
after migration 0052. The worker's knowledge indexer likewise uses `INDEXER_DATABASE_URL`
(Compose builds it from `INDEXER_ROLE_PASSWORD`, migration 0060); with it unset, approved
knowledge never becomes AVAILABLE.

```bash
cp .env.example .env
# edit .env: DEMO_MODE=true, demo account credentials, cookie HMAC keys, and local knowledge/
# signal settings. Keep PLATFORM_ROLE_PASSWORD and INDEXER_ROLE_PASSWORD set for the dedicated
# platform and knowledge-indexer logins.
# demo:up rehearses migrations using the bootstrap URL, then runs preflight, seed, and smoke.
pnpm demo:up
```

The mock ERP is reachable only in local/CI demo mode. `QUOTE_SIGNING_SECRET` is required for
authoritative Sales quotes; omitting it leaves price quoting explicitly unbound rather than
inventing a quote.

### Provider prerequisites

`DEFAULT_LLM_PROVIDER=openai-compatible` (the `.env.example` value) is required; any other value
fails environment validation at boot.

Sales turns are classified server-side without a provider call, so scenario A runs against the
synthetic commerce pack alone. A Customer Care turn additionally asks the configured
OpenAI-compatible endpoint for its bounded intent proposal: without a live key and reachable
`OPENAI_BASE_URL` the gateway refuses the turn with `PROVIDER_REJECTED`/`PROVIDER_TIMEOUT` instead of
answering from an unvalidated classification, and `demo:smoke` stops at that refusal. Configure a
real key for scenario B.

### Demo wiring

- `ENABLED_AGENT_MODULES=sales,support,marketing` enables these domains for the API. The worker
  discovers active tenants and their enabled domains from the database; `ENABLED_AGENT_MODULES`
  and `WORKER_TENANT_IDS` are optional worker debug filters that intersect with that database set.
- `SALES_SIGNAL_SOURCE_CHANNELS=WEB_CHAT` and `SALES_SIGNAL_EVENT_TYPES=message.received` bind the
  Sales domain contract; `MARKETING_SIGNAL_SOURCE_CHANNELS=MARKETING_CAMPAIGN` with
  `MARKETING_SIGNAL_EVENT_TYPES=campaign.requested` binds the company-account campaign contract.
  `KNOWLEDGE_ROOT`/`KNOWLEDGE_TENANT_IDS` point Care and Marketing at the approved synthetic
  corpus (tenant-checked at read time).
- `MOCK_ERP_DEMO_PACK=novamart` makes the mock system of record serve only the NovaMart tenant.
- `demo:seed` promotes the six canonical low-risk skills (`skill.sales.check_stock`,
  `skill.sales.search_product`, `skill.sales.retrieve_customer`, `skill.care.search_faq`,
  `skill.mkt.segment_audience`, `skill.mkt.generate_content`) for the demo tenant and activates the
  demo agents at their demo authority (Sales/Sales-advisory `AUTH-3`, `MKT-05` `AUTH-3` so AUTH-4
  still pauses). Without that promotion, controlled autonomy parks every step as a draft and the demo
  never dispatches; never-promotable actions (cart, order, message, campaign dispatch) keep their
  MINIMUM gate and still require their own approval.
- `CORS_ALLOWED_ORIGINS` must list the console origins that embed the widget (for the default
  local stack: `http://localhost:3000`, `http://localhost:3001`). The gateway answers only an exact
  listed origin — never a wildcard — and only those origins may present a widget credential.
- Marketing audience membership is computed by the worker from the tenant's own Customer360 rows
  (last paid purchase older than the inactivity window, opt-outs for the demo email channel removed),
  capped at 100 customers by the campaign plan.
- A company-account campaign draft is admitted under `source_channel=MARKETING_CAMPAIGN` (the Marketing
  domain contract's own channel, never a browser `WEB_CHAT` turn) with
  `event_type=campaign.requested`. The fixed plan is segment → content → brand → **dispatch**, and
  `skill.mkt.dispatch_campaign` (AUTH-4) pauses for an approval: nothing is sent before a decision.
  Consent is re-read per exact recipient by the canonical dispatch tool at dispatch time; there is
  deliberately no pre-approval per-customer consent step, because a segment identifier is not a
  customer identity and the policy engine refuses a payload that asserts one.

### Demo login

The demo has two account-based sign-ins; there is no role selector. The API login body is
`{email, password, audience}`, while each console supplies its fixed audience:

- **Company admin account** (`DEMO_COMPANY_ADMIN_EMAIL` / `DEMO_COMPANY_ADMIN_PASSWORD`, audience
  `company`) has the seven company permissions: campaign drafting, conversation takeover, customer
  reads, run reads, telemetry reads, approval reads, and approval decisions. It can create campaign
  drafts and decide their digest-bound approvals.
- **Platform admin account** (`DEMO_PLATFORM_ADMIN_EMAIL` / `DEMO_PLATFORM_ADMIN_PASSWORD`, audience
  `platform`) has platform scope for redacted readiness and tenant-fenced run operations. It cannot
  draft campaigns or decide company approvals.

Passwords are used only by the server-side BFF/API flow. The storefront receives only a scoped
widget token; API bearer tokens stay in the server-side BFF session store, and no password or
provider secret is sent to browser code.

After a successful sign-in, the console redirects to the safe requested `next` path, or `/` when
no path was requested. Missing, malformed, or expired session cookies redirect to sign-in with an
expiry reason and clear the session cookie; an upstream API `401` does the same through the BFF.
An upstream `403` remains a forbidden response and does not log out an otherwise valid session.

The customer-visible Sales/Care answer is the durable run response written by the response
finalizer from that run's own successful receipts (verified quote, approved FAQ citation, verified
order status), then read back through `GET /api/v1/tasks/:task_id`. Exactly one customer message and
one agent message are recorded per admitted conversational run.

### Verification status for this branch

A live-provider acceptance run against a real OpenAI-compatible endpoint passed on this branch
(see "Verified live" below). Docker health smoke, offline demo smoke, and PostgreSQL/RLS rehearsal
cover local wiring only; they do not by themselves establish provider success.

#### Verified live

- `node scripts/demo/up.mjs --env-file <live env> --profile live` exited 0 on an isolated compose
  project: the Sales turn completed, the Care turn completed, and the Marketing campaign reached
  `awaiting_human` with a pending approval.
- `node scripts/live/run-tests.mjs` passed 3/3 API tests (Sales usage, grounded Care FAQ usage,
  Marketing approval usage) and 2/2 UI tests (Try assistant, campaign approval).
- `node scripts/live/scan-artifacts.mjs` reported no secret in the run artifacts.

#### Verified locally

- `pnpm check:demo-boundary` passed with no platform/demo violations.
- Demo helper tests passed, including pack counts, C05/C06 identity facts, seed transaction
  fencing, offline/live profile gates, and the boundary checker.
- `pnpm typecheck`, `pnpm lint`, and production-mode `pnpm build` passed. A build with the shell's
  `NODE_ENV=development` failed Next.js prerendering; production builds require
  `NODE_ENV=production`.
- The unit matrix passed for API, Worker, Database, Skills, Core Engine, Adapters, Tenant Console,
  and Platform Admin.
- Contract, adversarial, security, pilot, and Worker E2E tests passed. The offline composition does
  not create a PostgreSQL recorder.
- Provider adapter tests passed, including 401/429/5xx classification, timeout, cancellation,
  malformed JSON, invalid structured output, missing usage, bounded response, and secret redaction.
- Mock ERP boundary tests passed.
- `pnpm test:integration` passed against an isolated PostgreSQL application role; Care,
  cross-domain handoff, and Sales scenarios verified idempotency conflicts, retry recovery,
  tenant/customer ownership, durable evidence, and the three-leg handoff journey.
- On a disposable PostgreSQL container, the 62 currently shipped migration files (`0000`–`0062`, with
  `0008` intentionally skipped/never shipped) applied from empty state in the real-stack harness,
  and `pnpm demo:seed` passed with the seeded demo fixtures.
- `pnpm docker:smoke` built, inspected, started, health-checked, and tore down API, Worker, Tenant
  Console, and Platform Admin images.
- `pnpm demo:smoke` passed against a fresh API/mock-ERP stack. It accepted the Sales turn and
  explicitly reported the provider as `not_exercised`; Care and Marketing were
  `not_exercised_offline`. The live profile refused before requests when provider/database
  prerequisites were absent.
- Changing the seeded tenant display name caused the second seed to fail and preserved the
  mismatched value; it did not silently overwrite tenant identity.
- Customer-facing responses remain receipt-grounded: missing successful receipts, source versions,
  or tenant-bound evidence refuse finalization rather than rendering fallback text. The C06 route
  and storefront persona control are demo-only and support the cross-customer denial scenario.

#### Not verified

- Live operator reply after escalation, live Care order lookup, and a live AUTH-4 ERP order; the
  live suite covers Sales advice, Care FAQ, and Marketing draft/approval only.

#### Blocked prerequisites

- `demo:smoke:live` requires `DEMO_PROVIDER_MODE=live`, `DATABASE_URL`, the two account
  email/password pairs, the two cookie HMAC keys, and `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
  `PRIMARY_REASONING_MODEL`.
- Live acceptance is fail-closed without those prerequisites; offline smoke never claims provider
  success and reports Care/Marketing as `not_exercised_offline`.

The boundary checker intentionally allows demo fixtures, demo auth, demo UI routes, and demo
documentation while rejecting the canonical NovaMart tenant/brand in generic migrations and
platform runtime code.

### Limitations

- The demo pack is synthetic and date-frozen at `2026-09-28T00:00:00Z`; it is not production data.
- `DEMO_MOCK` and `UNBOUND` readiness states are truthful capability states, not successful provider
  observations.
- Campaign dispatch remains approval-gated (`AUTH-4`); draft admission never sends a campaign. The
  external `API-003.CommunicationConnector` and `API-002.EventIngestion`/analytics ports are **not**
  bound in this build, so an approved dispatch refuses and attribution reports `UNAVAILABLE`
  instead of inventing a delivery or a conversion.
- Sales `skill.sales.send_message` likewise has no outbound channel connector bound: the guarded
  reasoning chain is search → stock → owner-approved quote → grounded recommendation, and delivery
  to the customer happens through the run response above, never through a fabricated send.
- Provider/API keys are server-only. A missing LLM, ERP, event, consent, communication, or quote
  binding produces a typed refusal or an explicit readiness state.

## Current runtime settings and real-stack tests

This section supplements the earlier NovaMart runbook and verification record with current environment and database-backed controls (`docs/demo/README.md`).

- `AUTH_PROVIDER` accepts `demo` or `db` and defaults to `demo`; `db` uses durable accounts and sessions and requires `DATABASE_URL` (`apps/api/src/runtime/composition.ts`, `.env.example`).
- `SESSION_SECRET` signs API sessions; `ENCRYPTION_KEY_AES256` protects database-backed provider secrets, with `ENCRYPTION_KEY_AES256_PREVIOUS` available for reads during key rotation (`apps/api/src/runtime/composition.ts`, `packages/core-engine/src/secrets/cipher.ts`, `packages/database/src/repositories/secrets.ts`).
- `OPENAI_API_KEY` and `OPENAI_BASE_URL` are server-only, not `NEXT_PUBLIC_*` settings (`.env.example`).
- `DEMO_TENANT_NAME` optionally sets the demo company's display name; the fallback is `Demo` (`apps/api/src/runtime/composition.ts`).
- `PLATFORM_FEATURE_SUBSCRIPTIONS=true` enables subscriptions navigation and the subscriptions route (`apps/platform-admin/src/app/(app)/layout.tsx`, `apps/platform-admin/src/app/(dashboard)/subscriptions/page.tsx`).
- Test-data enablement is the tenant setting `tenant_governance_settings.test_data_enabled`, not an environment variable; the Test Customer Lab accepts `DEMO`/`TEST` tenants directly, while other data classes require that setting (`packages/database/migrations/0045_test_data_enabled.sql`, `packages/database/src/repositories/test-customers.ts`, `apps/api/src/routes/v1/testing.ts`).
- `OPENAI_BASE_URL` and stored LLM provider URLs are checked by `assertSafeProviderUrl`: HTTP is allowed only for `llm-stub`, `localhost`, `127.0.0.1`, `::1`, or `host.docker.internal` in `local`/`ci`; the other permitted endpoints use HTTPS and public hosts (`.env.example`, `packages/core-engine/src/llm/url-guard.ts`, `packages/core-engine/src/llm/resolver.ts`).

The historical verification count above records the 22 migration files in the 0000–0022 range (with 0008 skipped); the repository also contains the checked-in SQL files 0023–0048, listed in the [architecture reference](../architecture/README.md) (`packages/database/migrations/`).

Run the isolated end-to-end stack suite with `pnpm test:stack` from the repository root (`package.json`, `tests/stack/README.md`). It creates its own Compose project and automatically removes that project's services and volumes unless `STACK_KEEP=1` is set (`tests/stack/global-setup.mjs`, `tests/stack/README.md`). Remove a retained test stack with:

```bash
docker compose --project-name agentos_stacktest --file docker-compose.yml --file tests/stack/compose.stack.yml down --volumes --remove-orphans
```

The command targets the project's configured Compose files and removes volumes (`tests/stack/global-setup.mjs`).
