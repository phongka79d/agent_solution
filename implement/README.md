# AI Revenue & Engagement Platform — Implementation Blueprint
> **BLUEPRINT STATUS — pack contract; NOT IMPLEMENTED, DEPLOYED, MEASURED, or runtime evidence.**
> This index governs the ten target documents below; it records ownership, conflicts, and verification rules rather than an existing product.

## 1. Executive Technical Overview

The AI Revenue & Engagement Platform (AgentOS Customer360) is a target multi-tenant orchestration platform for Marketing, Sales, and Customer Care. SRS §15 / API-003 names Facebook, TikTok, Zalo, Email, SMS, and Web/App Chat; LINE, WhatsApp, payment providers, and vertical adapters are `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-001]`, not baseline channel replacements.

**This is documentation only.** Every code, SQL, YAML, JSON, TypeScript, OpenAPI, schema, and pipeline block is a **target snippet** `[BLUEPRINT][NOT-RUNTIME-EVIDENCE]`, not an existing file or measured result. Non-SRS numeric performance, size, cost, or KPI targets are `[PROVISIONAL][ASM-002]`; provider choices are `[UNCONFIRMED][ASM-001]`, pricing/promotion limits ASM-003, refund/compensation limits ASM-004, and long-term data/retention choices ASM-005. SRS security, evidence, consent, and idempotency invariants are mandatory and are not made provisional by this notice.

The platform design bridges probabilistic Large Language Models (LLMs) with deterministic enterprise systems of record (SoR) through a strict 11-step end-to-end orchestration lifecycle (`SIGNAL` -> `CONTEXT` -> `HYPOTHESIS` -> `DECISION` -> `PLAN` -> `ACTION` -> `APPROVAL` -> `EXECUTION` -> `EVIDENCE` -> `OUTCOME` -> `LEARNING`). That lifecycle is designed to deliver idempotent transactional integrity (`effect_key`, BR-005/BR-006), an owner-approved floor-price guardrail ($P_{floor}$) that rejects sub-floor quotes without ever replacing the ERP/POS/Web/App price of record, retrieval-grounded answers from the Second Brain RAG, and customer-context isolation (NFR-006) with tenant-level isolation as an additional layer. Whether these outcomes hold in operation is a design objective to be validated against measured data - not an achieved, measured, or certified result.

### Architectural Principles

1. **Two-Tier Separation**:
   - **Tier 1: Core Engine (Multi-Tenant Platform Core)**: Houses the central Revenue Orchestrator, Supervisor, State Machine, Authority Enforcement (AUTH-0..5), Business Rules Engine (BR-001..010), Customer 360 Event Fabric, and the Second Brain Knowledge Base.
   - **Tier 2: Plug-and-Play Adapters**: Decouples external communication channels - the SRS API-003 baseline set (Facebook, TikTok, Zalo, Email, SMS, Web/App Chat) plus extension channels such as LINE, WhatsApp, and Instagram, with the production connector list still gated by the ASM-001 audit - localized e-commerce gateways (Taiwan ECPay, CVS COD, Stripe), and enterprise ERP/OMS systems via authenticated connector interfaces.

2. **Zero Peer-to-Peer Agent Coupling**:
   - Agents (13 specialized agents across Marketing, Sales, and Support) never invoke each other directly.
   - All routing, handoffs, and state transitions are governed centrally by the Revenue Orchestrator and verified by the Policy Engine.

3. **Deterministic Authority & Fail-Closed Guardrails**:
   - Agent execution is strictly capped at `AUTH-0` through `AUTH-3`. `AUTH-4` is a routing verdict into the human approval gate and `AUTH-5` is a hard deny; neither is an assignable rank.
   - High-impact operations - bulk campaigns above the tenant's approved audience limit, financial commitments, pricing overrides - require human authorization through the `AUTH-4` route (Command Center Approval Queue SCR-003). The audience, discount, and refund/compensation thresholds that decide what counts as "high impact" are **tenant policy parameters owned by Business/Finance, not yet approved ([UNCONFIRMED][ASM-003/004])**; this blueprint fixes no platform-wide numeric threshold. An unset tenant parameter fails closed and routes to approval.
   - If pricing, inventory, identity, or consent cannot be conclusively verified from authoritative Systems of Record, the design fails closed (NFR-008) and transitions to safe human handoff (SCR-005).

4. **Customer Context Isolation + Multi-Tenant Isolation (NFR-006)**:
   - **Customer-level isolation (the baseline SRS §19 semantic)**: data belonging to verified customer A never appears in the context of customer B. Every context load, session memory, and prompt carries data for the single verified customer of the session only, and identity verification must complete before any profile or order lookup.
   - **Tenant-level isolation (an additional layer, not a replacement)**: mandatory `tenant_id` at every persistent layer - PostgreSQL Row-Level Security (RLS), isolated Redis key namespaces, and isolated Qdrant vector collections - so no runtime context crosses a tenant boundary either.

---

## 2. Complete Tech Stack Matrix

| Architecture Domain | Technology Component | Version / Specification | Rationale & Enterprise Responsibility |
|---|---|---|---|
| **Core Runtime** | Node.js / TypeScript | Node.js 20.x LTS, TypeScript 5.4+ | Core Engine orchestration, event loop efficiency, type-safe canonical contracts across workspaces. |
| **Optional auxiliary service** | Python / FastAPI | Candidate Python 3.12/Pydantic v2 `[OPTIONAL-EXTENSION]` | Only for a separately approved Python-specific need; not part of the Node core or a second owner of floor policy. See `01` §5. |
| **Workflow Engine** | Temporal.io / BullMQ | Temporal Server 1.23+ / BullMQ 5.x | Durable workflows, deterministic retry with exponential backoff, state checkpointing, and long-running human approval gates. |
| **Primary Database** | PostgreSQL | PostgreSQL 16 Enterprise | ACID compliance, System of Record integration, Row-Level Security (RLS) for tenant isolation, JSONB indexing. |
| **Vector Engine** | Qdrant & pgvector | Qdrant 1.9+ / pgvector 0.7+ | Multi-tenant HNSW dense vector indexing, payload metadata filtering for Second Brain 8-folder knowledge hierarchy. |
| **Cache & Distributed Lock** | Redis | Candidate Redis 7.2+ | Working memory and leased coordination; TTLs are provisional. Durable effect reservations in `03` survive cache expiry. |
| **Command Center UI** | Next.js | Target Next.js 14 / React 18, subject to compatibility verification before build | SCR-001..005; browser/server API access follows `02` and `06`, never direct customer-database access. |
| **UI Design System** | Tailwind CSS + shadcn/ui | Tailwind 3.4+, Radix UI primitives | Accessible, high-density, consistent administrative interface with zero bloated component overhead. |
| **Storefront Chat Widget** | Vanilla TypeScript | Web Component (Shadow DOM, < 20 KB) | Zero-dependency, ultra-lightweight client script embeddable on any e-commerce storefront without bundle pollution. |
| **Connectors & Gateways** | Node.js / Python Adapters | Axios / HTTPX with mTLS & HMAC-SHA256 | Bidirectional channel adapters (API-003 baseline: Facebook, TikTok, Zalo, Email, SMS, Web/App Chat; extension channels such as LINE, WhatsApp, Instagram), ERP API-001, Event API-002, Stripe, ECPay - provider selection pending the ASM-001 audit. |
| **Monorepo Build System** | Turborepo / pnpm | pnpm 9.x, Turborepo 1.13+ | Fast caching, strict workspace dependency graphs, atomic code sharing between packages and services. |
| **Observability** | OpenTelemetry & Prometheus | OTel SDK, Prometheus, Grafana | Real-time token tracking (NFR-010), end-to-end distributed tracing (`correlation_id`), and latency histograms. |

---

## 3. Implementation Blueprint Table of Contents

These 15 documents are the target implementation blueprint set for the platform, located in `implement/`. Every one of them is a **target blueprint/specification for a system that has not been built or deployed**; none reports implemented code, measured results, or production state.

| File | Document Title | Document Nature | Primary Scope & Contents |
|---|---|---|---|
| [**01-tech-stack-and-environment.md**](./01-tech-stack-and-environment.md) | **Tech Stack & Environment Setup** | Target blueprint/specification - not deployed | NFR-001..NFR-010 architectural justifications, target Docker Compose multi-container environment, comprehensive environment schema with Zod/Pydantic validation. |
| [**02-project-structure.md**](./02-project-structure.md) | **Project Structure & Monorepo** | Target blueprint/specification - not deployed | pnpm workspaces & Turborepo architecture, application and package boundaries, dependency graphs, and strict TypeScript/functional programming guidelines. |
| [**03-database-and-memory-schema.md**](./03-database-and-memory-schema.md) | **Database & Memory Schema** | Target blueprint/specification - not deployed | PostgreSQL DDL for all 28 canonical entities, Row-Level Security (RLS) enforcement, Redis session mutex and idempotency specs, Qdrant 8-folder vector schemas. |
| [**04-core-engine-and-orchestrator.md**](./04-core-engine-and-orchestrator.md) | **Core Engine & Revenue Orchestrator** | Target blueprint/specification - not deployed | Central execution loop, eleven-stage E2E lifecycle coordinator, multi-agent intent routing (FR-ORC-001/002), and durable workflow contracts. |
| [**05-skill-system-specifications.md**](./05-skill-system-specifications.md) | **Skill System & Runtime Specifications** | Target blueprint/specification - not deployed | Skill Engine Runtime, platform skill registry (eleven SRS-minimum contracts mapped to target storage fields), dynamic JSON schema validation, and tool execution wrappers. |
| [**06-api-and-connectors-spec.md**](./06-api-and-connectors-spec.md) | **Connectors & Plug-and-Play Adapters** | Target blueprint/specification - not deployed | API-001 (ERP/Commerce) & API-002 (Event Ingestion) contracts; API-003 communication connectors over the baseline channel set (Facebook, TikTok, Zalo, Email, SMS, Web/App Chat); Taiwan and global adapter extensions (ADPT-TW-001: LINE, ECPay, CVS COD; ADPT-GL-001..003: WhatsApp, Stripe, GDPR/CCPA) pending the ASM-001 audit. |
| [**07-human-command-center-ui.md**](./07-human-command-center-ui.md) | **Human Command Center UI & Storefront Widget** | Target blueprint/specification - not deployed | Next.js 14 Command Center implementation (SCR-001..005), SSE real-time streaming, and the standalone < 20 KB Vanilla TypeScript Web Component widget. |
| [**08-security-governance-nfr.md**](./08-security-governance-nfr.md) | **Security, Governance & NFR Engine** | Target blueprint/specification - not deployed | Policy Enforcement Point (PEP), Authority Model (AUTH-0..5), 10 Business Rules (BR-001..010), prompt injection defense, and audit evidence logging. |
| [**09-sprint-roadmap-and-pilots.md**](./09-sprint-roadmap-and-pilots.md) | **Sprint Roadmap, Pilots & CI/CD** | Target blueprint/specification - not deployed | 24-week engineering roadmap across 6 technical gates (P0 to P5), pilot acceptance test harnesses (TC-E2E-001..009), and CI/CD automation pipelines. |
| [**10-data-sovereignty-and-source-of-truth.md**](./10-data-sovereignty-and-source-of-truth.md) | **Data Sovereignty & Source-of-Truth** | Target blueprint/specification - not deployed | Canonical ownership model, SoR vs mirror vs derived data classification, provenance rules, customer and tenant isolation, fail-closed data access policy. |
| [**11-pricing-policy-engine.md**](./11-pricing-policy-engine.md) | **Pricing Policy Engine & Promotion Governance** | Target blueprint/specification - not deployed | Price floor evaluation, approval routing, promotion lifecycle, pricing rule engine separation from AI recommendation layer, auditability of pricing decisions. |
| [**12-identity-consent-lifecycle.md**](./12-identity-consent-lifecycle.md) | **Identity Verification, Consent Lifecycle & Access Boundaries** | Target blueprint/specification - not deployed | Verified identity rules, single-customer session confinement, channel-specific consent lifecycle, and fail-closed privacy protections. |
| [**13-approval-readiness-and-governance-gates.md**](./13-approval-readiness-and-governance-gates.md) | **Approval Readiness & Governance Gates** | Target blueprint/specification - not deployed | Governance gate model, approval queue design, human sign-off responsibilities, audit evidence, fail-safe and rollback requirements before operation. |
| [**14-incident-response-and-operational-runbook.md**](./14-incident-response-and-operational-runbook.md) | **Incident Response & Operational Runbook** | Target blueprint/specification - not deployed | Incident severity, containment modes, safe shutdown, rollback limits, operational roles, recovery evidence, and return-to-service gates. |
| [**15-mvp-v1-scope-and-release-strategy.md**](./15-mvp-v1-scope-and-release-strategy.md) | **MVP v1 Scope & Release Strategy** | Target blueprint/specification - not deployed | Bounded supervised MVP, explicit out-of-scope controls, staged release path, exit criteria, and expansion approval rules. |

---

## 4. Intended Build Sequence for Implementers

The sequence below is the build order the blueprint assumes for an eventual implementation. It is a plan, not a report of completed work: none of these steps has been executed, and no artifact referenced below is deployed.

```text
Step 1: Environment Provisioning (01-tech-stack-and-environment.md)
   ├── Launch Docker Compose infrastructure (Postgres 16, Redis 7.2, Qdrant, Mock ERP)
   └── Verify environment validation via Zod/Pydantic schema

Step 2: Workspace Setup (02-project-structure.md)
   ├── Initialize pnpm workspace with Turborepo
   └── Link packages (@agentos/database, @agentos/core-engine, @agentos/skills, @agentos/adapters)

Step 3: Data Governance Foundations (10-data-sovereignty-and-source-of-truth.md)
   ├── Define SoR, mirror, derived, and cache boundaries
   ├── Assign data ownership and provenance metadata
   └── Set customer/tenant fail-closed access rules before any runtime feature is built

Step 4: Database & Knowledge Ingestion (03-database-and-memory-schema.md)
   ├── Run PostgreSQL migrations for 28 canonical entities & activate RLS policies
   ├── Configure Redis memory policies and TTL constraints
   └── Initialize Qdrant vector collections for the 8 Second Brain namespaces

Step 5: Pricing Policy & Customer Consent Controls (11-pricing-policy-engine.md, 12-identity-consent-lifecycle.md)
   ├── Separate AI recommendation from pricing approval and execution
   ├── Enforce customer verification and channel-specific consent gating
   └── Route policy breaches to SCR-003 approval instead of silent execution

Step 6: Approval Readiness & Governance Gate Review (13-approval-readiness-and-governance-gates.md)
   ├── Confirm business owners, roles, and approval responsibilities
   ├── Validate policy, privacy, and technical safety gate criteria
   └── Require human sign-off before any material operational action is allowed

Step 7: MVP Scope & Incident Readiness Review (14-incident-response-and-operational-runbook.md, 15-mvp-v1-scope-and-release-strategy.md)
   ├── Freeze the supervised MVP boundary and explicit out-of-scope items
   ├── Define incident severity, containment, rollback, and return-to-service rules
   └── Approve offline contract validation before any sandbox or live connector work

Step 8: Core Engine, Policy, & Adapter Deployment (04, 05, 06)
   ├── Deploy Temporal workflows and Skill contracts
   ├── Configure authority limits and Price Floor inputs from the tenant's owner-approved ERP/SoR policy values ([UNCONFIRMED][ASM-003/004])
   └── Bind communication adapters (API-003 baseline channels plus ASM-001-gated extensions) and integration adapters (ERP API-001, Event API-002)

Step 9: Frontend & Observability Verification (07, 08, 09)
   ├── Launch Next.js Command Center and compile Storefront Widget
   ├── Execute automated test suites (TC-E2E-001..009 and TC-DATA-001..005)
   └── Validate OTel token metering and fail-closed circuits in staging
```

Each step's acceptance evidence must be produced by the implementing team when the work is actually done; this blueprint asserts none of it today.
## 5. Documentation Contract, Status Vocabulary, and Authority Order

This pack is a **target blueprint; NOT IMPLEMENTED, DEPLOYED, MEASURED, or runtime evidence**. The following labels are normative for every file in `implement/`:

| Label | Meaning and permitted use |
|---|---|
| `[SRS-MUST]` | Directly required by the SRS; cite the SRS section and ID in the same claim. |
| `[BLUEPRINT]` | Future target design proposed by this pack; it is not a runtime assertion. |
| `[PROVISIONAL][ASM-002]` (or applicable ASM) | Numeric or provider target awaiting the named owner baseline. |
| `[UNCONFIRMED][ASM-001..005]` | Assumption or owner decision not locked; the document MUST NOT choose silently. |
| `[OPTIONAL-EXTENSION]` | Beyond the SRS baseline and not required for the core contract. |
| `[OWNER-DECISION-REQUIRED]` | Implementation MUST stop and route the unresolved choice to its named owner. |
| `[NOT-RUNTIME-EVIDENCE]` | Snippet, fixture, generated testcase, mock, or design scenario that proves no live behavior. |

Normative claims use the pattern `SRS §<section> / <ID> → owner document → future verification scenario`. Lower layers may refine the SRS but MUST NOT weaken or replace it. The authority order is:

1. **SRS** `De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md` — controlling requirements and IDs.
2. **This README** — pack-level vocabulary, ownership, conflicts, and propagation rules.
3. **Numbered implementation contracts** — one canonical owner per subsystem.
4. **`plans/` playbooks** — delivery detail that may refine, but cannot supersede, the SRS or owner contract.
5. **`testcases/` sources and generated specifications** — specification-only executable intent; they are not runtime evidence.

`testcases/` is specification-only; case execution status remains `NOT_RUN`. `python testcases/_generate.py --check` checks generated consistency only and must not rewrite sources or generated output. A successful check is `[NOT-RUNTIME-EVIDENCE]`, not product behavior or gate sign-off. The exact observed result belongs in the delivery evidence, not a permanent claim of runtime success.

## 6. Complete Platform Capability Map

The SRS controls names and requirements. The blueprint chooses 23 registry skills and physical persistence mechanisms; these are not additional SRS-mandated counts. The maps below give SRS ID → owner → runtime boundary → future evidence. Every evidence item is currently `[NOT-RUNTIME-EVIDENCE]`/`NOT_RUN`.

### 6.1 Six objectives `[SRS-MUST][SRS §1, §25 / OBJ-001..006]`

| Objective | Required coverage | Owner | Runtime boundary | Future evidence |
|---|---|---|---|---|
| `OBJ-001` Marketing | Strategy, audience, content, campaign, evaluation | [05 registry](./05-skill-system-specifications.md) / SRS §6 | Orchestrator → campaign skill → API-003 | PILOT-01 human approval, dispatch receipt and attribution |
| `OBJ-002` Sales | Qualification, recommendation, cart recovery, conversion | [05 registry](./05-skill-system-specifications.md), [06 API-001](./06-api-and-connectors-spec.md) / SRS §7 | Verified context → price/stock/order adapter | PILOT-02 real order and revenue receipt |
| `OBJ-003` Customer Care | Intent, private lookup, cases, escalation | [05 registry](./05-skill-system-specifications.md), [07 console](./07-human-command-center-ui.md) / SRS §8 | Verified conversation → API-001 → customer/human | PILOT-03/04 real dialogue and case outcome |
| `OBJ-004` Retention | Inactivity, churn signals, replenishment and next-best-action | [03 memory](./03-database-and-memory-schema.md), [05 retention](./05-skill-system-specifications.md) / SRS §8 / FR-CS-003 | Signal → HYPOTHESIS → eligibility → approval/execution → outcome | Context-preserving retention trace, consent suppression and observed repeat purchase |
| `OBJ-005` Orchestration | Central cross-agent workflows | [04 orchestrator](./04-core-engine-and-orchestrator.md) / SRS §9 / FR-ORC-001/002 | Gateway → durable worker → skill ports | TC-E2E-001 and P4 restart/context trace |
| `OBJ-006` Governance | Source, reason, authority, policy, log, evidence, outcome | [08 governance](./08-security-governance-nfr.md), [09 gates](./09-sprint-roadmap-and-pilots.md) / SRS §12, §13, §17, §19 | PEP → approved dispatch → immutable audit | TC-E2E-002..009 and signed gate bundle |

### 6.2 Marketing `[SRS-MUST][SRS §6 / MKT-01..06]`

| Agents / blueprint skills | Owner and contract | Boundary | Evidence |
|---|---|---|---|
| `MKT-01` Strategist; `MKT-02` Audience Intelligence; `MKT-03` Content; `MKT-04` Brand Guardian; `MKT-05` Campaign; `MKT-06` Analyst | [05 §4.1 and §6](./05-skill-system-specifications.md): `skill.mkt.analyze_market_signal`, `skill.mkt.segment_audience`, `skill.mkt.check_consent`, `skill.mkt.generate_content`, `skill.mkt.audit_brand_compliance`, `skill.mkt.dispatch_campaign`, `skill.mkt.evaluate_attribution` | `SkillContract` → PEP/consent → API-003; `campaigns` and `segments` are owned by `03` | Seven per-skill five-category case sets, TC-E2E-002/007, PILOT-01 at P3 |

### 6.3 Sales `[SRS-MUST][SRS §7 / FR-SAL-001..003, SAL-01..05]`

| Agents / blueprint skills | Owner and contract | Boundary | Evidence |
|---|---|---|---|
| `SAL-01` Qualification; `SAL-02` Advisor; `SAL-03` Recommendation; `SAL-04` Cart Recovery; `SAL-05` Replenishment | [05 §4.2](./05-skill-system-specifications.md): `skill.sales.search_product`, `skill.sales.check_stock`, `skill.sales.check_price`, `skill.sales.retrieve_customer`, `skill.sales.recommend_product`, `skill.sales.create_cart`, `skill.sales.create_order`, `skill.sales.send_message`; [06 §2](./06-api-and-connectors-spec.md) owns wire DTOs | Registry → SoR product/price/inventory/order; seven-field recommendation → `03` projection; floor conflict §8.1 blocks unapproved dispatch | Eight per-skill case sets, TC-E2E-003/005/007/008, PILOT-02 at P2 |

### 6.4 Customer Care / Retention `[SRS-MUST][SRS §8 / FR-CS-001..003]`

| Agents / blueprint skills | Owner and contract | Boundary | Evidence |
|---|---|---|---|
| `CS-01` Omnichannel Care; `CS-02` Retention / Customer Success | [05 §4.3](./05-skill-system-specifications.md): `skill.care.search_faq`, `skill.care.lookup_order`, `skill.care.track_shipping`, `skill.care.manage_case`, `skill.care.initiate_return`, `skill.care.escalate_to_human`, `skill.care.analyze_churn_risk`, `skill.care.issue_retention_offer`; [03 FSM](./03-database-and-memory-schema.md); [07 SCR-005](./07-human-command-center-ui.md) | Verified identity → API-001 lookup; seven-state case/REOPEN; takeover and approval before protected effects | Eight per-skill case sets, TC-E2E-004/006/009, PILOT-03/04 at P1; P4 retention outcome |

### 6.5 Core Engine, data, memory, and UI

| Capability / members | SRS trace and canonical owner | Runtime boundary | Required evidence |
|---|---|---|---|
| 28 entities in SRS order: Customer, Customer Identity, Consent, Customer Event, Product, SKU, Price, Inventory, Order, Invoice, Conversation, Lead, Opportunity, **Campaign (14), Segment (15)**, Offer, Recommendation, Service Case, Agent, Skill, Workflow, Decision, Action, Approval, Execution, Evidence, Outcome, Learning | SRS §14 / [03 entity catalog](./03-database-and-memory-schema.md) | SoR adapters → tenant-scoped PostgreSQL/RLS; physical DDL order is not an entity numbering scheme | 28-entity migration/catalog check; FK/RLS/subject isolation; provenance reconstruction |
| `SIGNAL → CONTEXT → HYPOTHESIS → DECISION → PLAN → ACTION → APPROVAL → EXECUTION → EVIDENCE → OUTCOME → LEARNING` | SRS §9 / FR-ORC-001/002 / [04 stage contract](./04-core-engine-and-orchestrator.md) | Durable orchestrator/worker | Eleven-stage trace with effect reconciliation and restart recovery |
| Working Memory; Customer Context; Organizational Knowledge; Agent Operational Memory; Learning Memory | SRS §16; §10 approved knowledge / [03 memory contract](./03-database-and-memory-schema.md) | Redis / PostgreSQL / Qdrant; customer and tenant binding | Expiry/retention/identity tests and HYPOTHESIS/raw-conversation-to-FACT refusal |
| `SCR-001` Executive Dashboard; `SCR-002` Agent Operations; `SCR-003` Approval Center; `SCR-004` Customer 360; `SCR-005` Conversation Console | SRS §18 / [07 screen contract](./07-human-command-center-ui.md); [06 routes](./06-api-and-connectors-spec.md) | `/api/v1` reads/actions + SSE/WebSocket | Metric completeness, permission/stale/conflict/reconnect/takeover/accessibility scenarios |

### 6.6 Governance and delivery

| Capability / members | SRS trace and canonical owner | Runtime boundary | Required evidence |
|---|---|---|---|
| `AUTH-0..AUTH-3` assignable grants; `AUTH-4` approval routing; `AUTH-5` terminal deny | SRS §12 / [08 authority](./08-security-governance-nfr.md); [05 registry encoding](./05-skill-system-specifications.md) | PEP before queue/dispatch | Matrix negatives, one-time bound approval; no AUTH-5 queue |
| `BR-001` no invented price; `002` no unauthorized price/discount change; `003` authoritative price/inventory; `004` consent; `005` unique execution ID; `006` no duplicate retry; `007` high-risk approval; `008` authority boundary; `009` no prompt privilege elevation; `010` evidence | SRS §13 / [08 rule matrix](./08-security-governance-nfr.md) | Policy/consent/SoR/effect guard → dispatch → evidence | Each rule's deny/error/audit acceptance case; floor arithmetic remains blueprint policy, not the definition of BR-001 |
| `NFR-001` security; `002` audit; `003` idempotency; `004` recovery; `005` explainability; `006` isolation; `007` override; `008` fail closed; `009` performance; `010` cost observability | SRS §19 / [08 verification owner](./08-security-governance-nfr.md); `01`, `03`, `04` provide mechanisms | Cross-cutting runtime controls | Invariant checks plus provisional ASM-002/NFR-009 benchmarks |
| `PILOT-01` Marketing → Sales; `PILOT-02` Cart Recovery; `PILOT-03` Care; `PILOT-04` Escalation | SRS §21 / [09 pilot runbook](./09-sprint-roadmap-and-pilots.md) | Allowlisted production-like provider/SoR boundary | Real receipts/conversation/outcome and signed pilot bundle |
| `TC-E2E-001` lifecycle; `002` publish approval; `003` sourced price; `004` customer identity; `005` duplicate prevention; `006` authority deny; `007` consent suppression; `008` truthful connector failure; `009` backward trace | SRS §22 / [09 acceptance matrix](./09-sprint-roadmap-and-pilots.md) | Public runtime contracts and durable storage | Persisted traces, negative cases, provider transcript where gate requires it |
| `P0` Foundation; `P1` Care; `P2` Sales; `P3` Marketing; `P4` Cross-domain; `P5` Controlled Autonomy | SRS §24, §27 / [09 gates](./09-sprint-roadmap-and-pilots.md) | Entry/exit review and versioned promotion | Signed reviewer roles, artifacts, stop/rollback decision; mocks cannot close gates |
| `ASM-001` connectors (Product/IT); `002` KPI baseline/target (Business); `003` discount/promotion (Business/Finance); `004` refund/compensation (Finance/Operations); `005` long-term customer data (Data/Legal/Product) | SRS §26 / [01 configuration](./01-tech-stack-and-environment.md), [08 policy](./08-security-governance-nfr.md), [09 sign-off](./09-sprint-roadmap-and-pilots.md) | Signed tenant/environment policy inputs | Decision record or explicit unavailable/fail-closed state; no illustrative default approval |

## 7. Canonical Contract Ownership Table

| Document | Canonical ownership | Cross-document rule |
|---|---|---|
| `01-tech-stack-and-environment.md` | Environment/deployment assumptions, trust zones, configuration, startup/readiness, resource targets | Other documents link to environment names and variables; they do not redefine deployment values. |
| `02-project-structure.md` | Workspace/package boundaries, dependency DAG, pnpm/Turborepo toolchain, generation/seed boundary | Raw SQL migrations and named Dockerfiles remain the target; no Prisma migration contract is introduced. |
| `03-database-and-memory-schema.md` | Persistence, RLS, five memory layers, ten-stage timeline projection, Service Case FSM, migrations | DDL/object names and lifecycle state values are defined once here. |
| `04-core-engine-and-orchestrator.md` | Eleven-stage control flow, durable workflow semantics, authority verdict execution, evidence/outcome interfaces | Stage transitions and durable task behavior are linked, not redefined, elsewhere. |
| `05-skill-system-specifications.md` | Skill contract, registry invariants, all 23 skills, skill authority serialization | Skill fields and per-skill error/retry/test contracts are canonical here. |
| `06-api-and-connectors-spec.md` | Gateway, `/api/v1`, API-001/002/003, adapters, DTOs, route/wire contracts | UI and orchestrator consume these routes; `/v1` in `plans/` remains propagation debt. |
| `07-human-command-center-ui.md` | SCR-001..005, shared UI state/realtime, storefront widget behavior | UI never creates a second authority, pricing, or approval contract. |
| `08-security-governance-nfr.md` | PEP, authority verdicts, BR-001..010, audit, NFR verification, threat model | Security wording must distinguish requirements, mechanisms, and evidence. |
| `09-sprint-roadmap-and-pilots.md` | P0–P5 gates, pilots, DoD, CI/CD target, sign-off evidence | A gate cannot close on blueprint or mock-only evidence. |

## 8. Contract Conflict Register and Interim Rules

### 8.1 P_floor ownership and formula — `[OWNER-DECISION-REQUIRED]`

Two competing proposals remain intentionally visible until the **Solution Architect and Business/Finance** record a decision covering ownership, formula/mode, rounding, currency, staleness, and provenance:

1. **ERP/policy-service model:** the authoritative source supplies `floor_price` plus provenance; the platform validates presence, freshness, tenant binding, and signature, and refuses missing or unapproved provenance. This is the current safe mirror proposal in `03` and the action-boundary refusal in `04`.
2. **Platform-derived model:** the platform derives a floor from owner-approved policy inputs using a documented formula. The illustrative local calculations in `02`, `04`, `08`, `09`, and `plans/delivery/analytics.md` are competing candidates, not a canonical formula.

The historical review anchors `implement/04:409-410`, `implement/03:178-182`, `implement/08:736-739`, and `plans/delivery/analytics.md:207` are preserved for propagation tracking; line numbers move as documents expand. Current owner sections are [02 functional helper](./02-project-structure.md), [03 Price mirror](./03-database-and-memory-schema.md), [04 pricing guardrail](./04-core-engine-and-orchestrator.md), and [08 candidate equations](./08-security-governance-nfr.md). All remain competing proposals until the owner decision is recorded. Interim safety rule: **no price-bearing action may dispatch without an owner-approved, provenance-bearing floor decision; no numeric default may be invented.**

“Tenant may disable discount/subsidy capability” means the optional capability is not used. It does **not** mean a price-bearing proposal may bypass the safety decision when that capability is used. Missing or unapproved provenance is `P_FLOOR_UNAVAILABLE`; no document may authorize a price-bearing dispatch from a local candidate alone: until the owner decision is recorded, missing floor provenance is a hard fail-closed condition.

### 8.2 Authority, FSM, route, and toolchain conflicts

- Agents carry only `AUTH-0..AUTH-3` grants. `AUTH-4` is an approval-routing verdict; `AUTH-5` is terminal hard deny. Required-authority `AUTH-4` values are routing metadata, not grants. Existing testcase safeguards in `testcases/sources/governance.py`, `testcases/sources/platform.py`, and `testcases/unit/authority.md` remain unchanged.
- The implementation blueprint stores the seven Service Case states and uses `REOPEN` as an action/event returning to `IN_PROGRESS`; the downstream `REOPENED` proposal in plan/testcase material is recorded, not silently adopted.
- The target gateway surface is `/api/v1`. `/v1` wording in `plans/` is a pending propagation mismatch, not a second implementation route.
- The target toolchain is pnpm/Turborepo, raw SQL migrations, and `docker/Dockerfile.api`, `docker/Dockerfile.worker`, and `docker/Dockerfile.command-center`. npm/Prisma/Flyway/an unnamed root `Dockerfile` are not parallel targets.

## 9. Downstream Propagation Register

The contested floor-price wording is also present in `presentation/index.html:238`, `presentation/index.html:488-493`, `presentation/tech_spec.html:913`, and `presentation/tech_spec.html:925-933`. This documentation pass does **not** edit those HTML files and does **not** run `presentation/export_pdf.py`. Re-export is a separate propagation step after the P_floor owner decision.

The same pending propagation relationship applies to `plans/` and generated `testcases/`; lower-layer wording cannot settle an owner decision. After an explicitly authorized decision, propagate from the SRS/owner contract to `plans/delivery/analytics.md` (floor/KPIs), `plans/modules/customer-care.md` and related case playbooks (FSM), and platform API playbooks (`/v1` mismatch). Change testcase definitions in `testcases/sources/`, not generated Markdown or manifest by hand; use `python testcases/_generate.py` only in a separately authorized propagation pass, then `python testcases/_generate.py --check`. Existing authority safeguards in `governance.py`, `platform.py`, and `unit/authority.md` do not grant AUTH-4/AUTH-5 and need no change here. This pass edits none of these paths.

## 10. Pack-Level Verification Contract

Each numbered document MUST state purpose, SRS traceability, responsibility boundary, inputs/outputs, lifecycle/state behavior, authority and tenant rules, failure/retry/recovery behavior, observability/evidence, dependencies, rollout prerequisites, and concrete verification scenarios. Every code/SQL/YAML/JSON/OpenAPI block is a **target snippet** and carries `[NOT-RUNTIME-EVIDENCE]` meaning through its surrounding section.

Required future checks: scope to `implement/*.md`; blueprint banner, SRS trace, and verification section in all ten files; one `/api/v1` route vocabulary; one eleven-stage order; canonical owner links; P_floor interim safety and unresolved ownership in every affected document; authority separation; generated testcase consistency; `git diff --check`; and relative-link review. These checks establish documentation consistency only, never runtime success.
