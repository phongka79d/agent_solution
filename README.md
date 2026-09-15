# AgentOS Customer360 — Bộ 3 Trợ Lý AI Thương Mại Điện Tử Toàn Diện

## Tóm Tắt Dự Án (Executive Summary)

AgentOS Customer360 là giải pháp phần mềm B2B SaaS cung cấp bộ 3 trợ lý trí tuệ nhân tạo (AI Agents) chuyên biệt cho doanh nghiệp thương mại điện tử (E-Commerce):
- **Tiếp Thị (Marketing Agent)**: Nghiên cứu tín hiệu thị trường, tìm kiếm khách hàng tiềm năng, nuôi dưỡng nhận diện thương hiệu và tiếp nhận nhu cầu.
- **Bán Hàng (Sales Agent)**: Tư vấn thông minh, phân tích đối chiếu thông số sản phẩm, hỗ trợ cấu hình giỏ hàng và chốt đơn có kiểm soát giá sàn tự động.
- **Chăm Sóc Khách Hàng (Customer Support Agent)**: Hỗ trợ sau bán hàng 24/7, tra cứu vận đơn, xử lý sự cố, kích hoạt chu kỳ bảo dưỡng - mua lại và tạo vòng lặp khách hàng trung thành.

Hệ thống được thiết kế theo kiến trúc đa người dùng (Multi-tenant) dùng chung lõi điều phối thông minh (Core AI Engine) và hồ sơ khách hàng 360 độ (Customer360), tích hợp thông qua cơ chế Adapter bản địa hóa (Plug-and-Play Adapters). Thí điểm mỏ neo (Anchor Pilot) đầu tiên được thiết kế cho doanh nghiệp B2C kinh doanh Hàng tiêu dùng (FMCG) và Xe máy điện thông minh (Mobility), sẵn sàng mở rộng quy mô quốc tế qua Shopify và WooCommerce App Store.

---

## Cấu Trúc Thư Mục Dự Án (Directory Tree)

```text
agent_solution/
├── README.md                                  # Trang chủ điều hướng tổng thể dự án
├── PLAN.md                                    # Chỉ mục chuyển tiếp kế hoạch gốc
├── AGENT_NGIEN_CUU_THI_TRUONG.md              # Chỉ mục chuyển tiếp tài liệu nghiên cứu thị trường
├── BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf    # Báo cáo đề án tổng quan (bản PDF in 6 trang)
├── presentation/                              # Mã nguồn và công cụ xuất bản thuyết trình
│   ├── index.html                             # Giao diện HTML chuẩn A4 thiết kế báo cáo thuyết trình
│   └── export_pdf.py                          # Script tự động biên dịch HTML thành PDF
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
│       ├── mvp-and-roadmap.md                 # Lộ trình 6 cổng kỹ thuật P0-P5, tiêu chuẩn hoàn thành DoD và bộ test TC-E2E-001..009
│       └── analytics.md                       # Hệ thống KPI 5 nhóm theo SRS Mục 20, ngân sách AI 0,5-1 TWD và bảo toàn biên lãi
└── reports/                                   # Nhật ký làm việc và báo cáo thẩm định định kỳ
    ├── 09-09-2026/
    │   └── daily-report.md                    # Báo cáo tiến độ và thống nhất định hướng ngày 09/09/2026
    └── 10-09-2026/
        └── .gitkeep                           # Thư mục lưu trữ báo cáo các phiên tiếp theo
```

---

## Bảng Điều Hướng Nhanh (Quick Navigation)

| Tài Liệu / Hạng Mục | Đường Dẫn Tương Đối | Định Dạng | Mô Tả Trọng Tâm |
|---|---|---|---|
| Báo Cáo Đề Án Thuyết Trình | [BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf](BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf) | PDF (6 Trang) | Đề án tóm lược trực quan dành cho ban lãnh đạo và đối tác |
| Giao Diện Thuyết Trình | [presentation/index.html](presentation/index.html) | HTML5 / CSS A4 | Mã nguồn giao diện thiết kế báo cáo thuyết trình chuẩn A4 |
| Bộ Kế Hoạch 3 Module | [plans/README.md](plans/README.md) | Markdown | Mục lục điều phối toàn bộ 11 tài liệu kế hoạch chi tiết |
| Luồng Đọc Dễ Hiểu | [plans/plan-easy-read-flow.md](plans/plan-easy-read-flow.md) | Markdown | Bản tóm lược 5 phút dành cho người không chuyên kỹ thuật |
| Nghiên Cứu Thị Trường | [research/market_research.md](research/market_research.md) | Markdown | 28 mục chiến lược sản phẩm, khách hàng mục tiêu và thị trường |
| Gói Sản Phẩm & Định Giá | [plans/product-and-packaging.md](plans/product-and-packaging.md) | Markdown | Chiến lược B2B SaaS, gói sản phẩm Mobility & FMCG, mô hình doanh thu |
| Kiến Trúc Kỹ Thuật | [plans/platform/architecture.md](plans/platform/architecture.md) | Markdown | Thiết kế kiến trúc tổng thể, cơ chế Adapter và giao diện nhúng |
| Lộ Trình & Tiêu Chí Nghiệm Thu | [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md) | Markdown | 6 Cổng kỹ thuật P0–P5, DoD 10 thành tố và bộ kiểm thử E2E (TC-E2E-001..009) |
| Kinh Tế Đơn Vị & Đo Lường | [plans/delivery/analytics.md](plans/delivery/analytics.md) | Markdown | Hệ thống KPI SRS Mục 20, ngân sách AI 0,5–1 TWD/phiên và bảo toàn biên lãi |
| Báo Cáo Thẩm Định Định Kỳ | [reports/09-09-2026/daily-report.md](reports/09-09-2026/daily-report.md) | Markdown | Nhật ký làm việc và báo cáo tiến độ định kỳ |

---

## Ma Trận Đối Chiếu Mục Tiêu & Nghiệm Thu (Traceability Matrix theo SRS Mục 25)

| Mục Tiêu Kinh Doanh | Nhóm Yêu Cầu SRS | Tài Liệu Phụ Trách | Tiêu Chí Kiểm Chứng Chính |
|---|---|---|---|
| **OBJ-001 — Tiếp thị (Marketing)** | MKT-001..005, FR-MKT-* | [plans/modules/marketing.md](plans/modules/marketing.md) | **PILOT-01** (Marketing → Sales), **TC-E2E-002** (Kiểm soát phê duyệt Human Approval) |
| **OBJ-002 — Bán hàng (Sales)** | FR-SAL-001..007 | [plans/modules/sales.md](plans/modules/sales.md) | **PILOT-02** (Phục hồi giỏ hàng), **TC-E2E-003** (Toàn vẹn giá sàn ERP), **TC-E2E-005** (Chống tạo đơn trùng - Idempotency) |
| **OBJ-003 — Chăm sóc khách hàng (Customer Care)** | FR-CS-001..002 | [plans/modules/customer-support.md](plans/modules/customer-support.md) | **PILOT-03** (Tra cứu đơn ERP), **PILOT-04** (Xử lý khiếu nại), **TC-E2E-004** (Xác minh danh tính) |
| **OBJ-004 — Khách hàng thành công & Giữ chân (Retention)** | FR-CS-003 | [plans/modules/customer-support.md](plans/modules/customer-support.md), [plans/customer-lifecycle.md](plans/customer-lifecycle.md) | Quy trình giữ chân (Retention Workflow), Vòng lặp tích điểm đơn 2, Phân tích nguy cơ rời bỏ |
| **OBJ-005 — Điều phối đa Agent (Revenue Orchestration)** | FR-ORC-001..004 | [plans/platform/architecture.md](plans/platform/architecture.md), [plans/platform/workflows-and-handoffs.md](plans/platform/workflows-and-handoffs.md) | **TC-E2E-001** (Luồng tín hiệu khép kín E2E), **TC-E2E-009** (Truy vết ngược 100%) |
| **OBJ-006 — Quản trị & Tuân thủ (Governance & Policy)** | BR-001..008, NFR-001..010 | [plans/platform/api-and-integrations.md](plans/platform/api-and-integrations.md), [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md) | **TC-E2E-006** (Chặn vượt quyền - DENY), **TC-E2E-007** (Triệt tiêu liên hệ thiếu consent), **TC-E2E-008** (Báo lỗi connector trung thực) |

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
  1. [plans/platform/architecture.md](plans/platform/architecture.md): Ranh giới hệ thống, cơ chế Multi-tenant và Plug-and-Play Adapters.
  2. [plans/platform/data-and-knowledge.md](plans/platform/data-and-knowledge.md): Lược đồ dữ liệu Customer360, quyền riêng tư và RAG.
  3. [plans/platform/workflows-and-handoffs.md](plans/platform/workflows-and-handoffs.md): Quản lý phiên hội thoại, trạng thái và bàn giao nhân viên.
  4. [plans/platform/api-and-integrations.md](plans/platform/api-and-integrations.md): Đặc tả API hai chiều, bảo mật và kết nối kênh chat/thanh toán.
  5. [plans/delivery/mvp-and-roadmap.md](plans/delivery/mvp-and-roadmap.md): 6 Cổng kỹ thuật P0–P5, tiêu chuẩn hoàn thành DoD và bộ test TC-E2E-001..009.

### 4. Dành Cho Nhà Đầu Tư & Tài Chính (Investors, Finance & CFO)
- Mục tiêu: Thẩm định tính khả thi tài chính, hiệu quả đầu tư và lộ trình hoàn vốn.
- Trình tự đọc đề xuất:
  1. [plans/delivery/analytics.md](plans/delivery/analytics.md): Phân tích kinh tế đơn vị (Unit Economics), chi phí vận hành AI trên mỗi đơn hàng.
  2. [plans/product-and-packaging.md](plans/product-and-packaging.md): Cơ cấu doanh thu từ phí triển khai và phí thuê bao định kỳ.
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
