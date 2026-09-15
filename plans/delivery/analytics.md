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

| Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|
| Doanh thu chiến dịch | Campaign Revenue | Tổng doanh thu đơn hàng hợp lệ được quy thuộc cho chiến dịch tiếp thị cụ thể; loại trừ đơn hủy/hoàn. |
| Chuyển đổi Lead | Lead Conversion Rate | Số lượng Lead/khách quan tâm hợp lệ thu được / Tổng lượt tiếp cận hoặc lượt nhấp chiến dịch. |
| Chi phí thu hút khách | CAC (Customer Acquisition Cost) | Tổng chi phí tiếp thị và đối tác được phân bổ / Số lượng khách hàng mua mới hợp lệ trong cùng kỳ. |
| Hiệu suất chi quảng cáo | ROAS (Return on Ad Spend) | Doanh thu quy thuộc cho quảng cáo / Tổng ngân sách chi tiêu quảng cáo thực tế. |
| Chi phí mỗi Lead | CPL (Cost per Lead) | Tổng chi phí chiến dịch / Số lượng khách hàng quan tâm (Lead) hợp lệ ghi nhận vào CRM. |
| Mức độ tương tác | Engagement | Tỷ lệ tương tác (bình luận, nhắn tin, nhấp link, điền form) trên tổng lượt hiển thị thông điệp tiếp thị. |
| Tỷ lệ Lead đạt chuẩn | Qualified Lead Rate | Số Lead được Sales Agent hoặc nhân viên xác nhận đủ điều kiện / Tổng số Lead tiếp nhận. |

### 3.2. Chỉ số Bán hàng (Sales KPIs)

| Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|
| Chuyển đổi Lead sang Đơn | Lead-to-Order Conversion | Số đơn hàng hoàn tất thanh toán / Tổng số Lead đủ điều kiện được tư vấn trong cùng cửa sổ quan sát. |
| Phục hồi giỏ hàng bỏ quên | Cart Recovery Rate | Số đơn hàng giỏ bỏ quên được phục hồi thành công / Tổng số phiên giỏ hàng bị bỏ quên đủ điều kiện liên hệ. |
| Chuyển đổi đề xuất | Recommendation Conversion | Số lượt khách bấm mua sản phẩm được gợi ý / Tổng số lượt AI đưa ra đề xuất sản phẩm có căn cứ. |
| Doanh thu bán thêm | Upsell Revenue | Chênh lệch doanh thu tăng thêm khi khách chọn phiên bản cao cấp hơn sản phẩm ban đầu hỏi mua. |
| Doanh thu bán chéo | Cross-sell Revenue | Tổng doanh thu phát sinh từ các phụ kiện, gói bảo hành hoặc dịch vụ kèm theo được AI gợi ý thêm. |
| Giá trị đơn trung bình | AOV (Average Order Value) | Tổng doanh thu đơn hàng hợp lệ / Tổng số đơn hàng thành công trong kỳ (sau điều chỉnh hủy/hoàn). |
| Chu kỳ bán hàng | Sales Cycle | Thời gian trung bình từ thời điểm tiếp nhận nhu cầu đầu tiên đến khi đơn hàng được xác nhận thanh toán. |
| Chuyển đổi đặt lịch O2O | Booking Conversion Rate | Số lịch hẹn lái thử showroom / tư vấn B2B được xác nhận / Tổng số đề nghị lịch hẹn được gửi. |

### 3.3. Chỉ số Chăm sóc khách hàng (Customer Care KPIs)

| Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|
| Thời gian phản hồi đầu | First Response Time (FRT) | Thời gian từ lúc khách gửi tin nhắn đầu tiên đến khi nhận được phản hồi giá trị từ hệ thống (báo trung vị và p95). |
| Thời gian giải quyết | Resolution Time | Thời gian từ khi mở vụ việc (case) đến khi vụ việc được xác nhận giải quyết hoàn tất (đóng case). |
| Tỷ lệ AI tự giải quyết | AI Resolution Rate | Số vụ việc đóng thành công bởi AI không cần nhân viên can thiệp / Tổng số vụ việc đủ điều kiện giải quyết. |
| Tỷ lệ chuyển cấp nhân viên | Escalation Rate | Số phiên/vụ việc phải bàn giao cho nhân viên tiếp quản / Tổng số vụ việc tiếp nhận. |
| Tỷ lệ mở lại vụ việc | Reopen Rate | Số vụ việc bị khách hàng mở lại trong vòng 72 giờ sau khi AI đóng / Tổng số vụ việc AI đã đóng. |
| Mức độ hài lòng | CSAT (Customer Satisfaction) | Điểm đánh giá trung bình từ khách hàng phản hồi khảo sát sau phiên hỗ trợ; công bố rõ tỷ lệ phản hồi. |

### 3.4. Chỉ số Khách hàng thành công & Giữ chân (Customer Success & Retention KPIs)

| Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|
| Mua lại | Repeat Purchase Rate | Tỷ lệ khách hàng phát sinh đơn hàng hợp lệ thứ $N+1$ trong cửa sổ theo dõi quy định (30/60/90 ngày). |
| Giữ chân khách hàng | Retention Rate | Tỷ lệ khách hàng tiếp tục hoạt động hoặc mua hàng sau kỳ quan sát / Tổng khách hàng đầu kỳ. |
| Kích hoạt lại khách cũ | Reactivation Rate | Số khách hàng ngừng mua (ngủ đông > 90 ngày) quay lại mua hàng sau thông điệp chăm sóc / Tổng khách ngủ đông. |
| Tỷ lệ rời bỏ | Churn Rate | Tỷ lệ khách hàng không quay lại hoặc hủy dịch vụ trong kỳ quan sát (1 − Retention Rate). |
| Giá trị vòng đời khách | CLV / LTV (Customer Lifetime Value) | Tổng giá trị lợi nhuận đóng góp thực tế mà một khách hàng mang lại trong toàn bộ thời gian gắn bó. |
| Chuyển đổi đơn 2 từ tích điểm | Loyalty Repeat Conversion | Tỷ lệ khách hàng mua đơn thứ 2 sau khi nhận điểm thưởng đơn đầu; tỷ lệ đổi điểm thành voucher (Points Burn Rate). |
| Giới thiệu khách hàng mới | Referral Rate | Số khách hàng mới mua đơn hợp lệ từ mã giới thiệu / Tổng số lượt chia sẻ giới thiệu hợp lệ. |

### 3.5. Chỉ số Hệ thống AI & Vận hành (AI System KPIs)

| Chỉ số | Tên tiếng Anh | Công thức / Quy tắc đo lường |
|---|---|---|
| Tỷ lệ hoàn thành tự chủ | Autonomous Completion Rate | Số chuỗi tác vụ AI tự động thực thi thành công từ Signal đến Outcome / Tổng số tác vụ được phân công. |
| Tỷ lệ người can thiệp | Human Override Rate | Tỷ lệ phiên hoặc quyết định AI bị nhân viên con người chỉnh sửa, chặn lại hoặc giành quyền tiếp quản. |
| Tỷ lệ vi phạm chính sách | Policy Violation Rate | Số lần AI vi phạm ranh giới thẩm quyền hoặc bộ quy tắc giá/dữ liệu (Mục tiêu bắt buộc = 0%). |
| Tỷ lệ ảo giác & phát sinh lỗi | Hallucination / Error Rate | Tỷ lệ câu trả lời bịa đặt thông tin, sai giá catalog hoặc sai chính sách được phát hiện qua audit log. |
| Chi phí / kết quả thành công | Cost per Successful Outcome | Tổng chi phí API AI + hạ tầng / Số đơn hàng hoặc vụ việc CSKH được giải quyết thành công. |
| Tỷ lệ thực thi thất bại | Failed Execution Rate | Số lượt gọi công cụ/kết nối bên ngoài bị thất bại hoặc lỗi hệ thống / Tổng số lượt thực thi (Target < 0.1%). |
| Tỷ lệ thực thi trùng lặp | Duplicate Execution Rate | Số hành động gửi tin hoặc tạo đơn bị trùng lặp do lỗi Idempotency (Mục tiêu bắt buộc = 0%). |
| Ngân sách AI trên mỗi phiên | AI Cost per Session | Chi phí token và API model thực tế trên mỗi phiên tư vấn đầy đủ (Định mức mục tiêu: **0,5–1 TWD/phiên**). |

### 3.6. Quy tắc hợp nhất dữ liệu và quy thuộc doanh thu

1. **Không tính hai lần**: Vụ việc mở lại chỉ tính một kết quả cuối; nếu có nhân viên can thiệp thì không được tính vào "AI tự giải quyết".
2. **Không suy đoán doanh thu**: Doanh thu "có AI tham gia" chỉ là số liệu liên quan, **không chứng minh quan hệ nhân quả AI tạo thêm doanh thu** trừ khi có đối chứng A/B testing hợp lệ.
3. **Phân tách tiền tệ**: Không cộng gộp các khoản tiền khác loại tiền tệ (TWD, VND, USD). Báo cáo phân theo từng loại tiền hoặc quy đổi theo tỷ giá cố định tại thời điểm phát sinh sự kiện.
4. **Quy tắc đủ điều kiện**: Tương tác AI chỉ được gắn với đơn hàng nếu tương tác có nội dung tư vấn sản phẩm và diễn ra trong cửa sổ quy thuộc (attribution window) đã chốt trước (thường 24–72 giờ). Các tin nhắn tự động mở khung chat không được tính là tương tác tư vấn.

<a id=unit-economics></a>

## 4. Kinh tế ưu đãi và giá sàn

### 4.1. Điều chỉnh giả thuyết của PDF

PDF đề xuất chuyển phần hoa hồng bán hàng tiết kiệm thành giảm tiền cho khách. Giữ ý tưởng chia lợi ích, nhưng không giữ kết luận bảo toàn 100% lợi nhuận:

1. Chỉ tính chi phí thực sự tránh được theo đơn; lương cố định không tự biến mất.
2. Vẫn có chi phí AI, nhân viên hỗ trợ, thanh toán, vận chuyển, gian lận, đổi trả và đối tác.
3. Hoa hồng đối tác không phải hoa hồng nhân viên đã tiết kiệm; phải tính riêng.
4. Phiếu mua lần sau có chi phí khi sử dụng và nghĩa vụ cần theo dõi; không gọi là không mất tiền.
5. Phải so lãi đóng góp trước/sau, rồi mới đánh giá lợi nhuận toàn doanh nghiệp sau chi phí cố định.

### 4.2. Công thức đề xuất cho máy chủ

Các biến dưới đây dùng cùng tiền tệ và cơ sở **chưa thuế gián thu**; các yếu tố thuế/kế toán phải được người phụ trách xác nhận. Đây là mô hình lãi đóng góp đơn giản, không phải công thức lợi nhuận ròng.

| Biến | Nghĩa |
|---|---|
| P | Doanh thu sản phẩm sau giảm giá, chưa thuế; trong mô hình minh họa này không gồm phí vận chuyển thu riêng |
| C | Chi phí theo đơn không tính theo tỷ lệ P: giá vốn, xử lý, chi phí vận hành AI (ngân sách định mức 0,5–1 TWD/phiên tư vấn hoàn chỉnh, tương đương ~400–800 VNĐ hoặc ~0,016–0,032 USD), chi phí giao hàng sau khi trừ phí vận chuyển thu riêng, dự phòng đổi trả/phiếu mua hàng và chi phí khác đã xác định |
| r | Tổng tỷ lệ chi phí thực sự tính trên P, ví dụ phí thanh toán/hoa hồng đối tác nếu hợp đồng dùng đúng cơ sở này |
| L | Lãi đóng góp tối thiểu yêu cầu, số tiền trên đơn (bảo toàn biên lợi nhuận ròng doanh nghiệp) |
| P_base | Giá sản phẩm cơ sở hiện hành trên cùng phạm vi đơn, chưa thuế và chưa gồm phí vận chuyển thu riêng |
| D | Tổng giảm tiền trực tiếp so với P_base, gồm các mã giảm giá được kết hợp; không chỉ phần AI vừa đề xuất |
| D_cap | Hạn mức giảm tiền của đơn đã được người có quyền duyệt |

```text
P = P_base − D; 0 ≤ D ≤ D_cap
Lãi đóng góp = P × (1 − r) − C

Giá sàn = max((C + L) / (1 − r), P_base − D_cap)
Điều kiện: 0 ≤ r < 1; dữ liệu chi phí đầy đủ và hợp lệ.
```

Hệ thống bảo toàn tuyệt đối biên lãi ròng (Net Profit Margin) và lãi đóng góp (Contribution Margin) thông qua cơ chế kiểm soát giá sàn tự động trên máy chủ, ngăn chặn việc AI tự ý chiết khấu lạm vào lợi nhuận tối thiểu $L$.

Đầu vào phải là số hữu hạn, cùng tiền tệ và phạm vi số lượng; P_base > 0, D_cap ≥ 0, L ≥ 0, số lượng > 0. Chi phí âm bất thường hoặc khoản chưa xác định cần người kiểm tra, không tự coi bằng 0.

Làm tròn sàn lên theo đơn vị tiền/giá được phép, không làm tròn xuống. Nếu sàn cao hơn giá cơ sở thì chặn phát hành báo giá/đơn tự động và yêu cầu xem lại giá, chi phí hoặc chính sách; không tự bán ở giá cơ sở dưới sàn. Thiếu dữ liệu hoặc không hợp lệ thì không tự cấp ưu đãi.

Nếu doanh nghiệp chọn tỷ suất lãi đóng góp tối thiểu m trên doanh thu thay cho số tiền L:

```text
Giá tối thiểu theo tỷ suất = C / (1 − r − m)
Chỉ dùng khi 1 − r − m > 0.
```

Không nhầm tỷ suất trên doanh thu với tỷ lệ cộng trên giá vốn: công thức giá vốn × (1 + tỷ lệ) trong PDF là dạng cộng trên chi phí, chưa bảo đảm tỷ suất trên doanh thu và chưa bao phủ mọi chi phí.

Nếu chi phí có bậc, mức sàn/trần, thuế hoặc cơ sở khác P, dùng đúng quy tắc nhà cung cấp thay vì nhét vào r. Không tính cùng một khoản ở cả C và r.

### 4.3. Nguồn ngân sách giảm giá

Giới hạn ngân sách từ tiết kiệm được tính theo kịch bản cơ sở:

```text
Ngân sách từ tiết kiệm
= max(0, chi phí bán hàng thực sự tránh được
         − chi phí phát sinh thêm so với cách bán cơ sở)
```

Chi phí phát sinh thêm gồm các khoản AI, hỗ trợ, đối tác hoặc rủi ro chưa có trong cách bán cơ sở. Các khoản đã có được so phần chênh lệch, không trừ hai lần. Phép tính này giới hạn **nguồn tài trợ ưu đãi**; công thức giá sàn kiểm tra **hiệu quả đơn sau ưu đãi**. Hai phép kiểm phải cùng đạt.

D_cap không vượt ngân sách còn lại và trần chính sách. Nếu bổ sung ngân sách khuyến mãi riêng, ghi rõ đó là khoản đầu tư được duyệt, không gọi là tiết kiệm hoa hồng. Ưu đãi vận chuyển, phiếu và giảm tiền phải cùng đi qua một kiểm tra ngân sách để không cộng dồn ngoài ý muốn.

### 4.4. Ví dụ số để kiểm tra

Giả định cho một đơn: P_base = 1.000.000 đồng; C = 780.000 đồng; r = 2%; L = 120.000 đồng; D_cap = 50.000 đồng.

```text
Sàn theo lãi = (780.000 + 120.000) / 0,98 ≈ 918.367,35 đồng
Sàn theo hạn giảm = 1.000.000 − 50.000 = 950.000 đồng
Giá sàn áp dụng = 950.000 đồng
Lãi đóng góp ở giá sàn = 950.000 × 0,98 − 780.000 = 151.000 đồng
```

Giá 940.000 đồng bị từ chối dù vẫn có thể đạt mức L, vì vượt trần giảm 50.000 đồng. Ví dụ không chứng minh lãi bằng mô hình cũ và không phải đề xuất giá cho sản phẩm thật.

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
