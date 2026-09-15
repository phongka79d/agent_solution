# Bản đầu, kiểm chứng và lộ trình triển khai

[Mục lục](../README.md) · [Bản dễ hiểu](../plan-easy-read-flow.md) · [Đo lường](analytics.md)

Trạng thái: kế hoạch đề xuất theo chuẩn SRS v0.1 (AI-REV-SRS-001). P0–P5 là giai đoạn theo cổng nghiệm thu kỹ thuật và thương mại, không phải lịch phát hành cố định chưa kiểm chứng.

<a id=section-21></a>

## 1. Bản đầu: một hành trình nhỏ chạy được

Mục tiêu P1: Bán hàng tư vấn và Chăm sóc cơ bản trong website/kênh hiện có của doanh nghiệp mỏ neo, đảm bảo dữ liệu đúng quyền, nhân viên tiếp quản trơn tru và báo cáo kiểm tra được.

Đề xuất ưu tiên B2C từ PDF; hành trình thí điểm mỏ neo tại Đài Loan tập trung vào Hàng tiêu dùng (FMCG) và Xe máy điện thông minh (Mobility). Nếu chọn bán hàng B2B cần tư vấn, dùng cấu hình nhu cầu–ngân sách–người quyết định–thời điểm và lịch hẹn. Không triển khai hai hành trình riêng đồng thời trong một lần thử.

### 1.1. Tiêu chuẩn hoàn thành cấp hệ thống (System-level Definition of Done)

Hệ thống không được coi là hoàn thành chỉ vì Agent có khả năng trò chuyện (chat). Một năng lực (capability) hoặc quy trình nghiệp vụ chỉ đạt chuẩn nghiệm thu khi chứng minh được đầy đủ 10 thành tố thực tế:

> **Data thật + Agent thật + Skill thật + Tool thật + Policy thật + Approval thật + Execution thật + Evidence thật + Outcome thật + Test thật.**

Mục tiêu cốt lõi là thiết lập một **AI Revenue Workforce** có khả năng trực tiếp tham gia vận hành Tiếp thị, Bán hàng và Chăm sóc khách hàng với mức tự động hóa cao, nhưng mọi quyền thực thi đều có giới hạn, có thể kiểm soát và truy vết tuyệt đối.

### 1.2. Bốn kịch bản thí điểm nghiệm thu (Acceptance Pilots)

Theo Mục 21 của SRS v0.1, hệ thống thiết kế 4 kịch bản nghiệm thu mẫu:
- **PILOT-01 — Tiếp thị → Bán hàng (Marketing → Sales):** Customer Signal → Segment → Campaign → Content → Approval → Send/Publish → Customer Response → Sales Conversation → Recommendation → Order → Revenue Evidence.
- **PILOT-02 — Phục hồi giỏ hàng (Cart Recovery):** Abandoned Cart → Customer Context → Eligibility → Recommendation → Message → Conversion → Order → Attribution.
- **PILOT-03 — Chăm sóc khách hàng (Customer Care):** Customer Question → Intent Detection → Customer Identification → ERP/Order Lookup → AI Resolution → Customer Response → Case Outcome.
- **PILOT-04 — Khiếu nại & Chuyển cấp (Escalation):** Complaint → Classification → Policy Check → AI unable/unauthorized → Human Escalation → Resolution → Outcome.

### Phạm vi bật trong P1

| Thành phần | Mức tối thiểu | Điều kiện |
|---|---|---|
| Customer360 | Liên kết khách/phiên, yêu cầu, hội thoại, nguồn, đồng ý và người phụ trách | Tách doanh nghiệp, không ép sao chép toàn bộ dữ liệu |
| API và website | Gửi câu hỏi/sự kiện, nhận mã công việc, đọc kết quả; có dự phòng khi mất thông báo | Máy chủ doanh nghiệp hoặc đường kết nối được xác thực |
| Danh mục và kiến thức | Một nguồn sản phẩm, giá/điều kiện và tài liệu hỏi đáp đã duyệt | Có chủ nguồn, phiên bản và quy tắc độ mới |
| Điều phối | Bán hàng, Chăm sóc cơ bản hoặc người xử lý | Tiếp thị tự động tắt; không gọi mô-đun chưa bật |
| Bán hàng | Hỏi nhu cầu, gợi ý, giải thích dễ hiểu từ nguồn, ghi việc tiếp theo | Câu hỏi phù hợp B2C hoặc B2B đã chọn |
| Lưu khách/yêu cầu | Một hệ thống hiện có hoặc CRM với trường đọc/ghi cụ thể | Không bắt mua CRM mới |
| Hỗ trợ mua | Đưa khách tới trang/quy trình hiện có | Không tự phát hành báo giá, đơn ưu đãi hay yêu cầu thanh toán |
| Lịch hẹn | Kiểm tra và tạo lịch có mã xác nhận | Chỉ khi hành trình được chọn cần hẹn |
| Chăm sóc cơ bản | Trả lời có nguồn, hướng dẫn giới hạn, ghi vụ việc chưa giải quyết | Chưa bắt buộc API vận chuyển hoặc hệ thống phiếu hỗ trợ |
| Nhắc lại | Một chuỗi tối đa hai tin, mặc định tắt nếu chưa đủ điều kiện | Kênh, nội dung, mục đích và người phụ trách đã duyệt |
| Bàn giao | Hàng đợi, chấp nhận, tiếp quản, duyệt/từ chối, trả quyền AI | Có nhân viên chịu trách nhiệm và giờ làm việc |
| Báo cáo | Câu hỏi, tìm hiểu nhu cầu, đề xuất, bàn giao, hỗ trợ, chi phí; lịch/đơn nếu có nguồn | Dữ liệu thiếu phải ghi rõ |

Câu hỏi chọn nhanh trong P1 chỉ dùng thành phần giao diện có sẵn nếu phù hợp; không phụ thuộc bộ mã nhúng mới. Lưu nguồn đối tác/chiến dịch trong P1 là khả năng ghi nhận của lõi, không tự chạy Tiếp thị.

Nếu không có nguồn đơn/thanh toán đáng tin, nghiệm thu P1 ở kết quả tư vấn và phục vụ; **không tuyên bố tăng doanh thu**. Muốn dùng chuyển đổi mua hàng làm chỉ tiêu phải bổ sung kết nối chỉ đọc hoặc bản đối chiếu do chủ nguồn xác nhận.

### Danh sách được phép và bị cấm

| Được phép có điều kiện | Không được phép trong P1 |
|---|---|
| Đọc/lưu ngữ cảnh và trường khách/yêu cầu đã ánh xạ | Tra dữ liệu chéo doanh nghiệp, xem đơn chưa xác minh |
| Đọc sản phẩm, giá, tài liệu đã duyệt | Sửa giá, điều kiện, tồn kho hoặc kho kiến thức lúc trả lời |
| Đưa liên kết tới quy trình mua hiện tại | Tự tạo thanh toán/QR, thu tiền, hoàn tiền, hủy hoặc đổi trả |
| Chuẩn bị thông tin báo giá cho nhân viên | Phát hành báo giá tự động, mặc cả hoặc cấp phiếu |
| Tạo lịch nếu được chọn và xác nhận | Tự đổi/hủy lịch hoặc báo đặt xong khi chưa có mã |
| Trả lời và nhắc theo điều kiện hiện tại | Chiến dịch chăm sóc vô hạn, liên hệ khi bị chặn |
| Nhân viên duyệt, tiếp quản và trả quyền qua đường xác thực | Phê duyệt bằng im lặng, tự giành lại hội thoại |
| Nhân viên dùng AI soạn nháp nghiên cứu trong P0 | Tự thu gom dữ liệu, liên hệ đối tác, xuất bản hay chi tiền quảng cáo |

Không có trong P1: toàn bộ Tiếp thị tự động, nhiều kênh đồng thời, bộ nhúng đầy đủ, thanh toán và ưu đãi tự động, phiếu bù giá, video đổi trả, giọng nói, trình kéo-thả và các dự báo tự động.

## 2. Gói công việc theo phụ thuộc

| Thứ tự | Gói công việc | Phụ thuộc | Bằng chứng để qua bước |
|---|---|---|---|
| 1 | Chốt doanh nghiệp, hành trình, đường cơ sở | Chủ doanh nghiệp và người nghiệp vụ | Phiếu đầu vào, một kết quả chính và chỉ số có nguồn |
| 2 | Cấu hình, quyền, dữ liệu thử | Danh sách nguồn và quyền | Hai cấu hình tách biệt, phép thử từ chối truy cập chéo |
| 3 | API và kết nối đầu vào | Máy chủ/kênh có quyền thử | Yêu cầu được lưu, kết quả về giao diện, chống trùng |
| 4 | Danh mục, kiến thức, bằng chứng | Tài liệu và dữ liệu duyệt | Câu trả lời đúng nguồn/phiên bản; tài liệu bị gỡ không còn được dùng |
| 5 | Điều phối, hỏi nhu cầu, tư vấn | Gói 2–4 | Hành trình thử từ câu hỏi đến đề xuất và bản ghi nguồn |
| 6 | Ghi hệ thống nguồn, lịch nếu cần | Ánh xạ quyền và môi trường thử | Mỗi ghi có mã xác nhận; lỗi sau ghi được đối soát |
| 7 | Bàn giao, nhắc có điều kiện | Trạng thái bền vững, nhân viên và kênh | Một người trả lời, tối đa hai tin, dừng và khởi động lại đúng |
| 8 | Nhật ký, báo cáo, phục hồi | Sự kiện từ mọi gói | Đối chiếu tay ra đúng chỉ số, hiện dữ liệu thiếu, diễn tập quay lại cấu hình |
| 9 | Thử có kiểm soát | Toàn bộ điều kiện an toàn đã qua | Nhân viên duyệt kết quả; ghi vấn đề và quyết định có mở thêm quyền không |

Đây là các điều kiện phụ thuộc, không ép phát triển đo lường sau cùng: sự kiện và nhật ký phải đi cùng từng gói. Chưa có API/dữ liệu đầu vào thì chưa cam kết số tuần triển khai.

<a id=pilot-inputs></a>

## 3. Phiếu chốt đầu vào

Điền hai dòng đầu trong khoảng 2 phút; dùng một buổi 60–90 phút với người nghiệp vụ và kỹ thuật để chốt phần còn lại. Đây là thời lượng họp gợi ý, không phải ước lượng xây sản phẩm.

| Cần chốt | Giá trị hiện tại | Người chịu trách nhiệm |
|---|---|---|
| Doanh nghiệp thử nghiệm | Chưa chọn | Người bảo trợ dự án |
| Website/ứng dụng đầu tiên | Chưa chọn | Chủ ứng dụng |
| Ngành, sản phẩm và một hành trình B2C/B2B | Chưa chọn | Kinh doanh |
| Vấn đề cần cải thiện và kết quả chính | Chưa có đường cơ sở | Kinh doanh + đo lường |
| Danh mục, hệ thống lưu khách/yêu cầu, FAQ | Chưa xác nhận API/quyền/phiên bản | Chủ dữ liệu |
| Nguồn xác nhận đơn/thanh toán nếu dùng chỉ tiêu mua | Chưa xác nhận | Vận hành + tài chính |
| Có cần lịch hẹn không? | Chưa quyết định | Chủ hành trình |
| Kênh nhắc, mục đích, nội dung, giờ và giới hạn | Chưa duyệt; mặc định tắt | Nghiệp vụ + bảo vệ dữ liệu |
| Nhân viên nhận bàn giao, giờ trực, thời hạn | Chưa phân công | Vận hành |
| Chính sách truy cập, lưu/xóa và nhà cung cấp AI | Chưa rà soát | Bảo vệ dữ liệu/pháp lý |
| Ngân sách AI/vận hành và quyền ngắt | Chưa duyệt | Chủ doanh nghiệp + kỹ thuật |
| Bộ thử, nguồn dữ liệu thử và người ký nghiệm thu | Chưa lập | Kiểm thử + nghiệp vụ |

Không cần doanh nghiệp thật thứ hai để thử khả năng tách dữ liệu; dùng hai cấu hình thử trên cùng bản phần mềm. Không sao chép dữ liệu khách thật giữa chúng.

### 3.1. Bộ giả định bắt buộc phải khóa trước Production (Mandatory Assumptions)

Theo Mục 26 của SRS v0.1 (AI-REV-SRS-001), các giả định dưới đây bắt buộc phải được chủ trì (Owner) xác nhận và hành động trước khi triển khai vận hành thương mại:

| Mã giả định | Tên giả định cần khóa | Người chịu trách nhiệm (Owner) | Hành động nghiệp vụ bắt buộc |
|---|---|---|---|
| **ASM-001** | Danh sách cổng kết nối Production (Connectors) | Product / IT | Rà soát và kiểm toán danh sách API, quyền hạn, token, webhook và chính sách nền tảng thực tế (Facebook, LINE OA, Zalo, TikTok, Shopify, WooCommerce, ERP, POS, Payment Gateways). |
| **ASM-002** | Đường cơ sở KPI và chỉ tiêu cam kết (KPI Baselines & Targets) | Business / Commercial Lead | Thu thập dữ liệu vận hành lịch sử để thiết lập đường cơ sở (baseline) thực tế trước khi cam kết các chỉ tiêu tăng trưởng (conversion rate, response time, CSAT, CAC, ROAS). |
| **ASM-003** | Ngưỡng chiết khấu & khuyến mãi của AI (Discount & Promotion Thresholds) | Business / Finance | Ban hành hạn mức giảm giá tối đa ($D_{cap}$), trần ưu đãi đơn hàng cá nhân (Basket Cap), tỷ suất lãi đóng góp tối thiểu ($m$) và ngân sách trợ cấp; AI cấm vượt ngưỡng nếu không có Human Approval. |
| **ASM-004** | Phê duyệt hoàn tiền & đền bù (Refund & Compensation Approval) | Finance / Operations | Xác định rõ các trường hợp hoàn tiền, phát hành voucher đền bù bắt buộc phải có phê duyệt của con người; cấm tuyệt đối AI tự ý kích hoạt hoàn tiền hoặc cấp bù ngoài thẩm quyền. |
| **ASM-005** | Thời hạn và phạm vi lưu trữ dữ liệu Customer360 (Data Retention Policy) | Data / Legal / Product | Ban hành danh mục các trường dữ liệu định danh, lịch sử giao dịch và ngữ cảnh hội thoại được phép lưu trữ lâu dài theo luật bảo vệ dữ liệu (Taiwan PDPA / GDPR / CCPA); cấm AI tự ghi toàn bộ hội thoại thành fact vĩnh viễn. |

## 4. Kiểm thử và điều kiện chạy thử

| Nhóm | Bằng chứng bắt buộc |
|---|---|
| Hành trình chính | Câu hỏi → tìm hiểu nhu cầu → đề xuất có nguồn → bản ghi; hỗ trợ → giải quyết có xác nhận hoặc người nhận |
| Kết nối thực | Kết quả hiện trong ứng dụng, ghi nguồn có mã; mất thông báo phục hồi bằng truy vấn |
| Mô-đun độc lập | Bán hàng không cần Tiếp thị; tắt Chăm sóc thì chuyển người, không giả xử lý |
| Quyền và dữ liệu | Hai doanh nghiệp không truy cập chéo; khách chưa xác minh không đọc riêng |
| Nội dung AI | Đúng nguồn, không bịa công dụng/giá, không bị tài liệu hoặc khách cấp quyền bằng chỉ dẫn |
| Bàn giao | Chờ chưa thành công; nhận/tiếp quản/trả quyền rõ; không trả lời chồng |
| Liên hệ | Khách trả lời/rút phép, đóng yêu cầu, người nhận, ngoài giờ hoặc chạm hạn đều chặn gửi |
| Độ tin cậy | Trùng yêu cầu/sự kiện, xung đột khóa, mất mạng, lỗi sau ghi, tiến trình chết, thông báo cũ/mất |
| Chất lượng dữ liệu | Giá cũ, tài liệu chưa duyệt/bị gỡ, danh tính mơ hồ và thiếu nguồn xử lý đúng |
| Phục hồi | Ngắt năng lực và quay lại cấu hình không phát lại tin, đơn hoặc thanh toán |
| Đo lường | Mẫu tính tay khớp; hiển thị số chờ, loại trừ, dữ liệu thiếu và chi phí có nguồn |

### 4.1. Bộ kiểm thử chấp nhận E2E cấp hệ thống (System Acceptance Tests)

Theo Mục 22 của SRS v0.1, hệ thống phải vượt qua toàn bộ 9 ca kiểm thử E2E bắt buộc trước khi đóng cổng Gate:

| Mã kiểm thử | Tên kịch bản E2E | Phạm vi & Tiêu chí nghiệm thu (Pass Criteria) |
|---|---|---|
| **TC-E2E-001** | Luồng xử lý tín hiệu khép kín E2E | Một tín hiệu (signal) đi trọn vẹn chuỗi: **Signal → Decision → Action → Execution → Evidence → Outcome**. Mọi bước đều có log liên kết đồng nhất qua `trace_id`. |
| **TC-E2E-002** | Kiểm soát phê duyệt Tiếp thị | Marketing Agent tuyệt đối không thể xuất bản (publish) nội dung hoặc kích hoạt chiến dịch nếu thiếu thẩm quyền (authority) hoặc chưa có phê duyệt (human approval) theo chính sách. |
| **TC-E2E-003** | Toàn vẹn giá bán chính thức | Sales Agent không thể đưa ra mức giá, chiết khấu hoặc điều kiện bán hàng không có trong nguồn dữ liệu chính thức (Catalog/ERP/Price Rules); không bịa đặt hoặc phá giá sàn. |
| **TC-E2E-004** | Xác minh danh tính chăm sóc khách hàng | Customer Care Agent chỉ tra cứu và hiển thị dữ liệu đơn hàng/tài khoản đối với khách hàng đã được xác minh danh tính; cấm rò rỉ dữ liệu giữa các khách hàng khác nhau. |
| **TC-E2E-005** | Chống trùng lặp hành động (Idempotency) | Thực hiện lại cùng một yêu cầu thực thi (retry execution request do timeout/lỗi mạng) không được tạo tin nhắn gửi trùng hoặc phát sinh giao dịch/đơn hàng ngoài ý muốn lần hai. |
| **TC-E2E-006** | Từ chối và ghi vết vượt quyền | Bất kỳ hành vi nào của AI cố vượt thẩm quyền hoặc vi phạm chính sách bảo mật đều phải bị hệ thống từ chối lập tức (**DENY**) và tự động phát sinh sự kiện kiểm toán bảo mật (Security Audit Event). |
| **TC-E2E-007** | Triệt tiêu liên hệ thiếu đồng ý (Suppression) | Khách hàng chưa cấp sự đồng ý (consent) hoặc đã rút phép nhận tin (opt-out) phải bị hệ thống triệt tiêu liên hệ tự động; cấm gửi tin tiếp thị hoặc tin nhắc ngoài ý muốn. |
| **TC-E2E-008** | Xử lý lỗi cổng kết nối trung thực | Khi cổng kết nối (Connector) bên thứ ba gặp sự cố (lỗi mạng, HTTP 5xx, token hết hạn), hệ thống phải chuyển sang trạng thái failure/retry; tuyệt đối cấm ghi nhận thành công giả. |
| **TC-E2E-009** | Khả năng truy vết ngược toàn diện | Mỗi hành động thành công đều phải cho phép truy ngược 100%: **Trigger → Context → Decision → Approval → Execution → Evidence → Outcome**, kèm đầy đủ tham số, chi phí và độ trễ. |

Chạy lại bộ tình huống cố định sau thay đổi lời hướng dẫn AI, công cụ, danh mục, kiến thức, cấu hình hoặc quy trình. Mỗi ca thử phải có dữ liệu đầu vào, kết quả mong đợi, kết quả thực, bằng chứng, người kiểm và trạng thái đạt/không đạt/chưa chạy.

**Điều kiện an toàn bắt buộc:** không còn lỗi nghiêm trọng chưa xử lý về hành động trái quyền, rò dữ liệu, lách giá/quyền hoặc giả thành công trong bộ thử được duyệt. Điều này không phải cam kết hệ thống “an toàn 100%”.

### Chỉ tiêu kinh doanh để thảo luận

Các mục tiêu từ kế hoạch cũ được giữ để đối chiếu, chưa dùng làm lời hứa:

| Mục tiêu tham khảo | Cách dùng trong kế hoạch mới |
|---|---|
| Phản hồi dưới 30 giây | Chốt cách đo và phân vị; không chỉ đo thời gian API nhận việc |
| Hoàn thành tìm hiểu nhu cầu trên 60% | Dùng đúng nhóm đủ điều kiện và công bố số mẫu |
| Chuyển đổi đặt lịch tăng 20% tương đối | Chỉ dùng nếu hành trình có lịch và có đường cơ sở phù hợp |
| Thời gian hỏi nhu cầu lặp lại giảm 30% | Đo thời gian nhân viên thực, gồm cả kiểm tra/sửa câu trả lời |
| Hỗ trợ thông thường tự động trên 50% | Chỉ tính giải quyết có xác nhận, báo số mở lại |
| Tóm tắt bàn giao đầy đủ trên 95% | Chốt trường bắt buộc; trường an toàn quan trọng không được thiếu |
| Tuân thủ bộ thử chính sách trên 99% | Chỉ là chỉ số tổng hợp; không cho phép bỏ qua bất kỳ lỗi nghiêm trọng nào |

Với B2C, bổ sung lãi đóng góp, mua sai/đổi trả và tổng chi phí phục vụ làm điều kiện bảo vệ, nhưng ngưỡng phải do doanh nghiệp duyệt sau khi có dữ liệu.

### Hồ sơ nghiệm thu

Lưu phiên bản phần mềm/cấu hình/tài liệu, vết yêu cầu–kết quả, mã ghi hệ thống nguồn, kiểm thử hai doanh nghiệp, bộ tình huống và lỗi còn lại, phép tính báo cáo, quyết định bật quyền, người trực và phương án phục hồi. Ca chưa chạy không được đánh dấu đạt.

<a id=section-22></a>

## 5. Lộ trình theo bằng chứng & Cổng kỹ thuật P0–P5

Lộ trình kết hợp chặt chẽ giữa 6 Cổng kỹ thuật nghiêm ngặt theo SRS v0.1 và Chiến lược thương mại hóa B2B SaaS toàn cầu:

| Giai đoạn | Mục tiêu kỹ thuật & thương mại | Phạm vi triển khai | Cổng ra nghiệm thu (Exit Gate) |
|---|---|---|---|
| **P0 — Hạ tầng nền tảng & Hợp đồng chuẩn hóa (Foundation & Canonical Contracts)** | Chuẩn hóa giao diện dữ liệu, kiến trúc lõi đa doanh nghiệp (Multi-tenant) và chuẩn bị hạ tầng kiểm soát giá sàn. | Canonical contracts cho Customer360, Agent, Skill, Decision, Action, Approval, Evidence, Outcome; Connector Framework; Policy Engine; phân tách schema dữ liệu; nghiên cứu thị trường thủ công có AI soạn nháp; bộ quy tắc giá sàn và chi phí cơ sở. | Agent chưa cần thông minh nhất nhưng tuyệt đối không được vượt quyền hoặc mất dấu vết truy vết (Traceability). Vượt qua kiểm thử cô lập dữ liệu 2 doanh nghiệp; không có ca kiểm thử nào lọt lỗi ranh giới bảo mật. |
| **P1 — Thí điểm mỏ neo Đài Loan: Customer Care & Sales (Taiwan Anchor Pilot)** | Chứng minh hiệu quả vận hành thực tế trên thị trường nội địa Đài Loan cho 2 ngành FMCG và Xe máy điện thông minh (Mobility). | Triển khai B2C cho đối tác Đài Loan; Conversation Agent, intent, identity, ERP/Order lookup, FAQ, escalation bàn giao người (PILOT-03, PILOT-04); kết nối LINE OA, ECPay, 7-Eleven CVS COD, bộ tính trợ cấp xe điện O2O, cọc lái thử showroom; ngân sách AI 0.5–1 TWD/phiên. | Một hội thoại thật được xử lý E2E và có bằng chứng (evidence) xác thực từ ERP nguồn; nhân viên tiếp quản trơn tru; thu thập đầy đủ bộ chỉ số thực nghiệm tại [analytics.md](analytics.md). |
| **P2 — Sales Pilot & Chuẩn hóa Vertical SaaS + Plug-and-Play Adapters** | Chứng minh chuyển đổi doanh thu từ AI Sales (PILOT-02) và tách rời lõi thông qua cơ chế Adapter cắm-rút đa quốc gia. | Chấm điểm nhu cầu (qualification), tra cứu sản phẩm, đề xuất giỏ hàng, phục hồi giỏ hàng bỏ quên, cross-sell/upsell, hỗ trợ chốt đơn; đóng gói 2 gói chuyên ngành (**AgentOS Mobility** & **AgentOS FMCG**); xây dựng 3 cổng cắm-rút (WhatsApp Business API, Stripe/PayPal, GDPR/CCPA). | Chứng minh chuỗi: AI action → order → revenue evidence; hoán đổi thành công cổng kết nối mà không sửa Core Engine; vượt qua kiểm thử cô lập dữ liệu đa doanh nghiệp; thỏa mãn TC-E2E-003 và TC-E2E-005. |
| **P3 — Marketing Pilot & Phân phối 1-chạm qua App Store (Shopify & WooCommerce)** | Kích hoạt Tiếp thị tự động có kiểm duyệt (PILOT-01) và mở rộng kênh phân phối 1-chạm B2B SaaS toàn cầu. | Phân tập khách hàng (audience segment), tạo chiến dịch, sinh nội dung có human approval gate, phát hành đa kênh (Facebook, TikTok, Email), quy thuộc doanh thu (attribution); đóng gói ứng dụng 1-chạm trên Shopify App Store và WooCommerce Marketplace; dùng Case Study Đài Loan làm đòn bẩy B2B. | Tự động hóa quy trình onboarding merchant toàn cầu; chiến dịch Marketing chạy E2E có approval 100%; thỏa mãn TC-E2E-002; attribution doanh thu chuẩn xác, không suy đoán. |
| **P4 — Điều phối liên miền (Cross-domain Orchestration)** | Kết nối liền mạch chuỗi giá trị: Tiếp thị → Bán hàng → Chăm sóc khách hàng → Customer Success / Giữ chân (Retention). | Revenue Orchestrator đồng bộ ngữ cảnh Customer360 xuyên suốt các Agent; tự động chuyển tiếp tín hiệu từ chiến dịch tiếp thị sang hội thoại tư vấn bán hàng, chuyển trạng thái đơn hàng sang CSKH, kích hoạt chu kỳ bảo dưỡng, tích điểm đơn 2 và chống rời bỏ (churn prevention). | Toàn bộ hành trình khách hàng xuyên suốt 3 Agent duy trì thống nhất Customer360 Context mà không thất thoát dữ liệu; đạt chuẩn TC-E2E-001 và TC-E2E-009 trên luồng liên phòng ban. |
| **P5 — Tự chủ có kiểm soát & Tăng trưởng quy mô toàn cầu (Controlled Autonomy & Global Scale)** | Nâng cấp cấp độ tự động hóa an toàn cho $N$ doanh nghiệp toàn cầu trên hạ tầng Serverless/Multi-tenant. | Hành động rủi ro thấp đủ điều kiện được nâng từ *Recommend* → *Draft* → *Auto Execute*; hành động rủi ro cao (hoàn tiền, giảm giá ngoài khung, khiếu nại nghiêm trọng) bắt buộc giữ Human Approval; tự động hóa mở rộng quy mô, tối ưu token cost và bảo vệ biên lợi nhuận ròng. | Vận hành ổn định ở quy mô lớn với tỷ lệ tự động hóa cao; 0 vi phạm chính sách vượt quyền (Policy Violation Rate = 0%); chi phí AI trên mỗi kết quả thành công đạt định mức kinh tế đơn vị; 100% rủi ro cao tuân thủ cổng duyệt. |

Lộ trình được dẫn dắt bằng dữ liệu thực nghiệm: kết quả đo lường định lượng từ P1 tại Đài Loan là điều kiện tiên quyết để đóng gói và mở rộng thương mại sang P2 và P3.

### Cổng riêng cho tính năng rủi ro

| Tính năng | Chưa được bật cho tới khi |
|---|---|
| Mặc cả/giá ưu đãi | Tài chính duyệt chi phí/sàn/ngân sách; tính thử đúng; không lách qua API, giỏ hoặc mã ưu đãi; có hạn mức và ngắt |
| Thanh toán tức thời & Cổng quốc tế | Có hợp đồng kết nối (Stripe, PayPal, Apple/Google Pay, QR nội địa), đối soát nguồn, nhánh trùng/muộn/thiếu/thừa và người xử lý |
| Phiếu bù giá | Có chính sách công khai, chi phí, điều kiện đơn, chống cấp vượt/trùng và xử lý đơn trả |
| Đối tác | Quy tắc nguồn/hoa hồng, quyền dữ liệu, đối soát và chống gian lận được duyệt |
| Gợi ý tự bật/mã nhúng | Đo tương thích/tốc độ/khả năng tiếp cận và tần suất; không che thao tác mua |
| Tra vận chuyển/hóa đơn | Nguồn xác nhận được năng lực cụ thể; không hứa ngoài dữ liệu |
| Phân tích ảnh/video | Có dữ liệu đánh giá, quyền lưu/xóa, quy trình người duyệt; không tự quyết quyền lợi khách |
| Điểm thưởng & phiếu thân thiết | Tài chính duyệt tỷ lệ trích quỹ điểm; có quy tắc Min Spend, trần Basket Cap/Cap tiền mặt; bộ tứ định danh chống clone tài khoản (OTP kênh quốc tế, thiết bị, hash phương thức thanh toán, địa chỉ); cấm giảm % với xe máy điện |

<a id=section-23></a>

## 6. Quyết định tiếp theo & Quy trình Handoff triển khai

Điền tên doanh nghiệp và website ở [phiếu đầu vào](#pilot-inputs). Sau khi chọn hành trình, chốt một kết quả có thể kiểm tra rồi mới ước lượng công tích hợp. Các công việc trong tài liệu này chưa được đánh dấu đã làm.

### 6.1. Quy trình Handoff 7 bước triển khai đề xuất

Theo Mục 28 của SRS v0.1, các nhóm chuyên môn thực hiện chuyển giao theo quy trình:
1. **Business / BA**: Khóa danh sách KPI, cổng kết nối (Connectors), ngưỡng phê duyệt (Approval Thresholds) và phạm vi dữ liệu được phép sử dụng (ASM-001..ASM-005).
2. **Solution Architect**: Khóa Canonical Contracts cho Customer360, Agent, Skill, Decision, Action, Approval, Evidence và Outcome.
3. **AI Engineering**: Xây dựng Revenue Orchestrator, Agent Runtime, Knowledge/Skill Framework và bộ công cụ đánh giá tự động (Evaluation Harness).
4. **Backend / Integration**: Xây dựng API Gateway, Event Ingestion Pipeline, hệ thống Connector cắm-rút và cơ chế thực thi Idempotent chống trùng lặp.
5. **Frontend**: Phát triển Human Command Center gồm Executive Dashboard, Agent Operations, Approval Center, Customer360 Timeline và Conversation Console.
6. **QA / Testing**: Thiết lập bộ Acceptance Test Suite tự động hóa từ TC-E2E-001..TC-E2E-009 kèm các bộ kiểm thử phủ định (Negative / Adversarial Tests).
7. **Triển khai Pilot Production-like**: Vận hành thử nghiệm theo đúng thứ tự cổng Gate: Customer Care → Sales → Marketing → Cross-domain Orchestration → Controlled Autonomy.
