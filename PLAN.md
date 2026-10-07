# AgentOS Customer360 — Kế hoạch

Nguồn chân lý yêu cầu: [Đề bài SRS v0.1](De_bai_Xay_dung_He_thong_AI_Agent_Marketing_Sales_CSKH_v0.1.md) (AI-REV-SRS-001). Kế hoạch chi tiết đã được tách vào thư mục [plans/](plans/README.md).

1. [Đọc luồng dễ hiểu, dành cho người không chuyên kỹ thuật](plans/plan-easy-read-flow.md).
2. [Mở mục lục kế hoạch chi tiết](plans/README.md).
3. [Tra thuật ngữ chuyên ngành](plans/glossary.md).
4. [Mở mục lục tài liệu sản phẩm](docs/product/README.md), kiến trúc ([docs/architecture/README.md](docs/architecture/README.md)), đặc tả ([docs/specifications/README.md](docs/specifications/README.md)), vận hành ([docs/operations/README.md](docs/operations/README.md)), quyết định ([docs/decisions/README.md](docs/decisions/README.md)) và tham chiếu ([docs/reference/README.md](docs/reference/README.md)).

Ba module Marketing, Sales và Customer Support kết nối với ứng dụng, dữ liệu hiện có của doanh nghiệp qua API. Doanh nghiệp có thể chọn một hoặc nhiều module, dùng chung phần lõi nhưng tách riêng dữ liệu và cấu hình.

Trạng thái: bộ kế hoạch vẫn là tài liệu định hướng sản phẩm; runtime hiện tại gồm API, worker chạy các agent Care/Sales/Marketing, hai console Tenant Console và Platform Admin, cùng các migration PostgreSQL. Các giả định ASM-001..005 chưa khóa.
