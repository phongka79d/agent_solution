# Quy trình bền vững, phê duyệt và bàn giao

[Mục lục](../README.md) · [Kiến trúc](architecture.md) · [Dữ liệu](data-and-knowledge.md) · [API](api-and-integrations.md)

Trạng thái: Bản thiết kế khung gầm kỹ thuật (Platform Blueprint) độc lập thị trường cho quản lý quy trình, phân quyền và bàn giao vận hành.

<a id=section-13></a>

## 1. Cơ chế quy trình bền vững độc lập với LLM

Mô hình ngôn ngữ lớn (LLM) chỉ đóng vai trò hiểu ngữ cảnh và đề xuất giải pháp. Máy chủ trung tâm (Core Engine) nắm toàn quyền kiểm soát trạng thái, lịch trình chờ, điều kiện dừng và quyết định thực thi. Quy trình bền vững (Stateful Durable Workflow) là chuỗi các bước có thể khôi phục và tiếp tục chính xác vị trí đang xử lý sau khi tiến trình hoặc máy chủ khởi động lại.

| Trường bản ghi tác vụ | Ý nghĩa kỹ thuật |
|---|---|
| `run_id`, sự kiện gốc | Mã định danh duy nhất của lần chạy; khóa chống trùng theo `tenant_id` + nguồn + sự kiện + quy trình |
| Ngữ cảnh (`context`) | Khách hàng/phiên (`session_id`), cuộc trao đổi (`conversation_id`), cơ hội/đơn hàng/vụ việc và mã truy vết (`correlation_id`) |
| Phiên bản cấu hình | Cấu trúc quy trình và ảnh chụp cấu hình chính sách tại thời điểm chạy để phục vụ kiểm toán |
| Tiến độ vận hành | Trạng thái máy, bước hiện tại, số lần thử lại (`retry_count`), mốc thời gian chạy tiếp, khóa giữ bước có hạn |
| Trách nhiệm & Hàng đợi | Người/nhóm phụ trách, bên nhận bàn giao, thời hạn chờ phản hồi và quy tắc xử lý khi quá hạn (timeout escalation) |
| Phê duyệt (`approval`) | Người duyệt, loại hành động, quyết định (Approve/Reject/Modify), lý do, thời điểm và thời hạn hiệu lực |
| Kết quả & Bằng chứng | Mã tác động cố định (`effect_key`), kết quả từ cổng kết nối Adapter, điều chưa rõ và lý do dừng/thất bại |

Phiên bản cấu hình bảo đảm khả năng truy vết lịch sử. Trước mỗi bước thực thi, hệ thống bắt buộc phải kiểm tra lại quyền hạn, trạng thái kích hoạt của mô-đun, sự đồng ý (consent), dữ liệu giá sàn và trạng thái khách hàng thời gian thực. Ảnh chụp dữ liệu cũ tuyệt đối không được phép ghi đè các chính sách an toàn mới.

### Cấu trúc Nhật ký Kiểm toán Lần chạy Agent (Agent Run Log Schema — Chuẩn hóa theo Mục 17 SRS, NFR-006 và lớp cô lập đa doanh nghiệp)

Tuân thủ Mục 17 của SRS (AI-REV-SRS-001) và tiêu chuẩn cô lập ngữ cảnh khách hàng (**NFR-006**: dữ liệu khách A tuyệt đối không được xuất hiện trong ngữ cảnh khách B); cô lập đa doanh nghiệp theo `tenant_id` là lớp phòng vệ bổ sung, tách biệt với NFR-006. Mỗi lần chạy của bất kỳ AI Agent nào trong hệ thống (Agent Run) bắt buộc phải ghi lại đầy đủ các trường thông tin vào Audit Store phục vụ giám sát thời gian thực tại SCR-002 và truy vết hồi tố (TC-E2E-009). Thời hạn lưu trữ bản ghi kiểm toán do chính sách dữ liệu của tenant quy định (**[UNCONFIRMED][ASM-005]**); tài liệu này không cam kết lưu trữ vĩnh viễn:

| STT | Trường dữ liệu (Field) | Kiểu dữ liệu | Ý nghĩa & Quy cách chuẩn hóa |
|---|---|---|---|
| 1 | `run_id` | `UUID v4` | Mã định danh duy nhất của phiên chạy Agent; không trùng lặp |
| 2 | `tenant_id` | `UUID v4 / String` | Mã định danh doanh nghiệp; bắt buộc ở mọi bản ghi kiểm toán để cách ly dữ liệu giữa các doanh nghiệp (lớp phòng vệ tenant bổ sung, tách biệt với NFR-006) |
| 3 | `agent_id` | `String` | Mã định danh Agent thực thi (ví dụ: `MKT-05`, `SAL-02`, `CS-01`) |
| 4 | `customer_or_entity_id` | `String` | Khách hàng hoặc thực thể chịu tác động (`customer_id`, `lead_id`, `case_id`) |
| 5 | `trigger` | `String` | Sự kiện hoặc tín hiệu kích hoạt (`cart.abandoned`, `message.received`, `lead.qualified`) |
| 6 | `context` | `JSON Object` | Ảnh chụp ngữ cảnh đầu vào: lát cắt Customer 360, trạng thái consent, phiên hội thoại |
| 7 | `skill` | `String` | Mã kỹ năng được kích hoạt (ví dụ: `skill.sales.check_stock`, `skill.care.lookup_order`) |
| 8 | `tool` | `String` | Interface connector hoặc công cụ thực thi liên kết (API-001, API-002, API-003 hoặc `<Domain>Connector`). Adapter cụ thể theo thị trường (ví dụ ADPT-TW-001) chỉ là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]** |
| 9 | `decision` | `JSON Object` | Quyết định logic được Orchestrator xác lập kèm lý do (Reason) |
| 10 | `authority` | `Enum` | Cấp độ thẩm quyền áp dụng (`AUTH-0` đến `AUTH-5`) |
| 11 | `approval` | `JSON Object \| null` | Bản ghi duyệt của con người nếu là `AUTH-4` (`{approver_id, decision, timestamp, reason}`) |
| 12 | `action` | `JSON Object` | Payload chi tiết của hành động gửi ra ngoài kèm mã chống trùng `effect_key` (BR-005) |
| 13 | `execution_status` | `Enum` | Trạng thái thực thi (`pending`, `executing`, `success`, `failed`, `denied`, `aborted`) |
| 14 | `evidence` | `JSON Object` | Bản ghi bằng chứng xác thực từ hệ thống nguồn (mã vận đơn, mã đơn ERP, message ID) |
| 15 | `outcome` | `JSON Object \| null` | Kết quả kinh doanh thực tế sau đó (`order_created`, `cart_recovered`, `case_resolved`) |
| 16 | `latency_ms` | `Integer` | Tổng thời gian thực thi của lần chạy tính bằng mili-giây (ms) |
| 17 | `cost` | `JSON Object` | Chi phí vận hành: Token input/output, chi phí API mô hình, phí kết nối Adapter quy đổi |
| 18 | `error` | `JSON Object \| null` | Chi tiết mã lỗi, nhật ký lỗi (error stack) và nguyên nhân thất bại (nếu có) |
| * | `timestamp` | `ISO 8601 UTC` | Mốc thời gian bắt đầu và kết thúc lượt chạy (`started_at`, `completed_at`) |

## 2. Mô hình phân quyền (Authority Model) và Quy tắc nghiệp vụ (Business Rules)

### Mô hình phân quyền 6 cấp độ (Authority Model)

Hệ thống quản trị mọi hành động của AI theo 6 cấp bậc thẩm quyền cố định; Agent bị chặn cứng ở tầng máy chủ, không thể tự nâng cấp quyền hạn:

| Cấp độ | Tên quyền | Định nghĩa & Ranh giới hoạt động | Ví dụ áp dụng |
|---|---|---|---|
| `AUTH-0` | Observe | Chỉ đọc dữ liệu, quan sát hành vi, dòng sự kiện và tra cứu tài liệu công khai (bao gồm mọi skill tra cứu chỉ đọc: giá, tồn kho, FAQ, đơn hàng, vận đơn) | Đọc Timeline Customer 360, tra cứu tài liệu Second Brain, gọi `skill.sales.check_price` / `skill.sales.check_stock` / `skill.care.lookup_order` |
| `AUTH-1` | Recommend | Phân tích dữ liệu và đề xuất phương án cho con người hoặc Agent khác | Gợi ý sản phẩm phù hợp, chấm điểm cơ hội (lead scoring) |
| `AUTH-2` | Draft | Tạo nội dung hoặc hành động ở dạng bản nháp nội bộ, chưa gửi ra ngoài | Soạn thảo tin nhắn, lập dàn ý chiến dịch, chuẩn bị draft order |
| `AUTH-3` | Bounded Execute | Tự thực thi các tác vụ rủi ro thấp trong hạn mức và tần suất được cấu hình trước (hành động ghi/phát trả lời, tách biệt với skill tra cứu chỉ đọc ở `AUTH-0`) | Phát trả lời FAQ từ tài liệu đã duyệt ra kênh ngoài, gửi tin nhắc giỏ trong hạn mức tần suất |
| `AUTH-4` | Approval Required | Chuẩn bị đầy đủ payload hành động nhưng bắt buộc dừng chờ con người phê duyệt tại SCR-003 | Phát động chiến dịch diện rộng, chiết khấu vượt trần, bồi thường, hoàn tiền, thay đổi chính sách |
| `AUTH-5` | Prohibited | Tuyệt đối cấm; hệ thống chặn cứng ở tầng máy chủ (Hard Lock) | Tự tạo giá sản phẩm mới, truy cập dữ liệu chéo tenant, xuất dữ liệu khách hàng thô, tự nâng quyền |

### Ngưỡng kích hoạt AUTH-4 theo chính sách tenant (Tenant-Configurable Thresholds)

Máy chủ bắt buộc dừng chờ con người phê duyệt tại SCR-003 (`AUTH-4`) khi hành động vượt ngưỡng do chính sách của từng tenant cấu hình. Hệ thống **không hardcode** giá trị nghiệp vụ nào; mọi ngưỡng dưới đây là tham số cấu hình theo tenant và chỉ có hiệu lực sau khi chủ sở hữu chính sách khóa giá trị:

| Tham số kiểm soát rủi ro | Ngưỡng kích hoạt AUTH-4 | Trạng thái ngưỡng | Hành vi khi vượt ngưỡng | Ranh giới an toàn tuyệt đối |
|---|---|---|---|---|
| **Tỷ lệ chiết khấu (Discount Rate)** | `<ngưỡng do tenant cấu hình>` | **[UNCONFIRMED][ASM-003]** — chưa chốt, không có giá trị mặc định nào được phê duyệt | Dừng phát ưu đãi tự động, chuyển yêu cầu phê duyệt sang SCR-003 kèm bằng chứng biên lợi nhuận | Tuyệt đối không cho phép giá sau giảm vi phạm giá sàn toán học $P_{floor}$ (BR-001, BR-002) |
| **Bồi thường / Hoàn tiền (Compensation / Refund)** | `<ngưỡng do tenant cấu hình>` | **[UNCONFIRMED][ASM-004]** — chưa chốt loại giao dịch và mức tiền phải duyệt | Khóa quyền tự động của CS Agent, bắt buộc nhân viên quản lý phê duyệt trước khi phát lệnh | Phải đối soát khớp với mã đơn hàng và bằng chứng sự cố (BR-007) |
| **Quy mô tệp nhận tin chiến dịch (Campaign Audience)** | `<ngưỡng do tenant cấu hình>` | **[UNCONFIRMED][ASM-003]** — chưa chốt quy mô tập nhận tin | Yêu cầu phê duyệt ngân sách và nội dung thông điệp tại SCR-003 trước khi phát động | Kiểm soát chi phí phát sinh và chống gửi tin tiếp thị hàng loạt không mong muốn (BR-004) |
| **Thay đổi chính sách / Điều khoản (Terms Modification)** | Mọi sửa đổi chính sách bảo hành, đổi trả, cam kết thương mại | Quy tắc cố định, không phụ thuộc ngưỡng số | Chuyển trạng thái sang `awaiting_human`, cấm AI tự ý cam kết vượt thẩm quyền | Bảo vệ tính toàn vẹn của Second Brain (`/policy/authority.md`) |

Khi tenant chưa cấu hình ngưỡng, hệ thống **fail closed** (NFR-008): mọi hành động thuộc các nhóm trên đều phải qua phê duyệt của con người tại SCR-003. Các con số từng xuất hiện trong bản nháp (tỷ lệ chiết khấu, mức tiền bồi thường, quy mô tệp nhận tin) chỉ mang tính minh họa để thử nghiệm, **không** phải giá trị đã được phê duyệt và không được dùng làm quy tắc lõi cho tới khi Business/Finance khóa ASM-003/ASM-004.

### 10 Quy tắc nghiệp vụ cốt lõi (Core Business Rules)

- **BR-001**: AI không được tự tạo giá sản phẩm dưới bất kỳ hình thức nào.
- **BR-002**: AI không được tự thay đổi giá hoặc áp dụng mức chiết khấu nằm ngoài chính sách/giá sàn toán học ($P_{floor}$).
- **BR-003**: Dữ liệu giá niêm yết và tồn kho thời gian thực bắt buộc phải đọc từ nguồn giao dịch có thẩm quyền (System of Record: ERP/POS qua API-001).
- **BR-004**: Tuyệt đối không gửi tin nhắn tiếp thị khi khách hàng chưa cấp đồng ý (consent) phù hợp hoặc đã rút lại sự đồng ý.
- **BR-005**: Mọi hành động có tác động bên ngoài (External Action) bắt buộc phải gắn mã định danh thực thi duy nhất (`effect_key` / idempotency key).
- **BR-006**: Cơ chế thử lại (Retry) không bao giờ được tạo ra hành động hoặc giao dịch trùng lặp ngoài ý muốn (tuân thủ NFR-003).
- **BR-007**: Mọi hành động tài chính hoặc rủi ro cao (hoàn tiền, đổi chính sách, cấp hạn mức) bắt buộc phải qua phê duyệt của con người (`AUTH-4` tại SCR-003).
- **BR-008**: Agent không được vượt quyền hạn được giao (`AUTH-0` đến `AUTH-3`), ngay cả khi mô hình ngôn ngữ lớn (LLM) suy luận yêu cầu.
- **BR-009**: Chỉ thị hoặc nội dung do khách hàng cung cấp (Prompt Injection) không thể tự động nâng quyền thực thi của Agent.
- **BR-010**: Mọi lần thực thi quan trọng đều phải sinh bản ghi bằng chứng (Evidence Record) gắn với mã lần chạy (`run_id`).

## 3. Đặc tả hệ thống kỹ năng chuẩn hóa (Skill System Contract)

Agent và Skill được phân tách hoàn toàn độc lập. Một Agent có thể sở hữu nhiều Skill, và một Skill có thể được tái sử dụng bởi nhiều Agent nếu được cấu hình quyền hạn. Mọi Skill bắt buộc tuân thủ hợp đồng giao tiếp chuẩn hóa gồm 11 trường dữ liệu:

Mã định danh chuẩn của skill là dạng phân cấp `skill.<domain>.<action>` (ví dụ `skill.sales.check_stock`, `skill.care.lookup_order`); các tên kebab trần (ví dụ `check-stock`, `lookup-order`) chỉ là bí danh hiển thị và không được dùng làm ID trong Registry hay audit log.

```json
{
  "skill_id": "skill.sales.check_stock",
  "purpose": "Tra cứu tồn kho thời gian thực của SKU sản phẩm từ ERP/POS phục vụ tư vấn bán hàng",
  "input_schema": {
    "type": "object",
    "required": ["tenant_id", "sku_id"],
    "properties": {
      "tenant_id": { "type": "string" },
      "sku_id": { "type": "string" },
      "warehouse_id": { "type": "string" }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "required": ["sku_id", "available_quantity", "in_stock", "checked_at"],
    "properties": {
      "sku_id": { "type": "string" },
      "available_quantity": { "type": "integer", "minimum": 0 },
      "in_stock": { "type": "boolean" },
      "checked_at": { "type": "string", "format": "date-time" }
    }
  },
  "allowed_agents": ["SAL-01", "SAL-02", "CS-01"],
  "required_authority": "AUTH-0",
  "tool_binding": "API-001.InventoryConnector",
  "validation_rules": [
    "sku_id must exist in active product catalog",
    "warehouse_id must belong to active tenant region"
  ],
  "retry_policy": {
    "max_retries": 3,
    "backoff_multiplier": 1.5,
    "initial_interval_ms": 500,
    "stop_conditions": ["HTTP_401", "HTTP_403", "SKU_NOT_FOUND"]
  },
  "timeout_ms": 3000,
  "audit_spec": {
    "log_level": "INFO",
    "mask_pii_fields": [],
    "evidence_card": "EV_INVENTORY_CHECK",
    "record_latency": true
  },
  "test_cases": [
    { "test_id": "TC-SKILL-001-SUCCESS", "input": { "sku_id": "SKU_100" }, "expected": "in_stock == true" },
    { "test_id": "TC-SKILL-001-TIMEOUT", "input": { "simulate": "timeout" }, "expected": "CircuitBreakerOpen" },
    { "test_id": "TC-SKILL-001-AUTH-DENY", "agent": "UNAUTHORIZED_AGENT", "expected": "DENY" }
  ]
}
```

Ví dụ trên là skill **tra cứu chỉ đọc** nên `required_authority` phải là `AUTH-0`; hành động phát trả lời ra kênh ngoài hoặc thao tác ghi có hạn mức là action riêng, khai báo ở cấp `AUTH-3`.

11 trường chuẩn hóa của Skill System Contract:
1. **Skill ID**: Mã định danh duy nhất (chuẩn phân cấp: `skill.<domain>.<action>`).
2. **Purpose**: Mô tả mục đích nghiệp vụ và phạm vi hoạt động cụ thể của skill.
3. **Input / Output Schema**: Định nghĩa cấu trúc dữ liệu nghiêm ngặt theo JSON Schema.
4. **Allowed Agents**: Danh sách mã định danh Agent được phép kích hoạt skill.
5. **Required Authority**: Cấp độ quyền hạn tối thiểu để kích hoạt skill (từ `AUTH-0` đến `AUTH-4`). Skill chỉ tra cứu khai báo `AUTH-0`; quyền `AUTH-3` chỉ áp cho hành động ghi/phát trả lời riêng, không gộp vào skill tra cứu.
6. **Tool / Connector Binding**: Interface connector trừu tượng hoặc công cụ thực thi tương ứng (API-001, API-002, API-003, `<Domain>Connector`); adapter cụ thể theo thị trường (ví dụ ADPT-TW-001) là hiện thực tùy chọn, chỉ chốt sau khi khóa **[UNCONFIRMED][ASM-001]**.
7. **Validation Rules**: Quy tắc kiểm tra tính hợp lệ của tham số và điều kiện tiên quyết trước khi thực thi.
8. **Retry Policy**: Chính sách thử lại (số lần thử tối đa, hệ số lùi thời gian exponential backoff, điều kiện dừng lỗi cứng).
9. **Timeout & Circuit Breaker**: Thời gian chờ tối đa (ms) và ngưỡng ngắt mạch bảo vệ hệ thống khi dịch vụ đích gặp sự cố.
10. **Audit & Evidence Specification**: Cấu hình ghi nhật ký kiểm toán, danh sách trường nhạy cảm cần ẩn danh (PII masking) và định dạng thẻ bằng chứng.
11. **Automated Test Cases**: Bộ kiểm thử tự động gồm ca thành công, lỗi mạng, quá hạn thời gian, vi phạm phân quyền và dữ liệu sai cấu trúc.

### Danh mục Chuẩn hóa 23 Kỹ năng Nền tảng (Platform 23-Skill Registry)

Toàn bộ 23 kỹ năng của hệ thống bắt buộc phải tuân thủ nghiêm ngặt Hợp đồng kỹ năng 11 trường nêu trên, phân định rạch ròi theo 3 miền nghiệp vụ:

| STT | Mã kỹ năng (`skill_id`) | Mục đích nghiệp vụ (`purpose`) | Agent được phép | Quyền hạn | Cổng kết nối (`tool_binding`) | Timeout / Retry | Mã Test Suite |
|---|---|---|---|---|---|---|---|
| **I** | **Miền Tiếp Thị (Marketing - 7 Kỹ năng)** | | | | | | |
| 1 | `skill.mkt.analyze_market_signal` | Phân tích tín hiệu thị trường và xu hướng từ dữ liệu số | `MKT-01`, `MKT-02` | `AUTH-1` | API-002 Event Ingestion | 3000ms / 2 retries | `TC-SKILL-MKT-001` |
| 2 | `skill.mkt.segment_audience` | Phân nhóm khách hàng và tạo tập đối tượng theo RFM | `MKT-02`, `MKT-05` | `AUTH-1` | Customer 360 Store | 2500ms / 2 retries | `TC-SKILL-MKT-002` |
| 3 | `skill.mkt.check_consent` | Kiểm tra trạng thái đồng thuận liên lạc tiếp thị (BR-004) | `MKT-02`, `MKT-05`, `SAL-04` | `AUTH-3` | Consent Store (API-002) | 1000ms / 3 retries | `TC-SKILL-MKT-003` |
| 4 | `skill.mkt.generate_content` | Sinh nội dung tiếp thị đa kênh tuân thủ brand voice | `MKT-03` | `AUTH-2` | LLM Content Engine | 5000ms / 1 retry | `TC-SKILL-MKT-004` |
| 5 | `skill.mkt.audit_brand_compliance` | Kiểm duyệt tuân thủ thương hiệu, từ cấm và claim | `MKT-04` | `AUTH-1` | Second Brain (`/brand/`) | 2000ms / 2 retries | `TC-SKILL-MKT-005` |
| 6 | `skill.mkt.dispatch_campaign` | Phát động chiến dịch gửi tin tiếp thị đa kênh | `MKT-05` | `AUTH-4` | API-003 Communication | 5000ms / 0 retry | `TC-SKILL-MKT-006` |
| 7 | `skill.mkt.evaluate_attribution` | Đánh giá hiệu quả chiến dịch, tính CAC và ROAS | `MKT-06` | `AUTH-1` | Analytics Store | 4000ms / 2 retries | `TC-SKILL-MKT-007` |
| **II** | **Miền Bán Hàng (Sales - 8 Kỹ năng)** | | | | | | |
| 8 | `skill.sales.search_product` | Tra cứu sản phẩm trong danh mục theo nhu cầu khách | `SAL-01`, `SAL-02` | `AUTH-0` | API-001 CatalogConnector | 1500ms / 3 retries | `TC-SKILL-SAL-001` |
| 9 | `skill.sales.check_stock` | Tra cứu tồn kho thực tế theo kho hàng/khu vực | `SAL-01`, `SAL-02`, `CS-01` | `AUTH-0` | API-001 InventoryConnector | 3000ms / 3 retries | `TC-SKILL-SAL-002` |
| 10 | `skill.sales.check_price` | Tra cứu giá niêm yết và kiểm tra ràng buộc giá sàn $P_{floor}$ | `SAL-02`, `SAL-04` | `AUTH-0` | API-001 PricingEngine | 2000ms / 3 retries | `TC-SKILL-SAL-003` |
| 11 | `skill.sales.retrieve_customer` | Truy xuất hồ sơ Customer 360 và lịch sử mua sắm (chỉ sau khi xác minh định danh khách hàng) | `SAL-01`, `SAL-02`, `SAL-05` | `AUTH-0` | Customer 360 Store | 1500ms / 3 retries | `TC-SKILL-SAL-004` |
| 12 | `skill.sales.recommend_product` | Đề xuất sản phẩm, combo, upsell kèm Reason + Evidence | `SAL-02`, `SAL-03` | `AUTH-1` | Recommendation Engine | 2500ms / 2 retries | `TC-SKILL-SAL-005` |
| 13 | `skill.sales.create_cart` | Tạo hoặc cập nhật giỏ hàng cho phiên tương tác | `SAL-02`, `SAL-04` | `AUTH-3` | API-002 / Commerce API | 2000ms / 2 retries | `TC-SKILL-SAL-006` |
| 14 | `skill.sales.create_order` | Khởi tạo đơn hàng draft hoặc đơn đặt cọc chính thức vào ERP kèm xác thực giá phía máy chủ | `SAL-02`, `SAL-04`, `SAL-05` | `AUTH-4` | API-001 OrderConnector | 4000ms / 1 retry | `TC-SKILL-SAL-007` |
| 15 | `skill.sales.send_message` | Gửi tin nhắn tư vấn hoặc nhắc giỏ hàng kèm `effect_key` | `SAL-02`, `SAL-04`, `SAL-05` | `AUTH-3` | API-003 Communication | 3000ms / 2 retries | `TC-SKILL-SAL-008` |
| **III** | **Miền Chăm Sóc Khách Hàng (Customer Care - 8 Kỹ năng)** | | | | | | |
| 16 | `skill.care.search_faq` | Tra cứu câu hỏi - đáp đã phê duyệt trong Second Brain | `CS-01` | `AUTH-0` | Second Brain (`/customer-care/faq.md`) | 1500ms / 3 retries | `TC-SKILL-CARE-001` |
| 17 | `skill.care.lookup_order` | Tra cứu trạng thái đơn hàng, hóa đơn và lịch sử mua (chỉ sau khi xác minh định danh khách hàng) | `CS-01` | `AUTH-0` | API-001 OrderConnector | 2000ms / 3 retries | `TC-SKILL-CARE-002` |
| 18 | `skill.care.track_shipping` | Tra cứu hành trình vận đơn bưu cục và siêu thị CVS | `CS-01` | `AUTH-0` | Logistics Connector (interface); adapter cụ thể ví dụ ADPT-TW-001 là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]** | 2500ms / 3 retries | `TC-SKILL-CARE-003` |
| 19 | `skill.care.manage_case` | Tạo, cập nhật trạng thái và lưu vết vụ việc CSKH | `CS-01` | `AUTH-3` | Case Management Store | 2000ms / 3 retries | `TC-SKILL-CARE-004` |
| 20 | `skill.care.initiate_return` | Tiếp nhận yêu cầu đổi trả hàng và tạo phiếu thu hồi | `CS-01` | `AUTH-4` | Reverse Logistics Connector (interface) | 3500ms / 1 retry | `TC-SKILL-CARE-005` |
| 21 | `skill.care.escalate_to_human` | Bàn giao vụ việc cho nhân viên con người (SCR-005) | `CS-01`, `CS-02` | `AUTH-3` | Orchestrator Handoff Bus | 1000ms / 2 retries | `TC-SKILL-CARE-006` |
| 22 | `skill.care.analyze_churn_risk` | Phân tích cảm xúc tiêu cực và nguy cơ rời bỏ | `CS-02` | `AUTH-1` | Customer Intelligence | 2500ms / 2 retries | `TC-SKILL-CARE-007` |
| 23 | `skill.care.issue_retention_offer` | Cấp voucher/ưu đãi giữ chân trong hạn mức quy định | `CS-02` | `AUTH-3` | Promotion Engine ($P_{floor}$) | 3000ms / 1 retry | `TC-SKILL-CARE-008` |

**Phân tách quyền đọc và quyền trả lời:** các skill chỉ tra cứu trong Registry (`skill.sales.search_product`, `skill.sales.check_stock`, `skill.sales.check_price`, `skill.sales.retrieve_customer`, `skill.care.search_faq`, `skill.care.lookup_order`, `skill.care.track_shipping`) khai báo `AUTH-0` vì chỉ đọc dữ liệu. Việc phát câu trả lời ra kênh ngoài hoặc thao tác ghi có hạn mức là hành động riêng ở `AUTH-3` (ví dụ `skill.sales.send_message`, `skill.sales.create_cart`, `skill.care.manage_case`, `skill.care.escalate_to_human`), chịu kiểm tra consent, hạn mức tần suất và `effect_key` (BR-004, BR-005); thao tác tạo giao dịch vượt hạn mức như `skill.sales.create_order` vẫn thuộc `AUTH-4` và phải chờ phê duyệt tại SCR-003.

## 4. Máy trạng thái tác vụ thống nhất (Task State Machine)

| Trạng thái máy | Ý nghĩa vận hành | Điều kiện chuyển tiếp |
|---|---|---|
| `queued` | Đã xếp hàng chờ xử lý | Kiểm tra tài nguyên và ranh giới quyền hạn rồi cấp quyền chạy một bước |
| `running` | Đang thực thi bước hiện tại | Có kết quả → chuyển bước kế tiếp, chuyển sang chờ sự kiện, yêu cầu người duyệt hoặc kết thúc |
| `waiting` | Chờ thời điểm hoặc sự kiện bên ngoài | Tiếp tục đúng lần chạy khi nhận được sự kiện hợp lệ hoặc hết thời gian chờ |
| `awaiting_human` | Chờ người nhận bàn giao hoặc quyết định phê duyệt | Chỉ tiếp tục sau khi có sự kiện được xác thực từ nhân viên có thẩm quyền qua SCR-003 hoặc SCR-005 |
| `completed` | Đã hoàn tất kết quả yêu cầu | Kết thúc thành công lần chạy; lưu bản ghi bằng chứng và cập nhật Learning Memory |
| `stopped` | Đã dừng theo điều kiện nghiệp vụ | Kết thúc theo chủ đích (khách từ chối, rút consent, nhân viên ngắt); lưu lý do, không tự khởi động lại |
| `failed` | Lỗi không thể khắc phục | Kết thúc lần chạy; lưu đầy đủ tác động đã thực hiện/chưa rõ và tạo ticket cho nhân viên phục hồi |

Tại tầng giao diện API, hệ thống sử dụng mã HTTP `202 Accepted` kèm trạng thái `accepted` khi tiếp nhận công việc bền vững. Trạng thái `waiting` và `awaiting_human` không đồng nghĩa với hoàn tất. Mọi trạng thái chờ bắt buộc phải có thời hạn chờ tối đa (timeout) và kịch bản phân công người xử lý khi quá hạn.

Chỉ duy nhất một tiến trình được cấp quyền giữ bước thực thi tại một thời điểm. Khi hết hạn giữ bước, tiến trình tiếp theo phải đọc lại bản ghi từ cơ sở dữ liệu và đối soát trạng thái trước khi tiếp tục.

## 5. Quy trình chuỗi nhắc nhở bền vững (Durable Reminder Workflow)

Quy trình nhắc nhở thuộc quyền quản lý của Sales Agent, khởi chạy khi có tín hiệu giỏ hàng bỏ quên hoặc cơ hội bán hàng đang mở:

1. Tiếp nhận sự kiện đạt điều kiện (ví dụ: `cart.abandoned` hoặc `lead.qualified`) kèm ngữ cảnh định danh.
2. Kiểm tra chống trùng lần chạy theo khóa `tenant_id` + `customer_id` + `campaign_id`.
3. Xác định nhân viên/nhóm phụ trách; nếu hệ thống thiếu người chịu trách nhiệm thì tạm giữ quy trình ở trạng thái chờ, không tự động gửi.
4. Kiểm tra điều kiện an toàn ngay trước khi gửi:
   - Mục đích và kênh liên hệ được cấp phép theo hồ sơ consent (tuân thủ BR-004).
   - Khách hàng chưa phản hồi hoặc chưa yêu cầu dừng liên hệ.
   - Nằm trong khung giờ cho phép liên lạc và chưa vượt trần giới hạn tần suất.
   - Agent còn đầy đủ thẩm quyền và mô-đun bán hàng đang bật.
5. Phát tin nhắc đầu tiên kèm mã tác động cố định (`effect_key` - BR-005); lưu mã biên nhận tin nhắn từ Adapter nhà cung cấp.
6. Chuyển sang trạng thái `waiting` trong khoảng thời gian đã được cấu hình (ví dụ: 24 giờ).
7. Kiểm tra lại toàn bộ điều kiện an toàn; nếu vẫn hợp lệ, gửi tối đa một tin nhắc tiếp theo.
8. Kết thúc quy trình với nguyên nhân rõ ràng: khách hàng đã phản hồi, đơn hàng đã tạo, khách rút consent, đạt giới hạn số tin hoặc lỗi mạng.

Tổng giới hạn của một chuỗi nhắc là tối đa 2 tin nhắn, không cho phép lách giới hạn bằng cách sinh sự kiện mới.

| Tín hiệu dừng tức thì | Tác động vận hành |
|---|---|
| Khách hàng trả lời | Ngắt chuỗi nhắc tự động, chuyển hướng hội thoại tới bên phụ trách |
| Rút đồng ý / Yêu cầu ngừng | Dừng vĩnh viễn toàn bộ lịch gửi tương ứng và ghi nhận sự kiện rút consent (BR-004) |
| Đơn hàng hoàn tất / Đã mua | Dừng chuỗi nhắc; không tự động chuyển thành chiến dịch bán chéo khi chưa qua đánh giá |
| Nhân viên tiếp quản (`takeover`) | Khóa cứng quyền phát tin của AI lập tức; chuyển quyền kiểm soát cho nhân viên |
| Chạm giới hạn tần suất / Ngoài giờ | Tạm dừng chuỗi; việc kích hoạt lại bắt buộc phải qua quyết định điều phối mới |
| Quá số lần thử lại thất bại | Chuyển sang `failed` và thông báo cho nhân viên vận hành tại SCR-002 |

### Kiểm soát chi phí kênh tương tác và bảo vệ tài chính (Messaging Cost Guard & FX Safeguards)

Nhằm tối ưu chi phí vận hành kênh theo NFR-010 và bảo vệ an toàn biên lợi nhuận giao dịch (BR-001, BR-002), hệ thống thiết lập 3 cơ chế kiểm soát tự động:

1. **Phân biệt tin nhắn WhatsApp (< 24h Session vs > 24h Template có tính phí)**:
   - *Cửa sổ hội thoại 24 giờ (< 24h Session Window)*: Bắt đầu tính từ tin nhắn gần nhất khách hàng gửi đến doanh nghiệp. Trong cửa sổ 24 giờ này, AI Agent được phép gửi tin nhắn tự do (Session Messages / Free-form text) phục vụ tư vấn bán hàng hoặc CSKH với mức phí dịch vụ cơ sở thấp (hoặc miễn phí theo định mức Meta).
   - *Ngoài cửa sổ 24 giờ (> 24h Template Window)*: Sau khi hết 24 giờ kể từ tương tác cuối của khách hàng, hệ thống khóa cứng việc gửi tin tự do (`AUTH-5` cho free-form text). AI Agent chỉ được phép gửi các mẫu tin nhắn đã được Meta tiền phê duyệt (Pre-approved Message Templates) thuộc danh mục Utility hoặc Marketing có tính phí phát sinh theo biểu giá nhà mạng. Mọi chiến dịch gửi tin mẫu diện rộng bắt buộc phải qua phê duyệt tại SCR-003 (`AUTH-4`).

2. **Kiểm soát trần phí tin LINE OA (LINE OA Messaging Cost Guard)**:
   - LINE Official Account áp dụng định mức tin nhắn miễn phí hàng tháng (Free Message Quota) và tính phí lũy tiến trên từng tin nhắn đẩy (Pay-as-you-go Push Fee).
   - *Cơ chế Messaging Cost Guard*:
     - Giám sát thời gian thực số lượng tin nhắn đẩy đã tiêu thụ trong chu kỳ thanh toán của từng tenant.
     - Khi số tin gửi đạt ngưỡng cảnh báo (80% định mức miễn phí hoặc chạm trần ngân sách tin nhắn tháng do tenant cấu hình), hệ thống tự động:
       a) Ngăn chặn việc gửi tin nhắn tiếp thị broadcast không cấp thiết (`AUTH-4` hoặc chuyển cấm `AUTH-5`),
       b) Ưu tiên chuyển hướng tương tác sang kênh miễn phí (Web Chat Widget / In-app notification) hoặc lưu vào hàng đợi chờ người dùng chủ động tương tác trước để trả lời bằng tin nhắn phản hồi miễn phí (Reply Message API thay vì Push Message API).

3. **Khóa tỷ giá có thời hạn (FX Rate Buffer) bảo vệ giá sàn toán học $P_{floor}$ khi giao dịch ngoại tệ**:
   - Khi xử lý giao dịch ngoại tệ hoặc thương mại xuyên biên giới (TWD, USD, EUR, JPY, VND), biến động tỷ giá hối đoái tức thời có thể làm suy giảm biên lợi nhuận thực tế và vi phạm giá sàn an toàn toán học $P_{floor}$ (vi phạm BR-001, BR-002).
   - *Cơ chế FX Rate Buffer*:
     - **Ảnh chụp tỷ giá có thời hạn (Time-locked FX Snapshot)**: Khi tạo báo giá hoặc phiên tư vấn giỏ hàng, Core Engine khóa tỷ giá quy đổi trong một cửa sổ thời gian hữu hạn (mặc định 15 - 30 phút).
     - **Biên độ dự phòng tỷ giá (FX Safety Buffer)**: Tích hợp biên độ an toàn từ 1.5% đến 2.0% vào công thức tính giá bán khả dụng (cộng thêm vào giá vốn quy đổi hoặc trừ trực tiếp khỏi hạn mức chiết khấu $D_{cap}$), bảo đảm rằng ngay cả trong kịch bản tỷ giá biến động bất lợi nhất trong phiên, giá bán của AI luôn $\ge P_{floor}$.
     - **Kiểm tra lại khi hết hạn (Quote Expiration Guard)**: Nếu khách hàng tiến hành thanh toán sau khi khóa tỷ giá hết hạn (`quote_expired`), hệ thống bắt buộc phải cập nhật tỷ giá hối đoái mới nhất từ cổng thanh toán qua Payment Connector interface (API-001; adapter cụ thể như ADPT-GL-002 là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]**) và tái thẩm định điều kiện an toàn $P_{floor}$ trước khi cho phép tạo đơn hàng chính thức.

<a id=section-14></a>

## 6. Quy trình bàn giao nhân viên (Handoff & Takeover)

### Khóa xung đột phiên (Session Mutex Lock)

Hệ thống bảo đảm nguyên tắc độc quyền phát tin: Tại một thời điểm duy nhất, chỉ có đúng một bên (AI Agent HOẶC Nhân viên con người) nắm quyền phát thông điệp nghiệp vụ ra kênh tương tác bên ngoài.

```
[Khách yêu cầu người thật / Cảm xúc tiêu cực / Sự cố vượt quyền]
                           ↓
[1. Yêu cầu bàn giao: Phát sự kiện handover.requested]
                           ↓
[2. Khóa chờ (awaiting_human): Bot dừng phát tin nghiệp vụ]
                           ↓
[3. Nhân viên tiếp quản (human.takeover) tại SCR-005]
                           ↓
[4. Khóa cứng bot (Hard Lock): Bot chỉ hỗ trợ Copilot nháp (AUTH-2)]
                           ↓
[5. Nhân viên xử lý xong: Bấm "Trả lời cho AI" (human.resume)]
                           ↓
[6. Đối soát điều kiện an toàn -> Bot kích hoạt lại quyền chat]
```

### Cơ chế ngăn bot tự giành quyền (Anti-Bot Reclaim)

1. **Khóa cứng ở tầng máy chủ (Hard Server Lock)**: Khi trạng thái phiên chuyển sang `human.takeover`, Core Engine thu hồi toàn bộ quyền phát tin của AI trên phiên hội thoại đó (`AUTH-5` đối với hành động gửi tin ra ngoài). Mọi yêu cầu phát tin tự động từ AI Agent bị máy chủ từ chối thẳng thừng.
2. **Chế độ trợ lý đồng hành (Copilot Mode)**: Trong khi nhân viên đang tiếp quản, AI chỉ được hoạt động ở cấp độ `AUTH-1` (gợi ý thông tin) hoặc `AUTH-2` (soạn sẵn câu trả lời nháp). Các gợi ý này chỉ hiển thị trên màn hình SCR-005 của nhân viên, hoàn toàn ẩn với khách hàng.
3. **Cấm tự giành quyền**: AI tuyệt đối không thể tự kích hoạt lại quyền điều khiển phiên dựa trên nội dung tin nhắn mới của khách hàng.
4. **Quy trình khôi phục có xác thực**: Quyền điều khiển chỉ được hoàn trả cho AI khi nhân viên chủ động gửi sự kiện `human.resume` có chữ ký xác thực từ SCR-005. Hệ thống đọc lại ngữ cảnh, kiểm tra consent và trạng thái đơn hàng trước khi cho phép AI tiếp tục trả lời.

## 7. Thử lại, đối soát và an toàn sự cố (Fail Closed)

| Tình huống sự cố | Cơ chế xử lý kỹ thuật |
|---|---|
| Lỗi mạng tạm thời, quá tải tốc độ (Rate limit) | Thử lại hữu hạn theo thuật toán exponential backoff, giữ nguyên mã tác động duy nhất `effect_key` (BR-005, BR-006, NFR-003) |
| Lỗi nghiệp vụ, từ chối quyền hạn, vi phạm chính sách | Không thử lại tự động; chuyển trạng thái sang `failed`, ghi nhận sự kiện kiểm toán và cảnh báo tại SCR-002 (BR-008) |
| Quá hạn thời gian (Timeout) sau khi có khả năng đã ghi nhận thành công | Truy vấn đối soát hệ thống nguồn (API-001) theo mã tham chiếu trước khi quyết định gửi lại |
| Tiếp nhận sự kiện lặp lại | Trả về kết quả đã xử lý trước đó; nếu cùng mã sự kiện nhưng khác payload nội dung thì báo lỗi xung đột (`IDEMPOTENCY_CONFLICT`) |
| Tiến trình chết đột ngột / Hết hạn giữ bước | Đọc lại trạng thái từ cơ sở dữ liệu bền vững, thực hiện đối soát trước khi tiếp tục, tuyệt đối không gửi lại mù |
| Tiếp nhận tín hiệu dừng trong lúc chờ thử lại | Hủy bỏ ngay các lần thử còn lại và ghi nhận lý do dừng |
| Không xác định được tác động / Thiếu dữ liệu nguồn | **Fail Closed (NFR-008)**: Gắn nhãn kết quả `uncertain`, chặn thực thi, bảo lưu trạng thái và thông báo cho người xử lý; tuyệt đối không giả định thất bại để chạy lại |

Mọi thao tác bù trừ tài chính, hoàn tiền hoặc hủy đơn hàng là hành động mới có mã tác động riêng và bắt buộc phải qua phê duyệt của con người (`AUTH-4`).

## 8. Quy trình nghiệp vụ mở rộng sau bản đầu

| Quy trình mở rộng | Điều kiện kích hoạt và kiểm soát an toàn |
|---|---|
| Tiếp thị chăm sóc và nuôi dưỡng lead | Kênh liên hệ được cấp phép, nội dung chiến dịch được duyệt qua SCR-003, consent còn hiệu lực |
| Thương lượng giá tự động | Giới hạn ngân sách nghiêm ngặt, tuân thủ giá sàn toán học ($P_{floor}$), báo giá có thời hạn hiệu lực cố định |
| Bù giá và cấp mã giảm giá | Xác minh điều kiện đơn hàng, ngân sách bù giá sẵn có, chống cấp trùng voucher và kiểm soát trần ngân sách |
| Tái kích hoạt và gia hạn hợp đồng | Tín hiệu mua lại còn hiệu lực, không tạo cơ hội trùng lặp, thông báo cho nhân viên kinh doanh phụ trách |
| Phản hồi và cập nhật Second Brain | Bằng chứng lỗi được ghi nhận → Chủ sở hữu tài liệu chỉnh sửa → Duyệt phiên bản mới → Chạy lại bộ kiểm thử tự động |

## 9. Bằng chứng kiểm thử nghiệm thu quy trình

1. **TC-E2E-002**: Marketing Agent tuyệt đối không thể phát động chiến dịch diện rộng nếu thiếu phê duyệt tại Approval Center (`AUTH-4`).
2. **TC-E2E-003**: Sales Agent không thể cung cấp giá hoặc chiết khấu vi phạm chính sách giá sàn $P_{floor}$ (BR-001, BR-002, BR-003).
3. **TC-E2E-005**: Thử nghiệm gửi lại (Retry) với cùng `effect_key` không bao giờ tạo ra tin nhắn hoặc đơn hàng thứ hai (BR-005, BR-006, NFR-003).
4. **TC-E2E-006**: Mọi hành vi cố tình vượt quyền hạn (kể cả prompt injection từ khách) đều bị hệ thống từ chối (DENY) và sinh bản ghi kiểm toán (BR-008, BR-009, NFR-001).
5. **TC-E2E-007**: Khách hàng thiếu consent hoặc đã rút consent phải bị loại trừ lập tức khỏi mọi luồng gửi tin tiếp thị (BR-004).
6. **Kiểm soát tiếp quản nhân viên (SCR-005)**: Sau khi nhân viên kích hoạt `human.takeover`, AI bị khóa cứng quyền phát tin; AI không thể tự giành lại quyền trả lời khi chưa có sự kiện xác thực `human.resume`.
7. **Đối soát phục hồi sau sự cố**: Hệ thống mô phỏng tiến trình chết đột ngột giữa chừng và phục hồi trạng thái từ hàng đợi bền vững mà không phát sinh tác động kép ngoài ý muốn.

