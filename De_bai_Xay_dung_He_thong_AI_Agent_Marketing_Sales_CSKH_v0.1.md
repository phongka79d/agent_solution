# ĐỀ BÀI XÂY DỰNG HỆ THỐNG AI AGENT
## Marketing - Sales - Chăm sóc khách hàng

**Mã tài liệu:** AI-REV-SRS-001  
**Phiên bản:** 0.1  
**Trạng thái:** Baseline đề bài triển khai  
**Phạm vi:** AI Revenue & Customer Engagement Platform  
**Ngày:** 15/09/2026

---

## 1. Mục tiêu tổng thể

Xây dựng một hệ thống **AI Agent kinh doanh thống nhất** vận hành xuyên suốt chuỗi:

**Dữ liệu/Signal → Customer 360 → Marketing → Lead/Opportunity → Sales → Order → Chăm sóc khách hàng → Retention/Expansion → Outcome → Learning**

Hệ thống không phải ba chatbot độc lập. Marketing, Sales và Chăm sóc khách hàng phải dùng chung dữ liệu khách hàng, chính sách, quyền hạn, knowledge base, workflow và cơ chế đo kết quả.

### Mục tiêu kinh doanh

- **OBJ-001 - Marketing:** Tự động phát hiện cơ hội, lập kế hoạch, tạo nội dung, vận hành chiến dịch, đánh giá kết quả và tối ưu Marketing.
- **OBJ-002 - Sales:** Nhận diện nhu cầu, tư vấn, nuôi dưỡng, chấm điểm cơ hội, đề xuất sản phẩm, cross-sell/upsell, phục hồi giỏ hàng và hỗ trợ chuyển đổi thành đơn.
- **OBJ-003 - Customer Care:** Tiếp nhận và xử lý phần lớn yêu cầu khách hàng, tra cứu dữ liệu giao dịch thực, hỗ trợ đơn hàng, khiếu nại, hậu mãi và chuyển người khi cần.
- **OBJ-004 - Customer Success/Retention:** Phát hiện nguy cơ mất khách, nhu cầu mua lại, khả năng mở rộng doanh thu và chủ động thực hiện next-best-action.
- **OBJ-005 - Orchestration:** Nhiều AI Agent phải phối hợp theo workflow thay vì hoạt động độc lập.
- **OBJ-006 - Governance:** Mọi hành động AI phải có nguồn dữ liệu, lý do, quyền thực hiện, policy, log, bằng chứng và kết quả.

## 2. Nguyên tắc phạm vi

### 2.1 Không xây lại hệ thống giao dịch lõi

ERP/POS/Web/App hiện có tiếp tục là **System of Record** cho sản phẩm, SKU/biến thể, giá, tồn kho, khách hàng, đơn hàng, hóa đơn, giao dịch, thanh toán và giao hàng.

AI Platform phải tích hợp và sử dụng các hệ thống nguồn; không được tạo dữ liệu song song rồi coi đó là dữ liệu thật.

### 2.2 Hệ thống AI chịu trách nhiệm

- Thu nhận và hợp nhất tín hiệu khách hàng.
- Xây Customer Intelligence 360.
- Ra quyết định và lập kế hoạch hành động.
- Phối hợp nhiều Agent/Skill/Tool.
- Thực thi có giới hạn theo policy và authority.
- Đo evidence, outcome, attribution và learning.

## 3. Kiến trúc logic tổng thể

```text
CUSTOMER / MARKET
      │
      ├── Social
      ├── Web / App
      ├── Messaging
      └── Offline / POS signal
      │
      ▼
DATA & SIGNAL INGESTION
      │
      ▼
CUSTOMER INTELLIGENCE 360
      │
      ├─────────────┬──────────────┐
      ▼             ▼              ▼
MARKETING AI     SALES AI       CARE / CS AI
      └─────────────┼──────────────┘
                    ▼
          REVENUE ORCHESTRATOR
                    │
        Decision / Plan / Action
                    │
             POLICY ENGINE
                    │
          AUTHORITY / APPROVAL
                    │
                    ▼
              EXECUTION LAYER
                    │
   ERP/POS | Web/App | Zalo | Social | Email/SMS
                    │
                    ▼
      EVIDENCE → OUTCOME → LEARNING
```

## 4. Các khối chức năng bắt buộc

1. Customer Intelligence 360.
2. Marketing AI Agents.
3. Sales AI Agents.
4. Customer Care / Customer Success AI Agents.
5. Revenue Orchestrator.
6. Knowledge Base & Skill System.
7. Policy / Authority / Approval.
8. Evidence / Evaluation / Learning.
9. Human Command Center.
10. Connector & Integration Layer.

## 5. Customer Intelligence 360

### FR-C360-001 - Hồ sơ khách hàng thống nhất - MUST

Mỗi khách hàng phải có hồ sơ Customer 360 chứa tối thiểu: thông tin định danh, lịch sử mua, sản phẩm đã mua, hành vi Web/App, tương tác Marketing, hội thoại, ticket CSKH, phản hồi, giỏ hàng, voucher/offer, lần mua gần nhất, tần suất mua, giá trị mua, consent và trạng thái lifecycle.

### FR-C360-002 - Timeline thống nhất - MUST

Hệ thống phải tạo timeline khách hàng gồm các sự kiện có thể truy vết như: View → Search → Click → Chat → Add to cart → Purchase → Delivery → Support → Review → Repurchase.

### FR-C360-003 - Evidence separation - MUST

AI phải phân biệt rõ:

- **FACT:** dữ liệu đã xác minh.
- **SIGNAL:** dấu hiệu quan sát được.
- **HYPOTHESIS:** giả thuyết AI.
- **DECISION:** quyết định đã được hệ thống tạo.
- **ACTION:** hành động dự kiến hoặc đã thực thi.

**Giả thuyết AI không được ghi ngược thành Customer Fact.**

## 6. Marketing AI Agent System

### MKT-01 - Marketing Strategist

Nhiệm vụ: phân tích mục tiêu kinh doanh, lập kế hoạch Marketing, xác định campaign, audience, channel, KPI và đề xuất ưu tiên.

### MKT-02 - Audience Intelligence Agent

Phân tích cohort/segment dựa trên dữ liệu hành vi và giao dịch như: khách mới, khách quay lại, high-value, dormant, churn-risk, product affinity. Không sử dụng suy đoán nhạy cảm hoặc profiling không được phép.

### MKT-03 - Content Agent

Tạo nội dung cho social, TikTok/Reels, quảng cáo, email, landing page, SMS/Zalo và sản phẩm theo brief và brand policy.

### MKT-04 - Brand Guardian

Kiểm soát tone of voice, thuật ngữ, thông tin thương hiệu, claim, giá, promotion và prohibited content.

### MKT-05 - Campaign Agent

Workflow mục tiêu: **Brief → Audience → Content → Review → Approval → Publish → Monitor → Optimize**.

### MKT-06 - Marketing Analyst

Theo dõi impressions, reach, click, lead, conversion, CAC, revenue, repeat purchase và attribution.

## 7. Sales AI Agent System

### SAL-01 - Lead Qualification Agent

**FR-SAL-001 - MUST:** xác định khách mới/cũ, nhu cầu, sản phẩm quan tâm, mức độ sẵn sàng mua, hành vi gần nhất, lịch sử mua và cơ hội bán; kết quả phải có reason + evidence.

### SAL-02 - AI Sales Advisor

**FR-SAL-002 - MUST:** AI được phép hỏi nhu cầu, tìm/so sánh sản phẩm, kiểm tra tồn, kiểm tra giá, giải thích chính sách, đề xuất sản phẩm và sản phẩm bổ sung. Giá và tồn phải lấy từ nguồn dữ liệu có thẩm quyền; không tự suy diễn.

### SAL-03 - Recommendation Agent

**FR-SAL-003 - MUST:** hỗ trợ product recommendation, cross-sell, upsell, substitute, replenishment và bundle. Mỗi recommendation phải có customer, product, reason, evidence, eligibility, confidence và expected outcome.

### SAL-04 - Cart Recovery Agent

Phát hiện abandoned cart, kiểm tra customer, consent, tồn, giá, suppression rule, chọn channel, tạo message/action và đo conversion.

### SAL-05 - Reorder / Replenishment Agent

Phân tích chu kỳ mua để phát hiện nhu cầu mua lại. Không được gửi nếu khách từ chối marketing, sản phẩm không còn bán, tồn kho không phù hợp, khách vừa mua lại hoặc bị suppression.

## 8. Customer Care & Customer Success AI

### CS-01 - Omnichannel Customer Care Agent

Tiếp nhận Web Chat, App, social inbox, Zalo, email và các connector được phê duyệt.

**FR-CS-001 - MUST:** nhận biết tối thiểu các intent: hỏi sản phẩm, giá, tồn, trạng thái đơn, giao hàng, đổi/trả, thanh toán, khiếu nại, hỗ trợ sử dụng và yêu cầu gặp nhân viên.

### Case Management

Mỗi case cần có: Case ID, Customer, Intent, Priority, Conversation, Related Order, Evidence, Owner, Status, SLA, Resolution, Outcome.

State tối thiểu: **NEW → CLASSIFIED → ASSIGNED → IN_PROGRESS → WAITING_CUSTOMER → RESOLVED → CLOSED**.

**FR-CS-002 - MUST:** Agent phải biết khi nào tự trả lời, khi nào cần tra cứu, khi nào cần hành động, khi nào chuyển Agent khác và khi nào phải chuyển người.

### CS-02 - Retention / Customer Success Agent

Phát hiện inactivity, giảm tần suất mua, dissatisfaction, failed order, repeated complaint, replenishment opportunity và win-back opportunity.

**FR-CS-003 - MUST:** workflow chuẩn: **Signal → Hypothesis → Recommended Action → Eligibility Check → Execution/Approval → Outcome**.

## 9. Revenue Orchestrator

Revenue Orchestrator là lớp điều phối trung tâm; không để Agent tự gọi lẫn nhau tùy ý.

Chu trình chuẩn:

**SIGNAL → CONTEXT → HYPOTHESIS → DECISION → PLAN → ACTION → APPROVAL → EXECUTION → EVIDENCE → OUTCOME → LEARNING**

### FR-ORC-001 - Routing - MUST

Orchestrator phải xác định Agent nào xử lý, skill nào dùng, dữ liệu nào được truy cập, tool nào được gọi và có cần approval hay không.

### FR-ORC-002 - Multi-Agent Workflow - MUST

Hệ thống phải hỗ trợ workflow xuyên Agent, ví dụ abandoned cart → Sales phát hiện → Customer 360 lấy context → Recommendation chọn sản phẩm → Policy kiểm tra → Communication tạo nội dung → Approval nếu cần → Connector gửi → Order → Outcome.

## 10. Knowledge Base / Second Brain

AI Agent không được chỉ dựa vào kiến thức nội tại của LLM. Cần knowledge base có cấu trúc tối thiểu:

```text
/company
  company.md
  positioning.md
/customer
  customer.md
  segmentation.md
/product
  products.md
  pricing.md
  promotion-policy.md
/brand
  voice.md
  terminology.md
  prohibited-claims.md
/marketing
  playbook.md
  content-guidelines.md
  campaign-rules.md
/sales
  sales-playbook.md
  qualification.md
  objection-handling.md
/customer-care
  faq.md
  support-policy.md
  escalation.md
/policy
  authority.md
  approval.md
```

## 11. Skill System

Agent và Skill phải tách riêng. Ví dụ Sales Agent có thể dùng các skill: search-product, check-stock, check-price, retrieve-customer, recommend-product, create-cart, create-order, send-message.

Mỗi Skill phải định nghĩa tối thiểu:

- Skill ID.
- Purpose.
- Input / Output.
- Allowed Agent.
- Required Authority.
- Tool / Connector.
- Validation.
- Retry Policy.
- Timeout.
- Audit.
- Test Cases.

## 12. Authority Model

- **AUTH-0 - Observe:** chỉ đọc dữ liệu.
- **AUTH-1 - Recommend:** phân tích và đề xuất.
- **AUTH-2 - Draft:** tạo nội dung/hành động nháp.
- **AUTH-3 - Bounded Execute:** tự thực thi trong phạm vi đã phê duyệt.
- **AUTH-4 - Approval Required:** chuẩn bị hành động nhưng cần người phê duyệt.
- **AUTH-5 - Prohibited:** tuyệt đối không được thực hiện.

Ví dụ AUTH-3: trả lời FAQ, tra cứu trạng thái đơn, gửi reminder được phép.  
Ví dụ AUTH-4: campaign lớn, discount vượt ngưỡng, compensation, refund, thay đổi điều khoản.

## 13. Business Rules bắt buộc

- **BR-001:** AI không được tự tạo giá sản phẩm.
- **BR-002:** AI không được tự thay đổi giá hoặc discount ngoài policy.
- **BR-003:** Giá và tồn kho phải lấy từ nguồn giao dịch có thẩm quyền.
- **BR-004:** Không gửi marketing khi khách hàng không có consent phù hợp.
- **BR-005:** Một action có tác động bên ngoài phải có unique execution ID.
- **BR-006:** Retry không được tạo hành động trùng lặp.
- **BR-007:** Hành động tài chính/rủi ro cao phải qua approval.
- **BR-008:** Agent không được vượt quyền kể cả khi LLM yêu cầu.
- **BR-009:** Prompt/nội dung do khách hàng cung cấp không thể tự nâng quyền Agent.
- **BR-010:** Mọi execution quan trọng phải sinh evidence.

## 14. Data Model cốt lõi

Customer, Customer Identity, Consent, Customer Event, Product, SKU, Price, Inventory, Order, Invoice, Conversation, Lead, Opportunity, Campaign, Segment, Offer, Recommendation, Service Case, Agent, Skill, Workflow, Decision, Action, Approval, Execution, Evidence, Outcome, Learning.

## 15. Tích hợp hệ thống

### API-001 - ERP/POS

Cho phép đọc theo quyền: product, SKU, price, inventory, customer, order, invoice và sales history; các mutation phải đi qua API/action được kiểm soát.

### API-002 - Web/App

Nhận các event tối thiểu: session, product_view, search, click, add_to_cart, checkout, purchase.

### API-003 - Communication

Thiết kế connector architecture cho Facebook, TikTok, Zalo, Email, SMS và Web/App Chat.

**[UNCONFIRMED][ASM-001]** Danh sách connector production sẽ được chốt theo tài khoản, API, quyền và chính sách nền tảng thực tế.

## 16. AI Memory

Phải phân biệt:

- Working Memory - context của task hiện tại.
- Customer Context - dữ liệu khách hàng được phép sử dụng.
- Organizational Knowledge - knowledge base doanh nghiệp.
- Agent Operational Memory - trạng thái workflow.
- Learning Memory - kết quả hành động trước.

Không cho phép AI tự ghi toàn bộ hội thoại thành fact lâu dài.

## 17. Observability & Audit

Mỗi Agent Run phải ghi tối thiểu: Run ID, Agent, Customer/Entity, Trigger, Context, Skill, Tool, Decision, Authority, Approval, Action, Execution Status, Evidence, Outcome, Latency, Cost, Error và Timestamp.

## 18. Human Command Center

### SCR-001 - Executive Dashboard

Hiển thị Revenue, Leads, Conversion, Active Campaigns, AI Generated Revenue, CS status, Retention, AI Actions, Approval Pending và Abnormal Events.

### SCR-002 - Agent Operations

Hiển thị Agent online/offline, task hiện tại, run history, error, tool call, cost và KPI.

### SCR-003 - Approval Center

Cho phép: **Approve / Reject / Modify / Pause / Cancel**.

### SCR-004 - Customer 360

Hiển thị một khách hàng theo timeline thống nhất và các evidence liên quan.

### SCR-005 - Conversation Console

Con người có thể xem AI chat, takeover, trả lại Agent, sửa câu trả lời và đánh giá kết quả.

## 19. Non-functional Requirements

- **NFR-001 - Security - MUST:** Agent chỉ truy cập dữ liệu và tool theo quyền; không có test case cho phép vượt authority boundary.
- **NFR-002 - Auditability - MUST:** 100% hành động tạo thay đổi bên ngoài phải có audit/evidence record.
- **NFR-003 - Idempotency - MUST:** thực hiện lại cùng execution request không được tạo giao dịch ngoài ý muốn lần hai.
- **NFR-004 - Availability:** workflow quan trọng phải có retry, timeout và recovery.
- **NFR-005 - Explainability:** quyết định quan trọng phải lưu reason + evidence.
- **NFR-006 - Data Isolation:** dữ liệu khách A không được xuất hiện trong context khách B.
- **NFR-007 - Human Override:** con người phải có khả năng pause hoặc takeover workflow.
- **NFR-008 - Failure Safety - MUST:** khi không xác minh được giá, tồn, authority hoặc consent, hệ thống phải fail closed.
- **NFR-009 - Performance:** hội thoại thông thường phải được thiết kế cho phản hồi gần thời gian thực; SLA chính thức khóa sau benchmark.
- **NFR-010 - Cost Observability:** đo token, model, API/tool cost, cost/run, cost/customer và cost/conversion.

## 20. KPI

### Marketing
Campaign Revenue, Lead Conversion, CAC, ROAS, Cost per Lead, Engagement, Qualified Lead Rate.

### Sales
Lead-to-Order Conversion, Cart Recovery Rate, Recommendation Conversion, Upsell Revenue, Cross-sell Revenue, Average Order Value, Sales Cycle.

### Customer Care
First Response Time, Resolution Time, AI Resolution Rate, Escalation Rate, Reopen Rate, Customer Satisfaction.

### Customer Success
Repeat Purchase, Retention, Reactivation, Churn, Customer Lifetime Value.

### AI System
Autonomous Completion Rate, Human Override Rate, Policy Violation Rate, Hallucination/Error Rate, Cost per Successful Outcome, Failed Execution và Duplicate Execution.

**[UNCONFIRMED][ASM-002]** KPI target cụ thể phải được thiết lập sau khi lấy baseline dữ liệu thực tế.

## 21. MVP / Acceptance Pilot

### PILOT-01 - Marketing → Sales

Customer Signal → Segment → Campaign → Content → Approval → Send/Publish → Customer Response → Sales Conversation → Recommendation → Order → Revenue Evidence.

### PILOT-02 - Cart Recovery

Abandoned Cart → Customer Context → Eligibility → Recommendation → Message → Conversion → Order → Attribution.

### PILOT-03 - Customer Care

Customer Question → Intent Detection → Customer Identification → ERP/Order Lookup → AI Resolution → Customer Response → Case Outcome.

### PILOT-04 - Escalation

Complaint → Classification → Policy Check → AI unable/unauthorized → Human Escalation → Resolution → Outcome.

## 22. Acceptance Criteria cấp hệ thống

- **TC-E2E-001:** Một signal đi hết Signal → Decision → Action → Execution → Evidence → Outcome.
- **TC-E2E-002:** Marketing Agent không thể publish nếu thiếu authority/approval yêu cầu.
- **TC-E2E-003:** Sales Agent không thể đưa giá không có trong nguồn dữ liệu chính thức.
- **TC-E2E-004:** Customer Care Agent chỉ tra cứu dữ liệu đúng customer đã được xác minh.
- **TC-E2E-005:** Retry action không tạo message/order trùng.
- **TC-E2E-006:** Agent cố vượt quyền phải bị DENY và sinh audit event.
- **TC-E2E-007:** Customer không có consent phù hợp phải bị suppression.
- **TC-E2E-008:** Connector lỗi phải chuyển failure/retry, không được ghi success giả.
- **TC-E2E-009:** Mỗi action thành công truy ngược được Trigger → Context → Decision → Approval → Execution → Evidence → Outcome.

## 23. Phạm vi không xây lại

Không xây lại ERP, POS, kho, kế toán, Web Commerce core, Payment core, ứng dụng giao hàng hoặc master product system. AI Platform phải tích hợp và sử dụng các hệ thống này.

## 24. Lộ trình triển khai theo Gate

### P0 - Foundation

Canonical contracts, Customer 360, Agent/Skill/Workflow Contract, Authority, Policy, Evidence, Audit và Connector Framework.

**Exit Gate:** Agent chưa cần thông minh nhất nhưng tuyệt đối không được vượt quyền hoặc mất trace.

### P1 - Customer Care Pilot

Conversation Agent, intent, identity, ERP lookup, order status, FAQ và escalation.

**Exit Gate:** một hội thoại thật được xử lý E2E và có evidence.

### P2 - Sales Pilot

Qualification, product search, recommendation, cart recovery, cross-sell, order assistance.

**Exit Gate:** chứng minh AI action → order → revenue evidence.

### P3 - Marketing Pilot

Audience, campaign, content, approval, channel execution và attribution.

### P4 - Cross-domain Orchestration

Kết nối Marketing → Sales → Customer Care/Success → Retention mà không mất customer context.

### P5 - Controlled Autonomy

Action rủi ro thấp đủ qualification được nâng từ Recommend → Draft → Auto Execute; action rủi ro cao vẫn bắt buộc approval.

## 25. Traceability tổng quát

| Business Objective | Nhóm yêu cầu | Validation chính |
|---|---|---|
| OBJ-001 Marketing | MKT-* | PILOT-01 |
| OBJ-002 Sales | FR-SAL-* | PILOT-02 |
| OBJ-003 Customer Care | FR-CS-* | PILOT-03 |
| OBJ-004 Retention | FR-CS-003 | Retention workflow |
| OBJ-005 Orchestration | FR-ORC-* | TC-E2E-001 |
| OBJ-006 Governance | BR-*, NFR-* | TC-E2E-002..009 |

## 26. Assumptions cần khóa trước Production

- **ASM-001:** danh sách connector production. Owner: Product/IT. Action: audit API và quyền hiện có.
- **ASM-002:** KPI baseline và target. Owner: Business. Action: lấy dữ liệu thực tế.
- **ASM-003:** ngưỡng discount/promotion mà AI được phép thực hiện. Owner: Business/Finance.
- **ASM-004:** loại refund/compensation phải phê duyệt. Owner: Finance/Operations.
- **ASM-005:** danh sách dữ liệu Customer 360 được phép lưu lâu dài. Owner: Data/Legal/Product.

## 27. Definition of Done cấp hệ thống

Không coi hệ thống hoàn thành chỉ vì Agent có thể chat.

Một capability chỉ đạt chuẩn khi chứng minh được:

**Data thật + Agent thật + Skill thật + Tool thật + Policy thật + Approval thật + Execution thật + Evidence thật + Outcome thật + Test thật.**

Mục tiêu cuối cùng là xây dựng một **AI Revenue Workforce** có khả năng trực tiếp tham gia vận hành Marketing, Sales và Chăm sóc khách hàng với mức tự động hóa cao, nhưng mọi quyền thực thi đều có giới hạn, có thể kiểm soát và truy vết.

## 28. Handoff triển khai đề xuất

1. Business/BA khóa KPI, connector, approval threshold và dữ liệu được phép sử dụng.
2. Solution Architect khóa canonical contract cho Customer, Agent, Skill, Decision, Action, Approval, Evidence và Outcome.
3. AI Engineering xây Orchestrator, Agent Runtime, Knowledge/Skill framework và evaluation harness.
4. Backend/Integration xây API gateway, event ingestion, connector và idempotent execution.
5. Frontend xây Command Center, Approval Center, Customer 360 và Conversation Console.
6. QA xây acceptance suite từ TC-E2E-001..009 và negative/adversarial tests.
7. Pilot production-like theo thứ tự: Customer Care → Sales → Marketing → Cross-domain → Controlled Autonomy.
