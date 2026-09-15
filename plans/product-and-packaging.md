# Sản phẩm, cấu hình và cách đóng gói

[Mục lục](README.md) · [Bản dễ hiểu](plan-easy-read-flow.md) · [Thuật ngữ](glossary.md)

Trạng thái: đề xuất. Định hướng ngành, mức giá, ngân sách và hiệu quả cần doanh nghiệp thử nghiệm xác nhận.

<a id=section-1></a>

## 1. Bài toán và giá trị sản phẩm

AgentOS Customer360 giúp doanh nghiệp không bỏ sót nhu cầu, tư vấn nhất quán và nối thông tin từ trước mua đến sau mua. Sản phẩm không thay website, phần mềm quản lý khách hàng hay hệ thống bán hàng đang có.

Định vị đề xuất: **Hiểu nhu cầu sớm, tư vấn có bằng chứng, hỗ trợ giao dịch có kiểm soát và chăm sóc xuyên suốt.**

Ba nguồn bổ sung cho nhau: kế hoạch cũ cung cấp nền tảng vận hành; PDF bổ sung trải nghiệm B2C và kinh tế ưu đãi; tài liệu thị trường bổ sung cách tìm nhu cầu, đối tác và tăng trưởng sau mua. Giá trị không nằm ở việc có nhiều trợ lý AI, mà ở kết quả được xác nhận và khả năng triển khai lại.

### Thị trường mỏ neo đầu tiên và Định hướng B2B SaaS
Hệ thống được thiết kế theo mô hình **B2B SaaS đa doanh nghiệp (Multi-tenant)**, giải quyết bài toán tư vấn, bán hàng và chăm sóc khách hàng tự động để bán cho $N$ doanh nghiệp trong tương lai.

**Khách hàng mỏ neo đầu tiên (Anchor Client)**: Doanh nghiệp tại **Đài Loan** kinh doanh bán lẻ B2C trực tiếp cho người tiêu dùng Đài Loan, tập trung vào hai nhóm ngành:
1. **Hàng tiêu dùng (FMCG)**: Tối ưu cho tốc độ, giảm giá theo combo/định kỳ (定期購 / Subscription), tích điểm LINE Points và nhận hàng qua chuỗi siêu thị tiện lợi (7-Eleven / FamilyMart CVS COD).
2. **Xe máy điện (High-Ticket EV)**: Tối ưu cho mô hình O2O (Online-to-Offline), tích hợp bộ tính trợ cấp chính phủ theo hộ khẩu (政府補助), bản đồ mạng lưới trạm đổi pin (Gogoro/Ionex), và đặt lịch lái thử tại showroom (預約試乘) kèm cọc giữ chỗ có hoàn lại.

Toàn bộ giải pháp vận hành theo nguyên tắc tách rời: **Lõi thông minh dùng chung (Core Engine)** và **Tầng kết nối địa phương hóa (Taiwan Localization Adapter)**.

### Chiến lược 4 bước nhân rộng B2B SaaS ra toàn cầu

Để nhân rộng giải pháp từ mô hình khách hàng mỏ neo Đài Loan ra $N$ doanh nghiệp toàn cầu, hệ thống triển khai 4 bước chiến lược chuẩn hóa:

1. **Cơ chế Phích cắm bản địa (Plug-and-Play Adapters)**:
   - Giữ nguyên 100% Lõi AI (Core AI Engine), Customer360, máy chủ tính giá sàn toán học ($P_{floor}$) và máy trạng thái quy trình.
   - Hoán đổi giữa Gói adapter Đài Loan (**ADPT-TW-001**) và các Cổng kết nối toàn cầu (**ADPT-GL-001..003**):
     - *Cổng giao tiếp (Communication Port - ADPT-GL-001)*: Đài Loan dùng LINE Official Account (LINE OA) + Web Widget; Thị trường quốc tế hoán đổi sang WhatsApp Business API, Telegram hoặc Web Widget đa ngôn ngữ.
     - *Cổng thanh toán & đối soát (Payment Port - ADPT-GL-002)*: Đài Loan dùng ECPay, NewebPay, LINE Pay và 7-Eleven/FamilyMart CVS COD; Thị trường quốc tế hoán đổi sang Stripe, PayPal, Apple Pay, Google Pay hoặc COD bưu điện nội địa.
     - *Cổng pháp lý & hạ tầng dữ liệu (Compliance Port - ADPT-GL-003)*: Đài Loan tuân thủ Taiwan PDPA lưu trữ tại cụm máy chủ GCP Changhua / AWS Taipei; Thị trường quốc tế chuyển sang GDPR (Châu Âu), CCPA (Mỹ), PDPA (Singapore) với các module quản lý cookie và thu thập đồng ý (Consent Management).

2. **GTM-001: Đóng gói thành 2 sản phẩm chuyên ngành (Vertical SaaS Packaging)**:
   - Thay vì bán nền tảng chung chung, giải pháp được đóng gói thành 2 sản phẩm chuyên biệt:
     - **GTM-001A: AgentOS Mobility Edition**: Dành cho ngành xe điện và phương tiện giao thông O2O giá trị cao (tích hợp DOM-MOB-001..004: luồng O2O, bộ tính trợ cấp chính phủ theo hộ khẩu, bản đồ trạm sạc & đổi pin thời gian thực, luồng đặt lịch lái thử tại showroom với cọc giữ chỗ hoàn lại và thẩm định sơ bộ hồ sơ mua trả góp).
     - **GTM-001B: AgentOS FMCG Edition**: Dành cho thương mại điện tử hàng tiêu dùng nhanh, subscription và CVS COD (tích hợp DOM-FMCG-001..005: thuật toán giỏ hàng thông minh, tư vấn combo tương thích, cơ chế mua hàng định kỳ Subscription / 定期購 tự động áp mức giá sàn P_floor, chọn điểm nhận siêu thị tiện lợi CVS COD, tích điểm tiến độ Endowed Progress LINE Points và bộ lọc chống bùng hàng siêu thị).

3. **GTM-002: Phân phối quy mô qua Shopify & WooCommerce 1-Click App Store Integration**:
   - Đóng gói giải pháp thành ứng dụng cài đặt 1-chạm (1-click install app) trên hai kho ứng dụng thương mại điện tử lớn nhất toàn cầu: **Shopify App Store** và **WooCommerce Marketplace**.
   - Tự động đồng bộ sản phẩm, bảng giá sàn, đơn hàng và tồn kho qua Shopify GraphQL Admin API và WooCommerce REST API.
   - Tiếp cận hàng trăm nghìn nhà bán lẻ trực tuyến toàn cầu (Global Merchants) theo mô hình Tăng trưởng dựa trên sản phẩm (Product-Led Growth - PLG) với chi phí thu hút khách hàng (CAC) tối thiểu, không cần đội ngũ kinh doanh bán hàng trực tiếp (sales tay).

4. **GTM-003: Đòn bẩy số liệu thực nghiệm Đài Loan để bán toàn cầu (Empirical Social Proof Leverage)**:
   - Sử dụng bộ chỉ số thực tế đo lường được từ đối tác mỏ neo Đài Loan (được định nghĩa và theo dõi tại [analytics.md](delivery/analytics.md)): tỷ lệ tăng chuyển đổi (+25%–40%), độ trễ phản hồi (< 1.5 giây), chi phí AI đơn vị (0.5–1 TWD / phiên tư vấn ECN-003), tỷ lệ tự động hóa CSKH (> 65%) và bảo toàn 100% biên lợi nhuận ròng (ECN-002).
   - Xuất bản dữ liệu thực nghiệm thành Case Study và Whitepaper định lượng làm bằng chứng xã hội (Social Proof) và cam kết ROI để chào bán cho các doanh nghiệp quốc tế tiếp theo.

<a id=section-2></a>

## 2. Ba mô-đun và phần dùng chung

| Phần chọn mua | Năng lực đích | Không sở hữu |
|---|---|---|
| Tiếp thị | Nghiên cứu, định vị, nội dung, đối tác, tiếp nhận, phân nhóm, chăm sóc có phép | Ngân sách quảng cáo tự quyết hoặc dữ liệu cá nhân của đối tác |
| Bán hàng | Hỏi nhu cầu, gợi ý, giải thích, giỏ hàng, hẹn/báo giá nếu cần; ưu đãi và thanh toán khi được bật | Giá vốn, giá sàn, quyền phê duyệt tiền và sổ giao dịch gốc |
| Chăm sóc khách hàng | Hướng dẫn, tra trạng thái khi có kết nối, ghi vụ việc, bàn giao, tín hiệu mua lại | Quyền tự hoàn tiền, hủy hoặc thay quyết định chuyên môn |

Lõi dùng chung: bộ điều phối, Customer360, kho kiến thức được duyệt, quy trình bền vững, quy tắc máy chủ, bộ kết nối, quyền, nhật ký và báo cáo. Một mô-đun vẫn hoạt động độc lập; phần việc ngoài phạm vi đi tới nhân viên hoặc ứng dụng hiện có.

Nghiên cứu, chiến lược, thu hút khách và đo hiệu quả là bốn vai trò trong Tiếp thị. Chưa cần bốn dịch vụ hay bốn hệ thống AI riêng. Giữ chân khách và giới thiệu là quy trình liên mô-đun.

<a id=section-17></a>

## 3. Cấu hình thay vì sao chép sản phẩm

| Dùng chung trong phần mềm | Cấu hình riêng từng doanh nghiệp |
|---|---|
| Luồng gọi AI, điều phối, kiểm tra quyền | Mô-đun bật, giọng điệu, ngôn ngữ, trường cần hỏi |
| Quy trình, bộ hẹn giờ, kiểm soát bàn giao | Người phụ trách, giờ làm việc, mức phê duyệt, giới hạn liên hệ |
| Customer360 và truy xuất kiến thức | Danh mục, tài liệu, chính sách và dữ liệu khách được phép |
| Bộ kết nối và chuẩn sự kiện | Địa chỉ API, ánh xạ trường, phạm vi quyền, tham chiếu bí mật |
| Đo lường và nhật ký | Định nghĩa kết quả, nguồn xác nhận, đường cơ sở và ngưỡng dừng |

Bộ cấu hình cần có chủ sở hữu, phiên bản, tài liệu/bảng giá đã duyệt, quyền đọc/ghi, quy tắc chuyển người, bộ tình huống thử và phiên bản có thể quay lại. Bí mật kết nối nằm trong kho bảo vệ, không nằm trong lời hướng dẫn AI hay mã trình duyệt.

Mục tiêu tái sử dụng 80–90% của bản cũ được giữ như **giả thuyết thiết kế**, không dùng làm cam kết bán hàng. Bằng chứng tối thiểu là cùng một bản phần mềm chạy với hai cấu hình doanh nghiệp tách biệt; kết nối nhà cung cấp mới có thể vẫn cần phát triển thêm.

<a id=section-19></a>

## 4. Đóng gói và triển khai

Bán theo hai hình thức đóng gói chính:
1. **Theo mô-đun chức năng**: Từng mô-đun (Tiếp thị, Bán hàng, Chăm sóc) hoặc trọn bộ cả ba. Gói cả ba không phải mô-đun thứ tư.
2. **Theo giải pháp ngành dọc (Vertical SaaS - GTM-001)**:
   - **GTM-001A: AgentOS Mobility Edition**: Dành cho xe điện & phương tiện giao thông O2O. Đóng gói sẵn toàn bộ nghiệp vụ xe điện (DOM-MOB-001..004: O2O showroom, tính trợ cấp chính phủ theo hộ khẩu, bản đồ trạm sạc/pin thời gian thực, cọc lái thử hoàn lại và thẩm định trả góp).
   - **GTM-001B: AgentOS FMCG Edition**: Dành cho bán lẻ tiêu dùng, subscription, CVS COD. Đóng gói sẵn toàn bộ nghiệp vụ bán lẻ tiêu dùng (DOM-FMCG-001..005: giỏ hàng thông minh, giao định kỳ Subscription 定期購, chọn điểm nhận siêu thị tiện lợi CVS COD, tích điểm tiến độ LINE Points và bộ lọc chống bùng hàng).

Hình thức triển khai và phân phối:
- **Tùy biến cho doanh nghiệp lớn (Custom Enterprise)**: Nhúng mã website (`nexus-sales.min.js`), tích hợp API trực tiếp từ máy chủ doanh nghiệp, kết nối LINE OA (ADPT-TW-001) hoặc WhatsApp Business (ADPT-GL-001).
- **GTM-002: Phân phối tự động 1-chạm (Shopify & WooCommerce 1-Click App Store Integration)**: Cài đặt trực tiếp từ kho ứng dụng cho hàng trăm nghìn nhà bán lẻ trực tuyến toàn cầu, tự động kích hoạt Core Engine và Plug-and-Play Adapter tương ứng theo quốc gia của merchant.
- **GTM-003: Đòn bẩy số liệu thực nghiệm Đài Loan để bán toàn cầu (Empirical Social Proof Leverage)**: Cam kết ROI dựa trên bộ số liệu vận hành thực tế đã kiểm chứng từ đối tác mỏ neo Đài Loan (tỷ lệ chuyển đổi, chi phí AI 0.5–1 TWD/phiên ECN-003, bảo toàn biên lãi ECN-002).

Giá thương mại đề xuất gồm phí nền tảng theo tháng (Subscription Tier), mức sử dụng AI và công triển khai (nếu là khách hàng tùy biến doanh nghiệp lớn); chưa chốt số tiền cụ thể.

Hai loại hoa hồng phải tách biệt: hoa hồng nhân viên bán hàng có thể giảm ở một số đơn, còn hoa hồng đối tác giới thiệu vẫn là chi phí thật. Không hứa “không hoa hồng” nếu đơn hàng còn phải trả đối tác.

Trình tự triển khai:

1. Chọn một hành trình, kết quả cần cải thiện, người duyệt và nguồn đo.
2. Kiểm tra dữ liệu, API và quyền thực tế trước khi báo công tích hợp.
3. Duyệt cấu hình sản phẩm, câu trả lời, điều kiện liên hệ và nhân viên tiếp quản.
4. Kiểm thử với dữ liệu thử, cả lỗi kết nối và hành động bị cấm.
5. Chạy ở chế độ AI soạn nháp cho nhân viên; mở quyền thấp dần theo bằng chứng.
6. Đo kết quả trước khi thêm mô-đun hoặc ngành mới.

Bảng điều khiển ban đầu chỉ cần cấu hình, tài liệu, kết nối, hàng đợi người xử lý, nhật ký và báo cáo. Trình kéo-thả trợ lý, quy trình và hành trình để sau.

## 5. Danh mục ý tưởng đã chọn lọc

P0 là chuẩn bị; P1 là bản đầu; P2 là thử nghiệm sau bản đầu; P3 là mở rộng sau khi có dữ liệu. Đây là thứ tự ưu tiên, không phải cam kết lịch phát hành.

| Ý tưởng | Nguồn | Ưu tiên | Điều kiện / cách đo |
|---|---|---|---|
| Phiếu cơ hội từ tín hiệu trước nhu cầu | Tài liệu thị trường II–XV | P0 thủ công, P2 tự động hỗ trợ | Có nguồn, phân khúc, phép thử và lý do chọn; không thu gom danh sách cá nhân |
| Đối tác giới thiệu B2B2C | Tài liệu thị trường XI–XIV | P0 giả thuyết, P2 thử nhỏ, P3 mở rộng | Thỏa thuận, đường dẫn/mã nguồn, chi phí đối tác và đơn hợp lệ |
| Giải thích thông số dễ hiểu | PDF tr. 4–5 | P1 từ nội dung được duyệt | Câu trả lời đúng nguồn, không chuyển đổi số học thành lời hứa hiệu năng |
| Chọn nhanh và câu hỏi gợi ý theo ngữ cảnh | PDF tr. 2, 5 | P1 tối giản nếu giao diện hỗ trợ | Giảm thao tác; khách bỏ qua được; không cần biểu tượng hay hiệu ứng riêng |
| Lưu món chưa đăng nhập | PDF tr. 5 | P2 | Chỉ lưu mã sản phẩm trên thiết bị; hợp nhất thành công mới xóa bản tạm |
| Gợi ý tại chỗ, không đòi số điện thoại | PDF tr. 5–6 | P2 | Không che giỏ/chat; giới hạn tần suất; đo tỷ lệ tắt và rời trang |
| Mặc cả với giá sàn máy chủ | PDF tr. 2–3 | P2 tính thử, P3 tự động có giới hạn | Đủ dữ liệu chi phí, không cộng dồn ưu đãi ngoài ngân sách |
| Thanh toán QR / ghi nhớ lựa chọn thanh toán | PDF tr. 5 | P2 | Có đối soát, phương án thay thế, kiểm tra thiết bị và ngân hàng |
| Bổ sung món đạt ngưỡng miễn phí vận chuyển | PDF tr. 5 | P2 | So tổng tiền hai phương án; không khuyên chi thêm nếu lợi ích không hợp lý |
| Soát giỏ, khuyên không mua dư | PDF tr. 6; cải tiến hợp nhất | P2 | Phát hiện trùng/không tương thích bằng dữ liệu, khách tự xác nhận sửa |
| So sánh lý do nâng cấp | PDF tr. 4 | P2 | Đúng mẫu cũ/mới, tối đa vài khác biệt có nguồn; chấp nhận “chưa cần nâng cấp” |
| Phiếu bù giá trong khoảng theo dõi | PDF tr. 4–5 | P2 có người duyệt, P3 có hạn mức | Chính sách công khai, chi phí dự kiến, chống cấp trùng; 14 ngày chỉ là đề xuất |
| Theo dõi đơn, khung giờ giao, yêu cầu hóa đơn | PDF tr. 5 | P2 | Từng bộ kết nối xác nhận được; không hứa vị trí trực tiếp hay lịch ngoài khả năng |
| Xem ảnh/video hỗ trợ đổi trả | PDF tr. 1, 6 | P3 xem xét | Chỉ hỗ trợ nhân viên; phải có quyền lưu, xóa và dữ liệu kiểm chứng |

### Ba cải tiến xuyên suốt được đề xuất thêm

1. **Mỗi đề xuất có thẻ bằng chứng:** nguồn, thời điểm, sản phẩm, giả định và giới hạn. Dùng cùng cách truy vết cho nghiên cứu, tư vấn và hỗ trợ.
2. **Một ngân sách ưu đãi thống nhất:** giảm giá, hoa hồng đối tác, trợ phí vận chuyển và chi phí phiếu mua hàng không được duyệt riêng rồi cộng dồn vượt mức.
3. **Phản hồi sau mua quay lại nghiên cứu:** lý do không mua, mua sai, đổi trả và câu hỏi lặp lại tạo đề xuất sửa nội dung/sản phẩm; nhân viên duyệt trước khi xuất bản.

Đây là đề xuất tổng hợp mới, không phải tính năng có sẵn hoặc bằng chứng lợi thế độc quyền. [Lộ trình](delivery/mvp-and-roadmap.md) quyết định khi nào được thử; [đo lường](delivery/analytics.md) quyết định dựa trên số liệu nào.
