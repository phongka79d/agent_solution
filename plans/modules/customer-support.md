# Mô-đun Chăm sóc khách hàng — Giải quyết vấn đề và giữ niềm tin

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P1 có hỏi đáp cơ bản, hướng dẫn giới hạn và bàn giao; các tác vụ đơn hàng, vận chuyển, phiếu bù giá và đổi trả cần kết nối/nghiệm thu sau.

<a id=section-8></a>

## 1. Mục tiêu và ranh giới

Giúp khách dùng sản phẩm thành công, xử lý vấn đề nhất quán và được gặp nhân viên khi cần. Hỗ trợ là một phần của sản phẩm, không phải điểm cuối sau bán.

Chăm sóc có thể nhận câu hỏi trước mua. Câu hỏi công dụng chung dùng nguồn đã duyệt; khi khách cần đề xuất thương mại hoặc mua hàng, bàn giao Bán hàng nếu bật, nếu không thì chuyển nhân viên. Không trì hoãn giải quyết khiếu nại để bán thêm.

## 2. Luồng xử lý chuẩn

1. Kiểm tra mô-đun bật, người đang phụ trách và yêu cầu gặp người thật.
2. Với câu hỏi chung, dùng kiến thức công khai; trước khi đọc đơn/tài khoản riêng, xác minh đúng khách.
3. Đọc phần ngữ cảnh cần thiết qua kết nối được phép; nếu chưa có kết nối đơn thì không hứa tra được đơn.
4. Tìm tài liệu hiện hành đã duyệt, đúng sản phẩm/phiên bản.
5. Trả lời hoặc hướng dẫn các bước được cho phép; ghi bước đã thử và kết quả.
6. Hỏi khách vấn đề đã giải quyết chưa. Chưa xác nhận thì giữ mở/đang chờ, không đóng vì đã gửi câu trả lời.
7. Khi thiếu nguồn, hướng dẫn không hiệu quả, vấn đề rủi ro hoặc khách yêu cầu, tạo hàng đợi nhân viên kèm ngữ cảnh.
8. Chỉ đánh dấu giải quyết bằng xác nhận của khách hoặc kết quả nhân viên có bằng chứng theo quy trình; ghi riêng nếu phải mở lại.

## 3. Dữ liệu và đầu ra

| Đầu vào | Cách dùng |
|---|---|
| Khách/phiên và bằng chứng xác minh | Giới hạn quyền xem dữ liệu riêng; mã đơn tự khai không đủ |
| Vấn đề, mong muốn, mức ảnh hưởng | Chọn câu hỏi, hướng dẫn và mức ưu tiên |
| Sản phẩm, tài liệu, phiên bản | Trả lời có nguồn; không dùng hướng dẫn khác mẫu |
| Lịch sử, người phụ trách, bước đã thử | Tránh hỏi lại, không trả lời chồng nhân viên |
| Đơn, vận chuyển, phiếu hỗ trợ nếu có kết nối | Chỉ trình bày trạng thái được nguồn gốc xác nhận |

Đầu ra phải có câu trả lời và nguồn, phần chưa biết, bước đã thử, vụ việc/hàng đợi, người phụ trách và bước tiếp theo. Nếu tạo phiếu hỗ trợ ở hệ thống ngoài, phải có mã được nhà cung cấp xác nhận; nếu lỗi, dùng hàng đợi nội bộ có trạng thái rõ.

## 4. Năng lực được hợp nhất

| Năng lực | Thực hiện tối thiểu | Giai đoạn |
|---|---|---|
| Hỏi đáp và hướng dẫn | Tìm tài liệu đã duyệt, giải thích có nguồn | P1 |
| Gợi ý câu hỏi theo ngữ cảnh | Vài câu ngắn dựa trên trang/sản phẩm hợp lệ; dữ liệu riêng cần xác minh | P1 nếu giao diện hỗ trợ |
| Tra trạng thái đơn/giao hàng | Kết nối từng hệ thống, hiển thị thời điểm cập nhật | P2 |
| Nút liên hệ người giao | Chỉ hiển thị thông tin nguồn cho phép và người mua có quyền xem | P2 |
| Phiếu hỗ trợ và ưu tiên thời gian | Tạo/cập nhật có xác nhận, bàn giao người nhận | P2 |
| Bù giá bằng phiếu mua lần sau | Chính sách, ngân sách, kiểm tra điều kiện, duyệt/cấp một lần | P2 thử có người duyệt; P3 tự động giới hạn |
| Dùng ảnh/video hỗ trợ xử lý | Nhận tài liệu theo quyền, AI tóm tắt cho nhân viên | P3 xem xét, không tự quyết đổi trả |
| Tín hiệu mua lại/nâng cấp | Ghi nhu cầu thật; Bán hàng chịu trách nhiệm đề nghị thương mại | P1 ghi nhận; tự động mở rộng sau |

Tra cứu hai giai đoạn trong PDF được giữ như phương án: lọc đúng sản phẩm/quyền rồi tìm tài liệu liên quan. Chưa cần thêm hệ thống xếp hạng phức tạp nếu tìm kiếm đơn giản đáp ứng bộ thử; chỉ bổ sung khi đo được khoảng trống chất lượng.

## 5. Chính sách bù giá đề xuất

Mục tiêu là thử giảm lo mua hớ và tăng mua lại; **phiếu mua hàng vẫn có chi phí và nghĩa vụ thực hiện**, không phải tiền miễn phí. Khoảng 14 ngày từ PDF là tham số đề xuất, cần công khai và duyệt trước.

Trước thử nghiệm, phải xác định:

| Quy tắc | Cần chốt |
|---|---|
| Mốc thời gian | Tính từ thanh toán hay giao hàng; múi giờ; cửa sổ phát hiện |
| Tương đương sản phẩm | Mã hàng, biến thể, số lượng, điều kiện bán và loại khuyến mãi |
| Giá so sánh | Giá thực trả sau phân bổ giảm giá với giá đủ điều kiện sau đó; không so các điều kiện khác nhau |
| Điều kiện đơn | Đã xác nhận, chưa hủy/trả; xử lý hoàn một phần và các phiếu đã cấp |
| Hạn mức | Trần mỗi đơn/khách và toàn chương trình; cách xử lý nhiều lần giảm giá |
| Phiếu phát hành | Giá trị, hạn dùng, giá trị đơn tối thiểu, khả năng cộng dồn và cách thông báo |
| Quyền khách hàng | Không dùng phiếu để thay quyền hoàn tiền hoặc cam kết đã có nếu chưa phù hợp chính sách được rà soát |
| Thông báo | Kênh và mục đích được phép; không tự biến thông báo quyền lợi thành quảng cáo |

Luồng: sự kiện giảm giá được xác thực → đối chiếu đơn đủ điều kiện → tính phần chênh lệch theo chính sách → kiểm tra ngân sách → người duyệt hoặc quy tắc đã được bật → cấp phiếu → xác nhận mã → thông báo.

Chống trùng theo doanh nghiệp + đơn/dòng hàng + chương trình + sự kiện giảm giá; đồng thời kiểm soát tổng đã bù để nhiều sự kiện không cấp vượt. Cấp thành công nhưng gửi tin thất bại thì thử lại việc gửi, không cấp phiếu thứ hai. Đơn trả/hủy sau khi cấp cần xử lý theo chính sách, không tự trừ tiền khách.

## 6. Khiếu nại và bàn giao khẩn

Các tín hiệu bảo mật, an toàn, tranh chấp nghiêm trọng, lặp lỗi hoặc khách yêu cầu người thật cần chuyển người có trách nhiệm. Từ khóa chỉ là một tín hiệu, không phải bộ phân loại đáng tin duy nhất.

Mục tiêu gọi lại dưới hai phút của PDF chỉ là **mục tiêu thử nghiệm khi có nhân sự trực và điều kiện đáp ứng**, không phải lời hứa 24/7. Chưa có người nhận thì thông báo đang chờ và thời gian dự kiến được cấu hình.

Gói bàn giao chứa khách đã xác minh, vấn đề, kết quả mong muốn, đơn/sản phẩm liên quan, nguồn, bước đã thử, mức ảnh hưởng và hành động tiếp theo. Nhân viên nhận trách nhiệm thì AI ngừng trả lời nghiệp vụ. Thời hạn chờ phải có người theo dõi; hết hạn không tự đánh dấu giải quyết.

## 7. Phản hồi để cải tiến

Tổng hợp câu hỏi lặp lại, lý do không phù hợp, lỗi dùng, khiếu nại và đổi trả thành đề xuất sửa tài liệu, sản phẩm hoặc thông điệp. Dữ liệu gửi sang Tiếp thị cần tối thiểu hóa, ưu tiên tổng hợp và không lộ danh tính ngoài quyền.

Khách dùng tốt có thể được mời đánh giá, mua lại hoặc giới thiệu khi phù hợp; không yêu cầu đánh giá tích cực để được giải quyết quyền lợi. AI không tự xuất bản lời chứng thực hay sửa kho kiến thức.

## 8. Nghiệm thu

1. Câu hỏi chung được trả lời từ tài liệu đúng phiên bản, không cần buộc khai số điện thoại.
2. Khách chưa xác minh hỏi đơn hàng không nhận dữ liệu riêng.
3. Thiếu nguồn, nguồn mâu thuẫn hoặc bước không an toàn dẫn tới bàn giao, không suy đoán.
4. Khách chưa xác nhận thì vụ việc chưa giải quyết; vụ mở lại được liên kết đúng.
5. Tạo phiếu bị lỗi phải đối soát; một vụ việc không sinh nhiều phiếu do thử lại.
6. Khách yêu cầu người thật được bàn giao ngay; AI không trả lời chồng.
7. Khi thử bù giá, đơn không đủ điều kiện và ngân sách hết bị chặn; sự kiện trùng không cấp lặp.
8. Mô-đun chưa bật thì trả trạng thái không hỗ trợ hoặc hàng đợi nhân viên.

Mọi thao tác hoàn tiền, hủy, đổi trả hoặc thay tài khoản phải qua người có quyền và hệ thống nguồn; không nằm trong P1.
