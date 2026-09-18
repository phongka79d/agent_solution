# AI Revenue & Engagement Platform — Implementation Blueprint

## 1. Executive Technical Overview

The AI Revenue & Engagement Platform (AgentOS Customer360) is an enterprise-grade, multi-tenant autonomous AI orchestration system designed to unify Marketing, Sales, and Customer Support across omnichannel touchpoints (LINE, WhatsApp, Web, CRM, and ERP). 

The platform bridges probabilistic Large Language Models (LLMs) with deterministic enterprise systems of record (SoR). It enforces a strict 11-step end-to-end orchestration lifecycle (`SIGNAL` -> `CONTEXT` -> `HYPOTHESIS` -> `DECISION` -> `PLAN` -> `ACTION` -> `APPROVAL` -> `EXECUTION` -> `EVIDENCE` -> `OUTCOME` -> `LEARNING`) that guarantees transactional integrity, mathematical margin safety ($P_{floor}$), zero-hallucination factual grounding via Second Brain RAG, and total multi-tenant data isolation.

### Architectural Principles

1. **Two-Tier Separation**:
   - **Tier 1: Core Engine (Multi-Tenant Platform Core)**: Houses the central Revenue Orchestrator, Supervisor, State Machine, Authority Enforcement (AUTH-0..5), Business Rules Engine (BR-001..010), Customer 360 Event Fabric, and the Second Brain Knowledge Base.
   - **Tier 2: Plug-and-Play Adapters**: Decouples external messaging channels (LINE, WhatsApp, Webhooks), localized e-commerce gateways (Taiwan ECPay, CVS COD, Stripe), and enterprise ERP/OMS systems via authenticated connector interfaces.

2. **Zero Peer-to-Peer Agent Coupling**:
   - Agents (13 specialized agents across Marketing, Sales, and Support) never invoke each other directly.
   - All routing, handoffs, and state transitions are governed centrally by the Revenue Orchestrator and verified by the Policy Engine.

3. **Deterministic Authority & Fail-Closed Guardrails**:
   - Agent execution is strictly capped at `AUTH-0` through `AUTH-3`.
   - High-impact operations (bulk campaigns > 5,000 users, financial commitments, pricing overrides) mandate human authorization (`AUTH-4` at Command Center Approval Queue SCR-003).
   - If pricing, inventory, identity, or consent cannot be conclusively verified from authoritative Systems of Record, the system fails closed (NFR-008) and transitions to safe human handoff (SCR-005).

4. **Absolute Multi-Tenant Isolation (NFR-006)**:
   - Mandatory `tenant_id` at every persistent layer: PostgreSQL Row-Level Security (RLS), isolated Redis key namespaces, and isolated Qdrant vector collections.
   - Zero runtime context bleeding across tenant boundaries.

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
| **Connectors & Gateways** | Node.js / Python Adapters | Axios / HTTPX with mTLS & HMAC-SHA256 | Bidirectional channel adapters (LINE Messaging API, WhatsApp Cloud API, ERP API-001, Event API-002, Stripe, ECPay). |
| **Monorepo Build System** | Turborepo / pnpm | pnpm 9.x, Turborepo 1.13+ | Fast caching, strict workspace dependency graphs, atomic code sharing between packages and services. |
| **Observability** | OpenTelemetry & Prometheus | OTel SDK, Prometheus, Grafana | Real-time token tracking (NFR-010), end-to-end distributed tracing (`correlation_id`), and latency histograms. |

---

## 3. Implementation Blueprint Table of Contents

The complete production implementation documentation is organized into 9 specialized specifications located in `implement/`:

| File | Document Title | Primary Scope & Contents |
|---|---|---|
| [**01-tech-stack-and-environment.md**](./01-tech-stack-and-environment.md) | **Tech Stack & Environment Setup** | NFR-001..NFR-010 architectural justifications, production Docker Compose multi-container environment, comprehensive environment schema with Zod/Pydantic validation. |
| [**02-project-structure.md**](./02-project-structure.md) | **Project Structure & Monorepo** | pnpm workspaces & Turborepo architecture, application and package boundaries, dependency graphs, and strict TypeScript/functional programming guidelines. |
| [**03-database-and-memory-schema.md**](./03-database-and-memory-schema.md) | **Database & Memory Schema** | PostgreSQL DDL for all 28 canonical entities, Row-Level Security (RLS) enforcement, Redis session mutex and idempotency specs, Qdrant 8-folder vector schemas. |
| [**04-core-engine-and-orchestrator.md**](./04-core-engine-and-orchestrator.md) | **Core Engine & Revenue Orchestrator** | Central execution loop, 11-step E2E lifecycle coordinator, multi-agent intent routing (FR-ORC-001/002), and Temporal durable workflows. |
| [**05-skill-system-specifications.md**](./05-skill-system-specifications.md) | **Skill System & Runtime Specifications** | Skill Engine Runtime, platform skill registry (11-field contracts), dynamic JSON schema validation, and tool execution wrappers. |
| [**06-api-and-connectors-spec.md**](./06-api-and-connectors-spec.md) | **Connectors & Plug-and-Play Adapters** | API-001 (ERP/Commerce) & API-002 (Event Ingestion) contracts, Taiwan Adapter (ADPT-TW-001: LINE, ECPay, CVS COD), Global Adapters (ADPT-GL-001..003: WhatsApp, Stripe, GDPR/CCPA). |
| [**07-human-command-center-ui.md**](./07-human-command-center-ui.md) | **Human Command Center UI & Storefront Widget** | Next.js 14 Command Center implementation (SCR-001..005), SSE real-time streaming, and the standalone < 20 KB Vanilla TypeScript Web Component widget. |
| [**08-security-governance-nfr.md**](./08-security-governance-nfr.md) | **Security, Governance & NFR Engine** | Policy Enforcement Point (PEP), Authority Model (AUTH-0..5), 10 Business Rules (BR-001..010), prompt injection defense, and audit evidence logging. |
| [**09-sprint-roadmap-and-pilots.md**](./09-sprint-roadmap-and-pilots.md) | **Sprint Roadmap, Pilots & CI/CD** | 24-week engineering roadmap across 6 technical gates (P0 to P5), pilot acceptance test harnesses (TC-E2E-001..009), and CI/CD automation pipelines. |

---

## 4. Execution Sequence for Implementers

Engineers deploying the AI Revenue & Engagement Platform must execute the setup in strict chronological order:

```text
Step 1: Environment Provisioning (01-tech-stack-and-environment.md)
   ├── Launch Docker Compose infrastructure (Postgres 16, Redis 7.2, Qdrant, Mock ERP)
   └── Verify environment validation via Zod/Pydantic schema

Step 2: Workspace Setup (02-project-structure.md)
   ├── Initialize pnpm workspace with Turborepo
   └── Link packages (@agentos/database, @agentos/core-engine, @agentos/skills, @agentos/adapters)

Step 3: Database & Knowledge Ingestion (03-database-and-memory-schema.md)
   ├── Run PostgreSQL migrations for 28 canonical entities & activate RLS policies
   ├── Configure Redis memory policies and TTL constraints
   └── Initialize Qdrant vector collections for the 8 Second Brain namespaces

Step 4: Core Engine, Policy, & Adapter Deployment (04, 05, 06)
   ├── Deploy Temporal workflows and Skill contracts
   ├── Configure Authority limits and Price Floor constraints
   └── Bind localized adapters (LINE, WhatsApp, ERP API-001, Event API-002)

Step 5: Frontend & Observability Verification (07, 08, 09)
   ├── Launch Next.js Command Center and compile Storefront Widget
   ├── Execute automated test suites (TC-E2E-001..009 and TC-DATA-001..005)
   └── Validate OTel token metering and fail-closed circuits in staging
```
