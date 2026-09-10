# Thuật ngữ dùng chung

[Mục lục](README.md) · [Bản dễ hiểu](plan-easy-read-flow.md)

Dùng từ tiếng Việt trong diễn giải. Giữ tên viết tắt, tên riêng và mã máy khi cần tra cứu hoặc tương thích kỹ thuật.

## 1. Sản phẩm và kinh doanh

| Thuật ngữ | Nghĩa trong kế hoạch |
|---|---|
| Mô-đun (module) | Một phần chức năng bật/tắt riêng: Tiếp thị, Bán hàng hoặc Chăm sóc khách hàng |
| Trợ lý AI (agent) | Thành phần hiểu yêu cầu và đề xuất hành động trong quyền đã cấp |
| AI / mô hình ngôn ngữ lớn (LLM) | Trí tuệ nhân tạo / loại mô hình hỗ trợ hiểu và tạo văn bản; không tự có quyền nghiệp vụ |
| Lõi dùng chung (core) | Điều phối, dữ liệu, quy trình, kiến thức, kết nối, quyền và đo lường |
| Tiếp thị (marketing) | Nghiên cứu, định vị, phân phối, thu hút và chăm sóc khách quan tâm; không chỉ quảng cáo |
| Bán hàng (sales) | Tư vấn và hỗ trợ khách tiến tới kết quả thương mại phù hợp |
| Chăm sóc khách hàng (customer support) | Hướng dẫn, giải quyết vấn đề và bàn giao khi cần |
| B2C | Doanh nghiệp bán cho người tiêu dùng |
| B2B | Doanh nghiệp bán cho doanh nghiệp |
| B2B2C | Doanh nghiệp tiếp cận người tiêu dùng thông qua tổ chức/đối tác |
| Tín hiệu trước nhu cầu (upstream/intent signal) | Dấu hiệu có thể xuất hiện trước nhu cầu mua; là bằng chứng nghiên cứu, không tự cho quyền liên hệ |
| Điểm tập trung khách hàng (customer cluster) | Nhóm, địa điểm hoặc tổ chức có khách gặp nhu cầu tương tự |
| Vấn đề của khách (pain point) | Điều gây mất thời gian, chi phí, bất tiện hoặc cản kết quả mong muốn |
| Đề nghị giá trị (value proposition) | Giải pháp mang lợi ích gì, cho ai và có bằng chứng nào |
| Điểm khác biệt (USP) | Lý do có giá trị để chọn giải pháp, phải kiểm chứng thay vì tự nhận độc nhất |
| Khách quan tâm (lead) | Người/tổ chức có yêu cầu hoặc thể hiện quan tâm; chưa chắc sẽ mua |
| Kiểm tra điều kiện (qualification) | Làm rõ nhu cầu và mức phù hợp để chọn bước tiếp theo |
| Khách đủ điều kiện bán hàng (SQL) | Khách được Bán hàng xác nhận đủ điều kiện theo hành trình; không chỉ đạt điểm cao |
| Cơ hội (opportunity) | Việc bán có thể xảy ra đang được theo dõi, không phải doanh thu |
| CRM | Phần mềm quản lý khách, cơ hội, người phụ trách và lịch sử |
| Chăm sóc trước mua (nurture) | Liên hệ hữu ích khi khách chưa sẵn sàng, chỉ khi đủ điều kiện |
| Ghi nhận nguồn (attribution) | Gắn kết quả với nguồn/đối tác/chiến dịch theo quy tắc; không chứng minh tác động nhân quả |
| Mua lại / giới thiệu | Khách mua lần sau / tự nguyện giới thiệu người khác |
| Mua bổ sung / nâng cấp (cross-sell / upsell) | Mua sản phẩm liên quan / chuyển lựa chọn cao hơn khi phù hợp |
| Phiếu mua hàng (voucher) | Quyền hưởng ưu đãi theo điều kiện; có chi phí, không mặc nhiên tương đương tiền hoàn |
| Bản đầu tối thiểu (MVP) | Phạm vi nhỏ đủ chạy thử và kiểm chứng, gọi là P1 trong lộ trình |
| Đường cơ sở (baseline) | Số liệu trước thử hoặc nhóm so sánh được chốt để đánh giá thay đổi |
| Nhóm quan sát (cohort) | Nhóm khách/phiên/đơn cùng tiêu chí và thời điểm để theo dõi kết quả |

## 2. Dữ liệu và kỹ thuật

| Thuật ngữ | Nghĩa trong kế hoạch |
|---|---|
| Customer360 | Hồ sơ liên kết thông tin được phép của khách qua các mô-đun, không thay hệ thống gốc |
| Doanh nghiệp tách biệt (tenant) | Một tổ chức có dữ liệu, quyền và cấu hình riêng trong hệ thống dùng chung |
| Nguồn xác nhận gốc (source of truth) | Hệ thống được thỏa thuận giữ giá trị chính thức cho một loại dữ liệu |
| API | Cách phần mềm gửi yêu cầu/nhận dữ liệu có cấu trúc |
| Bộ kết nối (connector/adapter) | Phần ánh xạ và gọi API của một nhà cung cấp theo quyền được cấp |
| Bộ mã tích hợp (SDK) | Mã giúp nhúng/kết nối giao diện, không phải toàn bộ AI hoặc máy chủ |
| Sự kiện (event) | Bản ghi một việc đã xảy ra, có nguồn và mã bất biến |
| Thông báo sự kiện (webhook) | Cách hệ thống gửi sự kiện sang bên khác, chưa chứng minh mọi việc sau đó đã xong |
| Thông báo kết quả (callback) | Thông báo AgentOS gửi về máy chủ doanh nghiệp khi công việc đổi trạng thái |
| Công việc (task) | Một yêu cầu được AgentOS nhận và theo dõi |
| Quy trình (workflow) | Chuỗi bước có điều kiện, thời gian và trách nhiệm được lưu bền vững |
| Lần chạy (run) | Một lần thực hiện cụ thể của quy trình |
| Tiến trình nền (worker) | Thành phần tiếp tục xử lý công việc/lịch chờ sau khi API đã trả lời |
| Bộ hẹn giờ (timer) | Thời điểm đánh thức bước đang chờ; không tự cấp quyền gửi |
| Bàn giao (handoff) | Chuyển trách nhiệm, cần bên nhận chấp nhận; không chỉ gửi thông báo |
| Người duyệt/tiếp quản (human-in-the-loop) | Nhân viên quyết định hành động hoặc nhận xử lý ở bước cần người |
| Kho kiến thức (KB) | Tài liệu/hướng dẫn đã được duyệt theo quyền và phiên bản |
| Câu hỏi thường gặp (FAQ) | Bộ câu hỏi và câu trả lời phổ biến đã được duyệt |
| Trả lời dựa truy xuất (RAG) | Tìm nguồn phù hợp trước khi trả lời; không bảo đảm đúng nếu nguồn/quyền sai |
| Thẻ bằng chứng | Nguồn, phiên bản, thời điểm, điều kiện và giới hạn hỗ trợ một phát biểu |
| Học máy (ML) | Mô hình học từ dữ liệu để dự đoán; không bắt buộc cho quy tắc nghiệp vụ hoặc nghiên cứu ban đầu |
| Đồng ý nhận tin (opt-in) | Sự cho phép theo mục đích/kênh, có bằng chứng và có thể rút lại |
| Ngừng nhận tin (opt-out) | Yêu cầu dừng liên hệ tương ứng, phải kiểm tra trước lần gửi |
| Chống xử lý trùng (idempotency) | Gửi lại cùng một yêu cầu không tạo tác động lần hai |
| Mã tác động (effect_key) | Khóa cố định của một hành động bên ngoài khi thử lại/đối soát |
| Mã truy vết (correlation_id) | Nối yêu cầu, sự kiện, công việc, hành động và nhật ký |
| Phiên bản công việc (task_version) | Số tăng dần của trạng thái; thông báo cũ không ghi đè mới |
| Phiên bản cấu hình / nguồn | Phiên bản quy tắc đã dùng / dữ liệu hoặc tài liệu được đọc |
| Thử lại / đối soát (retry / reconciliation) | Thử lỗi tạm thời / kiểm tra tác động ở nguồn trước khi lặp ghi chưa rõ |
| Danh sách cho phép (allowlist) | Hành động/trường được phép; ngoài danh sách thì từ chối |
| Xác nhận từ nguồn (provider-confirmed) | Hệ thống gốc có kết quả/mã xác nhận nghiệp vụ, không chỉ mã HTTP |
| HMAC | Mã xác thực thông điệp bằng khóa bí mật; không mặc nhiên là chữ ký ngân hàng hoặc bảo mật tuyệt đối |
| Mã dùng một lần (OTP) | Mã xác thực giao dịch/tài khoản; trợ lý không yêu cầu thu thập hoặc lưu |
| Thời hạn hiệu lực (TTL) | Khoảng một dữ liệu/báo giá còn hiệu lực; khác thời điểm tiền thực tế đến |
| VietQR | Mã QR phục vụ thanh toán/chuyển tiền theo dịch vụ được tích hợp; tạo mã chưa có nghĩa nhận tiền |
| Liên kết mở ứng dụng (deeplink) | Liên kết gọi ứng dụng trên thiết bị nếu được hỗ trợ; cần phương án thay thế |
| Lưu tại trình duyệt (LocalStorage) | Bộ nhớ trên thiết bị, không là nguồn xác minh danh tính hay kho bí mật |
| SLA | Cam kết thời gian dịch vụ được thỏa thuận với điều kiện nguồn lực cụ thể |

## 3. Kinh tế và chỉ số

| Từ viết tắt/khái niệm | Nghĩa |
|---|---|
| Lãi đóng góp | Doanh thu theo cơ sở đã chốt trừ chi phí biến đổi/phục vụ được tính; chưa phải lợi nhuận ròng |
| Giá sàn | Mức thấp nhất máy chủ chấp nhận sau khi xét chi phí, lãi tối thiểu và hạn ưu đãi |
| Biên trên doanh thu / cộng trên giá vốn | Hai cơ sở tính khác nhau, không dùng thay nhau |
| CAC / CPL | Chi phí thu hút một khách mua / một khách quan tâm theo phạm vi chốt |
| LTV | Giá trị khách trong thời gian; dự báo phải ghi là ước tính |
| AOV | Giá trị đơn trung bình theo chính sách ghi nhận |
| ROAS | Doanh thu quy thuộc trên chi quảng cáo; không phải lãi |
| CSAT | Mức hài lòng do khách trả lời đánh giá, cần công bố tỷ lệ phản hồi |
| Thử nghiệm đối chứng | So các nhóm phù hợp để đánh giá thay đổi; liên quan không đồng nghĩa nguyên nhân |

Công thức, mẫu số và ngoại lệ chính thức nằm ở [đo lường](delivery/analytics.md).

## 4. Đọc trạng thái đúng

| Mã | Hiểu đúng |
|---|---|
| `accepted` / `queued` | Đã nhận qua API / xếp hàng trong quy trình |
| `running` | Đang xử lý |
| `waiting` | Chờ thời điểm/sự kiện |
| `awaiting_human` | Chờ người, chưa hoàn tất |
| `completed` | Kết quả yêu cầu được kiểm chứng; có thể chỉ là câu trả lời |
| `stopped` | Đã dừng theo điều kiện, không tự chạy lại |
| `failed` | Chưa xác lập được kết quả tổng thể; xem trạng thái từng hành động |
| `confirmed` / `rejected` / `uncertain` | Tác động được nguồn xác nhận / từ chối / chưa rõ |

Không gộp “đơn đã tạo”, “đã thanh toán”, “đã giao”, “đã giải quyết” thành “thành công” chung. Mỗi loại cần nguồn và bằng chứng riêng.
