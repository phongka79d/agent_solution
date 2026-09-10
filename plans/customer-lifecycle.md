# Hành trình khách hàng và các tình huống nghiệp vụ

[Mục lục](README.md) · [Bản dễ hiểu](plan-easy-read-flow.md) · [Thuật ngữ](glossary.md)

Trạng thái: hành trình đích đề xuất. [Bản đầu](delivery/mvp-and-roadmap.md#section-21) chỉ tự động hóa một phần.

<a id=section-3></a>

## 1. Hành trình từ nhu cầu đến giới thiệu

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
| 8. Mặc cả và thanh toán | Khách đề xuất → máy chủ duyệt giá → xác nhận đơn → thanh toán → đối soát | Giá thấp, hết hiệu lực, thiếu hàng, trả thiếu/thừa/muộn đều có nhánh riêng | P2 tính thử, P3 tự động có giới hạn; ngoài P1 |
| 9. Bù giá sau mua | Sự kiện giảm giá → kiểm tra đơn đủ điều kiện → duyệt/cấp phiếu một lần | Đơn trả/hủy, khác biến thể, ưu đãi không tương đương hoặc vượt ngân sách thì loại | P2 có người duyệt; không báo đã bù trước khi hệ thống cấp phiếu xác nhận |
| 10. Khách cần tư vấn B2B | Nhu cầu → ngân sách/người quyết định/thời điểm → sản phẩm → lịch hoặc báo giá | Thiếu trường thì để chưa biết; lịch hết chỗ hoặc lỗi thì không báo đã đặt | Cấu hình thay thế nếu chọn thử B2B; không bắt người mua lẻ đi qua chuỗi này |

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

## 3. Bàn giao giữ ngữ cảnh và trách nhiệm

Gói bàn giao tối thiểu:

| Nhóm | Nội dung |
|---|---|
| Liên kết | Doanh nghiệp, khách/phiên, cuộc trao đổi, yêu cầu, sự kiện và mã truy vết |
| Nghiệp vụ | Nguồn khách, nhu cầu, sản phẩm, đơn/cơ hội/vụ việc liên quan |
| Bằng chứng | Thông tin đã xác minh, nguồn, phiên bản, thời điểm và phần chưa rõ |
| Xử lý trước đó | Câu trả lời, bước đã thử, kết quả, đề xuất hoặc phê duyệt đang chờ |
| Trách nhiệm | Bên hiện phụ trách, bên được đề nghị nhận, mức ưu tiên, hạn phản hồi và bước tiếp theo |
| Liên hệ | Kênh được phép, trạng thái đồng ý, yêu cầu ngừng hoặc gặp nhân viên |

Quy tắc vận hành:

1. Gửi yêu cầu bàn giao chưa phải hoàn thành bàn giao; bên nhận phải chấp nhận.
2. Trong lúc chờ người, tạm dừng AI trả lời nghiệp vụ; giữ hàng đợi chịu trách nhiệm và thông báo trạng thái trung thực.
3. Mỗi cuộc trao đổi chỉ có một bên được phát trả lời tại một thời điểm.
4. Nhân viên tiếp quản thì hủy các lịch nhắc liên quan; chỉ bật lại AI bằng quyết định rõ ràng.
5. Giữ thông tin đã biết để không hỏi lại vô ích; vẫn xác minh lại khi cần bảo vệ dữ liệu hoặc thông tin đã cũ.
6. Bàn giao thất bại không làm mất cuộc trao đổi. Giữ người/nhóm chịu trách nhiệm xử lý tiếp.

Chi tiết trạng thái và thử lại do [quy trình](platform/workflows-and-handoffs.md) quy định; quyền truy cập do [API](platform/api-and-integrations.md) và [dữ liệu](platform/data-and-knowledge.md) quy định.
