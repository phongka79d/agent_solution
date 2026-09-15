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

### Cấu trúc Nhật ký Kiểm toán Lần chạy Agent (Agent Run Log Schema — 17 Trường bắt buộc theo Mục 17 SRS)

Tuân thủ Mục 17 của SRS (AI-REV-SRS-001), mỗi lần chạy của bất kỳ AI Agent nào trong hệ thống (Agent Run) bắt buộc phải ghi lại đầy đủ 17 trường thông tin vào Audit Store phục vụ giám sát thời gian thực tại SCR-002 và truy vết hồi tố (TC-E2E-009):

| STT | Trường dữ liệu (Field) | Kiểu dữ liệu | Ý nghĩa & Quy cách chuẩn hóa |
|---|---|---|---|
| 1 | `run_id` | `UUID v4` | Mã định danh duy nhất của phiên chạy Agent; không trùng lặp |
| 2 | `agent_id` | `String` | Mã định danh Agent thực thi (ví dụ: `MKT-05`, `SAL-02`, `CS-01`) |
| 3 | `customer_or_entity_id` | `String` | Khách hàng hoặc thực thể chịu tác động (`customer_id`, `lead_id`, `case_id`) |
| 4 | `trigger` | `String` | Sự kiện hoặc tín hiệu kích hoạt (`cart.abandoned`, `message.received`, `lead.qualified`) |
| 5 | `context` | `JSON Object` | Ảnh chụp ngữ cảnh đầu vào: lát cắt Customer 360, trạng thái consent, phiên hội thoại |
| 6 | `skill` | `String` | Mã kỹ năng được kích hoạt (ví dụ: `skill.sales.check_stock`, `skill.care.lookup_order`) |
| 7 | `tool` | `String` | Cổng kết nối Adapter hoặc công cụ thực thi liên kết (API-001, API-002, ADPT-TW-001) |
| 8 | `decision` | `JSON Object` | Quyết định logic được Orchestrator xác lập kèm lý do (Reason) |
| 9 | `authority` | `Enum` | Cấp độ thẩm quyền áp dụng (`AUTH-0` đến `AUTH-5`) |
| 10 | `approval` | `JSON Object \| null` | Bản ghi duyệt của con người nếu là `AUTH-4` (`{approver_id, decision, timestamp, reason}`) |
| 11 | `action` | `JSON Object` | Payload chi tiết của hành động gửi ra ngoài kèm mã chống trùng `effect_key` (BR-005) |
| 12 | `execution_status` | `Enum` | Trạng thái thực thi (`pending`, `executing`, `success`, `failed`, `denied`, `aborted`) |
| 13 | `evidence` | `JSON Object` | Bản ghi bằng chứng xác thực từ hệ thống nguồn (mã vận đơn, mã đơn ERP, message ID) |
| 14 | `outcome` | `JSON Object \| null` | Kết quả kinh doanh thực tế sau đó (`order_created`, `cart_recovered`, `case_resolved`) |
| 15 | `latency_ms` | `Integer` | Tổng thời gian thực thi của lần chạy tính bằng mili-giây (ms) |
| 16 | `cost` | `JSON Object` | Chi phí vận hành: Token input/output, chi phí API mô hình, phí kết nối Adapter quy đổi |
| 17 | `error` | `JSON Object \| null` | Chi tiết mã lỗi, nhật ký lỗi (error stack) và nguyên nhân thất bại (nếu có) |
| * | `timestamp` | `ISO 8601 UTC` | Mốc thời gian bắt đầu và kết thúc lượt chạy (`started_at`, `completed_at`) |

## 2. Mô hình phân quyền (Authority Model) và Quy tắc nghiệp vụ (Business Rules)

### Mô hình phân quyền 6 cấp độ (Authority Model)

Hệ thống quản trị mọi hành động của AI theo 6 cấp bậc thẩm quyền cố định; Agent bị chặn cứng ở tầng máy chủ, không thể tự nâng cấp quyền hạn:

| Cấp độ | Tên quyền | Định nghĩa & Ranh giới hoạt động | Ví dụ áp dụng |
|---|---|---|---|
| `AUTH-0` | Observe | Chỉ đọc dữ liệu, quan sát hành vi, dòng sự kiện và tra cứu tài liệu công khai | Đọc Timeline Customer 360, tra cứu tài liệu Second Brain |
| `AUTH-1` | Recommend | Phân tích dữ liệu và đề xuất phương án cho con người hoặc Agent khác | Gợi ý sản phẩm phù hợp, chấm điểm cơ hội (lead scoring) |
| `AUTH-2` | Draft | Tạo nội dung hoặc hành động ở dạng bản nháp nội bộ, chưa gửi ra ngoài | Soạn thảo tin nhắn, lập dàn ý chiến dịch, chuẩn bị draft order |
| `AUTH-3` | Bounded Execute | Tự thực thi các tác vụ rủi ro thấp trong hạn mức và tần suất được cấu hình trước | Trả lời FAQ từ tài liệu đã duyệt, tra cứu trạng thái đơn, gửi tin nhắc giỏ trong hạn mức tần suất |
| `AUTH-4` | Approval Required | Chuẩn bị đầy đủ payload hành động nhưng bắt buộc dừng chờ con người phê duyệt tại SCR-003 | Phát động chiến dịch diện rộng, chiết khấu vượt trần, bồi thường, hoàn tiền, thay đổi chính sách |
| `AUTH-5` | Prohibited | Tuyệt đối cấm; hệ thống chặn cứng ở tầng máy chủ (Hard Lock) | Tự tạo giá sản phẩm mới, truy cập dữ liệu chéo tenant, xuất dữ liệu khách hàng thô, tự nâng quyền |

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
  "required_authority": "AUTH-3",
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

11 trường chuẩn hóa của Skill System Contract:
1. **Skill ID**: Mã định danh duy nhất (chuẩn phân cấp: `skill.<domain>.<action>`).
2. **Purpose**: Mô tả mục đích nghiệp vụ và phạm vi hoạt động cụ thể của skill.
3. **Input / Output Schema**: Định nghĩa cấu trúc dữ liệu nghiêm ngặt theo JSON Schema.
4. **Allowed Agents**: Danh sách mã định danh Agent được phép kích hoạt skill.
5. **Required Authority**: Cấp độ quyền hạn tối thiểu để kích hoạt skill (từ `AUTH-0` đến `AUTH-4`).
6. **Tool / Connector Binding**: Cổng kết nối Adapter hoặc công cụ thực thi tương ứng (API-001, API-002, API-003, Adapter).
7. **Validation Rules**: Quy tắc kiểm tra tính hợp lệ của tham số và điều kiện tiên quyết trước khi thực thi.
8. **Retry Policy**: Chính sách thử lại (số lần thử tối đa, hệ số lùi thời gian exponential backoff, điều kiện dừng lỗi cứng).
9. **Timeout & Circuit Breaker**: Thời gian chờ tối đa (ms) và ngưỡng ngắt mạch bảo vệ hệ thống khi dịch vụ đích gặp sự cố.
10. **Audit & Evidence Specification**: Cấu hình ghi nhật ký kiểm toán, danh sách trường nhạy cảm cần ẩn danh (PII masking) và định dạng thẻ bằng chứng.
11. **Automated Test Cases**: Bộ kiểm thử tự động gồm ca thành công, lỗi mạng, quá hạn thời gian, vi phạm phân quyền và dữ liệu sai cấu trúc.

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

