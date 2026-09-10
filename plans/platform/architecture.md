# Kiến trúc và điều phối

[Mục lục](../README.md) · [Dữ liệu](data-and-knowledge.md) · [API](api-and-integrations.md)

Trạng thái: kiến trúc logic đề xuất, chưa phải hệ thống đã triển khai. Không quy định nhà cung cấp hạ tầng trước khi biết doanh nghiệp thử nghiệm.

<a id=section-5></a>

## 1. Bộ điều phối nghiệp vụ

Bộ điều phối xác định ý định, lấy ngữ cảnh được phép và chọn mô-đun hoặc nhân viên. Nó không tự cấp quyền, bật mô-đun bị tắt hoặc vượt quyền người đang tiếp quản.

| Yêu cầu | Nơi xử lý |
|---|---|
| “Tôi muốn xem có giải pháp nào phù hợp” | Tiếp thị nếu bật; Bán hàng khi có ý định mua; không rõ thì hỏi một câu |
| “Sản phẩm này có hợp với nhu cầu của tôi không?” | Bán hàng |
| “Tôi không dùng được sản phẩm” | Chăm sóc |
| “Tôi muốn mua thêm / nâng cấp” | Bán hàng, nếu không bật thì nhân viên |
| “Tôi muốn hủy / hoàn tiền / gặp người thật” | Tiếp nhận yêu cầu rồi chuyển người có quyền; không tự thực hiện |
| Nghiên cứu thị trường nội bộ | Tiếp thị ở giai đoạn được bật, không gửi nội dung cho khách tự động |

Yêu cầu chỉ đích danh mô-đun và yêu cầu tự điều phối `auto` phải qua cùng kiểm tra. `auto` không phải mô-đun thứ tư. Nếu ý định chưa rõ, hỏi tập trung hoặc chuyển người, không liên tục đổi trợ lý.

<a id=section-10></a>

## 2. Các lớp trách nhiệm

| Lớp | Trách nhiệm | Không được làm |
|---|---|---|
| Website/ứng dụng/kênh hiện có | Hiển thị, nhận thao tác, xác thực phiên khách theo thiết kế | Giữ khóa API doanh nghiệp, tự quyết giá hoặc trạng thái thanh toán |
| Cổng API và sự kiện | Xác thực bên gọi, gắn phạm vi doanh nghiệp, kiểm tra quyền, chống trùng | Tin mã doanh nghiệp/khách chỉ vì có trong nội dung gửi lên |
| Điều phối và mô-đun | Hiểu nhu cầu, tạo câu trả lời/đề xuất từ nguồn cho phép | Cấp quyền hoặc xác nhận hành động chưa xảy ra |
| Quy trình và quy tắc máy chủ | Phê duyệt, giá sàn, trạng thái, hẹn giờ, giới hạn, người phụ trách | Giao quyết định rủi ro chỉ cho lời hướng dẫn AI |
| Bộ kết nối | Đọc/ghi đúng API, ánh xạ trường, xử lý lỗi, trả bằng chứng | Cho AI truy cập cơ sở dữ liệu doanh nghiệp không giới hạn |
| Dữ liệu dùng chung | Liên kết khách, hội thoại, quy trình, bằng chứng và nhật ký | Thay nguồn gốc của giá, đơn hoặc thanh toán |
| Bảng điều khiển | Cấu hình, hàng đợi, duyệt, tiếp quản, tra lỗi và báo cáo | Cho người không có vai trò duyệt thao tác rủi ro |

Luồng thực thi: ngữ cảnh được phép → AI đề xuất → máy chủ kiểm tra quyền/quy tắc → bộ kết nối thực hiện nếu cần → kiểm chứng kết quả → phản hồi → lưu bằng chứng.

Customer360 chứa ngữ cảnh và liên kết khách. Kho kiến thức chứa tài liệu đã duyệt. Chúng khác nhau; AI không sửa tài liệu trong lúc trả lời. Dữ liệu giá/đơn/thanh toán có nguồn nghiệp vụ riêng.

## 3. Cách triển khai nhỏ nhất

Bắt đầu bằng **một ứng dụng chia phần chức năng và một tiến trình nền lưu trạng thái bền vững**. Không cần một dịch vụ riêng cho mỗi trợ lý, một bản phần mềm riêng cho mỗi khách hay hệ thống thông điệp phức tạp ngay từ đầu.

| Dữ liệu | Phương án khởi đầu |
|---|---|
| Liên kết khách, hội thoại, trạng thái, sự kiện, cấu hình, nhật ký | Cơ sở dữ liệu quan hệ với truy cập theo doanh nghiệp |
| Tài liệu | Kho tệp được kiểm soát quyền |
| Chỉ mục tìm kiếm | Dữ liệu dẫn xuất, có thể dựng lại; không là bản duy nhất của trạng thái nghiệp vụ |
| Công việc và lịch chờ | Hàng đợi/trạng thái bền vững; chỉ một tiến trình nắm quyền thực hiện một bước |
| Báo cáo | Truy vấn/bảng tổng hợp từ dữ liệu có sẵn; kho phân tích riêng chỉ khi cần |

Dùng bộ kết nối có sẵn hoặc API doanh nghiệp trước. Không có API phù hợp thì chốt nhập dữ liệu có kiểm soát hoặc cầu nối do doanh nghiệp quản lý; không hứa cắm vào mọi hệ thống là chạy.

## 4. Điều phối giao diện khác điều phối nghiệp vụ

Bộ giao diện nhúng đề xuất trong PDF chỉ quản lý trải nghiệm: phần hỏi nhanh, chat, gợi ý và trạng thái. Quyền dữ liệu, AI, giá sàn, thanh toán và nhật ký phải ở máy chủ.

| Quy tắc giao diện tùy chọn | Cách áp dụng |
|---|---|
| Không hiển thị chồng | Mở chat hoặc giỏ thì không tự bật gợi ý tiếp thị |
| Giới hạn tần suất | Ban đầu tối đa một gợi ý tự bật/24 giờ/thiết bị; lưu lượng đo không dựa vào theo dõi ngầm liên thiết bị |
| Dễ tắt, không ép đăng ký | Có nút đóng; không chặn mua hoặc buộc số điện thoại khi chỉ xem |
| Vùng an toàn di động | Không che nút gốc; kiểm thử bàn phím, vùng tai thỏ, trình đọc màn hình; 75 px chỉ là giá trị thử từ PDF |
| Cô lập kiểu hiển thị | Dùng cơ chế cô lập khi cần, chẳng hạn Shadow DOM; kiểm thử tương thích và khả năng tiếp cận |
| Tải theo nhu cầu | Chỉ tải phần được bật; không đóng gói mô hình AI vào mã trình duyệt |

Các mục tiêu dung lượng dưới 6/7/7 KB từng phần và dưới 20 KB toàn bộ trong PDF là ngân sách thử cho mã giao diện nén, không phải tổng dung lượng AI/RAG hay cam kết đã đo. Phải công khai thứ được tính: mã điều phối, phần tải thêm, CSS, ảnh, phông và thư viện. Đo cả ảnh hưởng tốc độ trang; không đạt ngân sách thì báo thật, không giấu vào tệp tải sau.

P1 ưu tiên giao diện đang có; chưa xây bộ mã nhúng đầy đủ chỉ để thỏa tên tệp trong PDF.

## 5. Một yêu cầu qua hệ thống

1. Website gửi yêu cầu qua máy chủ doanh nghiệp hoặc bộ kết nối kênh đã xác thực.
2. API lưu công việc bền vững, trả mã theo dõi; chưa báo kết quả kinh doanh.
3. Kiểm tra mô-đun, quyền xem hội thoại và danh tính khi cần dữ liệu riêng.
4. Điều phối xác nhận một bên đang phụ trách; nếu nhân viên sở hữu, chuyển tin vào hàng đợi của họ.
5. Mô-đun đề xuất câu trả lời/hành động từ nguồn có quyền.
6. Máy chủ kiểm tra lại quyền, đồng ý liên hệ, chính sách và điều kiện hiện tại trước thao tác.
7. Bộ kết nối trả đã xác nhận, bị từ chối hoặc chưa rõ; chưa rõ phải đối soát.
8. Gửi kết quả qua API/kênh được chỉ định, ghi nhật ký và ngữ cảnh cần cho lần tiếp theo.

## 6. Điều kiện nghiệm thu kiến trúc

1. Cùng bản phần mềm chạy được với hai doanh nghiệp thử tách biệt; không rò dữ liệu, tìm kiếm, tệp, hàng đợi hay báo cáo.
2. Tham số yêu cầu không thể mở mô-đun chưa bật hay truy cập công việc của doanh nghiệp khác.
3. Một cuộc trao đổi không có AI và nhân viên đồng thời phát trả lời nghiệp vụ.
4. AI không thể gọi công cụ ngoài danh sách hay ghi trực tiếp nguồn doanh nghiệp.
5. Khởi động lại tiến trình không làm mất công việc đã nhận hoặc gửi lại tác dụng bên ngoài không kiểm soát.
6. Nếu có mã nhúng, thao tác mua gốc vẫn hoạt động khi trợ lý lỗi; không có khóa dịch vụ trong trình duyệt.
7. Chỉ số giao diện và độ trễ phải được đo trên cấu hình thử thật; không coi ngân sách trong PDF là kết quả.

Hợp đồng chi tiết nằm ở [API](api-and-integrations.md), [dữ liệu](data-and-knowledge.md) và [quy trình](workflows-and-handoffs.md).
