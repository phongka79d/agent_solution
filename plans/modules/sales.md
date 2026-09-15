# Mô-đun Bán hàng — Tư vấn đúng và kiểm soát giao dịch

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P1 tập trung tư vấn và chuyển sang quy trình mua hiện có; ưu đãi, đơn hàng và thanh toán tự động phải được bật riêng sau nghiệm thu.

<a id=section-7></a>

## 1. Mục tiêu

Giúp khách chọn giải pháp đủ dùng và đi đến bước mua phù hợp, với giá và điều kiện có căn cứ. Không tối ưu số đơn bằng cách bán sai nhu cầu hoặc giảm giá làm mất hiệu quả kinh tế.

| Bối cảnh | Hỏi tối thiểu | Bước tiếp theo |
|---|---|---|
| Bán lẻ B2C | Nhu cầu, điều kiện dùng, tầm giá nếu cần; thiết bị/kích cỡ/biến thể khi liên quan | Gợi ý vài lựa chọn, giỏ/trang mua hiện có |
| Bán hàng B2B cần tư vấn | Nhu cầu, ngân sách, người quyết định, thời điểm, quy mô | Đặt lịch, chuẩn bị thông tin báo giá, theo dõi cơ hội |
| Khách cũ | Nhu cầu mới và sản phẩm hiện dùng đã xác minh nếu cần | Giữ sản phẩm cũ, mua bổ sung hoặc nâng cấp có lý do |

Không bắt người mua lẻ khai chức vụ hay người phê duyệt. Không ép khách tiết lộ dữ liệu không cần thiết. Trường chưa biết được ghi rõ, không suy đoán.

## 2. Hợp đồng đầu vào và đầu ra

Đầu vào gồm khách/phiên, cuộc trao đổi, nguồn, quyền liên hệ, người phụ trách; nhu cầu; danh mục với mã sản phẩm/phiên bản, giá, đơn vị tiền, thuế/phí, tồn kho/điều kiện; quy tắc và hệ thống xác nhận kết quả. Lịch/CRM/đơn hàng chỉ được dùng khi kết nối cho phép.

Đầu ra gồm lựa chọn, lý do và nguồn; phần chưa rõ; yêu cầu/cơ hội/lịch đã xác nhận khi có; người phụ trách, trạng thái và bước tiếp theo. Một câu tư vấn hoàn thành không có nghĩa đã bán hàng.

Luồng chung:

1. Kiểm tra quyền, mô-đun bật và người đang trả lời; nhận bàn giao nếu có.
2. Dùng thông tin đã có, xác minh khách trước khi đọc dữ liệu riêng.
3. Hỏi phần thiếu theo hành trình đã chọn.
4. Tra sản phẩm và điều kiện hiện hành, lọc nhu cầu, ngân sách, khả năng dùng và tồn kho.
5. Đưa lựa chọn có bằng chứng, nêu đánh đổi; không có món phù hợp thì nói rõ.
6. Khách tự xác nhận bước mua/hẹn; chỉ thực hiện hành động trong danh sách cho phép.
7. Ghi kết quả được hệ thống gốc xác nhận; lỗi chưa rõ phải đối soát trước thử lại.

Với B2B, chuỗi cơ hội tham khảo là mới → đủ điều kiện → tư vấn/trình diễn → đề xuất → thương lượng → thành công/thất bại. Có thể bỏ bước theo cấu hình; chưa phản hồi là đang chờ, không tự ghi thất bại hay thành công.

## 3. Trải nghiệm tư vấn có bằng chứng

| Năng lực | Quy tắc |
|---|---|
| Giải thích thông số | Dùng mô tả đã duyệt; tách thông số đo được khỏi ước tính và điều kiện sử dụng |
| Câu hỏi chọn nhanh | Hỏi từng câu cần thiết, khách có thể bỏ qua hoặc tự gõ |
| So sánh nâng cấp | Xác nhận đúng mẫu cũ/mới, chỉ ra vài khác biệt liên quan; không có bằng chứng thì không nêu phần trăm hiệu năng |
| Khuyên không mua đắt hơn | Nêu phương án đủ dùng hoặc chưa cần mua; không dựng lý do để ép nâng cấp |
| Soát giỏ hàng | Gợi ý sản phẩm trùng/không tương thích dựa dữ liệu; khách xác nhận trước khi sửa |
| Gợi ý đạt miễn phí giao hàng | Hiển thị tổng tiền trước/sau và điều kiện thật; không tự thêm món |
| Kích hoạt mở đầu (First-Touch) | Chờ khách dừng xem > 6–8s hoặc cuộn > 50%; hiển thị bong bóng nhỏ (micro-pill) cạnh nút Mua kèm nút 1-chạm; không bung che màn hình, không đòi SĐT/đăng nhập |

Không chuyển “10.000 mAh” thành số lần sạc cụ thể chỉ bằng suy đoán; không hứa thời gian đun nước, tiền điện, độ yên tĩnh hoặc kết quả sức khỏe từ một thông số đơn lẻ. Ví dụ trong PDF phải được kiểm chứng theo sản phẩm và điều kiện thử trước khi dùng với khách.

## 4. Giá ưu đãi: AI đề xuất, máy chủ quyết định

### 4.1. Phân luồng ý định & Tái định vị trợ cấp giá (Selective Subsidy Discovery)
- **Tuyệt đối im lặng với khách sẵn sàng mua giá gốc**: Nếu khách chỉ hỏi về thông số, công năng, độ bền, bảo hành hoặc thời gian giao hàng, AI tập trung tư vấn chốt đơn theo giá niêm yết, tuyệt đối KHÔNG chủ động đề cập hoặc gợi ý giảm giá.
- **Tái định vị thuật ngữ cho thị trường Đài Loan (Chống nghi ngờ lừa đảo - 詐騙)**:
  - Người tiêu dùng Đài Loan đặc biệt cảnh giác với website lừa đảo (詐騙網站); việc cho khách "trả giá tay đôi với bot" sẽ làm mất uy tín thương hiệu chính hãng.
  - Tuyệt đối không dùng từ "Mặc cả" (討價還價). Thay thế bằng các thuật ngữ thương mại bản địa: **"Trợ cấp chốt đơn tự động" (AI 智能即時補貼)**, **"Đặc quyền thành viên LINE" (LINE 專屬快閃折抵)** hoặc **"Tặng thêm điểm thưởng LINE Points" (加碼送 LINE Points)**.
  - Hiển thị bảo chứng uy tín trong khung chat: **Mã số thuế doanh nghiệp Đài Loan (統一編號 - Tongyi Bianhao)** và chứng nhận tài khoản **LINE Official Account tick xanh/xám**.
- **Bắt tín hiệu nhạy cảm về giá (Price-Sensitivity Triggers)**: Ưu đãi chỉ được kích hoạt khi khách ngần ngại về chi phí (ví dụ: *"giá hơi cao/đắt"*, *"vượt ngân sách"*, *"có mã ưu đãi không"*, *"bên khác rẻ hơn"*).
- **Mở lời có điều kiện**: AI mở gói trợ cấp giới hạn: *"Hệ thống vừa mở thêm 3 suất trợ cấp độc quyền 150 TWD cho đơn hàng xác nhận qua LINE Pay hoặc nhận tại 7-Eleven hôm nay, bạn có muốn nhận suất này không?"*.
- **Nút tương tác động**: Giao diện xuất hiện nút nhanh `[Nhận trợ cấp ngay]` để khách kích hoạt mức giảm sàn mà không cần giằng co.

### 4.2. Nguyên tắc và quy trình duyệt giá sàn
Năng lực mặc cả nằm sau P1. Lớp hội thoại chỉ chuyển nhu cầu và giá khách đề nghị; **không nhận quyền quyết định tiền, không được truy cập hay tiết lộ giá vốn nội bộ, không tự ghi đè giá sàn**. Dữ liệu chi phí chỉ đi tới bộ tính giá máy chủ và vai trò được cấp quyền.

Công thức ngân sách, giá sàn và ví dụ được định nghĩa duy nhất tại [kinh tế đơn hàng](../delivery/analytics.md#unit-economics).

1. Máy chủ đọc giá gốc, chi phí, phiên bản chính sách, tồn kho và quyền áp dụng.
2. Tính tổng lợi ích đã cấp: giảm tiền, mã ưu đãi, trợ phí vận chuyển, chi phí phiếu mua hàng dự kiến và hoa hồng đối tác.
3. Từ chối nếu thiếu dữ liệu, vượt ngân sách, dưới sàn hoặc vi phạm cách kết hợp ưu đãi.
4. Nếu hợp lệ, tạo báo giá gắn với doanh nghiệp, khách/phiên, giỏ hàng, số lượng, tiền tệ, giá, thời hạn và phiên bản chính sách; giữ chỗ ngân sách tương ứng bằng thao tác nguyên tử để nhiều đơn không cùng dùng một phần ngân sách.
5. Khách chấp nhận; khi tạo đơn kiểm tra lại điều kiện và dùng mã hành động chống trùng.
6. Đơn, báo giá và giao dịch thanh toán giữ mã liên kết để đối soát. Chuyển phần ngân sách giữ chỗ thành đã dùng hoặc giải phóng theo trạng thái được xác nhận; kết quả chưa rõ phải đối soát trước khi giải phóng.

Báo giá có thể dùng mã ngẫu nhiên tra phía máy chủ hoặc mã xác thực thông điệp HMAC để kiểm tra tính toàn vẹn. Đây không phải chứng nhận ngân hàng, không tự bảo vệ mọi đường mua hàng; trang thanh toán và API tạo đơn cũng phải áp dụng cùng kiểm tra giá.

Thời hạn 10 phút là lựa chọn thử nghiệm từ PDF, cần nêu thật với khách. Không tạo khan hiếm giả, giả vờ “lỗ vốn” hoặc “xin sếp” để gây áp lực. Hết hạn báo giá không bảo đảm ngân hàng từ chối tiền chuyển muộn.

### 4.3. Luồng xác nhận đơn & Hạ tầng giao nhận siêu thị tiện lợi (CVS COD)
1. **Nút chốt giá kèm đếm ngược (CTA Timer)**: Sau khi máy chủ duyệt mức giá hợp lệ, giao diện chat bung nút hành động: `[Khóa đơn nhận trợ cấp trong X phút]` (TTL 10 phút).
2. **Thu thập thông tin & Chọn điểm nhận hàng siêu thị tiện lợi (7-Eleven / FamilyMart)**:
   - Tại Đài Loan, hơn 60% giao dịch B2C dùng hình thức nhận hàng trả tiền tại siêu thị (超商取貨付款 - CVS COD).
   - Khung thời gian 10 phút áp dụng cho việc **Hoàn tất chọn cửa hàng tiện lợi và khóa đơn (Store Selection TTL)**. Khách mở bản đồ E-Map (tích hợp qua API ECPay/NewebPay), chọn chi nhánh 7-Eleven hoặc FamilyMart gần nhà và điền SĐT nhận thông báo SMS/LINE.
   - Tuân thủ Đạo luật Bảo vệ Dữ liệu Cá nhân Đài Loan (**Taiwan PDPA**): Có hộp kiểm đồng thuận riêng biệt, không tick sẵn.
3. **Thanh toán tức thời & Cổng thanh toán nội địa Đài Loan**:
   - Nếu khách chọn thanh toán trực tuyến: Hỗ trợ chuyển tiếp sang **LINE Pay**, **JKOPAY (街口支付)** hoặc thẻ tín dụng qua cổng **ECPay (綠界科技)** / **NewebPay (藍新金流)**.
   - Nếu khách chọn CVS COD: Khách có 7 ngày để ra cửa hàng tiện lợi nhận hàng và trả tiền mặt. Khách bùng hàng quá 7 ngày sẽ bị hệ thống Customer360 hạ điểm uy tín và khóa quyền nhận ưu đãi lần sau.

### 4.4. Quy trình chuyên biệt theo ngành hàng tại thị trường Đài Loan

#### A. Phân hệ Xe máy điện (High-Ticket EV Scooter O2O)
- **Module tính trợ cấp chính phủ theo hộ khẩu (政府補助試算器)**:
  - Khách mua xe điện tại Đài Loan được hưởng 3 tầng trợ cấp: Trợ cấp Bộ Kinh tế (經濟部), Trợ cấp Cục Môi trường (環保署), và Trợ cấp của chính quyền thành phố (Đài Bắc, Tân Bắc, Đào Viên, Cao Hùng...) kèm chính sách đổi xe xăng cũ (汰舊換新).
  - AI hỏi hộ khẩu và tình trạng xe cũ của khách để máy chủ tự động khấu trừ tiền trợ cấp (thường từ 10.000–20.000 TWD) và đưa ra mức giá lăn bánh thực tế.
- **Tích hợp bản đồ mạng lưới trạm đổi pin (Gogoro Network / Kymco Ionex)**: AI định vị trạm đổi pin gần nhà khách trong bán kính 1km để giải tỏa triệt để nỗi lo hết điện.
- **Phễu O2O (Online-to-Offline)**: AI không chốt bán đứt xe trực tuyến mà hướng tới **Đặt lịch lái thử tại Showroom (預約門市試乘)** và nhận cọc giữ chỗ 1.000–2.000 TWD có hoàn lại. Hồ sơ sau đó được bàn giao cho đại lý hỗ trợ khách làm thủ tục đăng kiểm và bấm biển số tại Trạm Đăng kiểm (監理所).

#### B. Phân hệ Hàng tiêu dùng (FMCG D2C)
- **Mô hình Giao định kỳ (定期購 / Subscription)**: Cho phép khách hàng thiết lập chu kỳ giao tự động 30 hoặc 60 ngày đến siêu thị 7-Eleven quen thuộc; đơn giao định kỳ tự động áp dụng mức giá sàn $P_{floor}$ rẻ hơn 15% mà không cần đàm phán từng lần.
- **Tích điểm LINE Points**: Điểm thưởng quy đổi trực tiếp thành LINE Points để khách có thể chi tiêu trong hệ sinh thái bán lẻ tại Đài Loan. Kèm Basket Cap (tối đa 1.000–2.000 TWD) để chặn con buôn gom hàng sỉ.

## 5. Hỗ trợ thanh toán, giao hàng và hóa đơn

P1 dùng trang thanh toán/quy trình hiện có; AI không tự tạo mã thanh toán hoặc đánh dấu đã trả tiền.

Sau P1, ưu tiên kết nối nhà cung cấp/hệ thống doanh nghiệp đã dùng. Lưu lựa chọn ứng dụng thanh toán nếu khách cho phép; không lưu thông tin đăng nhập ngân hàng, mã OTP hoặc dữ liệu sinh trắc học. Có phương án QR, sao chép thông tin hay trang thanh toán thay thế nếu liên kết mở ứng dụng không hoạt động.

Khách vẫn kiểm tra thông tin và xác nhận trong ứng dụng ngân hàng; đây là luồng được NAPAS mô tả, không phải thanh toán AI tự quyết. [Nguồn NAPAS](https://www.napas.com.vn/dich-vu-chuyen-tien-nhanh-napas-247).

Thanh toán chỉ xác nhận bằng nguồn tin cậy, không bằng ảnh chụp hoặc trang quay về. [API và tích hợp](../platform/api-and-integrations.md#payments) quy định đối soát và nhánh trả tiền muộn/thiếu/thừa.

Khung giờ giao và yêu cầu hóa đơn chỉ được chuyển tới hệ thống có năng lực tương ứng. Thu mã số thuế không có nghĩa hóa đơn đã phát hành; chọn khung giờ không có nghĩa đã được đơn vị vận chuyển chấp nhận.

## 6. Ranh giới bản đầu

| Cho phép trong P1 | Chưa cho phép trong P1 |
|---|---|
| Hỏi nhu cầu, giải thích từ nguồn duyệt, lưu ghi chú và bước tiếp theo | Sửa giá, mã khuyến mãi, tự mặc cả hoặc phát phiếu |
| Đọc danh mục và chuyển khách tới quy trình mua hiện có | Tạo/thu thanh toán, hoàn tiền, hủy đơn hoặc sửa tài khoản |
| Cập nhật trường khách/yêu cầu/CRM đã được cấp quyền | Cập nhật hàng loạt hoặc trường ngoài danh sách |
| Đặt một lịch được xác nhận nếu cấu hình B2B chọn lịch | Tự đổi/hủy lịch hoặc báo đặt thành công khi chưa có mã |
| Chuẩn bị thông tin để nhân viên báo giá | Tự phát hành báo giá thương mại |
| Một chuỗi nhắc tối đa hai tin khi đủ điều kiện | Nhắc vô hạn, gửi sau khi khách trả lời/từ chối hoặc người tiếp quản |

## 7. Ngoại lệ và nghiệm thu

| Tình huống | Kết quả bắt buộc |
|---|---|
| Sản phẩm/giá cũ hoặc thiếu | Không đưa giá cuối; làm mới hoặc chuyển người |
| Không có sản phẩm phù hợp | Nêu giới hạn và lựa chọn tiếp theo; không bịa sản phẩm |
| Chưa xác minh khách | Chỉ dùng thông tin công khai/phiên hợp lệ |
| Ghi CRM hoặc đặt lịch bị hết thời gian chờ | Tra kết quả bằng mã đối soát; không tạo trùng |
| Đơn lớn, giá ngoại lệ hoặc khách muốn gặp người | Bàn giao có người chịu trách nhiệm, AI tạm dừng |
| Mô-đun Bán hàng chưa bật | Từ chối rõ hoặc hàng đợi người xử lý |
| Yêu cầu giá 0, sửa giỏ/báo giá/tiền tệ từ trình duyệt | Máy chủ từ chối; không thể lách bằng nội dung nhắc AI |
| Báo giá/đơn hết hạn nhưng có tiền tới | Trạng thái cần đối soát, không bỏ tiền hoặc giao hàng tự động |
| Tư vấn xong nhưng chưa có giao dịch nguồn | Hoàn thành tư vấn, không tính doanh thu |

Mỗi kết quả cần nguồn, phiên bản, mã truy vết và người phụ trách. Bộ thử ưu đãi/QR chỉ áp dụng khi bật năng lực tương ứng, không được coi là đã vượt qua trong P1.
