# AgentOS Customer360 — Mục lục kế hoạch

Đọc [luồng dễ hiểu bằng tiếng Việt](plan-easy-read-flow.md) trước nếu bạn muốn nắm ý chính trong khoảng 5 phút.

Tra nghĩa các từ như **module**, **API**, **lead**, **Customer360**, **workflow** và **handoff** trong [bảng thuật ngữ dùng chung](glossary.md).

Sản phẩm gồm ba module Marketing, Sales và Customer Support. Doanh nghiệp chọn module cần dùng, kết nối vào ứng dụng và dữ liệu hiện tại qua API. Phần lõi được dùng lại; dữ liệu, quyền truy cập và cấu hình của từng doanh nghiệp được tách riêng.

Trạng thái: thiết kế đề xuất, chưa phải tính năng đã triển khai. Ví dụ, giá và chỉ tiêu cần được xác nhận với doanh nghiệp thử nghiệm.

## Đọc theo nhu cầu

1. **Người không chuyên kỹ thuật:** đọc [bản dễ hiểu](plan-easy-read-flow.md).
2. **Product / Business:** đọc [sản phẩm và cách đóng gói](product-and-packaging.md), rồi [luồng khách hàng và tình huống](customer-lifecycle.md).
3. **Engineering:** bắt đầu từ [kiến trúc](platform/architecture.md), [dữ liệu](platform/data-and-knowledge.md), [API](platform/api-and-integrations.md), rồi xem module cần làm và [MVP](delivery/mvp-and-roadmap.md).
4. **Tra thuật ngữ:** mở [glossary.md](glossary.md) bất cứ lúc nào.

## Tài liệu chi tiết

Các mục 1–23 của PLAN.md trước đây đã được chuyển vào các tài liệu dưới đây, không bỏ phần nào. Cột cuối giúp tìm lại nội dung cũ; mỗi tài liệu có thêm chi tiết thực hiện và kiểm chứng trong phạm vi kế hoạch.

**Nguồn của flow:** [Customer lifecycle](customer-lifecycle.md) là luồng kinh doanh chính; ba tài liệu trong `modules/` là luồng chi tiết từng module; `platform/` là luồng điều phối, dữ liệu, API và xử lý lỗi. Khi hai flow có vẻ khác nhau, ưu tiên điều kiện bật/tắt module, quyền dữ liệu và xác nhận từ hệ thống doanh nghiệp.

| Tài liệu | Nội dung chính | Mục từ bản cũ |
|---|---|---|
| [Product and packaging](product-and-packaging.md) | Bài toán, ba module, phần dùng chung, cấu hình, cách bán và triển khai | 1, 2, 17, 19 |
| [Customer lifecycle](customer-lifecycle.md) | Luồng khách, sáu tình huống, bàn giao giữa các module | 3, 4, 9 |
| [Marketing](modules/marketing.md) | Tiếp nhận khách từ quảng cáo/form, phân loại, chăm sóc và chuyển Sales | 6 |
| [Sales](modules/sales.md) | Tìm hiểu nhu cầu, tra sản phẩm/giá, đặt lịch, theo dõi bán hàng | 7 |
| [Customer Support](modules/customer-support.md) | Hỏi đáp, xử lý sự cố, chuyển nhân viên và ghi nhận nhu cầu mới | 8 |
| [Architecture](platform/architecture.md) | Điều phối module, ranh giới hệ thống và xử lý yêu cầu | 5, 10 |
| [Data and knowledge](platform/data-and-knowledge.md) | Customer360, dữ liệu gốc, nội dung được duyệt và danh mục sản phẩm | 11, 12, 18 |
| [Workflows and handoffs](platform/workflows-and-handoffs.md) | Quy trình, nhắc lại, phê duyệt, bàn giao và dừng tự động | 13, 14 |
| [API and integrations](platform/api-and-integrations.md) | API hai chiều, thông báo sự kiện, bảo mật và xử lý lỗi kết nối | 15, 16 |
| [Analytics](delivery/analytics.md) | Chỉ số, nguồn dữ liệu và cách đo kết quả | 20 |
| [MVP and roadmap](delivery/mvp-and-roadmap.md) | Phạm vi bản đầu, công việc, kiểm thử, điều kiện chạy thử và các giai đoạn sau | 21, 22, 23 |

## Cách duy trì tài liệu

1. Sửa quy định tại tài liệu chịu trách nhiệm cho quy định đó; dùng link để tham chiếu từ tài liệu khác.
2. Khi đổi cách kết nối, đối chiếu API, dữ liệu, module liên quan và tiêu chí MVP.
3. Khi đổi luồng kinh doanh, cập nhật thêm bản dễ hiểu. Bản dễ hiểu là bản tóm tắt, không thay thế các điều kiện bảo mật và phê duyệt trong tài liệu chi tiết.

Giữ `PLAN.md` ở thư mục gốc làm trang dẫn đường cho các link cũ. Các mốc `section-N` trong tài liệu là điểm tham chiếu ổn định từ 23 mục ban đầu.

## Website Atlas

[Atlas hiện có](../atlas/index.html) vẫn dùng được để xem các sơ đồ trước đây. Nó chưa được tạo lại theo thiết kế API/module và cấu trúc tài liệu mới; không dùng nó để suy ra API đã hoạt động. Các tài liệu trong `plans/` là nguồn kế hoạch hiện tại.

## Quyết định tiếp theo

Chọn ứng dụng của doanh nghiệp thử nghiệm để kết nối trước. Danh sách thông tin cần chốt nằm trong [MVP và lộ trình](delivery/mvp-and-roadmap.md).
