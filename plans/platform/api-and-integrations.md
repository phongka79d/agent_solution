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

## 5. Bộ kết nối và phạm vi

| Kết nối | Đọc | Ghi khi được phép | Giai đoạn |
|---|---|---|---|
| Danh mục | Sản phẩm, điều kiện, giá, khả dụng | Không sửa danh mục trong P1 | P1 bắt buộc một nguồn |
| Hệ thống lưu khách/yêu cầu hoặc CRM | Khách, yêu cầu/cơ hội, chủ sở hữu | Ghi chú, trường hỏi nhu cầu, bước tiếp theo | P1 một nguồn; không yêu cầu CRM mới nếu hệ thống hiện có đáp ứng |
| Kênh/website | Phiên, tin nhắn, trạng thái giao | Trả lời và nhắc có điều kiện | P1 website; kênh khác chọn riêng |
| Lịch | Khả dụng và lịch đã đặt | Tạo lịch có xác nhận | P1 chỉ khi chọn hành trình cần hẹn |
| Đơn hàng | Đơn và trạng thái | Tạo/sửa theo chính sách | P1 tùy nguồn chỉ đọc; thực thi sau P1 |
| Thanh toán | Yêu cầu/giao dịch và đối soát | Tạo yêu cầu thanh toán được duyệt | Sau P1; hoàn tiền luôn quyền riêng |
| Vận chuyển | Trạng thái, khả năng khung giờ, liên hệ được phép | Yêu cầu vận chuyển theo quyền | Sau P1 |
| Phiếu hỗ trợ / phiếu mua hàng | Trạng thái, người nhận, điều kiện | Tạo/cập nhật/cấp theo chính sách | Sau P1 |
| Quảng cáo / đối tác | Nguồn, chi phí và kết quả được phép | Không tự xuất bản, chi ngân sách hoặc trả hoa hồng | Sau P1 theo thử nghiệm |

GHN, GHTK, Viettel Post, LINE, Zalo, Facebook, WhatsApp, email, ngân hàng và ví trong tài liệu nguồn chỉ là ứng viên kết nối. Cần xác nhận quyền truy cập và năng lực từng nhà cung cấp; không cam kết thông tin vị trí trực tiếp, số người giao hay mở ứng dụng nếu API không hỗ trợ.

Mỗi bộ kết nối chịu trách nhiệm xác thực, ánh xạ trường, giới hạn tốc độ, thời gian chờ, loại lỗi, khóa đối soát và kiểm thử. Quyền đọc và ghi cấu hình độc lập; ngoài danh sách phải từ chối.

Kết quả hành động chung gồm `operation_id`, `effect_key`, `operation`, `source_record`, `status`, `provider_reference`, `reconciliation_key`, `correlation_id`. Trạng thái hành động là `confirmed` (xác nhận), `rejected` (từ chối) hoặc `uncertain` (chưa rõ). Mã HTTP 200/202 không tự thay kết quả nghiệp vụ.

<a id=payments></a>

## 6. Thanh toán và báo giá có thời hạn

NAPAS mô tả VietQR giúp giảm thao tác nhập thông tin; khách vẫn kiểm tra người nhận và xác nhận chuyển khoản trong ứng dụng ngân hàng. Không suy ra khả năng mở mọi ngân hàng, thời gian ba giây hoặc phí bằng 0 từ mô tả này. [Nguồn NAPAS](https://www.napas.com.vn/dich-vu-chuyen-tien-nhanh-napas-247).

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

## 7. Bảo mật và quản trị dữ liệu

| Lĩnh vực | Yêu cầu thiết kế |
|---|---|
| Tách doanh nghiệp | Kiểm tra ở cơ sở dữ liệu, truy xuất, tệp, hàng đợi, công việc và báo cáo |
| Vai trò | Chủ doanh nghiệp, quản trị, quản lý từng mô-đun, nhân viên được phân công, phân tích chỉ đọc |
| Tài khoản quản trị | Xác thực nhiều yếu tố; đăng nhập tập trung khi doanh nghiệp yêu cầu |
| Bí mật | Lưu bảo vệ, giới hạn quyền, xoay vòng; không đưa vào trình duyệt, lời hướng dẫn AI hay nhật ký |
| Truyền/lưu dữ liệu | Mã hóa phù hợp hạ tầng; TLS 1.3 và AES-256 trong PDF là mục tiêu cấu hình cần kiểm tra, không là chứng nhận tuân thủ |
| Sự kiện | Xác thực chữ ký/mã thông điệp theo nhà cung cấp, cửa sổ chống phát lại, chống trùng |
| Điểm kết nối | Chỉ địa chỉ đã duyệt; chặn gọi mạng nội bộ/địa chỉ tùy ý do nội dung không tin cậy đề xuất |
| AI và công cụ | Dữ liệu không được cấp quyền; kiểm tra lược đồ, vai trò, phê duyệt, hạn mức ngay khi thực thi |
| Nhà cung cấp AI | Tối thiểu hóa dữ liệu, thỏa thuận mục đích/lưu trữ; không chia sẻ hay dùng lại chéo doanh nghiệp |
| Vòng đời dữ liệu | Có người chịu trách nhiệm về lưu, xuất, xóa, bản sao lưu, sự cố và thu hồi quyền |
| Nhật ký | Chủ thể, doanh nghiệp, khách/cuộc trao đổi, hành động, phiên bản, phê duyệt, kết quả, thời gian, truy vết; che dữ liệu nhạy cảm |

Về căn cứ pháp lý: Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 có hiệu lực từ 01/01/2026. Vì vậy, kế hoạch tại thời điểm 10/09/2026 không thể chỉ viện dẫn Nghị định 13/2023/NĐ-CP như PDF để tự tuyên bố tuân thủ. [Cổng văn bản Chính phủ](https://vanban.chinhphu.vn/?classid=1&docid=214590&pageid=27160&typegroup=).

Đây là lưu ý cần rà soát, không phải kết luận pháp lý đầy đủ. Trước vận hành, người phụ trách pháp lý/bảo vệ dữ liệu cần xác định quy định đang áp dụng, mục đích/căn cứ xử lý, quyền chủ thể dữ liệu, vai trò các bên, hồ sơ/thỏa thuận cần thiết, chuyển dữ liệu khi có, thông báo sự cố và chính sách ưu đãi/đổi trả. Đánh giá thêm quy định ngành và điều khoản nền tảng được chọn; không lấy mã hóa hoặc ô đồng ý làm bằng chứng đã hoàn tất mọi nghĩa vụ.

## 8. Lỗi, vận hành và nghiệm thu

Lỗi cần mã ổn định, thông điệp tiếng Việt, `retryable` (cờ cho biết có thể thử lại), mã truy vết và chi tiết an toàn. Mã đề xuất: `AUTHENTICATION_FAILED`, `CUSTOMER_UNVERIFIED`, `CAPABILITY_NOT_ENABLED`, `VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, `APPROVAL_REQUIRED`, `PROVIDER_TIMEOUT`, `PROVIDER_REJECTED`, `RATE_LIMITED`, `TASK_NOT_FOUND`.

Theo dõi độ trễ, lỗi công cụ, hàng đợi, công việc kẹt, thiếu nguồn kiến thức, lượng dùng AI và chi phí. Có giới hạn thử lại, người trực xử lý ngoại lệ và cách ngắt từng năng lực/từng doanh nghiệp. Phục hồi dữ liệu phải được diễn tập; quay lại cấu hình không phát lại giao dịch.

Bộ thử bắt buộc:

1. Quyền chéo doanh nghiệp, khách chưa xác minh, mô-đun tắt, thao tác ngoài quyền đều bị chặn.
2. Yêu cầu/sự kiện trùng không tạo tác động thứ hai; khóa trùng khác nội dung bị báo xung đột.
3. Thông báo trùng/cũ/mất không làm lùi trạng thái; truy vấn phục hồi đúng kết quả.
4. Lỗi sau khả năng ghi phải đối soát; trạng thái chưa rõ không biến thành thành công.
5. Bàn giao/phê duyệt được xác thực; chưa có người nhận thì vẫn đang chờ.
6. Mỗi ghi thành công có tham chiếu hệ thống nguồn và nhật ký.
7. Tấn công chèn chỉ dẫn, sửa giá phía khách, phát lại sự kiện và lách hạn mức đều có thử âm tính.
8. Khi bật thanh toán: kiểm tra tiền muộn/thiếu/thừa, trùng giao dịch, sai người nhận, sai tiền tệ và hoàn tiền có quyền riêng.
