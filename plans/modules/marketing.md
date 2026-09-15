# Mô-đun Tiếp thị — Từ nghiên cứu nhu cầu đến khách phù hợp

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P0 nghiên cứu có người làm; P1 chỉ lưu nguồn/yêu cầu qua lõi, **chưa bật mô-đun Tiếp thị tự động**. P2/P3 mở các năng lực dưới đây theo [lộ trình](../delivery/mvp-and-roadmap.md).

<a id=section-6></a>

# PHẦN 1: KHUNG GẦM KỸ THUẬT CHUẨN SRS (CORE MARKETING ENGINE)

## 1. Mục tiêu và ranh giới

Tìm đúng vấn đề, đúng nhóm khách, đúng thời điểm và kênh phân phối; tạo nhu cầu được kiểm chứng, không chỉ tạo nhiều biểu mẫu hay lượt bấm (khớp mục tiêu **OBJ-001** trong SRS).

Tiếp thị bắt đầu trước quảng cáo, nhưng việc phát hiện một tín hiệu **không tạo quyền truy cập danh sách cá nhân hoặc quyền gửi tin** (tuân thủ **BR-004**). Quảng cáo, ngân sách và xuất bản bắt buộc phải do người có thẩm quyền phê duyệt (**AUTH-4**). Nền tảng quảng cáo sở hữu khâu phân phối/đấu giá; AgentOS không thay thế khâu đó.

## 2. Hệ thống 6 Agent Tiếp thị chuẩn theo SRS (MKT-01 đến MKT-06)

Mô-đun Tiếp thị vận hành với cấu trúc 6 Agent chuyên trách theo chuẩn SRS, phối hợp chặt chẽ qua Orchestrator:

| Mã Agent | Tên Agent | Nhiệm vụ cốt lõi | Quyền hạn (Authority) | Đầu vào chính | Đầu ra chuẩn |
|---|---|---|---|---|---|
| **MKT-01** | Marketing Strategist | Phân tích mục tiêu kinh doanh, lập kế hoạch tiếp thị, xác định chiến dịch, đối tượng, kênh, KPI và đề xuất ưu tiên | AUTH-1 (Recommend) | Mục tiêu doanh thu, ngân sách trần, dữ liệu thị trường | Kế hoạch chiến dịch, phân bổ kênh, KPI dự kiến |
| **MKT-02** | Audience Intelligence Agent | Phân tích cohort/segment từ dữ liệu hành vi, giao dịch; nhận diện nhóm khách mới, khách quay lại, high-value, dormant, churn-risk, product affinity | AUTH-1 (Recommend) | Dữ liệu sự kiện Web/App, lịch sử mua hàng ERP, trạng thái consent | Danh sách phân khúc hợp lệ, đặc tính nhóm, điều kiện lọc |
| **MKT-03** | Content Agent | Sáng tạo nội dung đa kênh: social post, video script (TikTok/Reels), mẫu quảng cáo, email, landing page, tin nhắn Zalo/LINE | AUTH-2 (Draft) | Bản tóm tắt chiến dịch (Brief), hướng dẫn thương hiệu, USP sản phẩm | Bản thảo nội dung đa biến thể, tiêu đề, lời kêu gọi hành động (CTA) |
| **MKT-04** | Brand Guardian | Kiểm soát tone of voice, thuật ngữ, thông tin thương hiệu, tính chuẩn xác của tuyên bố (claim), giá niêm yết, ưu đãi và nội dung bị cấm | AUTH-1 (Review/Verify) | Bản thảo nội dung từ MKT-03, chính sách thương hiệu, danh mục giá ERP | Báo cáo thẩm định (Pass/Flag/Reject), lý do và đề xuất sửa |
| **MKT-05** | Campaign Agent | Điều phối và vận hành vòng đời chiến dịch tiếp thị xuyên suốt từ khởi tạo đến thực thi và tối ưu | AUTH-3 (trong hạn mức) / AUTH-4 (ngân sách/xuất bản) | Kế hoạch từ MKT-01, nội dung đã duyệt, phân khúc từ MKT-02 | Lịch phát hành, trạng thái thực thi chiến dịch |
| **MKT-06** | Marketing Analyst | Theo dõi đo lường impressions, reach, click, lead, conversion, CAC, ROAS, doanh thu thực tế và phân bổ đóng góp (attribution) | AUTH-0 (Observe) / AUTH-1 (Recommend) | Nhật ký sự kiện, chi phí quảng cáo, đơn hàng ERP đối soát | Báo cáo hiệu quả chiến dịch, phân tích ROAS/CAC, đề xuất tối ưu |

### 2.1. Quy trình điều phối Chiến dịch chuẩn (Campaign Lifecycle Workflow)

MKT-05 điều phối quy trình chiến dịch 8 bước khép kín theo yêu cầu bắt buộc của SRS:

```text
[Brief] (MKT-01 / Human)
   │
   ▼
[Audience] (MKT-02: Phân tích cohort & kiểm tra Consent)
   │
   ▼
[Content] (MKT-03: Soạn thảo đa biến thể A/B testing)
   │
   ▼
[Review] (MKT-04 Brand Guardian: Soát Tone of Voice, Claims, Giá, Prohibited Content)
   │
   ▼
[Approval] (Human Manager / AUTH-4: Phê duyệt ngân sách & nội dung)
   │
   ▼
[Publish] (Connector Dispatcher: Đẩy nội dung lên kênh chỉ định)
   │
   ▼
[Monitor] (MKT-06: Giám sát tín hiệu, click, tương tác thời gian thực)
   │
   ▼
[Optimize] (MKT-01 & MKT-05: Điều chỉnh ngân sách, phân bổ kênh hoặc dừng phép thử)
```

### 2.2. Kiểm soát thương hiệu và phòng ngừa vi phạm (Brand Guardian Guardrails)

MKT-04 (Brand Guardian) hoạt động như một chốt chặn độc lập (Gatekeeper) trước khi bất kỳ nội dung nào được chuyển lên cấp phê duyệt:
- **Tone of Voice & Terminology:** Kiểm tra tính nhất quán với sổ tay thương hiệu (`/brand/voice.md`, `/brand/terminology.md`).
- **Claim Verification:** Đối chiếu mọi tuyên bố công dụng sản phẩm với dữ liệu kỹ thuật đã duyệt (`/brand/prohibited-claims.md`); nghiêm cấm thổi phồng hoặc cam kết vượt quá kiểm định.
- **Price & Promotion Validation:** Mọi mức giá hoặc ưu đãi nhắc đến trong nội dung phải khớp 100% với bảng giá ERP và chính sách giá hiện hành; tuyệt đối không tự tạo mức giảm giá ngoài danh mục.
- **Prohibited Content:** Tự động gắn cờ và chặn các nội dung kích động nỗi sợ hãi, phân biệt đối xử, hoặc vi phạm thuần phong mỹ tục.

### 2.3. Hệ thống Kỹ năng Tiếp thị (Marketing Skill System)

Theo Mục 11 của SRS, các Agent Tiếp thị gọi các Skill chuyên trách thông qua Orchestrator với hợp đồng kiểm soát nghiêm ngặt:

| Mã Skill (Skill ID) | Mục đích (Purpose) | Agent được phép dùng | Quyền hạn yêu cầu | Tool / Connector | Quy tắc kiểm tra (Validation) & Audit |
|---|---|---|---|---|---|
| `analyze-market-signal` | Phân tích tín hiệu nhu cầu, xu hướng tìm kiếm và cơ hội thị trường | MKT-01 | AUTH-1 (Recommend) | Market Research DB / Event Ingestion | Lọc tín hiệu hợp lệ; không suy đoán số liệu chưa kiểm chứng |
| `segment-audience` | Phân tích cohort/segment dựa trên hành vi và giao dịch hợp lệ | MKT-02 | AUTH-1 (Recommend) | Customer 360 Ingestion Layer | Loại trừ khách hàng chưa có consent hoặc đã rút consent (BR-004) |
| `check-consent` | Xác minh trạng thái đồng ý nhận tiếp thị theo từng kênh cụ thể | MKT-02, MKT-05 | AUTH-0 (Observe) | Consent Store (API-002) | Kiểm tra bắt buộc trước mọi chiến dịch; fail closed nếu thiếu consent |
| `generate-content` | Sáng tạo bản thảo nội dung quảng cáo, bài viết, email theo brief | MKT-03 | AUTH-2 (Draft) | LLM Generator / Brand Template | Bắt buộc đối chiếu sổ tay thương hiệu; gắn thẻ bản nháp (Draft) |
| `audit-brand-compliance` | Thẩm định tone of voice, tuyên bố tính năng, giá và từ cấm | MKT-04 | AUTH-1 (Review/Verify) | Brand Knowledge Base (/brand) | Đối chiếu 100% với bảng giá ERP và danh mục tuyên bố cấm |
| `dispatch-campaign` | Phát hành nội dung chiến dịch ra các kênh quảng cáo/mạng xã hội | MKT-05 | AUTH-4 (Approval Required) | Communication Gateway (API-003) | Bắt buộc có bản ghi phê duyệt tại SCR-003; gắn mã `effect_key` |
| `evaluate-attribution` | Đo lường hiệu quả chiến dịch, tính CAC, ROAS và quy thuộc doanh thu | MKT-06 | AUTH-0 (Observe) | Analytics Engine / ERP Reconciliation | Đối soát đơn hàng thực tế qua ERP; không suy đoán doanh thu ảo |

## 3. Tiếp nhận, phân loại và chuyển giao bán hàng

Đầu vào: yêu cầu hoặc sự kiện từ nguồn đã xác thực; mã sự kiện; thời điểm; sản phẩm quan tâm; nguồn chiến dịch/đối tác; trạng thái đồng ý liên hệ (Consent); khách/phiên đã được liên kết đúng quyền.

1. **Xác thực nguồn sự kiện:** Kiểm tra tính hợp lệ của webhook và loại sự kiện trước khi tiếp nhận; từ chối và ghi nhật ký nguồn không hợp lệ.
2. **Chống trùng lặp (Deduplication):** Lưu trữ yêu cầu duy nhất bằng idempotency key; đánh dấu rõ ràng các sự kiện chưa xác định nguồn.
3. **Cô lập phiên ẩn danh:** Giữ khách hàng ở mức phiên (session) khi chưa xác minh danh tính; tuyệt đối không tự ý hợp nhất dữ liệu dựa trên email hoặc số điện thoại tự khai khi chưa qua OTP/xác thực.
4. **Thu thập thông tin tối thiểu:** Hỏi thông tin cần thiết theo từng bước, ghi nhận các trường chưa rõ là chưa biết, không suy đoán.
5. **Chấm điểm tiềm năng (Scoring):** MKT-02 chấm mức độ phù hợp và quan tâm theo bộ quy tắc có phiên bản rõ ràng, giới hạn điểm hành vi và loại bỏ các lượt tương tác trùng lặp.
6. **Chuyển giao bán hàng (Handoff to SAL-01):** Khách hàng có điểm sẵn sàng mua cao được bàn giao sang Bán hàng (SAL-01) kèm đầy đủ Lý do (Reason) và Bằng chứng (Evidence). Bán hàng thẩm định lại điều kiện, không mặc định coi điểm cao là đủ chuẩn mua hàng.
7. **Chăm sóc nuôi dưỡng:** Khách hàng chưa sẵn sàng mua chỉ được đưa vào danh sách nuôi dưỡng nếu có đủ sự đồng thuận (Consent) theo đúng kênh và mục đích; luôn duy trì khả năng giải đáp câu hỏi chủ động của khách.

Lượt xem trang, thêm vào yêu thích hoặc thời gian dừng trên trang lớn hơn 8 giây chỉ là tín hiệu tương tác sơ bộ, không cấu thành bằng chứng ý định mua. Không áp dụng công thức chấm điểm tùy tiện cho mọi ngành hàng.

## 4. Tương tác website và Kiểm soát ngân sách an toàn

Tính năng sau P1 có thể gồm lưu sản phẩm chưa đăng nhập, hướng dẫn tại chỗ và đăng ký nhận ưu đãi. Nội dung quảng cáo, trang đích (landing page), thông điệp tiếp thị và đề xuất phân bổ ngân sách luôn ở trạng thái bản thảo (Draft) cho đến khi được người có thẩm quyền phê duyệt chính thức.

Giới hạn hiển thị gợi ý tự động là tối đa 1 lần/24 giờ/thiết bị khi kích hoạt tính năng; tham số 8 giây là giá trị thử nghiệm. Không tự bật gợi ý khi cửa sổ chat hoặc giỏ hàng đang mở, không cản trở hành vi mua sắm và không ép buộc cung cấp số điện thoại. Hành động khách hàng chủ động nhấn nút trợ giúp không tính là gợi ý tự bật.

Các kênh phân phối Zalo, LINE, Facebook, Email chỉ kích hoạt khi bộ kết nối và điều kiện đồng thuận hiện hành đã được xác nhận. Hộp kiểm nhận thông tin tiếp thị phải tách biệt với số điện thoại giao hàng, không được chọn sẵn.

### Kiểm soát ngân sách và chốt chặn an toàn (Budget & Safety Controls)
- **AUTH-4 Bắt buộc cho Ngân sách:** AI Tiếp thị (MKT-01, MKT-05) chỉ có quyền lập đề xuất kế hoạch ngân sách (Draft/Recommend), tuyệt đối không có quyền tự cấp phát hay tự động giải ngân chi phí quảng cáo.
- **Trần ngân sách kép (Dual-Cap):** Mọi chiến dịch bắt buộc phải cấu hình trần ngân sách ngày (Daily Budget Cap) và trần tổng ngân sách chiến dịch (Total Campaign Cap). Khi chi phí chạm 95% hạn mức, hệ thống phát cảnh báo; khi chạm 100%, hệ thống tự động tạm dừng chiến dịch (Fail Closed).
- **Phân định rõ ràng dòng chi phí:** Tách bạch chi phí truyền thông trực tiếp (Ad Spend), chi phí chi trả đối tác B2B2C và chi phí trợ cấp giá/ưu đãi khách hàng để tránh tính trùng hai lần vào biên đóng góp (Contribution Margin).

## 5. Tiêu chí nghiệm thu kỹ thuật & Hệ chỉ số KPI chuẩn SRS

### 5.1. Bảng kiểm tra nghiệm thu Tiếp thị (Acceptance Criteria)

| Tình huống | Kết quả bắt buộc | Mã kiểm thử SRS |
|---|---|---|
| Tìm được đối tác/tín hiệu | Có nguồn, ngày, giả thuyết và người duyệt; chưa tạo quyền liên hệ | TC-E2E-001 |
| Nguồn sự kiện không hợp lệ | Không tạo khách quan tâm được chấp nhận | TC-E2E-008 |
| Yêu cầu gửi trùng | Một bản ghi, một kết quả bàn giao | TC-E2E-005 |
| Thiếu phép tiếp thị (Consent) | Trả lời chủ động hợp lệ được; không lên lịch chăm sóc | TC-E2E-007 |
| Đề xuất xuất bản chiến dịch | MKT-05 không thể publish nếu thiếu Brand Guardian review và phê duyệt người | TC-E2E-002 |
| Điểm cao nhưng thiếu điều kiện | Không tự tạo khách đủ chuẩn/cơ hội bán hàng | FR-SAL-001 |
| Luồng phối hợp Tiếp thị → Bán hàng | Tín hiệu → Segment → Campaign → Content → Approval → Publish → Phản hồi → Handoff | PILOT-01 |
| Bán hàng chưa bật | Hàng đợi nhân viên, không gọi hành động Bán hàng | Quy trình bàn giao |
| Tiếp thị chưa bật ở P1 | Chỉ lõi lưu nguồn/yêu cầu; không nghiên cứu tự động, chấm điểm, xuất bản hay gửi chiến dịch | Lộ trình P1 |
| Nhân viên nhận hoặc khách yêu cầu dừng | Dừng lịch liên hệ liên quan, giữ bằng chứng và trạng thái | TC-E2E-006 |

### 5.2. Hệ chỉ số KPI Tiếp thị theo SRS

Hiệu quả hoạt động của hệ thống Agent Tiếp thị (MKT-01 đến MKT-06) được đo lường qua các chỉ số cốt lõi:
- **Campaign Revenue:** Doanh thu gán cho chiến dịch có đối soát đơn hàng thực tế qua ERP.
- **Lead Conversion & Qualified Lead Rate:** Tỷ lệ chuyển đổi đầu mối và tỷ lệ khách đủ chuẩn bàn giao sang Bán hàng kèm reason + evidence.
- **CAC (Customer Acquisition Cost):** Chi phí thu hút một khách hàng mới, tính đủ media spend, đối tác và ưu đãi.
- **ROAS (Return on Ad Spend):** Doanh thu thu về trên mỗi đồng ngân sách quảng cáo được duyệt.
- **Cost per Lead:** Chi phí trung bình trên mỗi đầu mối tiếp thị hợp lệ.
- **Engagement & Brand Safety Rate:** Tỷ lệ tương tác thực và tỷ lệ vi phạm chính sách thương hiệu (phải duy trì bằng 0 nhờ MKT-04).

---

# PHẦN 2: KỊCH BẢN NGHIÊN CỨU THỊ TRƯỜNG & ĐỐI TÁC B2B2C (DOMAIN PLAYBOOKS)

## MKT-RS-001: Market Opportunity Canvas — Phiếu cơ hội nghiên cứu tín hiệu trước nhu cầu

Quy trình nghiên cứu nhu cầu khách hàng bài bản, tập trung tìm đúng vấn đề gốc trước khi triển khai các biện pháp tiếp thị:

1. **Nguyên tắc vận hành cốt lõi:**
   - Đi ngược hành trình khách hàng để tìm kiếm hành động phát sinh trước khi nhu cầu mua sắm hình thành; kiểm chứng thứ tự thực tế thay vì suy đoán cảm tính.
   - Xác định nơi khách hàng tập trung và các tổ chức/đối tác có khả năng giới thiệu giải pháp tự nhiên.
   - Đánh giá sản phẩm của doanh nghiệp dựa trên: lợi ích thực tế, giới hạn kỹ thuật, sự khác biệt, điều kiện vận hành và bằng chứng kiểm định.
   - Phân biệt rạch ròi ba cấp độ thông tin: **Sự kiện có nguồn (Fact)**, **Suy luận logic (Inference)** và **Giả thuyết chưa kiểm chứng (Hypothesis)**. Không tự tạo quy mô thị trường khi chưa có số liệu đo lường.
2. **Cấu trúc Phiếu cơ hội thị trường chuẩn (Market Opportunity Canvas - 9 trường bắt buộc):**

| Trường dữ liệu | Nội dung bắt buộc ghi nhận |
|---|---|
| **Vấn đề và phân khúc** | Nhóm đối tượng gặp khó khăn, hoàn cảnh thực tế phát sinh; các yếu tố chưa xác định rõ |
| **Nhu cầu cuối** | Kết quả mong muốn cốt lõi của khách hàng và phương thức họ đang giải quyết tạm thời |
| **Tín hiệu sớm** | Hành vi nhận biết, nguồn quan sát, ngày phát hiện, khoảng thời gian hữu dụng và thời điểm hết hạn |
| **Điểm tập trung / Đối tác** | Tổ chức, cộng đồng hoặc kênh đối tác liên quan; lý do phù hợp từ nguồn hợp lệ |
| **Giải pháp và bằng chứng** | Sản phẩm đề xuất, giới hạn công năng và tài liệu kiểm định chứng minh công dụng |
| **Kinh tế sơ bộ** | Dự toán doanh thu, chi phí sản phẩm, hoa hồng đối tác, lãi đóng góp ước tính và các số liệu thiếu |
| **Rào cản** | Điều kiện pháp lý, quy định quyền riêng tư dữ liệu, năng lực vận hành cần chuyên gia đánh giá |
| **Thiết kế phép thử** | Quy mô đối tượng, kênh truyền thông, thông điệp, người duyệt, hạn mức chi phí và điều kiện dừng |
| **Kết quả & Quyết định** | Phản hồi thực tế, số lượng đơn hợp lệ, chi phí phát sinh và kết luận (duy trì / điều chỉnh / dừng) |

3. **Vận dụng nghiên cứu điển hình (Case Study: SIM viễn thông du lịch):**
   - Nhu cầu cuối của khách là kết nối Internet ổn định và liên lạc thuận tiện ngay khi đặt chân tới nước sở tại.
   - Các hành vi như đăng ký học ngoại ngữ, nộp hồ sơ xin visa hoặc đặt vé máy bay chỉ là tín hiệu để nhận diện nhóm nhu cầu, không phải bằng chứng khẳng định 100% cá nhân đó sẽ mua SIM.
   - Hợp tác với các trung tâm ngoại ngữ hoặc đơn vị tư vấn để cung cấp liên kết thông tin cho học viên tự nguyện tìm hiểu; không tự ý lấy danh bạ học viên để gửi tin quảng bá khi chưa có sự đồng thuận.

## MKT-PT-001: B2B2C Referral Partner Program — Hợp tác đối tác giới thiệu, đối soát hoa hồng minh bạch

Kịch bản thiết lập và vận hành mạng lưới đối tác giới thiệu khách hàng theo mô hình B2B2C có đối soát minh bạch:

1. **Quy trình hợp tác 6 bước chuẩn:**
   - **Bước 1 - Kiểm chứng độc lập:** Kiểm chứng giải pháp tiếp thị trực tiếp trên nhóm khách hàng nội bộ quy mô nhỏ trước khi mở rộng mạng lưới đối tác.
   - **Bước 2 - Tuyển chọn đối tác:** Lựa chọn đối tác có tệp khách hàng tiềm năng tương đồng, không cạnh tranh trực tiếp và có cơ chế lợi ích bổ trợ rõ ràng.
   - **Bước 3 - Thiết lập cam kết:** Phê duyệt mẫu thông điệp giới thiệu, phạm vi dữ liệu được chia sẻ, điều kiện ghi nhận chuyển đổi và tỷ lệ chi phí hợp tác.
   - **Bước 4 - Triển khai kỹ thuật:** Cung cấp mã giới thiệu hoặc liên kết truy vết chuyên biệt (UTM Referral Link); tôn trọng quyền chủ động đăng ký của khách hàng.
   - **Bước 5 - Đối soát đa chiều:** Định kỳ đối soát đơn hàng hợp lệ, loại trừ đơn trùng lặp, đơn hủy/hoàn trả và các đơn phát sinh ngoài cửa sổ ghi nhận đã thỏa thuận trước khi tính toán hoa hồng.
   - **Bước 6 - Thanh toán minh bạch:** Bộ phận kế toán thực hiện đối soát và thanh toán hoa hồng theo hợp đồng pháp lý; không để AI tự động thực hiện chi trả tài chính ngoài thẩm quyền.
2. **Quy tắc kiểm soát và chống gian lận hoa hồng:**
   - **Quy tắc ghi nhận (Attribution Rule):** Xác định rõ ưu tiên ghi nhận lượt giới thiệu đầu tiên hay lượt tương tác cuối cùng khi có nhiều đối tác cùng giới thiệu.
   - **Chống tự giới thiệu (Anti-Self-Referral):** Chặn đứng hành vi đối tác tự dùng liên kết của mình để mua hàng nhằm trục lợi hoa hồng chiết khấu.
   - **Chống tính trùng chi phí:** Tuyệt đối không tính trùng một khoản tiết kiệm chi phí hoa hồng hai lần vào biên đóng góp sản phẩm; xem chi tiết tại [kinh tế đơn hàng](../delivery/analytics.md#unit-economics).
3. **Cách ly dữ liệu khách hàng (Data Boundary Isolation):**
   - Báo cáo định kỳ gửi cho đối tác chỉ bao gồm dữ liệu tổng hợp về số lượng click, số đơn thành công và số tiền hoa hồng được duyệt.
   - Vai trò đối tác tuyệt đối không có quyền truy cập hồ sơ chi tiết Customer 360 hoặc thông tin cá nhân của người mua hàng.

## MKT-DOM-001: FMCG & EV Campaign Playbooks — Kịch bản chiến dịch thực chiến cho hàng tiêu dùng và xe máy điện

### 1. Phân hệ Hàng tiêu dùng nhanh (FMCG D2C & Bán lẻ)
- **Tín hiệu & Nhu cầu:** Nhu cầu bổ sung định kỳ đối với các mặt hàng tiêu hao nhanh (nước giặt, thực phẩm chức năng, sản phẩm chăm sóc cá nhân). Tín hiệu kích hoạt chiến dịch là khi thời gian kể từ lần mua trước đạt 70–80% chu kỳ sử dụng trung bình của nhóm sản phẩm.
- **Thiết kế chiến dịch nuôi dưỡng:** MKT-01 & MKT-03 khởi tạo chiến dịch thông báo chăm sóc cá nhân hóa kèm voucher ưu đãi có kiểm soát trần (Basket Cap từ 1.000–2.000 TWD hoặc trần tiền mặt), phân phối qua Zalo OA hoặc LINE OA.
- **Kênh phân phối & Giao nhận:** Kết hợp ưu đãi nhận hàng tại chuỗi siêu thị tiện lợi 7-Eleven / FamilyMart (CVS COD) nhằm tối ưu hóa sự thuận tiện cho người mua hàng tại khu vực đô thị.
- **Brand Guardian (MKT-04):** Rà soát nghiêm ngặt các tuyên bố về thành phần hữu cơ, nguồn gốc xuất xứ và chứng nhận an toàn; ngăn chặn triệt để mọi cam kết về hiệu quả điều trị hoặc công dụng y khoa sai quy định pháp luật.

### 2. Phân hệ Xe máy điện (High-Ticket EV Scooter O2O)
- **Tín hiệu & Phân khúc đối tượng:** Khách hàng quan tâm đến chính sách đổi xe xăng cũ lấy xe máy điện (汰舊換新), tìm kiếm thông tin về trợ cấp bảo vệ môi trường, hoặc có tuyến đường di chuyển hàng ngày đi qua mật độ trạm sạc/đổi pin GoStation/Ionex dày đặc.
- **Mô hình tiếp thị O2O (Online-to-Offline):**
  - Mục tiêu chiến dịch không nhằm bán xe trực tuyến mà tập trung dẫn dắt khách hàng Đặt lịch trải nghiệm lái thử tại Showroom (預約門市試乘).
  - Nội dung chiến dịch làm rõ chính sách trợ cấp chính phủ 3 tầng (Bộ Kinh tế, Cục Môi trường, Thành phố) và tiện ích mạng lưới trạm đổi pin trong bán kính 1km quanh nơi sinh sống.
- **Brand Guardian (MKT-04):**
  - Thẩm định chặt chẽ các thông số kỹ thuật về tầm hoạt động của pin (quãng đường tối đa bắt buộc phải nêu rõ điều kiện thử nghiệm tiêu chuẩn, vận tốc và tải trọng thử nghiệm).
  - Kiểm tra tính xác thực của các thông tin về thời gian đổi pin, thời hạn bảo hành pin và cam kết chất lượng xe; loại bỏ mọi nội dung phóng đại gây hiểu lầm cho người tiêu dùng.
