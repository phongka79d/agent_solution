# Hành trình khách hàng và các tình huống nghiệp vụ

[Mục lục](README.md) · [Bản dễ hiểu](plan-easy-read-flow.md) · [Thuật ngữ](glossary.md)

Trạng thái: hành trình đích đề xuất. [Bản đầu](delivery/mvp-and-roadmap.md#section-21) chỉ tự động hóa một phần.

<a id=section-3></a>

## 1. Hành trình Vòng đời & Chuỗi sự kiện Khách hàng

### 1.1. 10 Chặng tổ chức nội bộ của Doanh nghiệp (Internal Business Operational Stages)

Đây là các giai đoạn quản trị và quy trình phối hợp nghiệp vụ nội bộ giữa các bộ phận (Chiến lược, Tiếp thị, Bán hàng, Chăm sóc khách hàng, Vận hành và Sản phẩm):

| Chặng | Bên phụ trách | Đầu vào | Kết quả có thể kiểm chứng |
|---|---|---|---|
| Hiểu thị trường | Nhân viên và Tiếp thị | Nghiên cứu, phỏng vấn, dữ liệu tổng hợp được phép | Phiếu cơ hội có nguồn và giả thuyết |
| Phát hiện nhu cầu sớm | Tiếp thị | Hành động xảy ra trước nhu cầu, thời điểm và nơi khách tập trung | Nhóm nhu cầu đáng thử; chưa phải danh sách người được phép liên hệ |
| Định vị và phân phối | Doanh nghiệp, Tiếp thị, đối tác | Giải pháp, bằng chứng, điều kiện hợp tác | Thông điệp được duyệt, kênh tiếp cận có phép |
| Tiếp nhận | Mô-đun được bật hoặc lõi | Truy cập, câu hỏi, biểu mẫu, mã đối tác/chiến dịch | Yêu cầu được ghi; không tự suy ra danh tính từ lượt xem |
| Tìm hiểu và tư vấn | Bán hàng | Nhu cầu, điều kiện dùng, sản phẩm và giá hiện hành | Lựa chọn phù hợp, lý do, điều chưa rõ |
| Mua / đặt hẹn / báo giá | Hệ thống doanh nghiệp và người có quyền | Khách xác nhận lựa chọn; điều khoản được duyệt | Đơn, lịch hoặc báo giá có mã xác nhận riêng |
| Xác nhận thương mại | Hệ thống gốc | Sự kiện đáng tin theo loại kết quả | Phân biệt đặt đơn, thanh toán, giao hàng và doanh thu |
| Sử dụng và hỗ trợ | Chăm sóc hoặc nhân viên | Sản phẩm, tài liệu và khách đã xác minh khi cần | Hướng dẫn, vụ việc, giải quyết có xác nhận |
| Mua lại / nâng cấp / giới thiệu | Bán hàng, Tiếp thị, Chăm sóc theo phân công | Nhu cầu thật, trải nghiệm và quyền liên hệ | Cơ hội mới, đơn hợp lệ hoặc giới thiệu tự nguyện |
| Cải tiến | Chủ sản phẩm và Tiếp thị | Lý do từ chối, sự cố, đổi trả, kết quả thử | Đề xuất sửa có bằng chứng, chờ duyệt |

### 1.2. Chuỗi sự kiện hành vi chuẩn hóa FR-C360-002 Customer 360 Timeline

Theo yêu cầu bắt buộc **FR-C360-002 - MUST**, hệ thống Customer Intelligence 360 ghi nhận dòng thời gian khách hàng thông qua chuỗi 10 sự kiện hành vi khách quan có thể truy vết:

```text
View ──► Search ──► Click ──► Chat ──► Add to cart ──► Purchase ──► Delivery ──► Support ──► Review ──► Repurchase
```

**Phân định ranh giới cốt lõi:**
- **10 chặng tổ chức nội bộ (Mục 1.1):** Phản ánh góc nhìn quản trị, quy trình và phân công trách nhiệm của các bộ phận bên trong doanh nghiệp.
- **10 sự kiện hành vi Timeline (Mục 1.2):** Phản ánh góc nhìn khách quan từ hành vi tương tác thực tế của khách hàng trên hệ thống, được ghi nhận liên tục và bất biến vào Customer 360 Timeline.

**Bảng ánh xạ đối ứng giữa Hành vi khách hàng (FR-C360-002) và Chặng tổ chức nội bộ:**

*Lưu ý ánh xạ tên sự kiện:* Nhãn Timeline ở trên là tên hiển thị theo FR-C360-002, không phải định danh sự kiện. Khi dữ liệu đến từ cổng sự kiện số API-002, tên chuẩn dùng trong Registry và audit log là: `View` (khi là lượt xem sản phẩm) → `product_view`; `Search` → `search`; `Click` → `click`; `Add to cart` → `add_to_cart`; `Purchase` → `purchase`. Hai sự kiện chuẩn còn lại của API-002 là `session` (bắt đầu/kết thúc phiên truy cập) và `checkout` (bắt đầu thanh toán) — thuộc bước phiên và bước thanh toán giữa `Add to cart` và `Purchase`, không có nhãn Timeline riêng. Các nhãn `Chat`, `Delivery`, `Support`, `Review`, `Repurchase` do nguồn khác ghi nhận (hội thoại, logistics, vụ việc, phản hồi, mua lại), không thuộc danh mục API-002.

| STT | Sự kiện hành vi (FR-C360-002) | Hành vi khách quan của khách hàng | Chặng tổ chức nội bộ tương ứng | Đơn vị / Agent phụ trách ghi nhận | Bằng chứng & Dữ liệu truy vết (Evidence) |
|---|---|---|---|---|---|
| 1 | `View` | Xem trang đích, danh mục, bài viết tiếp thị | Định vị và phân phối | Web/App Tracking (API-002: sự kiện xem sản phẩm `product_view`), MKT-02 | `session_id`, `page_url`, `referrer`, `view_duration` |
| 2 | `Search` | Tìm kiếm từ khóa, sản phẩm hoặc giải pháp | Tiếp nhận | API-002 (`search`), MKT-02 / SAL-01 | `query_string`, `search_filters`, `result_count` |
| 3 | `Click` | Bấm vào quảng cáo, banner, nút kêu gọi hành động (CTA) | Định vị và phân phối / Tiếp nhận | API-002 (`click`), MKT-05 | `element_id`, `campaign_id`, `utm_source` |
| 4 | `Chat` | Mở cuộc hội thoại tư vấn mua sắm hoặc hỏi đáp | Tìm hiểu và tư vấn / Sử dụng và hỗ trợ | Conversation Console, SAL-02 / CS-01 | `conversation_id`, `channel`, `initial_intent` |
| 5 | `Add to cart` | Chọn SKU và đưa sản phẩm vào giỏ hàng | Tìm hiểu và tư vấn | API-002 (`add_to_cart`), SAL-02 / SAL-04 | `cart_id`, `sku`, `quantity`, `price_at_addition` |
| 6 | `Purchase` | Xác nhận đơn hàng, đặt cọc hoặc thanh toán thành công | Mua / đặt hẹn / báo giá & Xác nhận thương mại | ERP/POS (API-001) và Payment Connector interface, SAL-02 | `order_id`, `transaction_id`, `amount`, `payment_method` |
| 7 | `Delivery` | Nhận hàng tại địa chỉ hoặc tại điểm nhận (ví dụ siêu thị tiện lợi) | Xác nhận thương mại / Vận hành | Logistics Connector interface; adapter cụ thể (ví dụ ADPT-TW-001) là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]** | `waybill_id`, `delivery_status`, `delivered_timestamp` |
| 8 | `Support` | Gửi yêu cầu trợ giúp kỹ thuật, khiếu nại, đổi trả | Sử dụng và hỗ trợ | CS-01, Case Management Store | `case_id`, `intent`, `priority`, `resolution_summary` |
| 9 | `Review` | Gửi đánh giá, nhận xét sản phẩm hoặc điểm số hài lòng CSAT | Cải tiến / Hậu mãi | Feedback Store, CS-01 / MKT-06 | `rating_score`, `feedback_text`, `verified_buyer_flag` |
| 10 | `Repurchase` | Tái đặt hàng, kích hoạt gói giao định kỳ hoặc mua thêm | Mua lại / nâng cấp / giới thiệu | SAL-05, CS-02, Retention Engine | `reorder_id`, `cycle_days`, `replenishment_source` |

*Các trường bằng chứng trong bảng là tên trường đề xuất, sẽ chốt theo nguồn kết nối thực tế; adapter cụ thể theo thị trường (ví dụ ADPT-TW-001) là hiện thực tùy chọn **[UNCONFIRMED][ASM-001]**.*

Đối tác, quảng cáo, tìm kiếm, truy cập trực tiếp và khách cũ đều là điểm vào hợp lệ. Khách được vào thẳng Bán hàng hoặc Chăm sóc. Khi mô-đun đích chưa bật, chuyển công cụ/nhân viên đã cấu hình; không gọi vòng để lách quyền.

Một khách có thể có nhiều đơn, cơ hội và vụ hỗ trợ cùng lúc. Không ép mọi bản ghi vào một trạng thái “khách đã mua”. Một đơn xác nhận không có nghĩa đã thanh toán; thanh toán không có nghĩa đã giao hàng hoặc hết thời hạn đổi trả.

<a id=section-4></a>

## 2. Các tình huống cần hỗ trợ

*Ghi chú:* Mọi ngưỡng số trong bảng (ví dụ số lần nhắc, thời hạn giữ chỗ, mức giá sàn/ngân sách) chỉ là **ví dụ minh họa chưa được phê duyệt**; giá trị thực do chính sách tenant và nguồn ERP/System of Record cung cấp, khóa theo ASM-003/ASM-004. Phân kỳ cổng: **P0 — Nền tảng (Foundation)** bắt buộc xong trước (hợp đồng dữ liệu, quyền hạn, chính sách, bằng chứng, nhật ký kiểm toán, khung kết nối); tiếp theo **P1 chỉ Chăm sóc khách hàng (Care)**, rồi **P2 Bán hàng (Sales)**, sau đó **P3 Tiếp thị/Giữ chân (Marketing/Retention)**, P4 điều phối xuyên miền và P5 tự chủ có kiểm soát.

| Tình huống | Luồng chính | Nhánh dừng / ngoại lệ | Bằng chứng và phạm vi |
|---|---|---|---|
| 1. Khách mới hỏi mua | Tiếp nhận → hỏi nhu cầu → tra sản phẩm → gợi ý → quy trình mua hiện tại | Thiếu giá/tồn kho thì báo chưa xác nhận hoặc chuyển người | P1 (Chăm sóc): tiếp nhận, lưu yêu cầu và trả lời có nguồn; P2 (Bán hàng): tư vấn/đơn theo quy trình hiện có, chỉ tính đơn khi có nguồn xác nhận |
| 2. Khách chưa sẵn sàng | Lưu điều biết → chờ hoặc nhắc có phép → hỏi lại khi có tín hiệu mới | Thiếu quyền liên hệ, khách trả lời/từ chối, người tiếp quản thì dừng | P1 (Chăm sóc): lưu điều đã biết và dừng khi khách từ chối hoặc người tiếp quản; P3 (Tiếp thị): chuỗi nhắc/nuôi dưỡng có phép — số lần nhắc do cấu hình tenant khóa (giá trị minh họa, chưa phê duyệt) |
| 3. Khách cần hỗ trợ thông thường | Hỏi chung hoặc xác minh khách → tra tài liệu → hướng dẫn → hỏi kết quả | Không có nguồn hoặc bước xử lý không an toàn thì bàn giao | P1: khách xác nhận đã giải quyết; không đóng chỉ vì gửi câu trả lời |
| 4. Khiếu nại / cần người thật | Ghi vấn đề, việc đã thử, mức ưu tiên → hàng đợi → nhân viên nhận | Chưa ai nhận thì vẫn “đang chờ”, có người chịu trách nhiệm hàng đợi | P1: mã bàn giao, người nhận và AI tạm dừng; kết nối phiếu hỗ trợ nâng cao sau |
| 5. Khách muốn mua thêm | Ghi nhu cầu và nguồn tín hiệu → Bán hàng xác nhận → đề xuất mới | Không bật Bán hàng thì chuyển nhân viên; không dùng sự cố để ép mua | P2 (Bán hàng): ghi nhận, bàn giao và đề xuất mới; P3 (Tiếp thị): chiến dịch mua lại/nuôi dưỡng có điều kiện |
| 6. Đơn lớn / điều khoản riêng | Tư vấn → gói thông tin → người có thẩm quyền duyệt | Im lặng không phải phê duyệt; hết hạn thì dừng hoặc phân công lại | P1 (Chăm sóc): bàn giao hàng đợi nhân viên; P2 (Bán hàng): tư vấn và trình người có thẩm quyền duyệt; không tự gửi giá ngoại lệ |
| 7. Khách từ đối tác trước nhu cầu | Đối tác giới thiệu → khách tự vào → lưu nguồn → tư vấn theo thời điểm | Có mã đối tác không đồng nghĩa có quyền nhận dữ liệu khách | P0 (Nền tảng): chưa có công cụ đối tác, xử lý thủ công ngoài hệ thống; P1 (Chăm sóc): lõi lưu nguồn có sẵn; P3 (Tiếp thị): công cụ hỗ trợ đối tác |
| 8. Trợ cấp giá chốt nhanh & Thanh toán / Siêu thị tiện lợi | Khách ngần ngại giá → AI kích hoạt gói trợ cấp có điều kiện → máy chủ đối chiếu chính sách ưu đãi/giá sàn (thành phần tùy chọn) → hiện nút [Khóa đơn nhận trợ cấp trong thời hạn TTL] (ví dụ minh họa 10 phút, chưa phê duyệt) → chọn điểm nhận hoặc ví điện tử/thẻ → đối soát | Khách không băn khoăn giá thì giữ nguyên giá gốc; giá dưới sàn theo chính sách, quá hạn TTL chưa khóa điểm nhận, hoặc khách bùng hàng có nhánh xử lý riêng | P2 (Bán hàng): tính thử và trình người duyệt; hành động tài chính vẫn bắt buộc qua tuyến phê duyệt AUTH-4 (BR-007); không thuộc P1 |
| 9. Bù giá sau mua | Sự kiện giảm giá → kiểm tra đơn đủ điều kiện → duyệt/cấp phiếu một lần | Đơn trả/hủy, khác biến thể, ưu đãi không tương đương hoặc vượt ngân sách thì loại | P2 có người duyệt; không báo đã bù trước khi hệ thống cấp phiếu xác nhận |
| 10. Khách cần tư vấn B2B | Nhu cầu → ngân sách/người quyết định/thời điểm → sản phẩm → lịch hoặc báo giá | Thiếu trường thì để chưa biết; lịch hết chỗ hoặc lỗi thì không báo đã đặt | P2 (Bán hàng): cấu hình thay thế nếu chọn thử B2B; không bắt người mua lẻ đi qua chuỗi này |
| 11. Tích điểm thưởng đổi phiếu ưu đãi | Đơn hoàn tất → tích điểm (tặng thưởng đơn đầu theo chính sách tenant; giá trị minh họa, chưa phê duyệt) → theo dõi tiến độ mốc thưởng → đổi phiếu → áp dụng đơn sau | Đơn hủy/trả thì thu hồi điểm; đơn giá trị dưới mức sàn hoặc gian lận thì không cấp điểm | P3 (Tiếp thị/Giữ chân): thử có kiểm soát ngân sách; P4 (Cross-domain): tự động hóa gắn Customer360 |

### Ví dụ A — Người mua lẻ bận rộn

1. Khách hỏi sản phẩm phù hợp với không gian và tầm giá.
2. Bán hàng dùng dữ liệu có sẵn, hỏi phần thiếu bằng câu ngắn hoặc nút chọn.
3. Đưa một vài lựa chọn và giới hạn, không hứa số phút sử dụng nếu thiếu bằng chứng.
4. Khách chọn sản phẩm và tự xác nhận trên giỏ/trang mua hiện có.
5. Chỉ hiển thị trạng thái đơn/thanh toán do nguồn gốc xác nhận; sau mua chuyển hướng dẫn phù hợp.

### Ví dụ B — Đối tác giới thiệu SIM

1. Nhân viên kiểm chứng nhu cầu của người chuẩn bị đi, điều kiện SIM và khả năng cung cấp.
2. Một đối tác thử giới thiệu bằng đường dẫn hoặc mã; khách tự quyết định truy cập.
3. Lưu nguồn và thời điểm nhu cầu do khách cung cấp, không tự xác nhận kế hoạch xuất cảnh.
4. Tư vấn theo nơi đến, thiết bị, thời hạn, dữ liệu và điều kiện kích hoạt có nguồn.
5. Đơn xác nhận được đối chiếu với quy tắc nguồn giới thiệu; hoa hồng tính riêng, chưa tự chi trả.
6. Hỗ trợ sau mua phản hồi về sản phẩm và đối tác qua báo cáo tối thiểu cần thiết.

### Ví dụ C — Giá ưu đãi hết hạn nhưng có tiền chuyển đến

1. Hệ thống ngừng cho dùng báo giá hết hạn để tạo yêu cầu mới.
2. Nếu sau đó có giao dịch tiền đến, lưu giao dịch và đối chiếu thời điểm, số tiền, nội dung, người thụ hưởng.
3. Giữ trạng thái cần đối soát; không bỏ qua tiền, tự hồi sinh giá cũ hay tự giao hàng.
4. Nhân viên xử lý theo chính sách đã duyệt. Hoàn tiền, nếu cần, là một hành động riêng có quyền và xác nhận.

<a id=section-9></a>

## 3. Điều phối Bàn giao tập trung qua Revenue Orchestrator (Centralized Handoff Bus)

Theo Mục 3 và Mục 9 của SRS (**OBJ-005 - Orchestration** và **FR-ORC-001/002**), **Revenue Orchestrator là lớp điều phối trung tâm duy nhất**. Mọi luồng bàn giao (handoff) giữa các bộ phận, giữa các AI Agent (Tiếp thị, Bán hàng, Chăm sóc khách hàng) và giữa AI với nhân viên con người (Human Takeover SCR-005) **bắt buộc phải thực hiện tập trung qua Orchestrator Event Bus; tuyệt đối loại bỏ mọi hình thức bàn giao trực tiếp dạng điểm-sang-điểm (Peer-to-Peer) giữa các Agent**.

Mô hình điều phối tập trung đảm bảo:
- **Triệt tiêu nguy cơ xung đột thẩm quyền (Authority Collision) và vòng lặp vô hạn (Infinite Loops)** do các Agent tự gọi chéo lẫn nhau.
- **Bảo toàn toàn vẹn ngữ cảnh Customer 360 và Timeline thống nhất**, chống phân mảnh dữ liệu khách hàng.
- **Thực thi chốt chặn chính sách tập trung (Centralized Policy Engine)** và thẩm định thẩm quyền trước khi điều phối tác vụ: `AUTH-0`..`AUTH-3` là các cấp tự chủ gán được cho Agent, `AUTH-4` là tuyến chờ con người phê duyệt, `AUTH-5` là chặn cứng.
- **Ghi vết kiểm toán thống nhất (Unified Audit Trail - NFR-002)** cho 100% quyết định và hành động bàn giao.

Gói ngữ cảnh bàn giao chuẩn qua Orchestrator (Orchestrator Context Handoff Package):

| Nhóm | Nội dung |
|---|---|
| Liên kết | Doanh nghiệp, khách/phiên, cuộc trao đổi, yêu cầu, sự kiện và mã truy vết (Trace ID / Run ID) |
| Nghiệp vụ | Nguồn khách, nhu cầu, sản phẩm, đơn/cơ hội/vụ việc liên quan |
| Bằng chứng | Thông tin đã xác minh (FACT), nguồn, phiên bản, thời điểm và phần chưa rõ |
| Xử lý trước đó | Câu trả lời, bước đã thử, kết quả, đề xuất hoặc phê duyệt đang chờ (Pending Approval) |
| Trách nhiệm | Bên hiện phụ trách, bên được Orchestrator điều phối nhận việc, mức ưu tiên, hạn phản hồi (SLA) và bước tiếp theo |
| Liên hệ | Kênh được phép, trạng thái đồng ý (Consent), yêu cầu ngừng hoặc gặp nhân viên |

Quy tắc vận hành bàn giao tập trung:

1. **Bàn giao qua Bus:** Agent phát sự kiện bàn giao kèm gói ngữ cảnh gửi tới Revenue Orchestrator; Orchestrator kiểm tra chính sách, quyền hạn và định tuyến tới Agent đích hoặc hàng đợi nhân viên phù hợp. Gửi yêu cầu chưa phải hoàn thành bàn giao; bên nhận phải xác nhận tiếp nhận.
2. Trong lúc chờ người tiếp quản (Human Queue), Orchestrator kích hoạt khóa phiên (Session Mutex Lock) tạm dừng AI trả lời nghiệp vụ; hàng đợi có người chịu trách nhiệm và thông báo trạng thái trung thực cho khách hàng.
3. Mỗi cuộc trao đổi chỉ có một bên được quyền phát ngôn/trả lời tại một thời điểm dưới sự cấp quyền (Token) của Orchestrator.
4. Nhân viên tiếp quản (Human Takeover) thì Orchestrator tự động hủy các lịch nhắc tự động liên quan; chỉ kích hoạt lại AI khi nhân viên chủ động trả lại quyền qua Console (SCR-005).
5. Giữ thông tin và bằng chứng đã biết trong Customer 360 để không hỏi lại khách vô ích; vẫn xác minh lại khi cần bảo vệ dữ liệu hoặc thông tin đã cũ.
6. Bàn giao thất bại hoặc hết thời gian chờ (timeout) không làm mất cuộc trao đổi. Orchestrator kích hoạt cơ chế an toàn dự phòng (Fail-Safe), chuyển ngay sang người/nhóm chịu trách nhiệm xử lý tiếp (Fallback Owner).

Chi tiết trạng thái và thử lại do [quy trình](platform/workflows-and-handoffs.md) quy định; quyền truy cập do [API](platform/api-and-integrations.md) và [dữ liệu](platform/data-and-knowledge.md) quy định.
