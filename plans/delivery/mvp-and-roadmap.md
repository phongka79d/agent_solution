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

## 5. Mô hình Lộ trình Trục kép (Dual-Track Roadmap)

Để giải quyết triệt để sự giằng co giữa an toàn kỹ thuật phần mềm và mục tiêu tăng trưởng thương mại thực chiến, hệ thống vận hành theo **Mô hình Lộ trình Trục kép (Dual-Track Roadmap)**:
- **Trục 1 — Kỹ thuật Phần mềm (Engineering Track)**: Tuân thủ nghiêm ngặt 6 Cổng kỹ thuật P0–P5 theo Mục 24 của SRS v0.1, bảo đảm an toàn dữ liệu, kiểm soát ranh giới quyền hạn và tính ổn định của hệ thống.
- **Trục 2 — Kinh doanh & Thương mại (Commercial Track)**: Thực thi 3 giai đoạn mở rộng thị trường từ Khách hàng mỏ neo Đài Loan đến Mạng lưới phân phối App Store toàn cầu, bảo đảm dòng tiền và hiệu quả kinh tế đơn vị.

```text
======================= DUAL-TRACK ROADMAP ARCHITECTURE =======================

TRỤC 1: KỸ THUẬT PHẦN MỀM (ENGINEERING TRACK - 6 CỔNG P0–P5 THEO SRS)
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ P0: FOUNDATION│──▶│ P1: CARE     │──▶│ P2: SALES    │──▶│ P3: MARKETING│──▶│ P4: CROSS-   │──▶│ P5: CONTROLLED
│ Contracts &  │   │ FAQ & Lookup │   │ Pricing &    │   │ Content &    │   │     DOMAIN   │   │     AUTONOMY 
│ Architecture │   │ (PILOT-03/04)│   │ (PILOT-02)   │   │ (PILOT-01)   │   │ Orchestration│   │ Global Scale 
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
       │                  │                  │                  │                  │                  │
       ▼                  ▼                  ▼                  ▼                  ▼                  ▼
┌────────────────────────────────────────────┐   ┌─────────────────────────────┐   ┌──────────────────────────┐
│ PHASE 1: TAIWAN ANCHOR PILOT               │──▶│ PHASE 2: ADAPTER & SAAS     │──▶│ PHASE 3: GLOBAL APP STORE│
│ - AgentOS Mobility (GTM-001A, DOM-MOB)     │   │ - Chuẩn hóa Vertical SaaS   │   │ - Shopify & WooCommerce  │
│ - AgentOS FMCG (GTM-001B, DOM-FMCG)        │   │ - Cắm-rút ADPT-GL-001..003  │   │   1-Click App (GTM-002)  │
│ - Đài Loan Adapter (ADPT-TW-001)           │   │ - Đa khách hàng Multi-tenant│   │ - Đòn bẩy dữ liệu GTM-003│
└────────────────────────────────────────────┘   └─────────────────────────────┘   └──────────────────────────┘
TRỤC 2: KINH DOANH & THƯƠNG MẠI (COMMERCIAL TRACK - 3 GIAI ĐOẠN TĂNG TRƯỞNG)
==============================================================================
```

### 5.1. Trục 1 — Kỹ thuật Phần mềm (Engineering Track: 6 Cổng P0–P5 theo SRS)

| Cổng kỹ thuật | Mục tiêu kỹ thuật cốt lõi | Phạm vi công việc thực thi | Tiêu chuẩn ra cổng bắt buộc (Exit Gate) |
|---|---|---|---|
| **P0 — Foundation** (Hạ tầng nền tảng & Hợp đồng dữ liệu) | Chuẩn hóa Canonical Contracts, kiến trúc đa doanh nghiệp (Multi-tenant), phân quyền và kiểm toán. | Thiết lập Canonical contracts cho Customer360, Agent, Skill, Decision, Action, Approval, Evidence, Outcome; dựng Connector Framework, Policy Engine (BR-001..010), Authority Model (AUTH-0..5); phân tách schema đa tenant. | Agent chưa cần thông minh nhất nhưng tuyệt đối không vượt quyền hoặc mất trace. Vượt qua kiểm thử cô lập dữ liệu 2 doanh nghiệp; không lọt lỗi ranh giới bảo mật. |
| **P1 — Customer Care Pilot** (Thí điểm Chăm sóc khách hàng) | Kiểm chứng khả năng hội thoại và tra cứu dữ liệu thời gian thực từ System of Record mà không rò rỉ thông tin. | Triển khai CS-01 và CS-02; nhận diện 10 nhóm intent; xác minh danh tính khách hàng; tra cứu đơn hàng ERP/WMS; trả lời FAQ; quy trình chuyển người (PILOT-03, PILOT-04); ghi vết kiểm toán đầy đủ. | Một hội thoại thật được xử lý E2E và có evidence từ ERP nguồn; nhân viên tiếp quản trơn tru; đạt chuẩn TC-E2E-004 (xác minh danh tính) và TC-E2E-008 (connector trung thực). |
| **P2 — Sales Pilot** (Thí điểm Bán hàng & Bảo toàn giá sàn) | Kiểm chứng chuỗi giá trị: AI tư vấn → Đơn hàng → Doanh thu thật; bảo vệ 100% biên lãi ròng qua máy chủ. | Triển khai 5 Sales Agent (SAL-01..SAL-05); chấm điểm nhu cầu; tra cứu tồn kho/giá ERP; đề xuất cross/upsell; phục hồi giỏ hàng bỏ quên (PILOT-02); máy chủ duyệt giá sàn $P_{floor}$ (ECN-002) và trần giảm giá $D_{cap}$ (ECN-001). | Chứng minh chuỗi: AI action → order → revenue evidence; không đưa giá ngoài nguồn chính thức (TC-E2E-003); chống tạo đơn trùng lặp (TC-E2E-005); kiểm tra giá sàn thành công 100%. |
| **P3 — Marketing Pilot** (Thí điểm Tiếp thị có kiểm duyệt) | Tự động hóa tạo chiến dịch và nội dung tiếp thị dưới sự kiểm duyệt tuyệt đối của con người (Human Approval Gate). | Triển khai 6 Marketing Agent (MKT-01..MKT-06); phân tích cohort/segment; lập kế hoạch chiến dịch; sinh nội dung đa kênh (Facebook, TikTok, Email); cổng duyệt phê duyệt (SCR-003); quy thuộc doanh thu (attribution). | Chiến dịch Marketing chạy E2E có approval 100%; tuyệt đối không tự ý xuất bản nếu thiếu phê duyệt (TC-E2E-002); mô hình quy thuộc doanh thu minh bạch, không suy đoán. |
| **P4 — Cross-domain Orchestration** (Điều phối xuyên miền) | Hợp nhất toàn diện luồng dữ liệu liên miền Marketing → Sales → CSKH → Retention/Success trên cùng Customer360. | Revenue Orchestrator điều phối chu trình 11 bước; đồng bộ trạng thái khách hàng giữa các module; chuyển tiếp lead từ Marketing sang Sales, chuyển đơn hàng sang CSKH, kích hoạt vòng lặp giữ chân và mua lại. | Toàn bộ hành trình khách hàng xuyên suốt 3 Agent duy trì ngữ cảnh Customer360 thống nhất; đạt chuẩn TC-E2E-001 (luồng khép kín) và TC-E2E-009 (truy vết ngược 100%). |
| **P5 — Controlled Autonomy** (Tự chủ có kiểm soát quy mô lớn) | Mở rộng tự động hóa an toàn cho $N$ doanh nghiệp, nâng quyền tự động cho tác vụ an toàn và tối ưu chi phí vận hành. | Hành động rủi ro thấp đủ điều kiện được nâng từ *Recommend* → *Draft* → *Bounded Execute* (AUTH-3); hành động tài chính/rủi ro cao (hoàn tiền, đền bù, đổi giá) bắt buộc giữ Human Approval (AUTH-4); tối ưu chi phí token. | Tỷ lệ vi phạm chính sách bằng 0 (Policy Violation Rate = 0%); chi phí AI đạt định mức mục tiêu 0,5–1 TWD/phiên (ECN-003); hệ thống tự động ngắt khi phát hiện rủi ro (Fail Closed). |

### 5.2. Trục 2 — Kinh doanh & Thương mại (Commercial Track: 3 Giai đoạn mở rộng)

| Giai đoạn thương mại | Trọng tâm thị trường & Sản phẩm | Các thành phần triển khai chi tiết | Điều kiện chuyển tiếp (Milestone Gate) |
|---|---|---|---|
| **Phase 1 — Taiwan Anchor Pilot** (Thí điểm mỏ neo Đài Loan) | Kiểm chứng thực chiến bài toán kinh tế và văn hóa tiêu dùng B2C Đài Loan cho 2 ngành: High-Ticket EV Scooter và FMCG. | Triển khai 2 gói chuyên ngành: **GTM-001A (AgentOS Mobility)** và **GTM-001B (AgentOS FMCG)**; tích hợp bộ adapter Đài Loan **ADPT-TW-001**: cổng LINE OA, thanh toán ECPay/NewebPay/LINE Pay, nhận hàng siêu thị tiện lợi 7-Eleven/FamilyMart CVS COD, tuân thủ Taiwan PDPA tại GCP Changhua/AWS Taipei; ứng dụng cơ chế trích hoa hồng telesales (ECN-001) và khóa giá sàn $P_{floor}$ (ECN-002). | Đạt được các chỉ số thực nghiệm đo lường định lượng tại [analytics.md](analytics.md): Chuyển đổi tăng +25%–40%, phản hồi < 1,5s, chi phí AI 0,5–1 TWD/phiên, bảo toàn 100% biên lãi ròng. |
| **Phase 2 — Adapter Standardization & Multi-tenant** (Chuẩn hóa Vertical SaaS & Cơ chế Cắm-Rút) | Đóng gói sản phẩm độc lập, tách rời Core Engine và sẵn sàng mở rộng cho $N$ doanh nghiệp đa quốc gia. | Chuẩn hóa cấu trúc gói sản phẩm Vertical SaaS (GTM-001A và GTM-001B); hoàn thiện 3 cổng kết nối cắm-rút toàn cầu: **ADPT-GL-001** (WhatsApp Business API, Telegram, đa ngôn ngữ Web Widget), **ADPT-GL-002** (Stripe, PayPal, Apple Pay, Google Pay, Postal COD), **ADPT-GL-003** (Tuân thủ GDPR Châu Âu, CCPA Mỹ, PDPA Singapore); thiết lập cổng tự phục vụ cấu hình (Self-serve Onboarding). | Hoán đổi thành công giữa ADPT-TW-001 và ADPT-GL-001..003 mà không cần chỉnh sửa Core AI Engine; vượt qua kiểm thử cô lập dữ liệu 100% giữa các tenant doanh nghiệp. |
| **Phase 3 — Global 1-Click App Store Distribution** (Phân phối 1-chạm toàn cầu qua App Store) | Mở rộng quy mô toàn cầu theo mô hình Tăng trưởng dựa trên sản phẩm (Product-Led Growth - PLG) với chi phí thu hút khách hàng (CAC) tối thiểu. | Phát hành ứng dụng cài đặt 1-chạm **GTM-002** trên **Shopify App Store** và **WooCommerce Marketplace**; tự động đồng bộ sản phẩm, tồn kho và đơn hàng qua GraphQL/REST API; xuất bản Case Study và Whitepaper định lượng **GTM-003** đòn bẩy số liệu thực nghiệm Đài Loan làm bằng chứng xã hội (Social Proof) và cam kết ROI để bán cho hàng trăm nghìn nhà bán lẻ quốc tế. | Đạt quy mô tăng trưởng tự chủ toàn cầu; hệ thống vận hành tự động ổn định; doanh thu định kỳ hàng tháng (MRR) tăng trưởng bền vững dựa trên phí nền tảng và mức sử dụng AI. |

### 5.3. Ma trận đồng bộ giữa Trục Kỹ thuật và Trục Thương mại (Track Synchronization)

| Giai đoạn Thương mại | Cổng Kỹ thuật tương ứng | Điều kiện phối hợp hai trục |
|---|---|---|
| **Phase 1: Taiwan Anchor Pilot** | **Gate P0, P1, P2** | P0 cung cấp hạ tầng hợp đồng và kiểm soát giá; P1 kích hoạt CSKH (PILOT-03/04) trên LINE OA và E-Map 7-Eleven; P2 kích hoạt tư vấn bán hàng (PILOT-02) bảo toàn giá sàn $P_{floor}$ để tạo doanh thu thực tế cho đối tác mỏ neo. |
| **Phase 2: Adapter Standardization** | **Gate P3, P4** | P3 bổ sung năng lực Tiếp thị tự động có kiểm duyệt (PILOT-01); P4 hợp nhất điều phối liên miền; bộ cắm-rút ADPT-GL-001..003 được kiểm nghiệm độc lập với lõi. |
| **Phase 3: Global App Store Distribution** | **Gate P5** | P5 hoàn thiện cơ chế tự chủ có kiểm soát (Controlled Autonomy), tối ưu chi phí token dưới tải lớn của hàng loạt merchant cài đặt từ Shopify/WooCommerce App Store (GTM-002). |

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
