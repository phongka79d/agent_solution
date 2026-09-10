# AgentOS — Thuật ngữ dùng chung

[Mục lục kế hoạch](README.md) · [Luồng dễ hiểu](plan-easy-read-flow.md)

Đây là nghĩa của các từ kỹ thuật trong các tài liệu `plans/`. Nếu một tài liệu dùng từ theo nghĩa khác, tài liệu đó phải ghi rõ.

| Thuật ngữ | Nghĩa dễ hiểu | Ví dụ trong kế hoạch |
|---|---|---|
| **Module** | Một phần chức năng có thể bật hoặc tắt riêng | Marketing, Sales, Customer Support |
| **Agent** | Trợ lý AI chuyên làm một nhóm công việc | Marketing Agent hỏi thông tin lead; Sales Agent tư vấn |
| **Core platform** | Phần nền tảng dùng chung cho các module | Điều phối, Customer360, quy trình, quyền và ghi log |
| **API** | Cách hai phần mềm gửi yêu cầu và nhận kết quả có cấu trúc | Website của công ty gửi câu hỏi đến Sales Module |
| **Connector / adapter** | Bộ chuyển đổi để AgentOS nói đúng cách với một ứng dụng cụ thể | Kết nối CRM A, lịch hẹn B hoặc catalog C |
| **Webhook / event** | Thông báo do hệ thống công ty gửi sang AgentOS khi có việc xảy ra | Có lead mới, đơn hàng đã xác nhận |
| **Callback** | Thông báo AgentOS gửi ngược về hệ thống công ty khi task đổi trạng thái | Báo task đã hoàn thành hoặc đang chờ người |
| **Correlation ID** | Mã dùng để nối các yêu cầu, sự kiện, task và log thuộc cùng một việc | Tra từ câu hỏi của khách đến kết quả ghi vào CRM |
| **Effect key** | Mã cố định cho một hành động bên ngoài, giúp thử lại mà không làm hai lần | Không tạo hai cuộc hẹn khi request bị gửi lại |
| **Retry / reconciliation** | Thử lại lỗi tạm thời; reconciliation là kiểm tra hệ thống gốc trước khi thử lại hành động có thể đã xảy ra | Timeout khi ghi CRM thì tra CRM trước khi ghi lần nữa |
| **Provider-confirmed** | Ứng dụng gốc đã trả về mã hoặc trạng thái xác nhận | Có booking ID thật, không chỉ HTTP 202 |
| **Allowlist** | Danh sách hành động được phép; ngoài danh sách thì bị từ chối | MVP chỉ cho đọc catalog và cập nhật vài trường CRM |
| **Event** | Bản ghi “một việc đã xảy ra” do hệ thống gửi sang | Lead form đã gửi, đơn hàng đã xác nhận |
| **Worker** | Tiến trình chạy ngầm xử lý task, timer hoặc retry sau khi API đã nhận việc | Gửi follow-up sau 24 giờ |
| **CRM** | Phần mềm doanh nghiệp dùng để quản lý khách và cơ hội bán hàng | Lưu lead, người phụ trách, giai đoạn bán |
| **Lead** | Người hoặc công ty đã để lại dấu hiệu quan tâm nhưng chưa chắc mua | Khách điền form sau khi bấm quảng cáo |
| **Lead qualification** | Kiểm tra lead có phù hợp và sẵn sàng trao đổi mua hàng không | Hỏi nhu cầu, ngân sách, người quyết định, thời điểm |
| **SQL (Sales-qualified lead)** | Lead đã đạt điều kiện để Sales tiếp nhận | Đủ thông tin tối thiểu và có ý định mua rõ hơn |
| **Opportunity** | Một cơ hội bán hàng đang được theo dõi | Công ty A đang cân nhắc gói cho 30 người dùng |
| **Customer360** | Bản tổng hợp thông tin được phép xem về một khách | Lịch sử trao đổi, nguồn lead, cơ hội, vụ hỗ trợ |
| **Knowledge base (KB)** | Kho tài liệu đã được duyệt để Agent tra cứu | FAQ, hướng dẫn sử dụng, chính sách |
| **RAG / grounded answer** | Cách trả lời dựa trên tài liệu/dữ liệu đã tra được, không tự đoán | Support trích hướng dẫn đúng phiên bản |
| **Workflow** | Chuỗi bước có điều kiện, thời gian và người chịu trách nhiệm | Chờ 24 giờ, kiểm tra khách đã trả lời chưa, rồi mới nhắc |
| **Handoff** | Bàn giao một cuộc trao đổi từ module này sang module khác hoặc sang người | Marketing chuyển lead đủ điều kiện cho Sales |
| **Human-in-the-loop** | Có người duyệt hoặc tiếp quản ở bước rủi ro | Duyệt giảm giá, hoàn tiền, hủy dịch vụ |
| **Source of truth** | Hệ thống được công nhận là nơi giữ giá trị chính xác nhất | CRM giữ cơ hội; hệ thống thanh toán giữ trạng thái trả tiền |
| **Tenant** | Một doanh nghiệp độc lập trong hệ thống dùng chung | Dữ liệu tenant A không được nhìn thấy ở tenant B |
| **Idempotency** | Gửi lại cùng một yêu cầu không tạo thêm hành động lần hai | Webhook gửi trùng vẫn chỉ tạo một lead |
| **Task** | Một công việc AgentOS nhận và xử lý, có trạng thái rõ ràng | `accepted`, `running`, `waiting`, `awaiting_human`, `completed`, `stopped`, `failed` |
| **Task version** | Số thứ tự của trạng thái task; số cũ hơn không được ghi đè trạng thái mới | Callback version 3 không thể làm task quay về version 2 |
| **Configuration version** | Phiên bản bộ quy tắc/cài đặt của một doanh nghiệp | Biết task đã dùng ngưỡng điểm và câu hỏi nào |
| **Source version** | Phiên bản tài liệu hoặc dữ liệu gốc đã được đọc | Biết câu trả lời dựa trên bảng giá/catalog nào |
| **MVP** | Bản nhỏ nhất đủ để chạy thử và đo giá trị | Sales + Support cơ bản, một CRM, một lịch hẹn |
| **SLA** | Cam kết thời gian xử lý hoặc phản hồi | Ticket ưu tiên cao phải được người nhận trong thời gian quy định |
| **CSAT** | Điểm khách đánh giá sau khi được hỗ trợ | Câu hỏi “Bạn có hài lòng với cách xử lý không?” |

## Cách đọc flow

1. **Mũi tên** là thứ tự xử lý; không có nghĩa mọi bước đều chạy trong cùng một giây.
2. **Ô quyết định** là nơi hệ thống kiểm tra điều kiện. Nhánh “No” phải có kết quả rõ ràng: hỏi thêm, dừng, hoặc chuyển người.
3. **Module disabled** nghĩa là công ty chưa bật module đó; hệ thống không được tự bật hoặc giả vờ đã xử lý.
4. **Provider-confirmed** nghĩa là ứng dụng gốc đã trả về mã/kết quả xác nhận. `202 Accepted` chỉ có nghĩa là đã nhận việc, chưa có nghĩa là đặt lịch, bán hàng hoặc giải quyết xong.
5. **Handoff** luôn mang theo mã khách, mã cuộc trao đổi, tóm tắt, thông tin đã xác minh, việc đã thử và bước tiếp theo.
