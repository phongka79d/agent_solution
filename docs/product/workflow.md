# AgentOS 360 — End-to-End Workflow

> Tài liệu mô tả luồng vận hành hoàn chỉnh của hệ thống AgentOS 360, bao gồm Platform Admin, Company Admin, End Customer, Marketing, Sales, Customer Care, Approval, Customer360, Human Takeover, Observability, Recovery và Test Customer Lab.

## 1. Tổng quan

```text
Customer / Company Admin / Platform Admin
                    |
                    v
            Authentication / Session
                    |
                    v
               API / BFF
                    |
                    v
               AgentOS Core
                    |
                    v
           Revenue Orchestrator
                    |
      +-------------+-------------+
      |             |             |
      v             v             v
  Marketing        Sales          Care
      |             |             |
      +-------------+-------------+
                    |
                    v
              Policy / PEP
                    |
                    v
          Approval / Authority
                    |
                    v
                 Skills
                    |
       +------------+------------+
       |            |            |
       v            v            v
    ERP/POS      Knowledge     Channels
       |            |            |
       +------------+------------+
                    |
                    v
         Evidence / Audit / Outcome
                    |
                    v
               Customer360
```

## 2. User types

### Platform Admin

Quản lý toàn bộ nền tảng AgentOS:

- Companies / Tenants
- Provisioning
- Operations
- Provider health
- Usage
- Connector readiness
- Subscription/Billing khi được tích hợp
- System health

### Company Admin

Quản lý AgentOS của chính doanh nghiệp:

- Marketing
- Sales
- Customer Care
- Customer360
- Conversations
- Campaigns
- Approvals
- Human takeover
- Knowledge
- Integrations
- Settings

UI không yêu cầu người dùng chọn `tenant_operator` hay `marketing_approver`. Backend vẫn giữ granular permissions.

### End Customer

Khách cuối tương tác qua:

- Storefront Widget
- Website/App Chat
- Messaging connectors

### AI domains

- Marketing
- Sales
- Customer Care

Không direct Agent-to-Agent. Mọi cross-domain orchestration đi qua Revenue Orchestrator.

---

## 3. Authentication flow

### Company Admin

```text
Company Console
      |
      v
Auth middleware
      |
      +-- valid session --> protected app
      |
      +-- no session ----> /sign-in
                              |
                              v
                       Email + Password
                              |
                              v
                    Backend authentication
                              |
                              v
              Company membership + permissions
                              |
                              v
                     Company Dashboard
```

### Platform Admin

```text
Platform Admin
      |
      v
Auth middleware
      |
      +-- valid session --> Platform Dashboard
      |
      +-- no session ----> /sign-in
```

### Session expiry

```text
Protected page
      |
      v
Session expired
      |
      v
/sign-in
      |
      v
"Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
```

### Logout

```text
Logout
  |
  v
Invalidate session
  |
  v
Clear cookie
  |
  v
/sign-in
```

---

## 4. Company onboarding

```text
Platform Admin creates tenant
      |
      v
Company Admin first login
      |
      v
Setup Workspace
      |
      +--> Company profile
      +--> Product / ERP source
      +--> Knowledge
      +--> LLM provider
      +--> Channels
      +--> Test Agents
      |
      v
Activate
```

### Company profile

- Company name
- Industry
- Locale
- Timezone
- Currency
- Brand profile

### Product / business data

Possible sources:

- Shopify
- ERP/POS
- Custom API
- CSV / Manual Catalog

Authoritative business data such as price, stock, order state must come from Source of Record, not from the LLM.

### Knowledge

Examples:

- FAQ
- Shipping
- Returns
- Warranty
- Brand voice
- Sales guideline
- Marketing guideline
- Authority policy

Lifecycle:

```text
Draft -> Review -> Approved -> Available to Agents
```

### LLM configuration

- Provider
- Base URL
- API Key
- Reasoning model
- Fast model
- Timeout
- Token budget

Secrets never go to the browser.

---

# 5. Test Customer Lab

## 5.1 Purpose

Add a dedicated page in Tenant Console for creating synthetic customers used for:

- Demo
- QA
- Sales tests
- Care tests
- Marketing segmentation tests
- Customer360 tests
- Consent tests
- Human takeover tests
- Cross-customer isolation tests

Recommended route:

```text
/testing/customers
```

All records created from this page must be visibly and server-side classified as:

```text
TEST
```

Do not infer test data from names such as `Alice Demo`.

## 5.2 Access

Recommended:

```text
testdata:manage
```

Or initially restrict to:

```text
DEMO_MODE=true
APP_ENV=local|ci
```

The feature must never allow a browser user to override `tenant_id`.

## 5.3 Create Test Customer form

### Identity

- Full name
- Email
- Phone
- Locale
- Timezone

### Profile

- Segment
- Lifecycle stage
- Tags
- Acquisition source

### Consent

- Email marketing: Granted / Denied
- SMS marketing: Granted / Denied
- WhatsApp: Granted / Denied
- Transactional messages: Granted / Denied

### Optional Sales seed

- Interested category
- Budget
- Currency
- Use case
- Viewed products
- Cart state

### Optional Order seed

- Create sample order: Yes / No
- Order reference
- Status
- Currency
- Total
- Items
- Shipping status

### Optional Care seed

- Open support case
- Escalation requested
- Previous FAQ topic

### Optional Marketing seed

- Last active date
- Inactive days
- Campaign eligibility
- Suppression status

## 5.4 Create customer flow

```text
Company Admin
     |
     v
Test Customer Lab
     |
     v
Fill form
     |
     v
Validate
     |
     v
Preview synthetic data
     |
     v
Create Test Customer
     |
     v
Server creates:
- customer
- profile
- consent
- optional orders
- optional events
- optional support case
     |
     v
Customer360 projection
     |
     v
Ready for testing
```

## 5.5 Success state

Show:

```text
Customer created

Name: Alice Demo
Environment: TEST

[ Open Customer360 ]
[ Launch Storefront as this customer ]
[ Create another ]
```

Customer UUID belongs in Advanced Details, not as the main label.

## 5.6 Quick actions

Each test customer may support:

- Open Customer360
- Launch Storefront
- Send Marketing Signal
- Create Product View Event
- Create Cart Event
- Create Purchase Event
- Create Support Request
- Request Human Agent
- Create Sample Order
- Revoke Consent
- Reset Customer
- Delete Test Customer

All actions go through server APIs. Never fake success with local React state.

## 5.7 Launch as customer

```text
Company Admin
     |
     v
Select TEST customer
     |
     v
Launch Storefront
     |
     v
Server issues scoped widget session
     |
     v
Storefront
```

Session must be server-bound to:

```text
tenant_id
customer_id
session_id
```

Browser cannot set `verified_customer_id`.

## 5.8 Cross-customer isolation

```text
Customer A owns ORD-A
Customer B owns ORD-B

Launch as Customer B
        |
        v
Ask "Where is ORD-A?"
        |
        v
Care ownership check
        |
        v
DENY
```

Do not leak:

- Customer A identity
- Order items
- Order amount
- Order status
- Address

## 5.9 Reset

```text
Reset Test Data
      |
      v
Confirm
      |
      v
Delete TEST entities only
      |
      v
Preserve tenant configuration
```

Never delete production data.

## 5.10 Proposed API

This is a product/API proposal and must be aligned with the actual implementation before coding:

```text
POST   /api/v1/testing/customers
GET    /api/v1/testing/customers
GET    /api/v1/testing/customers/:customerId
DELETE /api/v1/testing/customers/:customerId

POST   /api/v1/testing/customers/:customerId/events
POST   /api/v1/testing/customers/:customerId/orders
POST   /api/v1/testing/customers/:customerId/consent
POST   /api/v1/testing/customers/:customerId/widget-session
POST   /api/v1/testing/reset
```

Every endpoint must:

- Server-bind tenant
- Respect RLS
- Operate only on TEST records
- Audit mutations
- Refuse client-supplied verified identity

---

## 6. Company dashboard

Primary information:

```text
Needs Attention
AI Team
Recent Activity
Useful Metrics
```

Do not make the business dashboard look like an engineering console.

### Needs Attention

Possible sources:

- Pending approval
- Human handoff
- Provider unavailable
- Connector unconfigured
- Policy configuration required

Example:

```text
1 campaign needs approval
2 conversations need human support
1 integration needs configuration
```

---

## 7. AI Team

```text
AI Team

Marketing
Sales
Customer Care
```

Each domain shows:

- Status
- Current activity
- Needs attention
- Recent work
- Configuration
- Advanced details

---

## 8. Marketing workflow

```text
Campaign Brief
     |
     v
Marketing Agent
     |
     v
Analyze Signal
     |
     v
Segment Customer360
     |
     v
Audience
     |
     v
LLM Content Proposal
     |
     v
Brand / Compliance
     |
     v
Consent
     |
     v
Campaign Draft
     |
     v
Human Approval
```

### Approval

```text
Approval Center
      |
      v
Review campaign
      |
      +--> Reject -> stop + audit
      |
      +--> Approve
              |
              v
         Signed approval
              |
              v
        Revalidate payload
              |
              v
        Revalidate consent
              |
              v
            Dispatch
```

If outbound provider is unavailable:

```text
Approved
Publishing not integrated / not configured
```

Never fake delivery.

---

## 9. Sales workflow

Customer:

```text
"I need a laptop under 20 million VND for graphic design."
```

Flow:

```text
Storefront
   |
   v
API
   |
   v
LLM structured understanding
   |
   v
Sales Agent
   |
   v
Revenue Orchestrator
```

Example proposal:

```json
{
  "category": "laptop",
  "budget": {
    "amount": 20000000,
    "currency": "VND"
  },
  "use_case": "graphic design"
}
```

LLM does not own:

- Real price
- Real stock
- tenant_id
- customer_id
- authority
- approval
- skill execution

### Recommendation

```text
search_product
      |
      v
Catalog
      |
      v
check_stock
      |
      v
Inventory
      |
      v
check_price
      |
      v
Pricing SoR
      |
      v
recommend_product
      |
      v
Grounded response
```

Anonymous advice needs neither verified identity nor marketing consent. The advisor keeps the
catalog-selected SKU through stock, price, and recommendation reads. Its response joins the
recommended SKU to the same run's successful Pricing SoR receipt and labels the exact
`list_price` as **Giá niêm yết ERP**, citing both recommendation and pricing evidence.
It never substitutes a model-proposed amount, discount, or another SKU's price; unavailable
pricing refuses the advisor request rather than returning a stock-only answer.


### Create order

```text
Customer wants to buy
       |
       v
Sales proposes order
       |
       v
AUTH check
       |
       v
AUTH-4
       |
       v
Human Approval
       |
       v
Revalidate
       |
       v
ERP create_order
       |
       v
Receipt + Evidence
```

---

## 10. Customer Care workflow

### FAQ

```text
Customer question
      |
      v
Care Agent
      |
      v
Intent
      |
      v
Approved Knowledge
      |
      v
Grounded response
```

### Order lookup

```text
"Where is ORD-123?"
      |
      v
Identity verification
      |
      +--> not verified -> refuse
      |
      +--> verified
              |
              v
         ownership check
              |
              +--> wrong customer -> deny
              |
              +--> owner
                      |
                      v
                    ERP
                      |
                      v
                  Response
```

---

## 11. Human takeover

```text
Customer:
"I want to speak to a person."
        |
        v
Care
        |
        v
Human escalation
        |
        v
Durable handoff
        |
        v
Conversation = NEEDS HUMAN
```

Company Admin:

```text
Conversation
     |
     v
Take over
     |
     v
Human owns conversation
     |
     v
AI paused
```

After handling:

```text
Resume AI
   |
   v
Release takeover
   |
   v
AI resumes
```

Audit records actor, timestamp and state changes.

---

## 12. Conversation Workspace

Desktop:

```text
+----------------+------------------------+------------------+
| Conversations  | Conversation           | Customer         |
|                |                        |                  |
| Alice          | Customer: ...          | Alice            |
| Bob            | AI: ...                | Segment          |
| Carol          |                        | Orders           |
|                | [Take over]            |                  |
|                | [Reply...]             | Recent activity  |
+----------------+------------------------+------------------+
```

Full Customer360 opens separately.

---

## 13. Customer360

Includes:

- Identity
- Profile
- Consent
- Orders
- Conversations
- Campaign activity
- Sales recommendations
- Support cases
- Recent activity

Timeline:

```text
Product viewed
    |
    v
Marketing interaction
    |
    v
Sales conversation
    |
    v
Recommendation
    |
    v
Order
    |
    v
Care conversation
```

Advanced classification:

```text
FACT
SIGNAL
HYPOTHESIS
DECISION
ACTION
```

Never promote HYPOTHESIS into FACT just because an LLM generated it.

---

## 14. Cross-domain flow

No direct A2A.

```text
Marketing -> Revenue Orchestrator -> Sales
Sales     -> Revenue Orchestrator -> Care
Care      -> Revenue Orchestrator -> Retention
```

### Marketing -> Sales

```text
Campaign / Signal
      |
      v
Customer interaction
      |
      v
Revenue Orchestrator
      |
      v
Sales
```

### Sales -> Care

```text
Sale completed
      |
      v
Revenue Orchestrator
      |
      v
Care onboarding
```

One product decision remains open: what exactly Care should do after a sale.

Possible choices:

- Welcome
- Order onboarding
- Usage guide
- Support case
- Timed follow-up

Do not hardcode this business decision just for a demo.

---

## 15. Approval and governance

```text
Agent proposes action
       |
       v
Authority check
       |
       v
AUTH-4
       |
       v
Pause
       |
       v
Approval Center
       |
       +--> Reject -> Stop + Audit
       |
       +--> Approve
                |
                v
           Signed Approval
                |
                v
           Payload re-check
                |
                v
              Execute
```

If payload changes after approval:

```text
STALE APPROVAL -> reject
```

AUTH-5 remains terminal deny.

---

## 16. Controlled autonomy

Possible low-risk candidates:

- Catalog read
- Stock read
- Verified customer context
- FAQ retrieval
- Segmentation
- Draft preparation

Do not auto-promote:

- Create cart
- Create order
- Outbound messaging
- Campaign publish
- Refund
- Discount changes
- Raw export
- Any AUTH-4 action

Promotion:

```text
Skill
 |
 v
Evidence window
 |
 v
Zero violations?
Zero duplicate effects?
Cost acceptable?
Latency acceptable?
 |
 v
Human approval
 |
 v
Versioned policy
 |
 v
Promoted
```

Demotion triggers:

- Policy violation
- Duplicate effect
- Provider ambiguity
- Drift
- Evidence gap

---

## 17. Integrations

### ERP / POS

```text
Company Admin
     |
     v
Integrations
     |
     v
Connect ERP
     |
     v
Test
     |
     v
Catalog / Inventory / Customers / Orders
```

### Shopify

```text
Connect Shopify
      |
      v
Auth
      |
      v
Catalog sync
      |
      v
Inventory sync
      |
      v
Order observations
```

### Messaging

```text
Website / Email / WhatsApp / Zalo / Messenger
                        |
                        v
                     API-003
                        |
                        v
                     AgentOS
```

---

## 18. LLM provider flow

```text
Agent cognitive request
       |
       v
OpenAI-compatible adapter
       |
       v
Provider
       |
       +--> valid structured output
       +--> timeout
       +--> 429
       +--> 5xx
       +--> invalid JSON
```

Failure:

```text
bounded retry
     |
     v
still failing
     |
     v
fail closed
```

Never invent structured output.

---

## 19. External effect safety

Every external mutation follows:

```text
Action
  |
  v
effect_key
  |
  v
Reserve
  |
  v
Provider call
  |
  +--> success -> COMMITTED
  |
  +--> unknown -> UNKNOWN -> Reconcile
```

No blind retry of UNKNOWN effects.

Duplicate protection:

```text
same effect_key
     |
     v
existing reservation
     |
     v
do not execute twice
```

---

## 20. Observability

Advanced trace:

```text
SIGNAL
  |
  v
CONTEXT
  |
  v
HYPOTHESIS
  |
  v
DECISION
  |
  v
PLAN
  |
  v
ACTION
  |
  v
APPROVAL
  |
  v
EXECUTION
  |
  v
EVIDENCE
  |
  v
OUTCOME
  |
  v
LEARNING
```

May show:

- run_id
- correlation_id
- agent
- skill
- provider
- model
- latency
- tokens
- authority
- effect_key

Never log secrets.

---

## 21. Worker recovery

```text
Worker running
     |
     v
Crash
     |
     v
Restart
     |
     v
Durable workflow
     |
     v
Resume checkpoint
```

No duplicate external action.

---

## 22. Connector failure

Example:

```text
Customer asks price
       |
       v
ERP unavailable
       |
       v
No authoritative price
       |
       v
Unavailable / fail closed
```

LLM must not guess price.

---

## 23. Platform Admin

Target navigation:

```text
Overview
Companies
Operations
Usage
Providers
System Health
Subscriptions
Settings
```

Company directory:

```text
Platform Admin
      |
      v
Companies
      |
      +--> Company A
      +--> Company B
      +--> Company C
```

Each company can expose:

- Subscription
- Agent readiness
- Usage
- Provider state
- Connector state
- Needs attention

Provisioning:

```text
Create Company
      |
      v
Provision Tenant
      |
      v
Workspace
Agents
Namespaces
Policy defaults
Connector slots
Autonomy minimum
      |
      v
Company = NOT CONFIGURED
```

---

## 24. UI status vocabulary

Business-facing:

```text
Hoạt động
Cần chú ý
Chờ phê duyệt
Chưa cấu hình
Chưa tích hợp
Chưa có dữ liệu
Tạm dừng
Lỗi
Demo
Test data
```

Raw technical states belong in Advanced/Trace.

---

## 25. Data classes

Recommended:

```text
PRODUCTION
DEMO
TEST
```

- Demo tenant data -> DEMO
- Test Customer Lab data -> TEST
- Real customer data -> PRODUCTION

---

## 26. Security invariants

Never break:

- Tenant isolation
- RLS
- Verified identity before private lookup
- No direct A2A
- Revenue Orchestrator owns routing
- PEP owns policy enforcement
- AUTH-5 terminal deny
- AUTH-4 explicit approval
- No blind retry UNKNOWN effects
- Idempotency
- Takeover mutex
- Consent enforcement
- Audit / Evidence
- FACT / SIGNAL / HYPOTHESIS separation

---

## 27. Full product flow

```text
Platform Admin
      |
      v
Create Company
      |
      v
Company Admin
      |
      v
Configure Workspace
      |
      +--> ERP / Catalog
      +--> Knowledge
      +--> LLM
      +--> Channels
      |
      v
Activate AI Team

--------------------------------------------

Marketing
Signal
 |
 v
Segment
 |
 v
Generate Content
 |
 v
Approval
 |
 v
Campaign

--------------------------------------------

Sales
Customer Chat
 |
 v
Understand Need
 |
 v
Catalog
 |
 v
Price / Stock
 |
 v
Recommendation
 |
 v
Order

--------------------------------------------

Customer Care
Customer Request
 |
 v
FAQ / Order / Support
 |
 +--> AI resolves
 |
 +--> Human Takeover

--------------------------------------------

Everything
 |
 v
Customer360
 |
 v
Evidence
Audit
Analytics
Learning
```

---

## 28. Daily QA/demo flow with Test Customer Lab

```text
Company Admin
      |
      v
Test Customer Lab
      |
      v
Create TEST customer
      |
      v
Seed profile / consent / order / events
      |
      v
Open Customer360
      |
      v
Launch Storefront
      |
      v
Test Sales
      |
      v
Test Care
      |
      v
Send Marketing signal
      |
      v
Test Marketing Approval
      |
      v
Request Human
      |
      v
Test Takeover
      |
      v
Inspect Trace
      |
      v
Reset TEST customer
```

---

## 29. Definition of Done — Test Customer Lab

The feature is complete when:

- Company Admin can create a TEST customer.
- TEST customer appears in Customer360.
- Consent can be seeded.
- Orders can be seeded.
- Web events can be seeded.
- Storefront can be launched as that customer.
- Sales receives server-verified customer context.
- Care order lookup verifies ownership.
- Customer A cannot read Customer B orders.
- Marketing segmentation can use the synthetic profile.
- Human escalation works.
- Test records carry a server-side TEST marker.
- Test records can be reset/deleted safely.
- Production data cannot be deleted by this flow.
- Tenant isolation remains intact.
- Regression tests exist.

---

## 30. Known technical debt

### Sales turn classifier

```text
apps/api/src/routes/v1/turn-classifier.ts
```

Fallback classification remains too electronics-oriented and should later become industry-agnostic.

### Revenue evidence model id

```text
apps/worker/src/runtime/sales/revenue-evidence-adapter.ts
```

The demo-specific model identifier should become generic/configurable/injected.

---

## 31. Product decision still open

The Sales -> Care onboarding itinerary is still undefined.

Need a product decision for:

```text
Welcome
Order onboarding
Usage guidance
Support case
Timed follow-up
Other
```

Do not invent this inside core just to make the demo look complete.

---

## 32. Core product principle

```text
LLM proposes
AgentOS validates
Orchestrator coordinates
PEP authorizes
Skills execute
Source of Record provides facts
Evidence proves outcome
Customer360 preserves context
Human retains final control over high-risk actions
```
