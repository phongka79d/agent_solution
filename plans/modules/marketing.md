# Mô-đun Tiếp thị — Từ nghiên cứu nhu cầu đến khách phù hợp

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P0 nghiên cứu có người làm; P1 chỉ lưu nguồn/yêu cầu qua lõi, **chưa bật mô-đun Tiếp thị tự động**. P2/P3 mở các năng lực dưới đây theo [lộ trình](../delivery/mvp-and-roadmap.md).

<a id=section-6></a>

## 1. Mục tiêu và ranh giới

Tìm đúng vấn đề, đúng nhóm khách, đúng thời điểm và kênh phân phối; tạo nhu cầu được kiểm chứng, không chỉ tạo nhiều biểu mẫu hay lượt bấm (khớp mục tiêu **OBJ-001** trong SRS).

Tiếp thị bắt đầu trước quảng cáo, nhưng việc phát hiện một tín hiệu **không tạo quyền truy cập danh sách cá nhân hoặc quyền gửi tin** (tuân thủ **BR-004**). Quảng cáo, ngân sách và xuất bản bắt buộc phải do người có thẩm quyền phê duyệt (**AUTH-4**). Nền tảng quảng cáo sở hữu khâu phân phối/đấu giá; AgentOS không thay thế khâu đó.

## 2. Hệ thống 6 Agent Tiếp thị chuẩn theo SRS (MKT-01 đến MKT-06)

Thay vì các kịch bản rời rạc, mô-đun Tiếp thị vận hành với cấu trúc 6 Agent chuyên trách theo chuẩn SRS, phối hợp chặt chẽ qua Orchestrator:

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

## 3. Quy trình nghiên cứu chuẩn

1. Xác định kết quả cuối khách cần, không chỉ tên sản phẩm đang bán.
2. Đi ngược hành trình để tìm hành động xảy ra trước nhu cầu; kiểm tra thứ tự thực tế thay vì coi ví dụ là quy luật.
3. Xác định nơi khách tập trung và tổ chức có thể giới thiệu giải pháp.
4. Tìm vấn đề chưa được giải quyết tốt, cách khách đang xử lý và lý do họ có thể đổi giải pháp.
5. Đánh giá sản phẩm của doanh nghiệp: lợi ích, giới hạn, khác biệt, điều kiện dùng và bằng chứng.
6. Ước lượng khả năng chi trả, biên lợi nhuận, mua lại, chi phí thu hút, phân phối; xác định rào cản pháp lý và vận hành cần người có chuyên môn kiểm tra.
7. Chọn một giả thuyết có đòn bẩy lớn như chuyển đổi, mua lại hoặc chi phí thu hút; thiết kế phép thử nhỏ.
8. Người phụ trách quyết định thử, sửa hay dừng dựa trên kết quả, không dựa vào lời tự chấm điểm của AI.

Ba nhóm động cơ trong PDF được diễn đạt trung tính: người quan tâm giá, người muốn thao tác nhanh và người cần thêm bằng chứng. Tuổi, tỷ lệ và hành vi minh họa chưa được coi là phân khúc đã xác thực; không gán nhãn cá nhân bằng suy đoán.

Thông điệp còn phải phù hợp mức nhận thức nhu cầu: khách đã có nhu cầu cần bằng chứng so sánh; khách biết vấn đề nhưng chưa biết giải pháp cần được giải thích lựa chọn; khách chưa nhận ra vấn đề cần thông tin có căn cứ về bất tiện hoặc cơ hội cải thiện. Không tạo nhu cầu giả, thổi phồng hậu quả hay dùng nỗi sợ để thúc mua.

### Phiếu cơ hội tối thiểu

| Trường | Nội dung phải ghi |
|---|---|
| Vấn đề và phân khúc | Ai gặp vấn đề gì, trong hoàn cảnh nào; điều chưa biết |
| Nhu cầu cuối | Kết quả khách mong muốn và cách giải quyết hiện tại |
| Tín hiệu sớm | Hành động, nguồn quan sát, ngày, khoảng thời gian hữu ích; hết hạn khi nào |
| Điểm tập trung / đối tác | Tổ chức nào, vì sao phù hợp, nguồn công khai hoặc nguồn được cấp quyền |
| Giải pháp và bằng chứng | Sản phẩm phù hợp, giới hạn, nguồn xác nhận công dụng |
| Kinh tế sơ bộ | Doanh thu/chi phí giả định, hoa hồng đối tác, lãi đóng góp và dữ liệu còn thiếu |
| Rào cản | Điều kiện pháp lý, quyền dữ liệu, năng lực cung cấp và rủi ro vận hành cần kiểm tra trước thử |
| Phép thử | Đối tượng, kênh, thông điệp, người duyệt, giới hạn ngân sách, chỉ số và tiêu chí dừng |
| Kết quả | Phản hồi, đơn hợp lệ nếu có, chi phí, kết luận giữ/sửa/bỏ |

Tách **sự kiện có nguồn**, **suy luận** và **giả thuyết chưa kiểm chứng**. Chưa có dữ liệu quy mô thị trường thì để chưa biết, không tự tạo số.

### Vận dụng ví dụ SIM

Nhu cầu cuối là kết nối thuận tiện khi đến nơi. Học tiếng, chuẩn bị hồ sơ hoặc vé máy bay có thể là tín hiệu để nghiên cứu nhóm nhu cầu, không phải bằng chứng từng người chắc chắn cần SIM. Trung tâm/đơn vị liên quan có thể thử giới thiệu đường dẫn để khách tự đăng ký.

Ví dụ 300 học viên × 60% × 40% = 72 khách/năm chỉ minh họa cách tính. Không dùng tỷ lệ 10%, 60%, 40% hoặc số đối tác trong tài liệu nguồn để lập dự báo thực tế khi chưa đo.

### Vận dụng kịch bản Hàng tiêu dùng (FMCG D2C & Bán lẻ)

- **Tín hiệu & Nhu cầu:** Chu kỳ dùng hết sản phẩm (nước giặt, thực phẩm chức năng, đồ chăm sóc cá nhân) tạo nhu cầu bổ sung định kỳ. Tín hiệu sớm là khoảng thời gian từ lần mua trước đạt 70–80% chu kỳ tiêu dùng trung bình.
- **Phép thử tiếp thị:** MKT-01 & MKT-03 tạo chiến dịch nhắc nhớ kèm ưu đãi nhỏ có trần giá trị (Basket Cap 1.000–2.000 TWD hoặc trần tiền mặt), phân phối qua Zalo/LINE OA.
- **Kênh phân phối & Nhận hàng:** Kết hợp ưu đãi nhận hàng tại chuỗi siêu thị tiện lợi 7-Eleven / FamilyMart (CVS COD) nhằm giảm rào cản thanh toán cho khách hàng bận rộn.
- **Brand Guardian:** MKT-04 rà soát claim về thành phần hữu cơ/tự nhiên, đối chiếu chứng nhận an toàn, không cho phép cam kết trị liệu y khoa sai luật.

### Vận dụng kịch bản Xe máy điện (High-Ticket EV Scooter O2O)

- **Tín hiệu & Phân khúc:** Khách hàng quan tâm chính sách đổi xe xăng cũ lấy xe điện (汰舊換新), tìm kiếm thông tin trợ cấp môi trường hoặc có lộ trình di chuyển hàng ngày qua các trạm sạc/trạm đổi pin.
- **Mô hình tiếp thị O2O (Online-to-Offline):** Chiến dịch không nhằm chốt bán xe online mà tập trung kéo khách đến Showroom trải nghiệm lái thử (預約門市試乘). Nội dung chiến dịch làm rõ quyền lợi trợ cấp 3 tầng (Bộ Kinh tế, Cục Môi trường, Thành phố) và mạng lưới đổi pin phủ sóng bán kính 1km.
- **Brand Guardian:** Kiểm duyệt nghiêm ngặt các tuyên bố về quãng đường tối đa của pin (phải ghi rõ điều kiện thử nghiệm tiêu chuẩn, tải trọng, vận tốc), thời gian sạc/đổi pin và chính sách bảo hành pin/xe; chặn hoàn toàn các claim gây hiểu lầm.

## 4. Kênh đối tác và hoa hồng

1. Kiểm chứng giải pháp trực tiếp với nhóm nhỏ trước.
2. Chọn một đối tác có khách phù hợp, không cạnh tranh trực tiếp và có lợi ích rõ.
3. Duyệt cách giới thiệu, dữ liệu được chia sẻ, điều kiện ghi nhận và chi phí hợp tác.
4. Gắn đường dẫn/mã nguồn; để khách chủ động truy cập hoặc cho phép liên hệ.
5. Đối chiếu đơn hợp lệ, đơn trùng, hủy/hoàn và cửa sổ ghi nhận trước khi tính hoa hồng.
6. Nhân viên đối soát và chi trả theo quy trình hiện có; chưa xây hệ thống thanh toán đối tác trong P1/P2.

Phải chốt quy tắc khi nhiều đối tác cùng giới thiệu, tự giới thiệu, gian lận mã, đơn bị trả hoặc nguồn không rõ. Không tính một khoản tiết kiệm hoa hồng bán hàng hai lần; xem [kinh tế đơn hàng](../delivery/analytics.md#unit-economics).

Báo cáo đối tác chỉ chứa dữ liệu cần thiết được phép. Vai trò đối tác không cho quyền xem toàn bộ Customer360.

## 5. Tiếp nhận, phân loại và chăm sóc

Đầu vào: yêu cầu/sự kiện từ nguồn đã xác thực; mã sự kiện; thời điểm; sản phẩm quan tâm; nguồn chiến dịch/đối tác nếu có; trạng thái đồng ý liên hệ; khách/phiên đã được liên kết đúng quyền.

1. Xác thực nguồn và loại sự kiện trước khi tiếp nhận; loại nguồn không hợp lệ, chỉ lưu nhật ký từ chối tối thiểu.
2. Chống trùng; lưu yêu cầu dù thiếu nguồn quảng cáo, nhưng đánh dấu nguồn chưa biết.
3. Giữ khách ẩn danh ở mức phiên khi chưa xác minh; không hợp nhất theo email/số điện thoại tự khai.
4. Hỏi phần cần thiết, lưu phần thiếu là chưa biết.
5. Khi Tiếp thị được bật, MKT-02 chấm mức phù hợp/quan tâm bằng quy tắc có phiên bản, giới hạn điểm hành vi và loại lượt trùng.
6. Khách sẵn sàng mua chuyển Bán hàng (SAL-01) kèm reason + evidence; Bán hàng xác nhận điều kiện, không coi điểm cao là khách đã đủ chuẩn.
7. Khách chưa sẵn sàng chỉ được chăm sóc nếu đủ điều kiện theo mục đích/kênh; thiếu phép vẫn có thể trả lời câu hỏi chủ động hợp lệ.

Lượt xem, lưu món hoặc ở trang hơn 8 giây chỉ là tín hiệu tương tác, không chứng minh ý định mua. Không có công thức chấm điểm mặc định đáng tin cho mọi ngành.

## 6. Tương tác tại website, sáng tạo nội dung và kiểm soát ngân sách

Tính năng sau P1 có thể gồm lưu món chưa đăng nhập, hướng dẫn tại chỗ và đăng ký nhận ưu đãi. Nội dung quảng cáo, trang giới thiệu, tin nhắn và đề xuất ngân sách luôn ở trạng thái nháp cho đến khi được người có quyền duyệt.

Giới hạn ban đầu cho gợi ý tự bật là tối đa một lần/24 giờ/thiết bị khi bật tính năng; 8 giây chỉ là tham số thử từ PDF. Không bật khi chat/giỏ đang mở, không cản mua hay buộc cung cấp số điện thoại. Người xem chủ động mở trợ giúp không tính là quảng cáo tự bật.

Zalo, LINE, Facebook, email hoặc kênh khác chỉ gửi khi bộ kết nối và điều kiện hiện hành đã được xác nhận. Nút đăng ký và số điện thoại giao hàng phải có mục đích riêng, không tự đánh dấu đồng ý.

### Kiểm soát ngân sách và chốt chặn an toàn (Budget & Safety Controls)
- **AUTH-4 Bắt buộc cho Ngân sách:** AI Tiếp thị (MKT-01, MKT-05) chỉ có quyền lập đề xuất ngân sách (Draft/Recommend), tuyệt đối không có quyền tự cấp phát hay giải ngân chi phí quảng cáo.
- **Trần ngân sách kép (Dual-Cap):** Mọi chiến dịch phải có trần ngày (Daily Budget Cap) và trần chiến dịch (Total Campaign Cap). Khi đạt 95% hạn mức, hệ thống tự động cảnh báo; khi đạt 100%, hệ thống tự động tạm dừng chiến dịch (Fail Closed).
- **Phân định rõ ràng chi phí:** Tách bạch chi phí media trực tiếp (Ad Spend), chi phí đối tác B2B2C và chi phí trợ cấp giá/ưu đãi khách hàng để tránh tính trùng hai lần vào biên đóng góp (Contribution Margin).

## 7. Nghiệm thu và Tiêu chí đánh giá

### 7.1. Bảng kiểm tra nghiệm thu (Acceptance Criteria)

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

### 7.2. Hệ chỉ số KPI Tiếp thị theo SRS

Hiệu quả hoạt động của hệ thống Agent Tiếp thị (MKT-01 đến MKT-06) được đo lường qua các chỉ số cốt lõi:
- **Campaign Revenue:** Doanh thu gán cho chiến dịch có đối soát đơn hàng thực tế qua ERP.
- **Lead Conversion & Qualified Lead Rate:** Tỷ lệ chuyển đổi đầu mối và tỷ lệ khách đủ chuẩn bàn giao sang Bán hàng kèm reason + evidence.
- **CAC (Customer Acquisition Cost):** Chi phí thu hút một khách hàng mới, tính đủ media spend, đối tác và ưu đãi.
- **ROAS (Return on Ad Spend):** Doanh thu thu về trên mỗi đồng ngân sách quảng cáo được duyệt.
- **Cost per Lead:** Chi phí trung bình trên mỗi đầu mối tiếp thị hợp lệ.
- **Engagement & Brand Safety Rate:** Tỷ lệ tương tác thực và tỷ lệ vi phạm chính sách thương hiệu (phải duy trì bằng 0 nhờ MKT-04).

Chỉ số và dữ liệu thiếu do [đo lường](../delivery/analytics.md) quy định; trạng thái gửi, nhận và dừng do [quy trình](../platform/workflows-and-handoffs.md) quy định.
