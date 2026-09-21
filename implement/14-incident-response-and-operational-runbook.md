# Implement 14: Incident Response, Rollback, and Operational Runbook

> **BLUEPRINT STATUS - design-level specification only.**
> This document defines the operating model for incidents, service degradation, unsafe AI behavior, connector failures, and controlled rollback. It does not claim that any runtime, alert, or runbook has been implemented.

## 1. Purpose

The platform must remain governable when an AI decision, connector, workflow, or data source behaves unexpectedly. The design therefore needs an operating model that answers four questions before implementation begins:

1. How is an incident detected?
2. Who is allowed to stop or restrict the system?
3. How is customer and business impact contained?
4. What evidence is preserved for recovery and review?

The default response to uncertainty is restriction, not continued autonomous execution.

## 2. Incident Severity Model

| Level | Description | Default Response |
|---|---|---|
| SEV-1 | active risk to customers, money, privacy, or cross-tenant isolation | stop affected action class immediately; page executive and security owners |
| SEV-2 | material workflow failure or repeated unsafe behavior without confirmed data exposure | pause affected workflow or connector; assign incident commander |
| SEV-3 | degraded quality, latency, or non-critical integration failure | route to support queue; continue only within approved safe limits |
| SEV-4 | documentation, monitoring, or isolated test defect | record, prioritize, and resolve through normal delivery process |

Severity is assigned from impact, not from the number of failing technical components.

## 3. Detection Signals

The implementation should produce alerts for:

- repeated policy denials or unexpected AUTH-5 decisions,
- approval queue growth or expired approvals,
- duplicate `effect_key` attempts,
- connector authentication, signature, or replay failures,
- missing provenance for pricing, inventory, consent, or identity data,
- cross-tenant access attempts,
- unusual outbound message volume,
- audit evidence write failures,
- model or retrieval responses that violate output policy,
- latency or error rates beyond the approved service objective.

Every alert must include `tenant_id` where known, `correlation_id`, affected workflow, action class, and first observed timestamp.

## 4. Containment Modes

The platform should support progressively restrictive modes:

### Normal

Approved low-risk workflows may run within tenant policy and authority limits.

### Supervised

Material actions are held for human approval; autonomous execution is restricted to read-only or reversible actions.

### Safe Mode

All external side effects are blocked. The system may retain evidence, present recommendations, and support human takeover.

### Tenant Isolation Mode

Only the affected tenant is paused. Other tenants continue only if isolation and shared-service health are verified.

### Global Stop

All external side effects are blocked when platform-wide isolation, audit integrity, or security cannot be trusted.

A mode transition must be recorded as an auditable governance event and require an authorized operator, except for automated fail-closed transitions that are reviewed afterward.

## 5. Incident Response Flow

```text
DETECT -> CLASSIFY -> CONTAIN -> PRESERVE EVIDENCE -> NOTIFY -> RECOVER -> REVIEW
```

### Detect

Create an incident record with a unique incident ID and link all related correlation IDs.

### Classify

Determine severity, affected tenant or global scope, action class, customer impact, and whether data integrity or privacy may be involved.

### Contain

Pause the smallest affected scope first. Escalate to tenant isolation or global stop when scope cannot be established reliably.

### Preserve Evidence

Preserve immutable audit records, policy versions, payload snapshots, connector responses, approval decisions, and relevant model/retrieval references. Do not modify evidence to make a recovery look successful.

### Notify

Notify the incident commander, business owner, support lead, security/privacy owner, and affected tenant owner according to the approved escalation matrix.

### Recover

Restore from the last trusted state, replay only idempotent operations, and keep material actions in supervised mode until the recovery review is complete.

### Review

Record root cause, impact, timeline, containment result, customer communication, corrective action, and the gate required before returning to normal mode.

## 6. Rollback Rules

Rollback must be defined by action type rather than treated as a universal undo button.

| Action Type | Rollback Design |
|---|---|
| outbound message | cancel queued send where possible; issue corrective communication only with approval |
| discount or offer | stop future issuance; preserve already accepted orders; reconcile with business owner |
| refund or compensation | freeze further actions; reconcile against authoritative finance record |
| customer data update | restore from authoritative SoR or approved version; retain before/after evidence |
| campaign | pause campaign and suppress remaining audience; preserve provider receipt history |
| workflow transition | restore only through an approved state transition; never delete the original event |

The system must never claim that an external provider action was reversed unless the provider returned confirmed evidence.

## 7. Operational Roles

- **Incident Commander:** coordinates severity, containment, and recovery decisions.
- **Technical Lead:** diagnoses services, workflows, queues, and connectors.
- **Business Owner:** decides customer, pricing, campaign, and financial remediation.
- **Security/Privacy Owner:** handles data exposure, identity, consent, and tenant-isolation concerns.
- **Support Lead:** coordinates customer-facing communication and manual takeover.
- **Scribe/Audit Owner:** maintains the incident timeline and evidence index.

No single AI agent may serve as incident commander or approve its own recovery.

## 8. Recovery Readiness Checklist

Before a pilot is approved, the design review must confirm:

1. each incident severity has an accountable human owner,
2. safe mode and global stop behavior are defined,
3. tenant-scoped pause is possible without deleting evidence,
4. external connector failures fail closed,
5. retry and replay behavior is idempotent,
6. rollback limitations are documented per action type,
7. manual business continuity procedures exist,
8. customer and regulator notification responsibilities are assigned,
9. incident evidence retention is defined,
10. an incident drill scenario is included in pilot acceptance evidence.

## 9. Return-to-Service Gate

A restricted workflow may return to normal only when:

- the cause is understood or bounded,
- the affected data and action scope are identified,
- the corrective change is reviewed,
- audit integrity is confirmed,
- a human owner approves the return,
- and a monitoring window is defined.

If these conditions cannot be demonstrated, the workflow remains in supervised or safe mode.

## 10. Design Decision

Operational readiness is not only the ability to start the platform. It is also the ability to stop it safely, explain what happened, recover without duplicating side effects, and continue the business manually. This runbook is therefore a prerequisite for pilot approval, not a post-production document.
