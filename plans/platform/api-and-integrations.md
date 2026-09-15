# API, tích hợp, bảo mật và vận hành

[Mục lục](../README.md) · [Kiến trúc](architecture.md) · [Quy trình](workflows-and-handoffs.md)

Trạng thái: hợp đồng đề xuất, chưa có API được triển khai hoặc kiểm thử. Tên đường dẫn, trường và trạng thái máy giữ nguyên để làm điểm xuất phát cho đặc tả kỹ thuật.

<a id=section-15></a>

## 1. Hai chiều kết nối

| Chiều | Luồng | Ví dụ |
|---|---|---|
| Doanh nghiệp gọi AgentOS | Máy chủ doanh nghiệp → API → mô-đun được bật → kết quả | Website gửi câu hỏi và hiển thị câu trả lời |
| AgentOS dùng hệ thống doanh nghiệp | Quy trình → công cụ được phép → bộ kết nối → API doanh nghiệp | Tra sản phẩm, lưu yêu cầu, đặt lịch khi được bật |
| Sự kiện nghiệp vụ | Nguồn đăng ký → cổng sự kiện → lần chạy phù hợp | Có yêu cầu mới, đơn hoặc thanh toán được xác nhận |

Hai cách vào hệ thống là máy chủ doanh nghiệp hoặc bộ kết nối kênh đã xác thực. Trình duyệt/ứng dụng di động không giữ khóa dịch vụ. Nếu cần mã truy cập phiên cho giao diện nhúng, dùng mã ngắn hạn, giới hạn quyền và phiên; không dùng khóa toàn doanh nghiệp.

Xác thực bên gọi trả lời “hệ thống nào đang gọi”; xác minh khách trả lời “ai được xem dữ liệu riêng”. Một bên gọi hợp lệ không tự chứng minh mọi mã khách trong nội dung đều thuộc phiên được phép.

## 2. Bốn API tối thiểu

| API | Ý nghĩa | Kết quả |
|---|---|---|
| `POST /v1/conversations` | Tạo/liên kết cuộc trao đổi với khách hoặc phiên được phép | Mã cuộc trao đổi và trạng thái xác minh |
| `POST /v1/conversations/{id}/messages` | Gửi câu hỏi, chọn `marketing`, `sales`, `support` hoặc `auto` | `202 Accepted`, mã công việc |
| `GET /v1/tasks/{id}` | Đọc trạng thái và kết quả đã được lưu | Trạng thái, phiên bản, câu trả lời và kết quả từng hành động |
| `POST /v1/events` | Nhận sự kiện từ nguồn đã đăng ký, kể cả quyết định nhân viên | Mã sự kiện, truy vết và các công việc liên quan |

`202 Accepted` chỉ là đã nhận bền vững, không phải đã đặt lịch, đã bán hay đã giải quyết. Trạng thái công việc: `accepted`, `running`, `waiting`, `awaiting_human`, `completed`, `stopped`, `failed`.

Ví dụ máy chủ doanh nghiệp gửi câu hỏi cho một cuộc trao đổi đã được phép:

```json
{
  "module": "sales",
  "message": "Tôi cần sản phẩm phù hợp với phòng nhỏ, có lựa chọn nào?"
}
```

Phản hồi tiếp nhận:

```json
{
  "task_id": "task_01",
  "conversation_id": "conv_01",
  "status": "accepted",
  "task_version": 1,
  "correlation_id": "corr_01"
}
```

Ví dụ kết quả tra danh mục; chưa có hành động thương mại:

```json
{
  "task_id": "task_01",
  "task_version": 3,
  "status": "completed",
  "answer": "Có hai lựa chọn phù hợp; đây là điều kiện và giới hạn của từng loại.",
  "sources": [{"source_record_id": "product_01", "source_version": "catalog_v3"}],
  "actions": [{"operation": "catalog.read", "status": "confirmed", "provider_reference": "product_01"}],
  "correlation_id": "corr_01"
}
```

Ví dụ chỉ mô tả cấu trúc; câu trả lời thực phải được nguồn hỗ trợ. Trước thử nghiệm cần một đặc tả OpenAPI (tài liệu mô tả API theo cấu trúc chuẩn) được duyệt về đầu vào, đầu ra, quyền, lỗi, giới hạn và phiên bản. Bộ kế hoạch này chưa thay thế đặc tả đó.

## 3. Định danh và quyền

| Trường/đối tượng | Quy tắc |
|---|---|
| `tenant_id` / `company_ref` | Suy ra từ thông tin xác thực, không lấy quyền từ nội dung khách gửi |
| `customer_id` / tham chiếu khách nguồn | Liên kết trong doanh nghiệp; cần bằng chứng phiên/tài khoản để xem dữ liệu riêng |
| `conversation_id`, `task_id`, `run_id` | Kiểm tra quyền trên từng đối tượng, không chỉ quyền gọi API |
| `event_id`, `source`, `occurred_at` | Sự kiện bất biến, nguồn được đăng ký và loại sự kiện nằm trong quyền nguồn |
| `correlation_id` | Nối yêu cầu, công việc, hành động và nhật ký |
| `configuration_version` | Phiên bản cấu hình để truy vết |
| `source_version` | Phiên bản dữ liệu/tài liệu đã dùng |
| `task_version` | Số tăng dần cho cập nhật trạng thái; dùng thống nhất ở truy vấn và thông báo |
| `effect_key` | Mã cố định của một tác động bên ngoài, dùng khi thử lại/đối soát |
| Nhân viên | Danh tính và vai trò đã xác thực; mã người dùng trong nội dung không tự cấp quyền |

Dùng khóa chống trùng cho yêu cầu theo doanh nghiệp + thao tác/cuộc trao đổi. Cùng khóa khác nội dung phải trả xung đột, không tạo hành động khác hoặc trả nhầm kết quả cũ.

Sự kiện có khóa doanh nghiệp + nguồn + mã sự kiện. Gửi lại cùng dữ liệu trả mã cũ; thay nội dung/loại dưới cùng khóa là xung đột. Một sự kiện có thể kích hoạt nhiều quy trình được cấu hình, mỗi quy trình có khóa lần chạy riêng.

Sự kiện người vận hành có thể là `human.approval`, `human.reject`, `human.takeover`, `human.resume`, kèm công việc/lần chạy, người thực hiện, quyết định, lý do và khóa chống trùng. Máy chủ kiểm tra quyền quyết định tại thời điểm xử lý.

## 4. Thông báo kết quả và chống xử lý lặp

AgentOS có thể gửi thông báo máy chủ tới máy chủ hoặc để bên gọi truy vấn trạng thái. Địa chỉ nhận phải đăng ký và được phê duyệt; không gửi tới địa chỉ tùy ý lấy từ khách/tài liệu.

Thông báo gồm `event_id`, `task_id`, `task_version`, `status`, `correlation_id`, kết quả/lỗi và người phụ trách nếu chờ người. Có xác thực, thời gian chống phát lại và thử gửi hữu hạn.

Bên nhận lưu khóa sự kiện, bỏ cập nhật phiên bản cũ và chấp nhận bản trùng mà không tạo tác động lần hai. Mất thông báo thì dùng `GET /v1/tasks/{id}` với khoảng chờ có giới hạn. Không tạo công việc mới chỉ vì chưa thấy kết quả.

**Thông báo kết quả về máy chủ khác tin gửi cho khách.** Phải chỉ định một nơi sở hữu việc gửi ra kênh; không để cả website và bộ kết nối cùng phát lại câu trả lời. Tin gửi cần mã tác động và mã nhà cung cấp.

## 5. Bộ kết nối và phạm vi (Connector & Integration Layer)

### 5.1 Các cổng kết nối cốt lõi theo mã chuẩn hóa

- **API-001 - ERP/POS Connector (Hệ thống giao dịch nguồn)**:
  - *Chức năng*: Kết nối với ERP/POS/Commerce hiện hành để đọc dữ liệu có thẩm quyền (System of Record) gồm: danh mục sản phẩm, SKU, giá niêm yết, tồn kho thời gian thực, hồ sơ khách hàng, đơn hàng, hóa đơn và lịch sử mua sắm.
  - *Kiểm soát thay đổi*: Mọi hành động ghi (mutation: tạo đơn, giữ hàng, cập nhật trạng thái) bắt buộc phải qua API/action được kiểm soát, kiểm tra quyền hạn và gắn `effect_key`. Tuyệt đối không cho phép AI tự tạo hoặc ghi đè giá/tồn kho trực tiếp vào cơ sở dữ liệu.
- **API-002 - Web/App Event Ingestion (Cổng thu nhận sự kiện số)**:
  - *Chức năng*: Thu nhận và chuẩn hóa các sự kiện hành vi số từ Website và Mobile App của doanh nghiệp theo thời gian thực.
  - *Sự kiện tối thiểu bắt buộc*: `session` (phiên truy cập), `product_view` (xem sản phẩm), `search` (tìm kiếm), `click` (tương tác liên kết), `add_to_cart` (thêm vào giỏ hàng), `checkout` (bắt đầu thanh toán), `purchase` (mua hàng thành công).
  - *Xử lý*: Dòng sự kiện được nạp vào Customer 360 để xây dựng Timeline thống nhất (FR-C360-002) và sinh các tín hiệu hành vi (`SIGNAL`).
- **API-003 - Communication Connectors (Cổng kết nối đa kênh tương tác)**:
  - *Chức năng*: Kiến trúc kết nối đa kênh hợp nhất phục vụ gửi/nhận tin nhắn hai chiều giữa khách hàng và các AI Agent/Nhân viên.
  - *Phạm vi kênh hỗ trợ*: Facebook Messenger, TikTok DM, Zalo OA/ZNS, LINE Official Account, WhatsApp Business, Email, SMS và Web Chat Widget nhúng.
  - **[UNCONFIRMED][ASM-001]**: Danh sách kênh triển khai thực tế trên production sẽ được chốt theo tài khoản doanh nghiệp, quyền hạn API và chính sách nền tảng cụ thể.

| Kết nối | Đọc | Ghi khi được phép | Giai đoạn |
|---|---|---|---|
| Danh mục (API-001) | Sản phẩm, điều kiện, giá, khả dụng | Không sửa danh mục trong P1 | P1 bắt buộc một nguồn |
| Khách/CRM (API-001) | Khách, yêu cầu/cơ hội, chủ sở hữu | Ghi chú, trường hỏi nhu cầu, bước tiếp theo | P1 một nguồn; không yêu cầu CRM mới |
| Kênh tương tác (API-003) | Phiên, tin nhắn, trạng thái giao | Trả lời và nhắc có điều kiện | P1 website/LINE; kênh khác chọn riêng |
| Sự kiện số (API-002) | Hành vi session, view, cart | Tạo timeline, tín hiệu Customer 360 | P1 thu nhận sự kiện cơ bản |
| Lịch hẹn | Khả dụng và lịch đã đặt | Tạo lịch có xác nhận | P1 chỉ khi chọn hành trình cần hẹn |
| Đơn hàng (API-001) | Đơn và trạng thái | Tạo/sửa theo chính sách | P1 chỉ đọc; ghi sau P1 |
| Thanh toán | Yêu cầu/giao dịch và đối soát | Tạo yêu cầu thanh toán được duyệt | Sau P1; hoàn tiền luôn quyền riêng |
| Vận chuyển | Trạng thái, khả năng khung giờ | Yêu cầu vận chuyển theo quyền | Sau P1 |
| Phiếu hỗ trợ / Voucher | Trạng thái, người nhận, điều kiện | Tạo/cập nhật/cấp theo chính sách | Sau P1 |
| Quảng cáo / Đối tác | Nguồn, chi phí và kết quả được phép | Không tự xuất bản, chi ngân sách | Sau P1 theo thử nghiệm |

### 5.2 Bộ kết nối bản địa hóa Đài Loan (Taiwan Localization Adapters)
Đối với khách hàng mỏ neo tại Đài Loan, hệ thống tích hợp sẵn các bộ kết nối đặc thù của thị trường nội địa:
1. **Nền tảng TMĐT Đài Loan**: Connectors cho **91APP**, **SHOPLINE**, **Cyberbiz** qua Open API và Webhook (đồng bộ tồn kho, danh mục sản phẩm và trạng thái đơn hàng thời gian thực).
2. **Kênh tương tác & Định danh**: **LINE Messaging API** (tương tác trực tiếp trên LINE Official Account), **LINE Login** (xác thực danh tính 1-chạm không cần tạo tài khoản mới).
3. **Cổng thanh toán & Giao nhận siêu thị tiện lợi (CVS)**: **ECPay (綠界科技)** và **NewebPay (藍新金流)**, hỗ trợ trọn gói thẻ nội địa, **LINE Pay**, **JKOPAY (街口支付)** và API bản đồ chọn siêu thị tiện lợi (**7-Eleven / FamilyMart E-Map**) phục vụ hình thức nhận hàng trả tiền mặt (**超商取貨付款 - CVS COD**).
4. **Hạ tầng lưu trữ tuân thủ Taiwan PDPA**: Đặt cụm máy chủ và cơ sở dữ liệu tại **GCP Changhua (Đài Loan)** hoặc **AWS Region Taipei** đảm bảo tốc độ phản hồi < 50ms và đáp ứng yêu cầu lưu trữ dữ liệu cá nhân tại chỗ theo Đạo luật Bảo vệ Dữ liệu Cá nhân Đài Loan.

### Bộ kết nối mở rộng toàn cầu (Global Multi-Tenant Adapters)
Để mở rộng sang $N$ doanh nghiệp quốc tế theo cơ chế Plug-and-Play:
1. **Nền tảng TMĐT toàn cầu (Global App Stores)**:
   - **Shopify GraphQL Admin API & App Bridge**: Đóng gói thành Shopify App cài đặt 1-chạm; tự động đồng bộ Webhook đơn hàng, giỏ hàng bỏ quên và danh mục sản phẩm.
   - **WooCommerce REST API**: Đóng gói thành plugin WordPress/WooCommerce chuẩn hóa.
2. **Kênh tương tác quốc tế**:
   - **WhatsApp Business Cloud API**: Hỗ trợ hội thoại B2C cho thị trường Châu Âu, Châu Mỹ Latinh, Ấn Độ và Đông Nam Á.
   - **Web Widget đa ngôn ngữ**: Nhúng linh hoạt với bộ dịch thuật tự động theo locale của người mua (`en-US`, `ja-JP`, `zh-TW`, `vi-VN`).
3. **Cổng thanh toán quốc tế**:
   - **Stripe & PayPal Commerce Platform**: Hỗ trợ thẻ tín dụng quốc tế, Apple Pay, Google Pay, Klarna (Buy Now Pay Later) và đối soát đa tiền tệ tự động (USD, EUR, JPY, GBP).
4. **Hạ tầng pháp lý toàn cầu**:
   - Tùy chọn lưu trữ phân vùng theo khu vực (Multi-region Data Residency): AWS Frankfurt (EU GDPR), AWS US East (CCPA), AWS Singapore (APAC PDPA).

Mỗi bộ kết nối chịu trách nhiệm xác thực, ánh xạ trường, giới hạn tốc độ, thời gian chờ, loại lỗi, khóa đối soát và kiểm thử. Quyền đọc và ghi cấu hình độc lập; ngoài danh sách phải từ chối.

Kết quả hành động chung gồm `operation_id`, `effect_key`, `operation`, `source_record`, `status`, `provider_reference`, `reconciliation_key`, `correlation_id`. Trạng thái hành động là `confirmed` (xác nhận), `rejected` (từ chối) hoặc `uncertain` (chưa rõ). Mã HTTP 200/202 không tự thay kết quả nghiệp vụ.

<a id=payments></a>

## 6. Thanh toán và báo giá có thời hạn (Áp dụng cho Thanh toán số & Siêu thị CVS)

Hệ thống hỗ trợ cả luồng thanh toán tức thời (LINE Pay/Thẻ) và luồng nhận hàng trả tiền tại siêu thị (CVS COD). Khách vẫn kiểm tra thông tin và xác nhận theo chuẩn của đơn vị trung gian thanh toán. Không suy ra khả năng mở mọi ngân hàng, thời gian ba giây hoặc phí bằng 0 từ mô tả PDF.

Thiết kế sau P1 phải phân biệt:

| Đối tượng | Ý nghĩa | Không đồng nghĩa |
|---|---|---|
| Báo giá | Điều khoản có phiên bản và hạn hiệu lực | Tiền đã vào |
| Đơn hàng | Yêu cầu mua được hệ thống đơn chấp nhận | Đã thanh toán/giao hàng |
| Yêu cầu thanh toán/QR | Hướng dẫn chuyển tiền hoặc đối tượng thanh toán của nhà cung cấp | Xác nhận giao dịch |
| Giao dịch đối soát | Nguồn tin cậy xác nhận tiền và kết quả ghép đơn | Đã giao hàng hoặc hết nghĩa vụ đổi trả |

1. Máy chủ tạo báo giá hợp lệ và đơn/yêu cầu mua theo thứ tự nhà cung cấp hỗ trợ; khóa giá, tiền tệ, số lượng, người thụ hưởng và tham chiếu.
2. Khách xem điều khoản rồi tự xác nhận thanh toán.
3. Chỉ nhận sự kiện từ nguồn đáng tin; kiểm tra đúng đơn, số tiền, tiền tệ, người thụ hưởng và mã giao dịch.
4. Sự kiện trùng chỉ ghi nhận một lần; sự kiện không theo thứ tự phải đối soát, không lùi trạng thái tùy tiện.
5. Hết thời gian chờ giữ trạng thái chờ/cần kiểm tra, không tự coi đã trả hoặc chưa trả.
6. Trả thiếu/thừa, sai nội dung, trả sau hạn, thiếu hàng hoặc đơn hủy phải có hàng đợi xử lý và chính sách được duyệt.
7. Hoàn tiền là tác vụ riêng, có người có quyền quyết định và mã xác nhận; không tự bù trừ.

Hạn báo giá 10 phút từ PDF được thi hành ở máy chủ. Mã xác thực HMAC có thể bảo vệ dữ liệu báo giá nội bộ, **không mặc nhiên ký chuẩn QR ngân hàng hoặc khiến ngân hàng từ chối tiền sau hạn**. Phải kiểm thử khả năng hết hạn thực của nhà cung cấp; mọi khoản tiền đến muộn đều cần được ghi và xử lý.

<a id=section-16></a>

## 7. Bảo mật, Quản trị và Yêu cầu phi chức năng (NFR)

### Các yêu cầu phi chức năng cốt lõi (Non-functional Requirements)

- **NFR-001 - Security (Bảo mật & Phân quyền) - MUST**: Agent chỉ được truy cập dữ liệu và công cụ theo đúng cấp độ thẩm quyền được giao (`AUTH-0` đến `AUTH-3`); không có bất kỳ ca kiểm thử nào cho phép vượt ranh giới authority boundary.
- **NFR-002 - Auditability (Khả năng kiểm toán) - MUST**: 100% hành động tạo ra thay đổi bên ngoài (External Action) đều phải sinh bản ghi kiểm toán audit/evidence record kèm mã lần chạy `run_id`, timestamp, latency, cost và người/agent thực hiện.
- **NFR-003 - Idempotency (Chống trùng lặp tác vụ) - MUST**: Thực hiện lại cùng một yêu cầu (trùng `effect_key`) tuyệt đối không được tạo ra giao dịch, đơn hàng hoặc thông điệp ngoài ý muốn lần thứ hai.
- **NFR-006 - Data Isolation (Cô lập dữ liệu đa doanh nghiệp) - MUST**: Dữ liệu của khách hàng hoặc doanh nghiệp A tuyệt đối không xuất hiện trong ngữ cảnh (context) của khách hàng hoặc doanh nghiệp B ở mọi tầng (DB schema, cache Redis, vector index, AI memory).
- **NFR-008 - Failure Safety (An toàn khi sự cố - Fail Closed) - MUST**: Khi không xác minh được giá, tồn kho, cấp độ quyền hạn (authority) hoặc sự đồng ý (consent), hệ thống bắt buộc phải fail closed (chặn thực thi, giữ trạng thái an toàn, chuyển người xử lý).
- **NFR-010 - Cost Observability (Giám sát chi phí) - MUST**: Đo lường chi tiết mức tiêu hao token, mô hình LLM, chi phí API/tool, tính toán chính xác cost/run, cost/customer và cost/conversion theo thời gian thực.

| Lĩnh vực | Yêu cầu thiết kế |
|---|---|
| Tách doanh nghiệp | Phân tách schema ở cơ sở dữ liệu, truy xuất, tệp, hàng đợi, công việc và báo cáo (NFR-006) |
| Vai trò | Chủ doanh nghiệp, quản trị, quản lý từng mô-đun, nhân viên được phân công, phân tích chỉ đọc |
| Tài khoản quản trị | Xác thực nhiều yếu tố (MFA); đăng nhập tập trung SSO khi doanh nghiệp yêu cầu |
| Bí mật | Lưu trong biến môi trường (.env), giới hạn quyền, xoay vòng; không đưa vào trình duyệt hay log |
| Truyền/lưu dữ liệu | Mã hóa đường truyền TLS 1.3 và lưu trữ AES-256; kiểm tra cấu hình định kỳ |
| Sự kiện | Xác thực chữ ký số/HMAC theo nhà cung cấp, cửa sổ chống phát lại, chống trùng (NFR-003) |
| Điểm kết nối | Chỉ địa chỉ đã duyệt; chặn gọi mạng nội bộ/địa chỉ tùy ý từ prompt injection |
| AI và công cụ | Kiểm tra lược đồ JSON, vai trò, phê duyệt `AUTH-4`, hạn mức giá sàn $P_{floor}$ ngay khi thực thi |
| Nhà cung cấp AI | Tối thiểu hóa dữ liệu, thỏa thuận zero data retention; không huấn luyện lại chéo doanh nghiệp |
| Vòng đời dữ liệu | Quản lý lưu, xuất, xóa theo yêu cầu chủ thể, phân vùng lưu trữ theo luật sở tại |
| Nhật ký | Lưu `run_id`, `tenant_id`, hành động, phiên bản, phê duyệt, kết quả, chi phí, che dữ liệu nhạy cảm |

### Căn cứ pháp lý đa thị trường

Với doanh nghiệp quốc tế hoặc triển khai đa thị trường, hệ thống tuân thủ các khung pháp lý bảo vệ dữ liệu cá nhân quốc tế tương ứng:
- **Đài Loan (Taiwan PDPA)**: Đặt cụm máy chủ và cơ sở dữ liệu tại GCP Changhua hoặc AWS Region Taipei đảm bảo lưu trữ dữ liệu cá nhân tại chỗ và độ trễ < 50ms.
- **Quốc tế**: Tuân thủ **GDPR (Châu Âu)**, **CCPA/CPRA (Hoa Kỳ)**, **PDPA (Singapore & Đông Nam Á)** song song với luật dữ liệu tại quốc gia sở tại (Việt Nam: Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 và Nghị định 13/2023/NĐ-CP). Tuyệt đối không tự động tuyên bố tuân thủ chỉ dựa trên cấu hình mã hóa hay ô chọn đồng thuận đơn lẻ.

## 8. Lỗi, vận hành và nghiệm thu

Lỗi cần mã ổn định, thông điệp tiếng Việt, `retryable` (cờ cho biết có thể thử lại), mã truy vết và chi tiết an toàn. Mã đề xuất: `AUTHENTICATION_FAILED`, `CUSTOMER_UNVERIFIED`, `CAPABILITY_NOT_ENABLED`, `VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, `APPROVAL_REQUIRED`, `PROVIDER_TIMEOUT`, `PROVIDER_REJECTED`, `RATE_LIMITED`, `TASK_NOT_FOUND`.

Theo dõi độ trễ, lỗi công cụ, hàng đợi, công việc kẹt, thiếu nguồn kiến thức, lượng dùng AI và chi phí theo thời gian thực (NFR-010). Có giới hạn thử lại, người trực xử lý ngoại lệ và cơ chế ngắt từng năng lực (Circuit Breaker).

Bộ thử bắt buộc:

1. **TC-E2E-001**: Luồng E2E qua chu trình 11 bước: Signal → Execution → Outcome → Learning.
2. **TC-E2E-002 / TC-E2E-006**: Thao tác ngoài quyền hoặc thiếu phê duyệt `AUTH-4` đều bị chặn (DENY) và sinh audit event (NFR-001, NFR-002, BR-008).
3. **TC-E2E-005**: Yêu cầu trùng (cùng `effect_key`) không tạo tác động thứ hai; khóa trùng khác nội dung báo lỗi xung đột (NFR-003).
4. **NFR-006**: Kiểm thử cô lập dữ liệu; không có rò rỉ dữ liệu giữa 2 tenant thử nghiệm.
5. **NFR-008**: Khi không xác minh được giá/tồn từ API-001 hoặc consent từ API-002, hệ thống phải fail closed.
6. **TC-E2E-008**: Lỗi từ cổng kết nối API-001/002/003 phải ghi nhận thất bại/thử lại, không báo thành công giả.
7. **Bảo mật chỉ thị**: Tấn công chèn chỉ dẫn (prompt injection) từ khách hàng qua API-003 không thể nâng quyền Agent (BR-009).
8. **Thanh toán & CVS COD**: Kiểm tra xử lý tiền muộn/thiếu/thừa, trùng mã đơn, sai người nhận và quyền hoàn tiền độc lập.
