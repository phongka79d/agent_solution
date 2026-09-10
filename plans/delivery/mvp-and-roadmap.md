# Bản đầu, kiểm chứng và lộ trình triển khai

[Mục lục](../README.md) · [Bản dễ hiểu](../plan-easy-read-flow.md) · [Đo lường](analytics.md)

Trạng thái: kế hoạch đề xuất, chưa triển khai. P0–P3 là giai đoạn theo điều kiện nghiệm thu, không phải lịch phát hành đã cam kết.

<a id=section-21></a>

## 1. Bản đầu: một hành trình nhỏ chạy được

Mục tiêu P1: Bán hàng tư vấn trong website hiện có của một doanh nghiệp, có Chăm sóc cơ bản, dữ liệu đúng quyền, nhân viên tiếp quản và báo cáo kiểm tra được.

Đề xuất ưu tiên B2C từ PDF; ngành/doanh nghiệp chưa chốt. Nếu chọn bán hàng B2B cần tư vấn, dùng cấu hình nhu cầu–ngân sách–người quyết định–thời điểm và lịch hẹn. Không triển khai hai hành trình riêng đồng thời trong một lần thử.

Thay đổi so với kế hoạch cũ đã được ghi ở [mục lục hợp nhất](../README.md): giữ Bán hàng trước, nhưng không bắt buộc LINE hoặc lịch hẹn cho mọi doanh nghiệp; nghiên cứu thị trường thủ công được đưa lên P0. Việc viết lại kế hoạch không đồng nghĩa phê duyệt kết nối, chạy quảng cáo hoặc giao dịch thật.

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

Không có trong P1: toàn bộ Tiếp thị tự động, học máy riêng, nhiều kênh đồng thời, bộ nhúng đầy đủ, thanh toán và ưu đãi tự động, phiếu bù giá, video đổi trả, giọng nói và trình kéo-thả.

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

## 5. Lộ trình theo bằng chứng

| Giai đoạn | Mục tiêu | Phạm vi | Điều kiện ra |
|---|---|---|---|
| P0 — Hiểu nhu cầu | Chọn đúng thử nghiệm | Nghiên cứu thủ công có AI soạn nháp; phiếu cơ hội; phỏng vấn/đối tác do người thực hiện theo quyền; chọn dữ liệu và hành trình | Có vấn đề thật, giải pháp khả thi, người chịu trách nhiệm, dữ liệu và phép thử |
| P1 — Bán hàng và Chăm sóc cơ bản | Chứng minh nền tảng dùng được | Phạm vi tại mục 1, một website và nguồn cần thiết | Qua bộ thử, nhân viên tiếp quản được, báo cáo kiểm được, chủ doanh nghiệp duyệt |
| P2 — Thử cải tiến có kiểm soát | Tìm tính năng tạo giá trị | Chọn từng thử nghiệm: Tiếp thị/đối tác theo quy tắc, giao diện chọn nhanh/lưu món, hỗ trợ đơn, QR, so giỏ/nâng cấp, ưu đãi tính thử hoặc phiếu có người duyệt | Có nguồn, chi phí, người duyệt, kết quả thử và không vi phạm điều kiện dừng |
| P3 — Mở rộng có căn cứ | Nhân rộng phần đã chứng minh | Mặc cả/phát phiếu có hạn mức, nhiều kênh/đối tác, mua lại/giới thiệu, tự động hóa sâu; học máy khi đủ điều kiện | Hiệu quả và chất lượng ổn định, ngân sách phù hợp, vận hành/phục hồi được nghiệm thu |

P2 là danh sách lựa chọn, **không phải phải làm hết cùng lúc**. Chọn một tính năng theo vấn đề lớn nhất đã đo. Ví dụ giải thích sản phẩm hiệu quả hơn có thể được ưu tiên trước thanh toán mới.

### Cổng riêng cho tính năng rủi ro

| Tính năng | Chưa được bật cho tới khi |
|---|---|
| Mặc cả/giá ưu đãi | Tài chính duyệt chi phí/sàn/ngân sách; tính thử đúng; không lách qua API, giỏ hoặc mã ưu đãi; có hạn mức và ngắt |
| Thanh toán QR | Có hợp đồng/năng lực kết nối, đối soát nguồn, nhánh trùng/muộn/thiếu/thừa và người xử lý |
| Phiếu bù giá | Có chính sách công khai, chi phí, điều kiện đơn, chống cấp vượt/trùng và xử lý đơn trả |
| Đối tác | Quy tắc nguồn/hoa hồng, quyền dữ liệu, đối soát và chống gian lận được duyệt |
| Gợi ý tự bật/mã nhúng | Đo tương thích/tốc độ/khả năng tiếp cận và tần suất; không che thao tác mua |
| Tra vận chuyển/hóa đơn | Nguồn xác nhận được năng lực cụ thể; không hứa ngoài dữ liệu |
| Phân tích ảnh/video | Có dữ liệu đánh giá, quyền lưu/xóa, quy trình người duyệt; không tự quyết quyền lợi khách |

<a id=section-23></a>

## 6. Nghiên cứu có AI khác học máy dự đoán

Nghiên cứu thị trường có thể bắt đầu ở P0 bằng đọc nguồn, phiếu cơ hội và nhân viên kiểm chứng. Không phải chờ có mô hình dự đoán riêng mới nghiên cứu được.

Học máy dự đoán là nhánh P3 có điều kiện:

| Năng lực | Điều kiện |
|---|---|
| Chấm phù hợp bằng quy tắc | Trường rõ, bằng chứng nguồn và phiên bản; làm trước mô hình học |
| Dự đoán chất lượng/chuyển đổi | Dữ liệu đủ nhãn, trạng thái đáng tin, tập kiểm tra theo thời gian không dùng lúc học |
| Ước tính giá trị vòng đời | Đủ lịch sử doanh thu/chi phí, mua lại và nhóm quan sát |
| Đề xuất ngân sách | Có chi phí, kết quả kiểm định và người duyệt quyết định |

So mô hình với quy tắc đơn giản, kiểm tra độ chính xác xác suất và suy giảm chất lượng theo thời gian. Chưa tốt hơn thì giữ quy tắc; không xây mô hình chỉ để có nhãn “AI”. Dự đoán không cho phép chi tiền tự động và không chứng minh quan hệ nhân quả.

## 7. Quyết định tiếp theo

Điền tên doanh nghiệp và website ở [phiếu đầu vào](#pilot-inputs). Sau khi chọn hành trình, chốt một kết quả có thể kiểm tra rồi mới ước lượng công tích hợp. Các công việc trong tài liệu này chưa được đánh dấu đã làm.
