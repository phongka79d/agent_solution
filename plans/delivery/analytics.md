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
| `ai.usage.recorded` | Lượng dùng và chi phí AI thực, tiền tệ và độ bao phủ |

Chống trùng theo doanh nghiệp + nguồn + mã sự kiện; đếm đơn/vụ việc/cơ hội theo mã chuẩn, không theo số lần thông báo. Sửa dữ liệu phải có bản điều chỉnh truy vết, không xóa lịch sử sự kiện để làm đẹp số.

## 3. Từ điển chỉ số

Chốt múi giờ, khoảng báo cáo dạng [bắt đầu, kết thúc), nhóm quan sát và thời hạn theo dõi trước thử. Với chỉ số chuyển đổi, tử số phải thuộc đúng nhóm mẫu của mẫu số; kết quả đến sau được ghi theo cửa sổ quan sát đã chốt.

| Chỉ số | Công thức / quy tắc |
|---|---|
| Hoàn thành tìm hiểu nhu cầu | Số yêu cầu hoàn tất trong nhóm bắt đầu đủ điều kiện / số yêu cầu bắt đầu của nhóm đó; công bố số còn chờ |
| Khách đủ điều kiện | Khách được Bán hàng xác nhận / khách quan tâm cùng nhóm; không dùng điểm thay xác nhận |
| Chuyển đổi B2C | Đơn hoặc khách mua được nguồn xác nhận / phiên hoặc khách đủ điều kiện trong cùng nhóm; chọn một mẫu số, ghi rõ đo đặt đơn hay trả tiền |
| Chuyển đổi cơ hội B2B | Cơ hội thành công / cơ hội đóng trong kỳ; cơ hội mở báo riêng |
| Chuyển đổi đặt lịch | Đề nghị lịch có đặt thành công trong thời hạn / đề nghị đủ điều kiện của cùng nhóm; chốt cách xử lý đề nghị lặp |
| Tỷ lệ AI tự giải quyết | Vụ đóng có xác nhận và không cần người giải quyết / vụ đủ điều kiện đã đóng; công bố số mở, chờ và mở lại |
| Tỷ lệ chuyển người | Vụ đã bàn giao trong hạn quan sát / vụ đủ điều kiện mở trong nhóm; phân biệt chờ nhận và đã nhận |
| Thời gian phản hồi | Từ tin đến tới phản hồi đã giao đầu tiên; báo trung vị, phân vị 95 và số mẫu |
| Mức hài lòng | Điểm người trả lời đánh giá; công bố tỷ lệ phản hồi, không coi người im lặng là hài lòng |
| Chi phí AI/công việc | Tổng chi phí AI ghi nhận / số công việc cùng phạm vi; báo độ bao phủ, cộng riêng chi phí nhân sự/hạ tầng |
| Chi phí mỗi khách quan tâm (CPL) | Chi phí chiến dịch được quy thuộc / khách quan tâm hợp lệ cùng phạm vi |
| Chi phí thu hút khách (CAC) | Chi phí thu hút đã thống nhất, gồm đối tác khi có / khách mua mới cùng nhóm |
| Hiệu suất chi quảng cáo (ROAS) | Doanh thu quy thuộc / chi quảng cáo; không phải lợi nhuận hoặc tác động nhân quả |
| Giá trị đơn trung bình (AOV) | Doanh thu đơn theo cách tính đã chốt / số đơn hợp lệ; nêu điều chỉnh hủy/hoàn |
| Mua lại | Khách có lần mua hợp lệ tiếp theo trong cửa sổ / khách của nhóm đã có đủ thời gian quan sát |
| Giới thiệu | Khách mua mới hợp lệ từ giới thiệu / lượt giới thiệu hợp lệ, hoặc trên khách được mời; ghi rõ mẫu số |
| Giá trị vòng đời (LTV) | Giá trị thực nhận theo nhóm; dự báo phải gắn nhãn ước tính, kỳ và giả định |
| Doanh thu có AI tham gia | Tổng đơn hợp lệ có tương tác AI đủ điều kiện trước mua trong cửa sổ đã chốt; loại trùng và điều chỉnh theo chính sách |

Vụ mở lại chỉ trở về mẫu số giải quyết khi đóng cuối cùng; nếu người đã tham gia giải quyết thì không xếp “AI tự giải quyết”. Đếm mỗi vụ một kết quả cuối tại thời điểm chốt và công bố riêng tỷ lệ mở lại để tránh làm đẹp số bằng đóng sớm.

Không cộng tiền khác loại tiền tệ. Báo riêng hoặc dùng tỷ giá đã lưu với nguồn/thời điểm. Doanh thu “có AI tham gia” là ghi nhận liên quan, **không chứng minh AI tạo thêm doanh thu**.

Tương tác AI đủ điều kiện phải được định nghĩa trước: chẳng hạn khách nhận tư vấn sản phẩm có nội dung liên quan tới lần mua. Loại lời chào tự bật, lượt tải khung chat và tương tác sau mua. Lưu mã tương tác, khách/phiên đã liên kết hợp lệ, thời điểm và bằng chứng liên quan; đếm mỗi mã đơn chuẩn một lần trong doanh nghiệp. Cửa sổ quy thuộc và cách xử lý nhiều nguồn phải được chủ chỉ số duyệt; nguồn/định danh thiếu thì không tự quy thuộc. Báo riêng doanh thu gộp hay sau hủy/hoàn theo chính sách đã chốt.

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
| C | Chi phí theo đơn không tính theo tỷ lệ P: giá vốn, xử lý, AI, chi phí giao hàng sau khi trừ phí vận chuyển thu riêng, dự phòng đổi trả/phiếu mua hàng và chi phí khác đã xác định |
| r | Tổng tỷ lệ chi phí thực sự tính trên P, ví dụ phí thanh toán/hoa hồng đối tác nếu hợp đồng dùng đúng cơ sở này |
| L | Lãi đóng góp tối thiểu yêu cầu, số tiền trên đơn |
| P_base | Giá sản phẩm cơ sở hiện hành trên cùng phạm vi đơn, chưa thuế và chưa gồm phí vận chuyển thu riêng |
| D | Tổng giảm tiền trực tiếp so với P_base, gồm các mã giảm giá được kết hợp; không chỉ phần AI vừa đề xuất |
| D_cap | Hạn mức giảm tiền của đơn đã được người có quyền duyệt |

```text
P = P_base − D; 0 ≤ D ≤ D_cap
Lãi đóng góp = P × (1 − r) − C

Giá sàn = max((C + L) / (1 − r), P_base − D_cap)
Điều kiện: 0 ≤ r < 1; dữ liệu chi phí đầy đủ và hợp lệ.
```

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
