# AgentOS Customer360 — Kế hoạch

Đọc [bản tổng quan dễ hiểu](plan-easy-read-flow.md) trước, khoảng 5 phút. Muốn bắt đầu triển khai, mở [phạm vi bản đầu và điều kiện nghiệm thu](delivery/mvp-and-roadmap.md).

Cập nhật: 10/09/2026. Trạng thái: **đề xuất thiết kế, chưa triển khai và chưa được kiểm chứng bằng thử nghiệm thực tế**. Việc nguồn PDF ghi “đã phê duyệt ý niệm” không có nghĩa bộ kế hoạch hợp nhất hoặc các tính năng đã được nghiệm thu.

## 1. Định hướng thống nhất

Xây bộ trợ lý AI giúp doanh nghiệp **hiểu nhu cầu sớm → tư vấn đúng giải pháp → hỗ trợ mua thuận tiện → chăm sóc sau mua → tạo mua lại và giới thiệu**. Khách có thể đến từ tìm kiếm, quảng cáo, đối tác, khách cũ hoặc trực tiếp; quảng cáo không phải điểm khởi đầu duy nhất.

Giữ ba mô-đun có thể bật riêng:

| Mô-đun | Phạm vi hợp nhất | Kết quả cần đo |
|---|---|---|
| Tiếp thị | Nghiên cứu thị trường, tín hiệu trước nhu cầu, định vị, đối tác, tiếp nhận và chăm sóc khách quan tâm | Nhu cầu được kiểm chứng, khách phù hợp, chi phí thu hút |
| Bán hàng | Hỏi nhu cầu, đề xuất có bằng chứng, giải thích sản phẩm, hỗ trợ mua; ưu đãi có kiểm soát ở giai đoạn sau | Chuyển đổi và lãi đóng góp, không chỉ số đơn |
| Chăm sóc khách hàng | Hướng dẫn, xử lý vấn đề, chuyển nhân viên, ghi nhận nhu cầu mua lại | Giải quyết có xác nhận, hài lòng và mua lại |

Nghiên cứu thị trường là năng lực của Tiếp thị, không phải mô-đun thứ tư. Giữ chân và phát triển đối tác là quy trình liên quan đến ba mô-đun, không đòi thêm sản phẩm độc lập.

Lõi dùng chung gồm điều phối, hồ sơ khách hàng hợp nhất Customer360, kho kiến thức, quy trình, kết nối API, kiểm soát quyền, nhật ký và đo lường. Doanh nghiệp giữ ứng dụng và dữ liệu gốc; dùng chung phần mềm không đồng nghĩa dùng chung dữ liệu khách hàng.

## 2. Mô hình Phân tầng 3 Lớp (The 3-Tier Separation Architecture)

Để giải quyết triệt để sự chồng chéo giữa đặc tả kỹ thuật chuẩn hóa và chiến lược thương mại thực chiến, hệ thống được cấu trúc rành mạch thành 3 tầng:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ TẦNG 3: DOMAIN PLAYBOOKS & PACKAGING (Bản Đóng Gói Ngành Dọc & GTM)   │
│ - GTM-001A: AgentOS Mobility Edition (Xe điện O2O, DOM-MOB-001..004)   │
│ - GTM-001B: AgentOS FMCG Edition (Bán lẻ tiêu dùng, DOM-FMCG-001..005) │
│ - GTM-002: Phân phối 1-chạm qua Shopify & WooCommerce App Store        │
│ - GTM-003: Đòn bẩy số liệu thực nghiệm Đài Loan làm bằng chứng ROI      │
│ - Cổng kết nối cắm-rút: ADPT-TW-001 (Đài Loan) & ADPT-GL-001..003      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Cấu hình & Kế thừa
┌───────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 2: COMMERCIAL ENGINE & ECONOMICS (Động Lực Kinh Tế Đơn Vị)        │
│ - ECN-001: Tái phân bổ hoa hồng bán hàng/telesales 5–10% thành trợ cấp │
│ - ECN-002: Công thức giá sàn toán học máy chủ P_floor (Bảo toàn 100% L)│
│ - ECN-003: Định mức chi phí AI 0,5–1 TWD/phiên tư vấn hoàn chỉnh       │
│ - ECN-004: Ngân sách điểm thưởng, trần Basket Cap & chống gian lận     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Vận hành trên nền tảng
┌───────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 1: SYSTEM BLUEPRINT & PLATFORM SPEC (Khung Gầm Kỹ Thuật SRS v0.1) │
│ - Revenue Orchestrator 11 bước (SIGNAL ➔ DECISION ➔ EVIDENCE ➔ OUTCOME)│
│ - 13 Internal Sub-Agents (MKT-01..06, SAL-01..05, CS-01..02)          │
│ - Mô hình thẩm quyền 6 cấp (AUTH-0..5) & 10 Quy tắc nghiệp vụ BR-001..010│
│ - Knowledge Base 8 thư mục (/company, /product..) & 5 tầng AI Memory   │
│ - Human Command Center 5 màn hình quản trị (SCR-001..SCR-005)          │
│ - 10 Yêu cầu phi chức năng (NFR-001..010) & 9 Test E2E (TC-E2E-001..009)│
│ - Lộ trình kỹ thuật 6 Cổng Gate (P0–P5) & 5 Giả định (ASM-001..005)    │
└────────────────────────────────────────────────────────────────────────┘
```

## 3. Bảng Danh mục Mã Hiệu Toàn Hệ Thống (Master Code Taxonomy)

Hệ thống phân định rành mạch giữa 2 nhóm mã hiệu: Nhóm SRS (quy chuẩn kỹ thuật phần mềm chuẩn) và Nhóm Proprietary (giải pháp thương mại, kinh tế và ngành dọc độc quyền):

### 3.1. Nhóm SRS (Software Requirements Specification — Kỹ thuật Phần mềm)

| Tiền tố / Nhóm mã | Tên nhóm danh mục | Phạm vi định danh chi tiết | Tài liệu chịu trách nhiệm |
|---|---|---|---|
| **OBJ-001..006** | Mục tiêu kinh doanh hệ thống | 6 Mục tiêu nền tảng: Marketing (001), Sales (002), Care (003), Retention (004), Orchestration (005), Governance (006) | [README.md](README.md), [Root README](../README.md) |
| **MKT-01..06** | Sub-Agents Tiếp thị | 6 Vai trò nội bộ: MKT-01 (Strategist), MKT-02 (Audience), MKT-03 (Content), MKT-04 (Brand Guardian), MKT-05 (Campaign), MKT-06 (Analyst) | [Tiếp thị](modules/marketing.md) |
| **SAL-01..05** | Sub-Agents Bán hàng | 5 Vai trò nội bộ: SAL-01 (Qualification), SAL-02 (Advisor), SAL-03 (Recommendation), SAL-04 (Cart Recovery), SAL-05 (Replenishment) | [Bán hàng](modules/sales.md) |
| **CS-01..02** | Sub-Agents Chăm sóc & Giữ chân | 2 Vai trò nội bộ: CS-01 (Omnichannel Care), CS-02 (Retention / Customer Success) | [Chăm sóc khách hàng](modules/customer-support.md) |
| **FR-*** | Yêu cầu chức năng cốt lõi | FR-C360-001..003 (Customer 360), FR-SAL-001..003 (Sales), FR-CS-001..003 (Care), FR-ORC-001..002 (Orchestrator) | [Kiến trúc](platform/architecture.md), [Dữ liệu](platform/data-and-knowledge.md) |
| **AUTH-0..5** | Cấp độ thẩm quyền AI | 6 Mức kiểm soát: AUTH-0 (Observe), AUTH-1 (Recommend), AUTH-2 (Draft), AUTH-3 (Bounded Execute), AUTH-4 (Approval Required), AUTH-5 (Prohibited) | [Quy trình](platform/workflows-and-handoffs.md) |
| **BR-001..010** | Quy tắc kinh doanh bắt buộc | 10 Ràng buộc toàn vẹn: Không tự định giá, bảo toàn giá sàn ERP, kiểm tra consent, chống trùng Idempotency, cấm vượt quyền... | [Quy trình](platform/workflows-and-handoffs.md), [Bán hàng](modules/sales.md) |
| **SCR-001..005** | Màn hình Command Center | 5 Giao diện quản trị: SCR-001 (Executive Dashboard), SCR-002 (Agent Operations), SCR-003 (Approval Center), SCR-004 (Customer 360), SCR-005 (Conversation Console) | [Kiến trúc](platform/architecture.md) |
| **NFR-001..010** | Yêu cầu phi chức năng | 10 Chuẩn chất lượng: Security, Auditability, Idempotency, Availability, Explainability, Data Isolation, Human Override, Fail Closed, Performance, Cost | [API & Tích hợp](platform/api-and-integrations.md) |
| **TC-E2E-001..009**| Kiểm thử chấp nhận hệ thống | 9 Ca kiểm thử E2E: Luồng tín hiệu khép kín, kiểm soát phê duyệt, toàn vẹn giá sàn, bảo mật danh tính, chống trùng lặp, chặn vượt quyền... | [Bản đầu và lộ trình](delivery/mvp-and-roadmap.md) |
| **ASM-001..005** | Giả định khóa trước Production | 5 Giả định bắt buộc: Cổng kết nối, KPI baseline, ngưỡng discount, duyệt hoàn tiền, chính sách lưu trữ Customer360 | [Bản đầu và lộ trình](delivery/mvp-and-roadmap.md) |
| **P0..P5** | Cổng kỹ thuật lộ trình | 6 Cổng nghiêm ngặt: P0 (Foundation), P1 (Care), P2 (Sales), P3 (Marketing), P4 (Cross-domain), P5 (Controlled Autonomy) | [Bản đầu và lộ trình](delivery/mvp-and-roadmap.md) |
| **KPI-*** (5 nhóm) | Bộ chỉ số đo lường hiệu quả | MKT-KPI-01..07 (Tiếp thị), SAL-KPI-01..08 (Bán hàng), CS-KPI-01..06 (CSKH), SUC-KPI-01..07 (Giữ chân), AI-SYS-KPI-01..10 (Hệ thống AI) | [Đo lường](delivery/analytics.md) |

### 3.2. Nhóm Proprietary (Commercial, Economics & Domain Playbooks — Độc quyền)

| Tiền tố / Nhóm mã | Tên nhóm danh mục | Phạm vi định danh chi tiết | Tài liệu chịu trách nhiệm |
|---|---|---|---|
| **ECN-001..004** | Động lực kinh tế đơn vị | ECN-001 (Tái phân bổ hoa hồng telesales 5–10%), ECN-002 (Công thức giá sàn toán học P_floor), ECN-003 (Định mức chi phí AI 0,5–1 TWD/phiên), ECN-004 (Ngân sách điểm thưởng & trần Basket Cap) | [Đo lường](delivery/analytics.md) |
| **DOM-MOB-001..004** | Phân hệ ngành Xe điện O2O | DOM-MOB-001 (Bộ tính trợ cấp chính phủ theo hộ khẩu), DOM-MOB-002 (Định vị trạm pin Gogoro/Ionex bán kính 1km), DOM-MOB-003 (Đặt lịch lái thử showroom & cọc hoàn lại), DOM-MOB-004 (Giới thiệu 2 chiều Tesla & nhắc bảo dưỡng) | [Bán hàng](modules/sales.md), [CSKH](modules/customer-support.md) |
| **DOM-FMCG-001..005** | Phân hệ ngành Hàng tiêu dùng | DOM-FMCG-001 (Giỏ hàng thông minh & soát giỏ chống mua thừa), DOM-FMCG-002 (Giao định kỳ Subscription 定期購 áp giá sàn P_floor), DOM-FMCG-003 (Bản đồ chọn điểm nhận 7-Eleven CVS COD TTL 10p), DOM-FMCG-004 (Tích điểm tiến độ LINE Points), DOM-FMCG-005 (Bộ tứ định danh chống clone acc & bùng hàng CVS) | [Bán hàng](modules/sales.md), [CSKH](modules/customer-support.md) |
| **ADPT-TW-001** | Gói Adapter Đài Loan | Tích hợp bản địa Đài Loan: LINE OA + ECPay/NewebPay/LINE Pay + 7-Eleven/FamilyMart CVS COD + Taiwan PDPA GCP Changhua/AWS Taipei | [API & Tích hợp](platform/api-and-integrations.md), [Sản phẩm](product-and-packaging.md) |
| **ADPT-GL-001..003** | Cổng cắm-rút toàn cầu | ADPT-GL-001 (Communication: WhatsApp/Telegram/Web), ADPT-GL-002 (Payment: Stripe/PayPal/Apple Pay), ADPT-GL-003 (Compliance: GDPR/CCPA/PDPA) | [API & Tích hợp](platform/api-and-integrations.md), [Sản phẩm](product-and-packaging.md) |
| **GTM-001..003** | Chiến lược Go-To-Market | GTM-001 (Đóng gói Vertical SaaS: GTM-001A Mobility Edition, GTM-001B FMCG Edition), GTM-002 (Shopify & WooCommerce 1-Click App Store), GTM-003 (Đòn bẩy số liệu thực nghiệm Đài Loan làm bằng chứng ROI) | [Sản phẩm và cách đóng gói](product-and-packaging.md) |

## 4. Đọc theo nhu cầu

1. Người phụ trách kinh doanh: [bản dễ hiểu](plan-easy-read-flow.md) → [sản phẩm và cách đóng gói](product-and-packaging.md).
2. Người thiết kế nghiệp vụ: [hành trình khách hàng](customer-lifecycle.md) → mô-đun liên quan.
3. Nhóm kỹ thuật: [bản đặc tả kỹ thuật PDF](../DAC_TA_KY_THUAT_HE_THONG_AI_AGENT.pdf) → [kiến trúc](platform/architecture.md) → [dữ liệu](platform/data-and-knowledge.md) → [API](platform/api-and-integrations.md) → [nghiệm thu](delivery/mvp-and-roadmap.md).
4. Người ra quyết định đầu tư: [đo lường và kinh tế đơn hàng](delivery/analytics.md) → [thứ tự thử nghiệm](delivery/mvp-and-roadmap.md).
5. Tra từ viết tắt: [bảng thuật ngữ](glossary.md).

## 5. Nơi chịu trách nhiệm cho từng nội dung

| Tài liệu | Nội dung chính | Mốc tham chiếu cũ được giữ |
|---|---|---|
| [Sản phẩm và cách đóng gói](product-and-packaging.md) | Khách hàng mục tiêu, giá trị, bộ cấu hình, mô hình thương mại B2B SaaS, gói GTM-001A/B, phân phối GTM-002/003 | 1, 2, 17, 19 |
| [Hành trình khách hàng](customer-lifecycle.md) | Từ tín hiệu sớm đến mua lại; tình huống B2C và bán hàng cần tư vấn | 3, 4, 9 |
| [Tiếp thị](modules/marketing.md) | 6 Marketing Sub-Agents (MKT-01..06), nghiên cứu, định vị, đối tác, tiếp nhận, chấm điểm và chăm sóc | 6 |
| [Bán hàng](modules/sales.md) | 5 Sales Sub-Agents (SAL-01..05), tư vấn, bằng chứng, giỏ hàng, ưu đãi, kiểm soát giá và kịch bản DOM-MOB/DOM-FMCG | 7 |
| [Chăm sóc khách hàng](modules/customer-support.md) | 2 CS Sub-Agents (CS-01..02), tra cứu, xử lý sự cố, bàn giao, bảo vệ giá, phản hồi và vòng lặp giữ chân | 8 |
| [Kiến trúc](platform/architecture.md) | Ranh giới hệ thống, Revenue Orchestrator 11 bước, 5 màn hình Command Center (SCR-001..005) và giao diện nhúng | 5, 10 |
| [Dữ liệu và kiến thức](platform/data-and-knowledge.md) | Hồ sơ Customer360, đồng ý liên hệ, nguồn gốc bằng chứng, kho kiến thức 8 thư mục, 5 tầng AI Memory | 11, 12, 18 |
| [Quy trình và bàn giao](platform/workflows-and-handoffs.md) | Trạng thái bền vững, nhắc lại, mô hình thẩm quyền AUTH-0..5, quy tắc BR-001..010, dừng và phục hồi | 13, 14 |
| [API và tích hợp](platform/api-and-integrations.md) | Hợp đồng kết nối, cổng cắm-rút ADPT-TW-001 & ADPT-GL-001..003, thanh toán, bảo mật và 10 NFRs | 15, 16 |
| [Đo lường](delivery/analytics.md) | Hệ thống KPI 5 nhóm theo SRS Mục 20, động lực kinh tế ECN-001..004, công thức giá sàn P_floor và chi phí AI | 20 |
| [Bản đầu và lộ trình](delivery/mvp-and-roadmap.md) | Lộ trình trục kép (Engineering P0–P5 & Commercial Phase 1–3), DoD 10 thành tố, giả định ASM-001..005, kiểm thử TC-E2E-001..009 | 21, 22, 23, 26, 27 |

Mỗi quy định có một nơi chịu trách nhiệm; tài liệu khác chỉ tóm tắt và liên kết. Giữ đường dẫn tệp và các mốc `section-N` để hạn chế làm hỏng tham chiếu cũ. Tên tệp, tên sản phẩm, API và mã trạng thái giữ nguyên khi cần tương thích; toàn bộ phần diễn giải được viết bằng tiếng Việt.

## 6. Ma trận đối chiếu mục tiêu và nghiệm thu (Traceability Matrix theo SRS Mục 25)

Bảng đối chiếu tổng thể giữa các Mục tiêu kinh doanh (Business Objectives), nhóm yêu cầu kỹ thuật, tài liệu module phụ trách và bộ ca kiểm thử nghiệm thu E2E:

| Mục tiêu kinh doanh (Business Objective) | Nhóm yêu cầu SRS | Module / Tài liệu đảm nhiệm | Tiêu chí kiểm chứng chính (Validation & E2E Tests) |
|---|---|---|---|
| **OBJ-001 — Tiếp thị (Marketing):** Tự động phát hiện cơ hội, lập kế hoạch, tạo nội dung, vận hành chiến dịch và tối ưu marketing. | MKT-01..06 | [Tiếp thị](modules/marketing.md) | **PILOT-01** (Marketing → Sales), **TC-E2E-002** (Marketing không publish nếu thiếu human approval). |
| **OBJ-002 — Bán hàng (Sales):** Nhận diện nhu cầu, tư vấn thông minh, chấm điểm cơ hội, gợi ý sản phẩm, cross-sell/upsell, phục hồi giỏ hàng. | FR-SAL-001..003, SAL-01..05 | [Bán hàng](modules/sales.md) | **PILOT-02** (Cart Recovery), **TC-E2E-003** (Toàn vẹn giá sàn ERP), **TC-E2E-005** (Chống tạo đơn trùng - Idempotency). |
| **OBJ-003 — Chăm sóc khách hàng (Customer Care):** Tiếp nhận yêu cầu, tra cứu dữ liệu thực, hỗ trợ đơn hàng, khiếu nại, chuyển người kịp thời. | FR-CS-001..003, CS-01..02 | [Chăm sóc khách hàng](modules/customer-support.md) | **PILOT-03** (Tra cứu đơn hàng), **PILOT-04** (Xử lý khiếu nại & Chuyển cấp), **TC-E2E-004** (Xác minh danh tính khách hàng). |
| **OBJ-004 — Khách hàng thành công & Giữ chân (Retention):** Phát hiện nguy cơ mất khách, kích hoạt chu kỳ mua lại, chăm sóc khách hàng thân thiết. | FR-CS-003 | [Chăm sóc khách hàng](modules/customer-support.md), [Hành trình](customer-lifecycle.md) | Quy trình giữ chân (Retention Workflow), Vòng lặp tích điểm kích hoạt đơn 2 (Loyalty Loop), Phân tích rủi ro rời bỏ (Churn). |
| **OBJ-005 — Điều phối đa Agent (Revenue Orchestration):** Phối hợp liền mạch giữa Marketing, Sales và CSKH dùng chung Customer360. | FR-ORC-001..002 | [Kiến trúc](platform/architecture.md), [Quy trình](platform/workflows-and-handoffs.md) | **TC-E2E-001** (Luồng tín hiệu khép kín E2E), **TC-E2E-009** (Truy vết ngược 100% từ Trigger đến Outcome). |
| **OBJ-006 — Quản trị & Tuân thủ (Governance & Policy):** Ranh giới thẩm quyền nghiêm ngặt, chính sách an toàn, ghi vết kiểm toán toàn diện. | BR-001..010, NFR-001..010 | [API & Tích hợp](platform/api-and-integrations.md), [Dữ liệu](platform/data-and-knowledge.md), [Lộ trình](delivery/mvp-and-roadmap.md) | **TC-E2E-002..009** (Kiểm soát phê duyệt, toàn vẹn giá sàn, bảo mật danh tính, chống trùng Idempotency, chặn vượt quyền DENY, triệt tiêu thiếu consent, báo lỗi connector trung thực, truy vết ngược 100%). |

## 7. Đã hợp nhất các nguồn như thế nào?

| Nguồn | Ý được giữ | Cách điều chỉnh |
|---|---|---|
| Đề bài SRS v0.1 (`AI-REV-SRS-001`) | 6 Business Objectives (OBJ-001..006), 6 Cổng Gate (P0–P5), Bộ kiểm thử TC-E2E-001..009, 5 Giả định ASM-001..005, DoD 10 thành tố thực tế | Chuẩn hóa toàn bộ cấu trúc quy hoạch, ma trận đối chiếu và điều kiện nghiệm thu |
| Bộ `plans/` trước lần hợp nhất này | Ba mô-đun độc lập; API hai chiều; dữ liệu riêng từng doanh nghiệp; người duyệt; chống xử lý trùng; xác nhận từ hệ thống gốc | Gộp phần lặp, dịch phần tiếng Anh, giữ ràng buộc kỹ thuật và tiêu chí kiểm chứng |
| [Báo cáo PDF](../BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf), trang 1–2 | Giảm thao tác, giảm bị làm phiền, tư vấn theo nhu cầu, tạo niềm tin | Dùng ba nhóm động cơ mua làm giả thuyết nghiên cứu; không coi tuổi hay tỷ lệ trong báo cáo là dữ liệu khảo sát |
| PDF, trang 2–4 | Ưu đãi từ chi phí thực sự tiết kiệm; máy chủ kiểm soát giá sàn | Bổ sung chi phí AI, đối tác, vận hành và rủi ro; không cam kết lợi nhuận hay an toàn tuyệt đối |
| PDF, trang 4–5 | Giải thích thông số dễ hiểu; so sánh nâng cấp; phiếu bù giá; chọn nhanh; lưu món; theo dõi đơn | Phân kỳ theo độ rủi ro, yêu cầu bằng chứng và dữ liệu kết nối |
| PDF, trang 5–6 | Giao diện nhúng nhẹ; điều phối hiển thị; đồng ý nhận tin; QR; chuyển nhân viên | Bộ giao diện là tùy chọn, không thay lõi máy chủ; không hứa mọi ngân hàng mở được, phí bằng 0 hoặc thanh toán trong 3 giây |
| PDF, kết luận trang 6 | Soát giỏ hàng, can ngăn mua đắt, xem video mở hộp | Hai ý đầu là thử nghiệm tư vấn; video chỉ xem xét sau, không tự quyết đổi trả |
| [Tài liệu nghiên cứu thị trường](../research/market_research.md), mục I–XXI | Nhu cầu thật, tín hiệu sớm, nơi tập trung khách, giải pháp, thời điểm và lợi thế có bằng chứng | Đưa thành phiếu cơ hội có nguồn, giả thuyết, phép thử và tiêu chí dừng |
| Tài liệu thị trường, mục XXII–XXVIII | Bốn vai trò Tiếp thị; đối tác; mua lại; giới thiệu | Bốn vai trò nghiệp vụ trong một mô-đun; thử thủ công trước khi tự động hóa |

### Những thay đổi có chủ ý so với kế hoạch cũ

1. **Mô hình kinh doanh B2B SaaS & Khách hàng mỏ neo đầu tiên**: Hệ thống được kiến trúc theo dạng B2B SaaS đa doanh nghiệp (Multi-tenant) để mở rộng cho $N$ khách hàng. Thí điểm mỏ neo (Anchor Pilot) đầu tiên là doanh nghiệp B2C tại Đài Loan kinh doanh Hàng tiêu dùng (FMCG) và Xe máy điện thông minh.
2. **Chiến lược 4 bước mở rộng B2B SaaS toàn cầu**:
   - *Cơ chế Phích cắm bản địa (Plug-and-Play Adapters)*: Giữ 100% Core AI Engine & máy chủ tính giá sàn; chỉ hoán đổi 3 cổng kết nối (Chat: LINE sang WhatsApp/Widget; Thanh toán: ECPay/CVS sang Stripe/PayPal; Pháp lý: Taiwan PDPA sang GDPR/CCPA).
   - *Đóng gói 2 sản phẩm chuyên ngành (Vertical SaaS - GTM-001)*: Tách thành **GTM-001A: AgentOS Mobility** (DOM-MOB-001..004) và **GTM-001B: AgentOS FMCG** (DOM-FMCG-001..005).
   - *Phân phối quy mô qua Shopify & WooCommerce App Store (GTM-002)*: Đóng gói ứng dụng 1-chạm tiếp cận hàng trăm nghìn nhà bán lẻ quốc tế không cần sales tay.
   - *Đòn bẩy Case Study thực nghiệm Đài Loan (GTM-003)*: Dùng trực tiếp số liệu định lượng (CAC, chuyển đổi, độ trễ, chi phí AI 0,5–1 TWD/đơn ECN-003, bảo toàn biên lãi ECN-002 tại [analytics.md](delivery/analytics.md)) làm bằng chứng ROI để chào bán ra toàn cầu.
3. **Giữ Bán hàng trước, kèm Chăm sóc cơ bản**, nhưng đưa nghiên cứu thị trường thủ công lên giai đoạn chuẩn bị; chưa bật tự động Tiếp thị trong bản đầu.
4. **Thanh toán tự động, trợ cấp giá chốt nhanh và phiếu ưu đãi không vào P1.** Khách mua qua quy trình hiện tại; các tính năng này có điều kiện kiểm chứng riêng theo từng ngành hàng.
5. **Giữ phương án bán hàng B2B cần tư vấn** như cấu hình thay thế: nhu cầu, ngân sách, người quyết định, thời điểm, lịch hẹn và báo giá. Không ép bộ câu hỏi B2B lên người mua lẻ.
6. **Không dùng lại các kết luận tuyệt đối của PDF.** “Độc bản”, “100% lợi nhuận”, “100% chống hack”, “phiếu mua hàng không tốn tiền” đều chưa có bằng chứng để khẳng định.
7. **Không coi dẫn chiếu pháp lý cũ là chứng nhận tuân thủ.** Phần [API và bảo vệ dữ liệu](platform/api-and-integrations.md#section-16) bổ sung nguồn chính thức và bước rà soát trước vận hành.
8. Bỏ liên kết Atlas khỏi mục lục này vì không có tệp `atlas/index.html` trong thư mục làm việc đã kiểm tra. Không sửa hay xóa tài liệu ngoài `plans/`.

## 8. Cách cập nhật về sau

1. Đổi phạm vi tại [bản đầu và lộ trình](delivery/mvp-and-roadmap.md), ghi lý do và người duyệt.
2. Đổi quy định tại tài liệu chịu trách nhiệm; đối chiếu dữ liệu, quyền, API và chỉ số liên quan.
3. Chạy lại bộ tình huống kiểm thử sau thay đổi cấu hình, lời hướng dẫn AI, kiến thức hoặc kết nối.
4. Cập nhật bản dễ hiểu sau cùng; không dùng nó để thay thế điều kiện bảo mật và nghiệm thu.

**Việc tiếp theo:** điền tên một doanh nghiệp và website dự kiến thử nghiệm vào [phiếu chốt đầu vào](delivery/mvp-and-roadmap.md#pilot-inputs).
