# Agent — Luồng, đọc là hiểu

Đọc phần 1–3 để nắm ý chính trong khoảng 2 phút; toàn bộ bản này khoảng 5 phút.

[Mục lục đầy đủ](README.md) · [Bảng thuật ngữ](glossary.md) · [Phạm vi bản đầu tiên](delivery/mvp-and-roadmap.md)

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

Chi tiết từng chặng:

| Chặng | Điều gì xảy ra | Kết quả cần có |
|---|---|---|
| 1. Quảng cáo | Doanh nghiệp tự tạo và chạy quảng cáo trên Facebook/Google | Nền tảng quảng cáo phân phối quảng cáo |
| 2. Khách bấm | Khách bấm vào quảng cáo | Khách đến website, landing page, chat hoặc form của doanh nghiệp |
| 3. Gửi yêu cầu | Website/app gửi câu hỏi hoặc form sang AgentOS | Mã yêu cầu, mã cuộc trao đổi và nguồn quảng cáo nếu có |
| 4. Marketing | Marketing Module hỏi nhu cầu, lưu thông tin và xin phép liên hệ | Lead, nguồn, nội dung quan tâm, trạng thái cho phép liên hệ |
| 5. Đánh giá | Hệ thống kiểm tra khách đã đủ thông tin và có nhu cầu rõ chưa | Đủ điều kiện chuyển Sales, hoặc tiếp tục chăm sóc |
| 6. Sales | Sales Module hỏi sâu hơn, tra sản phẩm, đặt lịch và ghi nhận cơ hội | Thông tin tư vấn, cơ hội bán hàng và bước tiếp theo |
| 7. Xác nhận mua | Khách mua theo quy trình hiện tại của doanh nghiệp | Chỉ ghi “đã mua” khi hệ thống bán hàng xác nhận |
| 8. Support | Support Module hướng dẫn và xử lý vấn đề sau mua | Câu trả lời, trạng thái đã giải quyết hoặc yêu cầu cho nhân viên |
| 9. Gia hạn/mua thêm | Dữ liệu sử dụng hoặc câu hỏi mới cho thấy nhu cầu mở rộng | Tín hiệu chuyển lại Sales, không tự coi là đơn hàng |

Nếu module Marketing không được bật, khách có thể đi thẳng vào Sales hoặc hàng đợi nhân viên. Nếu Sales không được bật, việc tư vấn/chốt đơn chuyển nhân viên. Nếu Support không được bật, yêu cầu hỗ trợ đi về công cụ hoặc nhân viên hiện tại của doanh nghiệp.

Facebook/Google phân phối quảng cáo. Marketing Agent tiếp nhận khách sau khi họ tương tác; nó cũng có thể hỗ trợ soạn nội dung quảng cáo, nhưng không tự thay nền tảng quảng cáo chạy hay chi tiền.

Các nhánh thường gặp:

1. **Khách chưa muốn mua:** tiếp tục chăm sóc nếu khách cho phép; khách yêu cầu dừng thì dừng.
2. **Khách đang dùng sản phẩm gặp lỗi:** vào thẳng Support, không phải đi qua Marketing hay Sales.
3. **Khách chủ động hỏi mua:** có thể vào thẳng Sales; nếu Sales chưa bật thì chuyển nhân viên.
4. **Khách cần hỗ trợ:** có thể vào thẳng Support; nếu Support chưa bật thì chuyển công cụ hoặc nhân viên hiện tại.
5. **Doanh nghiệp không mua module tiếp theo:** giữ thông tin ở module đang có và chuyển phần việc cho nhân viên.

### Marketing làm gì sau khi khách bấm quảng cáo?

1. Nhận câu hỏi hoặc form từ website/chat của doanh nghiệp. Chỉ bấm vào quảng cáo chưa có nghĩa khách đã để lại thông tin.
2. Lưu khách đến từ đâu, quan tâm sản phẩm nào, đã hỏi gì và có cho phép liên hệ lại không.
3. Hỏi thêm thông tin còn thiếu, ví dụ nhu cầu, số lượng cần mua hoặc thời điểm muốn sử dụng.
4. Đánh giá mức phù hợp theo quy tắc doanh nghiệp đặt ra. Đây là **lead scoring**, tức chấm điểm mức quan tâm/phù hợp, không phải dự đoán chắc chắn khách sẽ mua.
5. Nếu khách chưa sẵn sàng, chỉ gửi nội dung chăm sóc khi được phép. Khách trả lời, yêu cầu dừng hoặc nhân viên tiếp quản thì chuỗi nhắc tự dừng.
6. Nếu khách có nhu cầu rõ, chuyển thông tin sang Sales. Sales phải nhận bàn giao rồi mới trở thành bên phụ trách.
7. Nếu doanh nghiệp không bật Sales, chuyển nhân viên bán hàng của doanh nghiệp, không tự mở module Sales.

**Kết quả:** một lead, tức một khách đã thể hiện quan tâm, kèm lịch sử và việc cần làm tiếp. Chưa phải đơn hàng.

### Sales tư vấn và theo dõi bán hàng ra sao?

1. Nhận khách từ Marketing hoặc nhận thẳng câu hỏi mua hàng trong website/app.
2. Đọc thông tin đã có để không hỏi lại vô ích; chỉ xác minh thêm khi cần bảo vệ dữ liệu riêng.
3. Hỏi bốn nhóm chính: khách cần gì, ngân sách bao nhiêu, ai quyết định mua, khi nào cần. Bước này gọi là **qualification**, nghĩa là kiểm tra khách có phù hợp để tiếp tục bán hàng không.
4. Tra sản phẩm, giá và điều kiện trong hệ thống của doanh nghiệp; không tự bịa giá hoặc ưu đãi.
5. Đề xuất lựa chọn phù hợp. Nếu khách muốn gặp, kiểm tra lịch và chỉ báo đặt lịch thành công sau khi hệ thống lịch xác nhận.
6. Trong bản đầu, chuẩn bị thông tin để nhân viên làm báo giá. Giao dịch lớn hoặc giảm giá ngoài quy định luôn cần người duyệt.
7. Ghi kết quả vào phần mềm quản lý khách hàng (**CRM**) và nhắc lại khi được phép.
8. Chỉ ghi “bán thành công” khi hệ thống doanh nghiệp xác nhận. Khách chưa trả lời là “đang chờ”, không tự coi là đã mua hoặc đã từ chối.

**Kết quả:** thông tin tư vấn, lịch hẹn hoặc một cơ hội bán hàng đang được theo dõi. Cơ hội bán hàng (**opportunity**) là việc có thể bán được, không phải doanh thu đã nhận.

### Support xử lý sau mua ra sao?

1. Nhận câu hỏi từ website/app/chat hiện tại của doanh nghiệp. Khách có thể vào thẳng Support.
2. Nếu câu hỏi cần xem đơn hàng hoặc tài khoản, xác minh đúng khách trước; câu hỏi chung có thể trả lời bằng thông tin công khai.
3. Tra tài liệu đã được duyệt, gọi là **knowledge base**, tức kho hướng dẫn và câu hỏi thường gặp.
4. Hướng dẫn các bước xử lý đã được doanh nghiệp cho phép, ghi lại bước nào đã thử và kết quả.
5. Hỏi khách vấn đề đã hết chưa. Chỉ gửi một câu trả lời chưa đủ để đánh dấu đã giải quyết.
6. Nếu chưa xử lý được, tạo vụ việc trong hệ thống hỗ trợ nếu đã kết nối; nếu chưa có kết nối thì đưa vào danh sách chờ nhân viên. Vụ việc có mã theo dõi thường gọi là **ticket**.
7. Chuyển nhân viên kèm thông tin khách, vấn đề, các bước đã thử, mức ưu tiên và việc cần làm tiếp. Trong lúc nhân viên phụ trách, AI không trả lời chồng lên.
8. Nếu khách có nhu cầu mua thêm, ghi nhận và chuyển Sales; Support không tự hứa giá hoặc tự nâng gói.

**Kết quả:** vấn đề đã được khách xác nhận giải quyết, hoặc một nhân viên chịu trách nhiệm xử lý tiếp. Nếu kết nối lỗi thì báo đang chờ/chưa hoàn tất, không báo thành công giả.

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

Các module đang được bật cùng xem phần thông tin được phép của một khách: đã hỏi gì, quan tâm sản phẩm nào, đã mua gì và đang cần giúp việc gì. Phần tổng hợp này gọi là **Customer360**.

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
| Cách các module đã bật hoạt động và phối hợp | Module được chọn, cách tư vấn và quy trình |
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
| Một quy trình Sales nhắc lại có điều kiện, tối đa hai tin, và báo cáo cơ bản | Marketing chăm sóc theo chiến dịch, gia hạn và bán thêm |

Trong bản đầu, nhân viên vẫn xử lý báo giá và xác nhận mua hàng theo quy trình đã chọn. Quy trình nhắc lại thuộc Core/Sales, không phải Marketing chăm sóc theo chiến dịch. Chưa tự động chi tiền quảng cáo, hoàn tiền hay hủy dịch vụ. Chưa xây mô hình dự đoán riêng.

## 8. Việc cần chốt trước

Ghi tên **một ứng dụng của doanh nghiệp sẽ thử kết nối đầu tiên**. Từ đó mới xác định dữ liệu được dùng, quyền được cấp và quy trình nhỏ nào cần chạy thử.

Chi tiết theo từng phần: [cách đóng gói](product-and-packaging.md), [tình huống khách hàng](customer-lifecycle.md), [kế hoạch thử nghiệm](delivery/mvp-and-roadmap.md).

## 9. Bảng giải thích nhanh

| Từ | Hiểu đơn giản là |
|---|---|
| Module | Một phần chức năng có thể mua/bật riêng |
| API | Cách website/app nói chuyện với AgentOS |
| Lead | Người đã thể hiện quan tâm |
| CRM | Phần mềm công ty dùng để quản lý khách và cơ hội bán |
| Customer360 | Bản tổng hợp thông tin được phép xem về khách |
| Workflow | Chuỗi bước có điều kiện và thời gian |
| Handoff | Bàn giao cho module khác hoặc nhân viên |
| Webhook | Thông báo tự động từ hệ thống công ty khi có sự kiện |
| MVP | Bản đầu tiên đủ nhỏ để chạy thử và đo kết quả |

Muốn xem nghĩa đầy đủ hơn, mở [glossary.md](glossary.md).
