# AI Revenue & Engagement Platform — Implementation Blueprint

## 1. Executive Technical Overview

The AI Revenue & Engagement Platform (AgentOS Customer360) is specified here as an enterprise-grade, multi-tenant autonomous AI orchestration platform for Marketing, Sales, and Customer Support across omnichannel touchpoints (LINE, WhatsApp, Web, CRM, and ERP).

**This is documentation only.** The platform is not built, deployed, or measured: every code block, DDL statement, schema, and pipeline in these documents is a target specification, and any numeric target quoted from the baseline SRS is provisional pending the ASM-002 baseline.

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
| **High-Perf Services** | Python / FastAPI | Python 3.12, FastAPI, Pydantic v2 | High-throughput AI inference parsing, semantic vector pipelines, and mathematical floor calculations. |
| **Workflow Engine** | Temporal.io / BullMQ | Temporal Server 1.23+ / BullMQ 5.x | Durable workflows, deterministic retry with exponential backoff, state checkpointing, and long-running human approval gates. |
| **Primary Database** | PostgreSQL | PostgreSQL 16 Enterprise | ACID compliance, System of Record integration, Row-Level Security (RLS) for tenant isolation, JSONB indexing. |
| **Vector Engine** | Qdrant & pgvector | Qdrant 1.9+ / pgvector 0.7+ | Multi-tenant HNSW dense vector indexing, payload metadata filtering for Second Brain 8-folder knowledge hierarchy. |
| **Cache & Distributed Lock** | Redis | Redis 7.2+ (Cluster / Sentinel) | Sub-millisecond Working Memory (Layer 1), Redlock session mutex locks, and distributed 72-hour idempotency key cache. |
| **Command Center UI** | Next.js | Next.js 14 (App Router, React 18/19) | Enterprise web application for Management Dashboard, Approval Center (SCR-003), Live Takeover (SCR-005), and Analytics. |
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
| [**04-core-engine-and-orchestrator.md**](./04-core-engine-and-orchestrator.md) | **Core Engine & Revenue Orchestrator** | Target blueprint/specification - not deployed | Central execution loop, 11-step E2E lifecycle coordinator, multi-agent intent routing (FR-ORC-001/002), and Temporal durable workflows. |
| [**05-skill-system-specifications.md**](./05-skill-system-specifications.md) | **Skill System & Runtime Specifications** | Target blueprint/specification - not deployed | Skill Engine Runtime, platform skill registry (11-field contracts), dynamic JSON schema validation, and tool execution wrappers. |
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
