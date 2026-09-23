# P1 Customer Care Runtime — Blocked Work

## Status

The P1 Customer Care execution runtime is **not end-to-end bound**. The repository preserves fail-closed behavior rather than inventing missing policy, provider, approval, context, or idempotency behavior.

No API-to-durable-Care integration claim is supportable from the current contracts and composition roots.

## Blocked items

### 1. Bind `runs.start` through the existing gateway and orchestrator

**Status:** Blocked.

**Current behavior:**

- `apps/api/src/runtime/composition.ts:208-213` binds `runs.start` to `UnboundPortError`.
- `apps/api/src/runtime/bindings.ts:444-537` exposes only durable run `read`, `classifyRetry`, `retry`, and `list` behavior.
- `apps/api/src/routes/v1/conversations.ts:194-269` computes an effect key, checks for a completed receipt, calls `runs.start`, and stores a receipt afterward.

**Why blocked:**

- No production `RevenueOrchestrator` factory exists.
- `RevenueOrchestrator` requires all of the following, but no composition root supplies them as one authentic graph:
  - context aggregation;
  - agent hypothesis, routing, and plan generation;
  - policy/PEP evaluation;
  - durable workflow engine;
  - evidence logger;
  - audit trail;
  - adapter dispatcher;
  - effect guard;
  - takeover/session control;
  - durable execution lease manager.
- The existing receipt-after-start route cannot safely claim idempotency before execution as currently wired: the canonical reservation helper requires a `run_id`, but this route only receives one after `runs.start` returns.
- A coordinated run-ID allocation and reservation protocol is needed before enabling this path; changing only the API route risks concurrent duplicate starts or an orphaned reservation.
- No authoritative Customer Care context, routing, policy, or provider behavior is available to fill the missing dependencies.

**Required unblock:**

- Define and approve the production composition for every `RevenueOrchestrator` dependency.
- Define a safe start-time reservation/claim contract that binds the inbound request identity before execution without inventing a run id or allowing duplicate dispatch.
- Provide authoritative P1 policy, identity/context, skill-routing, and provider inputs.

---

### 2. Bind `runs.reconcile` with durable `UNKNOWN` recovery

**Status:** Blocked.

**Current behavior:**

- `apps/api/src/runtime/composition.ts:211-213` binds `runs.reconcile` to `UnboundPortError`.
- The effect guard can read an existing durable reservation, but it cannot query a provider to establish whether an indeterminate effect succeeded or was absent.
- The worker parks reclaimed mutating actions requiring reconciliation instead of redispatching them.

**Why blocked:**

- No provider-side reconciliation lookup or reconciliation adapter port is bound.
- The existing API-001 connector reports unconfirmed outcomes but does not provide a provider-specific effect lookup operation.
- No production worker/orchestrator composition exists to load the checkpoint, resolve the original effect identity, consult the provider, settle the reservation, and resume the durable task.
- Blind redispatch would violate the `UNKNOWN` invariant and could duplicate an external effect.

**Required unblock:**

- Add an authoritative provider reconciliation contract keyed by the deterministic effect identity/provider reference.
- Bind that contract into the worker/orchestrator graph.
- Define settlement and resume behavior for confirmed success, confirmed absence, and unresolved/manual escalation.

---

### 3. Bind `approvals.decide` with AUTH-4 and takeover guards

**Status:** Blocked.

**Current behavior:**

- `apps/api/src/runtime/composition.ts:215-219` binds `approvals.decide` to `UnboundPortError`.
- Approval queue and detail reads are repository-backed.
- The durable workflow contracts include an approval claim/resume operation, but no API-to-orchestrator resume composition invokes it safely.

**Why blocked:**

- No production approval-resume graph exists.
- A direct repository mutation would bypass the required policy re-evaluation, exact action/effect binding, evidence/audit flow, and worker dispatch boundary.
- AUTH-4 decisions must be bound to the reviewed payload digest, run, action, and effect key.
- Takeover supremacy must be checked before an approved action is released for dispatch; rejection/cancellation behavior must remain available while takeover is active.
- No composition currently connects authenticated operator decisions to `RevenueOrchestrator.resumeTask` with these guards.

**Required unblock:**

- Bind the authenticated approval route to the orchestrator resume path.
- Re-evaluate the exact action and reviewed digest through the authoritative PEP/policy source.
- Enforce takeover supremacy before any released dispatch.
- Preserve the existing atomic approval claim/task transition and persist the decision's audit/evidence before any authorized dispatch.

---

### 4. Bind canonical P1 Care skills through the registry runtime

**Status:** Blocked.

**Current behavior:**

- `packages/skills/src/platform/index.ts:18-25` registers the platform rows.
- Rows are enabled only when `effect_class === 'READ'`.
- Mutating Care rows remain registered but disabled.
- Skill rows dispatch through injected `PlatformSkillDependencies.tools`; no production tool binding is supplied.

**Why blocked:**

- The Care rows are declarative contracts, not a complete production runtime.
- No `SkillToolPort` composition maps each required Care tool binding to an authoritative adapter/provider implementation.
- No production skill runtime is connected to the orchestrator's action drafting, PEP verdict, effect reservation, approval binding, evidence, or audit flow.
- Enabling mutating rows without those guards would bypass policy and could dispatch unapproved effects.
- Some Care skills require authoritative identity, FAQ/knowledge, logistics, handoff, or ERP inputs that are not bound by the current repository.

**Required unblock:**

- Define the exact P1 Care skill subset and authoritative data sources.
- Bind `SkillToolPort` implementations for each enabled skill.
- Connect the registry/runtime to PEP, deterministic effect reservation, approval, evidence, and audit contracts.
- Enable mutating rows only after the complete guarded path exists.

---

### 5. Bind durable worker adapter, evidence, and audit flow

**Status:** Blocked.

**Current behavior:**

- `apps/worker/src/worker.ts:98-163` contains strict claimed-task validation, lease fencing, failure recording, and reconciliation parking for reclaimed mutating actions.
- `apps/worker/src/worker.ts:170-288` contains tenant-scoped PostgreSQL claim/lease polling.
- `startWorker` requires an injected `orchestratorFactory`.
- Without `CARE_TENANT_IDS` or the factory, polling is disabled and explicit blockers are reported.
- `apps/worker/src/runtime/connectors.ts` binds API-001 only when explicitly configured for the local/CI mock provider; otherwise the connector is unbound.

**Why blocked:**

- No authentic `orchestratorFactory` binds the worker's durable repository, skill runtime, PEP/policy, adapter dispatcher, evidence logger, audit trail, session control, and lease manager.
- No production `SkillToolPort` maps Care skill tool bindings to connectors.
- No authoritative mutation authority is configured for API-001; the default authority refuses every mutation.
- Binding a poller without the orchestrator graph would claim durable work that cannot be executed correctly.

**Required unblock:**

- Supply a production worker composition factory with all required dependencies.
- Bind explicit tenant scope and approved provider connectors.
- Bind evidence/audit writers to the same durable run and tenant chain.
- Prove restart-safe execution, reservation-before-dispatch, and lease-fenced recovery with integration coverage.

---

### 6. Add API-to-durable-Care integration coverage

**Status:** Blocked.

**Why blocked:**

- The requested scenario requires `/api/v1` intake to create a durable run, the worker to execute a permitted Care skill, evidence/outcome to persist, and the result to be read back through the API.
- `runs.start` remains intentionally unbound, so no truthful end-to-end execution can enter the durable worker path.
- No production orchestrator factory, Care skill tool graph, authoritative policy/context source, or provider reconciliation source exists to exercise the scenario.
- Mock providers can support deterministic local/CI integration tests, but cannot substitute for a missing production composition or prove an invented success path.

**Required unblock:**

- Complete blockers 1–5 with approved authoritative bindings.
- Add an integration fixture that exercises the real API, durable PostgreSQL task lifecycle, worker claim/lease path, permitted Care skill, evidence/audit persistence, and API readback.
- Add negative tests for tenant/customer isolation, AUTH-5 denial, takeover supremacy, duplicate delivery, and `UNKNOWN` reconciliation.

---

### 7. Complete the build and Docker smoke suite

**Status:** Blocked for the full requested gate.

**Current behavior:**

- Production builds for the affected packages passed.
- Docker image build/inspection passed.

**Why blocked:**

- Docker health boot is blocked by fixed `container_name` collisions from the existing local Compose stack using `agentos-*` names.
- The smoke suite cannot establish a clean health boot while those containers already occupy the required names.
- This is an environment/topology blocker, not evidence that the affected application builds fail.

**Required unblock:**

- Run the smoke suite against an isolated Compose project/network or stop the conflicting local stack with explicit operator authorization.
- Re-run the complete Docker health and API/worker smoke flow in the isolated environment.

---

## Bound capabilities that are not blocked

The following durable/read-only or safety paths are available:

- Durable run read projection.
- Durable run listing.
- Retry classification for proven side-effect-free failures.
- Retry/requeue path guarded against `UNKNOWN` effects.
- Approval queue/detail reads.
- Effect reservation lookup and reconciliation classification at the storage layer.
- PostgreSQL task claim and lease fencing.
- Optimistic task-version guards.
- Durable failure recording and retry budget handling.
- Strict tenant, channel, module, and takeover checks in the worker/API boundaries.
- Fail-closed connector resolution and explicit API-001 mock-provider restrictions.

These capabilities do not constitute a complete P1 execution runtime.

## Verification evidence

Reported and verified on this branch:

- Typechecks passed: core-engine, database, API, worker.
- Unit suites passed:
  - core-engine: 190;
  - database: 200;
  - skills: 67;
  - adapters: 19;
  - worker: 19;
  - API: 33.
- API startup tests: 3/3 passed, including the expected invalid-environment fatal report.
- Affected package builds passed: core-engine, database, API, worker.
- `git diff --check`: passed.

## Decision

Keep all blocked mutation paths fail-closed. Do not add a parallel orchestrator, policy engine, skill system, queue, provider behavior, synthetic approval, or speculative idempotency protocol. The next implementation step is to compose the existing contracts with authoritative policy, identity/context, provider, and approval inputs while retaining their safety invariants.
