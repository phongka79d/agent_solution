# P2 Sales Runtime — Engineering-Complete Paths and Guarded Outcomes

## Status

The Sales domain now executes through the same durable execution graph as Customer Care. A signal
whose payload declares `module = sales` is admitted by the gateway, persisted as one durable task,
claimed and leased by the worker, resolved to the Sales runtime by the shared domain registry, and
walked through the Revenue Orchestrator's eleven stages over the Sales agent runtime, the Sales
policy engine (the canonical PolicyEnforcementPoint bound to the durable audit boundary), the skill
runtime and its adapter dispatcher, the effect guard, and the evidence/audit writers. The Care path
is unchanged: its contract (`support` / `WEB_CHAT` / `message.received`) and its error codes are
identical, and the same registry resolves both.

Sales capability is configuration-gated and off by default. `ENABLED_AGENT_MODULES` defaults to
`support` only, so a `module = sales` turn is refused with `CAPABILITY_NOT_ENABLED` until an
operator enables it; the Sales binding is additionally not constructed unless
`SALES_SIGNAL_SOURCE_CHANNELS` and `SALES_SIGNAL_EVENT_TYPES` are configured.

Every price-bearing or discount-sensitive decision fails closed. There is still **no owner-approved
floor policy** in this repository (`ASM-003`/`ASM-004` remain unapproved), so no floor decision
exists to read: missing, unapproved, provenance-free or TTL-free provenance refuses with
`P_FLOOR_UNAVAILABLE`, and an approved floor that a proposed price breaches refuses with
`ERR_FLOOR_PRICE_VIOLATION`. No component computes, defaults, interpolates or rounds a floor, a
COGS figure, a discount cap, a contribution-margin target or a quote TTL.

| Path | State |
|---|---|
| `module = sales` admission → durable task | Bound (`ENABLED_AGENT_MODULES` + per-module signal contract; off by default) |
| Worker claim/lease → domain registry → Sales orchestrator (fresh **and** resume) | Bound — resume events no longer fall back to the Care factory |
| Sales agent runtime SAL-01..SAL-05 planning over the canonical registry rows | Bound |
| Sales policy engine (PEP + durable policy audit sink + consent source) | Bound |
| Sales skill services — 8 canonical rows, dependency-driven enablement | Bound (4 read rows plus each mutation only when its authoritative dependency is actually bound) |
| `skill.sales.check_price` | Bound — authoritative read; refuses without an owner-approved floor decision, provenance and TTL, and without a server quote-signing secret |
| `skill.sales.create_cart` / `create_order` | Bound but unbound-by-default: require the cart/order port, the authoritative quote preflight, the tenant payment policy and a signed quote token; multi-SKU discount actions require an authoritative aggregate floor decision |
| `skill.sales.send_message` | Bound but unbound-by-default: requires the communication port, channel-specific consent, an authoritative takeover authority and a configured tenant frequency cap |
| Effect reservation, approval binding, receipt replay, reconciliation | Reused unchanged from P1B (`EffectGuard`, `ApprovalRepository`, adapter reconciliation) |
| `PILOT-02` (E2E-OFF-CART) offline acceptance | Executable and passing (20 tests) |
| DB-backed Sales execution smoke | Passing against an isolated PostgreSQL with the in-process API-001 mock |

## Guarded outcomes, not missing handoffs

- **`skill.sales.check_price`** reads the price from the System-of-Record boundary and returns a
  quote only when an owner-approved, provenance-bearing floor decision and a quote TTL exist. Its
  quote token is an HMAC over tenant/sku/customer/price/floor/currency/expiry keyed by an injected
  server secret — never by data the port returns. No cost, COGS or floor internal is exposed to the
  customer beyond the row's declared schema.
- **`skill.sales.create_order`** verifies the tenant's supported payment methods and the
  authoritative priced-cart quote through an order-connector **preflight** before any create call,
  and verifies the signed quote token. A mismatching total, an unsupported payment method, a
  tampered or expired token, or a missing preflight refuses with **zero ERP create calls**; the
  comparison of the created order's returned total is a secondary integrity check only.
- **`skill.sales.send_message`** and Cart Recovery enforce, in order: channel-specific consent,
  suppression, human takeover, then the tenant frequency cap. An unbound takeover authority refuses
  rather than defaulting to "no operator holds the session", and an unconfigured frequency cap
  refuses with `FREQUENCY_CAP_UNAVAILABLE` rather than substituting a platform constant.
- **SAL-05 Reorder/Replenishment** refuses when consent is missing or withdrawn, suppression is
  active, stock or the product's active state cannot be established through the authoritative read,
  the purchase evidence is missing or stale, the owner-approved replenishment interval is absent, or
  a recent verified purchase invalidates the hypothesis. Purchase evidence comes from the injected
  authoritative purchase-evidence port; a caller-asserted interval, reference, stock or purchase
  flag in the signal payload never satisfies the gate.
- **SAL-04 Cart Recovery** plans in the canonical order (consent/context read first) and refuses
  with an explicit fail-closed outcome when that consent read is unavailable. Its outbound channel
  comes only from verified session context; there is no `EMAIL` default.
- **No revenue is manufactured.** A Sales interaction is not revenue until an authoritative
  order/payment source proves it; the offline harness labels its evidence as regression evidence
  and claims no revenue.

## Intentionally unavailable Sales capabilities

These stay fail-closed and are reported as unbound by the runtime rather than stubbed:

- Discounts/price-bearing execution — no owner-approved floor provenance exists (`ASM-003`/`ASM-004`).
- Cart, order and outbound messaging in a default deployment — their connectors are not bound, so
  the rows are disabled and a dispatch attempt refuses (`SKILL_DISABLED`) instead of reaching an
  adapter.
- Scheduled reminder chains beyond a tenant-configured cap — no platform cap is invented; without a
  configured cap the capability refuses.
- SAL-05 replenishment dispatch — no owner-approved replenishment interval or evidence-staleness
  window is configured.
- Real API-001/API-002/API-003 providers — the local/CI instrument is the mock system of record and
  an in-process channel simulator; a managed `APP_ENV` refuses a simulated provider.

## Gate P2 blockers

- **Owner-approved floor policy** (`ASM-003`/`ASM-004`) does not exist in this repository, so every
  price-bearing or discount-sensitive Sales action refuses `P_FLOOR_UNAVAILABLE`.
- **Real system-of-record and channel credentials** for PILOT-02 are unavailable; the mock
  provider is local/CI regression evidence and is never presented as a real provider receipt.
- **Approved tenant configuration** for frequency caps and replenishment policy is unavailable, so
  those capabilities stay unavailable rather than defaulted.
- **Gate P1 remains open** (see below); the roadmap requires Gate P1 closure before Gate P2.
- A **signed P2 bundle** (Sales + Finance + Integration) does not exist, and no production-like
  sandbox run has been executed.

`P2 ENGINEERING MERGE READY: YES` for the Sales scope this branch was asked to deliver — generic
domain routing, SAL-01..05 behaviour, the eight canonical skill rows, reuse of the P1B
approval/effect/reconciliation machinery, consent and outbound enforcement, executable PILOT-02
coverage, and the verification matrix below. That is a statement about the delivered engineering
scope, not a claim that every `FR-SAL` MUST leg is implemented: the residual gaps below name the
legs that are not, and why. `FORMAL GATE P2 CLOSED: NO` — the blockers above are external (owner
policy, real provider credentials, cross-functional sign-off), not engineering gaps, and no offline
or mock result is claimed as gate evidence.

## Residual Sales capability gaps (recorded, not silently claimed)

These are canonical `FR-SAL` legs that are NOT implemented. They are named here rather than folded
into "merge ready", and each states why it was not closed on this branch.

- **`FR-SAL-001` lead qualification persistence (SAL-01).** The `agentos.leads` table exists in the
  DDL (`0000_agentos_schema.sql`, with `customer_type`, `needs_summary`, `interested_products`,
  `readiness_score`, `recent_behavior`, `purchase_history_summary`, `opportunity_potential`,
  `qualification_status`, `reason`, `evidence`), but no repository and no writer back it, so a
  qualified lead is not persisted as a `leads` row. SAL-01's required behaviour is implemented — it
  resolves qualification context from verified Customer360 facts only, discards any customer
  identifier a signal payload asserts, and refuses rather than inferring private facts. Two things
  are missing and neither is an engineering default: the eight canonical Sales skills contain no row
  that writes a lead, so where that write belongs is an architecture/owner decision rather than
  something to invent here; and `readiness_score` / `opportunity_potential` have no owner-approved
  scoring policy in this repository, so a score would have to be fabricated to fill them.
- **`FR-SAL-002` policy explanation (SAL-02).** No Sales-side policy-explanation capability exists.
  The platform's approved-corpus retrieval belongs to the Care pilot's Second Brain corpus, which is
  still a draft with no owner approval, so an approved-corpus explanation path is unavailable to
  Sales and none was substituted. This leg is blocked by the same approved-knowledge blocker that
  holds Gate P1 open. Product specification explanation is served from the authoritative catalog
  read.
- **Human-approval operator surface.** The operator approval route and the Command Center approval
  view are domain-generic — they read tenant-scoped pending approvals and bind a reviewed payload
  digest — so a Sales AUTH-4 effect flows through the same surface with no Sales-specific queue, and
  none was built. What is not yet demonstrated end to end for Sales is an operator approval
  round-trip against a live provider: the DB-backed Sales smoke asserts the fail-closed refusals for
  unbound capabilities, and the approval/replay/re-dispatch machinery is covered by the P1B
  repository and security suites plus the offline PILOT-02 suite.

# P1 Customer Care Runtime — Bound Paths and Guarded Outcomes

## Status

The P1 Customer Care execution graph is bound end to end for the pilot Care path, including the
operator-driven approval and reconciliation handoffs. Provider proof is bound via API-001 / mock GET:
confirmed success durably settles the reservation and replays the proven receipt without a second dispatch;
confirmed absence durably settles FAILED, reopens the SAME effect key, and permits exactly one re-dispatch.
The provider-proof resume path consumes decisive events with one fenced running transition and recognizes
an already-settled matching reservation on replay, so an interruption cannot leave an unclaimable waiting row or trigger a duplicate settlement failure. Care reconciliation is target-bound: HandoffBus
actions never query API-001. Optional adapters, live external ERP, PostgreSQL/RLS and Docker remain
environment-gated; the offline E2E-OFF-ESC/PILOT-04 harness is executable and currently passes.
Gate P1 remains open until live DB/RLS, DB-backed pilots, Docker, approved knowledge, and real SoR evidence exist; offline evidence proves local wiring only and does not close the gate.

| Path | State |
|---|---|
| `runs.start` (R02 intake → durable run) | Bound |
| Worker Care execution graph (claim/lease → orchestrator → skill registry/runtime → adapter → evidence/audit → durable outcome) | Bound |
| Durable retry/reattempt recovery (`queued` → step re-entry, retry budget, `waiting` park) | Bound (repaired this branch) |
| `runs.read` / `runs.list` / `runs.classifyRetry` / `runs.retry` (R13/R16) | Bound (`createDurableRunPort`) |
| `approvals.decide` (R05) | Bound — API queues one durable approval event; the worker owns guarded claim/resume |
| `runs.reconcile` (R18) | Bound — API queues one durable reconciliation event; the worker consumes it via authoritative API-001/mock GET provider proof (success settles/replays; confirmed absence settles FAILED and reopens same key for re-dispatch) |
| `PILOT-04 / E2E-OFF-ESC` | Bound — offline harness covers complaint escalation, durable handoff replay, Case FSM/version fencing, exact-bound AUTH-4 approval resume, takeover silence, human resume and isolation |

## Bound paths

### `runs.start` — admission to a durable run

- `apps/api/src/runtime/composition.ts` binds `runs.start` through `createStartRunPort`
  (`apps/api/src/runtime/bindings.ts`), which reserves the deterministic effect key and inserts the
  durable task in one transaction (`packages/database/src/repositories/run-admission.ts`).
- Runtime binding is covered by the API composition and repository unit suites. Live PostgreSQL/RLS pilot evidence is intentionally not claimed in this run.

### Worker execution graph

- `apps/worker/src/runtime/care/` composes the real components: `factory.ts` builds the
  `RevenueOrchestrator`, the skill registry/runtime binding, the adapter dispatcher, the evidence
  logger, the audit trail, the effect guard, the session-control port and the lease manager.
- `apps/worker/src/worker.ts` claims a `queued` task with the §4.2 optimistic guard, fences every
  write on the claimed lease, walks the eleven stages, persists evidence and the durable outcome,
  and releases the lease when the attempt ends.
- Package unit suites cover the worker graph, lease guards and fail-closed capability reporting. Application-runtime pilot evidence is unavailable without a live database.

### Durable retry and reattempt recovery (repaired on this branch)

Two defects made a re-queued run unable to make progress, and both are fixed in
`packages/core-engine/src/orchestrator/revenue-orchestrator.ts`:

1. `processQueuedSignal` re-entered a persisted plan with **no recovery envelope**, so a second
   failure escaped without an error class and without consuming retry budget — the run returned to
   `queued` and was claimed again forever (`state=queued`, `retry_count` frozen).
2. `replayCommittedStages` re-entered `SIGNAL` after the caller had already entered it, so every
   reattempt was refused with `INVALID_STAGE_TRANSITION` before reaching its first step.

Now a re-claimed run runs inside the same durable-recovery envelope as a first pass: a step that
fails again books `RETRYABLE`/`FATAL` and spends its budget (§4.4), a mutating step restarted from a
persisted checkpoint parks in `waiting` with the complete checkpoint the repository requires, and the
stage replay resumes from `CONTEXT`. Regression tests:
`packages/core-engine/src/orchestrator/revenue-orchestrator.test.ts` ("books the failure of a
re-claimed run instead of returning it to the queue unrecorded", "parks a restarted mutating step on
the checkpoint waiting requires") — these drive the real orchestrator with an injected engine, so
they pin the write-back contract, not the persisted row.

## Guarded outcomes, not missing handoffs

### 1. `approvals.decide` (R05)

**Current behaviour:** The route in `apps/api/src/routes/v1/approvals.ts` authenticates the operator, reads the tenant-scoped approval detail, validates the decision shape and reviewed digest, then calls `ApprovalRepository.queueDecision`. The repository locks the durable task and approval binding, stores one canonical `state_payload.resume_event`, and returns `202 QUEUED`. It never marks the approval decided and never runs a provider call.

The worker claims event-bearing `awaiting_human` rows with the optimistic task-version/lease fence. `RevenueOrchestrator.resumeTask` rechecks policy, takeover and floor guards, then `claimApprovalAndResume` performs the task → action → approval transaction. An identical decision replay is a no-op; a different event conflicts. The approval remains PENDING until that guarded worker claim.

### 2. `runs.reconcile` (R18)

**Current behaviour:** The route in `apps/api/src/routes/v1/operations.ts` authenticates the operator and queues one `human.reconcile` event through `createDurableRunPort`, returning `202`. The database repository locks a `waiting` task, preserves its complete checkpoint, clears any stale execution lease and rejects a different event already queued for the same run.

The worker consumes the event under the same task-version and lease fence. Operator labels or operator-supplied receipts are not proof: `RevenueOrchestrator.resumeTask` delegates to `adapterDispatcher.reconcile` against the authoritative provider boundary (API-001 / mock GET):
- `ESCALATE_MANUALLY`: clears the consumed event and leaves the task parked in `waiting`.
- Provider-confirmed `SUCCEEDED`: durably settles the reservation and replays the proven provider receipt without a second dispatch.
- Provider-confirmed `ABSENT` / `FAILED`: durably settles the reservation as FAILED, reopens the SAME effect key in `effect_reservations`, and permits exactly one re-dispatch under that key.
- Provider indeterminate or unavailable: fails closed without consuming or deleting the resume event, leaving the task parked in `waiting` until decisive proof is available.

**Gate P1 Status:** Gate P1 remains **OPEN**. While local Care execution, handoff, policy, approval, takeover, reconciliation, and offline PILOT-04 pass, Gate P1 requires:
- Live PostgreSQL/RLS verification (migrations 0000..0004 without auth/connection failures, tenant-isolation enforcement in a live database),
- Database-backed Care integration pilots (live DB-backed PILOT-03 / PILOT-04 execution),
- Docker container verification (daemon/compose startup without container naming/network conflicts),
- Approved knowledge corpus (`/customer-care/faq.md` and RAG citations approved by knowledge owner),
- Real System-of-Record (SoR) evidence (authoritative ERP/WMS connector proof, not mock/offline substitutes).
Offline harness evidence proves local wiring and regression contracts only; requirements must not be rewritten to claim offline evidence closes the gate.
## Intentionally unavailable capabilities

These stay fail-closed and are listed by the runtime rather than stubbed:

- Mutating Care skills: `skill.care.manage_case` is disabled by the default P1B allowlist; `skill.care.initiate_return` and `skill.care.issue_retention_offer` remain disabled. `skill.care.escalate_to_human` is enabled by default and writes through the durable `Orchestrator.HandoffBus`; it still fails closed if its tenant-scoped store or handoff contract is unavailable.
- Enabled Care rows whose declared dependency has no tool binding: of the eight Care rows, four are
  `READ` and therefore enabled by the registry. The worker's tool port implements two of their
  declared `guarded_dependency` values — `SecondBrain.FAQEngine` (`skill.care.search_faq`) and
  `API-001.OrderConnector` (`skill.care.lookup_order`). `skill.care.track_shipping`
  (`LogisticsConnector`) and `skill.care.analyze_churn_risk` (`Customer360.AnalyticsLayer`) have no
  implementation in that port, so a plan selecting either refuses
  (`AUTHORITATIVE_SOURCE_UNAVAILABLE`) rather than substituting cached or invented data. Local
  worker tests cover the supported binding and fail-closed refusal paths.
- Non-Care platform agents and every capability outside the P1 pilot scope.
- Optional channels (LINE, WhatsApp, Taiwan/Global) — `403 CAPABILITY_NOT_ENABLED`, no substitute
  channel.
- Reconciliation against a live production ERP system is unavailable: mock ERP / API-001 GET is the
  local bounded provider-proof implementation for the pilot slice; a managed `APP_ENV` refuses a
  simulated provider in production.
- Telemetry stream and command-center projections without a configured source: explicit
  empty/`NO_DATA` frames, never fabricated values.

## Current verification evidence (P2 Sales completion branch)

Re-run on `feat/p2-sales-completion` after the P2 Sales work; these numbers supersede the earlier
P1B-branch run and cover both the Care and Sales paths.

- python testcases/_generate.py --check: passed, exit 0, wrote nothing and mutated nothing — 218/218 baseline case IDs preserved exactly once, 26/26 e2e pairs, requirement coverage 94/94 and facet coverage 143/143.
- Root pnpm typecheck: 14/14 tasks passed.
- Root pnpm lint: 9/9 tasks passed.
- Root pnpm test:unit: 14/14 tasks passed; worker 400, database 252, core-engine 203, API 70, command-center 72, skills 70, adapters 24, storefront-widget 18, second-brain 2 tests passed.
- Root pnpm test:contracts: 7/7 tasks passed (core-engine 18, skills 11).
- Root pnpm test:adversarial: 7/7 tasks passed (core-engine 27, database 79).
- Root pnpm test:security: 7/7 tasks passed (core-engine 47, database 70).
- Root pnpm test:pilots: 6/6 tasks passed; the worker ran 27 pilot tests — E2E-OFF-ESC/PILOT-04 (7) and the new PILOT-02/E2E-OFF-CART Cart Recovery acceptance suite (20, including the below-floor refusal under an owner-approved floor decision with zero adapter dispatches).
- NODE_ENV=production pnpm build: 9/9 tasks passed.
- git diff --check: passed (clean).

## Environment-gated results (P2 Sales completion branch)

- Isolated PostgreSQL bootstrap succeeded on the `agentos-p2-sales-db` Compose project (own project, container prefix and host port) with `agentos_app` as NOBYPASSRLS. No other session's containers were stopped, removed or renamed.
- Migration rehearsal passed from clean state: 5 migration files applied and verified.
- Live RLS policy suite passed: 6 tests. RLS rehearsal isolation suite passed: 17 tests, including cross-tenant/cross-customer negative cases.
- DB-backed integration smoke passed 12 tests against that database with the in-process API-001 mock: the 7 Care cases and the 5 Sales cases (admission of exactly one durable run for `module = sales`, idempotency conflict on changed bytes, worker claim resolving the Sales binding through the real orchestrator with an authoritative ERP read and persisted evidence, gateway readback, and fail-closed refusals for unbound capabilities).
- Isolated Docker smoke passed on Compose project `agentos-p2sales-smoke` with a unique prefix and host ports: API, worker and Command Center images built, loaded, inspected, started, reported healthy, and the project torn down (exit 0). The smoke verifies boot/health only; behaviour is covered by the DB-backed smoke. The worker logs a missing-schema warning there because that stack is intentionally not migrated.
- GitHub Actions run `36215267296` on `005c637` (branch `feat/p2-sales-completion`) passed all five jobs: static analysis/typecheck/build, unit + contract + offline pilots, PostgreSQL migration and RLS rehearsal with the DB-backed Care and Sales integration smokes, adversarial + security, and the named image build/load/boot job.
- Two earlier runs on this branch failed and were fixed rather than bypassed: run `36214669292` failed the unit job because `startWorker` eagerly built the default Sales factory even when a caller injected its own (fixed in `ef3025a`), and run `36215110541` failed the database job because the Sales smoke fell back to the Care pilot tenant and both smokes then shared one durable task queue (fixed in `005c637`).

## Earlier verification evidence for the P1B runtime slice

- The P1B branch run recorded: python testcases/_generate.py --check passed with 419 generated files matching sources byte for byte; root pnpm typecheck 14/14; root pnpm lint 9/9; root pnpm test:unit 14/14 (database 252, core 202, worker 265, API 62); test:contracts 7/7; test:adversarial 7/7; test:security 7/7; test:pilots 6/6 with E2E-OFF-ESC/PILOT-04 running 7 tests; NODE_ENV=production build 9/9; git diff --check clean.
- Isolated Docker smoke passed there on Compose project `agentos-p1b-gate-smoke4` with a unique prefix and host ports.
- Focused coverage includes atomic handoff evidence repair/replay, target-bound reconciliation, durable queue claim, approval queueing, API-001 proof mapping, Vietnamese escalation, and service-case FSM guards.

## Gate P1 blockers

- Second Brain customer-care/faq.md, support-policy.md, and escalation.md remain status: draft; no owner approval exists in the repository, so approved-only retrieval remains fail-closed.
- PILOT-03 has DB-backed local/mock evidence but no approved staging/production-like API-001 SoR credentials or real provider receipt.
- PILOT-04 has the offline harness and local durable handoff coverage, but no approved production-like Redis/operator boundary run.
- GitHub Actions runs #36162634081 and #36162626251 for e3eae1a1 passed all five jobs, including static analysis, unit/contract, PostgreSQL/RLS rehearsal, security, Docker image boot/health, and the feature-branch pilot task.

These are truthful Gate P1 blockers; no draft knowledge was self-approved and no mock receipt is claimed as real SoR evidence.

## Decision

Local P1B behavior, isolated PostgreSQL/RLS, DB-backed Care smoke, offline PILOT-04, isolated Docker health, and remote GitHub CI are green. Gate P1 remains open until approved knowledge, real API-001 SoR evidence, and production-like PILOT-03/PILOT-04 evidence exist.

## P3 Marketing — feat/p3-marketing-completion

Baseline evidence: this branch and `init/agent-solution` both pointed to `05c3cda`; no P2 shared-routing changes were present at inspection. Marketing changes remain isolated under `apps/worker/src/runtime/marketing`; shared worker, RevenueOrchestrator, PEP/effect guard, approval repositories, durable workflow repositories, shared FSM/registry architecture, and generic adapter dispatcher were not changed.

Requirement classification:

| Requirement | State | Evidence / boundary |
|---|---|---|
| MKT-01 signal analysis | ALREADY COMPLETE | Existing source/version/time preservation and SIGNAL/HYPOTHESIS separation retained. |
| MKT-02 segmentation and consent | PARTIAL | Tenant-bound segmentation/consent foundation retained; lifecycle and dispatch-time suppression recheck added. Live Customer360/consent binding remains environment-dependent. |
| MKT-03 content drafting | ALREADY COMPLETE | Deterministic DRAFT generation, approved-knowledge provenance, and injection screening retained. |
| MKT-04 brand compliance | PARTIAL | Blocking brand review retained; dispatch requires blocking-free review and authoritative price/promotion validation, but no live authoritative provider is configured. |
| MKT-05 lifecycle/dispatch | PARTIAL | Bound to the shared P2 `DomainRuntimeRegistry` (`module: marketing`) for both fresh and resumed tasks through the shared `RevenueOrchestrator`; API admission accepts `campaign.requested`. External provider dispatch remains fail-closed without API-003 credentials. |
| MKT-06 attribution | PARTIAL | Matching campaign/effect/correlation/order evidence is required; incomplete evidence returns UNAVAILABLE without fabricated revenue/KPIs. Live order evidence is absent. |
| API-003 outbound | EXTERNAL BLOCKED | Marketing binding is fail-closed and requires explicit tenant/provider/credential/transport configuration; no provider credentials or audited provider contract are available. |
| PILOT-01 | PARTIAL / OFFLINE ONLY | Staged harness and named negative cases are present; provider dispatch/order attribution remain explicitly unavailable offline. |

Verification evidence (post-rebase): full GitHub Actions run 36236215115 on commit a71e265 passed all five jobs — static analysis/typecheck/build, unit and contract tests, PostgreSQL/RLS rehearsal, adversarial/security, and named-image Docker build/load/inspect/boot; run 36235684408 passed the same five jobs on b2e6326. `python testcases/_generate.py --check` reports 419 generated files matching sources byte for byte, and `git diff --check` is clean. Local dependency-backed commands (`pnpm lint`, `pnpm typecheck`, `pnpm test:*`, `pnpm build`) remain blocked because this checkout has no `node_modules`; the dependency-installed CI run is the authoritative evidence. LSP diagnostics are unavailable because no language server is registered.

Remaining blockers: API-003 provider credentials and an audited provider contract are absent, so Marketing dispatch stays fail-closed; authoritative downstream order/payment evidence is absent, so MKT-06 attribution remains UNAVAILABLE; ASM/owner inputs such as audience limits, budgets, send/frequency limits, and attribution windows remain unresolved and fail closed. Shared-routing integration is complete on this branch; formal Gate P3 additionally depends on Gate P2 closure.


## P3 Marketing CI follow-up — 36210697375

- GitHub Actions run 36210697375 failed only job 1 (Static Analysis and Type Checking); jobs 2–5 were skipped. The GitHub adapter did not expose the failed job log tail.
- The user confirms CI dependencies installed successfully; local verification commands in this workspace still report missing turbo/node_modules and therefore do not replace CI evidence.
- This correction removes the fake approval_signature contract, requires canonical P1B workflow claim/release with real approval_id/operator_id, keeps AUTH-4 out of caller grants, and requires authoritative price/promotion provenance without mapping floor_price to proposed_price or defaulting floor_source.
- testcases/sources/business.py was updated and generated outputs were regenerated from source. ~python testcases/_generate.py --check~ now passes with 419 files byte-for-byte current; ~git diff --check~ passes.
- Shared routing is now wired through `worker.ts` and the shared `DomainRuntimeRegistry`; no duplicate worker/router/approval/effect subsystem was added (final post-rebase status below).


## P3 Marketing correction verification

- Run 36210697375 remains the authoritative pre-fix CI evidence: static-analysis/typecheck failed and jobs 2–5 were skipped; GitHub job logs were unavailable through the repository tool.
- Local reruns after the correction remain environment-blocked because this checkout has no node_modules/turbo. No dependency installation was performed.
- ~python testcases/_generate.py --check~ passes: 419 generated files match source. ~git diff --check~ passes with only Git line-ending warnings.
- The correction is superseded by the post-P2 shared-runtime integration; full post-rebase validation completed green (see the post-rebase section below).


## P3 Marketing CI follow-up — 36219425499

- GitHub Actions static analysis/typecheck/build passed.
- PostgreSQL/RLS rehearsal passed.
- Unit and Contract Tests failed with process exit code 1; the public check annotations exposed no test-level failure details and job logs were unavailable through the repository/API tooling.
- The preceding unit failure was the lifecycle approval digest mismatch; commit 69cc8e9 binds the approved segment to the publish fixture without weakening digest verification.
- Historical snapshot; superseded by the green full-pipeline run recorded below.
- SHARED_P2_RUNTIME, API-003 provider/credential availability, and authoritative order evidence remain unchanged.


## P3 Marketing CI resolution — 36221622637

- Final clean-workflow GitHub Actions run 36221622637 passed all five jobs: static analysis/typecheck/build, unit and contract tests, PostgreSQL/RLS rehearsal, adversarial/security, and named-image Docker build/load/inspect/boot.
- The worker unit regression was fixed by supplying authoritative promotion provenance/limit in the digest-mismatch test, preserving fail-closed validation precedence.
- Temporary CI diagnostic steps were removed before this final green run.
- PILOT-01 remains PARTIAL / OFFLINE ONLY; provider dispatch and authoritative order attribution are unavailable offline.
- SHARED_P2_RUNTIME is integrated; formal Gate P3 remains blocked by external/provider/owner evidence and post-integration validation.


## P3 Marketing shared-runtime integration — post-rebase

- Baseline: P2 merged into `init/agent-solution` (`e5f3150`); this branch was rebased onto it (37 commits replayed, no conflicts) and force-pushed with `--force-with-lease`.
- Shared routing: `module: 'marketing'` is now bound in `DomainRuntimeRegistry` through `apps/worker/src/runtime/marketing/factory.ts` (`createMarketingOrchestratorFactory`), which assembles the shared `RevenueOrchestrator`, durable adapters (`createDurableAdapters`), `EffectGuard`, and the canonical Marketing skill dispatcher. No second worker, router, approval queue, or effect subsystem was added.
- Fresh tasks resolve `marketing` through `processClaimedTask` -> registry binding -> `processQueuedSignal`; resumed tasks resolve the same binding through `resumeTask`. Worker-level regression tests cover both paths plus the disabled-module refusal (`CAPABILITY_NOT_ENABLED`).
- API admission accepts `module: 'marketing'` with `event_type: campaign.requested` (`MARKETING_SIGNAL_SOURCE_CHANNELS` / `MARKETING_SIGNAL_EVENT_TYPES` overridable), and R02/R11 pass the module through to the durable run.
- Preserved P3 rules: AUTH-4 uses only a real durable `approval_id` with an authenticated `operator_id` (no synthesized ids, no provider call before release); the invented `segment_id` fallback is gone (`SEGMENT_REQUIRED` fails closed); consent/suppression is rechecked immediately before dispatch; provider UNKNOWN parks for reconciliation instead of blind retry; price and promotion claims require authoritative provenance plus floor data; MKT-06 counts revenue only from authoritative downstream order/payment evidence.
- PILOT-01 remains an offline fixture with `OFFLINE_FIXTURE` / `NOT_RUNTIME_EVIDENCE` markers, now additionally exercising the shared worker/registry path and the missing-segment refusal. Provider dispatch and external order attribution stay explicitly UNAVAILABLE offline.
- CI evidence: runs 36235684408, 36236215115, 36236707259 and 36237944922 each passed all five jobs (static analysis/typecheck/build, unit and contract tests, PostgreSQL/RLS rehearsal, adversarial/security, named-image Docker build/load/inspect/boot). 36237944922 is the green run for commit c482c84; the ledger commit eec0134 is green under run 36238275453, and run 36239763963 is green on commit c028999, which carries the shared-dispatcher cutover, the pre-pause dispatch guards and the MKT-06 refusal.
- Dispatch seam: Marketing no longer owns a dispatcher. `createMarketingSkillDispatcher` and its `MARKETING_DISPATCH_INTEGRATION`/`_STATUS` markers are deleted; `createMarketingSkillServices` now builds the shared `createSkillAdapterDispatcher` (extended with a generic `provider_reconcile` hook) and supplies only a Marketing receipt hook, so AUTH-4, EffectGuard and UNKNOWN reconciliation stay on one path.
- Pre-pause dispatch guards: the shared Marketing policy wrapper refuses a blank `segment_id` (`SEGMENT_REQUIRED`) and blank `campaign_id`/`approved_content_id`/`channel` (`SCHEMA_VALIDATION_ERROR`) before the shared AUTH-4 pause, so a malformed action never creates an approval row; a signal without a canonical `payload.skill_id` is booked as `MARKETING_SIGNAL_INVALID` rather than planned.
- MKT-06: the shared route refuses `skill.mkt.evaluate_attribution` with `MKT06_EVIDENCE_BINDING_REQUIRED` because no evidence-bound analytics contract is bound; the offline `runtime.ts`/PILOT-01 path keeps the evidence-bound validator, and no fabricated revenue/KPI path is exposed.
- PILOT-01 through the shared runtime: `apps/worker/src/runtime/marketing/pilot-01.shared-runtime.test.ts` starts the shared worker with a REAL `createMarketingOrchestratorFactory` graph and drives `processClaimedTask`, proving the run pauses at the shared AUTH-4 gate with a durable `approval_id` and zero provider calls, and that a promotion claim without authoritative provenance fails closed before dispatch. The surrounding registry tests cover fresh and resumed routing plus the disabled-module refusal, and `pilot-01.fixture.test.ts` adds the missing-segment refusal.
- Shared-boundary fix found by that test: the Marketing policy registry previously declared `skill.mkt.dispatch_campaign` as `epistemic_class: ACTION` writing to `FACT`, which the shared promotion guard rejects before AUTH-4; the row now mirrors the Care/Sales convention (`FACT` source, `FACT` target for the mutating dispatch, derived targets elsewhere).
- Ingress boundary: an API-admitted conversation turn carries `source_channel: WEB_CHAT` and the payload members of R02, so it must also carry a canonical `payload.skill_id` to be planned. A Marketing turn without one fails closed (`MARKETING_SIGNAL_INVALID`) instead of inventing a skill.
- These are engineering results only. No mock or offline evidence closes Gate P3: API-003 provider credentials, real downstream order evidence, and owner-supplied ASM/limit configuration are still absent.
- Shared P2 runtime routing is resolved: Marketing uses the shared worker/registry/orchestrator path on this branch, and no pending-routing marker remains in this ledger or in the Marketing source.


# P4 Cross-Domain Orchestration — feat/p4-cross-domain

## Scope classification (inspected on branch `feat/p4-cross-domain`, 0 commits ahead of `init/agent-solution`)

| P4 requirement | Before this branch | After this branch |
|---|---|---|
| Cross-domain lifecycle `Marketing → Sales → Care → Retention` brokered by the Revenue Orchestrator | MISSING — no cross-domain path existed; `assertOrchestratorBrokered` was an identity pass-through and each run was bound to one domain | PARTIAL — the journey contract, the durable brokered handoff, the ledger and the timeline are implemented; the Marketing and Sales legs plan and route, the Retention leg plans its canonical CS-02 row and fails closed at the unbound authoritative port, and the Care onboarding leg resolves its routing but plans NO step, so it emits no `care → retention` handoff today |
| Durable cross-domain handoff contract (tenant, customer, source/target, run/correlation, reason, evidence, classification, lifecycle version, idempotency) | MISSING | IMPLEMENTED (`packages/core-engine/src/contracts/cross-domain-handoff.ts`) |
| Unified Customer 360 timeline with FACT/SIGNAL/HYPOTHESIS/DECISION/ACTION | PARTIAL — `agentos.customer_events` + `CustomerEventRepository` + R15 + SCR-004 existed without classification integrity | IMPROVED — the projection is classification-checked, event-name-derived, and R15 resolves the operator's verified customer |
| Durable restart / no duplicate handoff or effect | PARTIAL — the durable task/checkpoint/lease/effect machinery existed (P1B); no cross-domain hop existed | IMPLEMENTED for the handoff hop — the ledger admission reuses the reservation + durable-task pattern, is idempotent by construction, and commits the Customer 360 row in the same transaction |
| Handoff safety rejections | PARTIAL — RLS, tenant-scoped FKs and the epistemic write guard existed; nothing rejected a cross-domain handoff | IMPLEMENTED at the contract and ledger boundaries |
| SCR-004 binding | PARTIAL — a component existed that always answered `403 CUSTOMER_UNVERIFIED` | IMPROVED — operator identity resolution, classification/domain/stage projection and an authenticated client fetch |
| `TC-E2E-001..009` executable coverage | MISSING — the cases existed only as generated specifications; `test:e2e` is declared in the root manifest and `turbo.json` but implemented by no package | PARTIAL — P4 unit coverage plus a live-database smoke of the handoff ledger exist (below); the `TC-E2E-001..009` acceptance suite and `test:e2e` are still NOT implemented |
| Real provider / LLM / owner inputs | EXTERNAL BLOCKED | EXTERNAL BLOCKED (unchanged) |

## What is implemented

- **One brokered route.** A run declares `HandoffIntent` on its `ExecutionPlan`; the orchestrator builds a `CrossDomainHandoffDraft` at its OUTCOME stage, and an injected `ICrossDomainHandoffBroker` admits the target domain's durable run. No agent calls, messages or addresses another agent. A plan that declares a handoff with no broker bound refuses `HANDOFF_BROKER_UNBOUND`; a refusal from the guard is permanent and fails the run; an unresolved admission parks the run in `waiting` with its real `request_id` and evidence-chain cursor so the same hop is retried under the same idempotency key.
- **The ledger is a ledger, not a queue.** `agentos.cross_domain_handoffs` (migration `0005`) holds the handoff contract; the target run lives in `agentos.platform_durable_tasks`, admitted by `admitCrossDomainHandoff` in ONE tenant transaction that inserts the `effect_reservations` row whose `effect_key` IS the handoff idempotency key, then the durable task, then the ledger row. No second queue, orchestrator, approval or effect system was added.
- **Derived identity, never supplied.** `handoff_id`, `idempotency_key`, `hop_count`, `visited_domains`, `lifecycle.version` and `classification` are computed. `classification` is the highest-ranked class among the attached evidence, so `SIGNAL`/`HYPOTHESIS` content cannot be relabelled `FACT`; a package whose key does not match its own identity is refused.
- **Rejections.** `HANDOFF_TENANT_MISMATCH`, `HANDOFF_CUSTOMER_MISMATCH`, `HANDOFF_DOMAIN_EDGE_REJECTED`, `HANDOFF_AUTHORITY_ESCALATION` (wrong entry agent or a source below the edge's `AUTH-1`, and `AUTH-5` always), `HANDOFF_LOOP_REJECTED` (a revisited domain or a hop that is not exactly the next one, capped at `MAX_HANDOFF_HOPS = 3`), `HANDOFF_STALE_REPLAY` (a superseded version, a completed journey, a leg the journey already left, or a different history), `HANDOFF_EVIDENCE_INVALID`, `HANDOFF_PACKAGE_INVALID`. A `FACT` reference is additionally re-checked against `agentos.evidences` at the admission boundary and refused `HANDOFF_EVIDENCE_UNVERIFIED` when no authoritative row backs it.
- **Timeline.** The handoff's Customer 360 row is committed BY THE ADMISSION, in the same tenant transaction as the reservation, the target task and the ledger row (the `CareHandoffRepository` precedent): `admitCrossDomainHandoff` validates the row before the transaction opens — it must be keyed by the handoff idempotency key, positioned at the handoff instant, and carry `classification_authority: 'SERVER'` with the handoff's own classification — and it stamps `evidence_reference` with the ledger's own generated `handoff_id`, so the row can never cite an id that does not exist. A handoff that committed therefore always has its timeline row, and a replayed admission appends no second one (the stream's `(tenant_id, source_event_id)` deduplication key). The R15 projection projects a stored classification and its evidence reference ONLY when that server marker is present; otherwise it reports `SIGNAL` with a named `gap_reason`. Client deliveries carrying `classification`, `classification_authority` or `evidence_reference` are refused `CUSTOMER_EVENT_RESERVED_PAYLOAD_FIELD` at the single event port.
- **Journey wiring.** `CROSS_DOMAIN_HANDOFF_CHANNEL`/`CROSS_DOMAIN_HANDOFF_EVENT_TYPES` extend the existing Care and Sales signal contracts (nothing was removed or narrowed); the journey is opt-in via `CROSS_DOMAIN_JOURNEY_ENABLED=true` and default-off. Sales emits `sales → care` from a handoff-admitted run; Marketing emits `marketing → sales` for a verified entry run; Care emits `care → retention` only from a handoff-admitted onboarding run that planned at least one step, and a retention run classifies as its own leg and plans `skill.care.analyze_churn_risk` on `CS-02`.

## Verification actually run on this branch

- `python testcases/_generate.py --check`: exit 0 — 218/218 baseline case IDs preserved exactly once, 26/26 e2e pairs, requirement coverage 94/94, facet coverage 143/143; nothing written.
- `pnpm lint` 9/9, `pnpm typecheck` 14/14, `pnpm test:unit` 14/14 (worker 609 tests), `pnpm test:contracts` 7/7, `pnpm test:adversarial` 7/7, `pnpm test:security` 7/7, `pnpm test:pilots` 6/6, `NODE_ENV=production pnpm build` 9/9, `git diff --check` clean.
- New P4 executable coverage: `packages/core-engine/src/contracts/cross-domain-handoff.test.ts` (18 tests — vocabulary, derived identity, every refusal code, malformed-input shapes), `packages/database/src/repositories/cross-domain-handoffs.test.ts` (7 tests — ADMITTED/REPLAY/IN_FLIGHT/CONFLICT/RECONCILE_REQUIRED, unverified-FACT refusal, crash-recovery completion), `apps/worker/src/runtime/shared/cross-domain-handoff.test.ts` (6 tests — signal building, admission mapping, one timeline append per admitted handoff, guard refusal propagation), plus the live-database ledger smoke below.
- Isolated PostgreSQL ring (own Compose project `agentos-p4-db`, container prefix `agentos-p4`, host port 55435, `agentos_app` NOBYPASSRLS): clean migration rehearsal applied 6 files and verified them; `pnpm test:rls-policies` 6/6; RLS rehearsal isolation suite 17/17 including cross-tenant/cross-customer negatives.
- DB-backed P1/P2 integration smokes against that ring with the in-process API-001 mock: `pnpm test:integration` 20/20 across the three suites (7 Care, 5 Sales, 8 P4 cross-domain ledger — the P4 suite added by this branch and wired into `test:integration` and into the CI database job through `P4_TENANT_IDS`).
- Offline pilot suites unchanged and green: E2E-OFF-ESC/PILOT-04 (7) and PILOT-02/E2E-OFF-CART (20) in `test:pilots`.
- GitHub Actions on this branch: runs `36247644513` (`701c68c`), `36248301419` (`45528b6`) and `36248990668` (`bb5232c`) each passed all five jobs — static analysis/typecheck/build, unit + contract, PostgreSQL migration/RLS rehearsal with the DB-backed Care, Sales and P4 smokes, adversarial/security, and the named-image Docker build/load/inspect/boot. Run `36249686575` (`34dee53`) passed the same five jobs after the isolation-case fix.

## Residual gaps and blockers (not closed on this branch)

- **`TC-E2E-001..009` is NOT an executable suite.** The cases exist as generated specifications, and `test:e2e` remains a declared-but-unimplemented task: no package implements it, no `apps/worker` P4 end-to-end suite drives the three domains in one process, and `packages/../vitest` config for it was not added. The P4 coverage above is unit-level and offline.
- **The DB-backed cross-domain smoke proves the LEDGER, not the HTTP path.** `scripts/p4-cross-domain-smoke.mjs` (8 cases, run by `pnpm test:integration`) drives the built `@agentos/database` package against real PostgreSQL as `agentos_app`: admission commits exactly one reservation, one target durable task and one ledger row; a replayed hop is answered `IN_FLIGHT` with the SAME run id and adds no task or row; the same key carrying different bytes is `CONFLICT`; a caller-asserted `FACT` is refused `HANDOFF_EVIDENCE_UNVERIFIED` with no write; the second hop advances the durable lifecycle and a repeated lifecycle version never admits; a hop addressed to a REAL customer of a second tenant is refused and writes nothing in either tenant (with a separate case for an unknown customer id); and the Customer 360 event appends once and reads back with its `SERVER` marker. It drives no API and no worker, so the HTTP admission → brokered handoff → target-run path is still unproven end to end.
- **The orchestrator's brokering is not covered by a live-database test.** The ledger itself is proved by the smoke above, but the OUTCOME-stage brokering and the park/resume path are exercised only by unit suites with substituted repositories.
- **`skill.care.analyze_churn_risk` / `skill.care.issue_retention_offer` remain disabled in the P1–P3 allowlist** (`blocked.md` P1 section; `implement/05` §2557 lists them as Gate P4 requirements). The retention leg only PLANS the churn row for a handoff run; its governed enablement, its consent gate and its approved-floor prerequisite are not delivered, so the P4 retention skill coverage is missing rather than met.
- **The Care onboarding leg plans no step.** A `sales → care` handoff admits its target run and the run classifies as the `care` leg, but the Care planner has no itinerary branch for that leg, so it returns the empty plan: no CS-01 work executes and the `care → retention` handoff is never emitted. The journey therefore ends at Care in practice. This is a named gap, not a passing path.
- **The default Marketing composition binds no Customer360 read.** `MarketingContextAggregator.hydrateContext()` returns `customer: null` unless a caller injects an authoritative resolver, so the Marketing journey entry produces no intent in a default `startWorker` deployment. The entry path is exercised only with an injected aggregator.
- **No `payload.module`/channel guard on external ingress for the internal channel.** The internal `ORCHESTRATOR_HANDOFF` channel is honoured by the domain signal contracts; no API-level test yet proves an external caller cannot present it.
- Real API-001/API-002/API-003 provider credentials, real SoR receipts, owner-approved floor/knowledge policy and cross-functional sign-off remain absent. Gate P1, P2 and P3 remain open for the reasons recorded above them.

`P4 ENGINEERING MERGE READY: NO` — the branch is green on the local matrix, on the isolated PostgreSQL ring, in Docker and on GitHub CI, and the handoff contract, ledger, brokered admission, server-authoritative and non-duplicate timeline PROJECTION, and the SCR-004 binding are delivered and tested (the timeline row's durable coupling to the handoff is not, as recorded above). What is NOT delivered is named above rather than folded into "done": the `TC-E2E-001..009` acceptance suite and `test:e2e`, the Care onboarding itinerary that would reach the retention leg, the governed CS-02 retention enablement, and an authoritative Customer360 binding for the default Marketing composition. `FORMAL GATE P4 CLOSED: NO` — Gate P4 requires real runtime evidence (`handoff_packages`, `single_customer_context_proof`) from live adapters and upstream receipts, and no offline, mock or unit result closes it (`GOV-GATE-P4`, `implement/09 §1.1`).
