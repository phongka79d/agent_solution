# AgentOS — Bản kế hoạch đọc trong 5 phút

Bắt đầu bằng câu hỏi: **Doanh nghiệp nào sẽ thử nghiệm, trên website nào, để giải quyết một vấn đề mua hàng cụ thể?**

[Mục lục](README.md) · [Thuật ngữ](glossary.md) · [Bản đầu và lộ trình](delivery/mvp-and-roadmap.md)

Đây là kế hoạch đề xuất, chưa phải hệ thống đã hoạt động. Các ví dụ là giả thuyết để thử, không phải cam kết kết quả.

## 1. Sản phẩm làm gì?

Ba trợ lý AI gắn vào ứng dụng đang có của doanh nghiệp:

| Trợ lý | Việc chính | Không được tự làm |
|---|---|---|
| Tiếp thị | Tìm hiểu thị trường, phát hiện nhu cầu sớm, tìm đối tác, tiếp nhận khách quan tâm | Thu gom dữ liệu cá nhân hoặc gửi quảng cáo khi chưa đủ điều kiện |
| Bán hàng | Hỏi đúng nhu cầu, giải thích sản phẩm, gợi ý lựa chọn và hỗ trợ mua | Bịa công dụng, sửa giá, hứa đã thanh toán |
| Chăm sóc khách hàng | Hướng dẫn, giải quyết câu hỏi, theo dõi vấn đề và chuyển nhân viên | Tự duyệt hoàn tiền, đổi trả hay bỏ qua xác minh khách |

Doanh nghiệp có thể bật một, hai hoặc cả ba mô-đun. Khi mô-đun cần dùng chưa bật, chuyển nhân viên hoặc công cụ hiện có; không tự mở thêm mô-đun.

## 2. Hành trình hợp nhất

```text
Hiểu vấn đề khách đang hoặc sắp gặp
→ Tìm tín hiệu sớm và nơi khách tập trung
→ Kiểm chứng giải pháp, thông điệp và đối tác
→ Khách đến website từ đối tác / tìm kiếm / quảng cáo / giới thiệu
→ Tư vấn theo nhu cầu, kèm bằng chứng
→ Khách mua qua quy trình của doanh nghiệp
→ Hệ thống gốc xác nhận giao dịch
→ Hướng dẫn và chăm sóc
→ Khách dùng tốt, có thể mua lại hoặc giới thiệu
→ Kết quả thực tế quay về cải thiện nghiên cứu và sản phẩm
```

Đây không phải chuỗi bắt buộc: khách muốn mua có thể vào thẳng Bán hàng; khách gặp sự cố vào thẳng Chăm sóc.

### Ví dụ: chuẩn bị kết nối khi sang Đài Loan

1. Tìm hiểu người chuẩn bị đi cần kết nối khi nào và đang vướng điều gì.
2. Xem trung tâm học tiếng, đơn vị du học hoặc đối tác phù hợp có thể giúp giới thiệu giải pháp không.
3. Đối tác cung cấp đường dẫn để khách tự xem và tự đăng ký; không chuyển danh sách học viên tùy tiện.
4. AI hỏi nơi đến, thời gian dùng, thiết bị và nhu cầu dữ liệu, rồi tra sản phẩm được duyệt.
5. Chỉ hứa khả năng kích hoạt hoặc dùng ngay khi có căn cứ từ nhà cung cấp.
6. Sau mua, hỗ trợ kích hoạt; ghi nhận vấn đề để cải thiện nội dung và lựa chọn sản phẩm.

Đây là ví dụ vận dụng tài liệu thị trường, **chưa phải quyết định chọn ngành SIM**. Thứ tự học tiếng, xin visa, đặt vé cũng không giống nhau ở mọi người.

## 3. Khác biệt đáng thử

| Ý tưởng | Giá trị mong muốn | Cách làm nhỏ trước |
|---|---|---|
| Tiếp cận trước khi nhu cầu đạt đỉnh | Xuất hiện đúng thời điểm, giảm lệ thuộc quảng cáo | Nhân viên duyệt một bản đồ nhu cầu và một nhóm đối tác |
| Giải thích thông số bằng ngôn ngữ đời thường | Giúp khách hiểu và chọn đúng | Viết nội dung từ tài liệu đã duyệt, không bịa thời lượng hay hiệu suất |
| Chọn nhanh bằng vài câu hỏi | Giảm nhập liệu trên điện thoại | Hỏi nhu cầu, điều kiện dùng, tầm giá; cho phép bỏ qua |
| Gợi ý “chưa cần mua đắt hơn” | Tăng độ tin cậy, giảm mua sai | Nêu phương án đủ dùng hoặc giữ sản phẩm cũ nếu có căn cứ |
| Ưu đãi có giới hạn kinh tế | Chia một phần chi phí thực sự tiết kiệm cho khách | Tính giá bằng máy chủ, chạy thử nội bộ trước khi cho AI đàm phán |
| Bảo vệ giá bằng phiếu mua lần sau | Giảm lo mua hớ và thử khả năng mua lại | Thử có người duyệt, ngân sách và điều kiện rõ ràng |
| Phản hồi sau mua quay lại nghiên cứu | Sửa vấn đề thật thay vì chỉ tăng lượng tin nhắn | Tổng hợp lý do không mua, đổi trả và câu hỏi lặp lại để người phụ trách xem |

Không khẳng định những ý này chưa từng có trên thị trường. Lợi thế cần được chứng minh qua kết quả của doanh nghiệp thử nghiệm.

## 4. Khách trải nghiệm thế nào?

1. Khách vẫn dùng website quen thuộc; có thể xem và hỏi chung mà không buộc để lại số điện thoại.
2. AI chỉ hỏi dữ liệu cần cho nhu cầu đang giải quyết. Khi khách đặt giao hàng, thu thông tin giao nhận theo quy trình hiện tại.
3. Nút trả lời nhanh hoặc phần giải thích sản phẩm giúp giảm gõ. Không bật nhiều cửa sổ cùng lúc.
4. Giá, tồn kho và chính sách đến từ nguồn doanh nghiệp cho phép.
5. Trong bản đầu, khách thanh toán bằng trang/quy trình có sẵn; AI chưa tự tạo ưu đãi hay giao dịch.
6. Hỗ trợ riêng về đơn hàng cần xác minh đúng khách. Muốn gặp nhân viên thì được chuyển ngay, không phải trả lời hết bộ câu hỏi.

Số điện thoại giao hàng **không tự trở thành quyền gửi quảng cáo**. Khách từ chối nhận tin thì chuỗi liên hệ phù hợp phải dừng.

## 5. Vì sao khách không cần kể lại từ đầu?

Customer360 là bản tổng hợp phần thông tin được phép: khách đã hỏi gì, nguồn nào giới thiệu, sản phẩm quan tâm, đơn hàng đã xác nhận và vấn đề chưa xử lý.

Mỗi cuộc trao đổi chỉ có một bên đang trả lời: một mô-đun hoặc nhân viên. Bàn giao phải có người nhận, tóm tắt và bước tiếp theo. Chưa ai nhận thì hiển thị “đang chờ”, không báo “đã xử lý”.

Dữ liệu công ty A không được dùng để trả lời khách công ty B. Giá và đơn hàng vẫn thuộc hệ thống gốc; AI không thể biến câu “tôi đã chuyển khoản” thành giao dịch đã xác nhận.

## 6. Bản đầu làm đến đâu?

| Làm trước | Chờ giai đoạn sau |
|---|---|
| Một doanh nghiệp, một hành trình, website hiện có | Nhiều ngành, nhiều kênh và giao diện nhúng đầy đủ |
| Bán hàng hỏi nhu cầu, tra sản phẩm, giải thích có nguồn | Mặc cả tự động, ưu đãi kết hợp, thanh toán QR mới |
| Chăm sóc trả lời câu hỏi phổ biến, chuyển nhân viên | Vận chuyển, phiếu bù giá, đổi trả chuyên sâu |
| Hồ sơ khách hợp nhất, quyền riêng, nhật ký, báo cáo | Nhiều kênh, trình kéo-thả quy trình và tự động hóa nâng cao |
| Tối đa một chuỗi nhắc với hai tin, chỉ khi đủ điều kiện liên hệ | Chăm sóc Tiếp thị theo chiến dịch |
| Nghiên cứu thị trường thủ công có AI hỗ trợ soạn nháp | Tự động tìm kiếm và quản lý mạng lưới đối tác |

Lịch hẹn chỉ thêm nếu doanh nghiệp bán theo lịch tư vấn. LINE, Zalo và các kênh khác cần chọn, kiểm tra kết nối riêng; không bắt buộc đồng thời.

## 7. Đánh giá thành công bằng gì?

Không chỉ nhìn số tin nhắn hoặc số đơn. Theo dõi khách chọn đúng hơn không, có người nhận bàn giao không, chi phí phục vụ có giảm không và **lãi đóng góp sau chi phí có tốt hơn không**.

Khi chưa kết nối được đơn hàng hoặc chi phí, báo “chưa có dữ liệu”, không ghi bằng 0. Giao dịch có AI tham gia không tự chứng minh AI tạo thêm doanh thu; cần phép thử phù hợp.

**Bước tiếp theo, khoảng 2 phút:** ghi tên doanh nghiệp và website thử nghiệm vào [phiếu đầu vào](delivery/mvp-and-roadmap.md#pilot-inputs).
