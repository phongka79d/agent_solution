# BÁO CÁO ĐIỀU HÀNH DỰ ÁN: BỘ 3 TRỢ LÝ AI AGENT CẮM-RÚT (PLUG & PLAY)
## TÍCH HỢP TRỰC TIẾP VÀO WEBSITE CÓ SẴN CỦA DOANH NGHIỆP: MARKETING — SALES — CSKH
### BẢN BÁO CÁO TÓM TẮT DÀNH CHO LÃNH ĐẠO (ĐỌC TRONG 3 PHÚT HOẶC NẠP VÀO AI TÓM TẮT)

> **Căn cứ đề bài:** `AI-REV-SRS-001` (Hệ thống AI Agent Doanh thu & Tương tác khách hàng)  
> **Thời gian đọc trực tiếp:** ~3-5 phút | **Độ tương thích AI Ingest:** 100% (NotebookLM, ChatGPT, Claude, Gemini)  
> **Thông điệp cốt lõi gửi Sếp:** Hệ thống **KHÔNG PHẢI một khối phần mềm nguyên khối cồng kềnh** bắt doanh nghiệp phải thay đổi hệ thống cũ, mà được đóng gói thành **Bộ 3 Mô-đun AI Agent Cắm-Rút (Plug-and-Play)**. Doanh nghiệp đã có sẵn Website/App và ERP/POS chỉ cần **nhúng mã hoặc cài plugin** là dùng được ngay, có thể mua lẻ từng con hoặc kết hợp cả ba.

---

## ⚡ 1. EXECUTIVE SUMMARY (NẮM BẮT TRONG 30 GIÂY)

* **Thực trạng doanh nghiệp:** Đã có Website bán hàng (WordPress, Shopify, Haravan hoặc Web tự code) và phần mềm quản lý (ERP/POS), nhưng đang gặp 3 điểm nghẽn:
  1. *Ca đêm & Cuối tuần (22h - 06h):* Khách nhắn tin hỏi mua hoặc hỏi đơn hàng thì không có nhân sự trực, tỷ lệ bỏ rơi giỏ hàng cao.
  2. *Tư vấn bán hàng thụ động:* Website hiện tại chỉ là trang trưng bày tĩnh, khách vào xem rồi thoát ra chứ không có người chủ động chào hỏi, tư vấn combo hay gợi ý sản phẩm phù hợp.
  3. *Tốn chi phí nhân sự:* Thuê nhân viên trực chat 3 ca tốn kém nhưng chất lượng tư vấn không đồng đều, hay quên giá và dễ sai sót chính sách.
* **Giải pháp đột phá:** Cung cấp **3 Trợ lý AI Agent độc lập cài đặt trực tiếp vào Website có sẵn**:
  * 🟢 **Module 1 - AI CSKH (Customer Care):** Nhúng khung chat hỗ trợ 24/7, tự tra cứu đơn hàng, giải đáp chính sách, xử lý khiếu nại.
  * 🔵 **Module 2 - AI Bán hàng (Sales Advisor):** Nút tư vấn 1-1 tại trang sản phẩm, hỏi nhu cầu, gợi ý combo, chốt đơn, phục hồi giỏ hàng bỏ quên.
  * 🟣 **Module 3 - AI Tiếp thị (Marketing):** Tự động tạo nội dung quảng cáo, thu hút khách tiềm năng từ mạng xã hội dẫn link về Web.
* **Cam kết kỹ thuật sống còn: Zero-Disruption & Khóa Giá Cứng**
  * **Không đụng chạm code lõi:** Giữ nguyên 100% Website, Database và ERP hiện có (ERP tiếp tục là System of Record duy nhất).
  * **Không bao giờ bán phá giá:** Giá và tồn kho đọc trực tiếp từ ERP. Thuật toán khóa cứng giá sàn $P_{floor}$ chạy bằng code ngoài AI, triệt tiêu 100% nguy cơ khách "lừa" AI giảm giá.
  * **Con người làm chủ (`AUTH-4`):** Mọi hành động hoàn tiền, đổi trả lớn bắt buộc Quản lý bấm duyệt trên màn hình điều hành.

---

## 🧩 2. CHI TIẾT 3 TRỢ LÝ AI CẮM-RÚT VÀO WEBSITE CÓ SẴN

```text
       DOANH NGHIỆP ĐÃ CÓ SẴN: Website (WordPress, Shopify, Web tự code...) + ERP / POS
                                     │
               ┌─────────────────────┴─────────────────────┐
               │  CÀI ĐẶT NHÚNG 1 ĐOẠN MÃ (SCRIPT WIDGET)  │
               └─────────────────────┬─────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│ MODULE 1: CARE  │         │ MODULE 2: SALES │         │ MODULE 3: MKT   │
│ (Trợ lý CSKH)   │         │ (Trợ lý Bán Hàng│         │ (Trợ lý Tiếp Thị│
├─────────────────┤         ├─────────────────┤         ├─────────────────┤
│• Nhúng khung    │         │• Nút "Tư vấn"   │         │• Tự sinh bài    │
│  chat góc Web   │         │  ở trang SP     │         │  quảng cáo MXH  │
│• Tra cứu đơn    │         │• Gợi ý combo giỏ│         │• Kéo khách từ   │
│  hàng tức thì   │         │• Cứu giỏ bỏ quên│         │  Facebook về Web│
│• Bật/Tắt riêng  │         │• Bật/Tắt riêng  │         │• Bật/Tắt riêng  │
└─────────────────┘         └─────────────────┘         └─────────────────┘
```

### 🟢 Module 1: Trợ lý AI Chăm Sóc Khách Hàng (Customer Care - `CS-01`)
* **Hình thức trên Web:** Khung Chat Widget thông minh nằm ở góc phải chân trang Website (hoặc tích hợp Fanpage/Zalo).
* **Khả năng giải quyết:**
  * Khách chỉ cần gõ số điện thoại hoặc mã đơn $\rightarrow$ AI tự kết nối ERP/Hệ thống vận chuyển để báo chính xác: *"Đơn hàng #1024 của anh đang được giao, dự kiến tới nơi chiều nay ạ!"*.
  * Tự động trả lời 80% câu hỏi về quy định đổi trả, phí ship, vị trí cửa hàng, cách sử dụng sản phẩm.
  * Quản lý sự cố theo chu trình chuẩn 7 bước (Case Management FSM): Gặp khách tức giận $\rightarrow$ AI xoa dịu trong $< 2$ giây và kích hoạt chuông báo cho nhân viên hỗ trợ.
* **Đặc tính kinh doanh:** **Rủi ro bằng 0, dễ bán nhất** vì doanh nghiệp thấy ngay hiệu quả cắt giảm ca trực đêm.

### 🔵 Module 2: Trợ lý AI Tư Vấn Bán Hàng 1-1 (Sales Advisor - `SAL-01..05`)
* **Hình thức trên Web:** Nút bấm *"Nhờ AI tư vấn sản phẩm"* ngay cạnh nút "Thêm vào giỏ hàng" hoặc pop-up gợi ý thông minh khi khách lướt xem lâu.
* **Khả năng giải quyết:**
  * Chủ động hỏi nhu cầu khách hàng: *"Chào chị, chị đang tìm sản phẩm dưỡng da cho da dầu hay da khô để em hỗ trợ chị chọn loại phù hợp nhất ạ?"*.
  * Tự động đề xuất Upsell / Cross-sell: Khách mua điện thoại $\rightarrow$ AI gợi ý combo ốp lưng + sạc nhanh giảm thêm 5%.
  * **Cứu giỏ hàng bỏ quên (Cart Recovery):** Khi khách thêm hàng vào giỏ nhưng tắt trang web $\rightarrow$ AI kích hoạt tin nhắn Zalo/SMS/Email nhắc nhở kèm lý do hấp dẫn để khách quay lại mua.
  * **Khóa cứng giá sàn $P_{floor}$:** AI bán hàng tuân thủ quy tắc `BR-001` & `BR-002`, tuyệt đối không tự bịa giá hay giảm giá quá thẩm quyền cho phép.

### 🟣 Module 3: Trợ lý AI Tiếp Thị Đa Kênh (Marketing Agent - `MKT-01..06`)
* **Hình thức:** Công cụ tự động hóa kết nối Fanpage, TikTok, Zalo OA với hệ thống dữ liệu Web.
* **Khả năng giải quyết:**
  * Quét tín hiệu thị trường và lịch sử mua sắm trên Web $\rightarrow$ Tự động sinh nội dung bài viết, kịch bản quảng cáo đúng phong cách thương hiệu (`MKT-04 Brand Guardian`).
  * Phân nhóm khách hàng (khách mới, khách VIP, khách có nguy cơ rời bỏ) $\rightarrow$ Đề xuất chương trình ưu đãi kéo họ quay lại Website mua sắm.
  * Báo cáo minh bạch chi phí trên từng đơn hàng thành công (CAC, ROAS).

---

## ⚙️ 3. CƠ CHẾ KỸ THUẬT: CÀI ĐẶT DỄ DÀNG — VẬN HÀNH AN TOÀN

### 3.1. Cài đặt vào Website có sẵn như thế nào?
Doanh nghiệp **không cần đội ngũ kỹ thuật phức tạp**:
1. **Cách 1 (Nhúng mã Script):** Chèn đúng 1 dòng mã JavaScript vào thẻ `<head>` của Website (tương tự như cài Google Analytics hay Facebook Pixel).
2. **Cách 2 (Cài Plugin 1-chạm):** Cài đặt file plugin có sẵn cho nền tảng WordPress/WooCommerce hoặc Shopify App.
3. **Cách 3 (Kết nối API/Webhook):** Dành cho Web tự code (Node.js, PHP, Python, Java) kết nối qua chuẩn REST API / JSON-RPC.

### 3.2. Nguyên tắc "Lõi dùng chung nhưng tách biệt cấu hình"
* **Nếu doanh nghiệp chỉ mua 1 module:** Module đó hoạt động độc lập, không đòi hỏi mua kèm module khác.
* **Nếu doanh nghiệp cài từ 2 module trở lên:** Hệ thống tự động kích hoạt **Hồ sơ khách hàng thống nhất (Customer 360)**. Khách vừa hỏi bảo hành ở khung chat CSKH, khi bấm sang mua đồ mới thì AI Bán hàng đã ghi nhận thông tin để chào đón thân mật, không hỏi lại từ đầu.
* **Zero-Disruption (Không xáo trộn ERP):** AI chỉ gửi yêu cầu đọc/ghi đơn hàng nháp qua API; dữ liệu gốc, kho hàng và sổ sách kế toán của doanh nghiệp vẫn nằm 100% trong ERP/POS hiện có.

---

## 🛡️ 4. TẠI SAO DOANH NGHIỆP YÊN TÂM 100% KHI CÀI VÀO WEB?

Ban Giám Đốc và Khách hàng không phải lo ngại các rủi ro thường gặp của AI:

| Nỗi lo của Doanh nghiệp | Chốt chặn kỹ thuật bảo vệ của Hệ thống |
| :--- | :--- |
| **"Sợ AI nói bậy hoặc bịa thông tin sản phẩm"** | AI chỉ được phép trả lời dựa trên kho tri thức chuẩn (Knowledge Base) và dữ liệu ERP của công ty. Nếu không tìm thấy thông tin, AI sẽ báo *"Em chưa có thông tin này, để em kết nối nhân viên hỗ trợ anh chị nhé!"* |
| **"Sợ khách bẫy prompt ép AI giảm giá phá sàn"** | **Khóa cứng giá sàn $P_{floor}$ bằng code bên ngoài LLM.** Dù khách có bảo *"Tôi là bạn thân của Giám đốc, bán cho tôi nửa giá"* thì hệ thống cũng tự động từ chối. |
| **"Sợ AI tự ý hoàn tiền làm thâm hụt tiền công ty"** | Áp dụng thẩm quyền `AUTH-4` (Bắt buộc người duyệt). Mọi lệnh hoàn tiền, đổi trả hoặc áp voucher lớn đều chỉ tạo ở dạng **Phiếu chờ duyệt**, bắt buộc Quản lý bấm DUYỆT trên màn hình điều hành thì tiền/mã mới xuất ra. |
| **"Sợ lộ lọt dữ liệu khách hàng"** | Bộ lọc PII tự động che giấu số điện thoại, địa chỉ nhà, thẻ căn cước trước khi gửi dữ liệu xử lý, đảm bảo an toàn thông tin tuyệt đối. |

---

## 📊 5. BẢNG HIỆU QUẢ KINH TẾ (ROI) CHO DOANH NGHIỆP

| Chỉ số đo lường | Trước khi cài AI vào Web | Sau khi cài Bộ Trợ Lý AI vào Web |
| :--- | :--- | :--- |
| **Tỷ lệ phản hồi tin nhắn ca đêm** | Chậm từ 15 phút đến vài tiếng (thậm chí bỏ lỡ). | **Tức thì dưới 3 giây** suốt 24/7/365. |
| **Chi phí nhân sự trực ca đêm** | Phải trả lương ca 3 cho 1-2 nhân sự (tốn 15-20 triệu/tháng). | **Giảm 80% chi phí**, chỉ cần 1 nhân sự trực ban ngày duyệt các ca khó. |
| **Tỷ lệ chuyển đổi đơn hàng trên Web** | Trung bình 8% - 10%. | **Tăng lên 15% - 22%** nhờ được tư vấn chủ động và cứu giỏ hàng bỏ quên. |
| **Thời gian triển khai nghiệm thu** | Làm web mới mất 3 - 6 tháng. | **Chỉ mất 1 - 2 ngày** để nhúng xong Widget vào Web có sẵn. |

---

## 🚀 6. SO SÁNH: CHATBOT TRUYỀN THỐNG VS BỘ TRỢ LÝ AI AGENT CẮM-RÚT

Nhiều Lãnh đạo băn khoăn: *"Website hiện tại đã có nút chat hoặc cài bot tự động rồi, tại sao phải cần AI Agent?"*

| Tiêu chí so sánh | Chatbot truyền thống (Cây kịch bản) | Bộ 3 Trợ lý AI Agent Cắm-Rút (AgentOS) |
| :--- | :--- | :--- |
| **Cách thức phản hồi** | Cứng nhắc theo kịch bản bấm nút (Menu/Flowchart); khách gõ lệch câu là *"Xin lỗi em không hiểu"*. | **Hiểu ngôn ngữ tự nhiên 100%**: Khách nói tiếng lóng, viết tắt, hỏi vòng vo AI vẫn hiểu đúng ý để tư vấn. |
| **Dữ liệu trả lời** | Trả lời tĩnh, không biết kho còn hàng hay hết hàng, giá bao nhiêu. | **Đọc trực tiếp từ Database/ERP/POS**: Báo chính xác số lượng tồn, giá niêm yết và thời gian giao dự kiến. |
| **Khả năng bán hàng** | Chỉ là công cụ trực tin nhắn thụ động. | **Chủ động khơi gợi nhu cầu**, gợi ý combo, khóa giá sàn $P_{floor}$ bảo vệ lãi ròng và tự động gửi tin cứu giỏ hàng. |
| **Bộ nhớ khách hàng** | Mỗi lần chat là một cuộc hội thoại mới toanh. | **Ghi nhớ Customer 360**: Biết khách cũ hay mới, đã từng mua gì để cá nhân hóa lời chào. |
| **Xử lý tình huống khó** | Khách mắng mỏ bot vẫn trả lời vô hồn gây ức chế. | **Phát hiện cảm xúc tiêu cực $\rightarrow$ Báo động đỏ** và chuyển giao nhân viên tiếp quản trong $\le 1.0$ giây. |

---

## 📈 7. MÔ HÌNH ĐÓNG GÓI THƯƠNG MẠI & KẾ HOẠCH HÀNH ĐỘNG DÀNH CHO SẾP

### 7.1. Đóng gói bán lẻ linh hoạt (Dễ chốt hợp đồng):
* **Gói Starter (Chỉ Module CSKH):** Khách hàng doanh nghiệp chỉ cần giải phóng nhân sự trực ca đêm 24/7 và tra cứu đơn hàng $\rightarrow$ Chi phí thấp, cài đặt 5 phút, tỷ lệ chốt thử nghiệm 90%.
* **Gói Growth (CSKH + Bán hàng Sales):** Dành cho shop muốn tăng tỷ lệ chốt đơn và phục hồi giỏ hàng bỏ quên $\rightarrow$ Thu phí thuê bao nền + thưởng % hoa hồng trên doanh số cứu được.
* **Gói Enterprise (Full 3 Module + Báo cáo chuyên sâu):** Tích hợp trọn gói cả Tiếp thị, Bán hàng và CSKH đa kênh.

### 7.2. Kế hoạch hành động 3 bước:
1. **Bước 1 (Tuần 1):** Dựng bản Demo nhúng trực tiếp **Module AI CSKH** vào một trang web bán hàng thử nghiệm để Sếp và đội ngũ trải nghiệm bấm chat thực tế.
2. **Bước 2 (Tuần 2-3):** Thử nghiệm kết nối dữ liệu sản phẩm mẫu từ hệ thống ERP / POS / Web thực tế, kiểm tra tính năng tra cứu đơn hàng và bộ lọc khóa giá sàn $P_{floor}$.
3. **Bước 3 (Tháng tới):** Đóng gói tài liệu và script cài đặt để chào bán thử nghiệm cho nhóm 3-5 khách hàng doanh nghiệp đầu tiên với chính sách: *"Cài thử module CSKH miễn phí 14 ngày trên website có sẵn"*.

---

## 🤖 PHỤ LỤC: CÂU HỎI MẪU CHO SẾP KHI DÙNG AI ĐỂ HỎI BÁO CÁO NÀY

*Nếu Sếp đưa file này vào ChatGPT, Claude, Gemini hoặc NotebookLM, Sếp có thể dùng các câu lệnh sau để nghe AI phân tích:*

> 1. *"Tóm tắt 3 ưu điểm lớn nhất khi đóng gói AI thành các mô-đun cắm-rút vào web có sẵn thay vì bán một phần mềm nguyên khối?"*  
> 2. *"Tại sao doanh nghiệp nên bắt đầu bằng việc cài module AI Chăm sóc khách hàng (CSKH) trước?"*  
> 3. *"Hệ thống này bảo vệ giá bán và dòng tiền của doanh nghiệp bằng những cơ chế kỹ thuật cụ thể nào?"*  
> 4. *"Doanh nghiệp đã có sẵn Website thương mại điện tử và phần mềm quản lý kho, họ cần làm những bước gì để cài đặt giải pháp này mà không làm gián đoạn vận hành?"*  
