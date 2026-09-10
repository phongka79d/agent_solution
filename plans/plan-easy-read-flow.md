# AgentOS — Luồng dễ hiểu cho người không chuyên kỹ thuật

Đọc phần 1–3 để nắm ý chính trong khoảng 2 phút; toàn bộ bản này khoảng 5 phút.

[Mục lục đầy đủ](README.md) · [Phạm vi bản đầu tiên](delivery/mvp-and-roadmap.md)

Đây là kế hoạch sẽ xây, không phải thông báo hệ thống đã chạy thực tế.

## 1. Chúng ta đang làm gì?

Làm một bộ ba trợ lý AI để doanh nghiệp gắn thêm vào website, ứng dụng và các kênh trò chuyện đang dùng.

| Trợ lý | Công việc chính |
|---|---|
| Marketing | Tiếp nhận khách quan tâm, lấy thông tin cần thiết và chăm sóc khách chưa sẵn sàng mua |
| Sales | Tìm hiểu nhu cầu, giới thiệu sản phẩm phù hợp và hỗ trợ quá trình bán hàng |
| Customer Support | Hướng dẫn sử dụng, giải đáp và xử lý vấn đề của khách |

Mỗi phần được đóng gói thành một **module**, tức một phần chức năng có thể chọn dùng riêng. Doanh nghiệp có thể mua một, hai hoặc cả ba module.

## 2. Luồng khách hàng đầy đủ

```text
Doanh nghiệp chuẩn bị sản phẩm, giá, nội dung và chính sách
↓
Doanh nghiệp chạy quảng cáo trên Facebook / Google
↓
Khách bấm quảng cáo, vào website / chat / form
↓
Marketing tiếp nhận, hỏi nhu cầu và ghi nhận thông tin
↓
Khách sẵn sàng trao đổi mua hàng → chuyển Sales
↓
Sales tư vấn, tra giá, đặt lịch hoặc chuyển nhân viên báo giá
↓
Khách quyết định mua qua quy trình bán hàng của doanh nghiệp
↓
Hệ thống bán hàng xác nhận giao dịch
↓
Support hướng dẫn và hỗ trợ khách
↓
Có nhu cầu gia hạn hoặc mua thêm → chuyển lại Sales
```

Facebook/Google phân phối quảng cáo. Marketing Agent tiếp nhận khách sau khi họ tương tác; nó cũng có thể hỗ trợ soạn nội dung quảng cáo, nhưng không tự thay nền tảng quảng cáo chạy hay chi tiền.

Các nhánh thường gặp:

1. **Khách chưa muốn mua:** tiếp tục chăm sóc nếu khách cho phép; khách yêu cầu dừng thì dừng.
2. **Khách đang dùng sản phẩm gặp lỗi:** vào thẳng Support, không phải đi qua Marketing hay Sales.
3. **Khách chủ động hỏi mua:** có thể vào thẳng Sales.
4. **Doanh nghiệp không mua module tiếp theo:** chuyển nhân viên hoặc công cụ hiện tại của doanh nghiệp.

## 3. Kết nối vào ứng dụng doanh nghiệp như thế nào?

**API là cách hai phần mềm gửi yêu cầu và nhận kết quả với nhau.** Khách hàng vẫn dùng website hoặc ứng dụng quen thuộc.

Ví dụ khách hỏi: “Công ty tôi có 30 người, nên mua gói nào?”

1. Website gửi câu hỏi đến module Sales.
2. Sales đọc thông tin sản phẩm và giá từ nguồn doanh nghiệp cho phép.
3. Sales hỏi thêm điều còn thiếu, rồi gửi câu trả lời về website.
4. Nếu được cấp quyền, Sales ghi kết quả tư vấn vào phần mềm quản lý khách hàng hoặc đặt lịch gặp.
5. Nếu kết nối lỗi, hệ thống báo chưa hoàn tất hoặc chuyển nhân viên; không nói đã đặt lịch hay bán thành công.

Doanh nghiệp **không phải bỏ hệ thống đang dùng hoặc chuyển toàn bộ dữ liệu sang chỗ khác**. Nếu ứng dụng chưa có cách kết nối phù hợp, cần làm rõ cách kết nối trước; không phải ứng dụng nào cũng cắm vào là chạy ngay.

## 4. Vì sao khách không phải kể lại từ đầu?

Ba trợ lý cùng xem phần thông tin được phép của một khách: đã hỏi gì, quan tâm sản phẩm nào, đã mua gì và đang cần giúp việc gì. Phần tổng hợp này gọi là **Customer360**.

Phía sau có bộ phận điều phối chọn đúng trợ lý hoặc nhân viên theo câu hỏi và quyền đã được doanh nghiệp cho phép.

Ví dụ: Sales đã biết khách có 30 người dùng. Khi chuyển Support, thông tin đó đi cùng cuộc trao đổi. Support chỉ hỏi lại nếu thông tin đã cũ hoặc cần xác minh danh tính.

Dữ liệu gốc như giá, đơn hàng và tình trạng thanh toán vẫn do hệ thống doanh nghiệp quản lý. Chỉ nói giao dịch thành công khi có xác nhận từ nguồn đã thống nhất, không chỉ vì khách nói “tôi đã trả tiền”.

## 5. Khi nào phải có nhân viên?

Chuyển người thật khi khách yêu cầu, AI không có câu trả lời đáng tin, cần xử lý giao dịch lớn, giảm giá ngoài quy định, hoàn tiền, hủy dịch vụ hoặc vấn đề pháp lý/bảo mật.

Khi chuyển, nhân viên nhận được thông tin khách, vấn đề, những gì đã thử và việc cần làm tiếp. Trong lúc nhân viên đang phụ trách, AI không tự trả lời chồng lên. Nếu chưa có người nhận, yêu cầu phải được ghi rõ là đang chờ.

## 6. Làm sao bán cùng giải pháp cho nhiều doanh nghiệp?

Giữ nguyên phần mềm chính, thay phần phù hợp với từng công ty:

| Dùng chung | Riêng từng doanh nghiệp |
|---|---|
| Cách ba trợ lý hoạt động và phối hợp | Module được chọn, cách tư vấn và quy trình |
| Khả năng kết nối ứng dụng | Địa chỉ kết nối và quyền được cấp |
| Cách tra cứu và trả lời | Sản phẩm, giá, tài liệu và chính sách |
| Cách kiểm soát và ghi lại công việc | Dữ liệu khách, nhân viên phụ trách và báo cáo |

**Dùng chung phần mềm không có nghĩa là dùng chung dữ liệu khách hàng.** Thông tin của công ty A không được lộ sang công ty B. Một ứng dụng mới có thể cần làm thêm bộ kết nối, nhưng không cần viết lại cả ba trợ lý.

## 7. Bản đầu tiên sẽ làm đến đâu?

| Bản đầu dự kiến | Giai đoạn sau |
|---|---|
| Kết nối website hiện tại / LINE với nguồn sản phẩm, phần mềm quản lý khách và lịch hẹn | Thêm các kênh và ứng dụng khác |
| Sales hỏi nhu cầu, gợi ý sản phẩm, đặt lịch, ghi nhận kết quả | Tự động hóa báo giá theo điều kiện đã duyệt |
| Support trả lời câu hỏi cơ bản, chuyển nhân viên khi cần | Xử lý hỗ trợ chuyên sâu hơn |
| Một quy trình nhắc lại có điều kiện và báo cáo cơ bản | Marketing chăm sóc theo chiến dịch, gia hạn và bán thêm |

Trong bản đầu, nhân viên vẫn xử lý báo giá và xác nhận mua hàng theo quy trình đã chọn. Chưa tự động chi tiền quảng cáo, hoàn tiền hay hủy dịch vụ. Chưa xây mô hình dự đoán riêng.

## 8. Việc cần chốt trước

Ghi tên **một ứng dụng của doanh nghiệp sẽ thử kết nối đầu tiên**. Từ đó mới xác định dữ liệu được dùng, quyền được cấp và quy trình nhỏ nào cần chạy thử.

Chi tiết theo từng phần: [cách đóng gói](product-and-packaging.md), [tình huống khách hàng](customer-lifecycle.md), [kế hoạch thử nghiệm](delivery/mvp-and-roadmap.md).
