# P1 Customer Care Runtime — Bound Paths and Guarded Outcomes

## Status

The P1 Customer Care execution graph is bound end to end for the pilot's Care path, including the
operator-driven approval and reconciliation handoffs. Provider proof is bound via API-001 / mock GET:
confirmed success durably settles the reservation and replays the proven receipt without a second dispatch;
confirmed absence durably settles FAILED, reopens the SAME effect key, and permits exactly one re-dispatch.
Operator labels or receipts are not proof. Optional adapters, live external ERP connections, live
PostgreSQL/RLS, Docker smoke, and PILOT-04 remain explicitly out-of-scope or fail-closed. Nothing here
invents a second orchestrator, policy engine, skill system, queue, approval protocol or idempotency mechanism.

| Path | State |
|---|---|
| `runs.start` (R02 intake → durable run) | Bound |
| Worker Care execution graph (claim/lease → orchestrator → skill registry/runtime → adapter → evidence/audit → durable outcome) | Bound |
| Durable retry/reattempt recovery (`queued` → step re-entry, retry budget, `waiting` park) | Bound (repaired this branch) |
| `runs.read` / `runs.list` / `runs.classifyRetry` / `runs.retry` (R13/R16) | Bound (`createDurableRunPort`) |
| `approvals.decide` (R05) | Bound — API queues one durable approval event; the worker owns guarded claim/resume |
| `runs.reconcile` (R18) | Bound — API queues one durable reconciliation event; the worker consumes it via authoritative API-001/mock GET provider proof (success settles/replays; confirmed absence settles FAILED and reopens same key for re-dispatch) |

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

**Remaining P1 blocker:** none in the handoff or provider-proof path for the pilot Care slice. Live PostgreSQL/RLS, migration rehearsal, Docker smoke, PILOT-04, and live external ERP connections require external services or live database state and remain unavailable in this run.
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

## Verification evidence

Current local evidence for the P1B runtime slice; no live database was used:

- Database: `pnpm --filter @agentos/database exec vitest run` — 11 files, 228 tests passed; lint, typecheck and build passed.
- Core engine: `pnpm --filter @agentos/core-engine exec vitest run src` — 13 files, 194 tests passed; lint, typecheck and build passed.
- Worker: `pnpm --filter @agentos/worker exec vitest run` — 9 files, 115 tests passed; lint, typecheck and build passed.
- API: `pnpm --filter @agentos/api exec vitest run src` — 6 files, 45 tests passed; lint, typecheck and build passed.
- Root gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:contracts`, `pnpm test:adversarial` and `pnpm test:security` completed successfully; `pnpm build` completed with 9 successful tasks.
- The focused handoff assertions cover durable queue replay/conflict, task-version and lease fencing, approval binding consumption, takeover suppression, manual reconciliation consumption, API-001/mock GET provider proof reconciliation (success replay without duplicate dispatch, confirmed absence settling FAILED and reopening the same key for re-dispatch), and consumed-event lease release.

Not run by design: live PostgreSQL/RLS tests, migration rehearsal, Docker smoke, and PILOT-04. Those require external services or live database state and remain unavailable in this run.

## Decision

No P1 handoff blocker remains. Provider proof for the pilot slice is bound via API-001 / mock GET; keep optional adapters, real external ERP connections, live PostgreSQL/RLS, and non-P1 capabilities fail-closed; do not add a second approval status, parallel queue, blind reservation settlement or speculative provider result.
