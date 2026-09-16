# API, tích hợp, bảo mật và vận hành

[Mục lục](../README.md) · [Kiến trúc](architecture.md) · [Dữ liệu](data-and-knowledge.md) · [Quy trình](workflows-and-handoffs.md)

Trạng thái: Bản thiết kế khung gầm kỹ thuật (Platform Blueprint) độc lập thị trường cho giao tiếp API hai chiều, cổng Adapter bản địa/toàn cầu và tiêu chuẩn bảo mật NFR.

<a id=section-15></a>

## 1. Hai chiều kết nối hệ thống

| Chiều tương tác | Luồng luân chuyển dữ liệu | Ví dụ thực tế |
|---|---|---|
| **Doanh nghiệp gọi Core Engine** | Hệ thống doanh nghiệp → API Gateway → Định tuyến Agent (FR-ORC-001) → Kết quả | Website gửi câu hỏi tư vấn và nhận câu trả lời đã kiểm duyệt |
| **Core Engine gọi hệ thống doanh nghiệp** | Quy trình bền vững → Tool được phép → Cổng Adapter → API Doanh nghiệp | Tra cứu tồn kho thời gian thực qua API-001, tạo đơn hàng draft |
| **Sự kiện nghiệp vụ bất đồng bộ** | Kênh tương tác / Webhook → Cổng tiếp nhận sự kiện → Lần chạy phù hợp (`run_id`) | Có tin nhắn mới từ LINE/WhatsApp hoặc Webhook thanh toán thành công |

Hai ngõ vào hệ thống hợp lệ duy nhất là máy chủ doanh nghiệp đã xác thực hoặc cổng Adapter kênh tương tác đã ký số. Trình duyệt hoặc ứng dụng di động khách hàng tuyệt đối không nắm giữ khóa API dịch vụ. Nếu cần phiên làm việc cho giao diện Storefront Widget, hệ thống cấp mã token ngắn hạn (`session_token`), giới hạn quyền và phiên; tuyệt đối không dùng khóa toàn doanh nghiệp.

Xác thực bên gọi (`caller_auth`) trả lời câu hỏi “hệ thống nào đang gọi”; xác minh khách hàng (`customer_auth`) trả lời câu hỏi “ai được phép xem dữ liệu riêng tư này”. Một bên gọi hợp lệ không mặc nhiên chứng minh mọi mã khách trong payload nội dung đều thuộc phiên được phép.

## 2. Bốn API cốt lõi của nền tảng

| API Endpoint | Mục đích kỹ thuật | Kết quả trả về chuẩn |
|---|---|---|
| `POST /v1/conversations` | Khởi tạo hoặc liên kết cuộc trao đổi với khách hàng/phiên được phép | `conversation_id`, trạng thái xác minh, token phiên |
| `POST /v1/conversations/{id}/messages` | Gửi câu hỏi hoặc tương tác; định tuyến `marketing`, `sales`, `support` hoặc `auto` | `202 Accepted`, `task_id`, `task_version`, `correlation_id` |
| `GET /v1/tasks/{id}` | Truy vấn trạng thái và kết quả xử lý của tác vụ bền vững | Trạng thái máy, phiên bản, câu trả lời, bằng chứng và kết quả hành động |
| `POST /v1/events` | Tiếp nhận sự kiện nghiệp vụ từ webhook hoặc quyết định từ Command Center | `event_id`, `correlation_id` và danh sách công việc liên quan |

Mã phản hồi `202 Accepted` chỉ xác nhận hệ thống đã tiếp nhận bền vững vào hàng đợi tác vụ; không đồng nghĩa với đơn hàng đã thanh toán hay yêu cầu đã hoàn tất. Các trạng thái tác vụ chuẩn hóa: `accepted`, `running`, `waiting`, `awaiting_human`, `completed`, `stopped`, `failed`.

Ví dụ payload máy chủ doanh nghiệp gửi câu hỏi tư vấn cho cuộc trao đổi đã xác thực:

```json
{
  "module": "sales",
  "message": "Tôi cần sản phẩm dưỡng ẩm cho da nhạy cảm, có lựa chọn nào phù hợp?",
  "idempotency_key": "idem_req_9981a"
}
```

Phản hồi tiếp nhận tức thời:

```json
{
  "task_id": "task_8820",
  "conversation_id": "conv_4412",
  "status": "accepted",
  "task_version": 1,
  "correlation_id": "corr_01928a"
}
```

Kết quả hoàn tất sau khi xử lý qua chu trình 11 bước (chỉ đọc dữ liệu, chưa phát sinh hành động tài chính):

```json
{
  "task_id": "task_8820",
  "task_version": 3,
  "status": "completed",
  "answer": "Chúng tôi có hai dòng sản phẩm phù hợp với da nhạy cảm theo tiêu chuẩn kiểm nghiệm. Dưới đây là thông số và điều kiện áp dụng.",
  "sources": [
    { "source_record_id": "prod_sens_01", "source_version": "v2.1", "source_file": "/product/products.md" }
  ],
  "actions": [
    { "operation": "catalog.read", "status": "confirmed", "provider_reference": "sku_sens_01" }
  ],
  "correlation_id": "corr_01928a"
}
```

## 3. Định danh, Kiểm soát ngữ cảnh và Khóa chống trùng

| Thuộc tính định danh | Quy tắc quản trị kỹ thuật |
|---|---|
| `tenant_id` / `company_ref` | Suy ra trực tiếp từ thông tin xác thực (JWT/mTLS); không lấy quyền từ nội dung khách hàng gửi lên |
| `customer_id` | Định danh khách hàng trong phạm vi tenant; yêu cầu xác minh phiên để truy cập dữ liệu riêng tư Customer 360 |
| `conversation_id`, `task_id`, `run_id` | Kiểm tra quyền truy cập trên từng thực thể độc lập, không chỉ kiểm tra quyền ở cấp độ API Gateway |
| `event_id`, `source`, `occurred_at` | Sự kiện bất biến; nguồn phát phải được đăng ký trước và loại sự kiện nằm trong danh mục cấp phép |
| `correlation_id` | Mã truy vết nối liền dòng dữ liệu: Yêu cầu → Công việc → Hành động → Nhật ký kiểm toán (NFR-002) |
| `configuration_version` | Ảnh chụp phiên bản cấu hình chính sách tại thời điểm chạy để phục vụ kiểm toán |
| `source_version` | Phiên bản tài liệu Second Brain hoặc bản ghi ERP đã trích dẫn trong câu trả lời |
| `task_version` | Số nguyên tăng dần cho mỗi lần chuyển trạng thái; dùng để đồng bộ nhất quán giữa truy vấn và thông báo |
| `effect_key` | Mã định danh duy nhất của một tác động bên ngoài; bắt buộc dùng khi thử lại hoặc đối soát (BR-005, NFR-003) |
| Nhân viên vận hành | Danh tính và vai trò được xác thực qua SSO/MFA; mã người dùng trong nội dung không tự động cấp quyền |

Khóa chống trùng (Idempotency Key) áp dụng cho mọi yêu cầu theo công thức `tenant_id` + `operation` + `unique_key`. Khi nhận cùng khóa nhưng khác nội dung payload, hệ thống trả mã lỗi xung đột `IDEMPOTENCY_CONFLICT`, tuyệt đối không tạo hành động mới hoặc trả kết quả cũ sai lệch.

**Quy định thời gian lưu trữ (TTL) của Idempotency Key (`effect_key`)**:
- *Bộ nhớ đệm thời gian thực (Redis Cache)*: Thiết lập TTL **72 giờ** phục vụ kiểm tra chống trùng lặp tức thời với tốc độ sub-millisecond, ngăn chặn các luồng thử lại dồn dập (retries) hoặc sự cố gửi lặp mạng trong cửa sổ giao dịch.
- *Lưu trữ bất biến vĩnh viễn (PostgreSQL)*: Toàn bộ bản ghi `effect_key` kèm mã lần chạy `run_id`, trạng thái thực thi và bằng chứng (Evidence) được ghi nhận và **lưu trữ vĩnh viễn** trong cơ sở dữ liệu quan hệ PostgreSQL (bảng `agent_run_log` / `idempotency_audit`) phục vụ đối soát tài chính, kiểm toán hồi tố (NFR-002, NFR-003) và giải quyết tranh chấp khiếu nại.

Các sự kiện can thiệp từ người vận hành tại Command Center gồm: `human.approval`, `human.reject`, `human.modify`, `human.takeover`, `human.resume`, kèm định danh nhân viên, quyết định, lý do giải trình và khóa chống trùng. Máy chủ kiểm tra quyền hạn của người ký tại thời điểm xử lý.

## 4. Cổng kết nối cốt lõi của nền tảng (Core Connectors)

### API-001 - ERP/POS Connector (Hệ thống giao dịch nguồn)
- **Chức năng**: Kết nối với hệ thống giao dịch của doanh nghiệp để đọc dữ liệu có thẩm quyền chính thức (System of Record) gồm: danh mục sản phẩm, biến thể SKU, giá niêm yết, tồn kho thực tế theo kho hàng, hồ sơ tài khoản khách hàng, đơn hàng, trạng thái thanh toán và hóa đơn.
- **Kiểm soát thay đổi (Mutation Guard)**: Mọi hành động ghi (tạo đơn hàng draft, giữ chỗ tồn kho, hủy đơn) bắt buộc phải qua API được cấp quyền, gắn mã tác động `effect_key` và tuân thủ mô hình phân quyền (AUTH-3 hoặc AUTH-4). Tuyệt đối cấm AI tự tạo giá hoặc ghi đè trực tiếp vào cơ sở dữ liệu (BR-001, BR-002, BR-003).

### API-002 - Web/App Event Ingestion (Cổng thu nhận sự kiện số)
- **Chức năng**: Thu nhận và chuẩn hóa các sự kiện hành vi số từ Website và Mobile App của doanh nghiệp theo thời gian thực.
- **Danh mục sự kiện tối thiểu bắt buộc**:
  - `session.start` / `session.end`: Bắt đầu và kết thúc phiên truy cập.
  - `product.view`: Xem chi tiết sản phẩm.
  - `search.query`: Tìm kiếm từ khóa sản phẩm.
  - `element.click`: Tương tác nút bấm, liên kết hoặc banner khuyến mãi.
  - `cart.add` / `cart.remove`: Thêm hoặc bớt sản phẩm khỏi giỏ hàng.
  - `checkout.start`: Bắt đầu tiến trình thanh toán.
  - `order.placed`: Đặt hàng thành công.
- **Xử lý**: Dòng sự kiện được chuẩn hóa và nạp vào Customer 360 Timeline (FR-C360-002) dưới dạng các tín hiệu hành vi (`SIGNAL`).

### API-003 - Communication Connectors (Cổng kết nối đa kênh tương tác)
- **Chức năng**: Kiến trúc kết nối đa kênh hợp nhất phục vụ gửi và nhận tin nhắn hai chiều giữa khách hàng với AI Agent hoặc Nhân viên.
- **Phạm vi kênh hỗ trợ**: LINE Official Account, WhatsApp Business, Web Chat Widget nhúng, Facebook Messenger, Instagram Direct, TikTok (TikTok Messaging & Webhooks theo SRS Mục 15), Zalo OA/ZNS, Email và SMS giao dịch.
- **Quy tắc an toàn**: Độc quyền phát tin qua Session Mutex Lock; khi nhân viên tiếp quản (Takeover), quyền gửi tin của AI bị ngắt lập tức. Tin nhắn tiếp thị chỉ được gửi khi có consent hợp lệ (BR-004).

## 5. Đặc tả mã chuẩn hóa cho các Plug-and-Play Adapters

Toàn bộ các cổng kết nối bản địa hóa và mở rộng toàn cầu được định danh theo mã chuẩn:

```
+-----------------------------------------------------------------------------+
|                          PLUG-AND-PLAY ADAPTER CODES                        |
+-----------------------------------------------------------------------------+
| ADPT-TW-001  | Taiwan Localization Adapter (LINE, ECPay, CVS COD, PDPA)    |
| ADPT-GL-001  | Global Communication Adapter (WhatsApp Cloud, Meta, i18n)   |
| ADPT-GL-002  | Global Payment Adapter (Stripe, PayPal, Apple Pay, Multi-ccy)|
| ADPT-GL-003  | Global Compliance & Residency (AWS Frankfurt/US/SG Regions)  |
+-----------------------------------------------------------------------------+
```

### ADPT-TW-001 - Taiwan Localization Adapter (Cổng kết nối bản địa hóa Đài Loan)
Phục vụ thị trường Đài Loan với hệ sinh thái thương mại nội địa đặc thù:
1. **Kênh tương tác & Định danh**:
   - **LINE Messaging API**: Tích hợp LINE Official Account (LINE OA) hỗ trợ gửi tin nhắn hai chiều, tin nhắn định dạng phong phú (Flex Messages) và tin nhắn thông báo (LINE Notification Messages).
   - **LINE Login**: Xác thực danh tính khách hàng 1-chạm, liên kết tự động LINE User ID với hồ sơ Customer 360 mà không cần tạo tài khoản mật khẩu mới.
2. **Nền tảng TMĐT bản địa**:
   - Kết nối Open API và Webhooks thời gian thực với **91APP**, **SHOPLINE** và **Cyberbiz** để đồng bộ tồn kho, đơn hàng và danh mục sản phẩm.
3. **Cổng thanh toán & Nhận hàng tại siêu thị tiện lợi (CVS COD)**:
   - Tích hợp cổng thanh toán **ECPay (綠界科技)** và **NewebPay (藍新金流)**, hỗ trợ thẻ tín dụng nội địa, LINE Pay, JKOPAY (街口支付).
   - Tích hợp **CVS COD E-Map API**: Gọi API bản đồ chọn siêu thị tiện lợi (**7-Eleven / FamilyMart**) phục vụ hình thức nhận hàng trả tiền mặt tại quầy (**超商取貨付款 - CVS COD**), tự động lưu mã cửa hàng (`cvs_store_id`) vào đơn hàng.
   - **Cơ chế truyền tin liên miền an toàn (Safe Cross-Origin `postMessage`)**: Storefront Widget chạy trong Shadow DOM siêu nhẹ (< 20 KB) khi mở giao diện bản đồ chọn siêu thị của bên thứ ba (ECPay/NewebPay/siêu thị) dưới dạng iframe hoặc popup cửa sổ sẽ nhận dữ liệu phản hồi (`cvs_store_id`, `cvs_store_name`, `cvs_address`) qua giao thức `window.postMessage`. Cơ chế này cấu hình listener nghiêm ngặt: kiểm tra chặt chẽ miền gốc `event.origin` theo danh sách whitelist domain đối tác đã cấp phép, xác thực tính toàn vẹn của token đi kèm nhằm bảo đảm widget không bị chính sách Same-Origin Policy chặn và triệt tiêu nguy cơ tấn công giả mạo nguồn gốc thông điệp (Cross-Origin Message Spoofing).
4. **Hạ tầng lưu trữ tuân thủ Taiwan PDPA**:
   - Triển khai cụm máy chủ và cơ sở dữ liệu tại **GCP Changhua (Đài Loan)** hoặc **AWS Region Taipei**, bảo đảm tốc độ phản hồi < 50ms và tuân thủ yêu cầu lưu trữ dữ liệu cá nhân tại chỗ theo Đạo luật Bảo vệ Dữ liệu Cá nhân Đài Loan.

### ADPT-GL-001 - Global Communication Adapter (Cổng giao tiếp toàn cầu)
Phục vụ mở rộng tương tác đa kênh quốc tế:
1. **WhatsApp Business Cloud API**:
   - Kết nối trực tiếp hạ tầng Meta Cloud API; hỗ trợ mẫu tin nhắn đã phê duyệt (Message Templates) cho thông báo đơn hàng và phiên hội thoại dịch vụ 24 giờ cho thị trường Châu Âu, Mỹ Latinh, Ấn Độ và Đông Nam Á.
2. **Meta Webhooks**:
   - Tích hợp Facebook Messenger và Instagram Direct Messaging qua Meta Graph API với cơ chế xác thực webhook HMAC-SHA256.
3. **Web Chat Widget đa ngôn ngữ**:
   - Giao diện chat nhúng siêu nhẹ (< 20 KB), cô lập qua Shadow DOM, tích hợp cơ chế i18n tự động dịch thuật theo locale của trình duyệt (`en-US`, `ja-JP`, `zh-TW`, `vi-VN`).

### ADPT-GL-002 - Global Payment Adapter (Cổng thanh toán & đối soát toàn cầu)
Phục vụ xử lý giao dịch thanh toán quốc tế đa tiền tệ:
1. **Stripe & PayPal Commerce Platform**:
   - Tích hợp Stripe Payment Intents API và PayPal Checkout API; hỗ trợ đầy đủ thẻ tín dụng quốc tế (Visa, Mastercard, Amex), Apple Pay, Google Pay và phương thức mua trước trả sau Klarna (BNPL).
2. **Đối soát đa tiền tệ tự động (Multi-currency Reconciliation)**:
   - Tự động quy đổi tỷ giá và đối soát đa tiền tệ thời gian thực (USD, EUR, JPY, GBP), ghi nhận chính xác doanh thu theo đồng tiền cơ sở của doanh nghiệp.

### ADPT-GL-003 - Global Compliance & Residency (Cổng pháp lý & hạ tầng lưu trữ toàn cầu)
Phục vụ tuân thủ các khung pháp lý bảo vệ dữ liệu cá nhân quốc tế:
1. **Phân vùng lưu trữ theo khu vực (Multi-region Data Residency)**:
   - **AWS Frankfurt (eu-central-1)**: Cấu hình phân vùng lưu trữ tuân thủ Quy định bảo vệ dữ liệu chung Châu Âu (GDPR).
   - **AWS US East (us-east-1)**: Cấu hình phân vùng tuân thủ Đạo luật quyền riêng tư người tiêu dùng California (CCPA/CPRA).
   - **AWS Singapore (ap-southeast-1)**: Cấu hình phân vùng tuân thủ PDPA Singapore và các nước ASEAN.
2. **Cơ chế thực thi quyền chủ thể**:
   - Cung cấp API chuẩn hóa để tiếp nhận và thực thi các quyền của chủ thể dữ liệu (Data Subject Access Request - DSAR): trích xuất dữ liệu cá nhân, cập nhật đồng thuận cookie và xóa dữ liệu vĩnh viễn (Right to be Forgotten).

<a id=payments></a>

## 6. Thanh toán, đối soát và xử lý ngoại lệ giao dịch

Hệ thống hỗ trợ cả luồng thanh toán số tức thời (Thẻ tín dụng, LINE Pay, Apple Pay) và luồng nhận hàng trả tiền mặt tại siêu thị (CVS COD). Khách hàng luôn tự xem xét điều khoản và chủ động xác nhận thanh toán qua giao diện của cổng trung gian.

| Khái niệm giao dịch | Bản chất kỹ thuật | Ranh giới phân định |
|---|---|---|
| **Báo giá (Quote)** | Bản chào giá có phiên bản, điều kiện kèm theo và thời hạn hiệu lực | Không đồng nghĩa với tiền đã vào tài khoản |
| **Đơn hàng (Order)** | Yêu cầu mua hàng được hệ thống ERP/POS (API-001) chấp nhận | Chưa đồng nghĩa với đã thanh toán hoặc đã giao hàng |
| **Yêu cầu thanh toán (Payment Intent)** | Đối tượng giao dịch hoặc mã QR được tạo từ Adapter thanh toán | Chưa đồng nghĩa với giao dịch thành công |
| **Giao dịch đối soát (Settled Transaction)** | Bằng chứng webhook từ cổng thanh toán/ngân hàng xác nhận đã nhận tiền | Đã xác nhận doanh thu; nghĩa vụ bảo hành/đổi trả vẫn tiếp tục |

### Quy trình thanh toán và kiểm soát an toàn

1. Máy chủ Core Engine tạo báo giá có phiên bản và đơn hàng tương ứng; khóa cứng đơn giá, đơn vị tiền tệ, số lượng và mã tham chiếu `correlation_id`.
2. Khách hàng kiểm tra điều khoản và thực hiện thanh toán trên cổng trung gian.
3. Hệ thống chỉ ghi nhận thanh toán qua webhook chính thức có chữ ký số hợp lệ; đối soát chính xác mã đơn, số tiền, loại tiền tệ và mã giao dịch nhà cung cấp.
4. Sự kiện thanh toán trùng lặp được bỏ qua nhờ cơ chế lọc theo `effect_key`; sự kiện đến sai thứ tự phải qua đối soát, không đảo ngược trạng thái tùy tiện.
5. Khi cổng thanh toán phản hồi chậm (timeout), hệ thống giữ trạng thái `waiting`, không tự tiện coi là đã trả hoặc chưa trả.
6. Trường hợp trả thiếu, trả thừa, trả sau hạn, hủy đơn hoặc bưu cục hoàn hàng: Hệ thống chuyển vào hàng đợi xử lý ngoại lệ tại SCR-003.
7. Hành động hoàn tiền (Refund) là một giao dịch tài chính độc lập, bắt buộc phải có sự phê duyệt của con người (`AUTH-4` tại SCR-003) và sinh bản ghi kiểm toán riêng; AI tuyệt đối không tự động hoàn tiền.

<a id=section-16></a>

## 7. Bảo mật, Quản trị và Yêu cầu phi chức năng (NFR)

Hệ thống bắt buộc phải đáp ứng đầy đủ 10 yêu cầu phi chức năng (NFR) nền tảng theo Mục 19 SRS:

- **NFR-001 - Security (Bảo mật & Ranh giới phân quyền) - MUST**:
  Agent chỉ được hoạt động nghiêm ngặt trong cấp độ thẩm quyền được cấp (`AUTH-0` đến `AUTH-3`). Bất kỳ hành vi nào cố tình vượt quyền, kể cả do kỹ thuật tấn công chèn chỉ dẫn (Prompt Injection - BR-009) từ người dùng, đều bị hệ thống từ chối (DENY) ở tầng máy chủ.
- **NFR-002 - Auditability (Khả năng kiểm toán bất biến) - MUST**:
  100% các hành động tạo tác động bên ngoài (External Actions) và các quyết định phê duyệt đều phải sinh bản ghi bằng chứng (Evidence Record) gắn liền với mã lần chạy `run_id`, `tenant_id`, timestamp, độ trễ (latency), mức tiêu thụ token, chi phí ước tính và định danh Agent/nhân viên thực hiện.
- **NFR-003 - Idempotency (Chống trùng lặp tác vụ) - MUST**:
  Mọi thao tác thay đổi dữ liệu hoặc phát thông điệp ra ngoài đều phải gắn mã định danh cố định `effect_key`. Việc thực hiện lại nhiều lần với cùng một `effect_key` tuyệt đối không được tạo ra đơn hàng, giao dịch tài chính hoặc tin nhắn trùng lặp.
- **NFR-004 - Availability (Tính sẵn sàng & Phục hồi tự động)**:
  Toàn bộ các quy trình nghiệp vụ quan trọng (Durable Workflows) bắt buộc phải tích hợp cơ chế thử lại hữu hạn theo lũy tiến thời gian (exponential backoff), thời gian chờ tối đa (timeout) và kịch bản phục hồi tự động (recovery) khi tiến trình gặp sự cố; không để tác vụ bị treo vô hạn làm nghẽn hàng đợi.
- **NFR-005 - Explainability (Tính giải trình & Minh bạch quyết định)**:
  100% các quyết định quan trọng (chấm điểm phân loại lead, đề xuất sản phẩm, áp dụng ưu đãi, phân luồng case CSKH) bắt buộc phải lưu trữ đầy đủ lý do logic (`reason`) kèm bằng chứng xác thực (`evidence`) trích xuất từ dữ liệu nguồn.
- **NFR-006 - Data Isolation (Cô lập dữ liệu đa doanh nghiệp) - MUST**:
  Dữ liệu của doanh nghiệp này tuyệt đối không xuất hiện trong ngữ cảnh của doanh nghiệp khác ở bất kỳ tầng kiến trúc nào: DB Schema / Row-Level Security, Redis cache keys, Vector Database Namespaces và Runtime Memory.
- **NFR-007 - Human Override (Quyền can thiệp & Tiếp quản của con người)**:
  Con người luôn có toàn quyền tạm dừng (Pause), hủy bỏ (Cancel) hoặc hiệu chỉnh tham số (Modify) bất kỳ quy trình nào đang chờ duyệt tại SCR-003, cũng như kích hoạt quyền tiếp quản tức thì (Takeover) tại SCR-005 để khóa quyền bot và trực tiếp trao đổi với khách hàng.
- **NFR-008 - Failure Safety - Fail Closed (An toàn khi sự cố) - MUST**:
  Khi không thể xác minh được giá niêm yết, tồn kho thực tế, ranh giới quyền hạn (authority) hoặc sự đồng ý của khách hàng (consent), hệ thống bắt buộc phải **Fail Closed**: Chặn đứng việc thực thi, giữ nguyên trạng thái an toàn, ghi nhận cảnh báo và chuyển giao cho nhân viên xử lý tại SCR-003 / SCR-005.
- **NFR-009 - Performance (Hiệu năng phản hồi & Tải)**:
  Hội thoại tương tác thông thường được thiết kế để phản hồi gần thời gian thực (độ trễ p95 < 1.5s đối với các luồng tư vấn tiêu chuẩn); gói mã nhúng Storefront Widget tối ưu siêu nhẹ (< 20 KB) không làm ảnh hưởng tốc độ tải trang; các chỉ số SLA chính thức được khóa sau vòng kiểm thử benchmark tải.
- **NFR-010 - Cost Observability (Giám sát chi phí vận hành) - MUST**:
  Đo lường chi tiết mức tiêu hao token (input, output, cached tokens), tên mô hình LLM, chi phí gọi tool và cổng Adapter theo thời gian thực. Tính toán chính xác các chỉ số chi phí: cost per run, cost per customer, cost per conversion hiển thị trực tiếp trên SCR-001 và SCR-002.

| Hạng mục an ninh | Tiêu chuẩn kỹ thuật thi hành |
|---|---|
| Cô lập đa doanh nghiệp | Cơ sở dữ liệu RLS hoặc schema độc lập, prefix tenant ở mọi tầng cache và hàng đợi (NFR-006) |
| Phân quyền người dùng (RBAC) | Chủ sở hữu (Owner), Quản trị viên (Admin), Quản lý mô-đun, Nhân viên vận hành, Phân tích chỉ đọc |
| Bảo vệ tài khoản quản trị | Bắt buộc xác thực đa yếu tố (MFA); hỗ trợ đăng nhập một lần (SSO SAML/OIDC) cho doanh nghiệp lớn |
| Quản lý bí mật & Khóa API | Lưu trữ hoàn toàn trong biến môi trường (.env / KMS); không bao giờ đưa vào mã client hoặc log file |
| Mã hóa dữ liệu | Mã hóa toàn bộ dữ liệu đường truyền bằng TLS 1.3 và dữ liệu lưu trữ bằng thuật toán AES-256 |
| Bảo vệ Webhook sự kiện | Xác thực chữ ký số HMAC-SHA256, kiểm tra timestamp chống tấn công phát lại (Replay Attack) |
| Kiểm soát cuộc gọi mạng | Cấu hình tường lửa chỉ cho phép kết nối tới danh sách domain/IP đã phê duyệt; chặn SSRF |
| Tuân thủ quyền riêng tư | Tối thiểu hóa dữ liệu (Data Minimization); cam kết Zero Data Retention với các nhà cung cấp mô hình LLM |

## 8. Quản lý lỗi, Giám sát vận hành và Tiêu chí nghiệm thu

### Bảng mã lỗi chuẩn hóa

Mọi phản hồi lỗi đều có mã lỗi cố định, thông điệp rõ ràng bằng tiếng Việt, cờ `retryable` (chỉ định việc có nên thử lại hay không) và mã truy vết `correlation_id`:

| Mã lỗi hệ thống | Ý nghĩa lỗi | Cờ `retryable` | Hành động khắc phục |
|---|---|---|---|
| `AUTHENTICATION_FAILED` | Xác thực danh tính hoặc chữ ký số không hợp lệ | `false` | Kiểm tra lại thông tin API key / token |
| `CUSTOMER_UNVERIFIED` | Phiên tương tác chưa xác minh được danh tính khách | `false` | Yêu cầu xác thực tài khoản hoặc số điện thoại |
| `CAPABILITY_NOT_ENABLED` | Mô-đun hoặc tính năng chưa được kích hoạt cho tenant | `false` | Bật tính năng trong cấu hình doanh nghiệp |
| `VALIDATION_FAILED` | Dữ liệu đầu vào không khớp JSON Schema của Skill | `false` | Sửa lại tham số payload theo đúng lược đồ |
| `IDEMPOTENCY_CONFLICT` | Trùng lặp `effect_key` nhưng khác nội dung payload | `false` | Tạo khóa mới cho thao tác nghiệp vụ mới |
| `APPROVAL_REQUIRED` | Thao tác cấp AUTH-4 cần phê duyệt của con người | `false` | Chờ người duyệt thao tác tại SCR-003 |
| `PROVIDER_TIMEOUT` | Cổng Adapter hoặc ERP nguồn phản hồi quá hạn | `true` | Thử lại với exponential backoff theo NFR-003 |
| `PROVIDER_REJECTED` | Cổng thanh toán hoặc đối tác từ chối lệnh | `false` | Kiểm tra nguyên nhân từ chối tại Adapter |
| `RATE_LIMITED` | Vượt ngưỡng giới hạn tần suất gọi API | `true` | Tạm dừng và thử lại sau khoảng thời gian chờ |
| `TASK_NOT_FOUND` | Không tìm thấy mã định danh tác vụ trong hệ thống | `false` | Kiểm tra lại tính chính xác của `task_id` |

### Tiêu chí kiểm thử nghiệm thu kỹ thuật (Acceptance Criteria)

1. **TC-E2E-001 (Chu trình 11 bước E2E)**: Luồng tương tác hoàn tất trọn vẹn chu trình từ Signal → Context → Hypothesis → Decision → Plan → Action → Approval → Execution → Evidence → Outcome → Learning.
2. **TC-E2E-002 / TC-E2E-006 (Kiểm soát quyền hạn)**: Mọi thao tác ngoài thẩm quyền hoặc thiếu phê duyệt AUTH-4 đều bị chặn cứng (DENY) và sinh bản ghi kiểm toán (NFR-001, NFR-002, BR-008).
3. **TC-E2E-005 (Chống trùng lặp tác vụ)**: Gửi lại yêu cầu với cùng mã `effect_key` bảo đảm không tạo ra đơn hàng hoặc tin nhắn thứ hai; gửi khác payload dưới cùng khóa trả về `IDEMPOTENCY_CONFLICT` (NFR-003).
4. **TC-NFR-006 (Cô lập dữ liệu đa doanh nghiệp)**: Kiểm thử rà quét rò rỉ dữ liệu giữa 2 tenant thử nghiệm ở cả tầng DB, Redis, Vector index và AI context; tỷ lệ rò rỉ đạt 0% (NFR-006).
5. **TC-NFR-008 (An toàn sự cố Fail Closed)**: Khi ngắt kết nối API-001 hoặc làm sai lệch dữ liệu consent, hệ thống lập tức fail closed, bảo lưu trạng thái và thông báo cho nhân viên (NFR-008).
6. **TC-ADPT-001 (Kiểm thử Adapter Đài Loan)**: Kiểm tra luồng tương tác trên LINE OA, chọn siêu thị CVS COD E-Map qua ECPay, đối soát đơn hàng thành công trên môi trường cụm GCP Changhua (ADPT-TW-001).
7. **TC-ADPT-002 (Kiểm thử Adapter Toàn cầu)**: Kiểm tra gửi tin nhắn WhatsApp Cloud API (ADPT-GL-001), thanh toán thẻ qua Stripe đa tiền tệ (ADPT-GL-002) và phân vùng dữ liệu tuân thủ GDPR tại AWS Frankfurt (ADPT-GL-003).
8. **TC-BR-009 (Chống Prompt Injection)**: Chèn chỉ dẫn giả mạo trong tin nhắn khách hàng nhằm nâng quyền hoặc yêu cầu chiết khấu vi phạm giá sàn $P_{floor}$; hệ thống nhận diện và từ chối xử lý (BR-001, BR-002, BR-009).

