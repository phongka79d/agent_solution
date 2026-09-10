# Mô-đun Tiếp thị — Từ nghiên cứu nhu cầu đến khách phù hợp

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P0 nghiên cứu có người làm; P1 chỉ lưu nguồn/yêu cầu qua lõi, **chưa bật mô-đun Tiếp thị tự động**. P2/P3 mở các năng lực dưới đây theo [lộ trình](../delivery/mvp-and-roadmap.md).

<a id=section-6></a>

## 1. Mục tiêu và ranh giới

Tìm đúng vấn đề, đúng nhóm khách, đúng thời điểm và kênh phân phối; tạo nhu cầu được kiểm chứng, không chỉ tạo nhiều biểu mẫu hay lượt bấm.

Tiếp thị bắt đầu trước quảng cáo, nhưng việc phát hiện một tín hiệu **không tạo quyền truy cập danh sách cá nhân hoặc quyền gửi tin**. Quảng cáo, ngân sách và xuất bản vẫn do người có thẩm quyền duyệt. Nền tảng quảng cáo sở hữu khâu phân phối/đấu giá; AgentOS không thay thế khâu đó.

## 2. Bốn vai trò trong một mô-đun

| Vai trò | Công việc | Đầu ra để người phụ trách duyệt |
|---|---|---|
| Nghiên cứu thị trường | Quy mô, tăng trưởng, nhu cầu, cạnh tranh, sản phẩm thay thế, nơi khách tập trung, đối tác | Phiếu cơ hội có nguồn, mức chắc chắn và phép thử |
| Chiến lược tiếp thị | Vấn đề thật, giải pháp, thời điểm, định vị, đề nghị giá trị, bằng chứng | Bản thông điệp, hành trình và điều kiện đề nghị |
| Thu hút khách và đối tác | Lựa chọn kênh, tìm tổ chức phù hợp, tiếp nhận, phân nhóm, bàn giao | Danh sách tổ chức có nguồn, đề xuất hợp tác, yêu cầu có phép |
| Đo hiệu quả tiếp thị | Nội dung, trang giới thiệu, thử nghiệm hai phương án, chi phí và chất lượng khách | Báo cáo, đề xuất cải tiến; không tự chi tiền hay xuất bản |

Đây là phân công nghiệp vụ, chưa yêu cầu bốn trợ lý chạy độc lập. Bắt đầu bằng quy trình và biểu mẫu; chỉ tách khi có nhu cầu vận hành thực.

## 3. Quy trình nghiên cứu chuẩn

1. Xác định kết quả cuối khách cần, không chỉ tên sản phẩm đang bán.
2. Đi ngược hành trình để tìm hành động xảy ra trước nhu cầu; kiểm tra thứ tự thực tế thay vì coi ví dụ là quy luật.
3. Xác định nơi khách tập trung và tổ chức có thể giới thiệu giải pháp.
4. Tìm vấn đề chưa được giải quyết tốt, cách khách đang xử lý và lý do họ có thể đổi giải pháp.
5. Đánh giá sản phẩm của doanh nghiệp: lợi ích, giới hạn, khác biệt, điều kiện dùng và bằng chứng.
6. Ước lượng khả năng chi trả, biên lợi nhuận, mua lại, chi phí thu hút, phân phối; xác định rào cản pháp lý và vận hành cần người có chuyên môn kiểm tra.
7. Chọn một giả thuyết có đòn bẩy lớn như chuyển đổi, mua lại hoặc chi phí thu hút; thiết kế phép thử nhỏ.
8. Người phụ trách quyết định thử, sửa hay dừng dựa trên kết quả, không dựa vào lời tự chấm điểm của AI.

Ba nhóm động cơ trong PDF được diễn đạt trung tính: người quan tâm giá, người muốn thao tác nhanh và người cần thêm bằng chứng. Tuổi, tỷ lệ và hành vi minh họa chưa được coi là phân khúc đã xác thực; không gán nhãn cá nhân bằng suy đoán.

Thông điệp còn phải phù hợp mức nhận thức nhu cầu: khách đã có nhu cầu cần bằng chứng so sánh; khách biết vấn đề nhưng chưa biết giải pháp cần được giải thích lựa chọn; khách chưa nhận ra vấn đề cần thông tin có căn cứ về bất tiện hoặc cơ hội cải thiện. Không tạo nhu cầu giả, thổi phồng hậu quả hay dùng nỗi sợ để thúc mua.

### Phiếu cơ hội tối thiểu

| Trường | Nội dung phải ghi |
|---|---|
| Vấn đề và phân khúc | Ai gặp vấn đề gì, trong hoàn cảnh nào; điều chưa biết |
| Nhu cầu cuối | Kết quả khách mong muốn và cách giải quyết hiện tại |
| Tín hiệu sớm | Hành động, nguồn quan sát, ngày, khoảng thời gian hữu ích; hết hạn khi nào |
| Điểm tập trung / đối tác | Tổ chức nào, vì sao phù hợp, nguồn công khai hoặc nguồn được cấp quyền |
| Giải pháp và bằng chứng | Sản phẩm phù hợp, giới hạn, nguồn xác nhận công dụng |
| Kinh tế sơ bộ | Doanh thu/chi phí giả định, hoa hồng đối tác, lãi đóng góp và dữ liệu còn thiếu |
| Rào cản | Điều kiện pháp lý, quyền dữ liệu, năng lực cung cấp và rủi ro vận hành cần kiểm tra trước thử |
| Phép thử | Đối tượng, kênh, thông điệp, người duyệt, giới hạn ngân sách, chỉ số và tiêu chí dừng |
| Kết quả | Phản hồi, đơn hợp lệ nếu có, chi phí, kết luận giữ/sửa/bỏ |

Tách **sự kiện có nguồn**, **suy luận** và **giả thuyết chưa kiểm chứng**. Chưa có dữ liệu quy mô thị trường thì để chưa biết, không tự tạo số.

### Vận dụng ví dụ SIM

Nhu cầu cuối là kết nối thuận tiện khi đến nơi. Học tiếng, chuẩn bị hồ sơ hoặc vé máy bay có thể là tín hiệu để nghiên cứu nhóm nhu cầu, không phải bằng chứng từng người chắc chắn cần SIM. Trung tâm/đơn vị liên quan có thể thử giới thiệu đường dẫn để khách tự đăng ký.

Ví dụ 300 học viên × 60% × 40% = 72 khách/năm chỉ minh họa cách tính. Không dùng tỷ lệ 10%, 60%, 40% hoặc số đối tác trong tài liệu nguồn để lập dự báo thực tế khi chưa đo.

## 4. Kênh đối tác và hoa hồng

1. Kiểm chứng giải pháp trực tiếp với nhóm nhỏ trước.
2. Chọn một đối tác có khách phù hợp, không cạnh tranh trực tiếp và có lợi ích rõ.
3. Duyệt cách giới thiệu, dữ liệu được chia sẻ, điều kiện ghi nhận và chi phí hợp tác.
4. Gắn đường dẫn/mã nguồn; để khách chủ động truy cập hoặc cho phép liên hệ.
5. Đối chiếu đơn hợp lệ, đơn trùng, hủy/hoàn và cửa sổ ghi nhận trước khi tính hoa hồng.
6. Nhân viên đối soát và chi trả theo quy trình hiện có; chưa xây hệ thống thanh toán đối tác trong P1/P2.

Phải chốt quy tắc khi nhiều đối tác cùng giới thiệu, tự giới thiệu, gian lận mã, đơn bị trả hoặc nguồn không rõ. Không tính một khoản tiết kiệm hoa hồng bán hàng hai lần; xem [kinh tế đơn hàng](../delivery/analytics.md#unit-economics).

Báo cáo đối tác chỉ chứa dữ liệu cần thiết được phép. Vai trò đối tác không cho quyền xem toàn bộ Customer360.

## 5. Tiếp nhận, phân loại và chăm sóc

Đầu vào: yêu cầu/sự kiện từ nguồn đã xác thực; mã sự kiện; thời điểm; sản phẩm quan tâm; nguồn chiến dịch/đối tác nếu có; trạng thái đồng ý liên hệ; khách/phiên đã được liên kết đúng quyền.

1. Xác thực nguồn và loại sự kiện trước khi tiếp nhận; loại nguồn không hợp lệ, chỉ lưu nhật ký từ chối tối thiểu.
2. Chống trùng; lưu yêu cầu dù thiếu nguồn quảng cáo, nhưng đánh dấu nguồn chưa biết.
3. Giữ khách ẩn danh ở mức phiên khi chưa xác minh; không hợp nhất theo email/số điện thoại tự khai.
4. Hỏi phần cần thiết, lưu phần thiếu là chưa biết.
5. Khi Tiếp thị được bật, chấm mức phù hợp/quan tâm bằng quy tắc có phiên bản, giới hạn điểm hành vi và loại lượt trùng.
6. Khách sẵn sàng mua chuyển Bán hàng kèm bằng chứng; Bán hàng xác nhận điều kiện, không coi điểm cao là khách đã đủ chuẩn.
7. Khách chưa sẵn sàng chỉ được chăm sóc nếu đủ điều kiện theo mục đích/kênh; thiếu phép vẫn có thể trả lời câu hỏi chủ động hợp lệ.

Lượt xem, lưu món hoặc ở trang hơn 8 giây chỉ là tín hiệu tương tác, không chứng minh ý định mua. Không có công thức chấm điểm mặc định đáng tin cho mọi ngành.

## 6. Tương tác tại website và nội dung

Tính năng sau P1 có thể gồm lưu món chưa đăng nhập, hướng dẫn tại chỗ và đăng ký nhận ưu đãi. Nội dung quảng cáo, trang giới thiệu, tin nhắn và đề xuất ngân sách luôn ở trạng thái nháp cho đến khi được người có quyền duyệt.

Giới hạn ban đầu cho gợi ý tự bật là tối đa một lần/24 giờ/thiết bị khi bật tính năng; 8 giây chỉ là tham số thử từ PDF. Không bật khi chat/giỏ đang mở, không cản mua hay buộc cung cấp số điện thoại. Người xem chủ động mở trợ giúp không tính là quảng cáo tự bật.

Zalo, LINE, Facebook, email hoặc kênh khác chỉ gửi khi bộ kết nối và điều kiện hiện hành đã được xác nhận. Nút đăng ký và số điện thoại giao hàng phải có mục đích riêng, không tự đánh dấu đồng ý.

## 7. Nghiệm thu

| Tình huống | Kết quả bắt buộc |
|---|---|
| Tìm được đối tác/tín hiệu | Có nguồn, ngày, giả thuyết và người duyệt; chưa tạo quyền liên hệ |
| Nguồn sự kiện không hợp lệ | Không tạo khách quan tâm được chấp nhận |
| Yêu cầu gửi trùng | Một bản ghi, một kết quả bàn giao |
| Thiếu phép tiếp thị | Trả lời chủ động hợp lệ được; không lên lịch chăm sóc |
| Điểm cao nhưng thiếu điều kiện | Không tự tạo khách đủ chuẩn/cơ hội bán hàng |
| Bán hàng chưa bật | Hàng đợi nhân viên, không gọi hành động Bán hàng |
| Tiếp thị chưa bật ở P1 | Chỉ lõi lưu nguồn/yêu cầu; không nghiên cứu tự động, chấm điểm Tiếp thị, xuất bản hay gửi chiến dịch |
| Nhân viên nhận hoặc khách yêu cầu dừng | Dừng lịch liên hệ liên quan, giữ bằng chứng và trạng thái |

Chỉ số và dữ liệu thiếu do [đo lường](../delivery/analytics.md) quy định; trạng thái gửi, nhận và dừng do [quy trình](../platform/workflows-and-handoffs.md) quy định.
