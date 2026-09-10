# AgentOS Customer360 — Kế hoạch hợp nhất

Đọc [bản tổng quan dễ hiểu](plan-easy-read-flow.md) trước, khoảng 5 phút. Muốn bắt đầu triển khai, mở [phạm vi bản đầu và điều kiện nghiệm thu](delivery/mvp-and-roadmap.md).

Cập nhật: 10/09/2026. Trạng thái: **đề xuất thiết kế, chưa triển khai và chưa được kiểm chứng bằng thử nghiệm thực tế**. Việc nguồn PDF ghi “đã phê duyệt ý niệm” không có nghĩa bộ kế hoạch hợp nhất hoặc các tính năng đã được nghiệm thu.

## 1. Định hướng thống nhất

Xây bộ trợ lý AI giúp doanh nghiệp **hiểu nhu cầu sớm → tư vấn đúng giải pháp → hỗ trợ mua thuận tiện → chăm sóc sau mua → tạo mua lại và giới thiệu**. Khách có thể đến từ tìm kiếm, quảng cáo, đối tác, khách cũ hoặc trực tiếp; quảng cáo không phải điểm khởi đầu duy nhất.

Giữ ba mô-đun có thể bật riêng:

| Mô-đun | Phạm vi hợp nhất | Kết quả cần đo |
|---|---|---|
| Tiếp thị | Nghiên cứu thị trường, tín hiệu trước nhu cầu, định vị, đối tác, tiếp nhận và chăm sóc khách quan tâm | Nhu cầu được kiểm chứng, khách phù hợp, chi phí thu hút |
| Bán hàng | Hỏi nhu cầu, đề xuất có bằng chứng, giải thích sản phẩm, hỗ trợ mua; ưu đãi có kiểm soát ở giai đoạn sau | Chuyển đổi và lãi đóng góp, không chỉ số đơn |
| Chăm sóc khách hàng | Hướng dẫn, xử lý vấn đề, chuyển nhân viên, ghi nhận nhu cầu mua lại | Giải quyết có xác nhận, hài lòng và mua lại |

Nghiên cứu thị trường là năng lực của Tiếp thị, không phải mô-đun thứ tư. Giữ chân và phát triển đối tác là quy trình liên quan đến ba mô-đun, không đòi thêm sản phẩm độc lập.

Lõi dùng chung gồm điều phối, hồ sơ khách hàng hợp nhất Customer360, kho kiến thức, quy trình, kết nối API, kiểm soát quyền, nhật ký và đo lường. Doanh nghiệp giữ ứng dụng và dữ liệu gốc; dùng chung phần mềm không đồng nghĩa dùng chung dữ liệu khách hàng.

## 2. Đọc theo nhu cầu

1. Người phụ trách kinh doanh: [bản dễ hiểu](plan-easy-read-flow.md) → [sản phẩm và cách đóng gói](product-and-packaging.md).
2. Người thiết kế nghiệp vụ: [hành trình khách hàng](customer-lifecycle.md) → mô-đun liên quan.
3. Nhóm kỹ thuật: [kiến trúc](platform/architecture.md) → [dữ liệu](platform/data-and-knowledge.md) → [API](platform/api-and-integrations.md) → [nghiệm thu](delivery/mvp-and-roadmap.md).
4. Người ra quyết định đầu tư: [đo lường và kinh tế đơn hàng](delivery/analytics.md) → [thứ tự thử nghiệm](delivery/mvp-and-roadmap.md).
5. Tra từ viết tắt: [bảng thuật ngữ](glossary.md).

## 3. Nơi chịu trách nhiệm cho từng nội dung

| Tài liệu | Nội dung chính | Mốc tham chiếu cũ được giữ |
|---|---|---|
| [Sản phẩm và cách đóng gói](product-and-packaging.md) | Khách hàng mục tiêu, giá trị, bộ cấu hình, mô hình thương mại, danh mục ý tưởng | 1, 2, 17, 19 |
| [Hành trình khách hàng](customer-lifecycle.md) | Từ tín hiệu sớm đến mua lại; tình huống B2C và bán hàng cần tư vấn | 3, 4, 9 |
| [Tiếp thị](modules/marketing.md) | Nghiên cứu, định vị, đối tác, tiếp nhận, chấm điểm và chăm sóc | 6 |
| [Bán hàng](modules/sales.md) | Tư vấn, bằng chứng, giỏ hàng, ưu đãi và kiểm soát giá | 7 |
| [Chăm sóc khách hàng](modules/customer-support.md) | Tra cứu, xử lý sự cố, bàn giao, bảo vệ giá và phản hồi | 8 |
| [Kiến trúc](platform/architecture.md) | Ranh giới hệ thống, điều phối nghiệp vụ và giao diện nhúng | 5, 10 |
| [Dữ liệu và kiến thức](platform/data-and-knowledge.md) | Danh tính, đồng ý liên hệ, nguồn gốc bằng chứng, danh mục sản phẩm | 11, 12, 18 |
| [Quy trình và bàn giao](platform/workflows-and-handoffs.md) | Trạng thái bền vững, nhắc lại, người duyệt, dừng và phục hồi | 13, 14 |
| [API và tích hợp](platform/api-and-integrations.md) | Hợp đồng kết nối, thanh toán, bảo mật và vận hành | 15, 16 |
| [Đo lường](delivery/analytics.md) | Chỉ số, công thức kinh tế, thử nghiệm đối chứng và chất lượng dữ liệu | 20 |
| [Bản đầu và lộ trình](delivery/mvp-and-roadmap.md) | Phạm vi bật/tắt, gói công việc, nghiệm thu và điều kiện mở rộng | 21, 22, 23 |

Mỗi quy định có một nơi chịu trách nhiệm; tài liệu khác chỉ tóm tắt và liên kết. Giữ đường dẫn tệp và các mốc `section-N` để hạn chế làm hỏng tham chiếu cũ. Tên tệp, tên sản phẩm, API và mã trạng thái giữ nguyên khi cần tương thích; toàn bộ phần diễn giải được viết bằng tiếng Việt.

## 4. Đã hợp nhất ba nguồn như thế nào?

| Nguồn | Ý được giữ | Cách điều chỉnh |
|---|---|---|
| Bộ `plans/` trước lần hợp nhất này | Ba mô-đun độc lập; API hai chiều; dữ liệu riêng từng doanh nghiệp; người duyệt; chống xử lý trùng; xác nhận từ hệ thống gốc | Gộp phần lặp, dịch phần tiếng Anh, giữ ràng buộc kỹ thuật và tiêu chí kiểm chứng |
| [Báo cáo PDF](../BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf), trang 1–2 | Giảm thao tác, giảm bị làm phiền, tư vấn theo nhu cầu, tạo niềm tin | Dùng ba nhóm động cơ mua làm giả thuyết nghiên cứu; không coi tuổi hay tỷ lệ trong báo cáo là dữ liệu khảo sát |
| PDF, trang 2–4 | Ưu đãi từ chi phí thực sự tiết kiệm; máy chủ kiểm soát giá sàn | Bổ sung chi phí AI, đối tác, vận hành và rủi ro; không cam kết lợi nhuận hay an toàn tuyệt đối |
| PDF, trang 4–5 | Giải thích thông số dễ hiểu; so sánh nâng cấp; phiếu bù giá; chọn nhanh; lưu món; theo dõi đơn | Phân kỳ theo độ rủi ro, yêu cầu bằng chứng và dữ liệu kết nối |
| PDF, trang 5–6 | Giao diện nhúng nhẹ; điều phối hiển thị; đồng ý nhận tin; QR; chuyển nhân viên | Bộ giao diện là tùy chọn, không thay lõi máy chủ; không hứa mọi ngân hàng mở được, phí bằng 0 hoặc thanh toán trong 3 giây |
| PDF, kết luận trang 6 | Soát giỏ hàng, can ngăn mua đắt, xem video mở hộp | Hai ý đầu là thử nghiệm tư vấn; video chỉ xem xét sau, không tự quyết đổi trả |
| [Tài liệu nghiên cứu thị trường](../AGENT_NGIEN_CUU_THI_TRUONG.md), mục I–XXI | Nhu cầu thật, tín hiệu sớm, nơi tập trung khách, giải pháp, thời điểm và lợi thế có bằng chứng | Đưa thành phiếu cơ hội có nguồn, giả thuyết, phép thử và tiêu chí dừng |
| Tài liệu thị trường, mục XXII–XXVIII | Bốn vai trò Tiếp thị; đối tác; mua lại; giới thiệu | Bốn vai trò nghiệp vụ trong một mô-đun; thử thủ công trước khi tự động hóa |

### Những thay đổi có chủ ý so với kế hoạch cũ

1. **Trọng tâm thử nghiệm đề xuất là B2C trên website hiện có**, phù hợp PDF. SIM/thẻ, hàng tiêu dùng, vận chuyển và xe điện là các ứng viên nghiên cứu, chưa phải ngành đã chọn. Không triển khai tất cả cùng lúc.
2. **Giữ Bán hàng trước, kèm Chăm sóc cơ bản**, nhưng đưa nghiên cứu thị trường thủ công lên giai đoạn chuẩn bị; chưa bật tự động Tiếp thị trong bản đầu.
3. **Lịch hẹn và LINE không còn bắt buộc với mọi dự án.** B2C dùng một nguồn sản phẩm và hệ thống lưu khách/yêu cầu hiện có; chỉ thêm lịch cho hành trình cần đặt hẹn. Chọn kênh bổ sung theo doanh nghiệp, không tự thay LINE bằng Zalo.
4. **Thanh toán tự động, mặc cả và phiếu bù giá không vào bản đầu.** Khách mua qua quy trình hiện tại; các tính năng này có điều kiện kiểm chứng riêng.
5. **Giữ phương án bán hàng B2B cần tư vấn** như cấu hình thay thế: nhu cầu, ngân sách, người quyết định, thời điểm, lịch hẹn và báo giá. Không ép bộ câu hỏi B2B lên người mua lẻ.
6. **Không dùng lại các kết luận tuyệt đối của PDF.** “Độc bản”, “100% lợi nhuận”, “100% chống hack”, “phiếu mua hàng không tốn tiền” đều chưa có bằng chứng để khẳng định.
7. **Không coi dẫn chiếu pháp lý cũ là chứng nhận tuân thủ.** Phần [API và bảo vệ dữ liệu](platform/api-and-integrations.md#section-16) bổ sung nguồn chính thức và bước rà soát trước vận hành.
8. Bỏ liên kết Atlas khỏi mục lục này vì không có tệp `atlas/index.html` trong thư mục làm việc đã kiểm tra. Không sửa hay xóa tài liệu ngoài `plans/`.

## 5. Cách cập nhật về sau

1. Đổi phạm vi tại [bản đầu và lộ trình](delivery/mvp-and-roadmap.md), ghi lý do và người duyệt.
2. Đổi quy định tại tài liệu chịu trách nhiệm; đối chiếu dữ liệu, quyền, API và chỉ số liên quan.
3. Chạy lại bộ tình huống kiểm thử sau thay đổi cấu hình, lời hướng dẫn AI, kiến thức hoặc kết nối.
4. Cập nhật bản dễ hiểu sau cùng; không dùng nó để thay thế điều kiện bảo mật và nghiệm thu.

**Việc tiếp theo:** điền tên một doanh nghiệp và website dự kiến thử nghiệm vào [phiếu chốt đầu vào](delivery/mvp-and-roadmap.md#pilot-inputs).
