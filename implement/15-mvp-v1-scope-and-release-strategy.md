# Implement 15: MVP v1 Scope, Release Strategy, and Out-of-Scope Boundaries

> **BLUEPRINT STATUS - design-level specification only.**
> This document defines a deliberately bounded first release for review and implementation planning. It does not claim that the MVP is built, deployed, or approved for live operation.

## 1. Purpose

The full platform vision spans Marketing, Sales, Customer Support, omnichannel connectors, knowledge retrieval, workflow orchestration, pricing governance, and analytics. Implementing all of it at once would make approval and risk evaluation difficult. MVP v1 should prove a narrow, supervised slice of the architecture before any expansion.

The MVP is a reviewable product boundary, not a promise to automate every business process.

## 2. MVP v1 Objective

Demonstrate that one tenant can use the platform to:

- receive a synthetic customer event,
- resolve a verified customer context,
- retrieve approved knowledge,
- produce a recommendation,
- apply deterministic policy checks,
- route material actions to a human approval queue,
- execute only approved low-risk or explicitly authorized actions,
- and preserve complete evidence.

The first release should use offline fixtures and provider stubs only. No real customer data, production credentials, or unapproved outbound channel should be required.

## 3. Included Scope

### Platform foundation

- one isolated tenant test profile,
- PostgreSQL schema with tenant-aware access controls,
- Redis session and idempotency namespaces,
- deterministic clock and synthetic fixture loading,
- correlation IDs and audit evidence records.

### Customer Support journey

- customer identity resolution from a verified session or exact channel handle,
- read-only customer and order context,
- knowledge-grounded answer recommendation,
- escalation to human takeover when identity, consent, policy, or confidence is uncertain.

### Sales journey

- product and inventory lookup through a designated source of truth,
- recommendation generation separated from price authority,
- price-floor and promotion checks,
- approval routing for policy exceptions,
- synthetic order intent with idempotent execution design.

### Human Command Center

- approval queue,
- approve/reject/modify/cancel outcomes,
- evidence view,
- safe-mode and tenant pause controls,
- basic workflow and incident status visibility.

### Verification

- offline acceptance scenarios for happy paths, denials, connector failures, duplicate effects, identity ambiguity, and tenant isolation,
- governance review against Gates A-D,
- rollback and incident drill design before any pilot expansion.

## 4. Explicitly Out of Scope for MVP v1

The following must not silently enter the first release:

- autonomous bulk marketing campaigns,
- unsupervised discounts, refunds, or financial compensation,
- production customer data migration,
- production credentials or real outbound recipients,
- multi-region active-active deployment,
- unrestricted cross-channel identity merging,
- self-modifying agent policies,
- autonomous policy changes based on model output,
- unsupported provider adapters,
- automated deletion of audit evidence,
- unreviewed model fine-tuning from customer conversations.

An out-of-scope item requires a new scope decision and a new approval review; it is not added through a technical shortcut.

## 5. Release Stages

```text
R0 Design Review
  -> R1 Offline Contract Validation
  -> R2 Internal Supervised Demo
  -> R3 Isolated Sandbox Pilot
  -> R4 Controlled Tenant Pilot
  -> R5 Production Expansion Review
```

### R0 - Design Review

Approve requirements, boundaries, ownership, threat model, synthetic fixtures, and MVP exit criteria.

### R1 - Offline Contract Validation

Validate schemas, policy decisions, state transitions, approval outcomes, evidence contracts, and failure paths without external systems.

### R2 - Internal Supervised Demo

Demonstrate the full journey with synthetic data to the business, security, and technical reviewers. No real customer or production side effect is allowed.

### R3 - Isolated Sandbox Pilot

Use only approved sandbox connectors and recipients. Keep all material actions supervised and capture provider evidence.

### R4 - Controlled Tenant Pilot

Enable a narrowly selected tenant and action set after explicit Gate E approval. Keep tenant-specific stop controls and manual fallback available.

### R5 - Production Expansion Review

Review pilot evidence, incidents, customer impact, economics, and support readiness before adding tenants, channels, or autonomous authority.

## 6. MVP Exit Criteria

MVP v1 is ready for the next review only when:

- synthetic offline fixtures load deterministically,
- tenant and customer context isolation is demonstrated,
- missing identity or consent fails closed,
- pricing recommendations cannot replace authoritative prices,
- material actions cannot bypass approval,
- duplicate effects are prevented by idempotency design,
- connector failure does not create false success,
- audit evidence links request, decision, approval, execution, and outcome,
- safe mode and tenant pause behavior are demonstrated,
- a human operator can complete the workflow manually,
- and all unresolved assumptions are listed in the risk register.

These are review criteria, not claims that the current repository has already met them.

## 7. Expansion Rules

Each expansion must define:

- new action classes and authority levels,
- new data sources and their ownership,
- new connectors and sandbox evidence,
- new customer or regional obligations,
- additional approval roles,
- rollback limitations,
- measurable exit criteria,
- and the governance gate required for approval.

The platform should expand one bounded workflow at a time, preserving the ability to compare new behavior against the approved MVP contract.

## 8. Design Decision

A narrow supervised MVP is the preferred implementation path because it makes policy, approval, incident response, and customer impact reviewable. The system should earn additional autonomy through evidence and explicit approval, rather than treating the complete platform vision as a single release.
