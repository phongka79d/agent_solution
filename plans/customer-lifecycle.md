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

| STT | Sự kiện hành vi (FR-C360-002) | Hành vi khách quan của khách hàng | Chặng tổ chức nội bộ tương ứng | Đơn vị / Agent phụ trách ghi nhận | Bằng chứng & Dữ liệu truy vết (Evidence) |
|---|---|---|---|---|---|
| 1 | `View` | Xem trang đích, danh mục, bài viết tiếp thị | Định vị và phân phối | Web/App Tracking (API-002), MKT-02 | `session_id`, `page_url`, `referrer`, `view_duration` |
| 2 | `Search` | Tìm kiếm từ khóa, sản phẩm hoặc giải pháp | Tiếp nhận | Search Engine, MKT-02 / SAL-01 | `query_string`, `search_filters`, `result_count` |
| 3 | `Click` | Bấm vào quảng cáo, banner, nút kêu gọi hành động (CTA) | Định vị và phân phối / Tiếp nhận | Tracking Gateway, MKT-05 | `element_id`, `campaign_id`, `utm_source` |
| 4 | `Chat` | Mở cuộc hội thoại tư vấn mua sắm hoặc hỏi đáp | Tìm hiểu và tư vấn / Sử dụng và hỗ trợ | Conversation Console, SAL-02 / CS-01 | `conversation_id`, `channel`, `initial_intent` |
| 5 | `Add to cart` | Chọn SKU và đưa sản phẩm vào giỏ hàng | Tìm hiểu và tư vấn | E-commerce Core Cart API, SAL-02 | `cart_id`, `sku`, `quantity`, `price_at_addition` |
| 6 | `Purchase` | Xác nhận đơn hàng, đặt cọc hoặc thanh toán thành công | Mua / đặt hẹn / báo giá & Xác nhận thương mại | ERP / POS / Payment Gateway, SAL-02 | `order_id`, `transaction_id`, `amount`, `payment_method` |
| 7 | `Delivery` | Nhận hàng tại địa chỉ hoặc tại siêu thị 7-Eleven/FamilyMart | Xác nhận thương mại / Vận hành | Logistics Connector / CVS Adapter (ADPT-TW-001) | `waybill_id`, `delivery_status`, `delivered_timestamp` |
| 8 | `Support` | Gửi yêu cầu trợ giúp kỹ thuật, khiếu nại, đổi trả | Sử dụng và hỗ trợ | CS-01, Case Management Store | `case_id`, `intent`, `priority`, `resolution_summary` |
| 9 | `Review` | Gửi đánh giá, nhận xét sản phẩm hoặc điểm số hài lòng CSAT | Cải tiến / Hậu mãi | Feedback Store, CS-01 / MKT-06 | `rating_score`, `feedback_text`, `verified_buyer_flag` |
| 10 | `Repurchase` | Tái đặt hàng, kích hoạt gói giao định kỳ hoặc mua thêm | Mua lại / nâng cấp / giới thiệu | SAL-05, CS-02, Retention Engine | `reorder_id`, `cycle_days`, `replenishment_source` |

Đối tác, quảng cáo, tìm kiếm, truy cập trực tiếp và khách cũ đều là điểm vào hợp lệ. Khách được vào thẳng Bán hàng hoặc Chăm sóc. Khi mô-đun đích chưa bật, chuyển công cụ/nhân viên đã cấu hình; không gọi vòng để lách quyền.

Một khách có thể có nhiều đơn, cơ hội và vụ hỗ trợ cùng lúc. Không ép mọi bản ghi vào một trạng thái “khách đã mua”. Một đơn xác nhận không có nghĩa đã thanh toán; thanh toán không có nghĩa đã giao hàng hoặc hết thời hạn đổi trả.

<a id=section-4></a>

## 2. Các tình huống cần hỗ trợ

| Tình huống | Luồng chính | Nhánh dừng / ngoại lệ | Bằng chứng và phạm vi |
|---|---|---|---|
| 1. Khách mới hỏi mua | Tiếp nhận → hỏi nhu cầu → tra sản phẩm → gợi ý → quy trình mua hiện tại | Thiếu giá/tồn kho thì báo chưa xác nhận hoặc chuyển người | P1: câu trả lời có nguồn và yêu cầu được lưu; chỉ tính đơn khi có nguồn xác nhận |
| 2. Khách chưa sẵn sàng | Lưu điều biết → chờ hoặc nhắc có phép → hỏi lại khi có tín hiệu mới | Thiếu quyền liên hệ, khách trả lời/từ chối, người tiếp quản thì dừng | P1: một chuỗi nhắc tối đa hai tin; chăm sóc chiến dịch ở P2/P3 |
| 3. Khách cần hỗ trợ thông thường | Hỏi chung hoặc xác minh khách → tra tài liệu → hướng dẫn → hỏi kết quả | Không có nguồn hoặc bước xử lý không an toàn thì bàn giao | P1: khách xác nhận đã giải quyết; không đóng chỉ vì gửi câu trả lời |
| 4. Khiếu nại / cần người thật | Ghi vấn đề, việc đã thử, mức ưu tiên → hàng đợi → nhân viên nhận | Chưa ai nhận thì vẫn “đang chờ”, có người chịu trách nhiệm hàng đợi | P1: mã bàn giao, người nhận và AI tạm dừng; kết nối phiếu hỗ trợ nâng cao sau |
| 5. Khách muốn mua thêm | Ghi nhu cầu và nguồn tín hiệu → Bán hàng xác nhận → đề xuất mới | Không bật Bán hàng thì chuyển nhân viên; không dùng sự cố để ép mua | P1: ghi nhận và chuyển; P2/P3: quy trình mở rộng có điều kiện |
| 6. Đơn lớn / điều khoản riêng | Tư vấn → gói thông tin → người có thẩm quyền duyệt | Im lặng không phải phê duyệt; hết hạn thì dừng hoặc phân công lại | P1: bàn giao; không tự gửi giá ngoại lệ |
| 7. Khách từ đối tác trước nhu cầu | Đối tác giới thiệu → khách tự vào → lưu nguồn → tư vấn theo thời điểm | Có mã đối tác không đồng nghĩa có quyền nhận dữ liệu khách | P0: thử thủ công; P1: lưu nguồn có sẵn; P2: công cụ hỗ trợ đối tác |
| 8. Trợ cấp giá chốt nhanh & Thanh toán / Siêu thị tiện lợi | Khách ngần ngại giá → AI kích hoạt gói trợ cấp có điều kiện → máy chủ duyệt giá sàn → hiện nút [Khóa đơn nhận trợ cấp trong 10 phút] → chọn chi nhánh 7-Eleven/FamilyMart (CVS COD) hoặc LINE Pay/thẻ → đối soát | Khách không băn khoăn giá thì giữ nguyên giá gốc; giá dưới sàn, quá 10 phút chưa khóa điểm nhận hoặc khách bùng hàng có nhánh xử lý riêng | P2 tính thử, P3 tự động có giới hạn; ngoài P1 |
| 9. Bù giá sau mua | Sự kiện giảm giá → kiểm tra đơn đủ điều kiện → duyệt/cấp phiếu một lần | Đơn trả/hủy, khác biến thể, ưu đãi không tương đương hoặc vượt ngân sách thì loại | P2 có người duyệt; không báo đã bù trước khi hệ thống cấp phiếu xác nhận |
| 10. Khách cần tư vấn B2B | Nhu cầu → ngân sách/người quyết định/thời điểm → sản phẩm → lịch hoặc báo giá | Thiếu trường thì để chưa biết; lịch hết chỗ hoặc lỗi thì không báo đã đặt | Cấu hình thay thế nếu chọn thử B2B; không bắt người mua lẻ đi qua chuỗi này |
| 11. Tích điểm thưởng đổi phiếu ưu đãi | Đơn hoàn tất → tích điểm (tặng lớn đơn đầu) → theo dõi tiến độ mốc thưởng → đổi phiếu → áp dụng đơn sau | Đơn hủy/trả thì thu hồi điểm; đơn giá trị dưới mức sàn hoặc gian lận thì không cấp điểm | P2 thử nghiệm có kiểm soát ngân sách; P3 tự động hóa gắn Customer360 |

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
- **Thực thi chốt chặn chính sách tập trung (Centralized Policy Engine)** và thẩm định quyền hạn (AUTH-0 đến AUTH-5) trước khi điều phối tác vụ.
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
