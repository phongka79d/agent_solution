# Bản đầu, kiểm chứng và lộ trình triển khai

[Mục lục](../README.md) · [Bản dễ hiểu](../plan-easy-read-flow.md) · [Đo lường](analytics.md)

Trạng thái: kế hoạch đề xuất theo chuẩn SRS v0.1 (AI-REV-SRS-001). P0–P5 là giai đoạn theo cổng nghiệm thu kỹ thuật và thương mại, không phải lịch phát hành cố định chưa kiểm chứng.

<a id=section-21></a>

## 1. Bản đầu (Gate P1): Customer Care Pilot thuần túy

Mục tiêu Gate P1 theo Mục 24 của SRS v0.1: Triển khai thuần túy **Customer Care Pilot (CS-01, CS-02)** trên website và kênh chat hiện có của doanh nghiệp mỏ neo. Trọng tâm là nhận diện ý định (Intent Detection), xác minh danh tính khách hàng, tra cứu dữ liệu đơn hàng thời gian thực từ System of Record (ERP/WMS), giải đáp chính sách (FAQ) và quy trình chuyển giao nhân viên (Human Escalation) trơn tru, bảo đảm an toàn dữ liệu và ghi vết kiểm toán đầy đủ.

**Tách biệt phạm vi rành mạch**: Toàn bộ module Bán hàng (hỏi nhu cầu, tư vấn cấu hình, gợi ý sản phẩm, giỏ hàng thông minh, trợ cấp chốt đơn động và bảo toàn giá sàn máy chủ) được tách riêng hoàn toàn sang **Gate P2 (Sales Pilot)** theo kịch bản PILOT-02. Gate P1 tuyệt đối không triển khai các chức năng bán hàng, tạo giỏ hay giao dịch thương mại.

### 1.1. Tiêu chuẩn hoàn thành cấp hệ thống (System-level Definition of Done)

Hệ thống không được coi là hoàn thành chỉ vì Agent có khả năng trò chuyện (chat). Một năng lực (capability) hoặc quy trình nghiệp vụ chỉ đạt chuẩn nghiệm thu khi chứng minh được đầy đủ 10 thành tố thực tế:

> **Data thật + Agent thật + Skill thật + Tool thật + Policy thật + Approval thật + Execution thật + Evidence thật + Outcome thật + Test thật.**

Mục tiêu cốt lõi là thiết lập một **AI Revenue Workforce** có khả năng trực tiếp tham gia vận hành Tiếp thị, Bán hàng và Chăm sóc khách hàng với mức tự động hóa cao, nhưng mọi quyền thực thi đều có giới hạn, có thể kiểm soát và truy vết tuyệt đối.

### 1.2. Bốn kịch bản thí điểm nghiệm thu (Acceptance Pilots)

Theo Mục 21 của SRS v0.1, hệ thống thiết kế 4 kịch bản nghiệm thu mẫu phân bổ theo từng cổng Gate:
- **PILOT-01 — Tiếp thị → Bán hàng (Marketing → Sales) [Gate P3]:** Customer Signal → Segment → Campaign → Content → Approval → Send/Publish → Customer Response → Sales Conversation → Recommendation → Order → Revenue Evidence.
- **PILOT-02 — Phục hồi giỏ hàng (Cart Recovery) [Gate P2]:** Abandoned Cart → Customer Context → Eligibility → Recommendation → Message → Conversion → Order → Attribution.
- **PILOT-03 — Chăm sóc khách hàng (Customer Care) [Gate P1]:** Customer Question → Intent Detection → Customer Identification → ERP/Order Lookup → AI Resolution → Customer Response → Case Outcome.
- **PILOT-04 — Khiếu nại & Chuyển cấp (Escalation) [Gate P1]:** Complaint → Classification → Policy Check → AI unable/unauthorized → Human Escalation → Resolution → Outcome.

### Phạm vi bật trong Gate P1 (Customer Care Pilot)

| Thành phần | Mức tối thiểu bật trong Gate P1 | Điều kiện kiểm soát |
|---|---|---|
| Customer360 | Liên kết khách/phiên, ngữ cảnh hỗ trợ, lịch sử hội thoại, ticket CSKH, consent và người phụ trách | Phân tách đa tenant; chỉ đọc dữ liệu khách đã xác minh danh tính |
| API và Kênh chat | Tiếp nhận câu hỏi qua Web Widget hoặc LINE OA, nhận mã công việc (job ID), trả lời bất đồng bộ; có cơ chế thử lại (retry) | Máy chủ doanh nghiệp hoặc webhook kênh được xác thực bảo mật |
| Kho kiến thức & FAQ | Kho tài liệu hỏi đáp, chính sách vận chuyển, đổi trả, bảo hành đã được duyệt (/customer-care/faq.md, support-policy.md) | Có chủ sở hữu nguồn, phiên bản, độ mới; không tự suy diễn ngoài tài liệu |
| Điều phối CSKH | Phân luồng giữa CS-01 (Omnichannel Care), CS-02 (Retention) và nhân viên hỗ trợ (Human Agent) | Tiếp thị và Bán hàng tắt hoàn toàn; không gọi skill ngoài phạm vi CSKH |
| CS-01 Chăm sóc khách hàng | Nhận diện 10 nhóm intent bắt buộc (hỏi đơn, giao hàng, đổi trả, bảo hành, khiếu nại, gặp người...) | Chỉ trả lời có bằng chứng; câu hỏi ngoài phạm vi chuyển sang nhân viên |
| CS-02 Retention cơ bản | Ghi nhận tín hiệu khách không hài lòng, khiếu nại lặp lại để chuyển cấp | Chỉ phân tích và ghi nhận fact; không tự ý kích hoạt ưu đãi/voucher |
| Tra cứu ERP/WMS | Đọc trạng thái đơn hàng, mã vận đơn, dự kiến giao hàng từ ERP/WMS thực qua Skill tra cứu có thẩm quyền (AUTH-3) | Khách hàng bắt buộc phải qua bước xác minh danh tính (TC-E2E-004) |
| Bàn giao người thật | Tạo Service Case, đưa vào hàng đợi bàn giao, nhân viên tiếp quản (takeover), trả quyền AI | Có nhân viên trực tiếp quản; chuyển giao trọn vẹn context hội thoại |
| Báo cáo & Giám sát | Đo lường FRT, thời gian giải quyết, tỷ lệ AI tự xử lý, tỷ lệ chuyển cấp, CSAT và chi phí token theo NFR-010 | Ghi rõ dữ liệu thiếu; phân tách chi phí token rõ ràng |
| *Module Bán hàng* | **TẮT HOÀN TOÀN** trong Gate P1 (Hỏi nhu cầu, tư vấn, gợi ý, giỏ hàng, đặt cọc chuyển sang Gate P2) | Tuyệt đối không chào mời sản phẩm hoặc can thiệp quy trình mua hàng |
| *Module Tiếp thị* | **TẮT HOÀN TOÀN** trong Gate P1 (Lập chiến dịch, tạo nội dung, gửi tin tiếp thị chuyển sang Gate P3) | Không tự ý gửi thông điệp tiếp thị chủ động ra bên ngoài |

### Danh sách được phép và bị cấm trong Gate P1

| Được phép có điều kiện trong Gate P1 | Tuyệt đối không được phép trong Gate P1 |
|---|---|
| Đọc và lưu ngữ cảnh khách hàng sau khi đã xác minh danh tính hợp lệ | Tra cứu dữ liệu chéo tenant doanh nghiệp, xem đơn hàng của khách khác |
| Giải đáp FAQ, chính sách bảo hành/giao hàng dựa trên tài liệu đã duyệt | Tự suy diễn hoặc bịa đặt chính sách ngoài kho tri thức đã duyệt |
| Tra cứu trạng thái đơn hàng thời gian thực từ ERP/WMS nguồn | Sửa đổi trạng thái đơn hàng, sửa địa chỉ giao hàng hoặc can thiệp tồn kho |
| Tự động phân loại intent và đánh giá mức độ khẩn cấp của khiếu nại | Tự ý quyết định hoàn tiền, hủy đơn hoặc cấp bù giá ngoài thẩm quyền (AUTH-5) |
| Chuyển vụ việc cho nhân viên con người kèm đầy đủ context Customer360 | Để vụ việc khiếu nại bị treo im lặng mà không có người tiếp quản |
| Thu thập phản hồi đánh giá CSAT sau khi giải quyết xong vụ việc | Tự ý hỏi nhu cầu mua sắm, tư vấn bán hàng hoặc gợi ý sản phẩm (tách sang P2) |
| Nhân viên duyệt, tiếp quản và trả quyền AI qua giao diện Command Center | Tự tạo giỏ hàng, liên kết thanh toán, nhận cọc hoặc can thiệp giá bán (tách sang P2) |
| Ghi nhận sự kiện kiểm toán và chi phí AI theo NFR-002, NFR-010 | Báo cáo thành công giả mạo khi cổng kết nối ERP gặp sự cố (TC-E2E-008) |

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

### 4.2. Ma trận truy vết chuẩn cấp hệ thống (Traceability Matrix theo Mục 25 SRS)

Bảng đối chiếu truy vết 100% giữa các Mục tiêu kinh doanh nền tảng (Business Objectives), nhóm yêu cầu kỹ thuật và tiêu chí kiểm chứng nghiệm thu chính theo Mục 25 của đề bài SRS v0.1:

| Business Objective | Nhóm yêu cầu | Validation chính |
|---|---|---|
| **OBJ-001 Marketing** | MKT-01..06 | PILOT-01 |
| **OBJ-002 Sales** | FR-SAL-001..003, SAL-01..05 | PILOT-02 |
| **OBJ-003 Customer Care** | FR-CS-001..003, CS-01..02 | PILOT-03 |
| **OBJ-004 Retention** | FR-CS-003 | Retention workflow |
| **OBJ-005 Orchestration** | FR-ORC-001..002 | TC-E2E-001 |
| **OBJ-006 Governance** | BR-001..010, NFR-001..010 | TC-E2E-002..009 |

### 4.3. Phụ lục Đặc tả kịch bản kiểm thử chi tiết cho 4 kịch bản thí điểm (Pilot Test Specifications)

Đặc tả kiểm thử chi tiết đối với 4 kịch bản nghiệm thu tại Mục 21 SRS, bao gồm đầy đủ dữ liệu kích hoạt (Trigger Data), các bước thực thi tuần tự (Execution Steps) và tiêu chuẩn Đạt/Không đạt (Pass/Fail Criteria) lượng hóa:

#### 1. PILOT-01 — Tiếp thị → Bán hàng (Marketing → Sales Pilot - Nghiệm thu Gate P3)
- **Mục tiêu nghiệm thu:** Kiểm chứng chu trình trọn vẹn từ tín hiệu khách hàng, lập kế hoạch chiến dịch, tạo nội dung có kiểm duyệt, xuất bản qua kênh đến hội thoại tư vấn bán hàng và ghi nhận doanh thu có quy thuộc.
- **Dữ liệu kích hoạt (Trigger Data):**
  - Tín hiệu: `signal.market_cohort` (nhóm khách hàng quan tâm dòng xe điện thế hệ mới hoặc nhóm khách hàng FMCG chu kỳ mua định kỳ).
  - Ngữ cảnh: Hồ sơ Customer360 (phân khúc, lịch sử tương tác, trạng thái consent hợp lệ).
  - Kế hoạch chiến dịch: Campaign Brief ID `#CAMP-2026-M03` do MKT-01 đề xuất.
- **Các bước thực thi tuần tự:**
  1. *Phân tích & Lập kế hoạch:* MKT-01 phân tích mục tiêu kinh doanh, xác định đối tượng mục tiêu; MKT-02 trích xuất cohort đủ điều kiện nhận tin.
  2. *Sáng tạo nội dung & Duyệt thương hiệu:* MKT-03 sinh nội dung tiếp thị đa kênh (LINE OA / Email); MKT-04 kiểm soát tone of voice, tính trung thực thông số và từ khóa cấm.
  3. *Cổng phê duyệt bắt buộc (Human Approval Gate):* Hệ thống chuyển nội dung sang màn hình Command Center SCR-003. Chiến dịch dừng chờ con người phê duyệt (AUTH-4); tuyệt đối không tự ý xuất bản (TC-E2E-002).
  4. *Xuất bản chiến dịch:* Sau khi nhận quyết định `APPROVED` từ người có thẩm quyền, MKT-05 kích hoạt cổng kết nối gửi thông điệp có gắn `campaign_id` và `trace_id`.
  5. *Phản hồi & Điều phối:* Khách hàng nhấp liên kết hoặc nhắn tin phản hồi; Revenue Orchestrator điều hướng hội thoại sang SAL-01 để thẩm định nhu cầu.
  6. *Tư vấn & Bán hàng:* SAL-02 tra cứu giá và tồn kho chính thức từ ERP; SAL-03 đề xuất gói sản phẩm phù hợp.
  7. *Chốt đơn & Ghi nhận doanh thu:* Khách hoàn tất đặt hàng (`order.confirmed`); Orchestrator ghi nhận bằng chứng doanh thu (Revenue Evidence) và đối soát quy thuộc (Attribution).
- **Tiêu chuẩn Đạt / Không đạt (Pass/Fail Criteria) lượng hóa:**
  - **ĐẠT (PASS):**
    - 100% nội dung chiến dịch được phê duyệt qua cổng SCR-003 trước khi phát tán ra môi trường thực tế (Zero Unauthorized Publish).
    - Chuỗi truy vết liên tục 100% từ Signal ID → Campaign ID → Message ID → Lead ID → Order ID mang cùng `trace_id`.
    - Doanh thu đơn hàng ghi nhận khớp 100% với số liệu từ System of Record (ERP/Payment Gateway).
    - Độ trễ phản hồi khi khách tương tác qua lại < 2.0 giây (p95).
  - **KHÔNG ĐẠT (FAIL):**
    - AI tự động xuất bản thông điệp khi chưa có xác nhận từ con người trên SCR-003 (Vi phạm nghiêm trọng TC-E2E-002).
    - Nội dung tin nhắn chứa thông tin giá, khuyến mãi sai lệch với nguồn ERP hoặc vi phạm brand policy.
    - Mất dấu liên kết truy vết doanh thu ngược về chiến dịch khởi tạo.

#### 2. PILOT-02 — Phục hồi giỏ hàng bỏ quên (Cart Recovery Pilot - Nghiệm thu Gate P2)
- **Mục tiêu nghiệm thu:** Kiểm chứng khả năng phát hiện giỏ hàng bỏ quên, kiểm tra tính hợp lệ và sự đồng ý, áp dụng trợ cấp bảo toàn giá sàn và khôi phục đơn hàng thành công.
- **Dữ liệu kích hoạt (Trigger Data):**
  - Sự kiện: `cart.abandoned` được phát ra từ Web Commerce / App sau khi phiên giỏ hàng không có hoạt động trong 30 phút.
  - Payload sự kiện: `cart_id`, `customer_id`, danh sách SKU, số lượng, giá niêm yết $P_{base}$, tổng giá trị giỏ hàng.
- **Các bước thực thi tuần tự:**
  1. *Tiếp nhận & Kiểm tra điều kiện:* SAL-04 tiếp nhận tín hiệu; tra cứu Customer360 kiểm tra trạng thái đồng ý (Marketing Consent) và kiểm tra quy tắc loại trừ (Suppression Rules: không gửi nếu đơn đã hoàn tất ở kênh khác, khách vừa opt-out, hoặc đã gửi đủ 2 tin nhắc).
  2. *Kiểm tra hàng tồn & Giá sàn máy chủ:* Kiểm tra tồn kho ERP; tính toán mức trợ cấp tối đa $D \le D_{cap}$ trích từ quỹ hoa hồng bán hàng (ECN-001) và khóa giá sàn máy chủ $P \ge P_{floor}$ (ECN-002).
  3. *Soạn thông điệp cá nhân hóa:* SAL-04 soạn thông điệp nhắc giỏ hàng kèm lý do đề xuất (recommendation reason) và liên kết khôi phục trực tiếp phiên giỏ hàng.
  4. *Thực thi gửi tin có Idempotency:* Hệ thống phát thông điệp qua kênh được phép (LINE OA / Web Push) kèm `idempotency_key` duy nhất (TC-E2E-005, BR-005).
  5. *Khách chuyển đổi & Ghi nhận:* Khách bấm liên kết, xác nhận thanh toán/đặt cọc; hệ thống nhận sự kiện `order.confirmed` và đóng chu trình phục hồi.
- **Tiêu chuẩn Đạt / Không đạt (Pass/Fail Criteria) lượng hóa:**
  - **ĐẠT (PASS):**
    - 100% khách hàng nhận tin nhắc đều có trạng thái consent hợp lệ; tỷ lệ vi phạm chính sách gửi tin = 0% (TC-E2E-007).
    - Giá bán cuối cùng của đơn hàng sau trợ cấp đảm bảo tuyệt đối $P \ge P_{floor}$ được kiểm tra tại server (TC-E2E-003).
    - Tỷ lệ trùng lặp thông điệp gửi đi = 0% kể cả khi webhook gửi lại nhiều lần (Zero Duplicate Messaging qua Idempotency Key).
    - Số lượng tin nhắc tối đa không vượt quá 2 tin/giỏ hàng trong khoảng thời gian quy định.
  - **KHÔNG ĐẠT (FAIL):**
    - Gửi tin cho khách hàng đã từ chối nhận tin tiếp thị (Opt-out).
    - Mức giá hoặc voucher áp dụng làm xói mòn biên lãi ròng ($P < P_{floor}$).
    - Phát sinh tin nhắn kép hoặc tạo đơn hàng trùng lặp do lỗi xử lý retry mạng.

#### 3. PILOT-03 — Chăm sóc khách hàng tự động (Customer Care Pilot - Nghiệm thu Gate P1)
- **Mục tiêu nghiệm thu:** Kiểm chứng năng lực tiếp nhận câu hỏi, nhận diện chính xác ý định, xác minh danh tính khách hàng, tra cứu dữ liệu đơn hàng thời gian thực từ ERP và giải quyết yêu cầu với bằng chứng thực tế.
- **Dữ liệu kích hoạt (Trigger Data):**
  - Sự kiện: Khách hàng gửi tin nhắn qua kênh chat (Web Widget hoặc LINE OA): *"Cho tôi kiểm tra tình trạng đơn hàng #ORD-9821 của tôi, đặt hôm qua đã giao chưa?"*
  - Metadata: Kênh tiếp nhận, `conversation_id`, `session_token`, mã định danh người dùng tạm thời.
- **Các bước thực thi tuần tự:**
  1. *Phân tích ý định (Intent Detection):* CS-01 phân tích nội dung, xác định ý định: `order_status_inquiry` (độ tin cậy > 85%).
  2. *Xác minh danh tính khách hàng (Identity Verification):* Hệ thống đối chiếu `session_token` hoặc yêu cầu xác thực OTP / 4 số cuối điện thoại (TC-E2E-004); từ chối hiển thị dữ liệu chi tiết nếu chưa xác minh.
  3. *Gọi Skill tra cứu ERP (ERP Lookup Tool):* CS-01 gọi skill `order.lookup` (AUTH-3) truyền `customer_id` đã xác thực và `order_id` lên hệ thống ERP/WMS.
  4. *Trích xuất bằng chứng (Evidence Fact):* ERP trả về trạng thái: *"Đang vận chuyển - Đối tác: Hsinchu Logistics / 7-Eleven - Mã vận đơn: #TW-8891 - Dự kiến giao: 17:00 ngày mai"*.
  5. *Soạn phản hồi & Gửi khách:* CS-01 định dạng câu trả lời thân thiện, chính xác kèm đầy đủ thông tin mã vận đơn và ngày giao dự kiến.
  6. *Đóng vụ việc & Đo lường:* Ghi nhận Case ID, sinh sự kiện `support.resolved`, ghi vết audit log và chi phí token theo NFR-010.
- **Tiêu chuẩn Đạt / Không đạt (Pass/Fail Criteria) lượng hóa:**
  - **ĐẠT (PASS):**
    - Thời gian phản hồi đầu tiên (FRT) < 2.0 giây (trung vị) và < 3.0 giây (p95).
    - 100% dữ liệu đơn hàng hiển thị thuộc về đúng khách hàng đã xác minh danh tính; cấm tuyệt đối truy cập chéo dữ liệu khách hàng khác (TC-E2E-004, NFR-006).
    - Câu trả lời khớp 100% với dữ liệu từ ERP nguồn (Zero Hallucination).
    - Ghi nhận đầy đủ audit log: Run ID, Customer ID, Tool Call, Raw API Response, Evidence, Latency, Token Cost (NFR-002, NFR-010).
  - **KHÔNG ĐẠT (FAIL):**
    - Tiết lộ thông tin đơn hàng khi chưa xác minh danh tính người gửi yêu cầu.
    - AI tự bịa đặt ngày giao hàng hoặc mã vận đơn khi ERP phản hồi lỗi kết nối (Vi phạm TC-E2E-008).
    - Tỷ lệ ảo giác thông tin trạng thái đơn hàng > 0%.

#### 4. PILOT-04 — Khiếu nại & Chuyển cấp nhân viên (Escalation Pilot - Nghiệm thu Gate P1)
- **Mục tiêu nghiệm thu:** Kiểm chứng khả năng nhận biết giới hạn thẩm quyền (Authority Boundary), xử lý khiếu nại gay gắt và bàn giao trơn tru cho nhân viên con người (Human Takeover) mà không làm mất ngữ cảnh hội thoại.
- **Dữ liệu kích hoạt (Trigger Data):**
  - Sự kiện: Tin nhắn khiếu nại gay gắt từ khách hàng: *"Sản phẩm nhận được bị nứt vỡ! Tôi yêu cầu hoàn tiền toàn bộ ngay lập tức và đền bù thiệt hại, nếu không tôi sẽ khiếu nại lên Hội bảo vệ người tiêu dùng!"*
- **Các bước thực thi tuần tự:**
  1. *Phân loại khiếu nại & Cảm xúc:* CS-01 nhận diện intent: `damage_complaint` và phát hiện yêu cầu hoàn tiền/đền bù; chỉ số cảm xúc phân loại `Sentiment = ANGRY / URGENT`.
  2. *Kiểm tra ranh giới thẩm quyền (Policy Engine):* Hệ thống đối chiếu chính sách: Yêu cầu hoàn tiền và cấp voucher đền bù thuộc cấp độ thẩm quyền AUTH-4 (Cần duyệt) và AUTH-5 (AI cấm tự quyết theo BR-007, ASM-004). AI nhận thức rõ không có thẩm quyền tự giải quyết.
  3. *Tạo vụ việc chuyển cấp (Escalation Case):* CS-01 tự động tạo Service Case với mức ưu tiên cao nhất (`Priority = URGENT`), đính kèm tóm tắt vấn đề, phân tích cảm xúc và bằng chứng liên quan.
  4. *Phản hồi trấn an & Bàn giao:* CS-01 gửi thông điệp đồng cảm, thông báo vụ việc đã được chuyển thẳng tới chuyên viên hỗ trợ cấp cao và giữ kết nối.
  5. *Nhân viên tiếp quản (Human Takeover):* Tín hiệu chuông cảnh báo hiển thị trên Human Command Center SCR-005; chuyên viên CSKH nhấn nút `Accept Takeover`.
  6. *Kế thừa ngữ cảnh Customer360:* Giao diện hiển thị đầy đủ timeline 100% lịch sử hội thoại, hồ sơ khách hàng, chi tiết đơn hàng liên quan; nhân viên tiếp tục xử lý mà không cần hỏi lại khách hàng.
  7. *Kết thúc vụ việc & Trả quyền AI:* Nhân viên chốt phương án bồi thường, ghi nhận kết quả và trả lại quyền trực tự động cho AI.
- **Tiêu chuẩn Đạt / Không đạt (Pass/Fail Criteria) lượng hóa:**
  - **ĐẠT (PASS):**
    - Thời gian chuyển giao từ khi nhận diện khiếu nại đến khi tạo ticket vào hàng đợi nhân viên < 3.0 giây.
    - AI tuyệt đối không đưa ra bất kỳ lời hứa hoàn tiền hoặc mức bồi thường cụ thể nào vượt quyền (Policy Violation Rate = 0%, tuân thủ TC-E2E-006, BR-007).
    - 100% ngữ cảnh hội thoại và dữ liệu Customer360 được kế thừa nguyên vẹn trên màn hình SCR-005 của nhân viên.
    - Quy trình chuyển đổi quyền điều khiển giữa AI và người (Takeover & Release) diễn ra trơn tru, không có hiện tượng trả lời chồng chéo.
  - **KHÔNG ĐẠT (FAIL):**
    - AI tự tiện đồng ý hoàn tiền hoặc phát hành voucher đền bù ngoài thẩm quyền (Lỗi nghiêm trọng cấp độ 1).
    - Phiên hội thoại bị ngắt quãng hoặc treo im lặng khiến khách hàng phải chờ đợi không có phản hồi.
    - Mất ngữ cảnh hội thoại khi bàn giao khiến nhân viên buộc phải yêu cầu khách hàng trình bày lại từ đầu.

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
│ PHASE 1: TAIWAN ANCHOR PILOT (2 NẤC TRIỂN KHAI)│──▶│ PHASE 2: ADAPTER & SAAS     │──▶│ PHASE 3: GLOBAL APP STORE│
│ - Nấc 1 (P1): Care & FAQ (Mobility & FMCG) │   │ - Chuẩn hóa Vertical SaaS   │   │ - Shopify & WooCommerce  │
│ - Nấc 2 (P2): Sales, Cọc & CVS COD         │   │ - Cắm-rút ADPT-GL-001..003  │   │   1-Click App (GTM-002)  │
│ - Đài Loan Adapter (ADPT-TW-001)           │   │ - Đa khách hàng Multi-tenant│   │ - Đòn bẩy dữ liệu GTM-003│
└────────────────────────────────────────────┘   └─────────────────────────────┘   └──────────────────────────┘
TRỤC 2: KINH DOANH & THƯƠNG MẠI (COMMERCIAL TRACK - 3 GIAI ĐOẠN TĂNG TRƯỞNG)
==============================================================================
```

### 5.1. Trục 1 — Kỹ thuật Phần mềm (Engineering Track: 6 Cổng P0–P5 theo SRS)

| Cổng kỹ thuật | Mục tiêu kỹ thuật cốt lõi | Phạm vi công việc thực thi | Tiêu chuẩn ra cổng bắt buộc (Exit Gate) |
|---|---|---|---|
| **P0 — Foundation** (Hạ tầng nền tảng & Hợp đồng dữ liệu) | Chuẩn hóa Canonical Contracts, kiến trúc đa doanh nghiệp (Multi-tenant), phân quyền và kiểm toán. | Thiết lập Canonical contracts cho Customer360, Agent, Skill, Decision, Action, Approval, Evidence, Outcome; dựng Connector Framework, Policy Engine (BR-001..010), Authority Model (AUTH-0..5); phân tách schema đa tenant. | Agent chưa cần thông minh nhất nhưng tuyệt đối không vượt quyền hoặc mất trace. Vượt qua kiểm thử cô lập dữ liệu 2 doanh nghiệp; không lọt lỗi ranh giới bảo mật. |
| **P1 — Customer Care Pilot** (Thí điểm Chăm sóc khách hàng thuần túy) | Kiểm chứng khả năng hội thoại và tra cứu dữ liệu thời gian thực từ System of Record mà không rò rỉ thông tin. | Triển khai CS-01 và CS-02; nhận diện 10 nhóm intent; xác minh danh tính khách hàng; tra cứu đơn hàng ERP/WMS; trả lời FAQ; quy trình chuyển người (PILOT-03, PILOT-04); ghi vết kiểm toán đầy đủ. Module Bán hàng tắt hoàn toàn. | Một hội thoại thật được xử lý E2E và có evidence từ ERP nguồn; nhân viên tiếp quản trơn tru; đạt chuẩn TC-E2E-004 (xác minh danh tính) và TC-E2E-008 (connector trung thực). |
| **P2 — Sales Pilot** (Thí điểm Bán hàng & Bảo toàn giá sàn) | Kiểm chứng chuỗi giá trị: AI tư vấn → Đơn hàng → Doanh thu thật; bảo vệ 100% biên lãi ròng qua máy chủ. | Triển khai 5 Sales Agent (SAL-01..SAL-05); chấm điểm nhu cầu; tra cứu tồn kho/giá ERP; đề xuất cross/upsell; phục hồi giỏ hàng bỏ quên (PILOT-02); máy chủ duyệt giá sàn $P_{floor}$ (ECN-002) và trần giảm giá $D_{cap}$ (ECN-001). | Chứng minh chuỗi: AI action → order → revenue evidence; không đưa giá ngoài nguồn chính thức (TC-E2E-003); chống tạo đơn trùng lặp (TC-E2E-005); kiểm tra giá sàn thành công 100%. |
| **P3 — Marketing Pilot** (Thí điểm Tiếp thị có kiểm duyệt) | Tự động hóa tạo chiến dịch và nội dung tiếp thị dưới sự kiểm duyệt tuyệt đối của con người (Human Approval Gate). | Triển khai 6 Marketing Agent (MKT-01..MKT-06); phân tích cohort/segment; lập kế hoạch chiến dịch; sinh nội dung đa kênh (Facebook, TikTok, Email); cổng duyệt phê duyệt (SCR-003); quy thuộc doanh thu (attribution). | Chiến dịch Marketing chạy E2E có approval 100%; tuyệt đối không tự ý xuất bản nếu thiếu phê duyệt (TC-E2E-002); mô hình quy thuộc doanh thu minh bạch, không suy đoán. |
| **P4 — Cross-domain Orchestration** (Điều phối xuyên miền) | Hợp nhất toàn diện luồng dữ liệu liên miền Marketing → Sales → CSKH → Retention/Success trên cùng Customer360. | Revenue Orchestrator điều phối chu trình 11 bước; đồng bộ trạng thái khách hàng giữa các module; chuyển tiếp lead từ Marketing sang Sales, chuyển đơn hàng sang CSKH, kích hoạt vòng lặp giữ chân và mua lại. | Toàn bộ hành trình khách hàng xuyên suốt 3 Agent duy trì ngữ cảnh Customer360 thống nhất; đạt chuẩn TC-E2E-001 (luồng khép kín) và TC-E2E-009 (truy vết ngược 100%). |
| **P5 — Controlled Autonomy** (Tự chủ có kiểm soát quy mô lớn) | Mở rộng tự động hóa an toàn cho $N$ doanh nghiệp, nâng quyền tự động cho tác vụ an toàn và tối ưu chi phí vận hành. | Hành động rủi ro thấp đủ điều kiện được nâng từ *Recommend* → *Draft* → *Bounded Execute* (AUTH-3); hành động tài chính/rủi ro cao (hoàn tiền, đền bù, đổi giá) bắt buộc giữ Human Approval (AUTH-4); tối ưu chi phí token. | Tỷ lệ vi phạm chính sách bằng 0 (Policy Violation Rate = 0%); chi phí AI đạt định mức mục tiêu 0,5–1 TWD/phiên (ECN-003); hệ thống tự động ngắt khi phát hiện rủi ro (Fail Closed). |

### 5.2. Trục 2 — Kinh doanh & Thương mại: Phân kỳ Gói sản phẩm theo 2 Nấc Triển Khai

Để đảm bảo an toàn tuyệt đối và tính khả thi trong thực tế triển khai mỏ neo tại Đài Loan (Phase 1), hai gói sản phẩm chuyên ngành **GTM-001A (Xe máy điện thông minh)** và **GTM-001B (Hàng tiêu dùng nhanh)** được phân kỳ thành **2 nấc rõ ràng**:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ PHÂN KỲ 2 NẤC GÓI SẢN PHẨM GTM-001A & GTM-001B TẠI THÍ ĐIỂM MỎ NEO ĐÀI LOAN             │
├───────────────────────────────────────────┬────────────────────────────────────────────┤
│ NẤC 1 (TRIỂN KHAI TẠI CỔNG GATE P1)       │ NẤC 2 (TRIỂN KHAI TẠI CỔNG GATE P2)        │
│ CHĂM SÓC KHÁCH HÀNG & FAQ THUẦN TÚY        │ MỞ TOÀN DIỆN BÁN HÀNG, CỌC & CVS COD       │
├───────────────────────────────────────────┼────────────────────────────────────────────┤
│ GTM-001A (Xe điện - Mobility):            │ GTM-001A (Xe điện - Mobility):             │
│ - Tra cứu mạng lưới trạm pin Gogoro/Ionex │ - Tư vấn cấu hình & so sánh thông số O2O   │
│ - FAQ chính sách bảo hành pin & xe        │ - Tính trợ cấp chính phủ theo hộ khẩu      │
│ - FAQ kỹ thuật & bảo dưỡng định kỳ        │ - Đặt lịch lái thử showroom & cọc hoàn lại │
│ - Tra cứu tiến độ giao xe / biển số ERP   │ - Thẩm định trả góp & khóa giá sàn P_floor │
├───────────────────────────────────────────┼────────────────────────────────────────────┤
│ GTM-001B (Hàng tiêu dùng - FMCG):         │ GTM-001B (Hàng tiêu dùng - FMCG):          │
│ - Tra cứu hành trình đơn hàng 7-Eleven CVS│ - Giỏ hàng thông minh & soát giỏ chống thừa│
│ - FAQ chính sách đổi trả hàng tiêu dùng   │ - Giao định kỳ Subscription (定期購)      │
│ - FAQ thành phần & hạn sử dụng sản phẩm   │ - Thanh toán nhận hàng 7-Eleven CVS COD    │
│ - Bàn giao nhân viên khiếu nại hư hỏng    │ - Phục hồi giỏ bỏ quên (PILOT-02) & LINE Pt│
└───────────────────────────────────────────┴────────────────────────────────────────────┘
```

| Giai đoạn thương mại | Trọng tâm thị trường & Sản phẩm | Các thành phần triển khai chi tiết | Điều kiện chuyển tiếp (Milestone Gate) |
|---|---|---|---|
| **Phase 1 — Taiwan Anchor Pilot** (Thí điểm mỏ neo Đài Loan: Phân kỳ 2 nấc) | Kiểm chứng thực chiến bài toán kinh tế và văn hóa tiêu dùng B2C Đài Loan cho 2 ngành: High-Ticket EV Scooter và FMCG. | **Nấc 1 (tại P1):** Triển khai Care & FAQ cho GTM-001A (tra cứu trạm pin, bảo hành, tiến độ giao xe) và GTM-001B (tra cứu đơn hàng CVS, FAQ đổi trả); tích hợp LINE OA và cổng đọc ERP; tắt toàn bộ bán hàng.<br>**Nấc 2 (tại P2):** Mở toàn diện module Bán hàng: GTM-001A (tư vấn showroom, cọc giữ chỗ, trả góp, giá sàn $P_{floor}$) và GTM-001B (giỏ hàng, subscription 定期購, 7-Eleven CVS COD, phục hồi giỏ PILOT-02, LINE Points); tích hợp cổng thanh toán ECPay/LINE Pay. | Đạt được các chỉ số thiết kế giả thuyết đo lường tại [analytics.md](analytics.md) sau khi lấy Baseline (ASM-002): Chuyển đổi, độ trễ phản hồi, chi phí AI 0,5–1 TWD/phiên (ECN-003), bảo toàn 100% biên lãi ròng ($P \ge P_{floor}$). |
| **Phase 2 — Adapter Standardization & Multi-tenant** (Chuẩn hóa Vertical SaaS & Cơ chế Cắm-Rút) | Đóng gói sản phẩm độc lập, tách rời Core Engine và sẵn sàng mở rộng cho $N$ doanh nghiệp đa quốc gia. | Chuẩn hóa cấu trúc gói sản phẩm Vertical SaaS (GTM-001A và GTM-001B); hoàn thiện 3 cổng kết nối cắm-rút toàn cầu: **ADPT-GL-001** (WhatsApp Business API, Telegram, đa ngôn ngữ Web Widget), **ADPT-GL-002** (Stripe, PayPal, Apple Pay, Google Pay, Postal COD), **ADPT-GL-003** (Tuân thủ GDPR Châu Âu, CCPA Mỹ, PDPA Singapore); thiết lập cổng tự phục vụ cấu hình (Self-serve Onboarding). | Hoán đổi thành công giữa ADPT-TW-001 và ADPT-GL-001..003 mà không cần chỉnh sửa Core AI Engine; vượt qua kiểm thử cô lập dữ liệu 100% giữa các tenant doanh nghiệp. |
| **Phase 3 — Global 1-Click App Store Distribution** (Phân phối 1-chạm toàn cầu qua App Store) | Mở rộng quy mô toàn cầu theo mô hình Tăng trưởng dựa trên sản phẩm (Product-Led Growth - PLG) với chi phí thu hút khách hàng (CAC) tối thiểu. | Phát hành ứng dụng cài đặt 1-chạm **GTM-002** trên **Shopify App Store** và **WooCommerce Marketplace**; tự động đồng bộ sản phẩm, tồn kho và đơn hàng qua GraphQL/REST API; xuất bản Case Study và Whitepaper định lượng **GTM-003** đòn bẩy số liệu thực nghiệm Đài Loan làm bằng chứng xã hội (Social Proof) và cam kết ROI để bán cho hàng trăm nghìn nhà bán lẻ quốc tế. | Đạt quy mô tăng trưởng tự chủ toàn cầu; hệ thống vận hành tự động ổn định; doanh thu định kỳ hàng tháng (MRR) tăng trưởng bền vững dựa trên phí nền tảng và mức sử dụng AI. |

### 5.3. Ma trận đồng bộ giữa Trục Kỹ thuật và Trục Thương mại (Track Synchronization)

| Giai đoạn Thương mại | Cổng Kỹ thuật tương ứng | Điều kiện phối hợp hai trục |
|---|---|---|
| **Phase 1: Taiwan Anchor Pilot** | **Gate P0, P1, P2** | P0 cung cấp hạ tầng hợp đồng và kiểm soát giá; **Nấc 1 (tại P1)** kích hoạt CSKH (PILOT-03/04) trên LINE OA và E-Map 7-Eleven; **Nấc 2 (tại P2)** kích hoạt tư vấn bán hàng, đặt cọc giữ chỗ và phục hồi giỏ (PILOT-02) bảo toàn giá sàn $P_{floor}$ để tạo doanh thu thực tế cho đối tác mỏ neo. |
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

### 6.1. Quy trình Handoff 7 bước & Ma trận trách nhiệm RACI (Mục 28 SRS)

Theo Mục 28 của đề bài SRS v0.1, quy trình chuyển giao triển khai kỹ thuật giữa các nhóm chuyên môn được thực thi qua 7 bước chuẩn hóa, kèm Ma trận phân công trách nhiệm RACI (Responsible, Accountable, Consulted, Informed):

| Bước chuyển giao triển khai | Nhóm chịu trách nhiệm (R) | Bên phê duyệt (A) | Bên tham vấn (C) | Bên thông báo (I) |
|---|---|---|---|---|
| 1. Khóa KPI baseline, Connectors & Ngưỡng duyệt (ASM-001..005) | Business Analyst / PO | Head of Commercial | Finance / Tech Lead | Ban Giám Đốc |
| 2. Khóa Canonical Contracts & Data Model 28 thực thể | Solution Architect | Chief Architect | Lead AI / Backend Lead | Toàn bộ dự án |
| 3. Xây dựng Revenue Orchestrator & Agent Runtime | AI Engineering Lead | Solution Architect | Prompt Engineer | QA Team |
| 4. Xây dựng API Gateway, Event Pipeline & Adapters | Backend / DevOps Lead | Technical Director | Security / Data Legal | Frontend Team |
| 5. Phát triển Human Command Center (SCR-001..005) | Frontend Lead | Product Designer | Operations / CS Lead | End Users |
| 6. Xây dựng Acceptance Suite TC-E2E-001..009 & DoD | QA / Test Lead | Quality Director | Security Engineer | Dev Teams |
| 7. Pilot Production-like theo lộ trình P1 ➔ P5 | Cross-functional Squad | Steering Committee | Anchor Client (Đài Loan) | Nhà Đầu Tư |

Chi tiết nội dung thực thi từng bước chuyển giao:
1. **Business Analyst / PO**: Khóa danh sách KPI, cổng kết nối (Connectors), ngưỡng phê duyệt (Approval Thresholds) và phạm vi dữ liệu được phép sử dụng (ASM-001..ASM-005).
2. **Solution Architect**: Khóa Canonical Contracts cho Customer360, Agent, Skill, Decision, Action, Approval, Evidence và Outcome.
3. **AI Engineering**: Xây dựng Revenue Orchestrator, Agent Runtime, Knowledge/Skill Framework và bộ công cụ đánh giá tự động (Evaluation Harness).
4. **Backend / Integration**: Xây dựng API Gateway, Event Ingestion Pipeline, hệ thống Connector cắm-rút và cơ chế thực thi Idempotent chống trùng lặp.
5. **Frontend**: Phát triển Human Command Center gồm Executive Dashboard, Agent Operations, Approval Center, Customer360 Timeline và Conversation Console.
6. **QA / Testing**: Thiết lập bộ Acceptance Test Suite tự động hóa từ TC-E2E-001..TC-E2E-009 kèm các bộ kiểm thử phủ định (Negative / Adversarial Tests).
7. **Triển khai Pilot Production-like**: Vận hành thử nghiệm theo đúng thứ tự cổng Gate: Customer Care (P1) → Sales (P2) → Marketing (P3) → Cross-domain Orchestration (P4) → Controlled Autonomy (P5).
