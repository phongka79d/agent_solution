# AgentOS — Bản Kế Hoạch Triển Khai Đọc Trong 5 Phút
## HỆ THỐNG 3 TRỢ LÝ AI CẮM-RÚT (PLUG & PLAY) CHO WEBSITE DOANH NGHIỆP CÓ SẴN

Bắt đầu bằng câu hỏi: **Doanh nghiệp nào sẽ thử nghiệm, trên website nào, để giải quyết một vấn đề mua hàng cụ thể?**

[Mục lục](README.md) · [Thuật ngữ](glossary.md) · [Bản đầu và lộ trình](delivery/mvp-and-roadmap.md) · [Đặc tả kỹ thuật SRS](../presentation/tech_spec.html)

Đây là bản kế hoạch hành động thực tế, kết hợp hài hòa giữa **tính khả thi triển khai từng bước nhỏ** và **khung kiểm soát rủi ro kỹ thuật cấp doanh nghiệp (AI-REV-SRS-001)**.

---

## 1. Sản phẩm làm gì? [OBJ-001 đến OBJ-004]

Hệ thống được đóng gói thành **3 Mô-đun Trợ lý AI Cắm-Rút (Plug & Play)** cài trực tiếp vào Website hoặc App sẵn có của doanh nghiệp:

| Mô-đun Trợ lý | Mã mục tiêu SRS | Việc chính trên Website | Giới hạn an toàn (Code cứng chặn đứng) |
|---|---|---|---|
| **Chăm sóc khách hàng (Care)** | **OBJ-003** & **OBJ-004** | Trực chat 24/7 góc màn hình web, giải đáp FAQ, tra cứu vận đơn, chính sách đổi trả, kết nối nhân viên | **Cấm tự ý duyệt hoàn tiền/bồi thường** (`AUTH-4`/`BR-007`); bắt buộc xác minh đúng chủ đơn (`NFR-006`) |
| **Tư vấn Bán hàng (Sales)** | **OBJ-002** | Nút "Tư vấn chọn nhanh", gợi ý combo mua kèm, nhắc phục hồi giỏ hàng bỏ quên | **Cấm tự bịa giá hay bán dưới giá sàn $P_{floor}$** (`BR-001..003`); gợi ý phải đủ 7 trường minh bạch (`FR-SAL-003`) |
| **Tiếp thị (Marketing)** | **OBJ-001** | Quét nhu cầu thị trường, tạo nội dung giới thiệu, thu hút khách tiềm năng về web | **Cấm thu gom dữ liệu trái phép** (`BR-004`); khách từ chối nhận tin là dừng ngay (`suppression rule`) |

> 🔑 **Nguyên tắc "Cắm là chạy" & Zero-Disruption (Không làm đảo lộn hệ thống cũ):**  
> * Doanh nghiệp **giữ nguyên 100% Website, Landing Page, cơ sở dữ liệu và phần mềm ERP/POS hiện tại**. AI chỉ nhúng vào như một tiện ích (Widget/Script) hoặc cổng kết nối (Webhook).
> * Doanh nghiệp có toàn quyền **bật/tắt độc lập từng mô-đun**: Thích giải phóng trực ca đêm thì bật riêng **CSKH**; muốn tăng doanh thu thì bật thêm **Bán hàng**; cần kéo khách thì mở thêm **Tiếp thị**.
> * **Không phải 3 Chatbot rời rạc [OBJ-005, OBJ-006]:** Dù cài độc lập, bên dưới cả 3 mô-đun đều kết nối chung một bộ não **Revenue Orchestrator**, dùng chung hồ sơ khách **Customer 360**, chung tri thức nội bộ và tuân thủ chặt chẽ khung phân quyền `AUTH-0..5`.

---

## 2. Hành trình mua sắm hợp nhất [OBJ-001 đến OBJ-005]

```text
Hiểu vấn đề khách đang hoặc sắp gặp [OBJ-001 Tiếp thị]
→ Tìm tín hiệu sớm và nơi khách tập trung [OBJ-001 Tiếp thị]
→ Khách vào Website quen thuộc qua link đối tác / tìm kiếm / bài viết
→ Khung tư vấn AI xuất hiện, gợi ý đúng nhu cầu kèm bằng chứng thật [OBJ-002 Bán hàng]
→ Khách chốt đơn qua quy trình giỏ hàng có sẵn của website [OBJ-002 Bán hàng]
→ Hệ thống ERP/POS gốc xác nhận giao dịch & trừ tồn kho thực tế
→ AI tự động hướng dẫn sử dụng và cập nhật tiến độ đơn hàng [OBJ-003 CSKH]
→ Khách dùng hài lòng, AI phát hiện nhu cầu mua lại/giới thiệu [OBJ-004 Thành công]
→ Kết quả thực tế quay về vòng lặp học hỏi để hoàn thiện dịch vụ [OBJ-005, OBJ-006 Học hỏi]
```

*Đây không phải quy trình bắt buộc cứng nhắc:* Khách muốn mua ngay có thể vào thẳng Bán hàng; khách gặp vấn đề bảo hành vào thẳng CSKH.

---

## 3. Khác biệt đáng thử & Khung bảo vệ kinh tế

| Ý tưởng kinh doanh thực chiến | Giá trị mong muốn | Giải pháp triển khai & Chốt chặn kỹ thuật |
|---|---|---|
| **Tiếp cận trước khi nhu cầu đạt đỉnh** | Xuất hiện đúng lúc, giảm phụ thuộc đốt tiền quảng cáo | Nhân viên duyệt danh sách đối tác giới thiệu và bản đồ nhu cầu; chỉ gửi link khi khách chủ động bấm xem. |
| **Giải thích thông số bằng tiếng đời thường** | Giúp khách hiểu ngay, không bị ngợp thông tin | Viết sẵn nội dung chuẩn vào kho tri thức (`/product/products.md`), cấm AI tự chém gió sai sự thật. |
| **Chọn nhanh bằng 3 câu hỏi trắc nghiệm** | Giảm gõ phím trên điện thoại, tăng tỷ lệ mua | Hỏi nhanh: Nhu cầu là gì? Dùng ở đâu? Tầm ngân sách bao nhiêu? Cho phép bấm "Bỏ qua". |
| **Gợi ý “chưa cần mua món đắt hơn”** | Tạo dựng niềm tin tuyệt đối, giảm tỷ lệ đổi trả | Ưu tiên phương án vừa đủ dùng; chỉ gợi ý nâng cấp khi có bằng chứng tương thích rõ ràng. |
| **Ưu đãi có giới hạn kinh tế & Khóa giá sàn** | Khách được giảm giá thực tế mà công ty không bị lỗ | **Thuật toán Khóa Giá Sàn Toán Học ($P_{floor}$):**<br>$$P_{floor} = \max\left(\frac{\text{Giá\_vốn} + \text{Lãi\_tối\_thiểu}}{1 - \text{Phí\_thanh\_toán}}, P_{base} - D_{cap}\right)$$Chạy bằng code logic cứng ngoài LLM (Deterministic Engine); phát hành Token giữ giá 10 phút, ngăn chặn 100% việc AI bị hack giá. |
| **Gợi ý có bằng chứng (7 trường chuẩn)** | Chống ảo giác (Anti-hallucination), minh bạch | Gợi ý sản phẩm bắt buộc đóng gói đủ 7 trường (`FR-SAL-003`): Khách hàng, Sản phẩm, Lý do, Bằng chứng, Điều kiện đủ, Độ tin cậy và Dự phóng kết quả. |
| **Phản hồi sau mua quay về cải tiến** | Giải quyết tận gốc vấn đề thay vì chỉ đếm số tin | Tự động gom lý do trả hàng, câu hỏi hay gặp để chuyển sang màn hình Quản trị (`SCR-003`). |

---

## 4. Khách hàng và Doanh nghiệp trải nghiệm thế nào?

1. **Giao diện thân quen:** Khách vẫn lướt website hiện tại của doanh nghiệp, không cần tải app mới hay chuyển sang ứng dụng lạ.
2. **Tôn trọng quyền riêng tư (Taiwan PDPA / Việt Nam):** AI chỉ hỏi những thông tin cần thiết để giải quyết việc trước mắt. Số điện thoại giao hàng **tuyệt đối không tự động biến thành quyền gửi tin rác tiếp thị**.
3. **Phân định rõ rệt giữa Bằng chứng và Suy đoán (`FR-C360-003`):**  
   Hệ thống tách biệt rạch ròi:
   * **FACT (Sự thật):** Dữ liệu thực lấy từ ERP/POS (đã thanh toán chưa, kho còn bao nhiêu).
   * **SIGNAL (Tín hiệu):** Hành vi xem hàng, thêm vào giỏ.
   * **HYPOTHESIS (Giả thuyết AI):** Phỏng đoán sở thích (tuyệt đối không được ghi ngược thành Fact).
4. **Quy tắc Duyệt người thật (Human-in-the-Loop - `AUTH-4`):**  
   Khi khách yêu cầu hoàn tiền, khiếu nại gay gắt hoặc đề xuất chiết khấu đặc biệt, AI sẽ dừng ngay và bắn thông báo khẩn sang màn hình Điều hành (`SCR-005`) để nhân viên tiếp quản trong vòng $\le 1.0$ giây.

---

## 5. Vì sao khách không phải kể lại từ đầu? [OBJ-005, OBJ-006]

* **Hồ sơ Customer 360 dùng chung:** Khi khách chat với AI CSKH về đơn hàng, nếu chuyển sang hỏi mua thêm sản phẩm, AI Bán hàng đã nắm sẵn ngữ cảnh (đang quan tâm món gì, vừa giao hàng đến đâu), không bắt khách trả lời lại từ đầu.
* **Nguyên tắc "Một người phát ngôn":** Tại một thời điểm, chỉ có một bên trao đổi với khách (hoặc AI hoặc nhân viên). Bàn giao phải có tóm tắt nội dung và trạng thái rõ ràng.
* **Cô lập ngữ cảnh tuyệt đối (NFR-006):** Dữ liệu của Khách A không bao giờ bị lộ sang Khách B; dữ liệu Doanh nghiệp A tuyệt đối không lẫn vào Doanh nghiệp B.

---

## 6. Lộ trình triển khai: Làm nhỏ trước, mở rộng sau (Gate P0 đến P3)

Thực hiện chuẩn chỉ theo 4 giai đoạn an toàn:

| Giai đoạn | Tên cổng | Việc làm ngay (Thực tế, rủi ro thấp) | Kết quả nghiệm thu |
|:---:|:---|---|---|
| **P0** | **Nền tảng (Foundation)** | Kết nối API đọc sản phẩm/tồn kho từ ERP/Web có sẵn; cài đặt bộ luật giá sàn $P_{floor}$ và quyền hạn `AUTH-0..5`. | Kết nối thông suốt, dữ liệu đọc chuẩn xác. |
| **P1** | **Thử nghiệm CSKH (Care Pilot)** | Nhúng khung chat hỗ trợ tra cứu đơn hàng, giải đáp thắc mắc thường gặp 24/7, nút chuyển nhân viên. | Giảm 60-80% khối lượng trực chat ca đêm; rủi ro tài chính = 0. |
| **P2** | **Thử nghiệm Bán hàng (Sales Pilot)** | Mở tính năng "Tư vấn chọn nhanh", gợi ý combo mua kèm và nhắc giỏ hàng bỏ quên theo hợp đồng 7 trường. | Tăng tỷ lệ hoàn tất đơn hàng, biên lãi an toàn. |
| **P3** | **Thử nghiệm Tiếp thị (Marketing)** | Tự động tạo nội dung chia sẻ, thu hút khách quan tâm từ mạng xã hội dẫn link về website. | Giảm chi phí quảng cáo (CAC), thêm khách mới. |

---

## 7. Tiêu chuẩn nghiệm thu 10 Điểm Vàng (Definition of Done - DoD)

Dự án tuyệt đối không được coi là xong chỉ vì "con bot biết nói chuyện qua lại". Một tính năng chỉ được bàn giao khi đạt chuẩn **10 Tiêu chuẩn Vàng**:

$$\textbf{Data thật} + \textbf{Agent thật} + \textbf{Skill thật} + \textbf{Tool thật} + \textbf{Policy thật} + \textbf{Approval thật} + \textbf{Execution thật} + \textbf{Evidence thật} + \textbf{Outcome thật} + \textbf{Test thật}$$

* **Thước đo cốt lõi:** Không chỉ đo số lượt nhắn tin, mà đo trực tiếp: **Khách có chọn đúng sản phẩm không? Tỷ lệ chuyển đổi đơn có tăng không? Chi phí vận hành có giảm không? Và biên lãi ròng thực thu có được bảo vệ 100% không?**

---
*Hồ sơ kỹ thuật chi tiết: Xem thêm tại [Kế hoạch triển khai tổng thể](../KE_HOACH_TRIEN_KHAI_HE_THONG_AI_AGENT_SRS_001.md) và [Báo cáo gửi Sếp](../BAO_CAO_TONG_QUAN_CHO_SEP_AI_BRIEF.md).*
