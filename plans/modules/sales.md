# Mô-đun Bán hàng — Tư vấn đúng và kiểm soát giao dịch

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P1 tập trung tư vấn và chuyển sang quy trình mua hiện có; ưu đãi, đơn hàng và thanh toán tự động phải được bật riêng sau nghiệm thu.

<a id=section-7></a>

# PHẦN 1: KHUNG GẦM KỸ THUẬT CHUẨN SRS (CORE SALES ENGINE)

## 1. Mục tiêu và ranh giới

Giúp khách chọn giải pháp đủ dùng và đi đến bước mua phù hợp, với giá và điều kiện có căn cứ (khớp mục tiêu **OBJ-002** trong SRS). Không tối ưu số đơn bằng cách bán sai nhu cầu hoặc giảm giá làm mất hiệu quả kinh tế.

| Bối cảnh | Hỏi tối thiểu | Bước tiếp theo |
|---|---|---|
| Bán lẻ B2C | Nhu cầu, điều kiện dùng, tầm giá nếu cần; thiết bị/kích cỡ/biến thể khi liên quan | Gợi ý vài lựa chọn, giỏ/trang mua hiện có |
| Bán hàng B2B cần tư vấn | Nhu cầu, ngân sách, người quyết định, thời điểm, quy mô | Đặt lịch, chuẩn bị thông tin báo giá, theo dõi cơ hội |
| Khách cũ | Nhu cầu mới và sản phẩm hiện dùng đã xác minh nếu cần | Giữ sản phẩm cũ, mua bổ sung hoặc nâng cấp có lý do |

Không bắt người mua lẻ khai chức vụ hay người phê duyệt. Không ép khách tiết lộ dữ liệu không cần thiết. Trường chưa biết được ghi rõ, không suy đoán. Mọi hành động đều tuân thủ nguyên tắc không vượt quyền (**BR-008**) và không tự nâng quyền từ dữ liệu do khách cung cấp (**BR-009**).

## 2. Hệ thống 5 Core Sales Agent chuẩn SRS (SAL-01 đến SAL-05)

Mô-đun Bán hàng vận hành với cấu trúc 5 Agent chuyên trách theo chuẩn SRS, phối hợp qua Revenue Orchestrator:

| Mã Agent | Tên Agent | Nhiệm vụ cốt lõi & Tiêu chuẩn SRS | Quyền hạn (Authority) | Đầu vào chính | Đầu ra chuẩn (Reason + Evidence) |
|---|---|---|---|---|---|
| **SAL-01** | Lead Qualification Agent | **FR-SAL-001 - MUST:** Xác định khách mới/cũ, nhu cầu, sản phẩm quan tâm, mức độ sẵn sàng mua, hành vi gần nhất, lịch sử mua và cơ hội bán | AUTH-1 (Recommend) | Sự kiện Web/App, lịch sử tương tác Marketing, hồ sơ Customer 360 | Điểm sẵn sàng mua, lý do (Reason), bằng chứng (Evidence) |
| **SAL-02** | AI Sales Advisor | **FR-SAL-002 - MUST:** Hỏi nhu cầu, tìm/so sánh sản phẩm, kiểm tra tồn, kiểm tra giá, giải thích chính sách, đề xuất sản phẩm chính và sản phẩm bổ sung | AUTH-3 (trong phạm vi dữ liệu đã duyệt) | Câu hỏi của khách, danh mục ERP/POS, tồn kho WMS, bảng giá | Lời tư vấn kèm căn cứ kỹ thuật/chính sách, so sánh tùy chọn |
| **SAL-03** | Recommendation Agent | **FR-SAL-003 - MUST:** Sinh đề xuất sản phẩm, cross-sell, upsell, sản phẩm thay thế (substitute), mua bổ sung (replenishment) và combo (bundle) | AUTH-1 (Recommend) | Giỏ hàng hiện tại, hồ sơ khách, mức độ tương thích sản phẩm | Đề xuất gồm: Customer, Product, Reason, Evidence, Eligibility, Confidence, Expected Outcome |
| **SAL-04** | Cart Recovery Agent | Phát hiện giỏ hàng bỏ quên (abandoned cart), kiểm tra customer context, consent, tồn kho, giá, áp dụng quy tắc suppression, chọn kênh và tạo thông điệp | AUTH-3 (nhắc giỏ theo lịch) / AUTH-4 (kèm trợ cấp giá) | Sự kiện giỏ hàng bỏ quên, tồn kho khả dụng, trạng thái consent | Thông điệp nhắc giỏ cá nhân hóa, đo lường conversion |
| **SAL-05** | Reorder / Replenishment Agent | Phân tích chu kỳ tiêu dùng thực tế để phát hiện nhu cầu mua lại. Chặn gửi nếu khách từ chối marketing, sản phẩm ngừng bán, hết hàng, khách vừa mua lại hoặc bị suppression | AUTH-1 (Recommend) / AUTH-3 (gửi nhắc định kỳ) | Chu kỳ mua quá khứ, mức tiêu hao ước tính, trạng thái tồn kho | Thông báo nhắc tái đặt hàng 1-chạm, liên kết giỏ hàng định kỳ |

### 2.1. Quy trình phối hợp xử lý bán hàng chuẩn (Sales Coordination Flow)

1. **Tiếp nhận & Xác thực:** Kiểm tra quyền, mô-đun bật, xác minh định danh khách trước khi truy cập dữ liệu mua hàng riêng biệt.
2. **Định chuẩn nhu cầu (SAL-01):** Khai thác thông tin tối thiểu theo hành trình, ghi nhận bằng chứng hành vi, không gán nhãn suy diễn.
3. **Tra cứu thời gian thực (SAL-02):** Gọi các Skill kiểm tra giá và tồn kho trực tiếp từ System of Record (ERP/POS); tuyệt đối không bịa thông số hoặc giá bán (**BR-001**, **BR-003**).
4. **Cá nhân hóa đề xuất (SAL-03):** Đề xuất giải pháp đủ dùng, nêu rõ đánh đổi; chỉ đưa gợi ý kèm đầy đủ 7 trường thông tin bắt buộc (Reason + Evidence + Confidence).
5. **Chốt giao dịch & Bàn giao:** Khách tự xác nhận bước mua hoặc hẹn lịch tư vấn B2B; ghi nhận kết quả xác thực qua máy chủ trước khi bàn giao khâu tiếp theo.

## 3. Hệ thống Kỹ năng bán hàng (Sales Skill System)

Theo Mục 11 của SRS, Agent (lớp nhận thức/hội thoại) và Skill (lớp thực thi tác vụ) được tách biệt hoàn toàn. Các Sales Agent gọi 8 Skill chuẩn thông qua Orchestrator với hợp đồng kiểm soát nghiêm ngặt:

| Mã Skill (Skill ID) | Mục đích (Purpose) | Agent được phép dùng | Quyền hạn yêu cầu | Tool / Connector | Quy tắc kiểm tra (Validation) & Audit |
|---|---|---|---|---|---|
| `search-product` | Tra cứu danh mục, thông số, biến thể theo từ khóa/nhu cầu | SAL-02, SAL-03 | AUTH-0 (Observe) | Catalog Search API / Vector DB | Lọc theo trạng thái đang bán (Active SKU); ghi log truy vấn |
| `check-stock` | Kiểm tra tồn kho khả dụng theo SKU và vị trí kho gần nhất | SAL-02, SAL-03, SAL-04, SAL-05 | AUTH-0 (Observe) | WMS / ERP Inventory API | Xác thực SKU tồn tại; fail closed nếu hệ thống kho mất kết nối |
| `check-price` | Tra cứu bảng giá niêm yết, chính sách giá và thuế/phí chính thức | SAL-02, SAL-03, SAL-04 | AUTH-0 (Observe) | ERP Pricing Engine | Bắt buộc đọc từ System of Record; không cho phép AI tự tạo giá (**BR-001**) |
| `retrieve-customer` | Đọc Customer 360: lịch sử mua, giỏ hàng, điểm tín nhiệm, consent | SAL-01, SAL-03, SAL-04, SAL-05 | AUTH-0 (Observe) | Customer 360 Ingestion Layer | Bắt buộc xác minh định danh (Customer Verification); cô lập dữ liệu khách (**NFR-006**) |
| `recommend-product` | Sinh danh sách đề xuất (cross/up/substitute/bundle) | SAL-03 | AUTH-1 (Recommend) | Recommendation Engine | Đủ 7 trường dữ liệu bắt buộc (Reason, Evidence, Eligibility...); kiểm tra tương thích |
| `create-cart` | Khởi tạo giỏ hàng hoặc thêm SKU vào phiên mua sắm của khách | SAL-02, SAL-04 | AUTH-3 (Bounded Execute) | E-commerce Core Cart API | Kiểm tra tồn kho trước khi thêm; chống trùng thao tác bằng idempotency key |
| `create-order` | Tạo đơn hàng nháp hoặc đơn đặt cọc chính thức vào ERP | SAL-02 | AUTH-4 (Approval / Server Verified) | ERP / POS Order API | Yêu cầu chữ ký xác thực giá máy chủ; gắn Unique Execution ID (**BR-005**) |
| `send-message` | Gửi tin tư vấn, nhắc giỏ qua Web, App, Zalo, LINE OA | SAL-02, SAL-04, SAL-05 | AUTH-3 (Bounded Execute) | Communication Gateway | Kiểm tra trạng thái Consent và quy tắc Suppression (**BR-004**); chống spam |

### 3.1. Hợp đồng Kỹ năng chuẩn (Skill Contract Schema)

Mỗi Skill khi được kích hoạt phải tuân thủ schema tối thiểu:
`Skill_Call = { skill_id, run_id, caller_agent, customer_id, input_payload, required_authority, idempotency_key, timeout_ms, retry_policy }`.
Mọi lượt gọi Skill đều được ghi vết vào Audit Log phục vụ đối soát và đo lường chi phí/độ trễ (**NFR-002**, **NFR-010**).

## 4. Trải nghiệm tư vấn có bằng chứng

| Năng lực | Quy tắc |
|---|---|
| Giải thích thông số | Dùng mô tả đã duyệt; tách thông số đo được khỏi ước tính và điều kiện sử dụng |
| Câu hỏi chọn nhanh | Hỏi từng câu cần thiết, khách có thể bỏ qua hoặc tự gõ |
| So sánh nâng cấp | Xác nhận đúng mẫu cũ/mới, chỉ ra vài khác biệt liên quan; không có bằng chứng thì không nêu phần trăm hiệu năng |
| Khuyên không mua đắt hơn | Nêu phương án đủ dùng hoặc chưa cần mua; không dựng lý do để ép nâng cấp |
| Soát giỏ hàng | Gợi ý sản phẩm trùng/không tương thích dựa dữ liệu; khách xác nhận trước khi sửa |
| Gợi ý đạt miễn phí giao hàng | Hiển thị tổng tiền trước/sau và điều kiện thật; không tự thêm món |
| Kích hoạt mở đầu (First-Touch) | Chờ khách dừng xem > 6–8s hoặc cuộn > 50%; hiển thị bong bóng nhỏ (micro-pill) cạnh nút Mua kèm nút 1-chạm; không bung che màn hình, không đòi SĐT/đăng nhập |

Không chuyển "10.000 mAh" thành số lần sạc cụ thể chỉ bằng suy đoán; không hứa thời gian đun nước, tiền điện, độ yên tĩnh hoặc kết quả sức khỏe từ một thông số đơn lẻ. Mọi dẫn chứng kỹ thuật phải được kiểm chứng theo sản phẩm và điều kiện thử trước khi dùng với khách.

## 5. Hỗ trợ thanh toán, giao hàng và hóa đơn

P1 dùng trang thanh toán/quy trình hiện có; AI không tự tạo mã thanh toán hoặc đánh dấu đã trả tiền.

Sau P1, ưu tiên kết nối nhà cung cấp/hệ thống doanh nghiệp đã dùng. Lưu lựa chọn ứng dụng thanh toán nếu khách cho phép; không lưu thông tin đăng nhập ngân hàng, mã OTP hoặc dữ liệu sinh trắc học. Có phương án QR, sao chép thông tin hay trang thanh toán thay thế nếu liên kết mở ứng dụng không hoạt động.

Khách vẫn kiểm tra thông tin và xác nhận trong ứng dụng ngân hàng/ví điện tử; đây là luồng bảo mật tiêu chuẩn, không phải thanh toán AI tự quyết. Thanh toán chỉ xác nhận bằng nguồn tin cậy từ webhook ngân hàng/cổng thanh toán, không bằng ảnh chụp màn hình hoặc trang quay về. Xem chi tiết tại [API và tích hợp](../platform/api-and-integrations.md#payments).

Khung giờ giao và yêu cầu hóa đơn chỉ được chuyển tới hệ thống có năng lực tương ứng. Thu mã số thuế không có nghĩa hóa đơn đã phát hành; chọn khung giờ không có nghĩa đã được đơn vị vận chuyển chấp nhận.

## 6. Ranh giới bản đầu (P1 Scope & Guardrails)

| Cho phép trong P1 | Chưa cho phép trong P1 |
|---|---|
| Hỏi nhu cầu, giải thích từ nguồn duyệt, lưu ghi chú và bước tiếp theo | Sửa giá, mã khuyến mãi, tự mặc cả hoặc phát phiếu |
| Đọc danh mục và chuyển khách tới quy trình mua hiện có | Tạo/thu thanh toán, hoàn tiền, hủy đơn hoặc sửa tài khoản |
| Cập nhật trường khách/yêu cầu/CRM đã được cấp quyền | Cập nhật hàng loạt hoặc trường ngoài danh sách |
| Đặt một lịch được xác nhận nếu cấu hình B2B chọn lịch | Tự đổi/hủy lịch hoặc báo đặt thành công khi chưa có mã |
| Chuẩn bị thông tin để nhân viên báo giá | Tự phát hành báo giá thương mại |
| Một chuỗi nhắc tối đa hai tin khi đủ điều kiện | Nhắc vô hạn, gửi sau khi khách trả lời/từ chối hoặc người tiếp quản |

## 7. Tiêu chí nghiệm thu kỹ thuật & Hệ chỉ số KPI chuẩn SRS

### 7.1. Bảng kiểm tra nghiệm thu Bán hàng (Acceptance Criteria)

| Tình huống | Kết quả bắt buộc | Mã kiểm thử SRS |
|---|---|---|
| Sản phẩm/giá cũ hoặc thiếu | Không đưa giá cuối; làm mới hoặc chuyển người | TC-E2E-003, BR-003 |
| AI đưa giá không có trong nguồn ERP/POS | Bị chốt chặn chối bỏ (Fail Closed); ghi audit violation | TC-E2E-003, BR-001 |
| Không có sản phẩm phù hợp | Nêu giới hạn và lựa chọn tiếp theo; không bịa sản phẩm | FR-SAL-002 |
| Chưa xác minh khách | Chỉ dùng thông tin công khai/phiên hợp lệ; cô lập dữ liệu | NFR-006 |
| Ghi CRM hoặc đặt lịch bị hết thời gian chờ | Tra kết quả bằng mã đối soát idempotency; không tạo trùng | NFR-003, BR-006 |
| Bỏ quên giỏ hàng (Cart Recovery) | Kiểm tra consent → Tồn kho → Giá → Suppression → Tin nhắc cá nhân hóa | PILOT-02, SAL-04 |
| Đơn lớn, giá ngoại lệ hoặc khách muốn gặp người | Bàn giao có người chịu trách nhiệm, AI tạm dừng | NFR-007 |
| Mô-đun Bán hàng chưa bật | Từ chối rõ hoặc chuyển hàng đợi người xử lý | Lộ trình P1 |
| Yêu cầu giá 0, sửa giỏ/báo giá/tiền tệ từ trình duyệt | Máy chủ từ chối; không thể lách bằng nội dung nhắc AI | BR-002, BR-009 |
| Báo giá/đơn hết hạn nhưng có tiền tới | Trạng thái cần đối soát, không bỏ tiền hoặc giao hàng tự động | Đối soát thanh toán |
| Tư vấn xong nhưng chưa có giao dịch nguồn | Hoàn thành tư vấn, không tính doanh thu | Đo lường bằng chứng |

### 7.2. Hệ chỉ số KPI Bán hàng theo SRS

Hiệu quả của hệ thống 5 Sales Agent được đo lường qua các chỉ số:
- **Lead-to-Order Conversion:** Tỷ lệ đầu mối chuyển đổi thành đơn hàng thành công có xác thực qua ERP.
- **Cart Recovery Rate:** Tỷ lệ giỏ hàng bỏ quên được phục hồi thành công qua SAL-04.
- **Recommendation Conversion:** Tỷ lệ khách hàng mua sản phẩm từ đề xuất cross-sell/upsell/bundle của SAL-03.
- **Upsell & Cross-sell Revenue:** Doanh thu gia tăng từ việc bán thêm/bán chéo giải pháp.
- **Average Order Value (AOV):** Giá trị đơn hàng trung bình sau khi áp dụng gợi ý và gói bundle.
- **Sales Cycle:** Thời gian từ lúc phát sinh nhu cầu đến khi hoàn tất thanh toán hoặc đặt cọc giữ chỗ.

---

# PHẦN 2: KỊCH BẢN THỰC CHIẾN CHUYÊN NGÀNH (DOMAIN PLAYBOOKS)

## ECN-002: Deterministic Floor Price Engine ($P_{floor}$) — Khóa cứng biên lãi ròng

Năng lực mặc cả thương mại nằm sau P1. Lớp hội thoại chỉ đóng vai trò tiếp nhận nhu cầu và mức giá khách kỳ vọng; **tuyệt đối không nhận quyền quyết định tiền, không được truy cập hay tiết lộ giá vốn nội bộ, không tự ghi đè giá sàn**. Dữ liệu chi phí chỉ đi tới bộ tính giá máy chủ (Pricing Engine) và vai trò được cấp quyền.

Công thức ngân sách, giá sàn và ví dụ được định nghĩa duy nhất tại [kinh tế đơn hàng](../delivery/analytics.md#unit-economics):

```text
P = P_base − D; 0 ≤ D ≤ D_cap
Lãi đóng góp = P × (1 − r) − C

P_floor = max((C + L) / (1 − r), P_base − D_cap)
Điều kiện: 0 ≤ r < 1; dữ liệu chi phí đầy đủ và hợp lệ.
```

Trong đó:
- $P_{base}$: Giá niêm yết cơ sở của sản phẩm trên phạm vi đơn, chưa thuế và chưa gồm phí ship thu riêng.
- $C$: Chi phí biến đổi theo đơn: giá vốn hàng bán (COGS), xử lý đơn, chi phí vận hành AI (ngân sách định mức 0,5–1 TWD/phiên tư vấn hoàn chỉnh, tương đương ~400–800 VNĐ), chi phí đóng gói, dự phòng đổi trả và rủi ro hoàn hủy.
- $r$: Tỷ lệ chi phí tính trên doanh thu (phí thanh toán cổng gateway, hoa hồng đối tác).
- $L$: Biên lãi ròng / lãi đóng góp tối thiểu yêu cầu trên đơn.
- $D_{cap}$: Hạn mức giảm tiền tối đa của đơn đã được phê duyệt.

### Quy trình phê duyệt giá sàn và giữ chỗ ngân sách nguyên tử
1. **Truy vấn dữ liệu nguồn:** Máy chủ đọc giá gốc, chi phí $C$, tỷ lệ $r$, phiên bản chính sách, tồn kho và quyền áp dụng.
2. **Kiểm tra trần giảm giá:** Tính tổng lợi ích đã cấp (giảm tiền trực tiếp, mã voucher, trợ phí vận chuyển, hoa hồng đối tác). Từ chối nếu thiếu dữ liệu, vượt ngân sách hoặc kết quả tính toán cho ra mức giá dưới sàn $P_{floor}$.
3. **Giữ chỗ nguyên tử (Atomic Budget Hold):** Nếu hợp lệ, tạo báo giá gắn với doanh nghiệp, khách/phiên, giỏ hàng, số lượng, tiền tệ, giá, thời hạn (TTL) và phiên bản chính sách. Giữ chỗ ngân sách tương ứng bằng thao tác nguyên tử trong cơ sở dữ liệu để ngăn chặn tình trạng nhiều đơn đồng thời cùng khai thác một phần ngân sách.
4. **Xác thực toàn vẹn (HMAC / Quote Token):** Báo giá được phát hành kèm mã xác thực thông điệp HMAC hoặc token ngẫu nhiên tra cứu phía máy chủ. Mọi API tạo đơn hoặc trang thanh toán đều phải kiểm tra chữ ký này trước khi xác nhận đơn.
5. **Chuyển hóa ngân sách:** Khi đơn thanh toán thành công, phần ngân sách giữ chỗ được chuyển thành đã dùng (committed). Nếu hết hạn TTL mà khách không thanh toán, ngân sách được giải phóng tự động về quỹ chung.

## ECN-001: Sales Commission Reallocation & Instant Dynamic Subsidy (AI 智能即時補貼) — Trợ cấp chốt đơn thay thế mặc cả

### 1. Phân luồng ý định & Tái định vị trợ cấp giá (Selective Subsidy Discovery)
- **Tuyệt đối im lặng với khách sẵn sàng mua giá gốc:** Nếu khách chỉ hỏi về thông số kỹ thuật, công năng, bảo hành hoặc thời gian giao hàng, AI tập trung tư vấn chốt đơn theo giá niêm yết, tuyệt đối không chủ động gợi ý giảm giá.
- **Tái định vị thuật ngữ cho thị trường Đài Loan (Chống nghi ngờ lừa đảo - 詐騙):**
  - Người tiêu dùng Đài Loan đặc biệt cảnh giác với website lừa đảo (詐騙網站); việc cho khách "trả giá tay đôi với bot" sẽ phá hủy định vị thương hiệu chính hãng.
  - Tuyệt đối không dùng từ "Mặc cả" (討價還價). Thay thế bằng các thuật ngữ thương mại bản địa: **"Trợ cấp chốt đơn tự động" (AI 智能即時補貼)**, **"Đặc quyền thành viên LINE" (LINE 專屬快閃折抵)** hoặc **"Tặng thêm điểm thưởng LINE Points" (加碼送 LINE Points)**.
  - Hiển thị bảo chứng uy tín trong khung chat: **Mã số thuế doanh nghiệp Đài Loan (統一編號 - Tongyi Bianhao)** và chứng nhận tài khoản **LINE Official Account tick xanh/xám**.

### 2. Kích hoạt có điều kiện và giới hạn suất
- **Bắt tín hiệu nhạy cảm về giá (Price-Sensitivity Triggers):** Ưu đãi chỉ được kích hoạt khi khách ngần ngại về chi phí (ví dụ: *"giá hơi cao/đắt"*, *"vượt ngân sách"*, *"có mã ưu đãi không"*, *"bên khác rẻ hơn"*).
- **Mở lời có điều kiện:** AI mở gói trợ cấp giới hạn: *"Hệ thống vừa mở thêm 3 suất trợ cấp độc quyền 150 TWD cho đơn hàng xác nhận qua LINE Pay hoặc nhận tại 7-Eleven hôm nay, bạn có muốn nhận suất này không?"*.
- **Nút tương tác động (CTA Timer 10 phút):** Giao diện xuất hiện nút nhanh `[Khóa đơn nhận trợ cấp trong X phút]` kèm đồng hồ đếm ngược đúng 10 phút (TTL 10 phút).
- **Tính minh bạch:** Thời hạn 10 phút phải được thông báo trung thực. Không tạo khan hiếm giả, không đóng kịch "lỗ vốn" hoặc "xin cấp trên" để gây áp lực tâm lý. Khi hết hạn 10 phút, báo giá tự động hủy và ngân sách giữ chỗ được hoàn trả.

## DOM-FMCG-001: Smart Cart & Compatibility Guard — Soát giỏ hàng thông minh

Kịch bản chuyên biệt cho phân hệ Bán lẻ & Hàng tiêu dùng nhanh (FMCG D2C):

1. **Soát độ tương thích và kiểm tra biến thể:**
   - Kiểm tra các mặt hàng trong giỏ để phát hiện các trường hợp không tương thích về phụ kiện, đầu nối, biến thể dung tích hoặc kích cỡ.
   - Đối chiếu hồ sơ Customer 360 để phát hiện nếu khách mua nhầm linh kiện không khớp với thiết bị chính khách đang sở hữu.
2. **Cảnh báo mua trùng lặp (Duplicate Cart Check):**
   - Nếu khách vô tình chọn trùng sản phẩm trong phiên mua sắm hoặc mua lặp lại sản phẩm có thời hạn sử dụng dài mà chu kỳ tiêu dùng trước đó chưa hết, AI hiển thị cảnh báo nhẹ nhàng để khách xác nhận số lượng mong muốn.
3. **Khuyên giải pháp đủ dùng (Avoid Overspending):**
   - Chủ động tư vấn combo đủ dùng thay vì khuyến khích mua nhiều sản phẩm có công năng chồng chéo, nâng cao mức độ hài lòng và giảm tỷ lệ hoàn trả sau bán.
4. **Gợi ý đạt ngưỡng miễn phí vận chuyển (Freeship Threshold Optimization):**
   - Hệ thống tự động tính khoảng cách chênh lệch giữa tổng giá trị giỏ hàng hiện tại và mốc miễn phí vận chuyển.
   - Gợi ý 1–2 sản phẩm tiêu hao tiện ích (add-on items) có giá trị vừa đủ để đạt mốc freeship, hiển thị minh bạch tổng chi phí trước và sau khi thêm món. Tuyệt đối không tự ý nhét thêm sản phẩm vào giỏ khi chưa có sự đồng ý của khách.

## DOM-FMCG-002: Automated Replenishment & Subscription — Giao định kỳ 定期購

Kịch bản tự động hóa tái đặt hàng cho nhóm hàng tiêu dùng thiết yếu:

1. **Mô hình Giao định kỳ (定期購 / Subscription):**
   - Cho phép khách hàng thiết lập chu kỳ giao hàng tự động 30, 60 hoặc 90 ngày cho các mặt hàng tiêu hao nhanh (nước giặt, bỉm tã, thực phẩm chức năng, mỹ phẩm dưỡng da).
   - Điểm nhận hàng mặc định: Giao đến chuỗi siêu thị tiện lợi 7-Eleven / FamilyMart quen thuộc gần nhà hoặc giao tận cửa.
2. **Cơ chế giá ưu đãi tự động ($P_{floor}$ Discount):**
   - Đơn giao định kỳ tự động áp dụng mức giá sàn $P_{floor}$ rẻ hơn 10–15% so với giá niêm yết bán lẻ đơn chiếc mà không cần khách phải đàm phán hay tìm kiếm voucher từng lần.
3. **Kiểm soát trần chống gom sỉ (Anti-Arbitrage Basket Cap):**
   - Cài đặt trần số lượng tối đa trên mỗi SKU định kỳ (tối đa 2–3 đơn vị/kỳ) và trần giá trị đơn hàng (Basket Cap từ 1.000–2.000 TWD) nhằm ngăn chặn các đại lý hoặc cá nhân đầu cơ gom hàng sỉ giá chiết khấu.
4. **Chăm sóc trước giao hàng:**
   - Hệ thống tự động gửi thông báo xác nhận qua LINE OA / SMS trước ngày xuất kho 3 ngày; khách hàng có quyền tạm hoãn (pause) hoặc điều chỉnh ngày giao chỉ với 1-chạm.

## DOM-FMCG-003: CVS COD Infrastructure — Nhận hàng siêu thị 7-Eleven / FamilyMart

Hạ tầng tiếp nhận và xử lý giao vận đặc thù cho thị trường bán lẻ Đài Loan:

1. **Mô hình nhận hàng thanh toán tại siêu thị (超商取貨付款 - CVS COD):**
   - Hơn 60% giao dịch thương mại điện tử B2C tại Đài Loan sử dụng hình thức nhận hàng và trả tiền mặt tại cửa hàng tiện lợi.
2. **Tích hợp bản đồ E-Map API:**
   - Giao diện chat/web tích hợp trực tiếp API E-Map của ECPay (綠界科技) hoặc NewebPay (藍新金流).
   - Khách hàng bấm nút chọn điểm nhận, bản đồ hiển thị để chọn đúng mã chi nhánh cửa hàng tiện lợi 7-Eleven hoặc FamilyMart gần nhất.
   - **Khung thời gian chọn cửa hàng (Store Selection TTL):** Áp dụng đồng hồ đếm ngược 10 phút để khách hoàn tất chọn cửa hàng và khóa đơn hàng.
3. **Tuân thủ Đạo luật Bảo vệ Dữ liệu Cá nhân (Taiwan PDPA):**
   - Hộp kiểm đồng thuận thu thập số điện thoại di động và họ tên để gửi mã tra cứu vận đơn qua SMS/LINE OA; không tick sẵn.
4. **Cổng thanh toán điện tử bổ trợ:**
   - Trường hợp khách chọn thanh toán online trước: Hệ thống kết nối cổng **LINE Pay**, **JKOPAY (街口支付)** hoặc thẻ tín dụng nội địa.
5. **Chính sách phạt bùng hàng (未取貨 Penalty Policy):**
   - Khách có thời hạn 7 ngày kể từ khi hàng về siêu thị để đến nhận và thanh toán tiền mặt.
   - Nếu khách không nhận hàng dẫn đến bị hoàn trả (未取貨退回), hệ thống Customer 360 tự động:
     * Ghi nhận cờ cảnh báo rủi ro vận chuyển (Delivery Default Flag).
     * Hạ điểm tín nhiệm khách hàng (Trust Score).
     * Khóa quyền sử dụng phương thức thanh toán CVS COD và tước quyền nhận trợ cấp giá ECN-003 trong vòng 90–180 ngày tiếp theo.

## DOM-MOB-001: Government Subsidy Calculator — Bộ tính trợ cấp chính phủ 3 tầng

Kịch bản chuyên biệt cho phân hệ Xe máy điện giá trị cao (High-Ticket EV Scooter):

1. **Cấu trúc trợ cấp xe điện 3 tầng tại Đài Loan:**
   - **Tầng 1 - Trợ cấp Trung ương (Bộ Kinh tế 經濟部):** Trợ cấp mua xe máy điện thông minh (~7.000 TWD).
   - **Tầng 2 - Trợ cấp Môi trường (Cục Môi trường 環保署):** Trợ cấp giảm thiểu phát thải và hỗ trợ thu hồi xe xăng cũ (汰舊換新) (~2.000–4.000 TWD).
   - **Tầng 3 - Trợ cấp Địa phương (Chính quyền Thành phố):** Mức trợ cấp bổ sung dao động từ 3.000–10.000 TWD tùy theo chính sách ngân sách hàng năm của từng thành phố (Đài Bắc, Tân Bắc, Đào Viên, Đài Trung, Cao Hùng...).
2. **Bộ tính toán tự động phía máy chủ:**
   - AI SAL-02 hỏi thông tin hộ khẩu thường trú (戶籍地) và tình trạng xe cũ của khách hàng.
   - Pricing Engine tự động đối chiếu cơ sở dữ liệu chính sách trợ cấp mới nhất của chính quyền địa phương, tính toán tổng mức trợ cấp được khấu trừ (thường từ 10.000–20.000 TWD).
   - Hiển thị bảng chiết tính minh bạch: Giá niêm yết Showroom − Trợ cấp Bộ Kinh tế − Trợ cấp Môi trường − Trợ cấp Thành phố = **Giá lăn bánh thực tế (實際到手價)**.

## DOM-MOB-002: Battery Swap & Charging Network Map — Bản đồ trạm đổi pin trong 1km

Giải tỏa triệt để nỗi lo cạn pin (Range Anxiety) cho người mua xe máy điện:

1. **Tích hợp API mạng lưới trạm đổi pin:**
   - Kết nối trực tiếp hệ thống dữ liệu vị trí trạm đổi pin của **GoStation (Gogoro Network)** và **Kymco Ionex**.
2. **Định vị trạm đổi pin trong bán kính 1km:**
   - Khi khách cung cấp khu vực sinh sống hoặc nơi làm việc, AI kích hoạt widget bản đồ tương tác hiển thị toàn bộ các trạm đổi pin trong bán kính 1km.
   - Cung cấp dữ liệu trực quan: Khoảng cách chính xác, thời gian di chuyển bằng xe máy (thường dưới 3 phút) và trạng thái pin sẵn sàng đổi theo thời gian thực.
3. **Bằng chứng thuyết phục mua sắm:**
   - Sử dụng mật độ phủ sóng trạm đổi pin dày đặc làm bằng chứng kỹ thuật cốt lõi giúp khách hàng an tâm chuyển đổi từ xe xăng sang xe điện.

## DOM-MOB-003: O2O Showroom Test-Drive & Deposit — Đặt lịch lái thử Showroom kèm cọc giữ chỗ

Phễu chuyển đổi Trực tuyến sang Thực tế (Online-to-Offline) cho sản phẩm giá trị cao:

1. **Định hướng phễu O2O:**
   - Với sản phẩm xe máy điện có giá trị hàng chục nghìn TWD, AI không cố gắng chốt đơn thanh toán toàn bộ trực tuyến.
   - Mục tiêu chuyển đổi chính là **Đặt lịch lái thử tại Showroom (預約門市試乘)** để nhân viên tư vấn trực tiếp và trải nghiệm xe thực tế.
2. **Đặt cọc giữ chỗ minh bạch (Refundable Deposit):**
   - AI hướng dẫn khách chọn khung giờ lái thử tại showroom gần nhất và tiến hành đặt cọc giữ chỗ từ 1.000–2.000 TWD qua thẻ tín dụng hoặc LINE Pay.
   - Cam kết hoàn cọc 100%: Tiền cọc được hoàn trả vô điều kiện nếu khách hủy lịch trước 24 giờ hoặc không mua sau khi lái thử; nếu khách đồng ý mua, tiền cọc được trừ trực tiếp vào giá trị đơn hàng.
3. **Quy trình bàn giao đại lý và hoàn tất thủ tục:**
   - Toàn bộ hồ sơ gồm nhu cầu, hộ khẩu, loại xe quan tâm, lịch hẹn và mã cọc được chuyển giao đồng bộ sang CRM đại lý.
   - Nhân viên showroom đón tiếp khách, hướng dẫn lái thử, hỗ trợ làm hồ sơ xin trợ cấp chính phủ DOM-MOB-001 và đồng hành cùng khách làm thủ tục đăng kiểm, bấm biển số tại Trạm Đăng kiểm địa phương (監理所).
