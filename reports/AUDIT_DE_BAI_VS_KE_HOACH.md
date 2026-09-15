# Báo Cáo Audit Chi Tiết: Đối Chiếu Đề Bài SRS v0.1 và Bản Kế Hoạch Hiện Tại

**Mã tài liệu audit:** AUDIT-REV-2026-01  
**Ngày lập:** 15/09/2026  
**Đối tượng kiểm toán:**  
1. Đề bài SRS: `De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md` (AI-REV-SRS-001)  
2. Hệ thống kế hoạch hiện tại: Thư mục `plans/` và tệp `README.md`

---

## 1. Kết Luận Tổng Quan (Executive Summary)

Cảm giác **"hơi bị rối"** khi đọc song song Đề bài SRS và Bản kế hoạch hiện tại là **hoàn toàn chính xác và có cơ sở thực tế**. 

Nguyên nhân cốt lõi không phải do logic sai lệch, mà do **hai tài liệu đang đứng ở hai góc nhìn hoàn toàn khác nhau nhưng hiện bị trộn lẫn cơ học vào nhau**:
- **Đề bài SRS (AI-REV-SRS-001)** là tài liệu **Đặc tả Kỹ thuật Phần mềm (Software Requirements Specification - SRS)**: Tập trung vào "Khung gầm kỹ thuật" (Engine, Framework, Canonical Contracts, Authority AUTH-0..5, Business Rules BR-001..010, Test Suites TC-E2E-001..009). Nó mang tính chất kỹ thuật trừu tượng và chuẩn hóa cấp doanh nghiệp.
- **Kế hoạch của chúng ta (`plans/`)** ban đầu là tài liệu **Nghiệp Vụ Thương Mại Thực Chiến (Commercial Strategy & Business Playbook)**: Tập trung vào "Bài toán kinh doanh" (Unit Economics, lấy hoa hồng telesales bù cho trợ cấp giá sàn $P_{floor}$, hóa giải tâm lý sợ lừa đảo 詐騙 tại Đài Loan, nhận hàng 7-Eleven CVS COD, trợ cấp xe máy điện O2O, gói Vertical SaaS và phân phối Shopify App Store).

Khi chúng ta "ghép cơ học" toàn bộ mã hiệu kỹ thuật của SRS (`MKT-01..06`, `SAL-01..05`, `AUTH-0..5`, `SCR-001..005`) trực tiếp vào các tài liệu nghiệp vụ thị trường, người đọc sẽ bị quá tải vì vừa phải xử lý thuật toán phân quyền, vừa phải đọc về bản đồ trạm pin hay thủ tục giao nhận siêu thị.

---

## 2. Bốn Điểm Nghẽn Gây Rối Cụ Thể (Root Causes of Confusion)

### Điểm nghẽn 1: Trộn lẫn giữa "Khung gầm AI (Platform)" và "Kịch bản ngành dọc (Vertical Playbooks)"
- **Thực trạng**: Trong cùng một tệp (như `sales.md` hay `architecture.md`), chúng ta vừa mô tả các Agent kỹ thuật chung (`SAL-01 Lead Qualification`, `SAL-03 Recommendation`), vừa mô tả chi tiết nghiệp vụ địa phương (E-Map chuỗi siêu thị 7-Eleven Đài Loan, bộ tính trợ cấp xe điện chính quyền thành phố Đài Bắc).
- **Hậu quả**: Kỹ sư phần mềm khi đọc sẽ thấy hệ thống bị dính chặt vào thị trường Đài Loan (hard-coded localization), trong khi đối tác kinh doanh hoặc ban lãnh đạo lại bị rối mắt bởi các mã hiệu kỹ thuật chuẩn hóa của SRS.

### Điểm nghẽn 2: Sự giằng co giữa Lộ trình Kỹ thuật (Technical Gating) và Lộ trình Kinh doanh (Commercial Milestones)
- **Đề bài SRS**: Tiếp cận theo thứ tự an toàn kỹ thuật phần mềm truyền thống:
  - `P0 Foundation` ➔ `P1 Customer Care Pilot` (vì CSKH ít rủi ro tài chính nhất, tra cứu FAQ/đơn hàng) ➔ `P2 Sales Pilot` ➔ `P3 Marketing Pilot`.
- **Kế hoạch Thương mại**: Tiếp cận theo mục tiêu dòng tiền và đối tác mỏ neo:
  - Doanh nghiệp Đài Loan cần AI bán hàng ngay để tăng chuyển đổi B2C. Nếu P1 chỉ làm CSKH mà không hỗ trợ tư vấn chốt đơn, đối tác sẽ không thấy ngay ROI (Return on Investment) để tiếp tục giải ngân.
- **Hậu quả**: Khi cố gộp 6 Gate của SRS với các Phase thương mại của dự án, người đọc thấy các giai đoạn P1, P2 bị chồng chéo định nghĩa.

### Điểm nghẽn 3: Chồng chéo danh mục Trợ lý (Agent Taxonomy Overlap)
- **Đề bài SRS** chia nhỏ thành 13 Agent kỹ thuật:
  - Marketing: `MKT-01` đến `MKT-06` (6 agents).
  - Sales: `SAL-01` đến `SAL-05` (5 agents).
  - Customer Care: `CS-01` và `CS-02` (2 agents).
- **Kế hoạch Thương mại** trước đó định vị: "Bộ 3 Trợ Lý AI Toàn Diện" (Tiếp thị, Bán hàng, Chăm sóc).
- **Hậu quả**: Khách hàng hoặc đối tác non-tech sẽ hỏi: *"Rốt cuộc giải pháp này có 3 con AI hay là 13 con AI?"*. Thực tế, 3 con AI là giao diện đóng gói thương mại bên ngoài (Commercial Bundles), còn 13 agents là các vi dịch vụ/vai trò chuyên biệt chạy ngầm bên dưới (Internal Sub-agents). Nếu không làm rõ điều này, tài liệu gây hiểu lầm nghiêm trọng.

### Điểm nghẽn 4: Trộn lẫn giữa "Công cụ Điều phối Quản trị (Command Center)" và "Giao diện Nhúng Phía Khách Hàng (Storefront Widget)"
- **Đề bài SRS** quy định 5 màn hình quản trị nội bộ dành cho nhân viên doanh nghiệp (`SCR-001` đến `SCR-005`: Executive Dashboard, Agent Operations, Approval Center, Customer 360, Conversation Console).
- **Kế hoạch cũ** lại nhấn mạnh vào bộ mã nhúng B2C cho khách mua hàng xem (`nexus-sales.min.js`, ngân sách <20 KB, floating widget, nút chọn nhanh).
- **Hậu quả**: Người đọc không phân biệt được màn hình nào là cho nhân sự nội bộ vận hành (Internal Admin Console) và giao diện nào là cho người tiêu dùng cuối tương tác (End-user Chat Widget).

---

## 3. Bản Đồ Hóa Giải: Mô Hình Phân Tầng 3 Lớp Rõ Ràng (The 3-Tier Separation Architecture)

Để toàn bộ kế hoạch trở nên mạch lạc, thanh thoát, khớp 100% với SRS mà vẫn giữ nguyên vẹn mọi thế mạnh kinh doanh thực chiến, hệ thống cần được phân tầng rành mạch:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ TẦNG 3: DOMAIN PLAYBOOKS & PACKAGING (Bản Đóng Gói Thương Mại & GTM)   │
│ - AgentOS Mobility Edition (Xe máy điện O2O, trợ cấp, trạm pin, cọc)   │
│ - AgentOS FMCG Edition (Giao định kỳ Subscription, giỏ hàng, CVS COD)  │
│ - Kênh phân phối 1-chạm qua Shopify & WooCommerce App Store            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Kế thừa & Cấu hình
┌───────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 2: COMMERCIAL ENGINE & ECONOMICS (Bài Toán Kinh Tế Đơn Vị)        │
│ - Mô hình kinh tế: Cắt giảm telesales ➔ Biến thành Quỹ trợ cấp động    │
│ - Máy chủ tính giá sàn toán học P_floor (Khóa cứng biên lãi ròng)       │
│ - Cơ chế tích điểm tiến độ (Endowed Progress) & Chống bùng hàng CVS    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Vận hành trên nền tảng
┌───────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 1: SYSTEM BLUEPRINT & PLATFORM SPEC (Khung Gầm Kỹ Thuật SRS v0.1)  │
│ - Revenue Orchestrator 11 bước (SIGNAL ➔ DECISION ➔ EVIDENCE ➔ OUTCOME) │
│ - 13 Internal Sub-Agents (MKT-01..06, SAL-01..05, CS-01..02)           │
│ - Mô hình phân quyền 6 cấp (AUTH-0..AUTH-5) & 10 Quy tắc BR-001..BR-010│
│ - Knowledge Base 8 thư mục (/company, /product..) & 5 tầng AI Memory   │
│ - Human Command Center 5 màn hình (SCR-001..SCR-005)                   │
│ - Bộ kiểm thử chấp nhận E2E (TC-E2E-001..009) & Gating P0–P5           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Ma Trận Định Vị Các Khái Niệm Để Không Còn Bị Rối

| Khái niệm trong Đề bài SRS v0.1 | Vị trí định vị chuẩn trong Hệ thống | Vai trò và Cách giải thích rành mạch |
|---|---|---|
| **Revenue Orchestrator (11 bước)** | Tầng 1: Lõi điều phối trung tâm (`architecture.md`) | Bộ não phân luồng, đảm bảo AI không tự biên tự diễn; mọi hành động đều có bằng chứng (evidence). |
| **13 Sub-Agents (MKT, SAL, CS)** | Tầng 1: Các vi kỹ năng nội bộ (`modules/`) | Đóng gói thành **Bộ 3 Gói Trợ Lý Thương Mại** (Tiếp thị, Bán hàng, Chăm sóc) để chào bán; bên trong gồm các sub-agent chuyên môn hóa. |
| **Authority Model (AUTH-0..5)** | Tầng 1: Cơ chế an toàn (`workflows-and-handoffs.md`) | Phân quyền rõ ràng: AI chỉ được tự làm việc rủi ro thấp (AUTH-3), việc liên quan đến tiền bạc/chiến dịch bắt buộc người duyệt (AUTH-4). |
| **Giá sàn $P_{floor}$ & Trợ cấp chốt đơn** | Tầng 2: Thuật toán kinh tế (`analytics.md`, `sales.md`) | Hiện thực hóa quy tắc `BR-001/002` của SRS: Lời giải cho bài toán tiền giảm giá lấy từ hoa hồng sales tiết kiệm được. |
| **Taiwan Anchor Pilot (7-Eleven, Xe điện)** | Tầng 3: Kịch bản thử nghiệm mỏ neo (`product-and-packaging.md`) | Là trường hợp triển khai thực tế đầu tiên (Pilot Instance) để kiểm chứng hệ thống trước khi nhân rộng toàn cầu. |
| **Command Center (SCR-001..005)** | Tầng 1: Bảng điều khiển quản trị (`architecture.md`) | 5 Màn hình dành cho nhân sự doanh nghiệp quản lý bot, duyệt chiến dịch, xem hồ sơ khách và tiếp quản hội thoại. |
| **Web Floating Widget** | Tầng 3: Kênh tiếp cận khách hàng (`api-and-integrations.md`) | Chỉ là một trong các cổng kết nối (Connectors) phía người dùng cuối, tương đương LINE OA hay WhatsApp. |

---

## 5. Đề Xuất Kế Hoạch Hành Động (Action Plan)

Để loại bỏ hoàn toàn sự rối rắm và đạt cấu trúc mạch lạc:

1. **Chuẩn hóa cấu trúc tài liệu**:
   - `plans/platform/`: Giữ thuần túy đặc tả kiến trúc kỹ thuật chuẩn SRS v0.1 (Orchestrator 11 bước, AUTH-0..5, BR-001..010, SCR-001..005, Second Brain, API Connectors, NFRs). Tuyệt đối không để chi tiết đặc thù địa phương làm loãng kiến trúc cốt lõi.
   - `plans/modules/`: Quy định rõ 13 Sub-Agents kỹ thuật, sau đó tổ chức phần kịch bản thực chiến địa phương (FMCG, Xe máy điện, 7-Eleven) thành các **Phụ lục Kịch bản Ngành dọc (Domain Playbook Addendums)** riêng biệt ở cuối mỗi module.
   - `plans/product-and-packaging.md`: Giữ vai trò tài liệu thương mại B2B SaaS (2 gói ngành dọc Mobility & FMCG, cơ chế cắm-rút Plug-and-Play Adapters, và phân phối Shopify App Store).
2. **Tách đôi trục Lộ trình (Dual-Track Roadmap)**:
   - **Trục Kỹ thuật (Engineering Track)**: Bám sát 6 Cổng P0–P5 của SRS (Foundation ➔ Care ➔ Sales ➔ Marketing ➔ Cross-domain ➔ Autonomy).
   - **Trục Thương mại (Commercial Track)**: Bám sát lộ trình Pilot mỏ neo Đài Loan ➔ Phân phối Shopify App Store toàn cầu.
3. **Cập nhật Báo cáo Thuyết trình**:
   - Đồng bộ trang 1–2 trong tệp thuyết trình [BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf](../BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf) để trình bày rõ mô hình 3 tầng này, giúp đối tác kỹ thuật lẫn đối tác kinh doanh đều nắm bắt ngay lập tức mà không bị nhầm lẫn.
