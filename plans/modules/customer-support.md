# Mô-đun Chăm sóc khách hàng — Giải quyết vấn đề và giữ niềm tin

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P1 bao gồm hỏi đáp FAQ, tra cứu trạng thái đơn hàng qua ERP có evidence (`skill.care.lookup_order` - PILOT-03), hướng dẫn giới hạn và bàn giao (escalation); các tác vụ phiếu bù giá, đổi trả và tích hợp logistics chuyên sâu cần kết nối/nghiệm thu sau.

<a id=section-8></a>

# PHẦN 1: KHUNG GẦM KỸ THUẬT CHUẨN SRS (CORE CARE & RETENTION ENGINE)

## 1. Mục tiêu và ranh giới

Giúp khách dùng sản phẩm thành công, xử lý vấn đề nhất quán và được gặp nhân viên khi cần. Hỗ trợ là một phần của sản phẩm, không phải điểm cuối sau bán (khớp mục tiêu **OBJ-003** và **OBJ-004** trong SRS).

Chăm sóc có thể nhận câu hỏi trước mua. Câu hỏi công dụng chung dùng nguồn đã duyệt; khi khách cần đề xuất thương mại hoặc mua hàng, bàn giao Bán hàng (SAL-02) nếu bật, nếu không thì chuyển nhân viên. Không trì hoãn giải quyết khiếu nại để bán thêm. Mọi hành vi tra cứu phải tuân thủ nguyên tắc cô lập ngữ cảnh khách hàng (**NFR-006**: dữ liệu khách A không được xuất hiện trong ngữ cảnh khách B), cô lập đa doanh nghiệp theo `tenant_id` (lớp phòng vệ bổ sung, tách biệt với NFR-006) và xử lý an toàn thất bại (**NFR-008 - Fail Closed**). Việc xác minh định danh khách hàng (TC-E2E-004) bắt buộc hoàn tất trước khi tra cứu hồ sơ khách hàng hoặc đơn hàng.

## 2. Hệ thống Agent Chăm sóc & Giữ chân khách hàng chuẩn SRS (CS-01 & CS-02)

Mô-đun vận hành với 2 Agent chủ lực chịu trách nhiệm xuyên suốt chuỗi hỗ trợ và duy trì quan hệ khách hàng:

### 2.1. CS-01 - Omnichannel Customer Care Agent

Tiếp nhận tương tác đa kênh: Web Chat, Mobile App, mạng xã hội (Facebook, TikTok Shop), Zalo OA, LINE OA, Email và các connector được phê duyệt.

**FR-CS-001 - MUST: Nhận biết tối thiểu 10 nhóm Intent chuẩn:**
1. **Hỏi thông tin sản phẩm (Product Info):** Tính năng, công dụng, thông số kỹ thuật đã kiểm duyệt.
2. **Tra cứu giá & ưu đãi (Price & Promotions):** Bảng giá niêm yết, chính sách khuyến mãi hiện hành.
3. **Kiểm tra tồn kho (Stock Availability):** Khả dụng của SKU tại các kho hoặc cửa hàng gần nhất.
4. **Trạng thái đơn hàng (Order Status):** Xác nhận đơn, đang đóng gói, mã vận đơn, thời gian giao dự kiến.
5. **Giao hàng & vận chuyển (Shipping Tracking):** Định vị đơn, đổi điểm nhận hàng siêu thị tiện lợi (CVS).
6. **Đổi / Trả / Hoàn tiền (Return & Refund):** Quy trình trả hàng, chính sách bảo hành, hoàn tiền.
7. **Xử lý sự cố thanh toán (Payment Issue):** Thanh toán lỗi, trùng lệnh, chưa nhận tiền mặt CVS COD.
8. **Tiếp nhận khiếu nại (Complaint Management):** Hàng lỗi, thái độ phục vụ, sai sót giao vận.
9. **Hướng dẫn sử dụng & kỹ thuật (Usage & Technical Support):** Hướng dẫn kích hoạt, xử lý sự cố cơ bản.
10. **Yêu cầu gặp nhân viên (Human Escalation):** Khách chủ động đòi gặp người thật hoặc vấn đề vượt thẩm quyền.

**FR-CS-002 - MUST: Ma trận định tuyến quyết định của CS-01:**
- **Tự trả lời (AUTH-3):** Đối với câu hỏi FAQ, chính sách công khai đã được duyệt trong `/customer-care/faq.md`.
- **Tra cứu dữ liệu (AUTH-0):** Đọc trạng thái đơn hàng, vận chuyển qua API ERP/WMS sau khi đã xác minh danh tính khách hàng thành công (**TC-E2E-004**).
- **Thực thi hành động giới hạn (AUTH-3):** Cập nhật ghi chú giao hàng, tạo yêu cầu đổi trả theo điều kiện có sẵn.
- **Bàn giao Agent khác:** Chuyển sang Sales (SAL-02/SAL-03) khi khách phát sinh nhu cầu mua sắm mới; chuyển sang CS-02 khi phát hiện tín hiệu cần giữ chân.
- **Chuyển người thật (Human Escalation):** Khiếu nại nghiêm trọng, tranh chấp pháp lý, khách kích động, hoặc hệ thống thiếu dữ liệu xác thực.

### 2.2. CS-02 - Retention / Customer Success Agent

Chủ động phát hiện các nguy cơ rời bỏ hoặc cơ hội mở rộng giá trị vòng đời: khách ngừng tương tác (inactivity), giảm tần suất mua sắm, khách không hài lòng (dissatisfaction), đơn hàng lỗi/hủy (failed order), khiếu nại lặp lại (repeated complaint), cơ hội mua bổ sung (replenishment) và thu hồi khách cũ (win-back).

**FR-CS-003 - MUST: Quy trình vận hành 6 bước chuẩn (Retention Workflow):**
```text
[Signal] (Phát hiện tín hiệu bất thường trên Customer 360 Timeline)
   │
   ▼
[Hypothesis] (Xây dựng giả thuyết nguyên nhân; không ghi đè thành Fact)
   │
   ▼
[Recommended Action] (Đề xuất Next-Best-Action: hỏi thăm, bù giá, ưu đãi cá nhân hóa)
   │
   ▼
[Eligibility Check] (Kiểm tra chính sách, consent, hạn mức ngân sách điểm thưởng)
   │
   ▼
[Execution / Approval] (AUTH-3 tự thực thi nếu trong hạn mức; AUTH-4 trình người duyệt nếu chi phí lớn)
   │
   ▼
[Outcome] (Đo lường phản hồi của khách, tỷ lệ giữ chân và ghi nhận vào Learning Memory)
```

**Ranh giới trách nhiệm giữa CS-02 và SAL-05 (Replenishment Boundary & Conflict Prevention):**
- **CS-02 (Retention Sensor):** Đóng vai trò cảm biến vòng đời, chỉ phát hiện tín hiệu mua lại (Replenishment Signal) từ chu kỳ tiêu dùng thực tế hoặc tương tác CSKH và đẩy sự kiện sang Revenue Orchestrator. **CS-02 tuyệt đối không tự ý phát lệnh gửi tin nhắn reorder độc lập** đến khách hàng nhằm tránh xung đột thông điệp và ngăn ngừa vi phạm BR-006.
- **Revenue Orchestrator & SAL-05 (Reorder Execution):** Revenue Orchestrator đóng vai trò điều phối tập trung, tiếp nhận tín hiệu từ CS-02, giải quyết xung đột đa kênh rồi giao việc cho SAL-05. SAL-05 thực hiện kiểm tra toàn diện: đồng thuận khách hàng (BR-004), tồn kho và giá niêm yết (BR-001, BR-003), quy tắc chống làm phiền (suppression rules) và chống gửi lặp (BR-006) trước khi tạo và gửi thông điệp mời tái đặt hàng.

## 3. Hệ thống Quản lý Vụ việc (Case Management State Machine)

Mọi yêu cầu hỗ trợ hoặc khiếu nại đều được theo dõi dưới dạng Case có cấu trúc, vận hành theo State Machine chuẩn gồm 7 trạng thái cơ bản theo baseline, kèm đường chuyển tiếp mở lại vụ việc (REOPENED):
`NEW → CLASSIFIED → ASSIGNED → IN_PROGRESS → WAITING_CUSTOMER → RESOLVED → CLOSED` + nhánh `REOPENED` (quay về IN_PROGRESS/ASSIGNED)

```text
[NEW] ──► [CLASSIFIED] ──► [ASSIGNED] ──► [IN_PROGRESS] ──► [WAITING_CUSTOMER] ──► [RESOLVED] ──► [CLOSED]
                                │               ▲                    │                 │             │
                                └───────────────┴────────────────────┘                 │             │
                                                ▲                                      │             │
                                                └─────────────── [REOPENED] ◄──────────┴─────────────┘
                                                      (Khách khiếu nại tiếp / chưa thỏa mãn)
```

### 3.1. Đặc tả các trạng thái vòng đời Case
1. **NEW:** Vụ việc mới được khởi tạo từ tin nhắn/yêu cầu của khách qua kênh bất kỳ.
2. **CLASSIFIED:** CS-01 đã phân loại Intent, gắn nhãn mức độ ưu tiên (P1-Khẩn cấp đến P4-Thấp) và liên kết hồ sơ khách hàng.
3. **ASSIGNED:** Hệ thống phân bổ quyền xử lý cho Agent (CS-01/CS-02) hoặc nhân viên hỗ trợ chuyên trách.
4. **IN_PROGRESS:** Đang tích cực tra cứu dữ liệu, hướng dẫn khách hàng hoặc xử lý nghiệp vụ với các bên liên quan.
5. **WAITING_CUSTOMER:** Tạm dừng tính SLA chờ phản hồi hoặc cung cấp thêm thông tin từ phía khách hàng.
6. **RESOLVED:** Đã cung cấp giải pháp hoặc hoàn tất xử lý; chờ xác nhận hài lòng từ khách hàng.
7. **CLOSED:** Khách hàng xác nhận hài lòng hoặc quá thời gian quy định sau giải quyết mà không có khiếu nại thêm.
8. **REOPENED:** Vụ việc được mở lại khi khách hàng tiếp tục khiếu nại, phản hồi chưa hài lòng hoặc phát sinh vấn đề liên quan từ trạng thái RESOLVED hoặc CLOSED. Hệ thống chuyển tiếp Case quay lại IN_PROGRESS/ASSIGNED, giữ nguyên mã Case ID cũ và bảo toàn lịch sử bằng chứng (Evidence) theo đúng thời hạn lưu trữ do chính sách dữ liệu của tenant quy định (**[UNCONFIRMED][ASM-005]**).

### 3.2. Cấu trúc dữ liệu Case bắt buộc
Mỗi Case phải lưu trữ tối thiểu các trường dữ liệu:
`Case_Record = { Case_ID, Customer_ID, Intent, Priority, Conversation_ID, Related_Order_ID, Evidence_Refs, Owner_Type (AI/Human), Owner_ID, Status, SLA_Target, Resolution_Summary, Outcome_Metric }`.
Tuyệt đối không đóng Case đơn phương khi chưa có xác nhận hoặc kết quả nhân viên có bằng chứng.

### 3.3. Hệ thống Kỹ năng Chăm sóc & Giữ chân (Care & Retention Skill System)

Theo Mục 11 của SRS, các Agent CS-01 và CS-02 gọi các Skill chuyên trách thông qua Orchestrator với hợp đồng kiểm soát nghiêm ngặt:

| Mã Skill (Skill ID) | Mục đích (Purpose) | Agent được phép dùng | Quyền hạn yêu cầu | Tool / Connector (interface) | Quy tắc kiểm tra (Validation) & Audit |
|---|---|---|---|---|---|
| `skill.care.search_faq` (bí danh hiển thị: `search-faq`) | Tra cứu FAQ và chính sách bảo hành, đổi trả đã được duyệt từ Second Brain | CS-01 | AUTH-0 (Observe) | Knowledge Base interface (`/customer-care`) | Chỉ trích dẫn tài liệu trạng thái `approved`; không bịa chính sách |
| `skill.care.lookup_order` (bí danh hiển thị: `lookup-order`) | Tra cứu thông tin đơn hàng, trạng thái xử lý và thanh toán từ ERP/OMS (**chỉ sau khi đã xác minh danh tính khách hàng**) | CS-01 | AUTH-0 (Observe) | Order Connector interface (API-001) | Bắt buộc xác minh danh tính khách hàng (Customer Verification - TC-E2E-004) **trước** khi tra cứu |
| `skill.care.track_shipping` (bí danh hiển thị: `track-shipping`) | Tra cứu hành trình vận chuyển thực tế và mã bưu gửi siêu thị CVS | CS-01 | AUTH-0 (Observe) | Logistics Connector interface; adapter cụ thể theo thị trường (ví dụ ADPT-TW-001) là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]** | Trả về dữ liệu hành trình vật lý từ nhà vận chuyển; ghi log tra cứu |
| `skill.care.manage_case` (bí danh hiển thị: `manage-case`) | Khởi tạo, cập nhật trạng thái hoặc đóng/mở lại vụ việc theo State Machine chuẩn (kèm REOPENED) | CS-01 | AUTH-3 (Bounded Execute) | Case Management Store | Tuân thủ nghiêm ngặt chuyển tiếp trạng thái; không đóng case đơn phương |
| `skill.care.initiate_return` (bí danh hiển thị: `initiate-return`) | Khởi tạo yêu cầu đổi/trả hàng nháp, thu thập hình ảnh và lý do khiếu nại | CS-01 | AUTH-2 (Draft) / AUTH-4 (Refund) | Returns API / Core Engine | Kiểm tra điều kiện thời hạn đổi trả; hoàn tiền bắt buộc người duyệt (AUTH-4 quy tắc cố định theo BR-007, ASM-004) |
| `skill.care.escalate_to_human` (bí danh hiển thị: `escalate-to-human`) | Bàn giao phiên chat và vụ việc sang hàng đợi nhân viên tại SCR-005 | CS-01 | AUTH-3 (Bounded Execute) | Conversation Console interface (SCR-005) | Kích hoạt khóa phiên (Session Mutex Lock); AI ngừng trả lời nghiệp vụ |
| `skill.care.analyze_churn_risk` (bí danh hiển thị: `analyze-churn-risk`) | Nhận diện tín hiệu bất thường (ngừng mua, giảm tần suất) trên Customer 360 | CS-02 | AUTH-1 (Recommend) | Customer 360 Analytics Layer | Ghi nhận dưới dạng HYPOTHESIS; không ghi đè thành FACT (FR-C360-003) |
| `skill.care.issue_retention_offer` (bí danh hiển thị: `issue-retention-offer`) | Phát hành ưu đãi/voucher giữ chân hoặc điểm thưởng trong hạn mức ngân sách | CS-02 | AUTH-3 (trong hạn mức do tenant cấu hình) / AUTH-4 (vượt trần **[UNCONFIRMED][ASM-003]**) | Promotion Engine / Loyalty Store | Kiểm tra hạn mức ngân sách và trần ưu đãi ($D_{cap}$); gắn mã `effect_key` |

**Phân tách quyền đọc và quyền trả lời:** các skill chỉ tra cứu (`skill.care.search_faq`, `skill.care.lookup_order`, `skill.care.track_shipping`) khai báo `AUTH-0 (Observe)` vì chỉ đọc dữ liệu. Việc phát câu trả lời ra kênh ngoài hoặc thao tác ghi có hạn mức là hành động riêng ở `AUTH-3` (ví dụ `skill.care.manage_case`, `skill.care.escalate_to_human`), chịu kiểm tra consent, hạn mức và `effect_key`. Mã kebab trần chỉ là bí danh hiển thị; ID chuẩn dùng trong Registry, hợp đồng skill và audit log là `skill.<domain>.<action>`.

## 4. Năng lực được hợp nhất

| Năng lực | Thực hiện tối thiểu | Giai đoạn |
|---|---|---|
| Hỏi đáp và hướng dẫn | Tìm tài liệu đã duyệt, giải thích có nguồn | P1 |
| Gợi ý câu hỏi theo ngữ cảnh | Vài câu ngắn dựa trên trang/sản phẩm hợp lệ; dữ liệu riêng cần xác minh | P1 nếu giao diện hỗ trợ |
| Tra cứu trạng thái đơn/giao hàng qua ERP (`skill.care.lookup_order`; bí danh hiển thị: `lookup-order`) | Kết nối ERP/OMS (API-001), xác minh danh tính khách hàng (TC-E2E-004), hiển thị trạng thái thực tế và thời điểm đối soát có evidence | P1 (PILOT-03) |
| Nút liên hệ người giao | Chỉ hiển thị thông tin nguồn cho phép và người mua có quyền xem | P2 |
| Phiếu hỗ trợ và ưu tiên thời gian | Tạo/cập nhật có xác nhận, bàn giao người nhận | P2 |
| Bù giá bằng phiếu mua lần sau | Chính sách, ngân sách, kiểm tra điều kiện, duyệt/cấp một lần | P2 thử có người duyệt; P3 tự động giới hạn |
| Dùng ảnh/video hỗ trợ xử lý | Nhận tài liệu theo quyền, AI tóm tắt cho nhân viên | P3 xem xét, không tự quyết đổi trả |
| Tín hiệu mua lại/nâng cấp | Ghi nhu cầu thật; Bán hàng chịu trách nhiệm đề nghị thương mại | P1 ghi nhận; tự động mở rộng sau |

Tra cứu hai giai đoạn: lọc đúng sản phẩm/quyền rồi tìm tài liệu liên quan. Chưa cần thêm hệ thống xếp hạng phức tạp nếu tìm kiếm đơn giản đáp ứng bộ thử; chỉ bổ sung khi đo được khoảng trống chất lượng.

## 5. Khiếu nại và bàn giao khẩn (Human Escalation)

Các tín hiệu bảo mật, an toàn, tranh chấp nghiêm trọng, lặp lỗi hoặc khách yêu cầu người thật cần chuyển người có trách nhiệm. Từ khóa chỉ là một tín hiệu, không phải bộ phân loại đáng tin duy nhất.

Mục tiêu gọi lại dưới hai phút chỉ là mục tiêu thử nghiệm khi có nhân sự trực và điều kiện đáp ứng, không phải lời hứa 24/7. Chưa có người nhận thì thông báo đang chờ và thời gian dự kiến được cấu hình.

Gói bàn giao chứa: thông tin khách đã xác minh, vấn đề cụ thể, kết quả mong muốn, đơn hàng/sản phẩm liên quan, tài liệu nguồn, các bước đã thử, mức độ ảnh hưởng và hành động tiếp theo. Nhân viên nhận trách nhiệm thì AI ngừng trả lời nghiệp vụ. Thời hạn chờ phải có người theo dõi; hết hạn không tự đánh dấu giải quyết.

## 6. Phản hồi để cải tiến

Tổng hợp câu hỏi lặp lại, lý do không phù hợp, lỗi sử dụng, khiếu nại và yêu cầu đổi trả thành đề xuất sửa tài liệu tri thức, sản phẩm hoặc thông điệp tiếp thị. Dữ liệu gửi sang Tiếp thị cần tối thiểu hóa, ưu tiên dữ liệu tổng hợp (aggregated) và không để lộ danh tính cá nhân ngoài thẩm quyền.

Khách hàng có trải nghiệm tốt có thể được mời đánh giá, mua lại hoặc tham gia chương trình giới thiệu khi phù hợp; tuyệt đối không yêu cầu đánh giá tích cực để được giải quyết quyền lợi khiếu nại. AI không tự xuất bản lời chứng thực hay tự ý sửa kho kiến thức.

## 7. Tiêu chí nghiệm thu kỹ thuật & Hệ chỉ số KPI chuẩn SRS

### 7.1. Bảng kiểm tra nghiệm thu (Acceptance Criteria)

| Tình huống | Kết quả bắt buộc | Mã kiểm thử SRS |
|---|---|---|
| Câu hỏi chung (FAQ, tính năng) | Trả lời từ tài liệu đúng phiên bản; không ép khai số điện thoại | PILOT-03 |
| Khách chưa xác minh hỏi đơn hàng | Tuyệt đối không tiết lộ dữ liệu riêng; yêu cầu OTP/đăng nhập (xác minh định danh bắt buộc trước mọi tra cứu); cô lập ngữ cảnh khách hàng (NFR-006) | TC-E2E-004, NFR-006 |
| Khách hợp lệ tra cứu đơn hàng | Gọi API ERP/WMS lấy trạng thái thực; hiển thị thời gian đối soát | PILOT-03, FR-CS-001 |
| Thiếu nguồn, mâu thuẫn hoặc rủi ro | Bàn giao hàng đợi nhân viên kèm ngữ cảnh; không suy đoán bịa đặt | PILOT-04, NFR-008 |
| Vụ việc đang xử lý | Khách chưa xác nhận thì giữ WAITING/IN_PROGRESS; không tự đóng | FR-CS-002 |
| Vụ việc mở lại (Reopen) | Liên kết đúng Case ID cũ, bảo toàn lịch sử và evidence | Quản lý Case |
| Lỗi mạng khi tạo phiếu hỗ trợ | Đối soát bằng Idempotency key; không sinh nhiều phiếu trùng lặp | NFR-003, TC-E2E-005 |
| Khách yêu cầu gặp người thật | Bàn giao ngay cho nhân viên trực; AI dừng trả lời nghiệp vụ | NFR-007 |
| Thử bù giá tự động | Đơn không đủ điều kiện hoặc hết ngân sách bị chặn; không cấp trùng | BR-002, BR-007 |
| Hệ thống điểm thưởng | Chặn đơn dưới mức sàn (Min Spend); tự thu hồi điểm khi đơn hủy/trả | Chống gian lận |
| Mô-đun CSKH chưa bật | Trả trạng thái không hỗ trợ hoặc chuyển hàng đợi người xử lý | Lộ trình P1 |
| Khiếu nại vượt thẩm quyền | Chuyển luồng bàn giao khẩn cấp; ghi vết audit đầy đủ | PILOT-04, AUTH-4 |

### 7.2. Hệ chỉ số KPI Chăm sóc & Thành công khách hàng theo SRS

- **Chăm sóc khách hàng (Customer Care KPIs):**
  - **First Response Time (FRT):** Thời gian phản hồi lần đầu (thiết kế gần thời gian thực qua Web/App/LINE).
  - **Resolution Time:** Thời gian trung bình từ khi tạo Case đến khi trạng thái chuyển sang RESOLVED.
  - **AI Resolution Rate:** Tỷ lệ vụ việc AI giải quyết tự động thành công mà không cần can thiệp của con người.
  - **Escalation Rate:** Tỷ lệ vụ việc phải chuyển giao cho nhân viên trực tiếp xử lý.
  - **Reopen Rate:** Tỷ lệ khách hàng khiếu nại lại hoặc mở lại vụ việc sau khi đã thông báo giải quyết.
  - **Customer Satisfaction (CSAT):** Điểm số hài lòng của khách hàng đánh giá sau khi đóng Case.
- **Giữ chân khách hàng (Customer Success / Retention KPIs):**
  - **Repeat Purchase Rate:** Tỷ lệ khách hàng mua lại định kỳ nhờ CS-02 kích hoạt lời nhắc hoặc gói bổ sung.
  - **Retention & Churn Rate:** Tỷ lệ giữ chân khách hàng và mức giảm tỷ lệ khách hàng rời bỏ.
  - **Reactivation Rate:** Tỷ lệ thu hồi và kích hoạt lại thành công khách hàng ngủ quên (dormant/win-back).
  - **Customer Lifetime Value (CLV):** Giá trị vòng đời khách hàng gia tăng xuyên suốt chuỗi dịch vụ.

Mọi thao tác hoàn tiền, hủy đơn, đổi trả hoặc thay đổi thông tin tài khoản bắt buộc phải qua nhân viên có thẩm quyền phê duyệt trên hệ thống nguồn; không nằm trong phạm vi tự động của P1.

---

# PHẦN 2: KỊCH BẢN CHĂM SÓC & GIỮ CHÂN THỰC CHIẾN (DOMAIN PLAYBOOKS)

Ghi chú: mọi con số trong phần này (mệnh giá voucher, tỷ lệ giảm, số ngày, hạn mức, trần ngân sách) là **giá trị minh họa** của thiết kế đề xuất, chưa được phê duyệt. Ngưỡng thực tế do tenant cấu hình và chỉ có hiệu lực sau khi khóa **[UNCONFIRMED][ASM-003]** / **[UNCONFIRMED][ASM-004]**.

## DOM-FMCG-004: Endowed Progress Loyalty Engine — Điểm thưởng tiến độ trao sẵn, kích hoạt mua lại qua LINE/Zalo

Thay vì phát phiếu giảm giá tự động liên tục (dễ gây lờn giá, discount fatigue và làm suy giảm định vị sản phẩm), hệ thống áp dụng cơ chế Điểm thưởng tích lũy (Reward Points) nhằm thúc đẩy khách hàng chủ động tương tác và mua lại:

1. **Hiệu ứng tiến độ trao sẵn (Endowed Progress Effect):**
   - Đơn hàng đầu tiên luôn được trao số điểm thưởng ban đầu lớn nhất (ví dụ: tặng sẵn 9/10 điểm trong thanh tiến độ để khách chỉ thiếu 1 điểm là mở khóa voucher giảm 15–20% kèm miễn phí giao hàng cho đơn thứ 2).
   - **Chốt chặn điều kiện đơn đầu (`Min_Spend_First_Order`):** Đơn hàng đầu tiên bắt buộc phải đạt giá trị tối thiểu theo quy định để được kích hoạt điểm trao sẵn, triệt tiêu hành vi mua đơn giá rẻ tượng trưng nhằm trục lợi điểm thưởng.
2. **Tích điểm theo giá trị đơn (Dynamic Spend-to-Points):**
   - Các đơn hàng tiếp theo không cố định điểm số mà tích lũy theo tỷ lệ giá trị đơn hàng thực tế (ví dụ: mỗi 100.000 VNĐ hoặc 100 TWD = 1 điểm). Đơn hàng càng lớn điểm càng nhiều, kích thích gia tăng quy mô giỏ hàng (AOV).
3. **Kiểm soát trần điểm thưởng (Max Cap Enforcement):**
   - Áp dụng trần tối đa trên mỗi đơn (`Cap_Max_Points_Per_Order`) và trần ngày (`Cap_Daily`).
   - Công thức tính điểm: `Points = min(floor(Order_Value / Spend_Unit), Cap_Max_Points_Per_Order)`.
   - Ngăn chặn triệt để rủi ro đại lý hoặc đơn gom sỉ tích lũy điểm vượt hạn mức làm thâm hụt ngân sách quỹ thưởng.
4. **Mốc vi mô theo bậc thang (Tiered Micro-Milestones):**
   - Sau khi hoàn thành mốc lớn đầu tiên ở đơn thứ 2, điểm quay về 0 và được duy trì động lực bằng các mốc thưởng nhỏ hơn dạng bậc thang (3 điểm đổi voucher 5%, 6 điểm đổi voucher 10%) nhằm nuôi dưỡng thói quen mua sắm liên tục.
5. **Thời hạn điểm thưởng (Points Expiry):**
   - Điểm tích lũy có hạn dùng từ 6–12 tháng để kích thích mua sắm định kỳ và ngăn chặn việc ghi nhận nợ nghĩa vụ tài chính kéo dài trên sổ sách kế toán.
6. **Tích hợp kênh liên lạc & Dự báo mua lại (Predictive Replenishment):**
   - Tại Đài Loan: Điểm thưởng có thể quy đổi trực tiếp thành **LINE Points** (tiêu dùng được trong mạng lưới bán lẻ toàn Đài Loan).
   - Tại Việt Nam: Đồng bộ thông báo điểm thưởng và ưu đãi qua Zalo OA.
   - AI CS-02 dựa trên chu kỳ tiêu dùng thực tế để phát hiện tín hiệu mua lại (Replenishment Signal) và gửi tới Revenue Orchestrator; Orchestrator điều phối SAL-05 kiểm tra chính sách và điều kiện (BR-004, BR-006, tồn kho BR-003) trước khi gửi thông điệp mời tái đặt hàng 1-chạm qua LINE/Zalo.

## DOM-FMCG-005: 4-Layer Anti-Sybil Defense — Bộ tứ định danh chống clone tài khoản & bùng hàng CVS

Bộ tứ chốt chặn phòng chống gian lận tạo nhiều tài khoản ảo nhằm trục lợi chính sách ưu đãi đơn đầu và điểm thưởng chào mừng:

1. **Lớp 1 - SĐT & Định danh mạng xã hội xác thực OTP (Phone & Social Identity):**
   - Xác thực số điện thoại qua mã OTP hoặc liên kết tài khoản LINE ID / Zalo ID chính chủ.
   - Mỗi định danh thực chỉ được phép nhận gói điểm thưởng chào mừng hoặc ưu đãi đơn đầu đúng 1 lần duy nhất trong toàn bộ vòng đời.
2. **Lớp 2 - Vân tay thiết bị (Device Fingerprint):**
   - Nhận diện mã định danh phần cứng, trình duyệt và môi trường thiết bị theo tiêu chuẩn bảo mật và quyền riêng tư (Taiwan PDPA / GDPR).
   - Chặn đứng hành vi mở trình duyệt ẩn danh (Incognito) hoặc chuyển đổi tài khoản trên cùng một thiết bị để đăng ký mới.
3. **Lớp 3 - Dấu vết thanh toán & Lịch sử nhận hàng Siêu thị (Payment Hash & CVS History):**
   - Lưu trữ mã băm một chiều (Hash) của tài khoản thanh toán trực tuyến (LINE Pay, JKOPAY, số thẻ tín dụng).
   - Theo dõi lịch sử giao nhận tại hệ thống cửa hàng tiện lợi 7-Eleven / FamilyMart. Khách hàng có tiền sử bùng hàng quá 7 ngày (未取貨) sẽ bị tự động đưa vào danh sách hạn chế và tước quyền hưởng ưu đãi trợ cấp giá.
4. **Lớp 4 - Đối soát địa chỉ mờ (Fuzzy Address Matching):**
   - Sử dụng thuật toán khớp mờ đối soát địa chỉ nhận hàng, họ tên và mã bưu chính.
   - Phát hiện các biến thể cố tình thay đổi ký tự trong địa chỉ giao hàng nhằm gom hàng ưu đãi về cùng một địa điểm thực tế.
5. **Cơ chế thu hồi và trần quỹ thưởng:**
   - **Thu hồi điểm khi hủy/trả hàng:** Khi đơn hàng bị hoàn tiền hoặc hủy, hệ thống tự động phát sự kiện `loyalty.points_revoked` để trừ lại số điểm đã cấp tương ứng.
   - **Trần ngân sách quỹ thưởng:** Bộ phận tài chính thiết lập tỷ lệ trích tối đa từ biên lợi nhuận cho quỹ điểm thưởng; hệ thống tự động ngắt phát hành điểm thưởng nếu tổng chi chạm trần ngân sách cho phép.

## DOM-MOB-004: Two-Sided EV Referral Program — Giới thiệu 2 chiều xe máy điện kiểu Tesla

Kịch bản phát triển mạng lưới khách hàng trung thành thông qua mô hình giới thiệu hai chiều cho sản phẩm Xe máy điện giá trị cao:

1. **Cơ chế giới thiệu hai chiều (Two-Sided Incentive):**
   - Chủ xe hiện tại sau khi mua xe và hoàn tất đăng ký biển số được cấp một mã giới thiệu độc quyền tích hợp trên LINE OA.
   - Khi bạn bè hoặc người quen quét mã này để đặt lịch lái thử Showroom và tiến hành mua xe thành công:
     * **Quyền lợi người giới thiệu:** Nhận ngay 1–3 tháng miễn phí gói thuê/đổi pin (BaaS - Battery as a Service) hoặc gói tín dụng (credit) bảo dưỡng định kỳ chính hãng.
     * **Quyền lợi người mua mới:** Được tặng bộ phụ kiện cao cấp chính hãng (mũ bảo hiểm thông minh, thảm để chân, giá treo điện thoại) hoặc voucher chiết khấu trừ trực tiếp vào tiền đặt cọc giữ chỗ.
2. **Chăm sóc vòng đời bảo dưỡng định kỳ (EV Lifecycle Care):**
   - AI CSKH trên LINE OA tự động ước tính quãng đường di chuyển dựa trên lịch sử vận hành, chủ động gửi tin nhắn nhắc lịch bảo dưỡng định kỳ tại mốc 1.000km (rút dầu phanh/siết ốc đầu tiên), 5.000km và 10.000km.
   - Tự động thông báo khi có trạm đổi pin mới (GoStation / Ionex) được lắp đặt và đưa vào vận hành trong bán kính 1km quanh nơi ở của chủ xe.

## ECN-004: Unified Promotion & Price Protection Budget — Chính sách bù giá trong 14 ngày có hạn mức

Kịch bản bảo vệ quyền lợi khách hàng, giảm thiểu tâm lý lo lắng mua hớ và duy trì niềm tin thương hiệu mà vẫn kiểm soát chặt chẽ ngân sách tài chính:

1. **Mục tiêu và nguyên tắc vận hành:**
   - Phiếu bù giá (Price Protection Voucher) là cam kết thương hiệu có chi phí tài chính và nghĩa vụ nợ thực hiện trên hệ thống kế toán, không phải dòng tiền miễn phí.
   - Áp dụng trong cửa sổ thử nghiệm **14 ngày** tính từ ngày đơn hàng được xác nhận thanh toán hoặc giao hàng thành công.
2. **Tiêu chuẩn đối soát và điều kiện áp dụng:**
   - **Tương đương sản phẩm:** Phải cùng mã SKU, cùng biến thể màu sắc/cấu hình, điều kiện bán và loại chương trình khuyến mãi hợp lệ.
   - **Cơ sở tính chênh lệch:** So sánh giá thực trả của khách hàng trên đơn hàng cũ (sau khi đã trừ hết các khoản chiết khấu/mã giảm giá phân bổ) với giá niêm yết mới đủ điều kiện; không so sánh với các chương trình thanh lý hàng tồn kho hoặc flash sale cục bộ có điều kiện đặc thù.
   - **Trạng thái đơn hàng:** Đơn hàng cũ phải ở trạng thái giao thành công, chưa bị hoàn trả, chưa hủy hoặc phát sinh tranh chấp.
3. **Kiểm soát trần hạn mức và ngân sách tập trung:**
   - Cài đặt trần bù giá tối đa trên mỗi đơn hàng (`Cap_Per_Order`), trần trên mỗi khách hàng (`Cap_Per_Customer`) và trần tổng thể cho toàn chương trình (`Total_Protection_Budget_Cap`).
   - Mọi đề xuất bù giá đều phải kiểm tra tính sẵn sàng của ngân sách thời gian thực; hệ thống tự động từ chối nếu ngân sách bảo vệ giá đã được giải ngân hết.
4. **Quy trình thực thi và chống trùng lặp nguyên tử:**
   - Luồng nghiệp vụ: Sự kiện giảm giá hợp lệ được kích hoạt → Hệ thống đối chiếu danh sách đơn hàng trong 14 ngày → Tính toán khoản chênh lệch theo chính sách → Kiểm tra ngân sách còn lại → Người có thẩm quyền (AUTH-4) duyệt hoặc quy tắc tự động kích hoạt → Cấp phiếu mua hàng (voucher) bù giá gắn mã định danh duy nhất → Gửi thông báo đến khách hàng.
   - Chống cấp trùng bằng khóa Idempotency tổng hợp: `Business_ID + Order_ID + Item_SKU + Event_ID`.
   - Nếu việc cấp phiếu thành công nhưng đường truyền thông báo tin nhắn thất bại, hệ thống chỉ thực hiện gửi lại tin nhắn thông báo, tuyệt đối không cấp thêm mã phiếu bù giá thứ hai.
