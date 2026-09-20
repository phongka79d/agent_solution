# Dữ liệu khách hàng, bằng chứng và kho kiến thức

[Mục lục](../README.md) · [Kiến trúc](architecture.md) · [Quy trình](workflows-and-handoffs.md) · [API](api-and-integrations.md)

Trạng thái: Bản thiết kế khung gầm kỹ thuật (Platform Blueprint) độc lập thị trường cho dữ liệu khách hàng, bộ nhớ AI và kho tri thức doanh nghiệp.

<a id=section-11></a>

## 1. Hồ sơ khách hàng hợp nhất (Customer 360)

Customer 360 đóng vai trò là tầng tổng hợp thông tin khách hàng đa kênh phục vụ chuỗi điều phối Revenue Orchestrator, tuyệt đối không thay thế hệ thống giao dịch gốc (System of Record: ERP/POS/CRM):

- **FR-C360-001 - Hồ sơ khách hàng thống nhất - MUST**:
  Chứa tối thiểu thông tin định danh (`customer_id`, email, số điện thoại đã mã hóa), lịch sử mua hàng, danh mục sản phẩm quan tâm, hành vi tương tác số từ Web/App (API-002), lịch sử hội thoại từ các kênh tương tác (API-003), ticket CSKH, phản hồi đánh giá, trạng thái giỏ hàng, ưu đãi/voucher khả dụng, chỉ số RFM (Recency, Frequency, Monetary), trạng thái đồng ý liên hệ (consent status) và giai đoạn trong vòng đời khách hàng.
- **FR-C360-002 - Timeline sự kiện thống nhất - MUST**:
  Chuỗi sự kiện truy vết thời gian thực xuyên suốt hành trình khách hàng:
  `View` → `Search` → `Click` → `Chat` → `Add to cart` → `Purchase` → `Delivery` → `Support` → `Review` → `Repurchase`.
  Mỗi sự kiện được gắn nhãn thời gian chuẩn ISO 8601, mã nguồn kênh và thẻ bằng chứng (Evidence Card).

**Nguyên tắc truy cập:** Mọi truy vấn hồ sơ khách hàng hoặc đơn hàng chỉ được thực hiện sau khi xác minh định danh khách hàng thành công (Customer Verification - TC-E2E-004); truy vấn khi chưa xác minh phải fail closed (NFR-008).

### Nguồn dữ liệu có thẩm quyền (System of Record)

| Nguồn hệ thống | Dữ liệu thẩm quyền chính thức | Nguyên tắc quản trị |
|---|---|---|
| Hệ thống quản trị doanh nghiệp (ERP/POS qua API-001) | Danh mục sản phẩm, SKU, giá niêm yết, tồn kho thời gian thực, đơn hàng và hóa đơn | Nguồn sự thật duy nhất về giá và tồn kho; AI không được tự ý sửa đổi |
| CRM doanh nghiệp (API-001) | Tài khoản khách hàng, liên hệ, cơ hội bán hàng và người phụ trách | Đồng bộ hai chiều có kiểm soát; không ghi đè trường quản trị |
| Cổng thanh toán (Payment Connector interface; adapter cụ thể như ADPT-TW-001 / ADPT-GL-002 là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]**) | Mã giao dịch, số tiền thanh toán, trạng thái đối soát thực tế | Đối soát ngân hàng/cổng; chỉ chấp nhận trạng thái từ webhook có chữ ký số |
| Hệ thống giao vận & Siêu thị CVS (Logistics Connector interface; adapter cụ thể theo thị trường là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]**) | Mã vận đơn bưu bưu, trạng thái giao nhận, mã cửa hàng nhận hàng COD | Dữ liệu hành trình vật lý độc lập từ đối tác vận tải |
| Cổng thu nhận sự kiện số (API-002) | Dòng sự kiện hành vi: phiên truy cập, xem trang, tương tác giỏ | Nạp dòng sự kiện thời gian thực vào Customer 360 Timeline |
| Tầng dữ liệu nền tảng Core Engine | Liên kết danh tính, phiên chat, trạng thái workflow, thẻ bằng chứng, suy luận AI | Lưu vết phục vụ điều phối; không ghi đè dữ liệu tài chính gốc |

### Mô hình dữ liệu cốt lõi (Canonical Data Model — 28 Thực thể chuẩn SRS)

Tuân thủ Mục 14 của SRS (AI-REV-SRS-001), hệ thống chuẩn hóa 28 thực thể dữ liệu phân định theo 4 miền nghiệp vụ, xác định rõ nguồn dữ liệu có thẩm quyền (System of Record - SoR) và ranh giới quản lý của AI Platform:

| STT | Thực thể (Entity) | Miền dữ liệu (Domain) | Nguồn thẩm quyền (System of Record) | Vai trò & Ranh giới trong AI Platform |
|---|---|---|---|---|
| 1 | **Customer** | Customer & Identity | CRM / ERP (API-001) | Hồ sơ tổng thể khách hàng; AI liên kết đa kênh qua Customer 360 |
| 2 | **Customer Identity** | Customer & Identity | Identity Service / SSO | Định danh hợp nhất (email, phone hash, LINE UID, cookie UUID) |
| 3 | **Consent** | Customer & Identity | Consent Store / Legal | Trạng thái đồng ý tiếp thị/liên lạc; kiểm tra bắt buộc trước mọi tương tác (BR-004) |
| 4 | **Customer Event** | Customer & Identity | Event Ingestion (API-002) | Dòng sự kiện hành vi số (view, click, cart, purchase) gắn nhãn ISO 8601 |
| 5 | **Product** | Commerce & Fulfillment | ERP / PIM (API-001) | Danh mục sản phẩm gốc, thông số kỹ thuật đã kiểm duyệt |
| 6 | **SKU** | Commerce & Fulfillment | ERP / WMS (API-001) | Đơn vị lưu kho biến thể cụ thể (màu sắc, kích cỡ, phiên bản) |
| 7 | **Price** | Commerce & Fulfillment | ERP Pricing Engine (API-001) | Bảng giá niêm yết chính thức; AI cấm tự sinh giá (BR-001, BR-003) |
| 8 | **Inventory** | Commerce & Fulfillment | WMS / ERP (API-001) | Tồn kho thực tế khả dụng theo kho/vùng; kiểm tra thời gian thực |
| 9 | **Order** | Commerce & Fulfillment | ERP / OMS (API-001) | Đơn hàng chính thức; AI chỉ tạo Draft Order hoặc đặt cọc |
| 10 | **Invoice** | Commerce & Fulfillment | ERP / Accounting (API-001) | Hóa đơn điện tử/chứng từ kế toán; AI chỉ tra cứu trạng thái |
| 11 | **Conversation** | Engagement & Lifecycle | Communication Gateway | Phiên hội thoại đa kênh (LINE, WhatsApp, Web Widget, Zalo) |
| 12 | **Lead** | Engagement & Lifecycle | CRM / Marketing Ingestion | Đầu mối quan tâm thu được; thẩm định bằng Reason + Evidence (FR-SAL-001) |
| 13 | **Opportunity** | Engagement & Lifecycle | CRM (API-001) | Cơ hội kinh doanh B2B/B2C có khả năng chuyển đổi cao |
| 14 | **Campaign** | Engagement & Lifecycle | Marketing Engine (MKT-05) | Chiến dịch tiếp thị đa kênh; bắt buộc có phê duyệt ngân sách (AUTH-4) |
| 15 | **Segment** | Engagement & Lifecycle | Audience Intelligence (MKT-02) | Phân khúc khách hàng dựa trên hành vi và RFM hợp lệ |
| 16 | **Offer** | Engagement & Lifecycle | Promotion Engine / Second Brain | Chính sách ưu đãi, voucher hợp lệ nằm trong hạn mức trần ($D_{cap}$) |
| 17 | **Recommendation** | Engagement & Lifecycle | Recommendation Agent (SAL-03) | Đề xuất sản phẩm/combo gồm đầy đủ 7 trường dữ liệu bắt buộc (FR-SAL-003) |
| 18 | **Service Case** | Engagement & Lifecycle | Case Management (CS-01) | Vụ việc hỗ trợ/khiếu nại vận hành theo State Machine 7 trạng thái cơ bản (NEW → CLASSIFIED → ASSIGNED → IN_PROGRESS → WAITING_CUSTOMER → RESOLVED → CLOSED) kèm nhánh mở lại REOPENED |
| 19 | **Agent** | Governance & Intelligence | AI Platform Registry | Cấu hình định danh, phạm vi và vai trò của 13 Agent chuyên trách |
| 20 | **Skill** | Governance & Intelligence | Skill Registry / Contract | Đơn vị năng lực thực thi độc lập (tuân thủ Skill System Contract 11 trường) |
| 21 | **Workflow** | Governance & Intelligence | Revenue Orchestrator | Chu trình điều phối bền vững xuyên Agent (11 bước khép kín) |
| 22 | **Decision** | Governance & Intelligence | Orchestrator / Policy Engine | Quyết định nghiệp vụ logic được hệ thống phê chuẩn |
| 23 | **Action** | Governance & Intelligence | Action Dispatcher | Lệnh hành động chuẩn bị thi hành ra kênh ngoài (gắn idempotency key) |
| 24 | **Approval** | Governance & Intelligence | Approval Center (SCR-003) | Bản ghi phê duyệt của con người cho tác vụ rủi ro cao (AUTH-4) |
| 25 | **Execution** | Governance & Intelligence | Adapter Execution Layer | Lần thực thi vật lý tới API bên ngoài kèm mã `effect_key` duy nhất |
| 26 | **Evidence** | Governance & Intelligence | Audit Store / Customer 360 | Bằng chứng xác thực từ hệ thống nguồn (mã đơn, tin nhắn ID, log API) |
| 27 | **Outcome** | Governance & Intelligence | Analytics Engine (API-001 đối soát) | Kết quả kinh doanh thực tế định lượng (doanh thu, chuyển đổi, CSAT) |
| 28 | **Learning** | Governance & Intelligence | Learning Memory | Trọng số tối ưu hóa, bài học rút ra cập nhật vào tri thức dài hạn |

### Đặc tả lược đồ (Schema) và chỉ mục chính cho các thực thể động cốt lõi

Bên cạnh các thực thể giao dịch tĩnh từ SoR (Product, Order, Inventory), nền tảng quản trị 4 thực thể động then chốt phục vụ chu trình tiếp thị, điều phối bán hàng và cá nhân hóa:

#### 1. Thực thể Lead (Khách hàng tiềm năng — Chuẩn FR-SAL-001)
Thẩm định và theo dõi đầu mối kinh doanh với đầy đủ cấu trúc phân loại, lý do và bằng chứng:
- **Lược đồ trường dữ liệu (Schema)**:
  - `lead_id` (`UUID v4`, Primary Key): Định danh duy nhất của đầu mối tiềm năng.
  - `tenant_id` (`UUID v4 / String`, Not Null): Định danh doanh nghiệp phục vụ cô lập đa doanh nghiệp (lớp phòng vệ tenant bổ sung, tách biệt với NFR-006).
  - `customer_id` (`UUID v4 / String`, Nullable): Khóa ngoại liên kết tới Customer nếu là khách hàng đã từng phát sinh giao dịch.
  - `customer_type` (`Enum: 'new' | 'returning'`): Phân loại khách mới hoặc khách quay lại theo chuẩn FR-SAL-001.
  - `needs_summary` (`Text`): Tóm tắt nhu cầu sản phẩm/giải pháp được AI trích xuất từ cuộc trò chuyện.
  - `interested_products` (`JSON Array`): Danh sách mã sản phẩm (`product_id`) hoặc SKU khách quan tâm.
  - `readiness_score` (`Integer`, 0 - 100): Điểm số đánh giá mức độ sẵn sàng mua hàng (Warm / Hot / Cold).
  - `recent_behavior` (`JSON Object`): Ảnh chụp sự kiện số gần nhất từ API-002 (lần xem cuối, sản phẩm xem lặp, thời lượng phiên).
  - `purchase_history_summary` (`JSON Object`): Tóm tắt lịch sử mua hàng từ API-001 (tổng chi tiêu, số đơn, đơn gần nhất).
  - `opportunity_potential` (`Decimal`): Giá trị doanh số tiềm năng dự kiến.
  - `qualification_status` (`Enum: 'unqualified' | 'nurturing' | 'qualified' | 'converted' | 'disqualified'`).
  - `reason` (`Text`, Not Null): Lý do logic của Agent SAL-01 khi thẩm định phân loại lead (Reason).
  - `evidence` (`JSON Object`, Not Null): Thẻ bằng chứng xác thực từ Timeline sự kiện (Evidence) chứng minh cho nhận định.
  - `assigned_agent` (`String`): Mã Agent phụ trách trực tiếp (`SAL-01`, `SAL-02`).
  - `created_at`, `updated_at` (`ISO 8601 UTC`).
- **Chỉ mục chính (Indexes)**:
  - `PRIMARY KEY (tenant_id, lead_id)`
  - `INDEX idx_lead_customer (tenant_id, customer_id)`
  - `INDEX idx_lead_qualification (tenant_id, qualification_status, readiness_score DESC)`
  - `INDEX idx_lead_updated (tenant_id, updated_at DESC)`

#### 2. Thực thể Campaign (Chiến dịch tiếp thị — Chuẩn MKT-05)
Quản trị chiến dịch đa kênh từ khâu lập kế hoạch đến phát động có kiểm soát phê duyệt:
- **Lược đồ trường dữ liệu (Schema)**:
  - `campaign_id` (`UUID v4`, Primary Key): Định danh duy nhất của chiến dịch tiếp thị.
  - `tenant_id` (`UUID v4 / String`, Not Null): Khóa định danh doanh nghiệp (cô lập đa doanh nghiệp, tách biệt với NFR-006).
  - `name` (`String`, Max 255): Tên chiến dịch tiếp thị.
  - `objective` (`Enum: 'lead_generation' | 'cart_recovery' | 'retention' | 'promotion' | 'cross_sell'`).
  - `segment_id` (`UUID v4`, Foreign Key): Khóa ngoại liên kết tới tập phân khúc mục tiêu (`Segment`).
  - `channels` (`JSON Array`): Danh sách kênh phát động (`['line', 'whatsapp', 'tiktok', 'email', 'sms', 'web']`).
  - `content_bundle` (`JSON Object`): Tập biến thể thông điệp từ MKT-03 đã được MKT-04 duyệt brand compliance.
  - `budget_limit` (`Decimal`): Ngân sách tối đa được phân bổ cho chiến dịch (chi phí kênh + token).
  - `spent_budget` (`Decimal`): Ngân sách thực tế đã tiêu hao cập nhật thời gian thực.
  - `authority_level` (`Enum: 'AUTH-4'`): Chiến dịch phát động vượt ngưỡng quy mô tệp nhận tin do tenant cấu hình phải gắn cờ `AUTH-4` (**[UNCONFIRMED][ASM-003]** — ngưỡng chưa chốt, không hardcode giá trị).
  - `approval_id` (`UUID v4`, Nullable): Khóa ngoại liên kết bản ghi phê duyệt từ SCR-003.
  - `status` (`Enum: 'draft' | 'awaiting_approval' | 'approved' | 'running' | 'paused' | 'completed' | 'cancelled'`).
  - `schedule` (`JSON Object`): Cấu hình lịch phát `{ "start_time": ISO8601, "end_time": ISO8601, "rate_limit_per_min": 100 }`.
  - `metrics` (`JSON Object`): Chỉ số hiệu quả `{ "reach": 0, "clicks": 0, "conversions": 0, "revenue": 0.0, "roas": 0.0 }`.
  - `created_at`, `updated_at` (`ISO 8601 UTC`).
- **Chỉ mục chính (Indexes)**:
  - `PRIMARY KEY (tenant_id, campaign_id)`
  - `INDEX idx_campaign_status_schedule (tenant_id, status, (schedule->>'start_time'))`
  - `INDEX idx_campaign_segment (tenant_id, segment_id)`

#### 3. Thực thể Offer (Chính sách ưu đãi / Voucher — Chuẩn BR-001, BR-002)
Quản lý hạn mức ưu đãi và khóa cứng giá sàn kinh tế bảo vệ biên lợi nhuận:
- **Lược đồ trường dữ liệu (Schema)**:
  - `offer_id` (`UUID v4`, Primary Key): Định danh duy nhất của chương trình ưu đãi hoặc voucher.
  - `tenant_id` (`UUID v4 / String`, Not Null): Khóa định danh doanh nghiệp (cô lập đa doanh nghiệp, tách biệt với NFR-006).
  - `name` (`String`, Max 255): Tên chương trình khuyến mãi.
  - `offer_type` (`Enum: 'percentage_discount' | 'fixed_amount' | 'free_shipping' | 'bundle_deal'`).
  - `discount_value` (`Decimal`): Mức giảm giá trị (% hoặc số tiền quy đổi).
  - `max_discount_cap` (`Decimal`): Hạn mức giảm giá trần tuyệt đối ($D_{cap}$) được phép áp dụng.
  - `min_order_value` (`Decimal`): Giá trị đơn hàng tối thiểu để được hưởng ưu đãi.
  - `p_floor_constraint` (`Decimal`): Ngưỡng giá sàn toán học $P_{floor}$; cấm AI giảm giá vi phạm ngưỡng này (BR-001, BR-002).
  - `applicable_skus` (`JSON Array`): Danh sách các SKU sản phẩm đủ điều kiện áp dụng ưu đãi.
  - `total_quota` (`Integer`): Tổng số lượng voucher/suất ưu đãi phát hành.
  - `claimed_count` (`Integer`): Số lượng đã được khách hàng nhận hoặc sử dụng thành công.
  - `status` (`Enum: 'active' | 'paused' | 'exhausted' | 'expired'`).
  - `valid_from`, `valid_to` (`ISO 8601 UTC`): Khoảng thời gian có hiệu lực của ưu đãi.
  - `created_at`, `updated_at` (`ISO 8601 UTC`).
- **Chỉ mục chính (Indexes)**:
  - `PRIMARY KEY (tenant_id, offer_id)`
  - `INDEX idx_offer_validity (tenant_id, status, valid_from, valid_to)`
  - `INDEX idx_offer_type (tenant_id, offer_type)`

#### 4. Thực thể Recommendation (Đề xuất sản phẩm thông minh — Chuẩn FR-SAL-003)
Đặc tả đầy đủ 7 trường thông tin bắt buộc theo Mục 7 SRS phục vụ cá nhân hóa bán hàng:
- **Lược đồ trường dữ liệu (Schema)**:
  - `recommendation_id` (`UUID v4`, Primary Key): Định danh duy nhất của lượt đề xuất sản phẩm.
  - `tenant_id` (`UUID v4 / String`, Not Null): Khóa định danh doanh nghiệp (cô lập đa doanh nghiệp, tách biệt với NFR-006).
  - `customer_id` (`UUID v4 / String`, Not Null): Định danh khách hàng nhận đề xuất (Trường 1: customer).
  - `product_id` / `sku_id` (`String`, Not Null): Mã sản phẩm hoặc biến thể được đề xuất (Trường 2: product).
  - `recommendation_type` (`Enum: 'cross_sell' | 'upsell' | 'substitute' | 'replenishment' | 'bundle'`): Loại hình gợi ý.
  - `reason` (`Text`, Not Null): Lý do đề xuất giải thích rõ tính tương thích và nhu cầu khách (Trường 3: reason).
  - `evidence` (`JSON Object`, Not Null): Thẻ bằng chứng xác thực trích xuất từ giỏ hàng, lịch sử mua hoặc tồn kho (Trường 4: evidence).
  - `eligibility` (`JSON Object`, Not Null): Tiêu chí đủ điều kiện: ngân sách, tương thích kỹ thuật, tồn kho khả dụng > 0 (Trường 5: eligibility).
  - `confidence` (`Float`, 0.00 - 1.00, Not Null): Độ tin cậy thuật toán của lượt đề xuất (Trường 6: confidence).
  - `expected_outcome` (`JSON Object`, Not Null): Kết quả kỳ vọng: xác suất mua, AOV uplift, biên lãi ròng (Trường 7: expected outcome).
  - `status` (`Enum: 'proposed' | 'accepted' | 'dismissed' | 'converted' | 'expired'`).
  - `presented_at` (`ISO 8601 UTC`, Nullable): Thời điểm đề xuất được gửi hoặc hiển thị tới khách hàng.
  - `converted_order_id` (`UUID v4 / String`, Nullable): Mã đơn hàng đối soát nếu khách chuyển đổi thành công.
  - `created_at`, `expires_at` (`ISO 8601 UTC`).
- **Chỉ mục chính (Indexes)**:
  - `PRIMARY KEY (tenant_id, recommendation_id)`
  - `INDEX idx_rec_customer_created (tenant_id, customer_id, created_at DESC)`
  - `INDEX idx_rec_product_type (tenant_id, product_id, recommendation_type)`
  - `INDEX idx_rec_status (tenant_id, status)`

<a id=evidence-separation></a>

## 2. Cơ chế phân định bằng chứng (FR-C360-003 - Evidence Separation)

Hệ thống bắt buộc phải phân định rạch ròi 5 khái niệm dữ liệu trong Customer 360 để bảo đảm tính toàn vẹn thông tin và triệt tiêu ảo giác (hallucination):

```
+-----------------------------------------------------------------------------+
|                             FR-C360-003 TAXONOMY                            |
+-----------------------------------------------------------------------------+
| 1. FACT       | Dữ liệu sự thật khách quan từ System of Record (ERP/POS)   |
| 2. SIGNAL     | Tín hiệu hành vi quan sát được qua kênh số (API-002)        |
| 3. HYPOTHESIS | Giả thuyết do AI suy luận dựa trên mô hình & phân tích      |
| 4. DECISION   | Quyết định nghiệp vụ được Orchestrator / Policy xác lập     |
| 5. ACTION     | Hành động cụ thể đã hoặc dự kiến thi hành ra kênh ngoài     |
+-----------------------------------------------------------------------------+
```

- **FACT**: Dữ liệu sự thật đã được xác minh từ System of Record (đơn hàng đã thanh toán thành công, giá niêm yết ERP, tồn kho thực tế trong kho hàng, biên lai bưu cục).
- **SIGNAL**: Dấu hiệu hành vi khách quan sát được qua kênh số (xem sản phẩm 3 lần trong 24 giờ, thêm vào giỏ hàng nhưng chưa thanh toán, thời lượng phiên 10 phút, bấm vào liên kết khuyến mãi).
- **HYPOTHESIS**: Giả thuyết do AI suy luận dựa trên mô hình (khách hàng có nguy cơ rời bỏ 70%, sở thích thời trang tối giản, độ nhạy cảm chiết khấu cao).
- **DECISION**: Quyết định nghiệp vụ đã được Orchestrator hoặc Policy Engine xác lập (kích hoạt kịch bản chăm sóc giỏ hàng bỏ quên, phân bổ ticket cho CSKH bậc 2).
- **ACTION**: Hành động cụ thể dự kiến hoặc đã thực thi ra kênh ngoài (gửi tin nhắn thông báo qua LINE/WhatsApp, tạo mã giảm giá 5%, tạo draft order).

**Quy tắc bất biến cốt lõi: Giả thuyết AI (HYPOTHESIS) tuyệt đối không được ghi ngược hoặc nhầm lẫn thành Sự thật khách hàng (FACT).**

## 3. Phân tầng 5 cấp bộ nhớ AI (AI Memory Hierarchy)

Hệ thống phân định nghiêm ngặt 5 tầng bộ nhớ để bảo đảm an toàn dữ liệu, tránh rò rỉ ngữ cảnh và tối ưu chi phí vận hành:

| Tầng bộ nhớ | Tên gọi kỹ thuật | Cơ chế lưu trữ & Vòng đời | Hạ tầng nền tảng (Platform Implementation) | Phạm vi dữ liệu |
|---|---|---|---|---|
| **Tầng 1** | **Working Memory** (Bộ nhớ tác vụ) | RAM / Redis cache; giải phóng hoặc đóng băng ngay sau lượt hội thoại | Redis 7.2 (`tenant:{tenant_id}:wm:{session_id}`) | Ngữ cảnh câu hỏi - đáp hiện tại, biến trung gian của prompt, trạng thái bước xử lý hiện hành |
| **Tầng 2** | **Customer Context** (Ngữ cảnh khách hàng) | Cơ sở dữ liệu quan hệ (PostgreSQL); nạp động theo phiên | PostgreSQL 16 (`agentos.customer_360_profiles` view & bảng `customers`, `consents`) | Hồ sơ Customer 360, lịch sử mua sắm, trạng thái consent hiện tại, ưu đãi khả dụng của khách |
| **Tầng 3** | **Organizational Knowledge** (Tri thức tổ chức) | Second Brain Knowledge Base & Vector DB Index | Qdrant Vector Engine (`second_brain_knowledge`) & kho 21 tệp Markdown | Tài liệu, chính sách, bảng giá niêm yết, playbook bán hàng và CSKH đã được phê duyệt (`approved`) |
| **Tầng 4** | **Operational Memory** (Bộ nhớ vận hành Agent) | Cơ sở dữ liệu trạng thái bền vững (Stateful Workflow Store) | PostgreSQL (`agentos.workflow_executions`, `agent_run_logs`) & Redis Mutex Lock | `run_id`, `task_id`, lịch hẹn gọi lại, số lần retry, khóa mutex phiên, nhật ký lỗi |
| **Tầng 5** | **Learning Memory** (Bộ nhớ học tập & cải tiến) | Kho dữ liệu phân tích (Analytics Store) | PostgreSQL (`agentos.learnings`) & bảng tổng hợp chỉ số kinh doanh | Chỉ số chuyển đổi thực tế (Outcome), doanh thu đóng góp, phản hồi chấm điểm từ SCR-005, tỷ lệ giải quyết CSKH |

**Nguyên tắc vận hành**: AI không được phép tự ý lưu nội dung hội thoại thô thành tri thức lâu dài của tổ chức. Mọi thông tin cập nhật vào Second Brain bắt buộc phải qua bộ lọc làm sạch dữ liệu và sự phê duyệt của con người. Thời hạn lưu trữ của từng tầng bộ nhớ (bao gồm dữ liệu Customer 360 và ngữ cảnh hội thoại) do chính sách dữ liệu của tenant quy định theo **[UNCONFIRMED][ASM-005]**; tài liệu này không cam kết lưu trữ vĩnh viễn bất kỳ trường dữ liệu khách hàng nào.

## 4. Kho kiến thức doanh nghiệp (Second Brain Knowledge Base)

AI Agent không được hoạt động dựa trên tri thức nội tại thiếu kiểm chứng của mô hình LLM mà phải truy xuất từ cấu trúc phân cấp chuẩn hóa gồm đúng 21 tệp markdown phân bổ trong 8 thư mục nghiệp vụ (khớp 100% Mục 10 SRS):

```text
/company
  company.md              # Giới thiệu doanh nghiệp, tầm nhìn, mô hình hoạt động
  positioning.md          # Định vị thương hiệu, phân khúc thị trường mục tiêu
/customer
  customer.md             # Chân dung khách hàng mục tiêu, ICP
  segmentation.md         # Quy tắc phân khúc cohort, tiêu chí phân loại khách
/product
  products.md             # Danh mục sản phẩm, tính năng, thông số kỹ thuật
  pricing.md              # Bảng giá chính thức, cơ cấu chi phí, quy định giá sàn
  promotion-policy.md     # Chính sách khuyến mãi, điều kiện áp dụng voucher
/brand
  voice.md                # Tone of voice, phong cách ngôn ngữ theo từng kênh
  terminology.md          # Thuật ngữ chuẩn hóa, từ ngữ khuyến khích sử dụng
  prohibited-claims.md    # Danh mục từ cấm, cam kết vượt thẩm quyền bị cấm
/marketing
  playbook.md             # Kịch bản chiến dịch, hướng dẫn tiếp thị đa kênh
  content-guidelines.md   # Tiêu chuẩn nội dung social, video, email
  campaign-rules.md       # Giới hạn ngân sách, quy định phân bổ tần suất gửi
/sales
  sales-playbook.md       # Quy trình bán hàng chuẩn, kịch bản chốt đơn
  qualification.md        # Bộ câu hỏi sàng lọc lead, tiêu chí BANT
  objection-handling.md   # Kịch bản xử lý từ chối và phản bác giá
/customer-care
  faq.md                  # Bộ câu hỏi - trả lời thường gặp đã được phê duyệt
  support-policy.md       # Chính sách bảo hành, đổi trả, quy trình xử lý sự cố
  escalation.md           # Ma trận phân cấp xử lý sự cố, tiêu chí chuyển người
/policy
  authority.md            # Quy chế phân quyền Agent (AUTH-0..5), hạn mức tự chủ
  approval.md             # Ma trận phê duyệt các hành động rủi ro cao (AUTH-4)
```

### Quy tắc kiểm duyệt và Thẻ bằng chứng (Evidence Card)

- Mỗi tài liệu trong Second Brain bắt buộc phải có metadata gồm: chủ sở hữu (`owner`), phiên bản nguồn (`source_version`), trạng thái phê duyệt (`status: draft | review | approved`), ngày hiệu lực và ngày hết hạn.
- AI Agent chỉ được phép trích dẫn các tài liệu ở trạng thái đã phê duyệt (`status: approved`).
- Cấu trúc Thẻ bằng chứng (Evidence Card) chuẩn hóa:
  - `claim`: Nội dung phát biểu hoặc đề xuất giá trị cung cấp cho khách hàng.
  - `evidence_type`: Phân loại FACT, SIGNAL hoặc HYPOTHESIS.
  - `source_file`: Đường dẫn tệp tài liệu trong Second Brain (ví dụ: `/product/pricing.md`).
  - `source_version`: Phiên bản tài liệu tại thời điểm truy xuất.
  - `conditions`: Điều kiện và ranh giới áp dụng.
  - `verified_by`: Định danh người hoặc hệ thống kiểm chứng.

## 5. Cô lập ngữ cảnh khách hàng (NFR-006), cô lập đa doanh nghiệp và Bảo vệ dữ liệu theo mục đích

### Cô lập ngữ cảnh khách hàng (Customer Context Isolation - NFR-006)

NFR-006 yêu cầu dữ liệu của khách hàng A tuyệt đối không được xuất hiện trong ngữ cảnh của khách hàng B: mọi lượt nạp ngữ cảnh, bộ nhớ phiên và prompt chỉ chứa dữ liệu của đúng khách hàng đã được xác minh trong phiên tương tác hiện tại. Việc xác minh định danh (Customer Verification - TC-E2E-004) bắt buộc hoàn tất **trước** mọi tra cứu hồ sơ khách hàng hoặc đơn hàng.

### Cô lập đa doanh nghiệp (Multi-Tenant Isolation - lớp phòng vệ bổ sung)

Đây là lớp phòng vệ độc lập, bổ sung cho NFR-006, bảo đảm cô lập giữa các doanh nghiệp (tenant) dùng chung hạ tầng. Hệ thống bảo đảm cô lập dữ liệu tuyệt đối giữa các tenant ở mọi tầng kiến trúc:

1. **Tầng cơ sở dữ liệu quan hệ (Database Layer)**:
   - Áp dụng phân tách schema độc lập hoặc cơ chế Row-Level Security (RLS) với khóa `tenant_id` bắt buộc tại mọi truy vấn. Mọi câu lệnh SQL thiếu mệnh đề `WHERE tenant_id = ?` đều bị tầng truy cập dữ liệu chặn cưỡng bức.
2. **Tầng Vector Embedding & RAG**:
   - Không gian vector của từng doanh nghiệp được cô lập hoàn toàn bằng namespace riêng biệt hoặc collection riêng. Hệ thống truy xuất RAG không thể thực hiện semantic search chéo giữa các tenant.
3. **Tầng bộ nhớ đệm và hàng đợi (Cache & Queue Layer)**:
   - Các khóa Redis và hàng đợi tác vụ được đánh tiền tố theo tenant (`tenant:{id}:*`), ngăn chặn triệt để tình trạng nhiễm bẩn ngữ cảnh bộ nhớ runtime (zero runtime context bleeding).

### Bảo vệ dữ liệu theo mục đích sử dụng (Purpose Limitation)

| Tình huống tương tác | Nguyên tắc thu thập và bảo vệ dữ liệu |
|---|---|
| Khách hỏi thông tin công khai | Trả lời thông tin công khai từ Second Brain; không ép buộc đăng ký thông tin cá nhân |
| Khách đặt đơn giao hàng | Thu thập thông tin giao nhận tối thiểu; không tự ý sử dụng dữ liệu này cho mục đích quảng cáo nếu chưa có consent |
| Khách đăng ký nhận ưu đãi | Lưu trữ kênh, mục đích cụ thể, phương thức xác nhận, timestamp và phiên bản nội dung đồng thuận |
| Khách rút lại sự đồng ý | Ngừng ngay lập tức toàn bộ lịch gửi tin tiếp thị liên quan, ghi nhận sự kiện rút consent vào nhật ký kiểm toán (BR-004) |
| Chia sẻ đối tác vận chuyển/thanh toán | Chỉ truyền dữ liệu cần thiết phục vụ hoàn tất giao dịch; không mở rộng phạm vi ra ngoài thỏa thuận |

### Ánh xạ hạ tầng tuân thủ pháp lý theo Adapter

**[UNCONFIRMED][ASM-001]** Danh sách connector và hạ tầng production chưa được chốt; các adapter nêu dưới đây là hiện thực cụ thể tùy chọn/minh họa cho từng thị trường, không phải ràng buộc cứng của nền tảng.

1. **Thị trường Đài Loan (adapter ví dụ: ADPT-TW-001)**:
   - Đáp ứng đầy đủ Đạo luật Bảo vệ Dữ liệu Cá nhân Đài Loan (Taiwan PDPA).
   - Triển khai cụm máy chủ và cơ sở dữ liệu tại GCP Changhua hoặc AWS Region Taipei, bảo đảm lưu trữ dữ liệu cá nhân tại chỗ và độ trễ phản hồi < 50ms.
2. **Thị trường Toàn cầu (adapter ví dụ: ADPT-GL-003)**:
   - Hỗ trợ phân vùng lưu trữ theo khu vực địa lý: AWS Frankfurt (tuân thủ GDPR Châu Âu), AWS US East (tuân thủ CCPA/CPRA Hoa Kỳ), AWS Singapore (tuân thủ APAC PDPA).
   - Tích hợp mô-đun quản lý đồng thuận cookie và thực thi quyền của chủ thể dữ liệu (Data Subject Rights: quyền truy cập, xuất dữ liệu và quyền được lãng quên/xóa dữ liệu).

## 6. Danh mục sản phẩm, dữ liệu giá và kiểm soát giá sàn

Dữ liệu sản phẩm bắt buộc phải đồng bộ từ API giao dịch nguồn (API-001). Không duy trì hệ thống dữ liệu sản phẩm thứ hai song song.

| Trường thông tin sản phẩm | Ý nghĩa và nguồn thẩm quyền |
|---|---|
| Định danh sản phẩm | `product_id`, `sku_id`, tên sản phẩm, phân loại danh mục, đơn vị tính |
| Điều kiện kỹ thuật & Ranh giới | Nhu cầu đáp ứng, thông số kỹ thuật, điều kiện tương thích, giới hạn sử dụng |
| Giá niêm yết chính thức | Đơn vị tiền tệ, giá niêm yết chính thức từ ERP/POS (API-001), biểu thuế và phí |
| Tồn kho khả dụng thời gian thực | Số lượng tồn kho thực tế theo kho hàng, vùng phục vụ, mốc thời gian cập nhật |
| Bằng chứng tài liệu | Đường dẫn tài liệu mô tả đã duyệt trong Second Brain (`/product/products.md`) |
| Chính sách khuyến mãi | Chương trình ưu đãi đang chạy, điều kiện áp dụng, hạn dùng từ `/product/promotion-policy.md` |
| Giá sàn kinh tế nội bộ ($P_{floor}$) | Mức giá sàn toán học bảo vệ biên lãi ròng; chỉ cấp quyền truy cập cho máy chủ tính giá nội bộ |

Nếu thiếu thông tin giá hoặc điều kiện tồn kho quan trọng từ API-001, hệ thống cấm phát hành báo giá tự động (tuân thủ BR-001, BR-002, BR-003, NFR-008).

## 7. Tiêu chí kiểm thử nghiệm thu dữ liệu

1. **TC-DATA-001 (Cô lập dữ liệu đa doanh nghiệp)**: Kiểm thử truy vấn và vector search giữa hai tenant mẫu; bảo đảm không có bất kỳ bản ghi nào của Tenant A xuất hiện trong kết quả của Tenant B (lớp phòng vệ tenant bổ sung cho NFR-006).
2. **TC-DATA-002 (Phân định bằng chứng)**: Xác minh dữ liệu trong Customer 360 luôn phân tách rõ rệt FACT, SIGNAL, HYPOTHESIS, DECISION, ACTION; chứng minh giả thuyết AI không bị ghi đè thành FACT (FR-C360-003).
3. **TC-DATA-003 (Tuân thủ rút consent)**: Khách hàng phát tín hiệu rút consent dẫn đến việc hệ thống hủy bỏ ngay lập tức mọi lịch gửi tin tiếp thị trong hàng đợi (BR-004, TC-E2E-007).
4. **TC-DATA-004 (Kiểm duyệt Second Brain)**: Thử nghiệm nạp tài liệu trạng thái `draft`; hệ thống RAG từ chối sử dụng tài liệu này để tạo phản hồi cho khách hàng.
5. **TC-DATA-005 (Xóa dữ liệu chủ thể)**: Khi nhận yêu cầu xóa dữ liệu cá nhân theo PDPA/GDPR, hệ thống xóa sạch dữ liệu tương ứng trong Customer 360, bộ nhớ đệm Redis và chỉ mục vector.

