# Mô-đun Chăm sóc khách hàng — Giải quyết vấn đề và giữ niềm tin

[Mục lục](../README.md) · [Hành trình](../customer-lifecycle.md) · [Thuật ngữ](../glossary.md)

Trạng thái: thiết kế đề xuất. P1 có hỏi đáp cơ bản, hướng dẫn giới hạn và bàn giao; các tác vụ đơn hàng, vận chuyển, phiếu bù giá và đổi trả cần kết nối/nghiệm thu sau.

<a id=section-8></a>

## 1. Mục tiêu và ranh giới

Giúp khách dùng sản phẩm thành công, xử lý vấn đề nhất quán và được gặp nhân viên khi cần. Hỗ trợ là một phần của sản phẩm, không phải điểm cuối sau bán (khớp mục tiêu **OBJ-003** và **OBJ-004** trong SRS).

Chăm sóc có thể nhận câu hỏi trước mua. Câu hỏi công dụng chung dùng nguồn đã duyệt; khi khách cần đề xuất thương mại hoặc mua hàng, bàn giao Bán hàng (SAL-02) nếu bật, nếu không thì chuyển nhân viên. Không trì hoãn giải quyết khiếu nại để bán thêm. Mọi hành vi tra cứu phải tuân thủ nguyên tắc cô lập dữ liệu khách hàng (**NFR-006**) và xử lý an toàn thất bại (**NFR-008 - Fail Closed**).

## 2. Hệ thống Agent Chăm sóc & Giữ chân khách hàng (CS-01 & CS-02)

Mô-đun vận hành với 2 Agent chủ lực chịu trách nhiệm xuyên suốt chuỗi hỗ trợ và duy trì quan hệ khách hàng:

### 2.1. CS-01 - Omnichannel Customer Care Agent

Tiếp nhận tương tác đa kênh: Web Chat, Mobile App, mạng xã hội (Facebook, TikTok Shop), Zalo OA, LINE OA, Email và các connector được phê duyệt.

**FR-CS-001 - MUST: Nhận biết tối thiểu 10 nhóm Intent chuẩn:**
1. **Hỏi thông tin sản phẩm (Product Info):** Tính năng, công dụng, thông số kỹ thuật đã kiểm duyệt.
2. **Tra cứu giá & ưu đãi (Price & Promotions):** Bảng giá niêm yết, chính sách khuyến mãi hiện hành.
3. **Kiểm tra tồn kho (Stock Availability):** Khả dụng của SKU tại các kho hoặc cửa hàng gần nhất.
4. **Trạng thái đơn hàng (Order Status):** Xác nhận đơn, đang đóng gói, mã vận đơn, thời gian giao dự kiến.
5. **Giao hàng & vận chuyển (Shipping Tracking):** Định vị đơn, đổi điểm nhận hàng siêu thị tiện lợi (CVS).
6. **Đổi / Trả / Hoàn tiền (Return & Refund):** Quy trình trả hàng, chính sách bảo hành, hoàn tiền.
7. **Xử lý sự cố thanh toán (Payment Issue):** Thanh toán lỗi, trùng lệnh, chưa nhận tiền mặt CVS COD.
8. **Tiếp nhận khiếu nại (Complaint Management):** Hàng lỗi, thái độ phục vụ, sai sót giao vận.
9. **Hướng dẫn sử dụng & kỹ thuật (Usage & Technical Support):** Hướng dẫn kích hoạt, xử lý sự cố cơ bản.
10. **Yêu cầu gặp nhân viên (Human Escalation):** Khách chủ động đòi gặp người thật hoặc vấn đề vượt thẩm quyền.

**FR-CS-002 - MUST: Ma trận định tuyến quyết định của CS-01:**
- **Tự trả lời (AUTH-3):** Đối với câu hỏi FAQ, chính sách công khai đã được duyệt trong `/customer-care/faq.md`.
- **Tra cứu dữ liệu (AUTH-0):** Đọc trạng thái đơn hàng, vận chuyển qua API ERP/WMS sau khi đã xác minh danh tính khách hàng thành công (**TC-E2E-004**).
- **Thực thi hành động giới hạn (AUTH-3):** Cập nhật ghi chú giao hàng, tạo yêu cầu đổi trả theo điều kiện có sẵn.
- **Bàn giao Agent khác:** Chuyển sang Sales (SAL-02/SAL-03) khi khách phát sinh nhu cầu mua sắm mới; chuyển sang CS-02 khi phát hiện tín hiệu cần giữ chân.
- **Chuyển người thật (Human Escalation):** Khiếu nại nghiêm trọng, tranh chấp pháp lý, khách kích động, hoặc hệ thống thiếu dữ liệu xác thực.

### 2.2. CS-02 - Retention / Customer Success Agent

Chủ động phát hiện các nguy cơ rời bỏ hoặc cơ hội mở rộng giá trị vòng đời: khách ngừng tương tác (inactivity), giảm tần suất mua sắm, khách không hài lòng (dissatisfaction), đơn hàng lỗi/hủy (failed order), khiếu nại lặp lại (repeated complaint), cơ hội mua bổ sung (replenishment) và thu hồi khách cũ (win-back).

**FR-CS-003 - MUST: Quy trình vận hành 6 bước chuẩn (Retention Workflow):**
```text
[Signal] (Phát hiện tín hiệu bất thường trên Customer 360 Timeline)
   │
   ▼
[Hypothesis] (Xây dựng giả thuyết nguyên nhân; không ghi đè thành Fact)
   │
   ▼
[Recommended Action] (Đề xuất Next-Best-Action: hỏi thăm, bù giá, ưu đãi cá nhân hóa)
   │
   ▼
[Eligibility Check] (Kiểm tra chính sách, consent, hạn mức ngân sách điểm thưởng)
   │
   ▼
[Execution / Approval] (AUTH-3 tự thực thi nếu trong hạn mức; AUTH-4 trình người duyệt nếu chi phí lớn)
   │
   ▼
[Outcome] (Đo lường phản hồi của khách, tỷ lệ giữ chân và ghi nhận vào Learning Memory)
```

## 3. Hệ thống Quản lý Vụ việc (Case Management State Machine)

Mọi yêu cầu hỗ trợ hoặc khiếu nại đều được theo dõi dưới dạng Case có cấu trúc, vận hành theo State Machine 7 trạng thái chuẩn:

```text
[NEW] ──► [CLASSIFIED] ──► [ASSIGNED] ──► [IN_PROGRESS] ──► [WAITING_CUSTOMER] ──► [RESOLVED] ──► [CLOSED]
                                │               ▲                    │
                                └───────────────┴────────────────────┘
```

### 3.1. Đặc tả 7 trạng thái vòng đời Case
1. **NEW:** Vụ việc mới được khởi tạo từ tin nhắn/yêu cầu của khách qua kênh bất kỳ.
2. **CLASSIFIED:** CS-01 đã phân loại Intent, gắn nhãn mức độ ưu tiên (P1-Khẩn cấp đến P4-Thấp) và liên kết hồ sơ khách hàng.
3. **ASSIGNED:** Hệ thống phân bổ quyền xử lý cho Agent (CS-01/CS-02) hoặc nhân viên hỗ trợ chuyên trách.
4. **IN_PROGRESS:** Đang tích cực tra cứu dữ liệu, hướng dẫn khách hàng hoặc xử lý nghiệp vụ với các bên liên quan.
5. **WAITING_CUSTOMER:** Tạm dừng tính SLA chờ phản hồi hoặc cung cấp thêm thông tin từ phía khách hàng.
6. **RESOLVED:** Đã cung cấp giải pháp hoặc hoàn tất xử lý; chờ xác nhận hài lòng từ khách hàng.
7. **CLOSED:** Khách hàng xác nhận hài lòng hoặc quá thời gian quy định sau giải quyết mà không có khiếu nại thêm.

### 3.2. Cấu trúc dữ liệu Case bắt buộc
Mỗi Case phải lưu trữ tối thiểu các trường dữ liệu:
`Case_Record = { Case_ID, Customer_ID, Intent, Priority, Conversation_ID, Related_Order_ID, Evidence_Refs, Owner_Type (AI/Human), Owner_ID, Status, SLA_Target, Resolution_Summary, Outcome_Metric }`.
Tuyệt đối không đóng Case đơn phương khi chưa có xác nhận hoặc kết quả nhân viên có bằng chứng.

## 4. Năng lực được hợp nhất

| Năng lực | Thực hiện tối thiểu | Giai đoạn |
|---|---|---|
| Hỏi đáp và hướng dẫn | Tìm tài liệu đã duyệt, giải thích có nguồn | P1 |
| Gợi ý câu hỏi theo ngữ cảnh | Vài câu ngắn dựa trên trang/sản phẩm hợp lệ; dữ liệu riêng cần xác minh | P1 nếu giao diện hỗ trợ |
| Tra trạng thái đơn/giao hàng | Kết nối từng hệ thống, hiển thị thời điểm cập nhật | P2 |
| Nút liên hệ người giao | Chỉ hiển thị thông tin nguồn cho phép và người mua có quyền xem | P2 |
| Phiếu hỗ trợ và ưu tiên thời gian | Tạo/cập nhật có xác nhận, bàn giao người nhận | P2 |
| Bù giá bằng phiếu mua lần sau | Chính sách, ngân sách, kiểm tra điều kiện, duyệt/cấp một lần | P2 thử có người duyệt; P3 tự động giới hạn |
| Dùng ảnh/video hỗ trợ xử lý | Nhận tài liệu theo quyền, AI tóm tắt cho nhân viên | P3 xem xét, không tự quyết đổi trả |
| Tín hiệu mua lại/nâng cấp | Ghi nhu cầu thật; Bán hàng chịu trách nhiệm đề nghị thương mại | P1 ghi nhận; tự động mở rộng sau |

Tra cứu hai giai đoạn trong PDF được giữ như phương án: lọc đúng sản phẩm/quyền rồi tìm tài liệu liên quan. Chưa cần thêm hệ thống xếp hạng phức tạp nếu tìm kiếm đơn giản đáp ứng bộ thử; chỉ bổ sung khi đo được khoảng trống chất lượng.

## 5. Chính sách bù giá đề xuất

Mục tiêu là thử giảm lo mua hớ và tăng mua lại; **phiếu mua hàng vẫn có chi phí và nghĩa vụ thực hiện**, không phải tiền miễn phí. Khoảng 14 ngày từ PDF là tham số đề xuất, cần công khai và duyệt trước.

Trước thử nghiệm, phải xác định:

| Quy tắc | Cần chốt |
|---|---|
| Mốc thời gian | Tính từ thanh toán hay giao hàng; múi giờ; cửa sổ phát hiện |
| Tương đương sản phẩm | Mã hàng, biến thể, số lượng, điều kiện bán và loại khuyến mãi |
| Giá so sánh | Giá thực trả sau phân bổ giảm giá với giá đủ điều kiện sau đó; không so các điều kiện khác nhau |
| Điều kiện đơn | Đã xác nhận, chưa hủy/trả; xử lý hoàn một phần và các phiếu đã cấp |
| Hạn mức | Trần mỗi đơn/khách và toàn chương trình; cách xử lý nhiều lần giảm giá |
| Phiếu phát hành | Giá trị, hạn dùng, giá trị đơn tối thiểu, khả năng cộng dồn và cách thông báo |
| Quyền khách hàng | Không dùng phiếu để thay quyền hoàn tiền hoặc cam kết đã có nếu chưa phù hợp chính sách được rà soát |
| Thông báo | Kênh và mục đích được phép; không tự biến thông báo quyền lợi thành quảng cáo |

Luồng: sự kiện giảm giá được xác thực → đối chiếu đơn đủ điều kiện → tính phần chênh lệch theo chính sách → kiểm tra ngân sách → người duyệt hoặc quy tắc đã được bật → cấp phiếu → xác nhận mã → thông báo.

Chống trùng theo doanh nghiệp + đơn/dòng hàng + chương trình + sự kiện giảm giá; đồng thời kiểm soát tổng đã bù để nhiều sự kiện không cấp vượt. Cấp thành công nhưng gửi tin thất bại thì thử lại việc gửi, không cấp phiếu thứ hai. Đơn trả/hủy sau khi cấp cần xử lý theo chính sách, không tự trừ tiền khách.

## 6. Cơ chế Điểm thưởng đổi Phiếu ưu đãi & Vòng lặp khách hàng thân thiết

Thay vì phát phiếu mua hàng tự động liên tục (dễ gây lờn giá, discount fatigue và làm suy giảm định vị sản phẩm), hệ thống áp dụng cơ chế **Điểm thưởng tích lũy (Reward Points)** để khách hàng chủ động quy đổi phiếu theo nỗ lực mua sắm và tương tác.

### 6.1. Nguyên lý hành vi và cấu trúc điểm
1. **Hiệu ứng tiến độ trao sẵn (Endowed Progress Effect)**: Đơn hàng đầu tiên luôn nhận số điểm thưởng lớn nhất (ví dụ: tặng ngay 9/10 điểm để chỉ thiếu 1 điểm là mở khóa phiếu giảm 15–20% + freeship). Đơn đầu tiên **bắt buộc phải đạt giá trị đơn tối thiểu (`Min_Spend_First_Order`)** để chặn hành vi mua món tượng trưng vài nghìn đồng nhằm lấy điểm.
2. **Tích điểm theo giá trị đơn (Dynamic Spend-to-Points)**: Các đơn hàng tiếp theo không cố định điểm số mà tích lũy tỷ lệ thuận theo giá trị đơn thực tế (ví dụ: mỗi 100.000 VNĐ = 1 điểm). Đơn giá hoặc tổng giá trị đơn càng lớn thì điểm thưởng càng nhiều, kích thích khách gom đơn và gia tăng giá trị giỏ hàng (AOV).
3. **Giới hạn trần điểm thưởng (Max Cap Enforcement)**:
   - Cài đặt trần điểm tối đa trên mỗi đơn hàng (`Cap_Max_Points_Per_Order`) và trần ngày (`Cap_Daily`).
   - Công thức tính điểm đơn sau: `Points = min(floor(Order_Value / Spend_Unit), Cap_Max_Points_Per_Order)`.
   - Chặn rủi ro các đơn sỉ, đơn B2B hoặc đại lý gom hàng hưởng điểm vượt trần làm thâm hụt quỹ thưởng.
   - Với ngành hàng giá trị cao (như Xe máy điện): áp dụng bảng quy đổi có mức trần trọn gói (ví dụ trần 50–100 điểm/xe), không nhân lũy tiến vô hạn theo giá trị hàng chục triệu đồng.
4. **Tránh điểm rơi động lực (Tiered Micro-Milestones)**: Sau khi đạt mốc đầu tiên (đơn 2), điểm quay về 0 được dẫn tiếp bằng các mốc thưởng nhỏ hơn dạng bậc thang (3 điểm đổi phiếu 5%, 6 điểm đổi phiếu 10%) để duy trì hưng phấn mua lặp lại.
5. **Hạn sử dụng điểm (Points Expiry)**: Điểm có hạn dùng 6–12 tháng nhằm kích thích chi tiêu định kỳ và ngăn tích lũy nợ nghĩa vụ tài chính kéo dài trên sổ sách kế toán.

### 6.2. Phân loại Phiếu ưu đãi theo ngành hàng & Kiểm soát trần (Voucher Caps)
- **Xe máy điện (Giá trị cao, chu kỳ 3–5 năm)**:
  - **Tuyệt đối KHÔNG áp dụng phiếu giảm %**: Giảm % trên đơn xe hàng chục triệu sẽ làm sụp đổ biên lợi nhuận ròng.
  - **Hình thức áp dụng**: Chỉ phát hành phiếu tiền mặt cố định (500.000đ–1.000.000đ cho đơn đầu; 1.500.000đ–2.000.000đ cho mốc tích lũy lớn) hoặc quy đổi trực tiếp thành gói phụ kiện chính hãng, dịch vụ bảo dưỡng định kỳ (1.000km, 5.000km), gói thuê/đổi pin, hoặc cứu hộ SOS khẩn cấp 24/7.
- **Hàng tiêu dùng (FMCG, chu kỳ lặp ngắn)**:
  - Cho phép phiếu giảm %: Đơn đầu từ 10%–15%; phiếu mở khóa theo mốc tích lũy 1 lần (1-time milestone) tối đa từ 20%–30%.
  - **Kiểm soát trần (Không thả nổi không giới hạn)**: Để tránh trường hợp đại lý/tạp hóa gom hàng sỉ, hệ thống cài đặt trần mềm qua **Trần độ lớn giỏ hàng (Basket Cap tối đa 1.000.000đ–2.000.000đ được hưởng % ưu đãi)** hoặc **Trần số lượng sản phẩm (tối đa 3–5 món/đơn)** hoặc trần tiền mặt quy đổi tối đa (200.000đ–500.000đ).
  - **Khóa cứng giá sàn $P_{floor}$**: Toàn bộ giỏ hàng sau khi áp dụng phiếu ưu đãi phải thỏa mãn giá sàn máy chủ để bảo toàn biên lợi nhuận tối thiểu.

### 6.3. Kiểm soát rủi ro và chống gian lận tạo tài khoản mới (Anti-Sybil & Anti-Exploit)
- **Bộ tứ định danh chống lập acc mới (Anti-Clone Accounts)**:
  1. **SĐT/LINE ID xác thực OTP**: Xác thực qua LINE OA hoặc SMS; mỗi định danh thực chỉ được nhận ưu đãi chào mừng đơn đầu đúng 1 lần.
  2. **Vân tay thiết bị (Device Fingerprint)**: Nhận diện mã thiết bị/trình duyệt theo chuẩn Taiwan PDPA (thông báo đồng thuận rõ ràng), chặn việc mở trình duyệt ẩn danh để tạo tài khoản mới.
  3. **Dấu vết thanh toán & Lịch sử nhận hàng Siêu thị (CVS History)**: Lưu vết mã băm thanh toán (LINE Pay / Thẻ); đồng thời lưu vết SĐT/lịch sử nhận hàng tại 7-Eleven/FamilyMart. Khách có tiền sử bùng hàng quá 7 ngày (未取貨) sẽ bị hệ thống tự động khóa quyền áp dụng trợ cấp giá.
  4. **Đối soát địa chỉ & Mã bưu chính Đài Loan (Fuzzy Address Matching)**: Quét trùng lặp địa chỉ nhận hàng và tên người nhận để ngăn gom ưu đãi về cùng một địa chỉ.
- **Kiểm soát điều kiện kép (Min Spend & Max Cap)**: Đơn nhận điểm đầu tiên phải đạt `Min_Spend_First_Order`; các đơn sau vừa có điều kiện giá trị tối thiểu vừa bị chặn trần `Max_Cap` điểm.
- **Thu hồi điểm khi hủy/trả hàng**: Khi đơn hàng bị hoàn tiền hoặc hủy, hệ thống tự động thu hồi điểm tương ứng qua sự kiện `loyalty.points_revoked`.
- **Trần ngân sách điểm thưởng**: Bộ phận tài chính duyệt tỷ lệ trích tối đa từ biên lợi nhuận cho quỹ điểm thưởng; hệ thống tự ngắt phát hành điểm thưởng nếu vượt hạn mức ngân sách chương trình.

### 6.4. Vòng lặp hệ sinh thái thực tế tại thị trường Đài Loan
- **Xe máy điện (High-Ticket EV)**:
  - **Chương trình giới thiệu hai chiều (Dual-Sided Referral kiểu Tesla)**: Khách đã mua xe được cấp mã giới thiệu trên LINE OA. Khi bạn bè quét mã đặt cọc lái thử và mua xe thành công: Người giới thiệu nhận 1–3 tháng miễn phí gói thuê/đổi pin (BaaS) hoặc credit bảo dưỡng; người mua mới được tặng phụ kiện chính hãng hoặc voucher trừ thẳng vào tiền cọc.
  - **Chăm sóc vòng đời bảo dưỡng**: AI CSKH trên LINE OA tự động gửi tin nhắc bảo dưỡng định kỳ theo số km ước tính (1.000km, 5.000km, 10.000km) và thông báo tình trạng trạm đổi pin mới mở gần nhà khách.
- **Hàng tiêu dùng (FMCG)**:
  - **Tích điểm đổi LINE Points**: Khách mua hàng tích lũy điểm thưởng quy đổi trực tiếp thành điểm **LINE Points** (chi tiêu được tại hầu hết các chuỗi siêu thị/cửa hàng tiện lợi Đài Loan), tăng tính hấp dẫn thực tế vượt trội so với điểm thưởng nội bộ.
  - **Nhắc nhở đơn hàng định kỳ (Predictive Replenishment)**: AI CSKH dự báo ngày sắp hết hàng tiêu dùng, gửi tin nhắn 1-chạm qua LINE để khách tái đặt hàng giao đến 7-Eleven quen thuộc.

## 7. Khiếu nại và bàn giao khẩn

Các tín hiệu bảo mật, an toàn, tranh chấp nghiêm trọng, lặp lỗi hoặc khách yêu cầu người thật cần chuyển người có trách nhiệm. Từ khóa chỉ là một tín hiệu, không phải bộ phân loại đáng tin duy nhất.

Mục tiêu gọi lại dưới hai phút của PDF chỉ là **mục tiêu thử nghiệm khi có nhân sự trực và điều kiện đáp ứng**, không phải lời hứa 24/7. Chưa có người nhận thì thông báo đang chờ và thời gian dự kiến được cấu hình.

Gói bàn giao chứa khách đã xác minh, vấn đề, kết quả mong muốn, đơn/sản phẩm liên quan, nguồn, bước đã thử, mức ảnh hưởng và hành động tiếp theo. Nhân viên nhận trách nhiệm thì AI ngừng trả lời nghiệp vụ. Thời hạn chờ phải có người theo dõi; hết hạn không tự đánh dấu giải quyết.

## 8. Phản hồi để cải tiến

Tổng hợp câu hỏi lặp lại, lý do không phù hợp, lỗi dùng, khiếu nại và đổi trả thành đề xuất sửa tài liệu, sản phẩm hoặc thông điệp. Dữ liệu gửi sang Tiếp thị cần tối thiểu hóa, ưu tiên tổng hợp và không lộ danh tính ngoài quyền.

Khách dùng tốt có thể được mời đánh giá, mua lại hoặc giới thiệu khi phù hợp; không yêu cầu đánh giá tích cực để được giải quyết quyền lợi. AI không tự xuất bản lời chứng thực hay sửa kho kiến thức.

## 9. Tiêu chí nghiệm thu & Chỉ số đo lường

### 9.1. Bảng kiểm tra nghiệm thu (Acceptance Criteria)

| Tình huống | Kết quả bắt buộc | Mã kiểm thử SRS |
|---|---|---|
| Câu hỏi chung (FAQ, tính năng) | Trả lời từ tài liệu đúng phiên bản; không ép khai số điện thoại | PILOT-03 |
| Khách chưa xác minh hỏi đơn hàng | Tuyệt đối không tiết lộ dữ liệu riêng; yêu cầu OTP/đăng nhập | TC-E2E-004, NFR-006 |
| Khách hợp lệ tra cứu đơn hàng | Gọi API ERP/WMS lấy trạng thái thực; hiển thị thời gian đối soát | PILOT-03, FR-CS-001 |
| Thiếu nguồn, mâu thuẫn hoặc rủi ro | Bàn giao hàng đợi nhân viên kèm ngữ cảnh; không suy đoán bịa đặt | PILOT-04, NFR-008 |
| Vụ việc đang xử lý | Khách chưa xác nhận thì giữ WAITING/IN_PROGRESS; không tự đóng | FR-CS-002 |
| Vụ việc mở lại (Reopen) | Liên kết đúng Case ID cũ, bảo toàn lịch sử và evidence | Quản lý Case |
| Lỗi mạng khi tạo phiếu hỗ trợ | Đối soát bằng Idempotency key; không sinh nhiều phiếu trùng lặp | NFR-003, TC-E2E-005 |
| Khách yêu cầu gặp người thật | Bàn giao ngay cho nhân viên trực; AI dừng trả lời nghiệp vụ | NFR-007 |
| Thử bù giá tự động | Đơn không đủ điều kiện hoặc hết ngân sách bị chặn; không cấp trùng | BR-002, BR-007 |
| Hệ thống điểm thưởng | Chặn đơn dưới mức sàn (Min Spend); tự thu hồi điểm khi đơn hủy/trả | Chống gian lận |
| Mô-đun CSKH chưa bật | Trả trạng thái không hỗ trợ hoặc chuyển hàng đợi người xử lý | Lộ trình P1 |
| Khiếu nại vượt thẩm quyền | Chuyển luồng bàn giao khẩn cấp; ghi vết audit đầy đủ | PILOT-04, AUTH-4 |

### 9.2. Hệ chỉ số KPI Chăm sóc & Thành công khách hàng theo SRS

- **Chăm sóc khách hàng (Customer Care KPIs):**
  - **First Response Time (FRT):** Thời gian phản hồi lần đầu (thiết kế gần thời gian thực qua Web/App/LINE).
  - **Resolution Time:** Thời gian trung bình từ khi tạo Case đến khi trạng thái chuyển sang RESOLVED.
  - **AI Resolution Rate:** Tỷ lệ vụ việc AI giải quyết tự động thành công mà không cần can thiệp của con người.
  - **Escalation Rate:** Tỷ lệ vụ việc phải chuyển giao cho nhân viên trực tiếp xử lý.
  - **Reopen Rate:** Tỷ lệ khách hàng khiếu nại lại hoặc mở lại vụ việc sau khi đã thông báo giải quyết.
  - **Customer Satisfaction (CSAT):** Điểm số hài lòng của khách hàng đánh giá sau khi đóng Case.
- **Giữ chân khách hàng (Customer Success / Retention KPIs):**
  - **Repeat Purchase Rate:** Tỷ lệ khách hàng mua lại định kỳ nhờ CS-02 kích hoạt lời nhắc hoặc gói bổ sung.
  - **Retention & Churn Rate:** Tỷ lệ giữ chân khách hàng và mức giảm tỷ lệ khách hàng rời bỏ.
  - **Reactivation Rate:** Tỷ lệ thu hồi và kích hoạt lại thành công khách hàng ngủ quên (dormant/win-back).
  - **Customer Lifetime Value (CLV):** Giá trị vòng đời khách hàng gia tăng xuyên suốt chuỗi dịch vụ.

Mọi thao tác hoàn tiền, hủy, đổi trả hoặc thay tài khoản phải qua người có quyền và hệ thống nguồn; không nằm trong P1.
