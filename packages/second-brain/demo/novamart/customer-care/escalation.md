---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Human Escalation and Takeover Policy

## Immediate Human Escalation (`skill.care.escalate_to_human`)

When a customer requests human assistance (for example, *"I want to speak with a person"* or *"I want a human agent"*), or when a dispute exceeds automated Customer Care authority:

1. **Transition to `awaiting_human`:** `CareAgentRuntime` executes `skill.care.escalate_to_human`, creates an auditable support handoff record, and transitions the conversation to `awaiting_human` under a takeover lock.
2. **Cessation of Autonomous Replies:** Once the takeover lock is engaged, the automated LLM response finalizer must **never** append an autonomous agent reply or continue automated turn generation. Subsequent automated turns while locked are refused with `CONVERSATION_LOCKED`.

## Operator Lease and Takeover Lifecycle (`R06` / `R07` / `R08`)

- **Claim Lease (`R06`):** An authenticated NovaMart tenant operator with `conversation:takeover` permission claims the active takeover lease in Tenant Console.
- **Heartbeat Renewal (`R07`):** The lease owner maintains exclusive control via periodic heartbeats; expired or non-owner lease calls are rejected.
- **Operator Reply (`POST /api/v1/conversations/:id/operator-messages`):** The lease-owning operator with `conversation:reply` permission sends a human response (`sender_type = 'operator'`) backed by an idempotent `conversation.operator_reply` effect reservation and local channel outbox receipt.
- **Optional Resume (`R08`):** Only the authorized operator may release the takeover lock and return the conversation to automated handling.

## Cross-Domain Onboarding Boundary (`CARE_ONBOARDING_ITINERARY_UNBOUND`)

Automated Sales-to-Care post-purchase onboarding itineraries (`handoff.sales_to_care`) remain explicitly unbound (`CARE_ONBOARDING_ITINERARY_UNBOUND`) pending a formal merchant owner decision. Customer Care handles independent customer-initiated support, FAQ, order status, and human takeover interactions on the shared Customer360 timeline without fabricating an automated onboarding itinerary.
