# Đo lường hiệu quả và kinh tế đơn hàng

[Mục lục](../README.md) · [Bản đầu và lộ trình](mvp-and-roadmap.md) · [Bán hàng](../modules/sales.md)

Trạng thái: mô hình đo lường đề xuất, chưa có số liệu vận hành. Các phép tính là minh họa thiết kế, phải được người phụ trách tài chính kiểm tra bằng dữ liệu thực trước khi dùng để quyết định giá.

<a id=section-20></a>

## 1. Đo giá trị, không chỉ đo hoạt động

Mục tiêu chính là giải quyết đúng nhu cầu với chi phí hợp lý và lãi đóng góp phù hợp. Nhiều tin nhắn, điểm khách cao hay nhiều đơn giảm giá chưa đủ chứng minh thành công.

| Đối tượng | Câu hỏi chính | Chỉ số phù hợp |
|---|---|---|
| Nghiên cứu/Tiếp thị | Tìm đúng nhu cầu và nguồn khách chưa? | Giả thuyết được kiểm chứng, khách phù hợp, chi phí thu hút, kết quả theo nguồn/đối tác |
| Bán hàng | Khách chọn đúng và tiến đến mua chưa? | Hoàn thành tìm hiểu nhu cầu, chuyển đổi, lãi đóng góp, đổi trả |
| Chăm sóc | Vấn đề thật sự được giải quyết chưa? | Giải quyết có xác nhận, mở lại, bàn giao, thời gian phản hồi, mức hài lòng |
| Vận hành | Tự động hóa có đáng tin và tiết kiệm không? | Lỗi, hành động bị chặn, thời gian nhân viên, chi phí AI và kết nối |
| Doanh nghiệp | Tăng trưởng có chất lượng không? | Mua lại, giới thiệu, lãi theo kênh, chi phí thu hút, giá trị khách theo thời gian |

P1 chỉ báo các chỉ số từ nguồn đã kết nối. Chi phí quảng cáo, doanh thu, hoa hồng, giá trị vòng đời hay hiệu quả đối tác chưa có nguồn thì để chưa có dữ liệu, không tự ước lượng như số thực.

## 2. Sự kiện và nguồn xác nhận

Mỗi sự kiện gồm doanh nghiệp, nguồn, mã bất biến, thời điểm xảy ra, thời điểm nhận, đối tượng nghiệp vụ, mã truy vết, phiên bản và chủ thể khi cần. Dùng thời điểm nghiệp vụ để báo cáo, không thay bằng thời gian mạng nhận được.

| Sự kiện máy | Ý nghĩa và nguồn |
|---|---|
| `lead.captured` | Yêu cầu/khách quan tâm được website hoặc hệ thống lưu khách chấp nhận |
| `qualification.started`, `qualification.completed` | Bắt đầu/hoàn tất bộ thông tin theo phiên bản và kết quả |
| `recommendation.presented` | Lựa chọn có nguồn đã được hiển thị |
| `opportunity.updated` | Cơ hội đổi trạng thái được CRM xác nhận, nếu có dùng |
| `booking.offered`, `booking.confirmed` | Đề nghị lịch và lịch được hệ thống xác nhận |
| `message.received`, `message.sent` | Tin vào/ra với trạng thái giao thực từ kênh |
| `followup.sent`, `followup.stopped` | Lần nhắc, kết quả gửi hoặc lý do dừng |
| `handoff.created`, `handoff.accepted`, `handoff.resolved` | Yêu cầu chuyển, người nhận, kết quả xử lý; không gộp thành một trạng thái |
| `support.case_opened`, `support.resolved`, `support.reopened` | Vụ việc, bên giải quyết, xác nhận và mở lại |
| `order.confirmed`, `payment.confirmed` | Đơn và thanh toán là hai sự kiện nguồn riêng |
| `order.returned`, `payment.refunded` | Điều chỉnh theo nguồn được phép, không suy từ lời khách |
| `partner.attributed`, `voucher.issued`, `voucher.redeemed` | Ghi nhận nguồn đối tác/cấp/dùng phiếu sau khi bật năng lực |
| `loyalty.points_awarded`, `loyalty.points_redeemed`, `loyalty.points_revoked`, `loyalty.points_expired` | Sự kiện tích điểm (đơn 1 tặng lớn), đổi phiếu ưu đãi, thu hồi điểm (do hoàn/hủy) và hết hạn điểm |
| `ai.usage.recorded` | Lượng dùng và chi phí AI thực, tiền tệ và độ bao phủ |

Chống trùng theo doanh nghiệp + nguồn + mã sự kiện; đếm đơn/vụ việc/cơ hội theo mã chuẩn, không theo số lần thông báo. Sửa dữ liệu phải có bản điều chỉnh truy vết, không xóa lịch sử sự kiện để làm đẹp số.

## 3. Từ điển chỉ số KPI theo chuẩn SRS v0.1

Chốt múi giờ, khoảng báo cáo dạng [bắt đầu, kết thúc), nhóm quan sát và thời hạn theo dõi trước khi bắt đầu đo lường. Với các chỉ số tỷ lệ, tử số phải thuộc đúng tập mẫu của mẫu số. Toàn bộ các chỉ số dưới đây tuân thủ phân nhóm chuẩn tại Mục 20 của SRS (AI-REV-SRS-001):

**[UNCONFIRMED][ASM-002]** Các chỉ tiêu (target) số lượng cụ thể bắt buộc phải được thiết lập và phê duyệt sau khi thu thập đầy đủ dữ liệu đường cơ sở (baseline) thực tế từ đối tác mỏ neo.

### 3.1. Chỉ số Tiếp thị (Marketing KPIs)

| Mã chỉ số | Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|---|
| **MKT-KPI-01** | Doanh thu chiến dịch | Campaign Revenue | Tổng doanh thu đơn hàng hợp lệ được quy thuộc cho chiến dịch tiếp thị cụ thể; loại trừ đơn hủy/hoàn. |
| **MKT-KPI-02** | Chuyển đổi Lead | Lead Conversion Rate | Số lượng Lead/khách quan tâm hợp lệ thu được / Tổng lượt tiếp cận hoặc lượt nhấp chiến dịch. |
| **MKT-KPI-03** | Chi phí thu hút khách | CAC (Customer Acquisition Cost) | Tổng chi phí tiếp thị và đối tác được phân bổ / Số lượng khách hàng mua mới hợp lệ trong cùng kỳ. |
| **MKT-KPI-04** | Hiệu suất chi quảng cáo | ROAS (Return on Ad Spend) | Doanh thu quy thuộc cho quảng cáo / Tổng ngân sách chi tiêu quảng cáo thực tế. |
| **MKT-KPI-05** | Chi phí mỗi Lead | CPL (Cost per Lead) | Tổng chi phí chiến dịch / Số lượng khách hàng quan tâm (Lead) hợp lệ ghi nhận vào CRM. |
| **MKT-KPI-06** | Mức độ tương tác | Engagement Rate | Tỷ lệ tương tác (bình luận, nhắn tin, nhấp link, điền form) trên tổng lượt hiển thị thông điệp tiếp thị. |
| **MKT-KPI-07** | Tỷ lệ Lead đạt chuẩn | Qualified Lead Rate | Số Lead được Sales Agent hoặc nhân viên xác nhận đủ điều kiện / Tổng số Lead tiếp nhận. |

### 3.2. Chỉ số Bán hàng (Sales KPIs)

| Mã chỉ số | Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|---|
| **SAL-KPI-01** | Chuyển đổi Lead sang Đơn | Lead-to-Order Conversion | Số đơn hàng hoàn tất thanh toán / Tổng số Lead đủ điều kiện được tư vấn trong cùng cửa sổ quan sát. |
| **SAL-KPI-02** | Phục hồi giỏ hàng bỏ quên | Cart Recovery Rate | Số đơn hàng giỏ bỏ quên được phục hồi thành công / Tổng số phiên giỏ hàng bị bỏ quên đủ điều kiện liên hệ. |
| **SAL-KPI-03** | Chuyển đổi đề xuất | Recommendation Conversion | Số lượt khách bấm mua sản phẩm được gợi ý / Tổng số lượt AI đưa ra đề xuất sản phẩm có căn cứ. |
| **SAL-KPI-04** | Doanh thu bán thêm | Upsell Revenue | Chênh lệch doanh thu tăng thêm khi khách chọn phiên bản cao cấp hơn sản phẩm ban đầu hỏi mua. |
| **SAL-KPI-05** | Doanh thu bán chéo | Cross-sell Revenue | Tổng doanh thu phát sinh từ các phụ kiện, gói bảo hành hoặc dịch vụ kèm theo được AI gợi ý thêm. |
| **SAL-KPI-06** | Giá trị đơn trung bình | AOV (Average Order Value) | Tổng doanh thu đơn hàng hợp lệ / Tổng số đơn hàng thành công trong kỳ (sau điều chỉnh hủy/hoàn). |
| **SAL-KPI-07** | Chu kỳ bán hàng | Sales Cycle | Thời gian trung bình từ thời điểm tiếp nhận nhu cầu đầu tiên đến khi đơn hàng được xác nhận thanh toán. |
| **SAL-KPI-08** | Chuyển đổi đặt lịch O2O | Booking Conversion Rate | Số lịch hẹn lái thử showroom / tư vấn B2B được xác nhận / Tổng số đề nghị lịch hẹn được gửi. |

### 3.3. Chỉ số Chăm sóc khách hàng (Customer Care KPIs)

| Mã chỉ số | Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|---|
| **CS-KPI-01** | Thời gian phản hồi đầu | First Response Time (FRT) | Thời gian từ lúc khách gửi tin nhắn đầu tiên đến khi nhận được phản hồi giá trị từ hệ thống (báo trung vị và p95). |
| **CS-KPI-02** | Thời gian giải quyết | Resolution Time | Thời gian từ khi mở vụ việc (case) đến khi vụ việc được xác nhận giải quyết hoàn tất (đóng case). |
| **CS-KPI-03** | Tỷ lệ AI tự giải quyết | AI Resolution Rate | Số vụ việc đóng thành công bởi AI không cần nhân viên can thiệp / Tổng số vụ việc đủ điều kiện giải quyết. |
| **CS-KPI-04** | Tỷ lệ chuyển cấp nhân viên | Escalation Rate | Số phiên/vụ việc phải bàn giao cho nhân viên tiếp quản / Tổng số vụ việc tiếp nhận. |
| **CS-KPI-05** | Tỷ lệ mở lại vụ việc | Reopen Rate | Số vụ việc bị khách hàng mở lại trong vòng 72 giờ sau khi AI đóng / Tổng số vụ việc AI đã đóng. |
| **CS-KPI-06** | Mức độ hài lòng | CSAT (Customer Satisfaction) | Điểm đánh giá trung bình từ khách hàng phản hồi khảo sát sau phiên hỗ trợ; công bố rõ tỷ lệ phản hồi. |

### 3.4. Chỉ số Khách hàng thành công & Giữ chân (Customer Success & Retention KPIs)

| Mã chỉ số | Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|---|
| **SUC-KPI-01** | Mua lại | Repeat Purchase Rate | Tỷ lệ khách hàng phát sinh đơn hàng hợp lệ thứ $N+1$ trong cửa sổ theo dõi quy định (30/60/90 ngày). |
| **SUC-KPI-02** | Giữ chân khách hàng | Retention Rate | Tỷ lệ khách hàng tiếp tục hoạt động hoặc mua hàng sau kỳ quan sát / Tổng khách hàng đầu kỳ. |
| **SUC-KPI-03** | Kích hoạt lại khách cũ | Reactivation Rate | Số khách hàng ngừng mua (ngủ đông > 90 ngày) quay lại mua hàng sau thông điệp chăm sóc / Tổng khách ngủ đông. |
| **SUC-KPI-04** | Tỷ lệ rời bỏ | Churn Rate | Tỷ lệ khách hàng không quay lại hoặc hủy dịch vụ trong kỳ quan sát (1 − Retention Rate). |
| **SUC-KPI-05** | Giá trị vòng đời khách | CLV / LTV (Customer Lifetime Value) | Tổng giá trị lợi nhuận đóng góp thực tế mà một khách hàng mang lại trong toàn bộ thời gian gắn bó. |
| **SUC-KPI-06** | Chuyển đổi đơn 2 từ tích điểm | Loyalty Repeat Conversion | Tỷ lệ khách hàng mua đơn thứ 2 sau khi nhận điểm thưởng đơn đầu; tỷ lệ đổi điểm thành voucher (Points Burn Rate). |
| **SUC-KPI-07** | Giới thiệu khách hàng mới | Referral Rate | Số khách hàng mới mua đơn hợp lệ từ mã giới thiệu / Tổng số lượt chia sẻ giới thiệu hợp lệ. |

### 3.5. Chỉ số Hệ thống AI & Vận hành (AI System KPIs)

| Mã chỉ số | Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|---|
| **AI-SYS-KPI-01** | Tỷ lệ hoàn thành tự chủ | Autonomous Completion Rate | Số chuỗi tác vụ AI tự động thực thi thành công từ Signal đến Outcome / Tổng số tác vụ được phân công. |
| **AI-SYS-KPI-02** | Tỷ lệ người can thiệp | Human Override Rate | Tỷ lệ phiên hoặc quyết định AI bị nhân viên con người chỉnh sửa, chặn lại hoặc giành quyền tiếp quản. |
| **AI-SYS-KPI-03** | Tỷ lệ vi phạm chính sách | Policy Violation Rate | Số lần AI vi phạm ranh giới thẩm quyền hoặc bộ quy tắc giá/dữ liệu (Mục tiêu bắt buộc = 0%). |
| **AI-SYS-KPI-04** | Tỷ lệ ảo giác & phát sinh lỗi | Hallucination / Error Rate | Tỷ lệ câu trả lời bịa đặt thông tin, sai giá catalog hoặc sai chính sách được phát hiện qua audit log. |
| **AI-SYS-KPI-05** | Chi phí / kết quả thành công | Cost per Successful Outcome | Tổng chi phí API AI + hạ tầng / Số đơn hàng hoặc vụ việc CSKH được giải quyết thành công. |
| **AI-SYS-KPI-06** | Tỷ lệ thực thi thất bại | Failed Execution Rate | Số lượt gọi công cụ/kết nối bên ngoài bị thất bại hoặc lỗi hệ thống / Tổng số lượt thực thi (Target < 0.1%). |
| **AI-SYS-KPI-07** | Tỷ lệ thực thi trùng lặp | Duplicate Execution Rate | Số hành động gửi tin hoặc tạo đơn bị trùng lặp do lỗi Idempotency (Mục tiêu bắt buộc = 0%). |
| **AI-SYS-KPI-08** | Ngân sách AI trên mỗi phiên | AI Cost per Session | Chi phí token và API model thực tế trên mỗi phiên tư vấn đầy đủ (Định mức mục tiêu: **0,5–1 TWD/phiên**). |
| **AI-SYS-KPI-09** | Chi phí trên mỗi lượt chạy | Cost per Run | Tổng chi phí token mô hình, chi phí gọi API và tài nguyên connector trong một Agent Run đơn lẻ theo NFR-010. |
| **AI-SYS-KPI-10** | Chi phí trên mỗi khách hàng | Cost per Customer | Tổng chi phí AI tích lũy phân bổ cho một khách hàng định danh (Customer ID) trong toàn bộ chu kỳ tương tác theo NFR-010. |

### 3.6. Quy tắc hợp nhất dữ liệu, Cửa sổ phân bổ và Mô hình quy thuộc đa điểm chạm (Multi-Touch Attribution)

#### 1. Nguyên tắc hợp nhất dữ liệu và chống suy đoán
1. **Không tính hai lần (No Double Counting)**: Vụ việc mở lại chỉ tính một kết quả cuối; nếu có nhân viên can thiệp tiếp quản thì không được tính vào "AI tự giải quyết".
2. **Không suy đoán doanh thu (No Speculative Attribution)**: Doanh thu "có AI tham gia" chỉ là số liệu tương quan, **không chứng minh quan hệ nhân quả AI tạo thêm doanh thu** trừ khi có đối chứng A/B testing hợp lệ.
3. **Phân tách tiền tệ**: Không cộng gộp các khoản tiền khác loại tiền tệ (TWD, VND, USD). Báo cáo phân theo từng loại tiền hoặc quy đổi theo tỷ giá cố định tại thời điểm phát sinh sự kiện.

#### 2. Quy tắc Cửa sổ phân bổ doanh thu (Attribution Window Rules)
Cửa sổ phân bổ (Attribution Window) là khoảng thời gian tối đa cho phép kể từ thời điểm khách hàng tương tác có ý nghĩa với AI Agent đến thời điểm đơn hàng được xác nhận thanh toán (`order.confirmed`):
- **Cửa sổ mặc định theo ngành hàng:**
  - *Hàng tiêu dùng nhanh FMCG (GTM-001B)*:
    - Kịch bản Phục hồi giỏ hàng (Cart Recovery): Cửa sổ phân bổ là **24 giờ** tính từ lúc gửi tin nhắn nhắc giỏ có liên kết giỏ hàng.
    - Kịch bản Chiến dịch nội dung & Ưu đãi định kỳ: Cửa sổ phân bổ là **48 giờ** tính từ lúc khách hàng nhấp vào thông điệp chiến dịch.
  - *Xe máy điện thông minh & O2O High-Ticket (GTM-001A)*:
    - Kịch bản Tư vấn cấu hình & Đặt lịch lái thử showroom: Cửa sổ phân bổ là **72 giờ** tính từ phiên tư vấn cuối cùng có giải đáp thông số kỹ thuật hoặc chính sách trợ cấp.
    - Kịch bản Đặt cọc giữ chỗ hoàn lại: Cửa sổ phân bổ kéo dài tối đa **14 ngày** nếu phát sinh giao dịch đặt cọc giữ chỗ showroom trên hệ thống.
- **Quy tắc loại trừ:** Đơn hàng phát sinh sau khi cửa sổ phân bổ kết thúc sẽ được phân loại là *Doanh thu tự nhiên (Organic Revenue)*, không được tính quy thuộc cho Agent. Tin nhắn tự động mở khung chat mà khách không tương tác phản hồi bị loại trừ 100%.

#### 3. Mô hình quy thuộc đa điểm chạm (Multi-Touch Attribution - MTA) khi có nhiều Agent tham gia
Khi một hành trình chuyển đổi đơn hàng có sự tham gia phối hợp của nhiều Agent trong chuỗi giá trị (Marketing Agent → Sales Advisor → Cart Recovery → Customer Care), hệ thống áp dụng **Mô hình quy thuộc theo vị trí trọng số (Position-Based / W-Shaped Attribution)**:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ MÔ HÌNH QUY THUỘC ĐA ĐIỂM CHẠM VỊ TRÍ TRỌNG SỐ (POSITION-BASED W-SHAPED ATTRIBUTION)    │
├──────────────────────┬──────────────────────┬───────────────────┬──────────────────────┤
│ ĐIỂM CHẠM ĐẦU        │ ĐIỂM CHẠM TƯ VẤN     │ ĐIỂM CHẠM ĐỆM     │ ĐIỂM CHẠM CHỐT       │
│ (First-Touch: 30%)   │ (Lead Creation: 30%) │ (Nurturing: 10%)  │ (Last-Touch: 30%)    │
├──────────────────────┼──────────────────────┼───────────────────┼──────────────────────┤
│ Marketing Agent      │ AI Sales Advisor     │ Customer Care /   │ Cart Recovery Agent  │
│ (MKT-01..05):        │ (SAL-01..03):        │ Content Agent:    │ (SAL-04) hoặc        │
│ Tiếp cận, khơi gợi   │ Xác định nhu cầu,    │ Giải đáp thắc mắc │ Checkout Assistant:  │
│ nhu cầu, click ad    │ tư vấn cấu hình,     │ phụ, chăm sóc     │ Kích hoạt ưu đãi giá │
│ hoặc mở tin chiến dịch│ so sánh sản phẩm     │ chính sách        │ sàn, chốt đơn cuối   │
└──────────────────────┴──────────────────────┴───────────────────┴──────────────────────┘
```

- **Quy tắc phân bổ tỷ trọng:**
  - **30% Doanh thu quy thuộc** gán cho Marketing Agent (MKT-01..05) phụ trách điểm chạm khởi tạo đầu tiên đưa khách vào phễu.
  - **30% Doanh thu quy thuộc** gán cho Sales Agent tư vấn (SAL-01..03) trực tiếp giải đáp nhu cầu và đưa ra đề xuất sản phẩm phù hợp.
  - **30% Doanh thu quy thuộc** gán cho Agent chốt đơn cuối cùng (Last Touch), ví dụ Cart Recovery Agent (SAL-04) kéo khách quay lại giỏ hàng.
  - **10% Doanh thu quy thuộc** gán cho các tương tác đệm ở giữa (Middle Touches), ví dụ Customer Care Agent (CS-01) trả lời về chính sách đổi trả/vận chuyển trong quá trình cân nhắc.
- **Nếu chỉ có một Agent tham gia duy nhất:** 100% doanh thu quy thuộc được ghi nhận cho Agent đó nếu thỏa mãn quy tắc cửa sổ phân bổ.
- **Nếu có con người can thiệp (Human Takeover):** Toàn bộ tỷ trọng phân bổ của chặng tương ứng được chuyển sang ghi nhận cho Nhân viên CSKH/Telesales con người; AI chỉ nhận tỷ trọng của các chặng hoàn toàn tự động trước đó.

<a id=unit-economics></a>

## 4. Kinh tế ưu đãi và giá sàn (Unit Economics & Pricing Engine)

### 4.1. ECN-001 — Tái phân bổ hoa hồng bán hàng (Sales Commission Reallocation)

PDF đề xuất chuyển phần hoa hồng bán hàng tiết kiệm thành giảm tiền cho khách. Kế hoạch chuẩn hóa thành nguyên lý tái phân bổ hoa hồng có kiểm soát toán học:

1. **Trích hoa hồng telesales 5–10% thành Quỹ trợ cấp chốt đơn động (Dynamic Closing Subsidy Pool)**: Trong các kênh bán hàng truyền thống, chi phí hoa hồng đội ngũ telesales hoặc đại lý trung gian thường chiếm từ 5% đến 10% (hoặc cao hơn) trên giá bán niêm yết $P_{base}$. Khi thay thế hoặc tăng cường bằng AI Sales Advisor (SAL-02), phần hoa hồng biến đổi thực tế tránh được (Avoided Variable Commission) được trích một phần vào Quỹ trợ cấp chốt đơn, cho phép AI cấp ưu đãi tức thời nhằm tăng chuyển đổi mà không bào mòn biên lợi nhuận gốc của doanh nghiệp.
2. **Nguyên tắc chi phí tránh được**: Chỉ tính chi phí thực sự tránh được theo từng đơn phát sinh; lương cố định của nhân sự văn phòng không tự biến mất.
3. **Chi phí vận hành mới**: Vẫn phải khấu trừ chi phí AI (ECN-003), chi phí nhân viên hỗ trợ tiếp quản, phí cổng thanh toán, phí giao vận, dự phòng rủi ro gian lận, đổi trả và hoa hồng đối tác giới thiệu (B2B2C Affiliate).
4. **Tách bạch hoa hồng đối tác**: Hoa hồng đối tác giới thiệu là nghĩa vụ chi trả bằng tiền thật cho bên thứ ba, không được nhầm lẫn với phần hoa hồng nhân viên nội bộ đã tiết kiệm.
5. **Đánh giá lãi đóng góp**: Bắt buộc phải so sánh lãi đóng góp (Contribution Margin) trước và sau khi áp dụng trợ cấp, bảo toàn 100% mục tiêu tài chính sau chi phí cố định.

### 4.2. ECN-002 — Công thức xác định giá sàn máy chủ (Deterministic Floor Price Formula P_floor)

Hệ thống bảo toàn tuyệt đối 100% biên lãi ròng (Net Profit Margin) và lãi đóng góp thông qua công thức xác định giá sàn toán học chạy hoàn toàn phía máy chủ (Server-side deterministic validation). AI chỉ đóng vai trò thu nhận tín hiệu nhạy cảm giá và đề xuất mức giảm; **máy chủ là nơi duy nhất có thẩm quyền duyệt và chốt giá cuối**.

Các biến dưới đây dùng cùng loại tiền tệ và cơ sở **chưa thuế gián thu**; các yếu tố thuế/kế toán phải được người phụ trách tài chính xác nhận:

| Biến | Tên biến | Ý nghĩa và Quy tắc đo lường |
|---|---|---|
| $P$ | Doanh thu thực tế | Giá bán sản phẩm sau ưu đãi/trợ cấp, chưa thuế; không gồm phí vận chuyển thu riêng. |
| $C$ | Chi phí biến đổi trên đơn | Chi phí không phụ thuộc tỷ lệ $P$: giá vốn hàng bán (COGS), chi phí xử lý đơn hàng, chi phí vận hành AI (ngân sách định mức **0,5–1 TWD/phiên tư vấn** theo ECN-003), chi phí giao hàng sau trừ cước thu khách, dự phòng hoàn/hủy và chi phí khác đã xác định. |
| $r$ | Tỷ lệ chi phí theo doanh thu | Tổng tỷ lệ phần trăm chi phí tính trực tiếp trên $P$ (ví dụ: phí cổng thanh toán thẻ/LINE Pay/ECPay 2–3%, hoa hồng đối tác tiếp thị liên kết nếu tính theo % doanh thu). |
| $L$ | Lãi đóng góp tối thiểu yêu cầu | Số tiền lãi cố định tối thiểu bắt buộc phải thu về trên mỗi đơn hàng (nhằm bảo toàn 100% biên lãi ròng sau khi phân bổ chi phí cố định). |
| $P_{base}$ | Giá niêm yết cơ sở | Giá sản phẩm cơ sở hiện hành trên cùng phạm vi đơn, chưa thuế và chưa gồm phí vận chuyển thu riêng. |
| $D$ | Tổng mức trợ cấp giảm giá | Tổng mức giảm tiền trực tiếp so với $P_{base}$, bao gồm toàn bộ voucher, trợ cấp AI và khuyến mãi kết hợp ($0 \le D \le D_{cap}$). |
| $D_{cap}$ | Trần trợ cấp tối đa | Hạn mức giảm giá tối đa của đơn hàng do người có thẩm quyền tài chính phê duyệt (ASM-003). |

```text
P = P_base − D; với 0 ≤ D ≤ D_cap
Lãi đóng góp thực tế = P × (1 − r) − C

Giá sàn xác định (Deterministic Floor Price):
P_floor = max((C + L) / (1 − r), P_base − D_cap)
Điều kiện tiên quyết: 0 ≤ r < 1; C, L, P_base, D_cap là số thực dương hợp lệ.
```

**Bảo toàn tỷ suất lãi đóng góp tối thiểu ($m$)**: Nếu doanh nghiệp chọn quản trị theo tỷ suất lãi đóng góp $m$ trên doanh thu thay vì số tiền tuyệt đối $L$:
```text
P_floor_ratio = C / (1 − r − m)
Điều kiện: 1 − r − m > 0 (ngăn chặn chia cho 0 hoặc giá âm).
```

Quy tắc làm tròn: Luôn làm tròn sàn lên (Ceil) theo đơn vị tiền tệ nhỏ nhất được phép (ví dụ: làm tròn lên 1 TWD hoặc 1.000 VNĐ), tuyệt đối không làm tròn xuống. Nếu $P_{floor} > P_{base}$, hệ thống lập tức chối bỏ giao dịch tự động (**Fail Closed** theo NFR-008) và yêu cầu người có thẩm quyền rà soát cấu hình chi phí.

### 4.3. ECN-003 — Định mức kinh tế chi phí AI trên mỗi phiên (Unit AI Session Cost Economics)

Nhằm đảm bảo chi phí AI không làm xói mòn lợi nhuận đơn hàng:
1. **Định mức chi phí AI**: Mỗi phiên tư vấn bán hàng hoặc CSKH hoàn chỉnh có ngân sách định mức mục tiêu là **0,5–1 TWD / phiên** (tương đương ~400–800 VNĐ hoặc ~0,016–0,032 USD).
2. **Chiến lược tối ưu hóa token**:
   - Sử dụng mô hình nhẹ, phản hồi nhanh (ví dụ: Flash/Mini models) cho các tác vụ phân loại ý định (Intent Detection), routing và tra cứu FAQ.
   - Chỉ gọi mô hình suy luận sâu (Reasoning models) cho các tình huống so sánh cấu hình phức tạp hoặc xử lý khiếu nại nhạy cảm.
   - Cache kho kiến thức doanh nghiệp (Prompt Caching) và giới hạn context window để giảm thiểu chi phí input token.
3. **Tính toán trực tiếp vào giá sàn**: Khoản chi phí 0,5–1 TWD này được tính gộp trực tiếp vào thành phần $C$ trong công thức tính $P_{floor}$ của ECN-002, đảm bảo 100% chi phí AI được bù đắp và bảo vệ tuyệt đối biên lãi ròng của từng giao dịch.

### 4.4. ECN-004 — Kiểm soát ngân sách điểm thưởng & Phiếu ưu đãi (Dynamic Loyalty Points & Voucher Budgeting)

1. **Nguồn ngân sách giảm giá và điểm thưởng**:
   ```text
   Ngân sách trợ cấp tối đa = max(0, Hoa hồng bán hàng thực sự tránh được
                                    − Chi phí AI & vận hành phát sinh thêm)
   ```
2. **Kiểm soát trần giỏ hàng và mốc đổi điểm (Basket Cap & Thresholds)**:
   - Áp dụng trần giỏ hàng (Basket Cap 1.000–2.000 TWD hoặc 1.000.000–2.000.000 VNĐ) đối với các voucher giảm theo tỷ lệ %, chặn việc gom hàng sỉ của các đại lý không chính thức.
   - Điều kiện chi tiêu tối thiểu (Min Spend): Đơn hàng đầu tiên tích lũy điểm phải đạt ngưỡng giá trị tối thiểu để tránh tình trạng tạo đơn ảo trục lợi điểm mở đầu.
   - Cấm áp dụng voucher giảm % cho các sản phẩm giá trị cao (High-Ticket EV Scooter), chỉ áp dụng voucher tiền mặt cố định hoặc quà tặng bảo dưỡng/thuê pin.
3. **Chống gian lận trục lợi ưu đãi (Anti-Sybil & Anti-Exploit)**:
   - Sử dụng Bộ tứ định danh: SĐT/LINE OA OTP, vân tay thiết bị (Device Fingerprint), mã băm thanh toán/lịch sử nhận hàng siêu thị (CVS COD History) và đối soát địa chỉ trùng lặp.
   - Tự động thu hồi điểm thưởng (`loyalty.points_revoked`) khi đơn hàng bị hoàn tiền hoặc hủy.

### 4.5. Ví dụ số để kiểm tra thực nghiệm

Giả định cho một đơn hàng: $P_{base} = 1.000.000$ đồng; Chi phí $C = 780.000$ đồng (đã gồm chi phí AI 800 đồng); Tỷ lệ phí thanh toán $r = 2\%$; Lãi đóng góp tối thiểu yêu cầu $L = 120.000$ đồng; Trần giảm giá $D_{cap} = 50.000$ đồng (trích từ quỹ tiết kiệm hoa hồng telesales theo ECN-001).

```text
Sàn theo lãi đóng góp yêu cầu = (780.000 + 120.000) / (1 − 0,02) = 900.000 / 0,98 ≈ 918.368 đồng
Sàn theo trần giảm giá chính sách = 1.000.000 − 50.000 = 950.000 đồng
Giá sàn áp dụng cuối cùng (max) = 950.000 đồng

Kiểm tra hiệu quả kinh tế tại giá sàn áp dụng:
Doanh thu thực thu P = 950.000 đồng
Lãi đóng góp thực tế thu về = 950.000 × (1 − 0,02) − 780.000 = 931.000 − 780.000 = 151.000 đồng
Mức lãi thực tế (151.000 đồng) > Mức lãi tối thiểu L (120.000 đồng) ➔ Đạt chuẩn bảo toàn biên lợi nhuận ròng.
```

Nếu khách hàng hoặc bot AI yêu cầu mức giá 940.000 đồng: dù mức này vẫn đạt lãi đóng góp (141.200 đồng > 120.000 đồng), nhưng vì vượt trần giảm giá $D_{cap} = 50.000$ đồng, hệ thống từ chối ngay lập tức. Cả hai điều kiện an toàn kinh tế phải đồng thời thỏa mãn.

## 5. Thử nghiệm và điều kiện dừng

1. Chọn một thay đổi tại một thời điểm: cách giải thích, câu hỏi nhanh, kênh đối tác hoặc ưu đãi.
2. Chốt nhóm đủ điều kiện, chỉ số chính, thời gian, ngân sách, nguồn và ngưỡng dừng trước khi chạy.
3. Khi đủ lượng mẫu, chia nhóm đối chứng phù hợp để đo thay đổi; không chỉ so ngày chạy quảng cáo mạnh với ngày yếu.
4. Theo dõi đồng thời chuyển đổi, lãi đóng góp, đổi trả, khiếu nại, từ chối nhận tin và chi phí phục vụ.
5. Báo quy mô mẫu, độ bất định và sai lệch chọn nhóm; thiếu mẫu thì kết luận chưa đủ, không tuyên bố chiến thắng.
6. Dừng ngay khi có hành động trái quyền nghiêm trọng, rò dữ liệu hoặc giá dưới sàn; dừng thử thương mại theo ngưỡng ngân sách/lãi/khiếu nại đã duyệt.

P1 không bắt buộc chứng minh tác động nhân quả hay xây hệ thống dự báo. Có thể bắt đầu từ kiểm tra chất lượng và đường cơ sở; phép thử đối chứng dành cho giai đoạn đủ dữ liệu.

## 6. Chất lượng dữ liệu và trách nhiệm

Báo cáo phải hiển thị đủ, một phần, đã cũ hoặc chưa có dữ liệu, kèm lần cập nhật, độ bao phủ và lý do loại mẫu. Thiếu nguồn không hiển thị số 0.

| Vai trò | Trách nhiệm |
|---|---|
| Chủ hệ thống nguồn | Xác nhận dữ liệu và ánh xạ trạng thái |
| Chủ chỉ số | Duyệt tử/mẫu số, nhóm quan sát, cửa sổ, ngoại lệ |
| Người phụ trách tích hợp | Giao nhận, chống trùng, phục hồi và độ mới |
| Người phụ trách báo cáo | Công khai nguồn, phiên bản và dữ liệu thiếu |
| Tài chính/chủ doanh nghiệp | Duyệt chi phí, giá sàn, ngân sách, đường cơ sở và quyết định mở rộng |

Nghiệm thu bằng bộ dữ liệu mẫu tính tay: đối chiếu sự kiện → đối tượng → chỉ số; thử đơn trùng, đơn hủy/hoàn, vụ mở lại, thiếu chi phí và khác tiền tệ. Cùng phép tính phải chạy tách biệt cho hai cấu hình doanh nghiệp thử. Đây là yêu cầu cho sản phẩm tương lai, không phải kiểm thử đã chạy.
