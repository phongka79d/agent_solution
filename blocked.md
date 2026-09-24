# P1 Customer Care Runtime — Bound Paths and Remaining Blocks

## Status

The P1 Customer Care execution graph is bound end to end for the pilot's Care path, and the two
operator-driven paths that cannot be completed from the existing contracts stay fail-closed with
their missing input named. Nothing here invents a second orchestrator, policy engine, skill system,
queue, approval protocol, or idempotency mechanism.

| Path | State |
|---|---|
| `runs.start` (R02 intake → durable run) | Bound |
| Worker Care execution graph (claim/lease → orchestrator → skill registry/runtime → adapter → evidence/audit → durable outcome) | Bound |
| Durable retry/reattempt recovery (`queued` → step re-entry, retry budget, `waiting` park) | Bound (repaired this branch) |
| `runs.read` / `runs.list` / `runs.classifyRetry` / `runs.retry` (R13/R16) | Bound (`createDurableRunPort`) |
| `approvals.decide` (R05) | **Blocked** — fail-closed in `apps/api/src/runtime/composition.ts` |
| `runs.reconcile` (R18) | **Blocked** — fail-closed in `apps/api/src/runtime/composition.ts` |

## Bound paths

### `runs.start` — admission to a durable run

- `apps/api/src/runtime/composition.ts` binds `runs.start` through `createStartRunPort`
  (`apps/api/src/runtime/bindings.ts`), which reserves the deterministic effect key and inserts the
  durable task in one transaction (`packages/database/src/repositories/run-admission.ts`).
- Proven by `scripts/care-pilot-smoke.mjs` cases 1, 3 and 4 against real PostgreSQL with the
  NOBYPASSRLS application role: exactly one durable run per immutable inbound identity (case 1),
  redelivery answered from the run already started (case 3), and a changed payload under the same key
  refused with `IDEMPOTENCY_CONFLICT` (case 4).

### Worker execution graph

- `apps/worker/src/runtime/care/` composes the real components: `factory.ts` builds the
  `RevenueOrchestrator`, the skill registry/runtime binding, the adapter dispatcher, the evidence
  logger, the audit trail, the effect guard, the session-control port and the lease manager.
- `apps/worker/src/worker.ts` claims a `queued` task with the §4.2 optimistic guard, fences every
  write on the claimed lease, walks the eleven stages, persists evidence and the durable outcome,
  and releases the lease when the attempt ends.
- Proven by `scripts/care-pilot-smoke.mjs` case 1 (a permitted Care read skill executes and the
  evidence chain, Agent Run row and audit row persist), plus case 5 (draft knowledge corpus invents
  nothing) and case 6 (another customer's order is never disclosed).

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

## Remaining blocks

### 1. `approvals.decide` (R05)

**Current behaviour:** `apps/api/src/runtime/composition.ts` binds `approvals.decide` to
`UnboundPortError` with the reason `no approval decision handoff is specified: the decision
transaction requires a worker lease and policy recheck, and no worker may claim a parked task`.
The approval queue and detail reads stay repository-backed and available (`R14`, §8.2.1).

**Why it cannot be completed from the existing contracts:**

- R05's transition is a compare-and-set on the PENDING `approvals` row **plus the task transition in
  one transaction** (`06` §8.1.1), which is exactly the single-use `claimApprovalAndResume`
  transaction (`04` §4.2(4)), already implemented in
  `packages/database/src/repositories/approvals.ts`.
- The real components guard that transaction before the irreversible claim: the worker lease, a
  current policy verdict, and a live SCR-005 takeover read
  (`RevenueOrchestrator.resumeTask`, `packages/core-engine/src/orchestrator/revenue-orchestrator.ts`).
  The gateway holds no execution lease and cannot re-run those guards, so deciding there would
  consume the run's only resume authority with the guards skipped.
- The handoff that would let an authorized executor run the recorded decision does not exist:
  the worker's claim statement selects `queued` or an expired `running` lease only
  (`SELECT_CLAIMABLE_TASK`, `packages/database/src/repositories/durable-workflows.ts`), so nothing
  claims an `awaiting_human` task; and `state_payload.resume_event`, the only resume-event slot the
  worker reads, is written by no component (`apps/worker/src/worker.ts`).
- Inventing a second decision protocol or a duplicate status column would be a shadow of the
  documented transition, which the branch's rules forbid.

**Required unblock:** specify and test the authorized decision handoff — how a worker obtains the
`04` §4.2(1) claim on an `awaiting_human` task while preserving the state until the atomic decision,
and what durable record carries the operator's decision, digest and reason to that executor.

### 2. `runs.reconcile` (R18)

**Current behaviour:** `apps/api/src/runtime/composition.ts` binds `runs.reconcile` to
`UnboundPortError` with the reason `no reconciliation completion handoff is specified: a parked task
cannot be handed back to an executor`. The storage half is present: an operator resolution maps onto
the durable reservation settlement (`EffectReservationRepository.settleReservation` /
`reopenReservation`), and `04` §4.2(1) admits `waiting` in the claim predicate.

**Why it cannot be completed from the existing contracts:** the same handoff gap as above. A parked
`waiting` task cannot be claimed by any executor in this build, so a settled reservation would leave
the run parked forever; and provider-confirmed absence versus success is the operator's stated
resolution (`06` §8.1.2 R18), so the missing input is the executor handoff, not the authority.

**Required unblock:** the same decision/reconciliation handoff as item 1, with settlement and
resume behaviour defined for confirmed success, confirmed absence and manual escalation.

## Intentionally unavailable capabilities

These stay fail-closed and are listed by the smoke rather than stubbed:

- Mutating Care skills: `skill.care.manage_case`, `skill.care.escalate_to_human` (`INTERNAL`),
  `skill.care.initiate_return` (`APPROVAL`) and `skill.care.issue_retention_offer` (`EFFECT`) are
  registered with their full contracts but disabled, so a plan selecting one resolves the row and is
  refused rather than dispatched.
- Enabled Care rows whose declared dependency has no tool binding: of the eight Care rows, four are
  `READ` and therefore enabled by the registry. The worker's tool port implements two of their
  declared `guarded_dependency` values — `SecondBrain.FAQEngine` (`skill.care.search_faq`) and
  `API-001.OrderConnector` (`skill.care.lookup_order`). `skill.care.track_shipping`
  (`LogisticsConnector`) and `skill.care.analyze_churn_risk` (`Customer360.AnalyticsLayer`) have no
  implementation in that port, so a plan selecting either refuses
  (`AUTHORITATIVE_SOURCE_UNAVAILABLE`) rather than substituting cached or invented data. The smoke
  exercises only the two supported bindings: one successful `lookup_order` execution and one
  fail-closed `search_faq` refusal.
- Non-Care platform agents and every capability outside the P1 pilot scope.
- Optional channels (LINE, WhatsApp, Taiwan/Global) — `403 CAPABILITY_NOT_ENABLED`, no substitute
  channel.
- Reconciliation against a real provider: the pilot binds the mock system of record only, and a
  managed `APP_ENV` refuses a simulated provider.
- Telemetry stream and command-center projections without a configured source: explicit
  empty/`NO_DATA` frames, never fabricated values.

## Verification evidence

Run on this branch; every gate below was captured with its exit status (no piped summaries).

- `npx turbo run typecheck` — **exit 0**, 14/14 tasks.
- `npx turbo run lint` — **exit 0**, 9/9 tasks.
- `npx turbo run test:unit` — **exit 0**, 14/14 tasks.
- `npx turbo run test:contracts` — **exit 0**, 7/7 tasks.
- `npx turbo run test:adversarial` — **exit 0**, 7/7 tasks (26 effect-guard cases).
- `npx turbo run test:security` — **exit 0**, 7/7 tasks (46 policy cases).
- Migration rehearsal against an isolated `pgvector/pgvector:pg16` instance bootstrapped with the
  repository's own `docker/postgres/init.sql` + `init-roles.sh`: first invocation applies
  `0000_agentos_schema.sql`, `0001_tenant_scoped_fks.sql`, `0002_rls_policies.sql` with digests and
  verifies the applied schema; a forced cache-bypassing second invocation reports
  `skip … (already applied, sha256 …)` for the same three digests and exits 0 — apply and replay are
  idempotent. (`--force`, because turbo would otherwise serve a cache hit.)
- `test:rls-policies` from the NOBYPASSRLS application role on that instance — 6/6 passed.
- `test:integration` (`scripts/care-pilot-smoke.mjs`) — 7/7 passed on a freshly migrated instance
  (and 6/6, the earlier set, on the rehearsal database):
  1. `/api/v1` intake admits exactly one durable run, the worker completes it through the Care read
     skill, evidence/Agent-Run/audit rows persist, and `/api/v1/tasks/{id}` reads it back completed;
  2. **persisted requeue and reclaim**: the first attempt is dispatched through a connector bound to
     a closed local port, so the provider call fails on the wire (the request never reaches the
     system of record); the durable row is asserted as `state=queued`, `retry_count=1`,
     `last_error_class=RETRYABLE`, then the same run is claimed again by the same worker identity and
     executed through the live-provider factory in the same process, completing from its checkpoint
     with `retry_count` unchanged and read back through R03. This is a durable row-level
     requeue/reclaim proof, not a process-restart proof;
  3. redelivery of the same turn answers from the run already started (case 3); a changed payload
     under the same key is `IDEMPOTENCY_CONFLICT` (case 4);
  4. with the approved FAQ corpus absent (draft), `skill.care.search_faq` fails closed and invents
     no answer (case 5) — the case proves the refusal, not a successful FAQ answer; another
     customer's order is never disclosed (case 6);
  5. the capabilities this build does not bind are named, not stubbed (case 7).
- The reattempt/exhaustion contract is additionally pinned by unit regressions on the real
  orchestrator with an injected engine: a re-claimed run books `RETRYABLE` and spends budget instead
  of returning to the queue unrecorded, and a restarted mutating step parks with the checkpoint
  `waiting` requires.

- Docker build/load/inspect/boot gate (`node scripts/docker-smoke.mjs --project agentos-ci-smoke
  --env-file <isolated env> --wait-seconds 600`) — **exit 0**: all three images built through
  Compose, loaded locally, inspected (no registry push), and api/worker/command-center all reported
  `running | health healthy` on the isolated project, then torn down. Run with an isolated topology
  (`COMPOSE_CONTAINER_PREFIX=agentos-cismoke` plus distinct host ports) so the running local stack
  keeps its own container names and ports.

Two caveats observed while running that gate. Neither is a blocker for the verified run, and the two
runs were not a one-variable comparison (the first also carried the pilot tenant):

1. Compose configuration limitation: `docker-compose.yml` (tracked) hardcodes the worker healthcheck
   to `http://127.0.0.1:4001/health` while passing `${WORKER_HEALTH_PORT}` into the process. A run
   that overrides `WORKER_HEALTH_PORT` away from 4001 therefore probes a port the process does not
   listen on. The verified run left the variable at its default.
2. The Compose stack applies no migrations: `docker/postgres/init.sql` creates extensions, schema and
   roles only, and the gate asserts image build/load plus container health, not business behaviour
   (the smoke's own closing line says so). With `CARE_TENANT_IDS` set to the pilot tenant, the booted
   worker logs `relation "agentos.platform_durable_tasks" does not exist` on every poll until the raw
   SQL migrations are applied to that database. `.env.example` (what the CI job copies) omits
   `CARE_TENANT_IDS`, which Compose defaults to empty, so polling is disabled there and the gate does
   not exercise a working store. Running the pilot on Compose needs a migration step — or a
   pre-migrated database — before the worker can execute.

## Decision

Keep `approvals.decide` and `runs.reconcile` fail-closed with their missing input named. Do not add a
parallel resume protocol, a second approval status, or a speculative queue: the next implementation
step is the authorized decision/reconciliation handoff described above.
