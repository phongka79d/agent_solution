# Dữ liệu khách hàng, bằng chứng và kho kiến thức

[Mục lục](../README.md) · [Kiến trúc](architecture.md) · [API](api-and-integrations.md)

Trạng thái: thiết kế đề xuất. Chỉ lưu dữ liệu cần thiết được cấp quyền; không yêu cầu doanh nghiệp chuyển toàn bộ cơ sở dữ liệu sang AgentOS.

<a id=section-11></a>

## 1. Customer360 — Hồ sơ khách hàng hợp nhất

Customer360 đóng vai trò là lớp tổng hợp thông tin khách hàng đa kênh phục vụ chuỗi điều phối Revenue Orchestrator, không thay thế hệ thống giao dịch gốc (ERP/POS/CRM).

- **FR-C360-001 - Hồ sơ khách hàng thống nhất - MUST**: Chứa tối thiểu thông tin định danh, lịch sử mua hàng, sản phẩm đã mua, hành vi Web/App, tương tác Marketing, nhật ký hội thoại, ticket CSKH, phản hồi, giỏ hàng, ưu đãi/voucher, tần suất/giá trị mua (RFM), trạng thái đồng ý (consent) và vòng đời khách hàng.
- **FR-C360-002 - Timeline thống nhất - MUST**: Chuỗi sự kiện truy vết thời gian thực: View → Search → Click → Chat → Add to cart → Purchase → Delivery → Support → Review → Repurchase.

### Nguồn nào giữ giá trị chính thức (System of Record)?

| Nguồn | Giá trị chính thức |
|---|---|
| Ứng dụng/CRM doanh nghiệp | Tài khoản, khách, yêu cầu, cơ hội và chủ sở hữu theo ánh xạ |
| Danh mục/kho/hệ thống bán hàng (ERP/POS) | Sản phẩm, SKU, giá niêm yết, tồn kho, đơn hàng và hóa đơn |
| Ngân hàng / Cổng thanh toán (ECPay, Stripe...) | Giao dịch, số tiền và trạng thái thanh toán được đối soát |
| Đơn vị vận chuyển / Hệ thống giao hàng | Trạng thái giao hàng, mã bưu vận, người nhận |
| Nguồn đối tác / Kênh tiếp thị | Mã nguồn giới thiệu, sự kiện click, chi phí chiến dịch |
| AgentOS Data Layer | Liên kết danh tính, hội thoại, quy trình, thẻ bằng chứng, suy luận AI |

Phải có bảng sở hữu từng trường trước kết nối. Tuyệt đối không tự ghi đè nguồn gốc bằng tóm tắt AI. Dữ liệu lưu đệm cần mã nguồn, phiên bản/thời điểm và hạn dùng; giá, tồn kho, quyền và trạng thái quan trọng được kiểm tra lại trước hành động.

<a id=evidence-separation></a>

## 2. Phân định bằng chứng (FR-C360-003 - Evidence Separation)

Hệ thống bắt buộc phải phân định rạch ròi 5 khái niệm dữ liệu trong Customer 360 để bảo đảm tính toàn vẹn và tránh ảo giác:

- **FACT**: Dữ liệu sự thật đã được xác minh từ System of Record (đơn hàng đã thanh toán, giá niêm yết ERP, tồn kho kho hàng, biên lai bưu cục).
- **SIGNAL**: Dấu hiệu hành vi khách quan sát được qua kênh số (xem sản phẩm 3 lần, thêm vào giỏ hàng, thời lượng phiên 10 phút, click link khuyến mãi).
- **HYPOTHESIS**: Giả thuyết do AI suy luận dựa trên mô hình (khách hàng có nguy cơ churn 70%, sở thích thời trang công sở, độ nhạy cảm giá cao).
- **DECISION**: Quyết định nghiệp vụ đã được Orchestrator hoặc Policy Engine xác lập (kích hoạt kịch bản giỏ hàng bỏ quên, chuyển ticket sang CSKH).
- **ACTION**: Hành động cụ thể dự kiến hoặc đã thực thi ra kênh ngoài (gửi tin nhắn Zalo, tạo mã giảm giá 5%, tạo draft order).

**Quy tắc bất biến: Giả thuyết AI (HYPOTHESIS) tuyệt đối không được ghi ngược thành Sự thật khách hàng (FACT).**

## 3. Phân tầng 5 cấp bộ nhớ AI (AI Memory Hierarchy)

Hệ thống phân định nghiêm ngặt 5 tầng bộ nhớ để đảm bảo an toàn dữ liệu và tối ưu chi phí vận hành:

1. **Working Memory (Bộ nhớ tác vụ)**: Ngữ cảnh hội thoại và dữ liệu tạm của tác vụ hiện tại (session context). Lưu trong RAM/Redis, bị giải phóng hoặc đóng băng ngay sau khi kết thúc vòng xử lý.
2. **Customer Context (Ngữ cảnh khách hàng)**: Dữ liệu hồ sơ Customer 360 được phép nạp theo quyền hạn và phạm vi consent của khách hàng.
3. **Organizational Knowledge (Tri thức tổ chức)**: Toàn bộ tài liệu, chính sách, playbook, quy chế kinh doanh của doanh nghiệp lưu tại Second Brain; được kiểm duyệt trước khi lập chỉ mục RAG.
4. **Agent Operational Memory (Bộ nhớ vận hành Agent)**: Trạng thái workflow bền vững của Agent (tiến trình đang chờ `task_id`, `run_id`, biến bước, lịch hẹn gọi lại, số lần retry).
5. **Learning Memory (Bộ nhớ học tập & cải tiến)**: Dữ liệu đánh giá hiệu quả của các hành động trước (outcome, doanh thu đóng góp, phản hồi chấm điểm từ SCR-005, tỷ lệ chuyển đổi) phục vụ tinh chỉnh prompt và trọng số mô hình.

**Nguyên tắc: Không cho phép AI tự ý ghi toàn bộ nội dung hội thoại thành tri thức lâu dài mà không qua bộ lọc làm sạch và người duyệt.**

## 4. Kho kiến thức doanh nghiệp (Second Brain Knowledge Base)

AI Agent không được hoạt động dựa trên tri thức nội tại thiếu kiểm chứng của LLM mà phải truy xuất từ Knowledge Base phân cấp chuẩn:

```text
/company
  company.md              # Giới thiệu doanh nghiệp, tầm nhìn, mô hình hoạt động
  positioning.md          # Định vị thương hiệu, phân khúc thị trường
/customer
  customer.md             # Chân dung khách hàng mục tiêu, ICP
  segmentation.md         # Quy tắc phân khúc cohort, tiêu chí phân loại
/product
  products.md             # Danh mục sản phẩm, tính năng, thông số kỹ thuật
  pricing.md              # Bảng giá chính thức, cơ cấu chi phí
  promotion-policy.md     # Chính sách khuyến mãi, điều kiện áp dụng
/brand
  voice.md                # Tone of voice, phong cách ngôn ngữ theo từng kênh
  terminology.md          # Thuật ngữ chuẩn hóa, từ ngữ khuyến khích sử dụng
  prohibited-claims.md    # Danh mục từ cấm, cam kết vượt thẩm quyền bị cấm
/marketing
  playbook.md             # Kịch bản chiến dịch, hướng dẫn tiếp thị
  content-guidelines.md   # Tiêu chuẩn nội dung social, video, email
  campaign-rules.md       # Giới hạn ngân sách, quy định phân bổ kênh
/sales
  sales-playbook.md       # Quy trình bán hàng chuẩn, kịch bản chốt đơn
  qualification.md        # Bộ câu hỏi sàng lọc lead, tiêu chí BANT
  objection-handling.md   # Kịch bản xử lý từ chối và phản bác giá
/customer-care
  faq.md                  # Bộ câu hỏi - trả lời thường gặp đã được phê duyệt
  support-policy.md       # Chính sách bảo hành, đổi trả, giao nhận hàng
  escalation.md           # Ma trận phân cấp xử lý sự cố, tiêu chí chuyển người
/policy
  authority.md            # Quy chế phân quyền Agent, hạn mức tự chủ
  approval.md             # Ma trận phê duyệt cho các hành động rủi ro cao
```

Mỗi tài liệu bắt buộc có thông tin chủ sở hữu (owner), phiên bản (`source_version`), trạng thái phê duyệt, ngày hiệu lực và hạn dùng. AI chỉ được sử dụng tài liệu ở trạng thái đã duyệt (`approved`).

Thẻ bằng chứng (Evidence Card) dùng chung gồm: phát biểu/đề xuất, loại sự kiện hay suy luận, nguồn và vị trí, phiên bản/ngày tra, điều kiện áp dụng, giới hạn và người duyệt nếu cần.

## 5. Đồng ý liên hệ, Taiwan PDPA và Phân tách dữ liệu đa doanh nghiệp

### Đồng ý liên hệ theo mục đích (Purpose Limitation)

| Tình huống | Quy tắc thiết kế |
|---|---|
| Khách hỏi thông tin công khai | Trả lời thông tin công khai mà không ép đăng ký tiếp thị |
| Khách đặt giao hàng | Thu thập thông tin giao nhận tối thiểu; không tự động bật quảng cáo |
| Khách đăng ký nhận ưu đãi | Lưu kênh, mục đích, cách xác nhận, thời gian và phiên bản nội dung |
| Khách rút đồng ý | Ngừng ngay lịch gửi tương ứng, ghi lý do và sự kiện rút lại (BR-004) |
| Chuyển mô-đun hoặc đối tác | Không mở rộng mục đích/đối tượng nhận dữ liệu ngoài phạm vi đã duyệt |

### Phân tách dữ liệu đa doanh nghiệp (Multi-Tenant Data Isolation - NFR-006)

Hệ thống bảo đảm cô lập dữ liệu tuyệt đối giữa các tenant:
1. **Phân tách lưu trữ**: Mỗi tenant sở hữu schema cơ sở dữ liệu riêng biệt hoặc được gắn nhãn `tenant_id` bắt buộc tại mọi tầng truy vấn, không bao giờ thực thi truy vấn thiếu điều kiện `tenant_id`.
2. **Cô lập Vector Embedding**: Không gian embedding của các tenant được lưu trữ trong các namespace hoặc index hoàn toàn độc lập; RAG không thể tìm kiếm chéo tri thức giữa các doanh nghiệp.
3. **Cô lập bộ nhớ đệm và tiến trình**: Cache Redis và hàng đợi tác vụ được đánh tiền tố theo tenant; không chia sẻ ngữ cảnh bộ nhớ runtime giữa các khách hàng khác nhau.

### Tuân thủ pháp lý Đài Loan & Quốc tế

- **Đài Loan (Taiwan PDPA)**: Triển khai cụm máy chủ và cơ sở dữ liệu tại GCP Changhua hoặc AWS Region Taipei; tuân thủ đầy đủ quy định về lưu trữ dữ liệu cá nhân tại chỗ, quyền xóa dữ liệu và quyền xuất dữ liệu của chủ thể.
- **Quốc tế**: Hỗ trợ phân vùng dữ liệu theo khu vực tuân thủ GDPR (Châu Âu), CCPA/CPRA (Hoa Kỳ) và luật dữ liệu sở tại.

## 6. Danh mục sản phẩm, dữ liệu giá và kiểm soát giá sàn

Dùng API danh mục hiện có hoặc bản nhập được kiểm soát. Không tạo hệ thống sản phẩm thứ hai nếu không cần.

| Nhóm | Trường cần thiết |
|---|---|
| Nhận diện | Mã hàng, biến thể, phiên bản, tên, nhóm và đơn vị bán |
| Phù hợp | Nhu cầu đáp ứng, giới hạn, tương thích, điều kiện dùng |
| Điều khoản | Tiền tệ, giá niêm yết, cách tính thuế/phí, đơn vị thời gian nếu thuê bao |
| Khả dụng | Tồn kho/khả năng cung cấp thời gian thực, vùng phục vụ, thời điểm cập nhật |
| Bằng chứng | Nguồn thông số, mô tả đã duyệt, điều kiện đo |
| Khuyến mãi | Chương trình, điều kiện, thời hạn, cách cộng dồn |
| Kinh tế nội bộ | Giá vốn/chi phí/giới hạn giá sàn ($P_{floor}$), chỉ cho bộ tính giá và vai trò được phép |

Thiếu giá hoặc điều kiện quan trọng thì không phát hành báo giá tự động (BR-001, BR-002, BR-003). Lưu phiên bản/ảnh chụp điều khoản với đề xuất; kiểm tra lại trước tạo đơn. Công thức giá sàn ở [đo lường](../delivery/analytics.md#unit-economics), quyền thực thi ở [Bán hàng](../modules/sales.md).

## 7. Vòng đời dữ liệu và kiểm thử nghiệm thu

1. **Kiểm duyệt tri thức**: Tài liệu mới chưa duyệt tuyệt đối không được dùng để trả lời khách hàng.
2. **Loại bỏ nguồn lỗi thời**: Nguồn hết hạn, thu hồi quyền hoặc bị gỡ bỏ phải bị loại lập tức khỏi chỉ mục truy xuất RAG và bộ nhớ đệm liên quan.
3. **Quyền chủ thể dữ liệu**: Yêu cầu xuất/xóa dữ liệu phải bao phủ bản lưu Customer 360, tệp, chỉ mục vector và bản sao lưu theo chính sách được duyệt.
4. **Không đào tạo chéo**: Không dùng dữ liệu giữa doanh nghiệp để huấn luyện mô hình hoặc chia sẻ cho bên thứ ba khi chưa có thỏa thuận pháp lý.
5. **Kiểm thử nghiệm thu**:
   - Chứng minh không xảy ra tình trạng rò rỉ dữ liệu chéo tenant (NFR-006).
   - Chứng minh giả thuyết AI không bị lưu đè thành Customer Fact (FR-C360-003).
   - Chứng minh hệ thống ngừng hoàn toàn việc gửi thông điệp sau khi khách hàng rút đồng ý (BR-004, TC-E2E-007).
