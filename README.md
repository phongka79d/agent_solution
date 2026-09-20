# AgentOS Customer360 — Bộ 3 Trợ Lý AI Thương Mại Điện Tử Toàn Diện

## Tóm Tắt Dự Án (Executive Summary)

AgentOS Customer360 là giải pháp phần mềm B2B SaaS cung cấp bộ 3 trợ lý trí tuệ nhân tạo (AI Agents) chuyên biệt cho doanh nghiệp thương mại điện tử (E-Commerce):
- **Tiếp Thị (Marketing Agent)**: Nghiên cứu tín hiệu thị trường, tìm kiếm khách hàng tiềm năng, nuôi dưỡng nhận diện thương hiệu và tiếp nhận nhu cầu.
- **Bán Hàng (Sales Agent)**: Tư vấn thông minh, đối chiếu thông số sản phẩm theo nguồn đã duyệt, hỗ trợ cấu hình giỏ hàng và chốt đơn trong giới hạn chính sách giá/khuyến mãi do ERP/POS và người có thẩm quyền phê duyệt.
- **Chăm Sóc Khách Hàng (Customer Support Agent)**: Hỗ trợ sau bán hàng 24/7, tra cứu vận đơn, xử lý sự cố, kích hoạt chu kỳ bảo dưỡng - mua lại và tạo vòng lặp khách hàng trung thành.

Hệ thống được thiết kế theo kiến trúc đa người dùng (Multi-tenant) dùng chung lõi điều phối thông minh (Core AI Engine) và hồ sơ khách hàng 360 độ (Customer360), tích hợp thông qua cơ chế Adapter bản địa hóa (Plug-and-Play Adapters). Thí điểm mỏ neo (Anchor Pilot) đầu tiên được thiết kế cho doanh nghiệp B2C kinh doanh Hàng tiêu dùng (FMCG) và Xe máy điện thông minh (Mobility), với định hướng mở rộng quy mô quốc tế qua Shopify và WooCommerce App Store (đề xuất GTM-002; chưa xác nhận theo ASM-001).

> **Trạng thái tài liệu:** Kho lưu trữ này là **bộ tài liệu thiết kế/đề xuất (blueprint)**, chưa có mã nguồn chạy thật, chưa triển khai môi trường production và **chưa có số liệu vận hành**. Mọi chỉ tiêu định lượng (KPI, chi phí AI, tỷ lệ chuyển đổi, mức giá sàn) chỉ là **mục tiêu thiết kế giả thuyết**; chỉ được xem là cam kết sau khi khóa các giả định ASM-001..005 của [đề bài SRS v0.1](De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md). ERP/POS/Web/App vẫn là **System of Record** cho sản phẩm, SKU, giá, tồn kho, khách hàng và đơn hàng. Các tệp PDF trong kho là bản xuất sinh tự động từ mã nguồn HTML, có thể chậm hơn bản Markdown/HTML mới nhất.

---

## Cấu Trúc Thư Mục Dự Án (Directory Tree)

```text
agent_solution/
├── README.md                                  # Trang chủ điều hướng tổng thể dự án
├── PLAN.md                                    # Chỉ mục chuyển tiếp kế hoạch gốc
├── De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md  # Đề bài gốc SRS v0.1 (AI-REV-SRS-001)
├── AGENT_NGIEN_CUU_THI_TRUONG.md               # Chỉ dẫn nhiệm vụ agent nghiên cứu thị trường
├── BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf    # Báo cáo đề án tổng quan (bản PDF in 6 trang)
├── DAC_TA_KY_THUAT_HE_THONG_AI_AGENT.pdf      # Bản đặc tả kỹ thuật chi tiết nền tảng (bản PDF 10 trang)
├── presentation/                              # Mã nguồn và công cụ xuất bản thuyết trình
│   ├── index.html                             # Giao diện HTML chuẩn A4 thiết kế báo cáo đề án
│   ├── tech_spec.html                         # Giao diện HTML chuẩn A4 đặc tả kỹ thuật hệ thống
│   ├── export_pdf.py                          # Script tự động biên dịch HTML thành 2 bản PDF
│   └── check_pdf_overlap.py                   # Script đối soát tràn lề và chồng lấn trang khi xuất PDF
├── implement/                                 # Bộ 10 tài liệu thi hành kỹ thuật triển khai từ đặc tả
│   ├── README.md                              # Mục lục điều hướng và thứ tự thực thi bộ tài liệu
│   ├── 01-tech-stack-and-environment.md       # Ngăn xếp công nghệ và dựng môi trường production
│   ├── 02-project-structure.md                # Cấu trúc monorepo, giới hạn gói và quy ước mã nguồn
│   ├── 03-database-and-memory-schema.md       # Lược đồ CSDL 28 thực thể, RLS và bộ nhớ AI
│   ├── 04-core-engine-and-orchestrator.md     # Lõi điều phối 11 bước và workflow bền vững
│   ├── 05-skill-system-specifications.md      # Hệ thống kỹ năng và hợp đồng 11 trường
│   ├── 06-api-and-connectors-spec.md          # Hợp đồng API-001..003 và adapter cắm-rút
│   ├── 07-human-command-center-ui.md          # Command Center SCR-001..005 và widget nhúng
│   ├── 08-security-governance-nfr.md          # PEP, Authority, BR-001..010 và NFR-001..010
│   └── 09-sprint-roadmap-and-pilots.md        # Lộ trình sprint, kịch bản pilot và CI/CD
├── testcases/                                 # Đặc tả chấp nhận 383 ca (chưa có runtime; NOT_RUN)
│   ├── README.md                              # Chiến lược pyramid, mock vs sandbox, cách sinh
│   ├── TRACEABILITY.md                        # Ma trận ID ca → yêu cầu/facet
│   ├── COVERAGE.md                            # Ma trận ngược yêu cầu/facet → ca, khoảng trống
│   ├── manifest.json                          # Số lượng, hash nguồn, trạng thái NOT_RUN
│   ├── _generate.py                           # Bộ sinh + kiểm tra stdlib
│   ├── sources/                               # Nguồn ca viết tay (business/governance/platform)
│   ├── fixtures/offline/                      # JSON SoR giả lập
│   ├── fixtures/live/                         # env.example sandbox (ASM-001)
│   ├── fixtures/scenarios/                    # Bản JSON từng ca
│   ├── unit/                                  # Skills, AUTH, BR, KB, thực thể
│   ├── integration/                           # API, C360, FSM, SCR, điều phối
│   ├── e2e/                                   # Hành trình then chốt offline.md + live.md
│   ├── governance/                            # NFR, ASM, KPI, cổng, DoD, phê duyệt
│   └── platform/                              # Bản đồ phủ KB/memory và thực thể
├── research/                                  # Tài liệu nghiên cứu thị trường và người dùng
│   └── market_research.md                     # Khung chiến lược sản phẩm, phân tích thị trường chi tiết
├── plans/                                     # Toàn bộ hồ sơ quy hoạch kiến trúc và kế hoạch nghiệp vụ
│   ├── README.md                              # Mục lục chi tiết và nguyên tắc hợp nhất kế hoạch
│   ├── plan-easy-read-flow.md                 # Luồng tổng quan nghiệp vụ dành cho người không chuyên
│   ├── customer-lifecycle.md                  # Hành trình khách hàng từ tín hiệu đến mua lại
│   ├── product-and-packaging.md               # Mô hình kinh doanh B2B SaaS, gói giải pháp và định giá
│   ├── glossary.md                            # Bảng giải nghĩa thuật ngữ chuyên ngành
│   ├── modules/                               # Đặc tả chi tiết 3 module trợ lý AI
│   │   ├── marketing.md                       # Module Tiếp thị: Tín hiệu, tiếp nhận, nuôi dưỡng lead
│   │   ├── sales.md                           # Module Bán hàng: Tư vấn, so sánh cấu hình, chốt đơn
│   │   └── customer-support.md                # Module CSKH: Hỗ trợ, bảo hành, vòng lặp tích điểm
│   ├── platform/                              # Hạ tầng kỹ thuật nền tảng
│   │   ├── architecture.md                    # Kiến trúc lõi, ranh giới hệ thống và giao diện nhúng
│   │   ├── data-and-knowledge.md              # Mô hình dữ liệu Customer360, RAG và tri thức sản phẩm
│   │   ├── workflows-and-handoffs.md          # Luồng công việc, trạng thái bền vững và bàn giao người
│   │   └── api-and-integrations.md            # Hợp đồng API, cổng kết nối và chính sách bảo mật
│   └── delivery/                              # Kế hoạch bàn giao và kiểm chứng
│       ├── mvp-and-roadmap.md                 # Lộ trình trục kép (Engineering P0-P5 & Commercial Phase 1-3), DoD 10 thành tố và bộ test TC-E2E-001..009
│       └── analytics.md                       # Hệ thống KPI 5 nhóm theo SRS Mục 20, động lực kinh tế ECN-001..004, ngân sách AI mục tiêu 0,5-1 TWD (chờ baseline) và mục tiêu bảo toàn biên lãi
└── reports/                                   # Nhật ký làm việc và báo cáo thẩm định định kỳ
    ├── AUDIT_DE_BAI_VS_KE_HOACH.md            # Báo cáo thẩm định đối chiếu đề bài SRS và kế hoạch
    ├── 09-09-2026/
    │   └── daily-report.md                    # Báo cáo tiến độ và thống nhất định hướng ngày 09/09/2026
    └── 10-09-2026/
        └── .gitkeep                           # Thư mục lưu trữ báo cáo các phiên tiếp theo
```

---

## Mô Hình Phân Tầng 3 Lớp (The 3-Tier Separation Architecture)

Nhằm giải quyết triệt để sự giằng co giữa khung gầm kỹ thuật chuẩn hóa phần mềm và kịch bản kinh doanh thực chiến, toàn bộ dự án được phân định rành mạch theo cấu trúc 3 tầng:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ TẦNG 3: DOMAIN PLAYBOOKS & PACKAGING (Bản Đóng Gói Ngành Dọc & GTM)   │
│ - GTM-001A: AgentOS Mobility Edition (Xe điện O2O, DOM-MOB-001..004)   │
│ - GTM-001B: AgentOS FMCG Edition (Bán lẻ tiêu dùng, DOM-FMCG-001..005) │
│ - GTM-002: Phân phối 1-chạm qua Shopify & WooCommerce App Store        │
│ - GTM-003: Đòn bẩy kết quả đo lường sau khóa baseline (đề xuất)        │
│ - Cổng kết nối cắm-rút: ADPT-TW-001 (Đài Loan) & ADPT-GL-001..003      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Cấu hình & Kế thừa
┌───────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 2: COMMERCIAL ENGINE & ECONOMICS (Động Lực Kinh Tế Đơn Vị)        │
│ - ECN-001: Tái phân bổ hoa hồng bán hàng/telesales 5–10% thành trợ cấp │
│ - ECN-002: Kiểm tra giá sàn P_floor (mục tiêu thiết kế, chờ baseline)  │
│ - ECN-003: Định mức chi phí AI 0,5–1 TWD/phiên (mục tiêu, chờ baseline)│
│ - ECN-004: Ngân sách điểm thưởng, trần Basket Cap & chống gian lận     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Vận hành trên nền tảng
┌───────────────────────────────────▼────────────────────────────────────┐
│ TẦNG 1: SYSTEM BLUEPRINT & PLATFORM SPEC (Khung Gầm Kỹ Thuật SRS v0.1) │
│ - Revenue Orchestrator 11 bước (SIGNAL ➔ DECISION ➔ EVIDENCE ➔ OUTCOME)│
│ - 13 Internal Sub-Agents (MKT-01..06, SAL-01..05, CS-01..02)          │
│ - Mô hình thẩm quyền 6 cấp (AUTH-0..5) & 10 Quy tắc nghiệp vụ BR-001..010│
│ - Knowledge Base 21 tệp/8 thư mục (/company, /product..) & 5 tầng AI Memory│
│ - Human Command Center 5 màn hình quản trị (SCR-001..SCR-005)          │
│ - 10 Yêu cầu phi chức năng (NFR-001..010) & 9 Test E2E (TC-E2E-001..009)│
│ - Lộ trình kỹ thuật 6 Cổng Gate (P0–P5) & 5 Giả định (ASM-001..005)    │
└────────────────────────────────────────────────────────────────────────┘
```

> *Ghi chú:* Các mã ECN-*, GTM-*, DOM-*, ADPT-* trong sơ đồ là **đề xuất thiết kế**, chưa có số liệu vận hành hoặc phê duyệt thương mại. Gói adapter Đài Loan (ADPT-TW-001) là **tùy chọn** khi phục vụ thị trường Đài Loan, không phải thành phần bắt buộc của lõi. Giá bán, discount và tồn kho vẫn do ERP/POS/Web/App (SoR) cùng chính sách đã được chủ sở hữu phê duyệt quyết định; P_floor chỉ là phép kiểm tra chính sách tùy chọn.

---

## Bảng Danh Mục Mã Hiệu Toàn Hệ Thống (Master Code Taxonomy)

Hệ thống phân định rành mạch giữa 2 nhóm mã hiệu: Nhóm SRS (quy chuẩn kỹ thuật phần mềm chuẩn) và Nhóm Proprietary (giải pháp thương mại, kinh tế và ngành dọc độc quyền):

### 1. Nhóm SRS (Software Requirements Specification — Kỹ thuật Phần mềm)

| Tiền tố / Nhóm mã | Tên nhóm danh mục | Phạm vi định danh chi tiết | Tài liệu chịu trách nhiệm |
|---|---|---|---|
| **OBJ-001..006** | Mục tiêu kinh doanh hệ thống | 6 Mục tiêu nền tảng: Marketing (001), Sales (002), Care (003), Retention (004), Orchestration (005), Governance (006) | [README.md](README.md), [plans/README.md](plans/README.md) |
| **MKT-01..06** | Sub-Agents Tiếp thị | 6 Vai trò nội bộ: MKT-01 (Strategist), MKT-02 (Audience), MKT-03 (Content), MKT-04 (Brand Guardian), MKT-05 (Campaign), MKT-06 (Analyst) | [plans/modules/marketing.md](plans/modules/marketing.md) |
| **SAL-01..05** | Sub-Agents Bán hàng | 5 Vai trò nội bộ: SAL-01 (Qualification), SAL-02 (Advisor), SAL-03 (Recommendation), SAL-04 (Cart Recovery), SAL-05 (Replenishment) | [plans/modules/sales.md](plans/modules/sales.md) |
| **CS-01..02** | Sub-Agents Chăm sóc & Giữ chân | 2 Vai trò nội bộ: CS-01 (Omnichannel Care), CS-02 (Retention / Customer Success) | [plans/modules/customer-support.md](plans/modules/customer-support.md) |
| **FR-*** | Yêu cầu chức năng cốt lõi | FR-C360-001..003 (Customer 360), FR-SAL-001..003 (Sales), FR-CS-001..003 (Care), FR-ORC-001..002 (Orchestrator) | [plans/platform/architecture.md](plans/platform/architecture.md), [plans/platform/data-and-knowledge.md](plans/platform/data-and-knowledge.md) |
| **AUTH-0..5** | Cấp độ thẩm quyền AI | 6 Mức kiểm soát: AUTH-0 (Observe), AUTH-1 (Recommend), AUTH-2 (Draft), AUTH-3 (Bounded Execute), AUTH-4 (Approval Required), AUTH-5 (Prohibited) | [plans/platform/workflows-and-handoffs.md](plans/platform/workflows-and-handoffs.md) |
| **BR-001..010** | Quy tắc kinh doanh bắt buộc | 10 Ràng buộc toàn vẹn: Không tự định giá, bảo toàn giá sàn ERP, kiểm tra consent, chống trùng Idempotency, cấm vượt quyền... | [plans/platform/workflows-and-handoffs.md](plans/platform/workflows-and-handoffs.md), [plans/modules/sales.md](plans/modules/sales.md) |
| **SCR-001..005** | Màn hình Command Center | 5 Giao diện quản trị: SCR-001 (Executive Dashboard), SCR-002 (Agent Operations), SCR-003 (Approval Center), SCR-004 (Customer 360), SCR-005 (Conversation Console) | [plans/platform/architecture.md](plans/platform/architecture.md) |
| **NFR-001..010** | Yêu cầu phi chức năng | 10 Chuẩn chất lượng: Security, Auditability, Idempotency, Availability, Explainability, Data Isolation, Human Override, Fail Closed, Performance, Cost | [plans/platform/api-and-integrations.md](plans/platform/api-and-integrations.md) |
| **TC-E2E-001..009**| Kiểm thử chấp nhận hệ thống | 9 Ca kiểm thử E2E: Luồng tín hiệu khép kín, kiểm soát phê duyệt, toàn vẹn giá sàn, bảo mật danh tính, chống trùng lặp, chặn vượt quyền... | [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md) |
| **ASM-001..005** | Giả định khóa trước Production | 5 Giả định bắt buộc: Cổng kết nối, KPI baseline, ngưỡng discount, duyệt hoàn tiền, chính sách lưu trữ Customer360 | [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md) |
| **P0..P5** | Cổng kỹ thuật lộ trình | 6 Cổng nghiêm ngặt: P0 (Foundation), P1 (Care), P2 (Sales), P3 (Marketing), P4 (Cross-domain), P5 (Controlled Autonomy) | [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md) |
| **KPI-*** (5 nhóm) | Bộ chỉ số đo lường hiệu quả | 32 nhóm chuẩn theo SRS Mục 20 (MKT-KPI-01..07, SAL-KPI-01..07, CS-KPI-01..06, SUC-KPI-01..05, AI-SYS-KPI-01..07) cộng các mã mở rộng độc quyền SAL-KPI-08, SUC-KPI-06..07, AI-SYS-KPI-08..10. Hai chỉ số AI-SYS-KPI-03 (vi phạm chính sách) và AI-SYS-KPI-07 (thực thi trùng lặp) là bất biến bắt buộc = 0, không chờ baseline. | [plans/delivery/analytics.md](plans/delivery/analytics.md) |

### 2. Nhóm Proprietary (Commercial, Economics & Domain Playbooks — Độc quyền)

| Tiền tố / Nhóm mã | Tên nhóm danh mục | Phạm vi định danh chi tiết | Tài liệu chịu trách nhiệm |
|---|---|---|---|
| **ECN-001..004** | Động lực kinh tế đơn vị | ECN-001 (Tái phân bổ hoa hồng telesales 5–10%, giả định thiết kế), ECN-002 (Phép kiểm tra giá sàn P_floor — mục tiêu thiết kế, không thay thế nguồn giá ERP/SoR), ECN-003 (Định mức chi phí AI 0,5–1 TWD/phiên — mục tiêu thiết kế), ECN-004 (Ngân sách điểm thưởng & trần Basket Cap) | [plans/delivery/analytics.md](plans/delivery/analytics.md) |
| **DOM-MOB-001..004** | Phân hệ ngành Xe điện O2O | DOM-MOB-001 (Bộ tính trợ cấp chính phủ theo hộ khẩu), DOM-MOB-002 (Định vị trạm pin Gogoro/Ionex bán kính 1km), DOM-MOB-003 (Đặt lịch lái thử showroom & cọc hoàn lại), DOM-MOB-004 (Giới thiệu 2 chiều Tesla & nhắc bảo dưỡng) | [plans/modules/sales.md](plans/modules/sales.md), [plans/modules/customer-support.md](plans/modules/customer-support.md) |
| **DOM-FMCG-001..005** | Phân hệ ngành Hàng tiêu dùng | DOM-FMCG-001 (Giỏ hàng thông minh & soát giỏ chống mua thừa), DOM-FMCG-002 (Giao định kỳ Subscription 定期購 áp giá sàn P_floor), DOM-FMCG-003 (Bản đồ chọn điểm nhận 7-Eleven CVS COD TTL 10p), DOM-FMCG-004 (Tích điểm tiến độ LINE Points), DOM-FMCG-005 (Bộ tứ định danh chống clone acc & bùng hàng CVS — dữ liệu định danh nhạy cảm, chỉ dùng sau khi Data/Legal phê duyệt theo ASM-005) | [plans/modules/sales.md](plans/modules/sales.md), [plans/modules/customer-support.md](plans/modules/customer-support.md) |
| **ADPT-TW-001** | Gói Adapter Đài Loan (tùy chọn) | Đề xuất tích hợp bản địa Đài Loan khi phục vụ thị trường này: LINE OA + ECPay/NewebPay/LINE Pay + 7-Eleven/FamilyMart CVS COD + Taiwan PDPA GCP Changhua/AWS Taipei (chờ chốt theo ASM-001/ASM-005) | [plans/platform/api-and-integrations.md](plans/platform/api-and-integrations.md), [plans/product-and-packaging.md](plans/product-and-packaging.md) |
| **ADPT-GL-001..003** | Cổng cắm-rút toàn cầu | ADPT-GL-001 (Communication: WhatsApp/Telegram/Web), ADPT-GL-002 (Payment: Stripe/PayPal/Apple Pay), ADPT-GL-003 (Compliance: GDPR/CCPA/PDPA) | [plans/platform/api-and-integrations.md](plans/platform/api-and-integrations.md), [plans/product-and-packaging.md](plans/product-and-packaging.md) |
| **GTM-001..003** | Chiến lược Go-To-Market | GTM-001 (Đóng gói Vertical SaaS: GTM-001A Mobility Edition, GTM-001B FMCG Edition), GTM-002 (Shopify & WooCommerce 1-Click App Store — đề xuất, chưa phát hành), GTM-003 (Đòn bẩy kết quả đo lường sau khi khóa baseline — đề xuất, chưa có số liệu) | [plans/product-and-packaging.md](plans/product-and-packaging.md) |

---

## Bảng Điều Hướng Nhanh (Quick Navigation)

| Tài Liệu / Hạng Mục | Đường Dẫn Tương Đối | Định Dạng | Mô Tả Trọng Tâm |
|---|---|---|---|
| Báo Cáo Đề Án Thuyết Trình | [BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf](BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf) | PDF (6 Trang) | Đề án tóm lược trực quan dành cho ban lãnh đạo và đối tác |
| Bản Đặc Tả Kỹ Thuật Nền Tảng | [DAC_TA_KY_THUAT_HE_THONG_AI_AGENT.pdf](DAC_TA_KY_THUAT_HE_THONG_AI_AGENT.pdf) | PDF (10 Trang) | Bản đặc tả kỹ thuật chi tiết theo đề bài SRS v0.1 (bản v0.1; còn giả định ASM-001..005 chờ khóa) |
| Giao Diện Thuyết Trình | [presentation/index.html](presentation/index.html) | HTML5 / CSS A4 | Mã nguồn giao diện thiết kế báo cáo thuyết trình chuẩn A4 |
| Giao Diện Đặc Tả Kỹ Thuật | [presentation/tech_spec.html](presentation/tech_spec.html) | HTML5 / CSS A4 | Mã nguồn giao diện thiết kế bản đặc tả kỹ thuật chuẩn A4 |
| Bộ Kế Hoạch 3 Module | [plans/README.md](plans/README.md) | Markdown | Mục lục điều phối toàn bộ 11 tài liệu kế hoạch chi tiết |
| Luồng Đọc Dễ Hiểu | [plans/plan-easy-read-flow.md](plans/plan-easy-read-flow.md) | Markdown | Bản tóm lược 5 phút dành cho người không chuyên kỹ thuật |
| Nghiên Cứu Thị Trường | [research/market_research.md](research/market_research.md) | Markdown | 28 mục chiến lược sản phẩm, khách hàng mục tiêu và thị trường |
| Gói Sản Phẩm & Định Giá | [plans/product-and-packaging.md](plans/product-and-packaging.md) | Markdown | Chiến lược B2B SaaS, gói GTM-001A/B, kênh phân phối GTM-002/003, Adapter |
| Kiến Trúc Kỹ Thuật | [plans/platform/architecture.md](plans/platform/architecture.md) | Markdown | Thiết kế kiến trúc tổng thể, Orchestrator 11 bước, Command Center SCR-001..005 |
| Lộ Trình & Tiêu Chí Nghiệm Thu | [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md) | Markdown | Lộ trình trục kép (Engineering P0–P5 & Commercial Phase 1–3), DoD 10 thành tố, TC-E2E-001..009 |
| Kinh Tế Đơn Vị & Đo Lường | [plans/delivery/analytics.md](plans/delivery/analytics.md) | Markdown | Hệ thống KPI SRS Mục 20 (mục tiêu chờ baseline ASM-002), động lực kinh tế ECN-001..004, P_floor như phép kiểm tra chính sách và mục tiêu chi phí AI |
| Báo Cáo Thẩm Định Định Kỳ | [reports/09-09-2026/daily-report.md](reports/09-09-2026/daily-report.md) | Markdown | Nhật ký làm việc và báo cáo tiến độ định kỳ |

---

## Ma Trận Đối Chiếu Mục Tiêu & Nghiệm Thu (Traceability Matrix theo SRS Mục 25)

| Mục Tiêu Kinh Doanh | Nhóm Yêu Cầu SRS | Tài Liệu Phụ Trách | Tiêu Chí Kiểm Chứng Chính |
|---|---|---|---|
| **OBJ-001 — Tiếp thị (Marketing)** | MKT-01..06 | [plans/modules/marketing.md](plans/modules/marketing.md) | **PILOT-01** (Marketing → Sales), **TC-E2E-002** (Kiểm soát phê duyệt Human Approval) |
| **OBJ-002 — Bán hàng (Sales)** | FR-SAL-001..003, SAL-01..05 | [plans/modules/sales.md](plans/modules/sales.md) | **PILOT-02** (Phục hồi giỏ hàng), **TC-E2E-003** (Giá phải lấy từ nguồn ERP có thẩm quyền và không vượt ngưỡng chính sách giá sàn), **TC-E2E-005** (Chống tạo đơn trùng - Idempotency) |
| **OBJ-003 — Chăm sóc khách hàng (Customer Care)** | FR-CS-001..003, CS-01..02 | [plans/modules/customer-support.md](plans/modules/customer-support.md) | **PILOT-03** (Tra cứu đơn ERP), **PILOT-04** (Xử lý khiếu nại & Chuyển cấp), **TC-E2E-004** (Xác minh danh tính và cô lập ngữ cảnh khách hàng A/B; cô lập tenant là yêu cầu bổ sung) |
| **OBJ-004 — Khách hàng thành công & Giữ chân (Retention)** | FR-CS-003 | [plans/modules/customer-support.md](plans/modules/customer-support.md), [plans/customer-lifecycle.md](plans/customer-lifecycle.md) | Quy trình giữ chân (Retention Workflow), Vòng lặp tích điểm đơn 2, Phân tích nguy cơ rời bỏ |
| **OBJ-005 — Điều phối đa Agent (Revenue Orchestration)** | FR-ORC-001..002 | [plans/platform/architecture.md](plans/platform/architecture.md), [plans/platform/workflows-and-handoffs.md](plans/platform/workflows-and-handoffs.md) | **TC-E2E-001** (Luồng tín hiệu khép kín E2E), **TC-E2E-009** (Truy vết ngược đầy đủ chuỗi Trigger → Context → Decision → Approval → Execution → Evidence → Outcome) |
| **OBJ-006 — Quản trị & Tuân thủ (Governance & Policy)** | BR-001..010, NFR-001..010 | [plans/platform/api-and-integrations.md](plans/platform/api-and-integrations.md), [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md) | **TC-E2E-002..009** (Định tuyến phê duyệt AUTH-4 tại SCR-003, giá từ nguồn có thẩm quyền và ngưỡng giá sàn, xác minh danh tính phía máy chủ và cô lập ngữ cảnh khách hàng A/B, chống trùng Idempotency, chặn vượt quyền, triệt tiêu thiếu consent, báo lỗi connector trung thực kèm retry và đối soát trạng thái thực thi, truy vết ngược đầy đủ chuỗi) |

---

## Hướng Dẫn Đọc Theo Vai Trò (Role-Based Reading Guide)

### 1. Dành Cho Ban Lãnh Đạo (Executive & Business Owners)
- Mục tiêu: Nắm bắt tổng quan giá trị kinh doanh, mô hình vận hành và định hướng chiến lược.
- Trình tự đọc đề xuất:
  1. [Báo cáo đề án PDF](BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf): Đọc lướt 6 trang đề án trực quan.
  2. [plans/plan-easy-read-flow.md](plans/plan-easy-read-flow.md): Bản giải thích luồng hoạt động đơn giản trong 5 phút.
  3. [plans/product-and-packaging.md](plans/product-and-packaging.md): Xem mô hình thương mại B2B SaaS và chiến lược mở rộng quốc tế.

### 2. Dành Cho Khối Nghiệp Vụ (Product Owners, Marketing, Sales, CSKH)
- Mục tiêu: Nắm vững quy trình nghiệp vụ, hành trình khách hàng và kịch bản tương tác của từng Agent.
- Trình tự đọc đề xuất:
  1. [research/market_research.md](research/market_research.md): Thấu hiểu chân dung khách hàng, vấn đề chưa giải quyết và cơ hội.
  2. [plans/customer-lifecycle.md](plans/customer-lifecycle.md): Nắm bắt vòng đời khách hàng qua 5 giai đoạn từ tín hiệu đến mua lại.
  3. [plans/modules/marketing.md](plans/modules/marketing.md): Nghiên cứu và tiếp nhận lead.
  4. [plans/modules/sales.md](plans/modules/sales.md): Quy trình tư vấn, so sánh thông số và cơ chế kiểm soát giá sàn.
  5. [plans/modules/customer-support.md](plans/modules/customer-support.md): Hỗ trợ sau bán, vòng lặp tích điểm và bảo dưỡng định kỳ.

### 3. Dành Cho Đội Ngũ Kỹ Thuật (Architects, Tech Leads, Developers)
- Mục tiêu: Triển khai hạ tầng, xây dựng API, cấu hình kho tri thức RAG và tích hợp hệ thống.
- Trình tự đọc đề xuất:
  1. [Bản đặc tả kỹ thuật PDF](DAC_TA_KY_THUAT_HE_THONG_AI_AGENT.pdf): Xem toàn bộ 10 trang đặc tả kỹ thuật kiến trúc, data model, skill contracts và kiểm toán.
  2. [plans/platform/architecture.md](plans/platform/architecture.md): Ranh giới hệ thống, cơ chế Multi-tenant và Plug-and-Play Adapters.
  3. [plans/platform/data-and-knowledge.md](plans/platform/data-and-knowledge.md): Lược đồ dữ liệu Customer360, quyền riêng tư và RAG.
  4. [plans/platform/workflows-and-handoffs.md](plans/platform/workflows-and-handoffs.md): Quản lý phiên hội thoại, trạng thái và bàn giao nhân viên.
  5. [plans/platform/api-and-integrations.md](plans/platform/api-and-integrations.md): Đặc tả API hai chiều, bảo mật và kết nối kênh chat/thanh toán.
  6. [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md): 6 Cổng kỹ thuật P0–P5, tiêu chuẩn hoàn thành DoD và bộ test TC-E2E-001..009.

### 4. Dành Cho Nhà Đầu Tư & Tài Chính (Investors, Finance & CFO)
- Mục tiêu: Thẩm định tính khả thi tài chính, hiệu quả đầu tư và lộ trình hoàn vốn.
- Trình tự đọc đề xuất:
  1. [plans/delivery/analytics.md](plans/delivery/analytics.md): Mô hình minh họa kinh tế đơn vị (Unit Economics) và mục tiêu chi phí vận hành AI trên mỗi đơn hàng — chưa có số liệu vận hành, phải khóa baseline (ASM-002/ASM-003) trước khi dùng để quyết định.
  2. [plans/product-and-packaging.md](plans/product-and-packaging.md): Cấu trúc thương mại 3 tầng đề xuất (phí nền tảng định kỳ, mức sử dụng AI, công triển khai) và các gói ngành dọc — chưa chốt giá; kinh tế ưu đãi và adapter Đài Loan là tùy chọn.
  3. [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md): Lộ trình 6 cổng kỹ thuật P0–P5 từ mỏ neo Đài Loan đến phát hành toàn cầu.

---

## Hướng Dẫn Biên Dịch Báo Cáo PDF Từ Mã Nguồn

Báo cáo đề án PDF được lưu trữ cùng mã nguồn giao diện HTML tại thư mục `presentation/`. Có thể tái biên dịch báo cáo sang tệp PDF chuẩn trang in A4 bất kỳ lúc nào bằng script tự động hóa.

### Yêu Cầu Môi Trường
- Python 3.8 trở lên.
- Trình duyệt Google Chrome hoặc Microsoft Edge đã cài đặt trên hệ thống.

### Cách Thực Hiện
Chạy lệnh sau từ thư mục gốc của dự án:

```powershell
python presentation/export_pdf.py
```

Script sẽ tự động tìm kiếm trình duyệt tương thích, biên dịch tệp `presentation/index.html` và xuất bản trực tiếp vào `BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf` tại thư mục gốc của dự án.
