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

**Remaining P1 blocker:** none in the locally exercised Care handoff, policy, approval, takeover, reconciliation, or offline PILOT-04 paths. Live PostgreSQL/RLS, migration rehearsal, Docker smoke, and live external ERP evidence remain environment-gated.
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

Current verification evidence for the P1B runtime slice:

- Root `pnpm typecheck`: 14/14 tasks passed.
- Root `pnpm lint`: 9/9 tasks passed.
- Root `pnpm test:unit`: 14/14 tasks passed; database 233, core 201, worker 142 and API 62 tests passed.
- Root `pnpm test:contracts`, `pnpm test:adversarial`, `pnpm test:security` and `pnpm build`: 7/7, 7/7, 7/7 and 9/9 tasks passed.
- Root `pnpm test:pilots`: 6/6 tasks passed; E2E-OFF-ESC/PILOT-04 ran 7 tests successfully.
- Focused assertions cover provider-proof crash replay, target-bound reconciliation, durable queue claim, HTTP takeover silence, approvals.decide queueing, API-001 proof mapping, Vietnamese complaint/human-request routing, policy audit/effect binding, and the complete offline pilot.

Environment-gated results:
- PostgreSQL migration rehearsal and RLS: blocked by password authentication failure for `agentos_app` (SQLSTATE `28P01`).
- P1 database-backed integration smoke: timed out with all database-backed Care cases failing.
- Docker smoke: images built and inspected, but service startup hit an existing `/agentos-postgres` container-name conflict; no container was removed.
- Live external ERP/PILOT-04 evidence remains unavailable; the local API-001/mock and offline harness are the exercised substitutes.

These environment results are not code-gate failures; they require the corresponding external services and credentials.

## Decision

Local P1B behavior is bound and exercised, including the offline pilot. Merge readiness remains blocked only by the remaining environment-gated checks; do not claim live PostgreSQL/RLS, Docker, migration or external ERP evidence.
