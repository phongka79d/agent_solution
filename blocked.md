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

## Current verification evidence for the P1B runtime slice

- python testcases/_generate.py --check: passed; 419 generated files match sources byte for byte.
- Root pnpm typecheck: 14/14 tasks passed.
- Root pnpm lint: 9/9 tasks passed.
- Root pnpm test:unit: 14/14 tasks passed; database 252, core 202, worker 265 and API 62 tests passed.
- Root pnpm test:contracts: 7/7 tasks passed.
- Root pnpm test:adversarial: 7/7 tasks passed.
- Root pnpm test:security: 7/7 tasks passed.
- Root pnpm test:pilots: 6/6 tasks passed; E2E-OFF-ESC/PILOT-04 ran 7 tests successfully.
- NODE_ENV=production pnpm build: 9/9 tasks passed. The default host NODE_ENV was non-standard; the canonical production-mode build is green.
- git diff --check: passed.
- Focused coverage includes atomic handoff evidence repair/replay, target-bound reconciliation, durable queue claim, approval queueing, API-001 proof mapping, Vietnamese escalation, and service-case FSM guards.

## Environment-gated results

- Clean isolated PostgreSQL bootstrap succeeded on the agentos-p1b-db Compose project with agentos_app as NOBYPASSRLS.
- Migration rehearsal passed from clean state: 5 migrations applied and schema/RLS declarations verified; repeat rehearsal skipped all 5 matching checksums.
- Live RLS policy suite passed: 6 tests. RLS rehearsal isolation suite passed: 17 tests, including cross-tenant/cross-customer negative cases.
- DB-backed P1 integration smoke passed all 7 Care cases normally against the isolated PostgreSQL database and in-process API-001 mock.
- Isolated Docker smoke passed on Compose project agentos-p1b-gate-smoke4 with a unique prefix and host ports: API, worker, and Command Center images built, loaded, inspected, started, and reported healthy. No unrelated containers were stopped or removed. The smoke verifies boot/health only; P1 behavior is covered by the DB-backed smoke.

## Gate P1 blockers

- Second Brain customer-care/faq.md, support-policy.md, and escalation.md remain status: draft; no owner approval exists in the repository, so approved-only retrieval remains fail-closed.
- PILOT-03 has DB-backed local/mock evidence but no approved staging/production-like API-001 SoR credentials or real provider receipt.
- PILOT-04 has the offline harness and local durable handoff coverage, but no approved production-like Redis/operator boundary run.
- Repository GitHub CI has not run against this rebased follow-on work because the changes are not yet pushed to a remote commit.

These are truthful Gate P1 blockers; no draft knowledge was self-approved and no mock receipt is claimed as real SoR evidence.

## Decision

Local P1B behavior, isolated PostgreSQL/RLS, DB-backed Care smoke, offline PILOT-04, and isolated Docker health are green. Gate P1 remains open until approved knowledge, real API-001 SoR evidence, production-like PILOT-03/PILOT-04 evidence, and remote CI evidence exist.
