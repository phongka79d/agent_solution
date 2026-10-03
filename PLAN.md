# AgentOS 360 — Integration, UX and Hardening Plan

| | |
|---|---|
| Branch | `feat/demo-live-3agent` |
| Audited HEAD | `7c03cb2` (CI run 36711392513: **green**) |
| Date | 2026-09-30 |
| Main reference | [`docs/product/workflow.md`](docs/product/workflow.md) (AgentOS 360 — End-to-End Workflow) |
| Evidence | Full read of `apps/*`, `packages/*`, `services/mock-erp`, `scripts`, `tests`, migrations `0000`–`0022`; 17 user screenshots (11 Company, 6 Platform); an offline boot of the real stack (PostgreSQL 16 + mock ERP + API + worker + both consoles, API/worker connected as `agentos_app`) |
| Status | **Plan only. Nothing in this document has been implemented.** |

## How to use this plan

- Execute **phases in order** (§5). Inside a phase, execute tasks in the listed order unless a task says it can run in parallel.
- Every task uses the same block: Problem, Why, Files/Modules, Dependencies, Implementation, Verification, Expected Result. Task IDs (`T1.3`) are stable; other sections reference them.
- Evidence references use `path:line` at audited HEAD `7c03cb2`. Line numbers drift; search for the quoted symbol if a line moved.
- Each task ends with a green run of the **per-task gate** (§13.4) before commit. Each phase ends with the **phase gate** (§13.4) and a push to `feat/demo-live-3agent`.
- Commit body must end with `Governance: unchanged` or `Governance: tightened (<what>)`. A change that would loosen an invariant in §0 is **not** made; raise it instead.
- Never commit `.env*` (except `.env.example`), tokens, API keys, Playwright traces from live runs, or database dumps.

## 0. Non-negotiable invariants (workflow.md §26, §32)

Tenant isolation and RLS · verified identity before any private lookup · no direct agent-to-agent calls (Revenue Orchestrator owns routing) · PEP owns policy · AUTH-5 terminal deny · AUTH-4 explicit, digest-bound, single-use human approval · no blind retry of UNKNOWN effects · idempotency (effect_key reservation) · takeover mutex · consent enforcement · audit/evidence chains · FACT / SIGNAL / HYPOTHESIS separation · LLM proposes, never owns price/stock/tenant/customer/authority · never fake success or delivery · secrets never reach the browser or logs.

---

## 1. Executive Summary

### 1.1 What is wrong

CI is green, yet the product does not work end to end. The offline boot reproduced the user's screenshots exactly, and the root causes are concrete:

| # | Symptom (screenshot) | Verified root cause | Fix |
|---|---|---|---|
| R1 | 11 of 12 runs "Lỗi" (PA2); conversations show only customer messages (CA4) | `RunResponseRepository` replay read uses `SELECT … FOR UPDATE` (`packages/database/src/repositories/run-responses.ts:76-77`) but migration `0019_append_only_idempotent_costs.sql:6` revoked `UPDATE` on `run_responses` from `agentos_app`. Every conversational run fails at the final save with `permission denied for table run_responses` (FATAL, `UNCLASSIFIED`). Reproduced; granting UPDATE made Sales and Care complete with an agent reply. | T1.1 |
| R2 | Platform Overview "Đã xảy ra lỗi", Usage "Không thể tải dữ liệu" (PA1, PA3) | `isPlainRecord(request.query)` (`apps/api/src/routes/v1/platform.ts:27-31`) rejects Fastify's null-prototype-like query object, so `usageWindow` (`:57-62`) always answers `400 from and to are required`; the same helper makes the `tenant_id` query guard (`:35`) a silent no-op. Overview uses all-or-nothing `Promise.all` (`PlatformOverview.tsx:24-34`). | T1.2 |
| R3 | "I want to speak to a person" never reaches a human | `handoff-handler.ts:50` fingerprints the input **without** `effect_key`, while the reservation was made over the pending payload **with** it; `care-handoffs.ts:371-382` rejects `HANDOFF_EFFECT_RESERVATION_INVALID`, task left `waiting` with no error. | T1.3 |
| R4 | Stock/price-by-SKU questions, ambiguous turns, anonymous advisor chats and FAQ misses end in "Lỗi" | Clarification requires `working_memory.response_skill_id/response_adapter_target`, which nothing sets → `RESPONSE_SENDER_UNBOUND` (`revenue-orchestrator.ts:2285-2338`); empty plans → `RESPONSE_EVIDENCE_MISSING` (`:1911-1915`); FAQ miss → `RESPONSE_UNGROUNDED` (`response.ts:230-235`). | T1.4 |
| R5 | "Thử trợ lý Sales" refuses with raw English error (CA11) | Tenant BFF always replaces `Authorization` with the operator token (`apps/tenant-console/src/app/api/v1/[...path]/route.ts:52,126`); `/storefront/stream` accepts widget sessions only (`storefront.ts:125-133`). Even if fixed, the page reads only the receipt line and never polls the task (`try/page.tsx:16-32`). | T1.8 |
| R6 | 4 campaign cards titled "winback", none reaching Approvals (CA5, CA6) | Console sends the objective as `segment_id`; worker rejects anything not `inactive_Nd` (`marketing/factory.ts:270`, `MARKETING_CAMPAIGN_INVALID`); API accepts any string. With a valid segment, content generation needs the LLM, errors are relabelled `PROVIDER_UNAVAILABLE` and retried 3×. | T1.5, T1.9 |
| R7 | AI Team "Chưa phân loại", every connector "Chưa cấu hình", workspace "Production" (CA1, CA2, CA8) | Schema can only store a shell: `tenant_capabilities.status='UNCONFIGURED'`, `connector_configurations.status IN ('UNBOUND','DISABLED')`, `tenants.status='PROVISIONED'` (`0006_p5_controlled_autonomy.sql:8,18,24,31,94`). No write API exists for any configuration. Real bindings live only in env. No `data_class`. | Phase 2 |
| R8 | Raw codes, English, "Chưa phân loại" everywhere | UI/API contract drift: UI reads `name`, API sends `display_name`; UI reads `lease.*`, API sends `owner.*`; API emits ~60 enum values missing from `packages/ui-foundation/src/status-view.ts:26-53`; legacy English SCR-003 approval component still mounted. | T1.10, Phase 6 |
| R9 | "Why didn't tests catch this?" | `demo:smoke` reads only the admission receipt (`scripts/demo/smoke.mjs:89-99`); Playwright runs against a stub API (`tests/ui/global-setup.ts:114-220`); unit tests mock the fields the API never returns; no job runs the stack as `agentos_app` end to end; 500s are never logged (`apps/api/src/gateway/http.ts:236-239,277-282`). | Phase 0, Phase 10 |

### 1.2 Target

A product where every workflow in `workflow.md` runs through **UI → API → service → orchestrator → PEP → skill → adapter → DB → response → Company UI and Admin UI**, configuration is stored in the database (env only bootstraps), and a real end-to-end suite proves it.

### 1.3 Phases at a glance

| Phase | Outcome | Size |
|---|---|---|
| 0 Safety net | 5xx logged; a real-stack E2E suite that fails today for R1–R6 | S |
| 1 Unblock core flows | Sales, Care, escalation, takeover, campaign-to-approval and Try-assistant work end to end | M |
| 2 Configuration foundation | Profile, governance, LLM provider, connectors, secrets, agent activation persisted and editable | L |
| 3 Knowledge | DB-backed knowledge with Draft → Review → Approved → Available, used by agents | M |
| 4 Skills | Skills catalog, per-tenant enablement/config/assignment, test and health, used by the real runtime | L |
| 5 Trace & observability | Stage results, error catalog, PII-safe audit, LLM usage everywhere, run projection v2 | M |
| 6 Company UI | Clean business console on real data, one vocabulary, no raw codes | L |
| 7 Test Customer Lab | `workflow.md` §5 complete with server-side TEST data class | M |
| 8 Admin UI & control plane | Cross-company operations, diagnostics, retry/reconcile, providers, health, audit | L |
| 9 Real identity | Users, memberships, persistent sessions; demo auth stays local/CI only | M |
| 10 Testing & CI | Live E2E, chaos, contract tests, CI gates | M |
| 11 Cleanup | Dead code, duplicates, docs | S |

### 1.4 Decisions taken in this plan (recommended defaults; change before starting a phase if needed)

| ID | Decision | Default in this plan |
|---|---|---|
| D1 | Try-assistant transport | BFF-held widget session via a server-side test-chat route; the browser never holds a bearer (T1.8) |
| D2 | Autonomy `MINIMUM` meaning | READ skills run at baseline authority; `PARKED_DRAFT` only for DEMOTED/PAUSED/kill-switch/drift; explicit promotion only for `generate_content`, `segment_audience` (T4.5) |
| D3 | `create_order` authority | AUTH-4 approval per workflow §9 (T4.1) |
| D4 | Configuration ownership | DB is the source of truth; env values are imported once as `source='ENV'` defaults and shown as such (T2.6) |
| D5 | Secrets | AES-256-GCM envelope encryption in DB using `ENCRYPTION_KEY_AES256` (key id + rotation); write-only API; external secret manager later (T2.2) |
| D6 | LLM configuration scope | Platform default provider (Platform Admin) + optional company override (Company Admin, workflow §4) (T2.5) |
| D7 | Knowledge store | DB-backed, versioned, RLS; separate `knowledge:approve`; demo corpus imported (Phase 3) |
| D8 | Status vocabulary ownership | API emits stable, documented enums per domain; UI owns labels through one domain-scoped catalog; raw codes only in Advanced (T1.10) |
| D9 | Cross-tenant admin model | Platform SECURITY DEFINER read projections + tenant-targeted commands executed inside `withTenantContext(target)` with audit; no impersonation (Phase 8) |
| D10 | Real-time | Polling with ETag (5 s visible tab) now; SSE later (T6.2) |
| D11 | Operator reply delivery | Label "Đã lưu" until a channel confirms delivery; widget reads messages through a widget-scoped endpoint (T1.10) |
| D12 | Sales → Care onboarding itinerary | **Still open (workflow §31).** Shown as an owner input "Chưa cấu hình"; no default is invented |
| D13 | Subscriptions | Hidden behind a feature flag until billing is in scope; nav shows "Chưa tích hợp" (T8.8) |
| D14 | Marketing consent gating READ advisory | Marketing consent gates outbound messages only, not read-only advice (T1.14) |
| D15 | Identity | DB users + memberships + persistent sessions behind the existing `AuthProvider` seam; demo provider remains for local/CI (Phase 9) |

---

## 2. Current Architecture & Flow

### 2.1 Components

```text
Browser (Company console :3000)          Browser (Platform console :3001)       Storefront widget (unused)
   │  Next.js 14 app router                 │  Next.js 14 app router
   ▼                                        ▼
Tenant BFF  /api/auth/*  /api/v1/[...path]   Platform BFF  /api/auth/*  /api/v1/[...path]
   │  in-memory session store, HMAC cookie,  │  same design, regex allowlist
   │  CSRF, allowlist (lib/bff-allowlist.ts) │  (lib/auth/demo-provider.ts:258-279)
   │  replaces Authorization with operator token
   ▼                                        ▼
API gateway  apps/api  (Fastify, /api/v1, 51 routes)
   │  principal.ts (OPERATOR / CHANNEL_SESSION / WIDGET_SESSION; demo credential store only)
   │  routes/v1/*  →  runtime/composition.ts ports  →  packages/database repositories (withTenantContext → RLS)
   │  projections/*  (company overview, attention, AI team, activity, integrations, customers, campaigns)
   │  care-turn.ts admission: reserve effect → LLM intent (API only) → queued durable task → customer message
   ▼
PostgreSQL (agentos schema, 22 migrations, FORCE RLS)  ◄───────────────┐
   ▲  platform_durable_tasks (queue + checkpoint)                        │
   │                                                                      │
Worker  apps/worker (poller per tenant in WORKER_TENANT_IDS)              │
   │  claim (SKIP LOCKED) → lease + heartbeat → domain registry          │
   │  → RevenueOrchestrator (packages/core-engine, 11 stages)             │
   │      → agent runtime (care | sales | marketing) → plan              │
   │      → DomainPolicyEngine → PolicyEnforcementPoint (AUTH-0..5)       │
   │      → autonomy admission (DB) → EffectGuard reservation             │
   │      → SkillRuntimeEngine (packages/skills, 23 code-defined rows)    │
   │      → tool port → adapters (ERP API-001 mock only, LLM, filesystem knowledge)
   │      → evidence + audit chains → response finalizer → run_responses + agent message ──┘
   ▼
mock-erp (local/CI only)   OpenAI-compatible LLM (env key)   packages/second-brain files (KNOWLEDGE_ROOT)
```

### 2.2 Where configuration comes from today

| Concern | Source today | Consequence |
|---|---|---|
| Tenants polled by worker | env `WORKER_TENANT_IDS` (`apps/worker/src/index.ts:74`) | A newly provisioned company is never processed |
| Enabled domains | env `ENABLED_AGENT_MODULES` (default `support`) + `SALES_/MARKETING_SIGNAL_*` | Company cannot enable a domain |
| ERP connector | env `MOCK_ERP_ENABLED`, `ERP_API_BASE_URL`, `MOCK_SECRET_KEY` (`apps/worker/src/runtime/connectors.ts:114-198`); managed envs have no ERP at all | No real ERP; UI shows DB rows that are always `UNBOUND` |
| LLM provider | env `OPENAI_*`, read separately by API (`composition.ts:388-400`) and worker (`worker-bindings.ts:170-244`) | Cannot change without redeploy; API and worker can disagree |
| Knowledge | files under `KNOWLEDGE_ROOT` + `KNOWLEDGE_TENANT_IDS` | No add/review/approve |
| Skills | code rows + three hard-coded enablement lists | No management; DB `skills` table never read |
| Agent activation | DB `agents.is_active` — only the demo seed ever sets it | New companies: every run `UNKNOWN_AGENT` |
| Autonomy | DB `autonomy_policies` (MINIMUM parks read skills) — demo seed promotes 6 skills | New companies: every promotable step parks invisibly |
| Identity | env demo accounts, in-process 30-min sessions (`apps/api/src/runtime/demo-auth.ts`) | No users, no production auth, sessions lost on restart |
| Data class | none (demo detected from env) | "Production" label on the demo tenant |

### 2.3 Actual end-to-end flows (verified on the running stack)

| Flow | Hops (evidence) | Result today |
|---|---|---|
| Company sign-in | sign-in page → BFF `/api/auth/sign-in` → `POST /demo/login` (audience) → BFF session + cookie → middleware + `(app)/layout.tsx` server validation | Works (demo only) |
| Sales advisor chat | widget turn → `storefront.ts` → `admitCareTurn` → durable task → worker Sales plan (search → stock → price → recommend) → finalizer → `run_responses` save | **Fails at save (R1)**; works after R1 fix for a verified, consenting persona only |
| Sales SKU stock/price question | → Sales intent → clarification plan | **Fails `RESPONSE_SENDER_UNBOUND` (R4)** |
| Care FAQ | → Care FAQ skill (filesystem) → finalizer | **Fails at save (R1)**; FAQ miss fails `RESPONSE_UNGROUNDED` |
| Human escalation | → `escalate_to_human` → `CareHandoffRepository.enqueue` | **Stalls `waiting` (R3)** |
| Takeover / reply / resume | Company console → takeover (Redis lease 60 s) → operator message (persisted only) → resume | Works; lapsed lease still shows `paused_takeover`; customer never receives the operator reply |
| Campaign draft | console → `POST /campaigns/drafts` → worker marketing plan (segment → content(LLM) → brand audit → dispatch AUTH-4) | **Fails `MARKETING_CAMPAIGN_INVALID` (R6)**; with valid segment, fails on LLM/brand prerequisites; approval never reached |
| Approval decision | Approvals page → `POST /approvals/:id/decision` → queued resume event → worker claim → re-validate → dispatch | Not reachable (no approvals); digest definition mismatch suspected (T1.6) |
| Try assistant | page → BFF (operator token) → `/storefront/stream` | **Refused (R5)** |
| Platform overview/usage | page → BFF → `/platform/usage?from&to` | **400 (R2)** |
| Platform operations | page → `/runs` | Works but agent/latency/cost/error reason missing; BFF `/runs` path mismatch reported on the running stack |
| Retry | `POST /operations/runs/:id/retry` | Works server-side (safe requeue); UI eligibility disagrees with server |
| Reconcile UNKNOWN | `POST /operations/runs/:id/reconciliation` | API exists; no BFF route, no UI; no automatic reconciler |

---

## 3. Target Workflow

The target is `workflow.md` implemented literally. The mapping below names the component that owns each step.

### 3.1 Ownership principles

1. **Database is the source of truth for configuration.** Env provides bootstrap values only; on first boot they are imported as rows marked `source='ENV'` and shown as such.
2. **Every business screen reads a projection.** Projections aggregate authoritative rows; they never invent numbers. A missing source returns an explicit state (`NOT_CONFIGURED`, `NOT_INTEGRATED`, `NO_DATA`).
3. **One vocabulary.** The API emits documented enums per domain (OpenAPI). `ui-foundation` maps each `(domain, code)` to a §24 label, tone and icon. Raw codes appear only inside "Chi tiết kỹ thuật".
4. **Every run ends in a visible outcome.** Answer, clarification, refusal, handoff acknowledgement, awaiting approval, or failure with a reason — never silence.
5. **Every mutation is audited and idempotent** (`Idempotency-Key`, effect reservation, `platform_audit_events` / tenant audit).

### 3.2 Target flows

| Workflow (§) | Target path |
|---|---|
| Auth (§3) | middleware → server-validated layout → `AuthProvider` (DB users/memberships/sessions; demo provider local/CI) → membership + permissions → dashboard; expiry → `/sign-in?reason=expired`; logout invalidates server session |
| Onboarding (§4) | Platform: Companies → Create company (provision shell, `data_class`) → invite Company Admin → Company: Setup checklist (profile, product/ERP source, knowledge, LLM, channels, test agents) → Activate AI Team (prerequisite-checked) |
| Test Customer Lab (§5) | `/testing/customers` → `/api/v1/testing/*` → TEST-classed rows → Customer360 → launch storefront as customer (server-bound widget session) → reset TEST only |
| Dashboard (§6) | `/company/overview` projection: grouped Needs Attention, AI Team, recent activity (one line per run), useful metrics |
| AI Team (§7) | per domain: status + reason, current activity, needs attention, recent work, configuration (skills, sources, channels), advanced |
| Marketing (§8) | brief → analyze signal → segment → audience → LLM content → brand/compliance → consent → draft → AUTH-4 approval → revalidate payload + consent → dispatch or "Đã duyệt · Chưa tích hợp kênh gửi" |
| Sales (§9) | turn → LLM structured understanding (bounded retry, fail closed) → Sales agent → search → stock → price → recommend → grounded answer; order: propose → AUTH-4 → revalidate → ERP create_order → receipt + evidence |
| Care (§10–11) | FAQ from approved knowledge (graceful miss + escalate offer); order lookup with identity + ownership; escalation → durable handoff → NEEDS HUMAN → takeover → reply delivered → resume |
| Customer360 (§13) | profile, identity, consent, orders, conversations, campaigns, recommendations (HYPOTHESIS), cases, timeline with advanced classification |
| Cross-domain (§14) | broker only; Sales → Care itinerary is an owner input (open decision) |
| Governance (§15–16) | AUTH-4 pause → Approval Center → signed approval → payload re-check → execute; stale → reject; promotion with evidence window + human approval |
| Integrations (§17) | Connect (config + write-only secret) → Test (server probe) → status → runtime uses tenant binding |
| LLM (§18) | per-tenant or platform config → adapter with bounded retry → fail closed; usage recorded |
| Effects (§19) | effect_key → reserve → call → COMMITTED / UNKNOWN → reconcile (auto sweeper + operator) |
| Observability (§20) | friendly run story (Company) + diagnostic trace (Admin) from stage results |
| Recovery (§21–22) | checkpoint resume after crash; connector failure → explicit unavailable state |
| Platform Admin (§23) | Overview, Companies, Operations, Usage, Providers, System Health, Subscriptions (flagged), Settings, Audit |

---

## 4. Gap Analysis

Severity: **P0** blocks a core workflow · **P1** major gap · **P2** minor. "Tasks" reference §5.

| § | Area | Current | Gap | Sev | Tasks |
|---|---|---|---|---|---|
| — | Final response persistence | `FOR UPDATE` without UPDATE privilege | every conversational run fails | P0 | T1.1 |
| 23 | Platform directory/usage | `isPlainRecord` rejects query; all-or-nothing UI | overview/usage broken; 500s unlogged | P0 | T0.1, T1.2 |
| 11 | Escalation | fingerprint mismatch | handoff never enqueued | P0 | T1.3 |
| 9–10 | Clarification / refusal / FAQ miss | throw instead of replying | silent failure | P0 | T1.4 |
| 18–19 | Error classification | skill errors → `PROVIDER_UNAVAILABLE` ×3 | wrong retries, hidden cause | P0 | T1.5 |
| 15 | Approval digest | two digest definitions | approved actions may fail `APPROVAL_PAYLOAD_MISMATCH` | P0 | T1.6 |
| 19 | Outcome watch | `initializeOutcomeWatch` throws | successful mutating steps park | P1 | T1.7 |
| 9 | Try assistant | operator token to storefront; receipt-only read | test chat unusable | P0 | T1.8 |
| 8 | Campaign admission | objective sent as segment; failures shown as "Nháp" | drafts never reach approval | P0 | T1.9 |
| 12 | Conversation delivery | customer message after run start; no system message on failure; customer cannot read replies; lapsed lease | confusing thread, lost replies | P1 | T1.10 |
| 21 | Lease heartbeat | version-predicated renew | live runs aborted | P1 | T1.11 |
| 10 | Care identity/conversation | aggregators disagree | anonymous Care for verified customers; replies dropped | P1 | T1.12 |
| 8 | Marketing consent port | no binding verifier | dispatch recheck always denies | P1 | T1.13 |
| 9 | Sales gating | marketing consent gates read advice; no SKU intent | most advisor chats refuse | P1 | T1.14 |
| 21 | In-memory run state | lost on reclaim | resumed runs lose identity/constraints | P1 | T1.15 |
| 4, 17, 23 | Config persistence | CHECKs allow only shell states | cannot configure anything | P0 | T2.1 |
| 4 | Secrets | none | no safe credential storage | P0 | T2.2 |
| 4 | Company profile | none | name/locale/timezone/currency/brand missing | P1 | T2.3 |
| 15 | Governance settings | read-only | distinct-approver unreachable | P1 | T2.4 |
| 4, 18 | LLM config | env only | cannot change provider/model/key | P0 | T2.5 |
| 17 | Connectors | env mock only, DB always UNBOUND | no connect/test; two truths | P0 | T2.6 |
| 7, 27 | AI Team activation | agents inactive, capabilities UNCONFIGURED | AI Team DISABLED | P0 | T2.7 |
| 23 | Worker tenant discovery | env list | new companies never run | P1 | T2.8 |
| — | Permissions | missing settings/knowledge/skills/testdata perms | cannot gate new features | P1 | T2.9 |
| — | Config audit | none readable | no history | P1 | T2.10 |
| 4 | Knowledge | files only | no lifecycle, no UI | P0 | T3.1–T3.4 |
| — | Skills | code-only, drift, dead DB table | not manageable | P0 | T4.1–T4.6 |
| 16 | Autonomy | MINIMUM parks reads; no promote path | new companies stall | P0 | T4.5 |
| 20 | Trace | stage entry only, no detail/result/duration | unreadable trace | P1 | T5.1, T5.4, T5.5 |
| 26 | PII in audit | full context logged | privacy breach | P1 | T5.2 |
| 18 | LLM retry/usage | one attempt; worker unmetered | fragile, unmeasured cost | P1 | T5.3 |
| 6–13 | Company UI | half legacy, contract drift | confusing product | P0/P1 | T6.1–T6.13 |
| 5, 25 | Test Customer Lab | missing | QA/demo flow impossible | P1 | T7.1–T7.5 |
| 23 | Admin control plane | tenant-bound, fake/empty screens | not operational | P0/P1 | T8.1–T8.10 |
| 3 | Real identity | demo only | no production path, no user monitoring | P1 | T9.1–T9.4 |
| — | Tests | acceptance-only smoke, stub UI tests | green CI, broken product | P0 | T0.2–T0.4, T10.1–T10.6 |
| 30 | Known debt | electronics classifier, demo model id | vertical lock-in | P2 | T11.3 |

---

## 5. Implementation Phases

Phase order and gates:

```text
Phase 0 ─► Phase 1 ─► Phase 2 ─┬─► Phase 3 ─┐
                               ├─► Phase 4 ─┼─► Phase 6 ─► Phase 7 ─► Phase 10 ─► Phase 11
                               └─► Phase 5 ─┘     ▲
                                   Phase 8 ◄──────┘ (needs 2, 5)
                                   Phase 9 (after 2; can run parallel to 3–8)
```

Each phase: **entry** = previous phase gate green; **exit** = every task verified + phase gate (§13.4) green + pushed + CI green.

### Phase 0 — Safety net and diagnostics

Goal: make failures visible and reproducible before changing behaviour.

- [ ] **T0.1 Log every 5xx and map database errors**
  - Problem: `mapError` turns unknown exceptions into `500 INTERNAL_ERROR` with no log (`apps/api/src/gateway/http.ts:236-239`); `replyFailure` (`:277-282`) and `setErrorHandler` (`apps/api/src/server.ts:142-154`) never log; routes call `replyFailure` directly.
  - Why: R1 and R2 were invisible in production; operators cannot diagnose anything.
  - Files/Modules: `apps/api/src/gateway/http.ts`, `apps/api/src/server.ts`, `apps/api/src/gateway/contracts.ts`.
  - Dependencies: none.
  - Implementation: in `replyFailure`, when status ≥ 500 call `reply.request.log.error({correlation_id, error_code, route, err:{name, code, constraint, routine, message:truncate(300)}})`; log 4xx at `warn` with code only; never log bodies, SQL parameters or `err.detail`. Map pg `42501`→`DEPENDENCY_MISCONFIGURED` (503), `42883`→`DEPENDENCY_MISCONFIGURED` (503), `22P02`→`VALIDATION_FAILED` (400). Add the unmapped repository codes listed in the API audit (`CUSTOMER_LIST_*`, `CAMPAIGN_LIST_*`, `CONVERSATION_NOT_FOUND`, `APPROVAL_*`, `HANDOFF_*`, `TASK_REQUEUE_REASON_REQUIRED`, `RUN_NOT_RECONCILABLE`, `TASK_ALREADY_TERMINAL`, `RECONCILIATION_EVENT_CONFLICT`, `RUN_LOG_PROJECTION_INVALID`, `PLATFORM_*`, `P5_*`) to 400/404/409. Change `PORT_UNBOUND` to 503 `CAPABILITY_UNAVAILABLE`.
  - Verification: unit test forces an unknown error and asserts one `error` log line with `correlation_id` and no secret; table test for each mapped code; non-UUID path param returns 400.
  - Expected Result: every 5xx is diagnosable from logs by correlation id; no known repository refusal becomes 500.

- [ ] **T0.2 Real-stack end-to-end harness (offline profile)**
  - Problem: no test runs API + worker + Postgres (as `agentos_app`) + mock ERP together and asserts outcomes; `demo:smoke` checks acceptance only (`scripts/demo/smoke.mjs:89-99`); Playwright uses a stub API (`tests/ui/global-setup.ts:114-220`).
  - Why: R1–R6 all passed CI.
  - Files/Modules: new `tests/stack/` (`global-setup.mjs`, `lib/{stack,api,db,widget}.mjs`, `*.stack.test.mjs`), new root script `test:stack`, reuse the audit launcher logic (native Postgres or compose), `scripts/demo/seed.mjs`.
  - Dependencies: T0.1 (logs), none functionally.
  - Implementation: boot Postgres, apply `docker/postgres/init.sql` + `init-roles.sh`, migrate as bootstrap superuser, **serve API and worker as `agentos_app`**, seed demo, start mock ERP, API, worker with `DEMO_PROVIDER_MODE=offline`. Helpers: `login(audience)`, `mintWidget(persona)`, `turn(message)`, `waitTask(task_id, terminal)`, `messages(conversation_id)`, `sql(...)` (read-only diagnostics). Write the first tests **expected to fail today** (mark `todo` until the fixing task lands): Sales advisor turn completes with an agent message (R1); `/platform/usage` returns 200 (R2); "I want to speak to a person" enqueues a handoff (R3); SKU stock question gets a clarification reply (R4); campaign draft with `inactive_90d` reaches `awaiting_approval` with the LLM stub (R6, see T0.4).
  - Verification: `pnpm test:stack` runs locally in < 10 min and reports the expected failures with task `error_details`.
  - Expected Result: a reproducible harness that proves real connectivity; each Phase 1 task flips one test from `todo` to passing.

- [ ] **T0.3 Make `demo:smoke` assert outcomes**
  - Problem: smoke passes while runs fail; live smoke creates new `winback` drafts and turns on every run (`smoke.mjs:198-236`).
  - Why: the demo gate must mean "works", not "accepted".
  - Files/Modules: `scripts/demo/smoke.mjs`, `scripts/demo/smoke.test.mjs`, `scripts/demo/up.mjs`.
  - Dependencies: T0.2 helpers (share `waitTask`).
  - Implementation: after each admission poll `GET /tasks/:id` until terminal; assert `completed` + agent message for Sales/Care, `awaiting_human` + approval row for campaign (live profile); tag every smoke entity with a run marker and clean it up (TEST class once T7.1 lands); add `demo:up --profile live` running `preflight --live` and `smoke --live`.
  - Verification: smoke fails on today's HEAD with the R1 error code; passes after Phase 1.
  - Expected Result: demo readiness is measured by answers, not receipts.

- [ ] **T0.4 Deterministic LLM stub for offline tests**
  - Problem: Marketing content and Care intent need an LLM; offline tests cannot reach approval.
  - Why: approvals, dispatch revalidation and campaign lifecycle must be tested without real keys.
  - Files/Modules: new `tests/stack/tools/llm-stub.mjs` (OpenAI-compatible `/chat/completions`, scripted responses, fault modes: 429, 500, timeout, invalid JSON), `tests/stack/global-setup.mjs`.
  - Dependencies: T0.2.
  - Implementation: tiny HTTP server returning schema-valid JSON for known prompts (content draft, care intent) and fault modes selected by header or scenario file; point `OPENAI_BASE_URL` to it in the stack profile only; refuse to start when `APP_ENV` is not `local|ci`.
  - Verification: stack test can run a campaign to `awaiting_approval`; fault modes produce the typed refusals.
  - Expected Result: every LLM-dependent path is testable offline, including failure paths.

- [ ] **T0.5 Schema-version and role self-check at boot**
  - Problem: API/worker never check applied migrations or platform role membership (R2 suspects; DB audit S10).
  - Why: a stale database silently breaks platform pages.
  - Files/Modules: `packages/database/src/schema-check.ts` (new), `apps/api/src/server.ts`, `apps/worker/src/index.ts`, `packages/core-engine/src/config/readiness.mjs`.
  - Dependencies: none.
  - Implementation: at startup read `agentos_meta.schema_migrations` and compare with the migration files bundled in the image; check `to_regprocedure('agentos.platform_list_tenants()')` and `pg_has_role(current_user,'agentos_platform','MEMBER')`; expose failures as `/ready` 503 with value-free codes (`SCHEMA_BEHIND`, `PLATFORM_ROLE_MISSING`).
  - Verification: boot against a DB migrated to 0015 → `/ready` 503 `SCHEMA_BEHIND`.
  - Expected Result: misconfigured databases fail loudly at boot, not as opaque 500s.

**Phase 0 exit:** T0.1–T0.5 merged; `pnpm test:stack` runs and reports the known failures; CI green (stack tests marked `todo` do not fail CI yet).

### Phase 1 — Unblock the core flows

Goal: Sales, Care, escalation, takeover, campaign-to-approval, Try-assistant and Platform usage work end to end on the demo tenant.

- [ ] **T1.1 Remove `FOR UPDATE` from the run-response replay read**
  - Problem: `SELECT_RESPONSE_FOR_UPDATE` (`packages/database/src/repositories/run-responses.ts:76-77`) needs UPDATE privilege revoked by `0019_append_only_idempotent_costs.sql:6`; every conversational run fails (R1).
  - Why: this single defect explains "11 of 12 failed" and "no AI replies".
  - Files/Modules: `packages/database/src/repositories/run-responses.ts`, its tests; new DB test running as `agentos_app`.
  - Dependencies: T0.2.
  - Implementation: use plain `SELECT` for the replay read (the durable task row lock at `run-responses.ts:51-54` already serialises writers); keep the immutable trigger and revoked UPDATE. Add a repository test executed as `agentos_app` (not superuser) covering first save, exact replay and conflicting replay.
  - Verification: stack test "Sales advisor turn completes" and "Care FAQ completes" pass; `run_responses` row + agent `conversation_messages` row exist.
  - Expected Result: conversational runs complete and the customer sees the AI reply.

- [ ] **T1.2 Fix platform query parsing and make Platform pages resilient**
  - Problem: `isPlainRecord(request.query)` returns false for Fastify's query object (`apps/api/src/routes/v1/platform.ts:27-31`), so `/platform/usage` is always 400 and the `tenant_id` query guard (`:35`) is a no-op; Overview fails as a whole (`apps/platform-admin/src/components/platform/PlatformOverview.tsx:24-34`); client drops status/code (`lib/platform-client.ts:22-37`).
  - Why: R2 (PA1, PA3); plus a silent security guard gap.
  - Files/Modules: `apps/api/src/routes/v1/platform.ts`, `apps/platform-admin/src/lib/platform-client.ts`, `PlatformOverview.tsx`, `PlatformPages.tsx`, `Companies.tsx`.
  - Dependencies: T0.1.
  - Implementation: replace `isPlainRecord` for query/body with `typeof x === 'object' && x !== null`; add Fastify querystring schemas (`from`,`to` ISO date-time; `from < to`); client throws typed `ApiError{status,error_code,correlation_id}`; Overview uses `Promise.allSettled` with per-card skeleton / error (code + correlation id + "Thử lại"); guard cleared date inputs.
  - Verification: `inject()` test with real query parsing (`?from=…&to=…` → 200; `?tenant_id=…` → 403); unit test: usage 500 still renders tenants.
  - Expected Result: Platform Overview and Usage load; one failing card never blanks the page.

- [ ] **T1.3 Fix escalation fingerprint and surface handoff failures**
  - Problem: `handoff-handler.ts:50` fingerprints input without `effect_key`; reservation fingerprint includes it; `care-handoffs.ts:371-382` refuses; task left `waiting` with no error (R3).
  - Why: human escalation (workflow §11) never happens.
  - Files/Modules: `apps/worker/src/runtime/care/skills/handoff-handler.ts`, `packages/database/src/repositories/care-handoffs.ts`, `packages/core-engine` fingerprint helper.
  - Dependencies: T0.2.
  - Implementation: have the repository verify the reservation by `(tenant_id, effect_key)` and compare the fingerprint the reservation stores against `computeRequestFingerprint(pending_action.payload)` computed once in the orchestrator and passed through the dispatch context (single definition); when `enqueue` fails deterministically, record FATAL with the code instead of leaving `waiting`; write a system message "Đã chuyển cho nhân viên hỗ trợ" to the conversation after a successful enqueue.
  - Verification: stack test: escalation → `care_handoffs` row ENQUEUED, conversation `paused_takeover`, system message visible, Company Conversations shows "Cần nhân viên".
  - Expected Result: escalation reaches a human and the customer is told.

- [ ] **T1.4 Always answer: clarification, refusal and no-answer replies**
  - Problem: clarification plan throws `RESPONSE_SENDER_UNBOUND` (`packages/core-engine/src/orchestrator/revenue-orchestrator.ts:2285-2338`); empty plans throw `RESPONSE_EVIDENCE_MISSING` (`:1911-1915`); FAQ miss throws `RESPONSE_UNGROUNDED` (`apps/worker/src/runtime/shared/response.ts:230-235`).
  - Why: most real turns fail silently (R4).
  - Files/Modules: `revenue-orchestrator.ts` (`buildClarificationPlan`, `persistFinalResponse`), `apps/worker/src/runtime/shared/response.ts`, `apps/worker/src/runtime/{sales,care}/agent-runtime.ts`, `packages/database/src/repositories/run-responses.ts` (add `response_kind`), migration `0023_run_response_kind.sql`.
  - Dependencies: T1.1.
  - Implementation: replace the synthetic `send_message` clarification step with a terminal **typed response**: `response_kind IN ('ANSWER','CLARIFICATION','REFUSAL','NO_ANSWER','HANDOFF_ACK')`, text from an approved, localized template catalog keyed by reason (`sales.need_budget`, `sales.need_sku`, `care.need_order_reference`, `care.identity_required`, `care.faq_no_answer_offer_handoff`, …), source `Core.Template@<version>`; finalizer accepts templates without receipts only for these kinds; the run ends `completed` with `outcome=CLARIFIED|REFUSED|NO_ANSWER`. Add a Sales intent for SKU stock/price (`check_stock` + `check_price` plan) so direct SKU questions do not fall to clarification.
  - Verification: stack tests: "hi" → clarification reply; "How many NM-L01-BLK in stock and price?" → grounded stock+price answer; off-topic FAQ → no-answer reply with escalation offer; anonymous order lookup → identity-required reply; all runs `completed`.
  - Expected Result: no conversational run ends without a customer-visible message.

- [ ] **T1.5 Preserve skill error codes and classify failures correctly**
  - Problem: `dispatchWithDeadline` converts any non-`OrchestratorError` into `PROVIDER_INDETERMINATE` (`packages/core-engine/src/orchestrator/effect-reconciliation.ts:254-261`); read steps are retried as `PROVIDER_UNAVAILABLE` (`revenue-orchestrator.ts:1147-1153`); `serializeError` prints `UNCLASSIFIED`; non-Orchestrator infra errors are FATAL (`checkpoint-guards.ts:220`); unconfigured LLM burns 3 retries.
  - Why: wrong retries, hidden causes (PA2 `r3` + blank reason).
  - Files/Modules: `apps/worker/src/runtime/shared/skill-dispatcher.ts` (`mapSkillError`), `effect-reconciliation.ts`, `checkpoint-guards.ts` (`classifyFailure`, `serializeError`), new `packages/core-engine/src/errors/catalog.ts`, `apps/worker/src/worker-bindings.ts` (LLM error mapping).
  - Dependencies: none (can run parallel to T1.1).
  - Implementation: error catalog `code → {class: RETRYABLE|FATAL|UNKNOWN, reason_key, admin_hint}`; `mapSkillError`: `EFFECT_UNKNOWN`→UNKNOWN, READ `TIMEOUT`/`BREAKER_OPEN`/`PROVIDER_RATE_LIMITED`/5xx→RETRYABLE, deterministic refusals (`SKILL_DISABLED`, `UNAUTHORIZED_AGENT`, `SCHEMA_*`, `CONSENT_REQUIRED`, `OUT_OF_STOCK`, `LLM_NOT_CONFIGURED`, `LLM_AUTH_FAILED`)→FATAL with code kept; settle pre-effect refusals of mutating steps as FAILED (release reservation); `serializeError` keeps any string `.code`; transient DB errors (`40001`, `40P01`, connection reset) RETRYABLE.
  - Verification: unit table over the catalog; stack test with LLM unconfigured → campaign `failed` r0 with `LLM_NOT_CONFIGURED`.
  - Expected Result: retries only where they can help; every failure carries a readable code.

- [ ] **T1.6 One approval payload digest definition**
  - Problem: pause digests `action.payload` (incl. `effect_key` and PEP-added fields) (`revenue-orchestrator.ts:2278-2280,1635-1637`; `approvals.ts:1319`), engine digests the normalized input without `effect_key` (`skill-dispatcher.ts:93-95`; `packages/skills/src/runtime/approval.ts:40`); unit test builds the digest from the normalized payload so the real path is untested.
  - Why: approved AUTH-4 actions are expected to fail `APPROVAL_PAYLOAD_MISMATCH` (workflow §15).
  - Files/Modules: `packages/core-engine/src/durability/approval-digest.ts` (new `approvalPayloadDigest(action)`), `revenue-orchestrator.ts`, `packages/database/src/repositories/approvals.ts`, `apps/worker/src/runtime/shared/skill-dispatcher.ts`, `packages/skills/src/runtime/approval.ts`.
  - Dependencies: T0.4 (to reach an approval in stack tests).
  - Implementation: define the digest over the exact skill input the engine will execute (payload minus `effect_key`, minus policy annotations, after schema normalization); use it in `pauseForApproval`, `applyModification`, the approval row, and the engine seam; persist `digest_version` on the approval row.
  - Verification: stack test: campaign → approval → approve → dispatch step reaches the connector (refused `NOT_INTEGRATED` as expected) with no digest error; MODIFY path produces a new digest; stale digest rejected.
  - Expected Result: approve works; payload change after approval is rejected as stale.

- [ ] **T1.7 Implement the outcome watch**
  - Problem: durable `initializeOutcomeWatch` throws `CAPABILITY_NOT_ENABLED` (`apps/worker/src/runtime/shared/adapters.ts:697-716`), called after every successful mutating step (`revenue-orchestrator.ts:1306-1338`).
  - Why: the first real mutation (order, case, handoff) would park.
  - Files/Modules: `packages/database/src/repositories/evidence.ts` (new method), `apps/worker/src/runtime/shared/adapters.ts`.
  - Dependencies: none.
  - Implementation: `INSERT INTO pending_outcome_attributions … ON CONFLICT (tenant_id, effect_key) DO NOTHING`; a sweeper stub that expires watches after the window and records `outcome=UNKNOWN_OUTCOME` (full attribution later).
  - Verification: repository test; stack test with a bound mutating skill completes.
  - Expected Result: mutating steps complete and OUTCOME has data.

- [ ] **T1.8 Server-side test chat for "Thử trợ lý" (decision D1)**
  - Problem: BFF forwards the operator token to `/storefront/stream` (`apps/tenant-console/src/app/api/v1/[...path]/route.ts:52,126`); page reads only the receipt (`src/app/(app)/ai-team/sales/try/page.tsx:16-32`); error shown twice with a meaningless "Vì sao gợi ý này?" (R5).
  - Why: the flagship demo is broken.
  - Files/Modules: new `apps/tenant-console/src/app/api/testing/chat/{session,turn,task}/route.ts`, `src/lib/bff-allowlist.ts` (remove `storefront/*`), `try/page.tsx`, `packages/ui-foundation` error catalog.
  - Dependencies: T1.1, T1.4.
  - Implementation: `POST session` verifies console session + `conversation:takeover`, mints upstream `POST /demo/widget-session` (later `/testing/customers/:id/widget-session`, T7.4) and stores `{widgetToken, sessionId, exp}` server-side; returns an opaque `chat_session_id`. `POST turn` calls `/storefront/stream` with the widget token + server idempotency key, parses the receipt line, returns `{task_id}`. `GET task` polls `/tasks/:id` with the widget token. UI: auto-open session on first send, persona/TEST-customer picker, one inline error bubble mapped from `error_code`, "Vì sao gợi ý này?" only on completed answers (evidence from task `sources` + trace).
  - Verification: unit: proxy never forwards a browser `Authorization`; Playwright stack test: ask about a product → answer bubble with price from ERP; forced 403 → one Vietnamese error.
  - Expected Result: Company Admin can chat with the Sales agent from the console; the browser never holds a bearer.

- [ ] **T1.9 Valid campaign admission and honest lifecycle**
  - Problem: console sends objective as `segment_id` (`apps/tenant-console/src/app/(app)/campaigns/new/page.tsx:13-24`); API accepts any string (`apps/api/src/routes/v1/campaigns.ts`); worker rejects (`apps/worker/src/runtime/marketing/factory.ts:270`); projection maps failed tasks to `draft`, name falls back to objective (`apps/api/src/projections/campaigns.ts:51-76`); no `campaigns` row at admission.
  - Why: R6 — four meaningless "winback" drafts, none reaching approval.
  - Files/Modules: `apps/api/src/routes/v1/campaigns.ts`, `apps/api/src/projections/campaigns.ts`, `packages/database/src/repositories/company-crm-projections.ts`, new `GET /campaigns/segments`, campaigns pages.
  - Dependencies: T1.5, T0.4.
  - Implementation: API validates `segment_id` against real segments (`GET /campaigns/segments` from `segments` table + computed `inactive_Nd` options with audience counts); require `name`; insert a `campaigns` row (status `DRAFTING`) in the admission transaction linked to the run; lifecycle states `drafting | brand_review | awaiting_approval | approved | rejected | failed | cancelled` with `failure_reason_key`; dedupe runs with multiple approvals (`DISTINCT ON`).
  - Verification: API test: invalid segment → 400; stack test (LLM stub): draft → `awaiting_approval`, card shows name, audience count, "Chờ phê duyệt"; LLM fault → `failed` with reason.
  - Expected Result: campaigns are named, valid and show their real state.

- [ ] **T1.10 Conversation correctness: ordering, delivery, lapsed takeover, contract**
  - Problem: customer message appended after `runs.start` (`apps/api/src/routes/v1/care-turn.ts:573-581`); reservation left RESERVED when the LLM intent call throws (`:358-370,443-445`); no system message when a run fails; customers cannot read agent/operator replies (operator-only GET); operator reply persisted but never delivered; lapsed Redis lease still shows `paused_takeover` (no sweeper); UI reads `lease.*`/`name` while API sends `owner.*`/`display_name`; conversation states `open/closed` unmapped.
  - Why: CA4 thread shows only customer messages and a contradictory takeover state.
  - Files/Modules: `care-turn.ts`, `packages/database/src/repositories/run-admission.ts`, `conversations.ts`, new widget route `GET /storefront/conversations/:id/messages`, `apps/api/src/projections/conversation-summary.ts`, `operator-conversations.ts`, worker failure hook (`apps/worker/src/worker.ts` `recordFailure` path), new sweeper in worker, `packages/ui-foundation/src/status-view.ts`.
  - Dependencies: T1.1, T1.4.
  - Implementation: append the customer message inside the admission transaction; on intent-call failure resolve the reservation as FAILED (re-openable); when a conversational run ends `failed|stopped`, append a system message from the template catalog ("Trợ lý chưa trả lời được. Nhân viên sẽ hỗ trợ bạn."); widget-scoped message read with cursor; operator messages marked `delivery_status='STORED'` until a channel confirms (widget reads them, so web chat delivery = read by widget); takeover sweeper clears `paused_takeover` whose lease expired > 60 s and no handoff ASSIGNED; summary/list project `ownership: AI_ACTIVE|NEEDS_HUMAN|HUMAN_ME|HUMAN_OTHER|PAUSED_ORPHAN|CLOSED`.
  - Verification: stack tests: failed run → system message; takeover → reply → widget reads it; lease lapse → ownership `PAUSED_ORPHAN` then sweeper → `AI_ACTIVE`; unit test for ownership derivation (6 states).
  - Expected Result: threads are complete and ordered; takeover state is always truthful.

- [ ] **T1.11 Heartbeat renewal without version conflicts**
  - Problem: heartbeat renews with the task version it read; concurrent orchestrator writes cause `TASK_VERSION_CONFLICT` and abort the live run (`apps/worker/src/worker-polling.ts:153-186`, `durable-workflows.sql.ts:146-151`).
  - Why: long runs die randomly (workflow §21).
  - Files/Modules: `worker-polling.ts`, `packages/database/src/repositories/durable-workflows.ts` + `.sql.ts`.
  - Dependencies: none.
  - Implementation: renew by `(tenant_id, run_id, lease_owner)` without version predicate; retry once on transient DB error before failing the lease.
  - Verification: concurrency test: heartbeat during checkpoint writes never aborts.
  - Expected Result: leases survive normal progress writes.

- [ ] **T1.12 One identity and conversation binding for Care and Sales**
  - Problem: Care resolves identity from `channel_identifier` and silently drops `conversation_id` on thread mismatch (`apps/worker/src/runtime/care/context-aggregator.ts:134-191`); Sales uses gateway `verified_customer_id` and copies conversation unchecked (`sales/context-aggregator.ts:248-310`).
  - Why: verified customers are anonymous for Care; replies dropped.
  - Files/Modules: new `apps/worker/src/runtime/shared/subject-resolver.ts`, both context aggregators.
  - Dependencies: T1.10.
  - Implementation: single resolver using the signal `subject` stamped by the gateway (`verified_customer_id`, `conversation_id`, `session_id`), verified against DB rows; mismatch → FATAL `SUBJECT_BINDING_MISMATCH` (visible), never silent drop.
  - Verification: stack test: verified persona asks for own order → answer; other customer's order → refused without leak (§5.8).
  - Expected Result: identical, verified subject for every domain.

- [ ] **T1.13 Marketing consent binding verifier**
  - Problem: consent port built without `verifyCustomerBinding` → always `CUSTOMER_BINDING_UNVERIFIED` (`apps/worker/src/worker-bindings.ts:495`, `marketing/data-adapters.ts:136-147`).
  - Why: dispatch revalidation (workflow §8) always denies.
  - Files/Modules: `worker-bindings.ts`, `marketing/data-adapters.ts`.
  - Dependencies: none.
  - Implementation: pass `createMarketingCustomerBindingVerifier(tenant_id)`.
  - Verification: unit + stack: consenting customer allowed, revoked denied.
  - Expected Result: consent recheck works per recipient.

- [ ] **T1.14 Sales gating: marketing consent only for outbound (decision D14)**
  - Problem: advisor plan requires verified customer + `consent_marketing` + no suppression + advisor state + price floor + quote secret (`apps/worker/src/runtime/sales/agent-runtime.ts:1130-1147`; `read-handlers.ts:357-362,569-574`); recommendation requires demo-only revenue evidence (`worker-bindings.ts:372-373`).
  - Why: most advisory chats refuse.
  - Files/Modules: `sales/agent-runtime.ts`, `sales/skills/read-handlers.ts`, `revenue-evidence-adapter.ts`.
  - Dependencies: T1.4.
  - Implementation: read-only advice (search/stock/price/recommend) requires no marketing consent; anonymous sessions get catalog/stock/price answers without personalization; `expected_outcome` becomes optional (`null` + "Chưa có dữ liệu doanh thu" in the evidence drawer); revenue evidence port injected with `{model_id, provenance}` from config (removes `novamart-demo-orders-v1`, workflow §30).
  - Verification: stack: anonymous "laptop under 20 million VND for graphic design" → grounded recommendation with ERP price.
  - Expected Result: Sales answers every reasonable shopping question with grounded data.

- [ ] **T1.15 Persist per-run state in the checkpoint**
  - Problem: verified customer, takeover flag, advisor requirements and lexicon live in process memory (`sales/context-aggregator.ts:219-235,294-299`, `advisor-adapters.ts:37-92`, `care/context-aggregator.ts:89,122-124`); lost on reclaim.
  - Why: worker restart changes behaviour mid-run (workflow §21).
  - Files/Modules: those files, `revenue-orchestrator.ts` resume path.
  - Dependencies: T1.12.
  - Implementation: store these in `state_payload.context` at CONTEXT stage; re-hydrate from checkpoint on resume; delete the maps.
  - Verification: stack chaos test: kill worker after PLAN → run completes after restart with identical answer, no duplicate effect.
  - Expected Result: crash-safe runs.

**Phase 1 exit:** all Phase 0 `todo` stack tests pass; Company console shows AI replies; Try-assistant answers; escalation → takeover → reply works; campaign reaches Approvals (LLM stub or real key); Platform Overview/Usage load.

### Phase 2 — Configuration foundation

Goal: every setting in §9 is persisted, validated, permissioned, audited and used by the runtime.

- [ ] **T2.1 Widen state enums and add data class**
  - Problem: CHECKs allow only shell states (`0006_p5_controlled_autonomy.sql:8,18,24,31,94`); no `data_class`.
  - Why: nothing can be configured; demo shows "Production" (R7).
  - Files/Modules: migration `0024_tenant_states_data_class.sql`, `packages/database/src/repositories/p5-provisioning.ts`, `platform-directory.ts`, provisioning functions, `scripts/demo/seed.mjs`, `apps/api/src/runtime/demo-auth.ts` (`tenant_name`).
  - Dependencies: Phase 1.
  - Implementation: `agentos.data_class` enum (`PRODUCTION|DEMO|TEST`) on `tenants`; `tenants.status IN (PROVISIONED, CONFIGURING, ACTIVE, SUSPENDED, ARCHIVED)`; workspaces `(UNCONFIGURED, CONFIGURING, ACTIVE)`; capabilities `(UNCONFIGURED, ENABLED, DISABLED)`; connectors `(UNBOUND, BOUND, DEGRADED, DISABLED)` + `mode`, `config`, `secret_id`, `bound_at`, probe columns, `version`; owner inputs `(UNRESOLVED, RESOLVED)` + `resolved_*`; add `apply_tenant_rls()` helper; `provision_tenant_shell*` accept `p_data_class` and insert governance + profile rows; demo seed creates the tenant as `DEMO`; session DTO returns `tenant_name` and `data_class`. Explicit grants (no DELETE); `REVOKE ALL … FROM PUBLIC` on new functions.
  - Verification: migration rehearsal; RLS rehearsal; `/company/overview` workspace chip = "Demo"; provisioning test creates a `PRODUCTION` shell.
  - Expected Result: the schema can express configured, active and demo/test states.

- [ ] **T2.2 Encrypted secret store**
  - Problem: no place to store API keys/credentials; `ENCRYPTION_KEY_AES256` validated but unused.
  - Why: LLM and connector configuration require secrets (workflow §4 "secrets never go to the browser").
  - Files/Modules: migration `0025_tenant_secrets.sql`, new `packages/database/src/repositories/secrets.ts`, new `packages/core-engine/src/secrets/{cipher,resolver}.ts`, `apps/api` + `apps/worker` composition.
  - Dependencies: T2.1.
  - Implementation: table `tenant_secrets(tenant_id, secret_id, purpose, key_version, nonce, ciphertext, fingerprint, created_by, created_at, revoked_at)` (+ `platform_secrets` for platform-level provider keys, owned by platform role); AES-256-GCM in app, AAD = `tenant|secret_id|purpose`; `key_version` + `ENCRYPTION_KEY_AES256_PREVIOUS` for rotation; API is write-only (returns `fingerprint` + last 4 only); `SecretResolver(tenant_id, secret_id)` used by adapters (existing `SecretResolver` interfaces in `packages/adapters`); never logged (add to pino redact paths).
  - Verification: unit (encrypt/decrypt, wrong AAD fails, rotation); API test: GET never returns plaintext; log scan test.
  - Expected Result: secrets stored safely, usable by runtime only.

- [ ] **T2.3 Company profile**
  - Problem: no profile (name, industry, locale, timezone, currency, brand).
  - Why: workflow §4; UI uses UUID and wrong currencies.
  - Files/Modules: migration `0026_tenant_profiles.sql`, repository, `GET/PUT /api/v1/company/settings/profile`, OpenAPI, Settings UI (T6.11).
  - Dependencies: T2.1, T2.9, T2.10.
  - Implementation: `tenant_profiles` (see §9 catalog) with validation (IANA timezone, ISO-4217, locale regex); optimistic concurrency via `version` (`If-Match`); audit event on change; profile feeds UI formatting (`Intl` with tenant currency/timezone) and agent prompts (brand profile).
  - Verification: API tests (validation, 409 on stale version, audit row); UI shows company name instead of UUID.
  - Expected Result: company identity is editable and used everywhere.

- [ ] **T2.4 Editable governance settings**
  - Problem: `tenant_governance_settings` read-only and not provisioned (`0015`, `company-settings.ts:17`); distinct-approver rule unreachable.
  - Why: approval policy must be configurable (workflow §15).
  - Files/Modules: migration (grant UPDATE on specific columns), `apps/api/src/routes/v1/company-settings.ts` (`PUT`), repository.
  - Dependencies: T2.1, T2.9, T2.10.
  - Implementation: settings `require_distinct_approver`, `approval_expiry_hours` (1–720), `takeover_lease_seconds` (30–600); PUT with `If-Match`; audit.
  - Verification: API tests; stack: enable distinct approver → self-approval refused `APPROVER_MUST_DIFFER`.
  - Expected Result: approval policy is a real setting.

- [ ] **T2.5 LLM provider configuration (platform default + company override)**
  - Problem: LLM read from env separately by API and worker; no test; no per-company config (workflow §4, §18).
  - Why: "How to change?" (PA4); keys cannot be rotated without redeploy.
  - Files/Modules: migration `0027_llm_provider_configs.sql` (`platform_llm_providers`, `tenant_llm_configs`, `llm_probe_results`), repositories, `apps/api/src/routes/v1/platform-providers.ts` (new), `apps/api/src/routes/v1/company-llm.ts` (new), `packages/adapters/src/llm/openai-compatible.ts`, new `packages/core-engine/src/llm/resolver.ts`, `apps/api/src/runtime/bindings/turn-intent.ts`, `apps/worker/src/worker-bindings.ts`.
  - Dependencies: T2.2, T2.9, T2.10, T5.3 (retry can land before or after).
  - Implementation: platform provider rows (name, base_url https + host allowlist + private-range block, reasoning/fast models, timeout 1–120 s, structured mode, secret, status `CONFIGURED|VERIFIED|FAILED`); tenant override (`inherit` or own provider/models/secret/timeout/monthly token budget); `POST …/test` runs a bounded server-side probe (models list or 1-token completion, 10 s, rate-limited) storing `{outcome, latency_ms, http_status, error_class}` only; `LlmConfigResolver(tenant)` with cache keyed by `tenant+config_version` (TTL ≤ 30 s) used by both API turn-intent and worker content engine; env values imported once as platform default `source='ENV'`.
  - Verification: API tests (validation, SSRF refusal, secret write-only, audit); stack: change model → next turn uses it (provider ledger shows model); probe failure shows "Lỗi" with reason.
  - Expected Result: LLM configuration is editable, testable and consistent across API and worker.

- [ ] **T2.6 Connector configuration and "Kiểm tra kết nối" (decision D4)**
  - Problem: ERP binding is a process-wide env mock (`apps/worker/src/runtime/connectors.ts:114-198`); DB rows always UNBOUND; categories wrong (`apps/api/src/projections/integrations.ts:21-28`); probes hard-coded `NOT_RUN` (`composition.ts:548-562`); two truths.
  - Why: CA8; workflow §17.
  - Files/Modules: migration `0028_connector_bindings.sql` (extends `connector_configurations`, adds `connector_probe_results`), new `packages/adapters/src/catalog.ts` (connector catalog: id, display key, category, config schema, auth schemes, supported probes), `apps/api/src/routes/v1/company-integrations.ts` (new), `apps/worker/src/runtime/connector-registry.ts` (per-tenant), `erp-http-transport.ts` (auth schemes: HMAC mock, bearer, basic), `apps/api/src/projections/integrations.ts`.
  - Dependencies: T2.1, T2.2, T2.9, T2.10.
  - Implementation: catalog with correct categories (API-001 ERP/POS, API-002 web events, API-003 messaging channels, SHOPIFY commerce, ADPT-GL-001..003 "Chưa tích hợp" seams); `PUT /company/integrations/:id` (config validated by catalog schema + write-only secret); `POST /company/integrations/:id/test` runs bounded reads (catalog, inventory, customers, orders) through the real connector and stores probe results; `BOUND` only after a successful test; worker resolves `(tenant, connector_id)` bindings per task (cache + version); env mock imported as `mode='DEMO_MOCK', source='ENV'` for DEMO tenants only.
  - Verification: stack: connect mock ERP via API → test PASS → Sales uses tenant binding; disconnect → Sales answers "Dữ liệu giá hiện không khả dụng" (fail closed, workflow §22).
  - Expected Result: one source of truth for integrations; Connect/Test works.

- [ ] **T2.7 Activate the AI Team with prerequisite checks**
  - Problem: agents inactive + capabilities UNCONFIGURED for new tenants; only demo seed activates (`scripts/demo/seed.mjs:187-193`); AI Team shows DISABLED (`apps/api/src/projections/ai-team.ts:57-88`).
  - Why: workflow §4 "Activate", §27 "Activate AI Team".
  - Files/Modules: migration (agents `activation_status`, `agent_activation_events`), `apps/api/src/routes/v1/company-ai-team.ts` (new: `GET /company/ai-team/:domain`, `POST /company/ai-team/:domain/activate|pause|resume`), `ai-team.ts` projection.
  - Dependencies: T2.5, T2.6, T3.1 (knowledge prerequisite for Care/Marketing).
  - Implementation: activation requires domain prerequisites (Sales: ERP bound or DEMO_MOCK; Care: approved FAQ knowledge; Marketing: LLM verified + brand docs approved); response lists unmet prerequisites with reason keys and CTA links; capability `ENABLED` + agents `ACTIVE` in one transaction; authority unchanged (PEP/autonomy still gate); audit.
  - Verification: API tests; stack: new company → activate Sales without ERP → 409 with `ERP_NOT_CONNECTED`; after connect → activated; AI Team status "Hoạt động".
  - Expected Result: companies can switch domains on safely.

- [ ] **T2.8 Worker tenant and module discovery from the database**
  - Problem: `WORKER_TENANT_IDS` / `ENABLED_AGENT_MODULES` env (`apps/worker/src/index.ts:74`, `worker.ts:80-93,511-524`).
  - Why: provisioned companies never run.
  - Files/Modules: `worker.ts`, `worker-polling.ts`, `approval-expiry-sweeper.ts`, new SECURITY DEFINER `platform_active_tenants()` (platform role, returns ids + enabled domains only).
  - Dependencies: T2.1, T2.7.
  - Implementation: refresh tenant/domain list every 30 s from DB; env lists become optional filters (local debugging); domain bindings built per tenant from capability state.
  - Verification: stack: provision + activate a second company → its turns complete without restarting the worker.
  - Expected Result: multi-company operation without redeploys.

- [ ] **T2.9 Permission catalog additions**
  - Problem: no permissions for settings, integrations, knowledge, skills, agents, test data (`packages/ui-foundation/src/auth.ts:1-11`; `apps/api/src/gateway/contracts.ts`).
  - Why: new features must be gated; Company Admin stays role-free in UI.
  - Files/Modules: `apps/api/src/gateway/contracts.ts`, `apps/api/src/runtime/demo-auth.ts` (bundles), `packages/ui-foundation/src/auth.ts`, `docs/operations/auth.md`.
  - Dependencies: none (land early in Phase 2).
  - Implementation: add `settings:manage`, `integration:manage`, `llm:manage`, `knowledge:manage`, `knowledge:approve`, `skills:manage`, `agents:manage`, `testdata:manage`, `run:retry:company` (company-scope retry of own failed runs); company_admin bundle gets all except platform ones; platform bundle adds `platform:providers:write`, `platform:companies:write`, `platform:audit:read`.
  - Verification: `demo-auth.test.ts` asserts exact bundles; platform-only routes refuse company sessions.
  - Expected Result: every new endpoint has an explicit permission.

- [ ] **T2.10 Configuration audit and history**
  - Problem: config changes would be unaudited; audit rows unreadable; platform actions attributed to `HUMAN_HANDOFF` (`composition.ts:461-490`).
  - Why: workflow §15 audit, operator accountability.
  - Files/Modules: migration `0029_platform_audit_events.sql` (hash-chained, append-only, `platform_append_audit()` SECURITY DEFINER, `tenant_audit_events` view), repository, `GET /company/audit`, `GET /platform/audit`.
  - Dependencies: T2.1.
  - Implementation: every config write calls `platform_append_audit(actor, scope, action, target_tenant, target, outcome, reason, before, after (redacted), correlation_id)` in the same transaction; secrets redacted by caller + CHECK against key patterns.
  - Verification: tests for chain integrity, redaction, RLS (tenant sees only its events).
  - Expected Result: every setting change has a readable, tamper-evident history.

**Phase 2 exit:** a freshly provisioned company can be configured (profile, LLM, ERP, governance), activated and run a Sales turn end to end with no env edits; all changes audited.

### Phase 3 — Knowledge management

Goal: workflow §4 knowledge lifecycle `Draft → Review → Approved → Available to Agents`, used by Care FAQ and Marketing brand guard.

- [ ] **T3.1 Knowledge tables and lifecycle**
  - Problem: knowledge is files on disk (`packages/second-brain/src/loader.ts:44-60`, `apps/worker/src/runtime/marketing/knowledge-adapter.ts`, `care/skills/faq-handler.ts`); only `status: approved` frontmatter; packaged corpus is all draft except the demo pack.
  - Why: CA7 "How to add?"; agents cannot use company knowledge.
  - Files/Modules: migration `knowledge_documents`, `knowledge_document_versions` (immutable), `knowledge_document_events` (immutable); repository `packages/database/src/repositories/knowledge.ts`.
  - Dependencies: T2.1, T2.9, T2.10.
  - Implementation: namespaces `company|product|brand|marketing|sales|customer-care|policy`; types FAQ, shipping, returns, warranty, brand voice, sales guideline, marketing guideline, authority policy; status `DRAFT|REVIEW|APPROVED|AVAILABLE|ARCHIVED`; transition trigger (DRAFT→REVIEW; REVIEW→DRAFT|APPROVED; APPROVED→AVAILABLE by indexer only; any→ARCHIVED; new version resets to DRAFT); four-eyes when `require_distinct_approver`; `content_sha256` per version; `data_class`.
  - Verification: migration + RLS rehearsal; transition trigger tests.
  - Expected Result: durable, auditable knowledge lifecycle.

- [ ] **T3.2 Knowledge API**
  - Problem: no knowledge routes (`apps/api`).
  - Why: UI and agents need CRUD + lifecycle.
  - Files/Modules: `apps/api/src/routes/v1/knowledge.ts` (new), OpenAPI, tenant BFF allowlist.
  - Dependencies: T3.1.
  - Implementation: `GET /knowledge/documents` (filters: namespace, status, q), `POST` (create draft), `GET/PUT /:id` (new version), `POST /:id/submit`, `/:id/approve` (`knowledge:approve`), `/:id/reject`, `/:id/archive`, `GET /:id/versions`, `GET /:id/usage` (which agents/skills read it); markdown body ≤ 64 KB; upload `.md/.txt` (PDF later); all audited.
  - Verification: API tests incl. permission matrix and four-eyes.
  - Expected Result: knowledge manageable via API.

- [ ] **T3.3 DB-backed knowledge store for agents + demo import**
  - Problem: FAQ and brand guard read files; `KNOWLEDGE_ROOT` env.
  - Why: approved company knowledge must reach agents.
  - Files/Modules: new `apps/worker/src/runtime/shared/knowledge-store.ts`, `care/skills/faq-handler.ts`, `marketing/knowledge-adapter.ts`, `brand-guard.ts`, `scripts/demo/seed.mjs` (import `packages/second-brain/demo/novamart/**` as AVAILABLE, class DEMO), indexer job (sets AVAILABLE; Qdrant upsert optional behind flag).
  - Dependencies: T3.1.
  - Implementation: `KnowledgeStore.listAvailable(tenant, namespace)` returns `{document_id, version, content_sha256, body}`; citation shape keeps `source_file` (= `namespace/slug`) and `source_version` (= sha256) so the finalizer stays unchanged; FAQ parser unchanged; remove FAQ internals leaking to customers (FAQ-1/FAQ-4 mention `skill.care.escalate_to_human`).
  - Verification: stack: approve a new FAQ entry → Care answers it citing the new version; archive it → Care stops using it.
  - Expected Result: "Available to Agents" is real.

- [ ] **T3.4 Knowledge page**
  - Problem: static empty state with English text (`apps/tenant-console/src/app/(app)/knowledge/page.tsx:9-19`; missing vi key `knowledge.description`).
  - Why: CA7.
  - Files/Modules: `knowledge/page.tsx`, new `components/knowledge/*` (list, editor, review drawer), i18n.
  - Dependencies: T3.2, T6.1.
  - Implementation: see §7.9.
  - Verification: Playwright stack: create → submit → approve → "Đang được AI dùng"; Care answers.
  - Expected Result: Company Admin adds and approves knowledge without engineers.

### Phase 4 — Skills management and integration

Goal: skills are real capabilities that can be listed, configured, enabled, assigned, tested, monitored and used (see §10).

- [ ] **T4.1 Single source of truth for skill attributes; fix drift; `create_order` AUTH-4**
  - Problem: attributes copied into PEP registries (`SALES_SKILLS`, `CARE_SKILLS`, `MARKETING_*`), payload allowlists and `deriveEffectPolicy` with drift (e.g. `search_product` agents `[SAL-01,SAL-02]` vs `[SAL-02,SAL-03]`; Care `initiate_return` allowlist missing fields); `create_order` EFFECT/AUTH-3 (`packages/skills/src/platform/sales/create-order.ts:81-86`) and never planned; `send_message` schema lacks `additionalProperties:false`; core hard-codes `skill.care.escalate_to_human` and agent-prefix→domain.
  - Why: governance correctness; prerequisite for data-driven skills.
  - Files/Modules: `packages/skills/src/contracts/types.ts` (add `display_key`, `domain`, `config_schema`, `autonomy_class: NEVER|PROMOTABLE`, `receipt_ref`, `completion: SYNC|AWAITS_HUMAN`, `connector_kinds`), all 23 rows, new `packages/skills/src/derive.ts` (`toPolicyRegistrySkill`, `payloadFieldsOf`, `effectPolicyOf`), `apps/worker/src/runtime/{sales,care,marketing}/policy-*.ts`, `packages/core-engine/src/orchestrator/revenue-orchestrator.ts:1232,1938-1944`, `packages/core-engine/src/autonomy/never-promotable.ts`.
  - Dependencies: Phase 1.
  - Implementation: derive PEP registries/allowlists from rows; delete hand tables; `create_order` → `effect_class:'APPROVAL'`, `required_authority:'AUTH-4'`, planned by SAL-02 on explicit purchase intent; never-promotable set derived from `autonomy_class`.
  - Verification: contract test "PEP registry == rows" for all 23; registration test; stack: purchase intent → approval pause.
  - Expected Result: one definition per skill; governance cannot drift.

- [ ] **T4.2 Skill catalog and tenant skill settings**
  - Problem: DB `skills` table never used; no per-tenant settings.
  - Why: manageability (§10).
  - Files/Modules: migration (`skill_catalog` platform-scoped, synced at boot with `contract_digest`; `tenant_skill_settings`; `tenant_skill_agents`; deprecate `skills`), repository, worker/API boot sync.
  - Dependencies: T4.1, T2.1.
  - Implementation: boot sync upserts catalog rows from the code manifest; boot refuses if a contract digest changed without a version bump; tenant settings `(enabled, config jsonb validated by config_schema, connector_id, version, updated_by)`; assignment trigger enforces `agent_code ∈ catalog.allowed_agents`; provisioning seeds default settings (READ skills enabled, EFFECT/APPROVAL disabled).
  - Verification: migration/RLS tests; digest-pin test.
  - Expected Result: per-tenant skill state stored safely.

- [ ] **T4.3 SkillGate and availability resolver in the runtime**
  - Problem: enablement is static per process; three engines with separate breakers; planners use static `enabled`.
  - Why: configuration must change behaviour.
  - Files/Modules: `packages/skills/src/runtime/engine.ts` (inject `SkillGate`), new `packages/skills/src/runtime/availability.ts`, worker skill indexes (one shared engine per worker), planners (`sales/plan-composer.ts`, care/marketing runtimes).
  - Dependencies: T4.2, T2.6, T2.7.
  - Implementation: `availability(tenant, skill) → {available, reason}` with reasons `OK, DISABLED_BY_TENANT, NOT_ENTITLED, CONNECTOR_UNBOUND, CONNECTOR_UNHEALTHY, AGENT_INACTIVE, NO_ASSIGNED_AGENT, PARKED_UNTIL_PROMOTED, AUTONOMY_PAUSED, BREAKER_OPEN, OWNER_INPUT_UNRESOLVED`; engine step "enabled" = `row.enabled AND gate.available`; gate failure fails closed; cache TTL ≤ 5 s keyed by config version; planners skip unavailable skills and produce a typed refusal (T1.4) naming the reason; breaker keyed `tenant+dependency`, HALF_OPEN single probe released in `finally`.
  - Verification: unit matrix of reasons; stack: disable `check_price` → Sales answers without price and says why.
  - Expected Result: skill availability is live, explainable, fail-closed.

- [ ] **T4.4 Skills API: list, configure, assign, test, health**
  - Problem: no API.
  - Why: §10 workflow.
  - Files/Modules: `apps/api/src/routes/v1/skills.ts` (new), `apps/api/src/routes/v1/platform-skills.ts` (new), OpenAPI, BFF allowlists.
  - Dependencies: T4.3.
  - Implementation: `GET /skills` (effective status + reason + business label), `GET /skills/:id`, `PATCH /skills/:id/settings` (`skills:manage`; cannot touch authority/effect class), `PUT /skills/:id/agents`, `POST /skills/:id/test` (READ: real dispatch with a test envelope on TEST/DEMO data; EFFECT/APPROVAL: connector ping + schema dry-run only; results stored in `skill_test_results`), `GET /skills/:id/health` (last 24 h success/failure/latency from stage results + breaker state); platform: `GET /platform/skill-catalog`, per-company entitlement toggle.
  - Verification: API tests: authority immutable; assignment subset; test of READ skill returns output summary; EFFECT test never executes an effect.
  - Expected Result: skills are manageable and testable.

- [ ] **T4.5 Autonomy semantics and promotion workflow (decision D2)**
  - Problem: `admit()` parks every MINIMUM skill (`packages/core-engine/src/autonomy/service.ts:384-392`); `promote()` has no caller; demo seed bypasses (`scripts/demo/seed.mjs:227-244`); only drift demotion live; `commitPolicy` last-write-wins.
  - Why: new companies stall invisibly (workflow §16).
  - Files/Modules: `autonomy/service.ts`, `eligibility.ts`, `packages/database/src/repositories/p5-autonomy.ts`, `apps/api/src/routes/v1/autonomy-admin.ts` (company + platform variants), seed.
  - Dependencies: T4.2.
  - Implementation: MINIMUM = READ skills execute at baseline authority; `PARKED_DRAFT` only for DEMOTED/PAUSED/kill switch/drift and for explicitly draft-gated skills (`generate_content`, `segment_audience`) until promoted; parked runs create a visible attention item ("Bản nháp chờ bạn duyệt"); promotion request computes evidence window (violations, duplicate effects, cost, latency from stage results/audit) and requires human approval (distinct approver when setting on); versioned CAS on policy writes + policy event in same transaction; demotion triggers: violation, duplicate effect, provider ambiguity, drift, evidence gap; seed stops re-promoting on re-run.
  - Verification: unit + stack: new company Sales read works without promotion; draft-gated skill parks with attention item; promotion approval flips it.
  - Expected Result: autonomy matches workflow §16 and is visible.

- [ ] **T4.6 Skills UI (Company and Platform)**
  - Problem: none.
  - Why: §10.
  - Files/Modules: tenant `ai-team/[domain]` "Kỹ năng" tab, platform `skills` catalog page.
  - Dependencies: T4.4, T6.1.
  - Implementation: see §10.4.
  - Verification: Playwright stack: disable/enable, assign, test, see health.
  - Expected Result: Company Admin understands and controls what each AI domain can do.

### Phase 5 — Trace, observability and LLM hygiene

- [ ] **T5.1 Stage results, stage detail and error catalog**
  - Problem: `run_stage_events` stores entry time only; `detail/evidence_refs` never passed (`revenue-orchestrator.ts:156-180`); no duration/status/error per stage.
  - Why: trace UX (§11), Operations reasons (PA2).
  - Files/Modules: migration `run_stage_results` (append-only) + generated `platform_durable_tasks.domain`; `packages/core-engine` recorder (`IRunStageRecorder.complete`); `apps/worker/src/runtime/shared/stage-recorder.ts`; error catalog from T1.5.
  - Dependencies: T1.5.
  - Implementation: record per stage `{status, started_at, completed_at, duration_ms, agent_code, skill_id, summary_key, refusal_code, error_class, input_digest, output_digest, evidence_refs}`; `detail` per stage as in §11.3; safe summaries built from per-skill allowlists + `audit_spec.mask_pii_fields`.
  - Verification: stack: every completed run has results for each entered stage; durations sum ≈ run duration.
  - Expected Result: trace data rich enough for both views.

- [ ] **T5.2 PII-safe audit**
  - Problem: `logRun` writes full hydrated context (phone, email, spend) into append-only `audit_records`/`agent_run_logs` (`revenue-orchestrator.ts:2374-2396`); `audit_spec` unused.
  - Why: privacy (workflow §20 "never log secrets"; §26).
  - Files/Modules: `revenue-orchestrator.ts`, new `packages/core-engine/src/audit/redact.ts`.
  - Dependencies: none.
  - Implementation: `redactForAudit(record, row.audit_spec)` (mask listed fields, hash identifiers, drop context PII); revoke UPDATE/DELETE on legacy immutable tables from `agentos_app` (DB audit S4).
  - Verification: stack: audit rows contain no `verified_email/phone`; unit tests per skill.
  - Expected Result: audit keeps accountability without PII.

- [ ] **T5.3 LLM bounded retry, cancellation and unified usage ledger**
  - Problem: adapter makes one attempt (`packages/adapters/src/llm/openai-compatible.ts:279-363`); worker LLM unmetered, no signal, errors collapsed (`apps/worker/src/worker-bindings.ts:166-244`); two usage tables (`token_cost_records` API only; `provider_call_ledger` Care success only).
  - Why: workflow §18; Usage page; cost control.
  - Files/Modules: adapter, new `packages/core-engine/src/llm/recorder.ts` (one recorder writing both tables incl. failures), `ExecutionContext` (add `llm` + `signal`), worker bindings, turn-intent.
  - Dependencies: T2.5 (resolver), can start before.
  - Implementation: retry on 429/5xx/timeout only, ≤ 2 retries, jittered backoff, honour `Retry-After`, total budget ≤ min(skill timeout − 1 s, 20 s); never retry invalid JSON (fail closed); sanitized `provider_error {status,type,code}`; atomic budget reserve before call; skill timeout ≥ adapter timeout × attempts.
  - Verification: adapter tests with fake fetch (429→200 attempts=2; invalid JSON no retry); stack with LLM stub fault modes; Usage page shows tokens/cost for Care and Marketing.
  - Expected Result: resilient, measured LLM usage.

- [ ] **T5.4 Run projection v2 and run story**
  - Problem: `RunProjection` lacks agent, domain, timestamps, failure reason, latency, cost (`apps/api/src/gateway/contracts.ts:573-582`, `bindings/run-port.ts:255-270`); N+1 log reads; `costOf` throws unmapped; activity = raw stage rows (`apps/api/src/projections/activity.ts:58-77`, unbounded SQL `company-projections.ts:226-283`).
  - Why: PA2, CA2.
  - Files/Modules: `run-port.ts`, `operations.ts`, `projections/activity.ts`, `company-projections.ts`, new `projections/run-story.ts`, OpenAPI.
  - Dependencies: T5.1.
  - Implementation: run list item `{run_id, domain, agents[], title_key+params (e.g. "Tư vấn sản phẩm cho {customer}"), state (business enum + raw), created_at, updated_at, duration_ms, cost{amount,currency}|null, tokens, attempts, failure{code, reason_key, class}|null, retry_eligibility{retryable, reason_code}, needs_reconciliation}`; batch reads; `GET /runs/:id/story` (Company: steps with display names, statuses, durations, safe summaries, final outcome); `GET /runs/:id/trace` (Admin: + stage events, provider calls, effect keys, approval, audit refs); activity = one row per run outcome, SQL LIMIT + cursor.
  - Verification: contract tests; Operations shows agent, cause, duration; Overview activity shows sentences.
  - Expected Result: runs are understandable at a glance.

- [ ] **T5.5 Automatic reconciliation sweeper**
  - Problem: no producer of `reconcile.completed`/`timer.expired`; UNKNOWN effects wait forever (`apps/worker/src/worker.ts:386-393`; `durable-workflows.sql.ts:113-117`).
  - Why: workflow §19, §21.
  - Files/Modules: new `apps/worker/src/reconcile-sweeper.ts`, adapters `reconcile()` (API-001 exists), `durable-workflows.ts`.
  - Dependencies: T1.5.
  - Implementation: every 60 s, for `waiting` runs with RESERVED effects older than N minutes call `provider.reconcile(effect_key)`: SUCCEEDED → settle + `reconcile.completed`; FAILED → settle FAILED + reopen for operator retry; INDETERMINATE → after max age create attention item "Cần đối soát" (no blind retry).
  - Verification: stack chaos: mock ERP swallow-after-write → sweeper settles SUCCEEDED, exactly one effect.
  - Expected Result: UNKNOWN effects resolve safely or surface to humans.

### Phase 6 — Company UI rebuild on real data

Goal: §7 specification implemented; every page uses projections, one vocabulary, one error model.

- [ ] **T6.1 Shared foundation: vocabulary, errors, components, data hooks**
  - Problem: flat case-sensitive status map (`packages/ui-foundation/src/status-view.ts:26-53`) → "Chưa phân loại"; raw English API messages; duplicated shells/dialogs/tables; `AttentionCard` prints severity as label and renders the badge twice; `StatusBadge` gives every badge `role=status`; raw `fetch` in 5 pages bypasses 401 redirect; root font 13 px; contrast failures.
  - Why: R8; consistency.
  - Files/Modules: `packages/ui-foundation/src/{status-view.ts, i18n/*, react/*}`, new `react/{Stepper,Switch,Textarea,Checkbox,Toast,ConfirmDialog,KeyValueList,ChatThread,IdChip,DataClassBadge,StageTimeline,ErrorBanner,Skeleton}.tsx`, new `data/useApi.ts` (SWR-like with ETag, retry, 401 redirect), `tokens.css`.
  - Dependencies: Phase 1 (API enums documented), T5.4 enums.
  - Implementation: `statusView(domain, code)` with per-domain tables (agent, connector, probe, run, campaign, approval, conversation, handoff, knowledge, skill, tenant, owner_input, data_class) covering every OpenAPI enum; unknown → neutral "Không xác định" + raw code in Advanced only; `describeApiError(err)` from `error_code` catalog with retry CTA and correlation id; en/vi parity test + banned-word test ("tenant", "telemetry", "fleet", UPPER_SNAKE, UUID in visible text); root font 16 px; fix contrast (warning/success ≥ 4.5:1); delete legacy `status.ts`, dead types, local mappers.
  - Verification: contract test enumerating `packages/api-contract/openapi.json` enums → no unknown label; axe on all routes.
  - Expected Result: one visual and verbal language across both consoles.

- [ ] **T6.2 Company shell and navigation**
  - Problem: two "Cài đặt" items; UUID + literal "Production" + unconditional Demo badge (`apps/tenant-console/src/components/shell/CompanyShell.tsx:34,134-137,164-174,219`); fake search; duplicated titles; mobile drawer without focus trap; English aria.
  - Why: CA1–CA11 chrome.
  - Files/Modules: `CompanyShell.tsx` → migrate to shared `AppShell`; `nav.test.tsx`; `tests/ui/tenant.spec.ts`.
  - Dependencies: T6.1, T2.1 (tenant name, data class).
  - Implementation: §7.1.
  - Verification: component tests; axe; Playwright mobile.
  - Expected Result: clean, trustworthy shell.

- [ ] **T6.3 Overview**
  - Problem: CA1 — "Chỉ số đã quan sát" shows one unlabeled "Lượt chạy 12"; one attention card per connector code with raw "warning" twice; attention empty state is a NO_DATA badge; four client fetches whose partial failure shows an empty list (`apps/tenant-console/src/components/company/CompanyOverview.tsx:38-41,84-118`; `apps/api/src/projections/attention.ts:108-132`).
  - Why: the dashboard must read like a business product (workflow §6).
  - Files/Modules: `CompanyOverview.tsx`, `apps/api/src/routes/v1/company.ts` (`/company/overview`), `apps/api/src/projections/{attention,overview}.ts`, `packages/database/src/repositories/company-projections.ts`.
  - Dependencies: T5.4 (per-run activity), T2.7 (AI Team status), T6.1.
  - Implementation: attention grouped by type with counts and one CTA each (max 5); positive empty state "Mọi thứ đang ổn"; AI Team strip; "Hôm nay" metrics (conversations, AI-resolved, handed to staff, approvals pending, campaigns by state) with "cập nhật lúc"; activity one line per run; onboarding checklist while workspace not ACTIVE; one server call `/company/overview`, per-section error with retry. Spec §7.2.
  - Verification: projection unit tests (grouping, no metric without rows); Playwright stack: after one Sales turn the Overview shows "1 hội thoại hôm nay" and a readable activity line; copy lint (no UUID/UPPER_SNAKE).
  - Expected Result: Overview answers "what needs me, what is my AI doing" in one screen.

- [ ] **T6.4 AI Team (list and domain pages)**
  - Problem: CA2 — three cards "Chưa phân loại" with no counts (domain never written: `company-projections.ts:213-228`); heading repeated four times; per-domain pages filter client-side on a missing domain.
  - Why: workflow §7 (status, current activity, needs attention, recent work, configuration, advanced).
  - Files/Modules: `apps/tenant-console/src/components/company/AiTeamConsole.tsx`, `src/app/(app)/ai-team/[domain]/*`, new `GET /company/ai-team/:domain`, `apps/api/src/projections/ai-team.ts`.
  - Dependencies: T2.7, T4.4, T5.4, T6.1.
  - Implementation: list = three cards (status + reason, "đang làm gì", counters, primary CTA); domain page tabs Tổng quan / Kỹ năng / Nguồn dữ liệu & kênh / Thử nghiệm / Chi tiết kỹ thuật; status reasons explicit ("Chưa cấu hình: thiếu kết nối ERP" → link). Spec §7.3.
  - Verification: contract test (every status has a label); Playwright: deactivate Sales → card "Tạm dừng" with reason; activate → "Hoạt động".
  - Expected Result: each AI domain is understandable and controllable.

- [ ] **T6.5 Conversations workspace**
  - Problem: CA4 — "Tiếp quản" beside "Nhân viên"+"Tạm dừng"; reason input always visible; no AI bubbles distinction; list remounts on select (`apps/tenant-console/src/components/conversation/ConversationWorkspace.tsx:41-59,134-200,269-276`); no polling.
  - Why: workflow §11–§12.
  - Files/Modules: `ConversationWorkspace.tsx` (single page with `?c=`), `conversations` list/summary projections (T1.10 ownership), `useApi` polling.
  - Dependencies: T1.10, T6.1.
  - Implementation: three panes; list tabs Cần nhân viên / AI / Nhân viên / Tất cả with name, channel label, snippet, time, ownership chip; thread with distinct Khách/AI/Nhân viên/Hệ thống bubbles and run-failure system rows; ownership banner per state; takeover confirm popover with reason chips; heartbeat with retry and countdown; composer only for `HUMAN_ME`; reply states Đang gửi/Đã lưu/Đã gửi/Gửi thất bại; poll 5 s visible. Spec §7.5.
  - Verification: unit matrix for 6 ownership states; Playwright stack: escalate → appears in "Cần nhân viên" → take over → reply → widget receives → return to AI.
  - Expected Result: human takeover is obvious and safe.

- [ ] **T6.6 Customers and Customer360**
  - Problem: CA3 — cards titled "Khách hàng" (UI reads `name`, API sends `display_name`: `CustomerList.tsx:15`), no search though API supports `query`; Customer360 misses consent/orders/campaigns (`Customer360Profile.tsx:67-104`); timeline only `customer_events`; storefront events stored with `customer_id:null` (`storefront.ts:538`).
  - Why: workflow §13.
  - Files/Modules: `CustomerList.tsx`, `Customer360Profile.tsx`, `Customer360Timeline.tsx`, `apps/api/src/routes/v1/customers.ts`, `projections/customers.ts`, timeline projection, `storefront.ts` event binding.
  - Dependencies: T6.1, T7.1 (data class chip), T1.12.
  - Implementation: DataTable with search, filters (segment, tier, consent, data class), sort by last activity; profile header + summary cards (identity, segment, consent per channel, orders) + tabs (timeline, orders, conversations, campaigns, recommendations labeled "Dự đoán", support); timeline merges events, conversations, orders, campaign engagement, cases; bind verified `customer_id` on storefront events. Spec §7.4.
  - Verification: fixture tests with API-shaped rows; Playwright: open TEST customer → see seeded order and consent.
  - Expected Result: a readable 360° customer view.

- [ ] **T6.7 Campaigns**
  - Problem: CA5 — cards "winback/winback", "?" status icon, static "Gửi đi: Chưa tích hợp", free-text segment, no link to approval.
  - Why: workflow §8.
  - Files/Modules: `src/app/(app)/campaigns/{page,new/page,[runId]/page}.tsx`, new `components/campaigns/*`, `GET /campaigns/segments` (T1.9).
  - Dependencies: T1.9, T6.1.
  - Implementation: list grouped by lifecycle; wizard (Mục tiêu → Đối tượng with counts and consent note → Kênh/giọng điệu/hướng dẫn → Xem lại); detail with step timeline (Soạn nội dung → Kiểm tra thương hiệu → Kiểm tra đồng ý → Chờ duyệt → Đã duyệt → Gửi đi), content preview, audience size, approval link, failure reason. Spec §7.6.
  - Verification: Playwright stack (LLM stub): create → awaiting approval → approve → "Đã duyệt · Chưa tích hợp kênh gửi".
  - Expected Result: campaigns are understandable from brief to approval.

- [ ] **T6.8 Approvals**
  - Problem: CA6 — legacy English SCR-003 component with nested `<main>`, "Operator: demo-company-admin", "Reviewed Payload SHA-256 Digest", JSON MODIFY editor, PENDING only, "Review: AGENT-UNKNOWN Action" (`apps/tenant-console/src/components/approvals/*`; `apps/api/src/routes/v1/approvals.ts:81-88`).
  - Why: workflow §15 — humans must understand what they approve.
  - Files/Modules: replace `components/approvals/*`; `approvals.ts` + repository add `status=DECIDED` filter and a `summary` block (`title_key`+params, requesting agent display key, domain, customer/campaign context, before/after for MODIFY, evidence list, risk, expiry).
  - Dependencies: T1.6, T2.4, T6.1.
  - Implementation: tabs Chờ duyệt / Đã xử lý; card sentence ("Gửi chiến dịch 'X' cho 320 khách qua Email", by "Marketing AI", expiry); drawer with what will happen, preview, checks, evidence; actions Duyệt / Từ chối (reason) / Yêu cầu sửa (structured fields); post-approval states; digest and payload JSON under Chi tiết kỹ thuật. Spec §7.7.
  - Verification: Playwright approve/reject/modify; stale approval → "Đề xuất đã thay đổi, cần xem lại"; axe.
  - Expected Result: approvals are clear and safe.

- [ ] **T6.9 Integrations**
  - Problem: CA8 — raw codes, wrong categories, read-only, "server-managed" copy.
  - Why: workflow §17.
  - Files/Modules: `apps/tenant-console/src/components/company/IntegrationsPage.tsx`, new `components/integrations/{ConnectModal,TestResultPanel}.tsx`.
  - Dependencies: T2.5, T2.6, T6.1.
  - Implementation: business groups; card with purpose, status, last check, [Kết nối]/[Kiểm tra]/[Xem chi tiết]; connect modal with catalog-driven fields and write-only secret; test result list per check; codes under Chi tiết kỹ thuật. Spec §7.8.
  - Verification: Playwright stack: connect mock ERP → test → "Hoạt động"; wrong secret → "Lỗi xác thực".
  - Expected Result: Company Admin can connect and verify integrations.

- [ ] **T6.10 Analytics**
  - Problem: CA9 — `kpi.snapshot` stub returns `metrics: []` (`apps/api/src/runtime/composition.ts:431-458`); UI whitelists unrelated keys (`AnalyticsPage.tsx:9-13,41-44`).
  - Why: "Useful Metrics" (workflow §6) must be real.
  - Files/Modules: new `GET /company/analytics?window=24h|7d|30d` (`apps/api/src/routes/v1/company-analytics.ts`, repository queries over tasks, stage results, run responses, approvals, handoffs, token costs), `AnalyticsPage.tsx`.
  - Dependencies: T5.1, T5.3, T6.1.
  - Implementation: KPIs with source status and timestamp: conversations, AI-resolved rate, handed to staff, avg first response time, approvals (pending/decided/avg time), campaigns by state, AI cost by currency, failures by reason; charts with table alternative; revenue attribution "Chưa tích hợp" until outcomes exist. Spec §7.10.
  - Verification: repository tests with fixtures; Playwright: after stack scenarios numbers match DB counts.
  - Expected Result: truthful analytics.

- [ ] **T6.11 Settings**
  - Problem: CA10 — read-only, raw UUID, "Chưa có dữ liệu" badge beside a value, "changes on server".
  - Why: §9.
  - Files/Modules: `apps/tenant-console/src/components/company/SettingsPage.tsx` → tabs (`settings/{profile,approvals,ai,data,security,users,audit}`).
  - Dependencies: T2.3, T2.4, T2.5, T2.10, T9.3 (users tab), T6.1.
  - Implementation: per §9 catalog: forms with validation, dirty-state guard, save with `If-Match`, toast, conflict dialog, history drawer; secrets write-only with fingerprint; read-only fields explain who can change them. Spec §7.11.
  - Verification: Playwright: edit timezone → saved → audit entry visible; concurrent edit → conflict dialog.
  - Expected Result: settings are editable, safe and traceable.

- [ ] **T6.12 Error/loading/not-found boundaries and session UX**
  - Problem: no `error.tsx`/`loading.tsx`/`not-found.tsx`; a non-401 upstream error at layout renders raw Next 500; 30-min absolute session, no warning; sign-in error always "Email hoặc mật khẩu không đúng"; sign-out failure bounces back.
  - Why: polish and trust (§7.12).
  - Files/Modules: `apps/tenant-console/src/app/(app)/{error,loading,not-found}.tsx`, `lib/auth/session.ts`, sign-in page, same in platform-admin.
  - Dependencies: T6.1.
  - Implementation: route-level boundaries with retry; sliding session renewal + 5-minute warning dialog ("Gia hạn"); sign-in maps 401 vs 429 vs 5xx; sign-out awaits and shows error.
  - Verification: Playwright: simulate 502, expiry warning, rate limit.
  - Expected Result: graceful failures everywhere.

- [ ] **T6.13 Remove dead UI code and legacy routes**
  - Problem: `components/executive/*`, `components/conversation/{TakeoverControls,MessageStream,CopilotComposer,EvaluationUnavailableModal}`, `lib/sse.ts`, unused client methods; tests pin dead code.
  - Why: confusion and drift.
  - Files/Modules: listed files and their tests; `next.config.mjs` redirects for `/demo/*` (remove after one release).
  - Dependencies: T6.3–T6.8.
  - Implementation: delete; re-point tests to live components.
  - Verification: `tsc`, tests, grep.
  - Expected Result: only live code remains.

### Phase 7 — Test Customer Lab (workflow §5)

- [ ] **T7.1 TEST data class on customer-tree entities and safe reset**
  - Problem: no `data_class`; `demo:down --volumes` is the only reset.
  - Why: §5, §25, §29 ("Production data cannot be deleted by this flow").
  - Files/Modules: migration adding `data_class` to customers, identities, consents, orders, customer_events, conversations, conversation_messages, service_cases, care_handoffs, campaigns (recipient links), platform_durable_tasks, effect_reservations, approvals; `inherit_data_class()` trigger; `agentos_test_reset` role + `reset_test_data(p_tenant, p_actor, p_dry_run)`.
  - Dependencies: T2.1, T2.10.
  - Implementation: rows created through the lab are `TEST` (server decides, never the client); children inherit; class immutable after insert; reset deletes `TEST` rows only in FK order inside a tenant-fenced SECURITY DEFINER function, dry-run first, audited; audit/evidence chains are never deleted (they keep run ids); Redis/Qdrant keys for TEST customers purged by the API step.
  - Verification: RLS rehearsal; test: reset removes TEST rows, leaves PRODUCTION/DEMO rows and config untouched; a PRODUCTION id passed to delete → refused.
  - Expected Result: safe, tenant-fenced test data lifecycle.

- [ ] **T7.2 Test Customer Lab API**
  - Problem: `/api/v1/testing/*` missing.
  - Why: workflow §5.10.
  - Files/Modules: `apps/api/src/routes/v1/testing.ts` (new), repository `test-customers.ts`, OpenAPI, BFF allowlist.
  - Dependencies: T7.1, T2.9 (`testdata:manage`).
  - Implementation: `POST/GET /testing/customers`, `GET/DELETE /testing/customers/:id`, `POST /testing/customers/:id/{events,orders,consent,support-requests,handoff-request,widget-session}`, `POST /testing/reset` (dry-run + confirm token); env gate: allowed for DEMO tenants and for tenants whose settings enable test data; server binds tenant, refuses client `tenant_id`/`verified_customer_id`; sample orders are written to the SoR the tenant uses (mock ERP seed endpoint `POST /__sim/seed` for DEMO; real ERP only via its sandbox, else refused `SOR_SEED_UNSUPPORTED`); every mutation audited.
  - Verification: API tests per endpoint (permission, tenant binding, TEST-only).
  - Expected Result: server-side test customer lifecycle.

- [ ] **T7.3 Mock ERP seed/reset/control endpoints**
  - Problem: static pack; no order creation, no seeding, chaos only at boot (`services/mock-erp/src/server.mjs:106-158,274-278`); `orders/draft` always 409; fixture path outside Docker context.
  - Why: lab orders and live chaos tests.
  - Files/Modules: `services/mock-erp/src/server.mjs`, tests, Dockerfile.
  - Dependencies: none.
  - Implementation: signed `POST /__sim/seed` (customers/orders for a tenant, TEST only), `POST /__sim/reset`, `POST /__sim/control` (failure rate, latency, swallow-after-write), idempotent `POST /api/v1/orders` (decrements stock, visible in `orders/status`); copy fixture into image.
  - Verification: mock tests.
  - Expected Result: realistic, controllable SoR for tests.

- [ ] **T7.4 Launch storefront as a TEST customer**
  - Problem: widget sessions only for fixed demo personas (`apps/api/src/routes/v1/demo-widget.ts:33-36`).
  - Why: §5.7.
  - Files/Modules: `testing.ts` widget-session endpoint, `principal.ts`, T1.8 test-chat BFF.
  - Dependencies: T7.2, T1.8.
  - Implementation: server creates/uses a verified `customer_identities` row for the TEST customer bound to `(tenant_id, customer_id, session_id)` and issues the widget session; browser never sets `verified_customer_id`.
  - Verification: stack: launch as B, ask for A's order → denied with no leak (§5.8).
  - Expected Result: realistic customer-perspective testing.

- [ ] **T7.5 Test Customer Lab page**
  - Problem: no `/testing/customers` page.
  - Why: workflow §5, §28 daily QA flow.
  - Files/Modules: `apps/tenant-console/src/app/(app)/testing/customers/{page,new/page,[id]/page}.tsx`, `components/testing/*`, BFF allowlist.
  - Dependencies: T7.2–T7.4, T6.1.
  - Implementation: list of TEST customers; create form (Identity / Profile / Consent / optional Sales, Order, Care, Marketing seeds) → validate → preview → create; success card (Mở Customer360 / Khởi chạy Storefront với khách này / Tạo thêm); per-customer quick actions (§5.6) through server APIs only; confirmed "Reset dữ liệu thử nghiệm" with dry-run counts. Spec §7.13.
  - Verification: Playwright stack runs workflow §28 end to end: create → Customer360 → storefront Sales + Care → marketing signal → approval → request human → takeover → trace → reset.
  - Expected Result: workflow §29 Definition of Done satisfied.

### Phase 8 — Admin UI and control plane

- [ ] **T8.1 Platform-scoped run projections and tenant-targeted commands (decision D9)**
  - Problem: platform admin bound to the demo tenant (`apps/api/src/runtime/demo-auth.ts:11,276,301`); `/runs`, retry, reconcile, autonomy act on `principal.tenant_id`; `/admin/*` lacks scope check; `agentos_app` can `SET ROLE agentos_platform` (DB audit S1).
  - Why: Admin must monitor all companies.
  - Files/Modules: migration (SECURITY DEFINER `platform_list_runs`, `platform_run_detail`, `platform_runs_summary`, `platform_reconciliation_queue`, `platform_company_overview`), `platform-directory.ts`, new `apps/api/src/routes/v1/platform-runs.ts`, `platform-companies.ts`, dedicated platform DB login + pool.
  - Dependencies: T5.4, T2.10.
  - Implementation: projections return derived fields only (no customer data, no raw payloads); commands `POST /platform/companies/:id/runs/:runId/{retry,reconcile}`, `POST /platform/companies/:id/autonomy/{pause,resume,demote}`, `POST /platform/companies/:id/{suspend,resume}` executed under `withTenantContext(:id)` after platform authorization, audited with actor + target; separate login role for platform routes, remove `agentos_app` membership.
  - Verification: RLS rehearsal (app role cannot call platform functions); API tests; stack: platform retries a run of company B.
  - Expected Result: real cross-company operations without weakening isolation.

- [ ] **T8.2 Platform Overview and Companies**
  - Problem: PA1 — fleet cards "Chưa có dữ liệu", "Telemetry trực tiếp" badge without telemetry, scope card "Chỉ tenant hiện tại"; Companies status "Chưa phân loại", modules always empty, no rollups, provisioning unreachable (`apps/platform-admin/src/components/platform/{PlatformOverview,Companies}.tsx`).
  - Why: workflow §23 company directory and provisioning.
  - Files/Modules: those components, new `GET /platform/overview`, `GET /platform/companies`, `GET /platform/companies/:id`, BFF route for `POST /provisioning/tenants` (wizard), `PlatformShell.tsx` scope card.
  - Dependencies: T8.1, T2.1, T2.10.
  - Implementation: Overview = "Cần chú ý" queue (failed runs by cause, reconciliation needed, stuck work, provider/connector problems, companies not configured) + KPI cards (companies by status, runs 30 d by state, failure rate, tokens/cost by currency) with refresh time; Companies table with data class, status, domain readiness dots, provider/connector state, runs, failures, attention count, last activity; detail tabs (Tổng quan, AI Team, Kết nối & nhà cung cấp, Mức sử dụng, Lượt chạy, Tự chủ, Kiểm toán, Người dùng); "Tạo công ty" wizard (name, data class, locale/currency) → provision → invite admin (after T9.3). Spec §8.2–§8.3.
  - Verification: Playwright: create company → appears as "Chưa cấu hình" → configure via Company console → status "Hoạt động".
  - Expected Result: Platform Admin sees and onboards every company.

- [ ] **T8.3 Operations: runs, reconciliation queue, stuck work, run detail**
  - Problem: PA2 — AGENT empty, failure reason hidden in "Chi tiết nâng cao", `queued/waiting` mislabelled "Chờ phê duyệt", `running` "Cần chú ý", English filters with fake placeholder and raw ISO inputs, UI retry rule ≠ server rule, reconcile not exposed, BFF 404 for `runs`/`operations/runs` on the running stack (`RunTable.tsx:23-41,105-111`, `retry-helpers.ts:18-50`, `demo-provider.ts:258-279`).
  - Why: operators must see, understand and recover work (workflow §19–§21).
  - Files/Modules: `apps/platform-admin/src/components/operations/*`, new `ReconcileModal.tsx`, run detail page `/operations/runs/[companyId]/[runId]`, BFF route table.
  - Dependencies: T8.1, T5.4, T5.5.
  - Implementation: tabs Lượt chạy / Đối soát / Bị kẹt; state tiles; table columns time, company, domain/agent, current stage, state (business), failure cause (visible), duration, cost, attempts, actions from server `retry_eligibility`; Vietnamese filters with date pickers and timezone; reconcile modal (Provider xác nhận thành công / Provider xác nhận không có / Chuyển xử lý thủ công, mandatory reason, optional receipt) — never a blind retry for UNKNOWN; run detail = diagnostic trace (T5.4). Spec §8.4.
  - Verification: stack: failed RETRYABLE run → retry → completes; UNKNOWN run → appears in Đối soát → reconcile → settled; Playwright filters.
  - Expected Result: operational console for all companies.

- [ ] **T8.4 Usage**
  - Problem: PA3 — broken request (R2); usage sums across currencies, includes `UNAVAILABLE` cost rows, shows tenant UUIDs (`0016_platform_directory.sql:161-172`, `PlatformPages.tsx:26-30`).
  - Why: cost control per company.
  - Files/Modules: `platform_usage` function (new version), `apps/api/src/routes/v1/platform.ts`, `apps/platform-admin/src/app/(app)/usage/*`.
  - Dependencies: T1.2, T5.3, T8.1.
  - Implementation: group by company, day, domain, model, currency; `cost_status='RECORDED'` only, unrecorded shown as "Chưa ghi nhận chi phí"; tokens vs budget; CSV export. Spec §8.5.
  - Verification: fixture with two currencies; Playwright shows per-currency totals.
  - Expected Result: accurate usage per company.

- [ ] **T8.5 AI Providers management**
  - Problem: PA4 — one read-only env row; "Đã cấu hình" and "Chế độ" both "Hoạt động" (`PlatformPages.tsx:39-45`, `composition.ts:388-400`); "How to change?".
  - Why: workflow §18; provider changes without redeploy.
  - Files/Modules: `apps/platform-admin/src/app/(app)/providers/*`, API from T2.5.
  - Dependencies: T2.5.
  - Implementation: provider list (status, models, timeout, budget, last probe with latency/error class), edit drawer (base URL, models, timeout, structured mode, write-only key with fingerprint), "Kiểm tra kết nối", default provider switch with confirmation + reason, per-company override visibility. Spec §8.6.
  - Verification: Playwright: rotate key → test → "Hoạt động"; invalid URL (http/private IP) refused.
  - Expected Result: providers are manageable and verifiable.

- [ ] **T8.6 System Health with real probes**
  - Problem: legacy English `ReadinessConsole.tsx` with own sign-out; probes `NOT_RUN` forever (`composition.ts:548-562`); demo-only route.
  - Why: PA5.
  - Files/Modules: new `GET /platform/health` (API, DB, Redis, Qdrant, worker heartbeats, queue depth, oldest queued age, expired leases, migration ledger, LLM probe, connector probes per company summary), migration `worker_heartbeats`, worker heartbeat writer, `system-health` page rewrite.
  - Dependencies: T0.5, T2.5, T2.6.
  - Implementation: probes with timeout + 30 s cache; states "Hoạt động / Suy giảm / Lỗi / Chưa kiểm tra".
  - Verification: stop worker → health shows "Worker: Lỗi" within 60 s.
  - Expected Result: an honest system health view.

- [ ] **T8.7 Audit log viewer**
  - Problem: audit rows are written but unreadable; platform actions attributed to `HUMAN_HANDOFF` on the demo tenant (`apps/api/src/runtime/composition.ts:461-490`).
  - Why: "understand what happened" and accountability.
  - Files/Modules: `apps/platform-admin/src/app/(app)/audit/*`, company audit tab in Settings (T6.11), API from T2.10.
  - Dependencies: T2.10.
  - Implementation: filters (company, actor, action, time, outcome), cursor pagination, chain verification badge, detail drawer with redacted before/after. Spec §8.8.
  - Verification: change a provider → audit row visible with reason; chain verify passes; tampered fixture → badge "Lỗi".
  - Expected Result: every administrative change is traceable.

- [ ] **T8.8 Subscriptions behind a feature flag (decision D13)**
  - Problem: static "Chưa tích hợp" page in primary nav (`PlatformPages.tsx:47-49`).
  - Why: avoid fake functionality.
  - Files/Modules: `PlatformShell.tsx` nav, `PlatformPages.tsx`.
  - Dependencies: none.
  - Implementation: hide nav item unless `PLATFORM_FEATURE_SUBSCRIPTIONS=true`; explain status in Settings → "Gói dịch vụ: Chưa tích hợp".
  - Verification: nav test with flag on/off.
  - Expected Result: no fake screen in the main navigation.

- [ ] **T8.9 Platform Settings and skill catalog**
  - Problem: PA6 — read-only, "SCOPE: Hoạt động", raw `platform_admin`, English labels (`PlatformPages.tsx:51-54`).
  - Why: platform configuration must be manageable.
  - Files/Modules: `apps/platform-admin/src/app/(app)/settings/*`, skill catalog page (T4.4 API).
  - Dependencies: T4.4, T9.3.
  - Implementation: tabs Tài khoản (profile, password once T9.2), Quản trị viên (platform admins, invite), Danh mục kỹ năng (catalog, per-company entitlement), Tính năng (flags, read-only), Bảo mật (session policy). Spec §8.9.
  - Verification: Playwright; permission tests.
  - Expected Result: useful platform settings.

- [ ] **T8.10 Remove dead platform code and fix fonts**
  - Problem: unused `TenantWorkspace.tsx`, `RequirePermission.tsx`, `src/server.mjs`, `env.mjs` NEXTAUTH leftovers, `telemetry/kpi-snapshot` allowlist entry; `globals.css:7-10` sets fonts without fallbacks so badges render serif.
  - Why: clarity and polish.
  - Files/Modules: listed files, `apps/platform-admin/src/app/globals.css`.
  - Dependencies: T8.2–T8.9.
  - Implementation: delete dead files; restore font stacks from `tokens.css`.
  - Verification: `tsc`, tests, visual check.
  - Expected Result: lean platform console.

### Phase 9 — Real identity (decision D15)

- [ ] **T9.1 Users, memberships, sessions schema**
  - Problem: identity only in env demo store; in-memory sessions lost on restart (`apps/api/src/runtime/demo-auth.ts`, consoles `lib/auth/session.ts`).
  - Why: workflow §3 membership; Admin "monitor users"; production path.
  - Files/Modules: migration `users` (global, default-deny RLS), `tenant_memberships` (tenant RLS), `auth_sessions` (token hash only), SECURITY DEFINER `auth_*` functions for a dedicated `agentos_auth` role.
  - Dependencies: T2.1, T2.10.
  - Implementation: argon2id/scrypt password hashes computed in app; idle + absolute expiry; lockout counters; memberships carry role bundle (`COMPANY_ADMIN|OPERATOR|VIEWER`) resolved to permissions server-side.
  - Verification: migration + RLS tests.
  - Expected Result: durable identity model.

- [ ] **T9.2 Auth API and database AuthProvider**
  - Problem: both consoles authenticate only through the demo provider (`apps/*/src/lib/auth/demo-provider.ts`), which returns 404 outside `DEMO_MODE` + `APP_ENV=local|ci`; the API has no login route for real users.
  - Why: workflow §3 (backend authentication → company membership + permissions) and a production path.
  - Files/Modules: `apps/api/src/routes/v1/auth.ts` (`POST /auth/login`, `/auth/logout`, `/auth/session`, `/auth/password`), `principal.ts` (resolve DB sessions), consoles `lib/auth/db-provider.ts` behind the existing `AuthProvider` seam; Redis session cache optional.
  - Dependencies: T9.1.
  - Implementation: demo provider stays for DEMO tenants in local/CI; production boots require DB provider; sliding renewal; rate limiting per IP+email; no user enumeration.
  - Verification: Playwright sign-in/out/expiry against DB provider; restart API → session survives.
  - Expected Result: real sign-in for both consoles.

- [ ] **T9.3 Invitations and user management**
  - Problem: no way to create the first Company Admin or add users.
  - Why: workflow §4 "Company Admin first login"; Admin "monitor users".
  - Files/Modules: `POST /platform/companies/:id/invitations`, `GET/POST/PATCH /company/users` (invite, change bundle, deactivate), accept-invite page in tenant console, email sender port (log-only transport in local/CI).
  - Dependencies: T9.2.
  - Implementation: single-use invitation tokens (hash stored, 72 h expiry); accept → set password → membership ACTIVE; deactivation revokes sessions; all audited.
  - Verification: API tests (expiry, reuse refused); Playwright invite → accept → sign in.
  - Expected Result: real onboarding of company users.

- [ ] **T9.4 User views in both consoles**
  - Problem: no user visibility.
  - Why: "monitor companies/users".
  - Files/Modules: Platform Companies → Người dùng tab; Company Settings → Người dùng tab.
  - Dependencies: T9.3.
  - Implementation: list (name, email masked for platform view, role bundle, status, last sign-in), actions (resend invite, deactivate) permission-gated.
  - Verification: Playwright; permission tests.
  - Expected Result: user lifecycle is visible and manageable.

### Phase 10 — Testing and CI (matrix in §13)

- [ ] **T10.1 Complete the offline stack E2E suite**
  - Problem: only Phase 0/1 scenarios exist in `tests/stack`.
  - Why: R9 — CI must prove the production flow.
  - Files/Modules: `tests/stack/*.stack.test.mjs`.
  - Dependencies: Phases 1–8.
  - Implementation: every row of §13.2 as a test (happy, invalid input, auth failure, integration failure, skill failure, timeout, retry, duplicate, empty state, refresh/recovery, Company/Admin sync).
  - Verification: suite green; mutation check — reintroduce R1 in a scratch branch → suite red.
  - Expected Result: connected flows are continuously proven.

- [ ] **T10.2 Playwright against the real stack**
  - Problem: UI tests use a stub API (`tests/ui/global-setup.ts:114-220`) returning unreachable values.
  - Why: UI/API contract drift went unnoticed (R8).
  - Files/Modules: `tests/ui/*` split into `stub/` (fast) and `stack/` (real API/worker/DB); axe on every route.
  - Dependencies: T10.1.
  - Implementation: critical journeys (§13.2 UI rows) on the real stack; stub suite only for layout/permissions; copy lint in page assertions.
  - Verification: CI job green; deliberately rename an API field → stack UI test fails.
  - Expected Result: the UI is tested against real data shapes.

- [ ] **T10.3 Live suite with the real `.env`**
  - Problem: no safe way to run real-provider tests.
  - Why: user requirement "real integration/live-flow testing".
  - Files/Modules: `tests/live/{README.md, playwright.live.config.ts, global-setup.ts, api/*.live.test.mjs, ui/*.live.spec.ts}`, `scripts/live/{preflight,scan-artifacts,reset}.mjs`, root scripts `live:up|live:preflight|test:live|live:scan|live:reset`, `.github/workflows/live-e2e.yml`.
  - Dependencies: T10.1, T0.3.
  - Implementation: §13.3 (safety rules, budget caps, isolated database, artifact scanning).
  - Verification: dry run with placeholder keys refuses before any request; full run on the user's machine produces a redacted report.
  - Expected Result: real-provider verification without secret exposure.

- [ ] **T10.4 Chaos and recovery tests**
  - Problem: recovery paths (§21, §22) unproven.
  - Why: no duplicate effects after crashes; fail-closed on connector loss.
  - Files/Modules: `tests/stack/chaos/*.stack.test.mjs`, mock ERP `/__sim/control` (T7.3), LLM stub fault modes (T0.4).
  - Dependencies: T7.3, T0.4, T5.5.
  - Implementation: worker SIGKILL mid-run, ERP down/latency/swallow-after-write, LLM 429/5xx/timeout/invalid JSON, Redis down during takeover, Postgres restart.
  - Verification: assertions on exactly-once effects and visible states.
  - Expected Result: recovery guarantees are tested.

- [ ] **T10.5 Contract tests and OpenAPI completeness**
  - Problem: 13 of 51 routes undocumented; 24 of 38 operations without response schema; consoles hand-type 66 DTOs.
  - Why: drift prevention.
  - Files/Modules: `packages/api-contract/*`, `apps/api/scripts/openapi-emit.mjs`, console type imports.
  - Dependencies: T6.1.
  - Implementation: schemas for every route incl. error envelope and enums; `check:openapi` in CI; generated client types used by both consoles; vocabulary coverage test over OpenAPI enums.
  - Verification: CI fails on undocumented route or enum without label.
  - Expected Result: one contract shared by API and UI.

- [ ] **T10.6 CI gates**
  - Problem: no stack job, no demo-boundary/script tests, no secret scan; `.env.demo/.env.live` not ignored; Playwright traces uploaded.
  - Why: keep "green" meaningful and secrets safe.
  - Files/Modules: `.github/workflows/production-pipeline.yml`, `.gitignore`, `tests/ui/playwright.config.ts`.
  - Dependencies: T10.1–T10.5.
  - Implementation: jobs `test:stack`, `check:demo-boundary` + `node --test scripts/**/*.test.mjs`, migration numbering, gitleaks, Playwright stack; ignore `.env.*` except `.env.example`; `trace: 'off'` for live.
  - Verification: pipeline runs all jobs on push.
  - Expected Result: CI blocks broken flows and leaked secrets.

### Phase 11 — Technical debt and cleanup (inventory in §14)

- [ ] **T11.1 Remove dead code**
  - Problem: dead modules listed in §14.1.
  - Why: confusion, false coverage.
  - Files/Modules: §14.1.
  - Dependencies: feature phases done.
  - Implementation: delete; re-point tests.
  - Verification: `tsc`, lint, tests, grep for imports.
  - Expected Result: only live code.

- [ ] **T11.2 Consolidate duplicates**
  - Problem: four canonical-JSON variants, two effect-key implementations, duplicate port declarations, duplicate evidence crypto (§14.2).
  - Why: drift risk in security-relevant code.
  - Files/Modules: `packages/database/src/repositories/canonical-json.ts` (single source), `packages/core-engine/src/{durability,effects}/*`, `contracts/*`.
  - Dependencies: none.
  - Implementation: one implementation re-exported; byte-compatibility tests over fixtures.
  - Verification: fixture digests unchanged.
  - Expected Result: one definition each.

- [ ] **T11.3 Known debt (workflow §30)**
  - Problem: electronics-oriented classifier and currency heuristics (`apps/api/src/routes/v1/turn-classifier.ts`); "for"/"one" parsed as currency.
  - Why: industry-agnostic product.
  - Files/Modules: `turn-classifier.ts`, `turn-intent.ts`, tenant lexicon from catalog categories.
  - Dependencies: T2.6 (catalog), T5.3.
  - Implementation: LLM structured understanding as primary (bounded retry, fail closed), regex only as ISO-4217-validated fallback; lexicon from tenant catalog.
  - Verification: tests for FMCG and fashion catalogs; "laptop under 500 for gaming" → no currency `FOR`.
  - Expected Result: classifier works for any vertical.

- [ ] **T11.4 Documentation refresh**
  - Problem: docs drift (README layout, `docs/demo/README.md` claims, `blocked.md` stale paths/counts, operations commands missing).
  - Why: next engineers need accurate runbooks.
  - Files/Modules: `README.md`, `docs/demo/README.md`, `docs/operations/*.md`, `blocked.md`, `docs/product/workflow.md` kept in sync with product decisions.
  - Dependencies: all phases.
  - Implementation: update commands, auth, secrets, live tests, architecture diagram (§2.1 updated).
  - Verification: docs lint; commands in docs executed in CI smoke.
  - Expected Result: accurate documentation.

- [ ] **T11.5 Knowledge corpus hygiene**
  - Problem: approved FAQ leaks internals (`skill.care.escalate_to_human`, `source_version`), policy docs cite nonexistent permissions (`campaign:create`, `conversation:reply`).
  - Why: customer-facing text must be clean.
  - Files/Modules: `packages/second-brain/demo/novamart/**` (then DB import, T3.3).
  - Dependencies: T3.3.
  - Implementation: rewrite customer-facing entries; move engineering notes out of the corpus.
  - Verification: corpus lint (no `skill.`, `AUTH-`, `source_version` in customer-facing docs).
  - Expected Result: clean customer answers.

---

## 6. Workflow Integration Matrix

Legend: ✅ connected · ⚠️ partial · 🧪 mock/demo-only · ❌ broken or missing. "Now" = audited HEAD `7c03cb2`; "Target" = after the listed tasks.

| Workflow | UI | API | Service | Agent | Skill/Tool | Database | Admin | Status now → target (tasks) |
|---|---|---|---|---|---|---|---|---|
| Company sign-in / expiry / logout (§3) | ✅ sign-in, middleware, layout | 🧪 `/demo/login` | 🧪 in-memory store | — | — | ❌ no users/sessions | ❌ no user view | 🧪 → ✅ (T9.1–T9.4) |
| Platform sign-in (§3) | ✅ | 🧪 | 🧪 | — | — | ❌ | — | 🧪 → ✅ (T9.2) |
| Create company / provisioning (§4, §23) | ❌ no wizard | ⚠️ `POST /provisioning/tenants` unreachable | ⚠️ shell only | — | — | ⚠️ shell CHECKs | ❌ | ❌ → ✅ (T2.1, T8.2) |
| Company setup & activation (§4, §27) | ❌ | ❌ no write APIs | ❌ | ❌ agents inactive | — | ❌ states not representable | ❌ | ❌ → ✅ (T2.1–T2.8, T6.3) |
| Dashboard (§6) | ⚠️ raw codes, flood | ⚠️ projections | ⚠️ | — | — | ⚠️ domain never written | — | ⚠️ → ✅ (T5.4, T6.3) |
| AI Team (§7) | ❌ "Chưa phân loại" | ⚠️ DISABLED always | ❌ | ⚠️ | — | ❌ | — | ❌ → ✅ (T2.7, T6.4) |
| Marketing campaign → approval (§8) | ⚠️ sends objective as segment | ⚠️ no validation | ⚠️ worker plan | ⚠️ MKT-02/03/04/05 | ⚠️ LLM, brand guard (files) | ⚠️ no campaign row | ❌ | ❌ → ✅ (T1.5, T1.6, T1.9, T6.7) |
| Approval decision → revalidate → dispatch (§8, §15) | ⚠️ legacy English | ✅ queue decision | ✅ fenced claim | ✅ | ⚠️ digest mismatch; ❌ API-003 unbound | ✅ | ❌ | ⚠️ → ✅ ("Đã duyệt · Chưa tích hợp kênh gửi" until a channel is connected) (T1.6, T6.8, T2.6) |
| Sales recommendation (§9) | ❌ Try page refused | ✅ admission | ✅ | ⚠️ over-gated | 🧪 mock ERP, demo revenue port | ❌ save fails (R1) | ⚠️ | ❌ → ✅ (T1.1, T1.4, T1.8, T1.14) |
| Sales create order (§9) | ❌ | ✅ approvals | ❌ never planned | ❌ | ❌ AUTH-3, refuse-all authority | ✅ | ❌ | ❌ → ✅ (T4.1, T2.6, mock orders T7.3) |
| Care FAQ (§10) | ⚠️ | ✅ | ✅ | ✅ | ⚠️ filesystem knowledge | ❌ save fails (R1) | ⚠️ | ❌ → ✅ (T1.1, T1.4, T3.3) |
| Care order lookup + ownership (§10, §5.8) | ⚠️ | ✅ | ⚠️ identity split | ✅ | 🧪 mock ERP | ✅ | — | ⚠️ → ✅ (T1.12, T2.6) |
| Human escalation → takeover → resume (§11–12) | ⚠️ contradictory state | ✅ takeover/resume | ❌ handoff stalls (R3) | ✅ | ❌ | ✅ | ❌ | ❌ → ✅ (T1.3, T1.10, T6.5) |
| Customer360 (§13) | ⚠️ no names/search | ✅ | ⚠️ timeline partial | — | — | ⚠️ events without customer | — | ⚠️ → ✅ (T6.6) |
| Cross-domain (§14) | — | — | ✅ broker (opt-in) | ⚠️ Sales→Care open decision | — | ✅ ledger | — | ⚠️ → ⚠️ by design (owner input "Chưa cấu hình", D12) |
| Knowledge (§4) | ❌ empty | ❌ | ❌ | ⚠️ reads files | ⚠️ | ❌ | — | ❌ → ✅ (T3.1–T3.4) |
| Integrations connect/test (§17) | ❌ read-only | ❌ | ❌ env singleton | — | 🧪 | ❌ UNBOUND only | ❌ | ❌ → ✅ (T2.2, T2.6, T6.9) |
| LLM provider config (§18) | ❌ | ❌ | ❌ env | ✅ fail closed | ⚠️ no retry | ❌ | ❌ read-only | ❌ → ✅ (T2.5, T5.3, T8.5) |
| Skills management | ❌ | ❌ | ❌ static | ⚠️ | ⚠️ code only | ❌ unused table | ❌ | ❌ → ✅ (T4.1–T4.6) |
| Controlled autonomy (§16) | ❌ | ⚠️ platform-only admin | ⚠️ parks reads | ✅ | ✅ | ⚠️ no CAS | ⚠️ dead UI | ⚠️ → ✅ (T4.5, T8.2) |
| Test Customer Lab (§5) | ❌ | ❌ | ❌ | — | — | ❌ no data class | — | ❌ → ✅ (T7.1–T7.5) |
| Effects / reconcile (§19) | — | ⚠️ R18 unreachable | ⚠️ no sweeper | ✅ | ✅ reservation | ✅ | ❌ | ⚠️ → ✅ (T5.5, T8.3) |
| Observability / trace (§20) | ⚠️ raw stage feed | ⚠️ trace endpoint | ⚠️ entry-only | — | ⚠️ lossy receipts | ⚠️ | ⚠️ hidden reasons | ⚠️ → ✅ (T5.1, T5.4, T6.x, T8.3) |
| Worker recovery (§21) | — | — | ⚠️ heartbeat conflicts, memory state | — | — | ✅ checkpoints | ❌ | ⚠️ → ✅ (T1.11, T1.15, T10.4) |
| Platform directory / usage (§23) | ❌ errors | ❌ 400 (R2) | ⚠️ | — | — | ✅ functions | ❌ | ❌ → ✅ (T1.2, T8.2, T8.4) |
| Platform operations (§23) | ⚠️ wrong columns | ⚠️ tenant-bound | ⚠️ | — | — | ✅ | ⚠️ | ⚠️ → ✅ (T8.1, T8.3) |
| System health (§23) | ⚠️ legacy page | 🧪 demo-only | ❌ no probes | — | — | ❌ | ⚠️ | ❌ → ✅ (T0.5, T8.6) |
| Audit (§15, §26) | ❌ | ❌ | ⚠️ written, unreadable | — | — | ⚠️ PII in audit | ❌ | ⚠️ → ✅ (T2.10, T5.2, T8.7) |

---

## 7. Company UI/UX Improvements

Audience: a company admin, not an engineer. Language: Vietnamese first (`vi` catalog), URLs English. Status vocabulary §24 plus the additions in §7.14. Every page: one `h1` (no eyebrow repeating the nav label), skeleton loading, per-section error with retry and correlation id under "Chi tiết kỹ thuật", positive empty state with a primary action, `vi-VN` dates, tenant currency.

### 7.1 Shell and navigation (T6.2)

Screenshot defects fixed: duplicated "Cài đặt" (CA1–CA11), UUID + literal "Production" + unconditional Demo badge, fake "Search workspace ⌘K", repeated page titles, "↗" logout glyph, English aria labels.

- Sidebar groups: **Tổng quan** · **Việc cần làm**: Hội thoại (badge = cần nhân viên), Phê duyệt (badge = chờ duyệt) · **Kinh doanh**: Khách hàng, Chiến dịch · **AI**: AI Team, Kiến thức, Kết nối, Phân tích · footer: Phòng thử nghiệm (only `testdata:manage` and tenant allows test data), Cài đặt (single entry).
- Workspace card: company name from profile + environment chip from `data_class` (Demo / Dữ liệu thử / Production hidden) — UUID moves to Settings → Chi tiết kỹ thuật with copy button.
- Topbar: breadcrumb only (no duplicate title); user menu with name, email, "Đăng xuất" text button; session-expiry warning 5 min before.
- Search: removed until a command palette exists (later: customers via `GET /customers?query=`, pages index).
- Mobile: drawer with focus trap and focus moved in, single close button; tablet (768–1279 px): collapsible rail so content keeps ≥ 720 px.
- Root font 16 px; contrast AA for warning/success text.
- "Thử trợ lý" leaves primary nav → AI Team → Sales → Thử nghiệm, and Test Customer Lab.

### 7.2 Tổng quan / Overview (T6.3)

1. Greeting: "Xin chào, {tên}" + company + environment chip.
2. **Cần bạn xử lý** (max 5 grouped cards, one CTA each): "1 chiến dịch chờ phê duyệt → Xem phê duyệt", "2 hội thoại cần nhân viên → Mở hội thoại", "3 kết nối chưa cấu hình → Xem kết nối", "Cần thiết lập 11 chính sách → Thiết lập", "Dịch vụ AI không khả dụng → Kiểm tra". Empty: "Mọi thứ đang ổn".
3. **AI Team**: three compact cards (status + reason, "đang làm gì", one counter, "Xem").
4. **Hôm nay**: hội thoại, AI tự xử lý, chuyển nhân viên, chờ phê duyệt, chiến dịch theo trạng thái — each with "cập nhật lúc HH:mm"; shown only for sources that exist.
5. **Hoạt động gần đây**: one line per run: "Trợ lý Bán hàng đã tư vấn cho Nguyễn Văn A · 2 phút trước" → link to conversation/campaign; "Chi tiết thực thi" link opens the friendly run story (§11).
6. **Thiết lập workspace** checklist while workspace is not ACTIVE (profile, ERP/catalog, knowledge, LLM, channels, test agents, activate).

### 7.3 AI Team (T6.4)

- `/ai-team`: three cards: Marketing ("Lập kế hoạch và soạn chiến dịch"), Sales ("Tư vấn và gợi ý sản phẩm"), Customer Care ("Hỗ trợ khách và chuyển nhân viên khi cần"). Each: status chip + reason ("Chưa cấu hình: thiếu kết nối ERP"), current activity ("3 hội thoại đang xử lý"), needs attention, primary action (Kích hoạt / Xem).
- `/ai-team/{domain}` tabs: **Tổng quan** (status, current activity, attention, recent work) · **Kỹ năng** (§10.4) · **Nguồn dữ liệu & kênh** (connectors/knowledge it uses) · **Thử nghiệm** (Sales chat, Care FAQ test, Marketing draft preview) · **Chi tiết kỹ thuật** (agent codes, authority levels, autonomy state).
- Activate/Pause buttons call T2.7 endpoints; unmet prerequisites listed with links.

### 7.4 Khách hàng / Customer360 (T6.6)

- List: DataTable — Tên (or "Khách #a1b2" + masked contact), Hạng, Xác minh, Kênh, Hoạt động gần nhất, Số đơn, Đồng ý marketing, data-class chip. Toolbar: search, filters (phân khúc, hạng, đồng ý, loại dữ liệu), sort. Empty: "Chưa có khách hàng. Khách xuất hiện khi họ chat qua widget hoặc khi đồng bộ từ ERP." + [Tạo khách thử nghiệm].
- Profile: header (name, tier, verified, class, actions "Mở hội thoại", "Khởi chạy Storefront như khách này" for TEST) · left cards Định danh, Hồ sơ/Phân khúc, Đồng ý theo kênh, Đơn hàng gần đây · right tabs Dòng thời gian, Đơn hàng, Hội thoại, Chiến dịch, Gợi ý bán hàng ("Dự đoán"), Hỗ trợ.
- Timeline: business sentences with icons; classification chips secondary; "Timeline nâng cao" toggle shows FACT / SIGNAL / HYPOTHESIS / DECISION / ACTION; HYPOTHESIS never styled as fact; unknown → "Chưa phân loại" only in advanced mode.

### 7.5 Hội thoại / Conversation workspace (T6.5, T1.10)

- Desktop 3 panes (§12), tablet 2 panes + customer drawer, mobile list → thread → customer drawer with back button.
- Ownership states and actions:

| State | Banner | Actions |
|---|---|---|
| AI_ACTIVE | "AI đang phụ trách" | Tiếp quản |
| NEEDS_HUMAN | "Khách yêu cầu nhân viên" | Nhận xử lý |
| HUMAN_ME | "Bạn đang phụ trách · còn m:ss" | Trả lại cho AI, composer |
| HUMAN_OTHER | "{tên} đang phụ trách" | Xem (read-only) |
| PAUSED_ORPHAN | "AI tạm dừng, chưa có nhân viên" | Tiếp quản, Trả lại cho AI |
| CLOSED | "Đã đóng" | — |

- Takeover opens a small confirm popover with optional reason chips (not an always-visible input).
- Bubbles: Khách (left, neutral), AI (left, tinted, "AI" label), Nhân viên (right), Hệ thống (centered, muted). Run failures render a system row ("Trợ lý chưa trả lời được") with link to the run story.
- Composer states: Đang gửi · Đã lưu · Đã gửi · Gửi thất bại (retry).
- Polling 5 s while visible; heartbeat with retry and countdown.

### 7.6 Chiến dịch / Campaigns (T6.7, T1.9)

- List grouped: Đang soạn · Chờ phê duyệt · Đã duyệt · Lỗi. Card: name, objective label, audience "320 khách", channel icon, status chip, next step ("Chờ bạn phê duyệt → Xem").
- Wizard: 1 Mục tiêu (select + optional brief) → 2 Đối tượng (segment picker with counts and "chỉ gửi khách đã đồng ý") → 3 Kênh, giọng điệu, hướng dẫn → 4 Xem lại → Tạo bản nháp.
- Detail: stepper Soạn nội dung → Kiểm tra thương hiệu → Kiểm tra đồng ý → Chờ duyệt → Đã duyệt → Gửi đi; content preview; audience size; approval panel link; failure reason in plain words; "Gửi đi: Chưa tích hợp kênh gửi · Kết nối kênh" only after approval.

### 7.7 Phê duyệt / Approvals (T6.8)

- Tabs Chờ duyệt / Đã xử lý; card sentence, requesting agent display name, domain chip, risk chip, expiry countdown.
- Drawer: "Điều gì sẽ xảy ra", preview (campaign content, order summary), checks (đồng ý, thương hiệu, giá), evidence list, before/after for modifications.
- Actions: Duyệt · Từ chối (reason required, quick reasons) · Yêu cầu sửa (structured fields per action type) · menu: Tạm dừng, Hủy. Distinct-approver notice when policy on.
- After decision: "Đã duyệt · Đang kiểm tra lại nội dung và đồng ý trước khi gửi" → final state from the run ("Đã gửi" / "Đã duyệt · Chưa tích hợp kênh gửi" / "Đề xuất đã thay đổi, cần duyệt lại").
- Advanced: authority level, run_id, effect_key, payload digest.

### 7.8 Kết nối / Integrations (T6.9)

- Groups: Dữ liệu sản phẩm & đơn hàng (ERP/POS, Shopify, CSV) · Kênh trò chuyện (Web chat, Email, Zalo, Messenger, WhatsApp) · Dịch vụ AI · Thanh toán & tuân thủ (seams "Chưa tích hợp").
- Card: name, what it powers ("Cung cấp giá và tồn kho cho Trợ lý Bán hàng"), status (Hoạt động · Demo · Chưa cấu hình · Chưa tích hợp · Lỗi), last check time, actions [Kết nối] [Kiểm tra] [Chi tiết].
- Connect modal: catalog-driven fields, write-only secret (fingerprint shown after save), "Kiểm tra kết nối" with per-check results (Danh mục, Tồn kho, Khách hàng, Đơn hàng).

### 7.9 Kiến thức / Knowledge (T3.4)

- Table: title, type, status (Nháp · Chờ duyệt · Đã duyệt · Đang được AI dùng · Lưu trữ), owner, updated, used by (agents).
- [Thêm tài liệu]: type, title, markdown editor or upload → Lưu nháp / Gửi duyệt. Review drawer with diff to previous version, Duyệt / Trả lại with comment.
- Empty: "Chưa có tài liệu. Thêm câu hỏi thường gặp, chính sách đổi trả, bảo hành… để AI trả lời chính xác." + templates for FAQ, returns, shipping, warranty, brand voice.

### 7.10 Phân tích / Analytics (T6.10)

Period selector (24 giờ, 7 ngày, 30 ngày); KPI cards with source status and timestamp; charts with table alternative; missing sources name the gap with CTA ("Doanh thu: Chưa tích hợp · Kết nối ERP đơn hàng").

### 7.11 Cài đặt / Settings (T6.11)

Tabs: Công ty · Phê duyệt · AI & mô hình · Dữ liệu · Bảo mật · Người dùng · Nhật ký. Behaviour per §9.

### 7.12 States, errors and session (T6.12)

- Error boundary per route; `describeApiError` messages ("Không tải được dữ liệu. Thử lại"), correlation id under Chi tiết kỹ thuật.
- Sign-in errors: sai thông tin · quá nhiều lần thử (chờ N giây) · hệ thống tạm thời không khả dụng.
- Session: sliding renewal; warning dialog 5 min before expiry; expired → `/sign-in?reason=expired` with "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.".

### 7.13 Phòng thử nghiệm / Test Customer Lab (T7.5)

Left: TEST customers (search, status). Right: create form (Định danh · Hồ sơ · Đồng ý · Hạt giống Sales / Đơn hàng / Hỗ trợ / Marketing, each optional and collapsible) → Xem trước → Tạo. Success card with the three actions of workflow §5.5. Per-customer quick actions (§5.6). Reset dialog shows dry-run counts and requires typing the company name.

### 7.14 Vocabulary additions (extend workflow §24)

| Code(s) | Label |
|---|---|
| NOT_RUN | Chưa kiểm tra |
| queued | Đang chờ chạy |
| running | Đang chạy |
| waiting (effect RESERVED) | Cần đối soát |
| waiting (other) | Đang chờ |
| awaiting_human (approval) / (handoff) | Chờ phê duyệt / Cần nhân viên hỗ trợ |
| completed | Hoàn tất |
| stopped | Đã dừng |
| failed | Lỗi (+ lý do) |
| PROVISIONED / UNCONFIGURED | Chưa cấu hình |
| DEGRADED | Suy giảm |
| DRAFT / REVIEW / APPROVED / AVAILABLE / ARCHIVED (knowledge) | Nháp / Chờ duyệt / Đã duyệt / Đang được AI dùng / Lưu trữ |
| PENDING / APPROVED / REJECTED / EXPIRED / CANCELLED (approval) | Chờ phê duyệt / Đã duyệt / Đã từ chối / Hết hạn / Đã hủy |
| TEST / DEMO | Dữ liệu thử / Demo |

---

## 8. Admin UI Improvements

Audience: AgentOS operators. Scope label "Toàn nền tảng" (never "Chỉ tenant hiện tại"). Vietnamese, "công ty" instead of "tenant".

### 8.1 Screens to remove or redesign

| Screen | Problem | Action |
|---|---|---|
| Overview (PA1) | all-or-nothing error, fake "Telemetry trực tiếp", readiness tiles are tenant status | Redesign (T8.2) |
| Operations (PA2) | wrong columns, hidden reasons, tenant-bound | Redesign (T8.3) |
| Usage (PA3) | broken request, mixed currencies | Fix + redesign (T1.2, T8.4) |
| Providers (PA4) | read-only env row | Redesign with CRUD + probe (T8.5) |
| System Health (PA5) | legacy English demo page with own sign-out | Replace (T8.6) |
| Settings (PA6) | static, "SCOPE: Hoạt động" | Redesign (T8.9) |
| Subscriptions | static stub | Hide behind flag (T8.8) |
| `TenantWorkspace.tsx`, `RequirePermission.tsx` | dead | Delete (T8.10) |

### 8.2 Tổng quan (T8.2)

"Cần chú ý" queue: lượt chạy lỗi theo nguyên nhân · cần đối soát · bị kẹt (lease hết hạn, chờ quá N phút) · chờ nhân viên quá SLA · nhà cung cấp AI lỗi/chưa kiểm tra · kết nối lỗi · công ty chưa cấu hình. KPI cards: công ty theo trạng thái, lượt chạy 30 ngày theo trạng thái, tỷ lệ lỗi, token và chi phí theo tiền tệ, cập nhật lúc. Every card independently loaded.

### 8.3 Công ty (T8.2)

Table + filters + search; "Tạo công ty" wizard; detail tabs Tổng quan · AI Team · Kết nối & nhà cung cấp · Mức sử dụng · Lượt chạy · Tự chủ (pause/resume/demote with evidence window) · Kiểm toán · Người dùng. Destructive actions (suspend, pause autonomy) require reason and are audited.

### 8.4 Vận hành (T8.3)

Tabs: **Lượt chạy** (state tiles; table: thời gian, công ty, lĩnh vực/agent, giai đoạn, trạng thái, nguyên nhân lỗi, thời lượng, chi phí, số lần thử, hành động) · **Đối soát** (effects UNKNOWN with reconcile modal; never blind retry) · **Bị kẹt** (expired leases, long-queued). Run detail = diagnostic view (§11.2). Search by run id, correlation id, conversation id.

### 8.5 Mức sử dụng (T8.4)

By company/day/domain/model; per currency; tokens vs budget; unrecorded cost rows labelled; CSV export.

### 8.6 Nhà cung cấp AI (T8.5)

List + edit drawer + test + default switch; per-company overrides visible (read-only link to company).

### 8.7 Tình trạng hệ thống (T8.6)

Components: API, Database (+ migration ledger), Redis, Qdrant, Worker (heartbeats, queue depth, oldest queued, expired leases), LLM provider probes, connector probe summary. States Hoạt động / Suy giảm / Lỗi / Chưa kiểm tra with last check time.

### 8.8 Nhật ký kiểm toán (T8.7)

Filters, cursor, chain verification badge, redacted before/after.

### 8.9 Cài đặt (T8.9)

Tài khoản · Quản trị viên · Danh mục kỹ năng · Tính năng (flags) · Bảo mật.

### 8.10 Company ↔ Admin synchronization

Both consoles read the same projections and vocabulary. Run state changes are visible in both within one polling interval (5 s Company, 10 s Admin). Company actions (approve, take over, configure) appear in Admin run detail and audit; Admin actions (retry, reconcile, pause autonomy, provider change) appear in Company activity and attention. Tested in §13.2 row "Company/Admin sync".

---

## 9. Settings Improvements

### 9.1 Settings catalog

| Setting | Scope | Editable by (permission) | Validation | Storage | Secret? | Audit | Task |
|---|---|---|---|---|---|---|---|
| Company name, industry | company | `settings:manage` | 1–128 chars; industry from list | `tenant_profiles` | no | yes | T2.3 |
| Locale, timezone, currency | company | `settings:manage` | BCP-47 regex; IANA tz exists; ISO-4217 | `tenant_profiles` | no | yes | T2.3 |
| Brand profile (voice, prohibited claims link, logo URL) | company | `settings:manage` | JSON schema; https URLs | `tenant_profiles.brand_profile` | no | yes | T2.3 |
| Require distinct approver | company | `settings:manage` | boolean | `tenant_governance_settings` | no | yes | T2.4 |
| Approval expiry hours | company | `settings:manage` | 1–720 | same | no | yes | T2.4 |
| Takeover lease seconds | company | `settings:manage` | 30–600 | same | no | yes | T2.4 |
| LLM: inherit platform / own provider | company | `llm:manage` | enum | `tenant_llm_configs` | — | yes | T2.5 |
| LLM base URL, models, timeout, monthly token budget | company | `llm:manage` | https + host allowlist, no private ranges; model regex; 1–120 s; > 0 | `tenant_llm_configs` | no | yes | T2.5 |
| LLM API key | company | `llm:manage` | non-empty, ≤ 512 | `tenant_secrets` | **yes, write-only** | yes (fingerprint only) | T2.2, T2.5 |
| Connector config (per catalog schema) | company | `integration:manage` | catalog JSON schema | `connector_configurations.config` | no | yes | T2.6 |
| Connector credentials | company | `integration:manage` | per auth scheme | `tenant_secrets` | **yes** | yes | T2.6 |
| Domain activation (Marketing/Sales/Care) | company | `agents:manage` | prerequisites | capabilities + agents | no | yes | T2.7 |
| Skill enable/config/assignment | company | `skills:manage` | `config_schema`; assignment ⊆ allowed_agents | `tenant_skill_settings`, `tenant_skill_agents` | no | yes | T4.4 |
| Owner inputs (floor policy, frequency cap, segment cap, Sales→Care itinerary …) | company | `settings:manage` | per input schema | `unresolved_owner_inputs` (RESOLVED + value ref) | no | yes | T2.1 + T6.11 |
| Test data enabled | company | platform `platform:companies:write` | boolean; never for PRODUCTION-only policy | tenant settings | no | yes | T7.2 |
| Users and roles | company | `settings:manage` | bundle enum | `tenant_memberships` | no | yes | T9.3 |
| Platform default LLM provider | platform | `platform:providers:write` | as above | `platform_llm_providers` + `platform_secrets` | key yes | yes | T2.5 |
| Company status (suspend/resume), data class | platform | `platform:companies:write` | enum; data class immutable after creation | `tenants` | no | yes | T8.2 |
| Feature flags | platform | read-only in UI (env) | — | env | no | — | T8.9 |

### 9.2 Save/update flow (all settings)

1. Form loads with `version` (ETag).
2. Client validation mirrors server schema (shared JSON schema from OpenAPI).
3. Save → `PUT` with `If-Match: <version>`; server validates, checks permission, writes row + audit event in one transaction, bumps version.
4. Success → toast "Đã lưu", form resets dirty state; runtime caches invalidate by version (≤ 30 s).
5. `409 VERSION_CONFLICT` → dialog "Cài đặt vừa được người khác thay đổi" with reload/compare.
6. `400` → field errors inline; `403` → read-only mode with "Bạn cần quyền …".
7. Secrets: separate "Đặt khóa mới" action; response shows fingerprint + "đã lưu lúc"; "Xóa khóa" revokes; plaintext never returned or logged.
8. History drawer lists audit events (who, when, what changed, reason).

---

## 10. Skills Management & Integration

### 10.1 Model (decision from core audit)

- **Contract (code, immutable):** `skill_id`, `effect_class`, `required_authority`, `allowed_agents` (ceiling), `tool_binding`, input/output schemas, retry/timeout bounds, `audit_spec`, test cases, `execute`/`reconcile`, plus new `display_key`, `domain`, `config_schema`, `autonomy_class`, `receipt_ref`, `completion`, `connector_kinds` (T4.1).
- **Binding (data, per company, can only narrow):** enabled flag, config values, connector binding + credentials, agent assignment ⊆ allowed agents, autonomy promotion state, tighter limits (T4.2).
- **Availability (computed per dispatch):** AND of all gates → `{available, reason}` (T4.3).

### 10.2 Lifecycle trace

```text
created (code PR: row + tests + assertRegistrable)
  → registered (boot: catalog sync, contract_digest pinned)            T4.2
  → configured (company: enable, config, connector, credentials)       T4.4, T2.6
  → assigned (agents ⊆ allowed_agents, DB trigger)                     T4.2
  → available? (SkillGate: tenant setting ∧ entitlement ∧ connector ∧ agent active ∧ autonomy ∧ breaker ∧ owner inputs)  T4.3
  → planned (agent runtime uses only available skills; otherwise typed refusal naming the reason)  T4.3, T1.4
  → authorized (PEP: authority, consent, price, identity, AUTH-4 pause)  existing
  → invoked (effect reservation → engine dispatch with deadline)       existing + T1.5
  → executed (tool port → adapter with tenant binding)                 T2.6
  → result (receipt with receipt_ref → evidence → stage result → response)  T1.1, T5.1
  → observed (health: success rate, latency, last error; breaker state)  T4.4
```

### 10.3 Adding a new skill

- **Code plugin (required for EFFECT/APPROVAL/INTERNAL):** add row under `packages/skills/src/platform/<domain>/`, implement tool port handler + `reconcile`, register in the manifest, contract tests (5 baseline cases), PR review. Catalog sync makes it visible; companies enable it.
- **Declarative HTTP tool (later, READ-only, platform-published):** only after T4.x; requires SSRF-safe executor, host allowlist per connector, response schema validation, AUTH ≤ AUTH-1, epistemic class SIGNAL unless marked source-of-record by a platform admin. Never for effects.

### 10.4 Skills UI

- Company (AI Team → domain → **Kỹ năng**): table — Kỹ năng (display name), Mô tả, Trạng thái (Sẵn sàng / Tắt / Thiếu kết nối / Chờ phê duyệt nâng quyền / Tạm dừng / Lỗi — from availability reason), Mức tự động (plain words: "Luôn cần người duyệt" for AUTH-4, "Tự động" for promoted reads, "Bản nháp chờ duyệt" for draft-gated), Tác nhân dùng, Sức khỏe (24 h success %, p95), actions: Bật/Tắt, Cấu hình (drawer from `config_schema`), Chạy thử, Chi tiết. AUTH-4/never-promotable skills show a lock with explanation.
- Chạy thử: READ → input form from schema (prefilled with TEST customer), output summary + evidence; EFFECT/APPROVAL → "Kiểm tra kết nối và dữ liệu đầu vào (không thực hiện hành động thật)".
- Platform (Cài đặt → Danh mục kỹ năng): catalog with contract version, domains, authority, per-company entitlement toggle, fleet health.

### 10.5 Invariants (tests in T4.x)

Contract fields immutable via API (digest pin) · effective enablement is an AND and never widens · assignments ⊆ allowed agents (write + dispatch) · never-promotable and AUTH-4 reject promotion (API + DB) · AUTH-5 unregistrable and denied · AUTH-4 always pauses, digest-bound · config validated; secrets never returned/logged · RLS on all new tables · every change audited + versioned · kill switch/pause precedence · gate outage fails closed · PEP registry equals rows.

---

## 11. Agent Trace UX Improvements

### 11.1 Company view — "Chi tiết thực thi" (friendly run story, T5.4)

```text
Trợ lý Bán hàng · Tư vấn laptop cho Nguyễn Văn A          Hoàn tất · 4,2 giây
────────────────────────────────────────────────────────────────────────────
✓ Hiểu yêu cầu            "Laptop dưới 20 triệu cho thiết kế đồ họa"        0,6 s
✓ Tìm sản phẩm phù hợp     5 sản phẩm trong danh mục                          0,4 s
✓ Kiểm tra tồn kho         Nova Studio 14 còn 12 máy                          0,3 s
✓ Kiểm tra giá             18.900.000 ₫ (giá chính thức từ ERP)               0,3 s
✓ Gợi ý sản phẩm           Nova Studio 14 Creator                             0,2 s
✓ Trả lời khách            "Bạn có thể tham khảo Nova Studio 14 …"
[Vì sao gợi ý này?]  [Xem hội thoại]
```

- Shows: what the agent did (skill display names), status per step, safe input/output summaries (allowlisted fields, PII masked), duration, retries ("Thử lại 1 lần do dịch vụ AI bận"), waiting states ("Chờ bạn phê duyệt"), failure in plain words + next action ("Kết nối ERP không phản hồi. Kiểm tra kết nối →"), final result.
- Hides: run_id, correlation_id, effect_key, stage names, authority codes (available under "Chi tiết kỹ thuật" collapsed, `run:read`).

### 11.2 Admin view — diagnostic trace (T5.4, T8.3)

- Header: run id, company, domain, agent(s), state (business + raw), correlation id (copy), attempts, lease owner/expiry, duration, cost, tokens.
- 11-stage timeline (SIGNAL → LEARNING) with per-stage status, start/end, duration, detail (§11.3), evidence refs.
- Steps table: agent, skill, tool binding, authority, autonomy decision, effect key + reservation status, receipt reference, error code/class/admin hint.
- Provider calls: model, latency, tokens, outcome, error class (no prompts/bodies).
- Approval/handoff links; audit entries; retry/reconcile actions (server eligibility).
- Raw JSON only via "Tải chi tiết (đã ẩn dữ liệu nhạy cảm)".

### 11.3 Stage detail contract (T5.1)

| Stage | detail fields |
|---|---|
| SIGNAL | event_type, channel, domain |
| CONTEXT | customer_verified (bool), takeover_active, data_class |
| HYPOTHESIS | intent, confidence, provider call index |
| DECISION | target_agent, routing reason key |
| PLAN | steps `[{agent, skill, authority, mutating}]` |
| ACTION / APPROVAL / EXECUTION / EVIDENCE | agent, skill, verdict, approval_id, attempts, evidence_id |
| OUTCOME / LEARNING | outcome kind (ANSWER/CLARIFICATION/REFUSAL/NO_ANSWER/HANDOFF_ACK/AWAITING_APPROVAL), outcome watch id |

---

## 12. Core System Improvements

### 12.1 Architecture changes (why · affected · dependencies · migration risk)

| Change | Why | Affected files/modules | Depends on | Migration risk and mitigation |
|---|---|---|---|---|
| **DB-backed configuration with per-tenant resolvers** (LLM, connectors, knowledge, skills, domains) replacing env singletons | env singletons make multi-company operation and self-service impossible; two truths in UI | `apps/worker/src/runtime/connectors.ts`, `worker-bindings.ts`, `worker.ts`, `{sales,care,marketing}/factory.ts` (move construction into per-tenant closures), `apps/api/src/runtime/composition.ts`, `bindings/turn-intent.ts`, new `packages/core-engine/src/{llm,secrets}/*`, `packages/adapters/src/catalog.ts` | T2.1, T2.2 | High: behaviour change at boot. Mitigate with env import as `source='ENV'` defaults, feature flag `CONFIG_SOURCE=db|env` for one release, stack tests for both |
| **Typed terminal responses** (ANSWER/CLARIFICATION/REFUSAL/NO_ANSWER/HANDOFF_ACK) | every run must end visibly | `revenue-orchestrator.ts`, `shared/response.ts`, `run-responses.ts`, migration | T1.1 | Medium: finalizer contract change; replay/idempotency tests on `run_responses` |
| **Single error catalog + skill error mapping** | correct retries, readable causes | `effect-reconciliation.ts`, `checkpoint-guards.ts`, `skill-dispatcher.ts`, new `errors/catalog.ts` | — | Low–medium: retry behaviour changes; covered by stack chaos tests |
| **Skill attributes derived from rows; SkillGate** | remove drift; data-configurable skills | `packages/skills/*`, worker policy engines, planners, engine | T4.1 | Medium: PEP registry changes; contract test "registry == rows" before deleting hand tables |
| **Platform control plane via SECURITY DEFINER projections + dedicated login role** | cross-company ops without breaking RLS; close `agentos_app → agentos_platform` escalation | migrations, `platform-directory.ts`, new platform routes, API pools | T2.1 | Medium: role/grant changes; RLS rehearsal asserts `agentos_app` cannot call platform functions |
| **Durable identity (users/memberships/sessions)** | production auth; user monitoring | new migrations, `apps/api/src/routes/v1/auth.ts`, `principal.ts`, consoles `lib/auth/*` | T2.1 | Medium: session model change; keep demo provider for DEMO tenants; dual-provider period |
| **Data class (PRODUCTION/DEMO/TEST)** | truthful labels; safe test reset | migrations (tenants + customer tree), triggers, seed, projections | T2.1 | Medium: new NOT NULL columns with defaults; backfill DEMO for demo tenant; immutable-table triggers get a narrow reset escape only for `agentos_test_reset` |
| **Stage results + PII-safe audit** | usable trace; privacy | core recorder, migrations, `revenue-orchestrator.ts` | T1.5 | Low: append-only additions |
| **One BFF route table** (method, pattern, permission, CSRF) in both consoles | allowlist drift (tenant `GET conversations/:id`, `telemetry/kpi` point to missing routes; platform `runs` 404) | `apps/tenant-console/src/lib/bff-allowlist.ts`, `apps/platform-admin/src/lib/auth/demo-provider.ts` | T10.5 | Low: generated from OpenAPI; test every entry resolves to a real route |

### 12.2 Hardening items (outside the phase tasks above; include in the phase touching the file)

| Item | Evidence | Fix | Phase |
|---|---|---|---|
| `X-Tenant-ID` accepted as a credential when no Authorization header | `apps/api/src/gateway/principal.ts:249` | remove; only signed provider deliveries via dedicated principal | 2 |
| `/admin/*` and `/demo/readiness` lack platform scope check | `autonomy-admin.ts`, `provisioning.ts:139` vs `platform.ts:49-55` | enforce `scope==='platform'` | 1 |
| Unvalidated `Number(limit)` | `campaigns.ts:281`, `approvals.ts:86`, `operations.ts:181` | Fastify schemas 1–200 | 1 |
| Per-process rate limiter, unbounded buckets | `care-turn.ts:128` | Redis-backed limiter with TTL | 2 |
| PEP approvals port fabricates `appr_<8>` | `apps/worker/src/runtime/shared/policy-engine.ts:102-106` | record the real approval id | 1 |
| `recordFailure` in catch can mask original error | `revenue-orchestrator.ts:781-786` | preserve original, log both | 1 |
| Autonomy RMW unversioned; budget TOCTOU | `autonomy/service.ts:104-125`, `llm-usage.ts:98-115` | CAS versions; atomic reserve | 4, 5 |
| `MAX_TOKENS_PER_RUN` double meaning | `composition.ts:274`, `turn-intent.ts:167` | split per-call cap and per-run budget | 5 |
| Pool without statement/idle timeouts | `packages/database/src/client.ts:28` | set `statement_timeout`, `idle_in_transaction_session_timeout` | 2 |
| Legacy immutable tables still grant UPDATE/DELETE to app | `0002:107` | revoke (trigger stays) | 5 |
| Seed re-run resets operator changes | `scripts/demo/seed.mjs:189-192,232-242` | insert-only agents; promote only on first create | 4 |
| Takeover Redis lease + DB state non-atomic | `conversations-takeover.ts:84-110` | CAS `setState` on `(state, takeover_operator_id)` + sweeper | 1 |
| Anonymous conversation never attached to later-verified customer | `conversations.ts bindOrCreate` | conditional customer attach | 1 |
| Breaker process-local, HALF_OPEN probe leak | `packages/skills/src/runtime/{attempt,circuit-breaker}.ts` | tenant-keyed, `finally` release, TTL | 4 |
| CSP `unsafe-inline`, `connect-src` includes API origin | `apps/tenant-console/next.config.mjs:15-16` | nonce CSP; BFF-only connect-src | 6 |

### 12.3 Migration index (numbers assigned in landing order; adjust if another migration lands first)

| No. | Purpose | Task |
|---|---|---|
| 0023 | `run_responses.response_kind`, outcome columns | T1.4 |
| 0024 | state enums widening, `data_class` on tenants, `apply_tenant_rls()` helper, provisioning functions v3 | T2.1 |
| 0025 | `tenant_secrets`, `platform_secrets` | T2.2 |
| 0026 | `tenant_profiles`, governance column grants | T2.3, T2.4 |
| 0027 | `platform_llm_providers`, `tenant_llm_configs`, `llm_probe_results` | T2.5 |
| 0028 | connector binding columns, `connector_probe_results` | T2.6 |
| 0029 | `platform_audit_events` + writer + tenant view | T2.10 |
| 0030 | agent activation columns + events | T2.7 |
| 0031 | `platform_active_tenants()` | T2.8 |
| 0032 | knowledge tables + transition trigger | T3.1 |
| 0033 | `skill_catalog`, `tenant_skill_settings`, `tenant_skill_agents`, `skill_test_results`; deprecate `skills` | T4.2 |
| 0034 | autonomy policy version CAS + events | T4.5 |
| 0035 | `run_stage_results`, generated `platform_durable_tasks.domain`, revoke legacy UPDATE/DELETE | T5.1, T5.2 |
| 0036 | `data_class` on customer tree, `agentos_test_reset`, `reset_test_data()` | T7.1 |
| 0037 | platform run projections, dedicated platform login role | T8.1 |
| 0038 | `worker_heartbeats` | T8.6 |
| 0039 | users, memberships, sessions, invitations, `agentos_auth` role | T9.1, T9.3 |

Rules for every migration: ENABLE + FORCE RLS on new tenant tables (`apply_tenant_rls`), explicit grants without DELETE unless required, `REVOKE ALL … FROM PUBLIC` on new functions, SECURITY DEFINER with `SET search_path = pg_catalog, agentos, pg_temp`, owner asserted BYPASSRLS/superuser, rehearsal assertions updated (`packages/database/scripts/rehearse-migrations.mjs`).

---

## 13. Testing Plan

Principle: a test proves a **flow is connected** only when it runs through the real API, worker, PostgreSQL as `agentos_app`, and the real adapters (mock ERP / LLM stub offline, real providers live) and asserts the **outcome the user sees** — not that a request was accepted.

### 13.1 Test layers

| Layer | Tooling | Runs where | Purpose |
|---|---|---|---|
| Unit | vitest (existing) | CI every push | pure logic, mappers, vocabulary, validators |
| Repository | vitest + disposable Postgres, **as `agentos_app`** | CI | SQL, RLS, grants, triggers (catches R1-class bugs) |
| Contract | OpenAPI emit + diff; vocabulary coverage; BFF route table ↔ API routes | CI | UI/API drift (R8) |
| Stack E2E (offline) | `tests/stack` node:test + LLM stub + mock ERP | CI every push (≈10 min) | connected flows, failures, recovery |
| UI E2E (stack) | Playwright against the offline stack; axe | CI every push | user journeys and accessibility |
| Chaos | `tests/stack/chaos` | CI nightly | crash/connector/provider failures |
| Live | `tests/live` with the user's real `.env` | manual (developer machine) or `live-e2e.yml` manual dispatch | real providers and credentials |

### 13.2 Scenario matrix (each row is at least one stack test; UI rows also Playwright)

| Category | Scenario | Assertions |
|---|---|---|
| Happy path | Sales: anonymous "laptop dưới 20 triệu cho thiết kế đồ họa" | task `completed`; agent message; price equals mock ERP `list_price`; evidence ≥ 1; run story steps search→stock→price→recommend |
| Happy path | Sales SKU: "NM-L01-BLK còn hàng không, giá bao nhiêu?" | grounded stock + price answer |
| Happy path | Care FAQ (return policy) | answer cites knowledge `source_version` = document sha256 |
| Happy path | Care order lookup as verified TEST customer | own order status (PAID → "Đang xử lý", never "Đã giao") |
| Happy path | Escalation → takeover → operator reply → widget receives → resume | handoff ENQUEUED→ASSIGNED→COMPLETED; ownership states; audit rows |
| Happy path | Campaign draft (LLM stub) → approval → approve → revalidation → "Chưa tích hợp kênh gửi" | lifecycle states; approval digest matches; no fake delivery |
| Happy path | Order: purchase intent → AUTH-4 approval → create_order on mock ERP → receipt → evidence | exactly one ERP order; stock decremented |
| Happy path | Onboarding: Platform creates company → Company Admin configures profile, ERP, LLM, knowledge → activates Sales → turn completes | no env edits; worker picks tenant within 30 s |
| Invalid input | empty/oversized message, bad module, invalid segment, invalid settings values | typed 4xx; Vietnamese message; no task created |
| Auth failure | wrong password; locked account; expired session (`reason=expired`); missing CSRF; operator token on `/storefront`; foreign `X-Tenant-ID`; company session on `/platform/*` | 401/403 codes; redirects; no data leak |
| Authorization | company admin without `knowledge:approve` cannot approve; platform admin cannot read customer PII via platform routes | 403; column assertions |
| Integration failure | ERP down / failure_rate=1 | Sales answers "chưa lấy được giá chính thức"; ERP probe "Lỗi"; recovers after restore |
| Agent/skill failure | `check_price` disabled; `P_FLOOR_UNAVAILABLE`; LLM invalid JSON | typed refusal reply; failure reason visible in Company run story and Admin |
| Timeout | LLM delay > timeout; ERP latency > timeout | PROVIDER_TIMEOUT / INDETERMINATE fail-closed; no invented output |
| Retry | LLM 429 then 200 | attempts=2 recorded; answer produced |
| Retry | Admin retries a RETRYABLE failed run | re-queued with same effect key; completes; audit row |
| UNKNOWN | ERP swallow-after-write on create_order | run `waiting` "Cần đối soát"; sweeper reconciles; exactly one order; never blind retry |
| Duplicate | same idempotency key twice; changed body same key; double-click send; double approve; concurrent takeover | same task; 409; one run; one effect; one lease |
| Empty state | fresh company (no customers, no runs, no knowledge) | business empty states with CTA; copy lint (no UUID, UPPER_SNAKE, "Chưa phân loại", English error envelopes) |
| Refresh/recovery | reload mid-run; kill worker mid-run; restart API | transcript restored from server; run completes once; session survives (DB sessions) |
| Company/Admin sync | Company approves → Admin run detail shows APPROVAL decided; Admin retries → Company activity updates; provider change → Company AI status reflects within 30 s | both consoles agree within one polling interval |
| Isolation | Customer B asks for Customer A's order; company A admin requests company B run id | DENY without leaking identity, items, amount, status, address; TASK_NOT_FOUND |
| Test lab | create TEST customer with seeds → Customer360 → storefront as customer → reset | TEST rows gone; DEMO/PRODUCTION rows and config untouched |

### 13.3 Live tests with the real `.env` (never expose or commit secrets)

- **Where:** the developer machine that holds `.env` (this repository never contains it), or GitHub `live-e2e.yml` with manual dispatch + protected environment secrets. To run inside a cloud session, secrets must be added as environment secrets, not files.
- **Isolation:** dedicated database name (e.g. `agentos_live_test`) and ports; `DEMO_MODE=true`, `APP_ENV=local`, demo or TEST tenant only; never production `DATABASE_URL`.
- **Loading:** `node --env-file=.env` / `docker compose --env-file .env`; never pass secrets through argv; `scripts/live/preflight.mjs` checks presence (not values) and refuses placeholders.
- **Budget:** dedicated low-limit LLM key; `LIVE_MAX_LLM_CALLS` enforced by the harness; synthetic data only; LLM host allowlist.
- **Artifacts:** Playwright `trace: 'off'`, no video/HAR; authenticate via API `storageState` file (mode 0600, gitignored); `scripts/live/scan-artifacts.mjs` scans `test-results/live/**` and logs for every secret value from `.env` and fails on any hit; reuse `redactSecrets` from `scripts/demo/up.mjs:155-187`.
- **Git hygiene:** `.gitignore` covers `.env.*` except `.env.example`; gitleaks in CI.
- **CI workflow:** `workflow_dispatch` only, protected environment, read-only permissions, secrets injected into one step, `.env` written to `$RUNNER_TEMP` with `umask 077` and deleted in `always()`, `::add-mask::` for every value, never on forks.
- **Commands:** `pnpm live:up` · `pnpm live:preflight` · `pnpm test:live` (API + UI) · `pnpm live:scan` · `pnpm live:reset`.
- **Scope:** every §13.2 happy path with the real LLM and the configured ERP/channels; timeouts and retries observed against the real provider; cost recorded in Usage.

### 13.4 Gates

| Gate | Commands |
|---|---|
| Per-task | `pnpm lint && pnpm typecheck && pnpm test:unit` + the package's repository/contract tests + the stack tests touched by the task |
| Phase | `python testcases/_generate.py --check` · `pnpm lint` · `pnpm typecheck` · `NODE_ENV=production pnpm build` · `pnpm test:unit` · `pnpm test:contracts` · `pnpm test:security` · `pnpm test:adversarial` · `pnpm test:pilots` · `pnpm test:e2e` · DB rehearsal (`pnpm db:migrate:rehearse`, `test:rls-rehearsal`, `test:rls-policies`, `test:p5-db`, `test:integration`) · `pnpm test:stack` · Playwright stack · `pnpm check:demo-boundary` · `node --test scripts/**/*.test.mjs` · `pnpm docker:smoke` |
| Release | Phase gate + chaos suite + live suite on the developer machine with a redacted report |

---

## 14. Technical Debt / Cleanup

### 14.1 Dead or misleading code (T11.1, T6.13, T8.10)

- API: `apps/api/src/gateway/idempotency.ts`, `routes/v1/chat.ts`, `routes/v1/webhooks.ts` (empty), stub `StreamPort`/`KpiPort` (`runtime/composition.ts:435,446`) once analytics exists, empty `src/middleware/`.
- Worker: marketing `evidence-adapter.ts` production exports, `createMarketingResearchPort`, `sales/offline-harness.ts` in production barrel, `lexiconByRun` and marketing `signals` maps.
- Core: `ProvisioningService`/`MemoryProvisioningStore`, unused `cost/*` pieces not wired by T5.3, `load/harness.ts` (keep only for load smoke), `task-fsm.ts` if unused, no-op `assertOrchestratorBrokered`, `defaultedString`, unused `zod`, empty skills domain dirs, unused package deps (`packages/skills` → adapters/database).
- Database: `skills` table (deprecated by T4.2), `invoices`, `leads`, `opportunities`, `offers`, `workflows`, `decisions`, `executions`, `learnings` — decide per table: keep for roadmap with a comment in `docs/architecture` or drop in a later migration (never silently).
- Tenant console: `components/executive/*`, `components/conversation/{TakeoverControls,MessageStream,CopilotComposer,EvaluationUnavailableModal,types}.ts(x)`, `lib/sse.ts`, `postStorefrontStream`/`postStorefrontEvent`, legacy approvals components (replaced by T6.8).
- Platform console: `TenantWorkspace.tsx`, `RequirePermission.tsx`, `src/server.mjs`, NEXTAUTH env leftovers.
- UI foundation: legacy `status.ts`, ten dead types, `apiFetch` in `packages/api-contract`.
- Storefront widget: fix (session id, markers, retry policy) or mark as external-embed only with tests (SW-01..SW-05).

### 14.2 Duplicates to consolidate (T11.2, T4.1)

- Canonical JSON: `packages/database/src/repositories/canonical-json.ts`, `packages/core-engine/src/durability/canonical-json.ts`, `packages/core-engine/src/effects/canonical-json.ts`, `packages/skills/src/schema/canonical.ts`, `durable-workflows.guards.ts` `canonicalizeEvent` → one implementation.
- Effect key: `effects/effect-key.ts` vs `EffectGuard.computeEffectKey`.
- Port declarations: `IEffectGuard`, `IEvidenceLogger`, `IAuditTrail` in `contracts/types.ts` and `ports.ts`.
- Skill attribute tables (PEP registries, allowlists, `deriveEffectPolicy`) → derived (T4.1).
- DTO types in consoles (66 hand-typed) → generated from OpenAPI (T10.5).
- Shells, dialogs, tables duplicated across consoles → ui-foundation (T6.1).
- Usage ledgers (`token_cost_records` vs `provider_call_ledger`) → one recorder writes both (T5.3).

### 14.3 Known debt from workflow §30

- Sales turn classifier electronics lexicon and currency heuristics (T11.3).
- Revenue evidence `MODEL_ID='novamart-demo-orders-v1'` (T1.14).

### 14.4 Documentation drift (T11.4)

`README.md` layout and UI contract section; `docs/demo/README.md` "verified" claims and one-message-per-run statement; `docs/operations/README.md` command list; `blocked.md` stale paths (`scripts/p4-cross-domain-smoke.mjs` → `tests/integration/…`), stale counts, superseded floor/knowledge statements; FAQ corpus internals (T11.5).

---

## 15. Final Acceptance Checklist

Tick only with evidence (test name, CI run, or screenshot in the PR description).

**Connected workflows**
- [ ] Every row of §6 is ✅ (or the documented ⚠️ for the open Sales→Care decision).
- [ ] No conversational run ends without a customer-visible message (stack suite).
- [ ] Sales recommendation, SKU stock/price, Care FAQ, Care order lookup, escalation → takeover → resume, campaign → approval, order → approval → ERP all pass on the offline stack and live.
- [ ] A newly created company can be configured and activated without editing env or restarting services.

**Company UI**
- [ ] No raw UUID, UPPER_SNAKE code, English API message or "Chưa phân loại" visible outside "Chi tiết kỹ thuật" (copy lint on every route).
- [ ] Single Settings entry; workspace shows company name and correct environment.
- [ ] Every page has skeleton loading, per-section error with retry, positive empty state.
- [ ] axe: no serious/critical violations on any route; keyboard-only journeys pass; mobile/tablet layouts verified.

**Admin UI**
- [ ] Overview, Companies, Operations, Usage, Providers, System Health, Audit show real data across companies.
- [ ] Failure reason visible for every failed run; retry/reconcile follow server eligibility; UNKNOWN never blind-retried.
- [ ] Provider and connector changes testable from the UI and reflected in both consoles.

**Settings**
- [ ] Every row of §9.1 editable by the right permission, validated, persisted, versioned, audited; secrets write-only.

**Skills**
- [ ] Skills listed with availability reasons; enable/disable/config/assign/test/health work; changes affect the next run; governance invariants §10.5 tested.

**Trace**
- [ ] Company run story and Admin diagnostic trace available for every run; no PII in audit rows.

**Core**
- [ ] Error catalog in use; LLM bounded retry; usage recorded for every LLM call; reconciliation sweeper active; heartbeat stable; per-run state in checkpoints.
- [ ] Identity: DB users/memberships/sessions in non-demo environments; demo auth restricted to DEMO tenants in local/CI.

**Testing and CI**
- [ ] §13.2 matrix implemented; CI runs unit, repository-as-app-role, contract, stack, Playwright stack, chaos (nightly), secret scan.
- [ ] Live suite executed on the developer machine with the real `.env`; artifact scan clean; report attached (redacted).
- [ ] Reintroducing R1 in a scratch branch turns CI red.

**Security invariants (workflow §26)**
- [ ] RLS rehearsal green including new tables and platform role boundaries; no invariant in §0 loosened (commit trailers reviewed).

---

## Appendix A — Evidence index

| Topic | Primary evidence |
|---|---|
| R1 run_responses | `packages/database/src/repositories/run-responses.ts:72-77`; `packages/database/migrations/0019_append_only_idempotent_costs.sql:6`; reproduced on the offline stack (task failed `permission denied for table run_responses`; completed after a local-only GRANT) |
| R2 platform usage | `apps/api/src/routes/v1/platform.ts:27-31,55-62`; reproduced (400 through API and BFF) |
| R3 escalation | `apps/worker/src/runtime/care/skills/handoff-handler.ts:50`; `packages/database/src/repositories/care-handoffs.ts:371-382`; reproduced (fingerprints differ) |
| R4 clarification/empty plan/FAQ miss | `packages/core-engine/src/orchestrator/revenue-orchestrator.ts:1911-1915,2285-2338`; `apps/worker/src/runtime/shared/response.ts:230-235`; reproduced (`RESPONSE_SENDER_UNBOUND`) |
| R5 Try assistant | `apps/tenant-console/src/app/api/v1/[...path]/route.ts:27-35,51-62,126`; `apps/api/src/routes/v1/storefront.ts:125-134`; `apps/tenant-console/src/app/(app)/ai-team/sales/try/page.tsx:16-32` |
| R6 campaign | `apps/worker/src/runtime/marketing/factory.ts:270`; reproduced (`MARKETING_CAMPAIGN_INVALID`) |
| R7 schema shell | `packages/database/migrations/0006_p5_controlled_autonomy.sql:8,18,24,31,94`; `apps/api/src/projections/ai-team.ts:57-88` |
| R8 contract drift | `apps/tenant-console/src/components/customer/CustomerList.tsx:15`; `ConversationWorkspace.tsx:45-59,168-172`; `packages/ui-foundation/src/status-view.ts:26-53` |
| R9 tests | `scripts/demo/smoke.mjs:89-99`; `tests/ui/global-setup.ts:114-220`; `apps/api/src/gateway/http.ts:236-239` |

## Appendix B — Related planning documents

This file replaces the previous short index in `PLAN.md`. The existing planning set remains valid as product background:

1. [Đề bài SRS v0.1](De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md) — requirements source of truth.
2. [plans/README.md](plans/README.md) — detailed product plans; [plans/plan-easy-read-flow.md](plans/plan-easy-read-flow.md); [plans/glossary.md](plans/glossary.md).
3. [docs/product](docs/product/README.md), [docs/architecture](docs/architecture/README.md), [docs/specifications](docs/specifications/README.md), [docs/operations](docs/operations/README.md), [docs/decisions](docs/decisions/README.md), [docs/reference](docs/reference/README.md).
4. [docs/product/workflow.md](docs/product/workflow.md) (AgentOS 360 — End-to-End Workflow) — main reference for this plan.
