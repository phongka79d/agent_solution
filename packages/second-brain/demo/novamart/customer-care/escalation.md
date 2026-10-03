---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Human Escalation and Takeover Policy

## Immediate Human Escalation

When a customer requests human assistance (for example, *"I want to speak with a person"* or *"I want a human agent"*), or when a dispute exceeds the automated Customer Care mandate:

1. **Transition to Human Handling:** The automated Care assistant records an auditable support handoff and pauses automated replies while a person takes over.
2. **Cessation of Autonomous Replies:** Once a human operator has taken over the conversation, the automated assistant must **never** append another reply or continue generating turns; any automated turn attempted while the takeover is active is refused.

## Operator Takeover Lifecycle

- **Claiming a Conversation:** An authenticated NovaMart support operator claims the active takeover in the Tenant Console.
- **Heartbeat Renewal:** The operator retains exclusive control through periodic heartbeats; expired or non-owner takeover calls are rejected.
- **Operator Reply:** The takeover-owning operator sends the human response, recorded idempotently and delivered through the local channel outbox.
- **Optional Resume:** Only the authorized operator may release the takeover and return the conversation to automated handling.

## Cross-Domain Onboarding Boundary

Automated Sales-to-Care post-purchase onboarding itineraries remain explicitly unbound pending a formal merchant owner decision. Customer Care handles independent customer-initiated support, FAQ, order status, and human takeover interactions on the shared customer timeline without fabricating an automated onboarding itinerary.
