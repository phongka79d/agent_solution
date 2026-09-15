# Kiến trúc và điều phối nền tảng

[Mục lục](../README.md) · [Dữ liệu](data-and-knowledge.md) · [Quy trình](workflows-and-handoffs.md) · [API](api-and-integrations.md)

Trạng thái: Bản thiết kế khung gầm kỹ thuật (Platform Blueprint) độc lập thị trường, phân tách hai tầng Core Engine và Plug-and-Play Adapters.

<a id=section-5></a>

## 1. Bộ điều phối doanh thu (Revenue Orchestrator)

Revenue Orchestrator là tầng điều phối trung tâm vận hành chuỗi giá trị khép kín độc lập với mô hình LLM cụ thể. Mọi tương tác trong hệ thống đều tuân thủ chu trình 11 bước E2E:

```
[1. SIGNAL]       -> Nhận tín hiệu thời gian thực từ Web/App, POS hoặc cổng tương tác
       ↓
[2. CONTEXT]      -> Truy xuất Customer 360, kiểm tra consent và ranh giới quyền hạn
       ↓
[3. HYPOTHESIS]   -> AI phân tích nhu cầu, dự đoán chuyển đổi và chấm điểm cơ hội
       ↓
[4. DECISION]     -> Xác định mục tiêu kinh doanh, định tuyến Agent chuyên trách (FR-ORC-001)
       ↓
[5. PLAN]         -> Thiết lập kịch bản phối hợp đa Agent (FR-ORC-002), các bước và kênh
       ↓
[6. ACTION]       -> Chuẩn bị nội dung hành động, đề xuất giá sàn hoặc cấu trúc lệnh gọi tool
       ↓
[7. APPROVAL]     -> Đối soát Authority Model (AUTH-0..5); kích hoạt SCR-003 nếu là AUTH-4
       ↓
[8. EXECUTION]    -> Phát lệnh tới Plug-and-Play Adapter tương ứng kèm mã chống trùng effect_key
       ↓
[9. EVIDENCE]     -> Thu thập phản hồi xác thực từ hệ thống đích (mã giao dịch, message ID)
       ↓
[10. OUTCOME]     -> Đo lường kết quả kinh doanh thực tế (doanh thu, đơn hoàn tất, CSAT)
       ↓
[11. LEARNING]    -> Cập nhật chỉ số hiệu quả vào Learning Memory, tối ưu trọng số và prompt
```

Hệ thống nghiêm cấm các AI Agent tự do gọi trực tiếp lẫn nhau (zero direct peer-to-peer coupling). Toàn bộ giao tiếp xuyên Agent bắt buộc phải thông qua Orchestrator để đảm bảo quản trị tập trung, cô lập ngữ cảnh và tuân thủ chính sách doanh nghiệp.

### Yêu cầu điều phối cốt lõi

- **FR-ORC-001 - Routing (Định tuyến trung tâm) - MUST**:
  Orchestrator phân tích ý định khách hàng, quyết định Agent nào tiếp nhận (`marketing`, `sales`, `support`), skill nào được phép gọi, dữ liệu nào từ Customer 360 / Second Brain được truy cập, tool nào được thi hành và điều kiện phê duyệt (Authority/Approval) tương ứng.
  - Quy tắc một câu hỏi làm rõ duy nhất: Nếu ý định chưa rõ ràng, Orchestrator yêu cầu đặt đúng một câu hỏi trọng tâm duy nhất để làm rõ hoặc chuyển giao ngay cho nhân viên (SCR-005); tuyệt đối không liên tục tráo đổi Agent gây phân mảnh ngữ cảnh.
  - Cơ chế `auto`: Không phải là một Agent thứ tư mà là thuật toán phân luồng tự động của Orchestrator dựa trên ý định hội thoại.

- **FR-ORC-002 - Multi-Agent Workflow (Quy trình xuyên Agent) - MUST**:
  Orchestrator quản lý quy trình phối hợp xuyên miền (Marketing → Sales → Customer Care / Retention) với ngữ cảnh được chuyển tiếp qua bus dữ liệu tập trung:
  - *Ví dụ luồng giỏ hàng bỏ quên E2E*: Tín hiệu bỏ giỏ (`SIGNAL`) → Sales Agent phát hiện → Customer 360 nạp lịch sử và consent (`CONTEXT`) → Suy luận độ nhạy giá và nguy cơ rời bỏ (`HYPOTHESIS`) → Quyết định kích hoạt kịch bản giữ chân (`DECISION`) → Lập kế hoạch thời điểm và kênh liên hệ (`PLAN`) → Recommendation Skill chọn sản phẩm bổ trợ (`ACTION`) → Policy Engine kiểm tra ngưỡng ưu đãi/ngân sách sàn ($P_{floor}$) (`APPROVAL`) → Communication Adapter gửi tin qua kênh đã đăng ký (`EXECUTION`) → Ghi nhận phản hồi và đơn hàng đối soát (`EVIDENCE`) → Đo lường doanh thu đóng góp (`OUTCOME`) → Cập nhật trọng số mô hình vào Learning Memory (`LEARNING`).

| Yêu cầu đầu vào | Miền xử lý chính | Hành vi điều phối |
|---|---|---|
| “Tôi muốn xem có giải pháp nào phù hợp” | Marketing AI / Sales AI | Khám phá nhu cầu; nếu đã có ý định mua cụ thể chuyển Sales AI |
| “Sản phẩm này có hợp với nhu cầu của tôi không?” | Sales AI | Tư vấn, so sánh tính năng, kiểm tra tồn kho và giá thực tế qua API-001 |
| “Tôi không dùng được sản phẩm / Đơn hàng chưa tới” | Customer Care AI | Tra cứu mã đơn, trạng thái vận chuyển, hướng dẫn xử lý lỗi theo playbook |
| “Tôi muốn mua thêm / Nâng cấp gói” | Sales AI | Phân tích lịch sử mua, đề xuất cross-sell/upsell trong ngân sách sàn |
| “Tôi muốn hủy / Hoàn tiền / Gặp người thật” | Human Handoff | Chuyển ngay hàng đợi nhân viên tại SCR-005; AI dừng trả lời nghiệp vụ |
| Tín hiệu nghiên cứu thị trường nội bộ | Marketing AI | Phân tích cohort, tổng hợp báo cáo; không tự phát tán ra ngoài |

<a id=section-10></a>

## 2. Kiến trúc hai tầng: Core Engine & Plug-and-Play Adapters

Toàn bộ hệ thống được phân tách nghiêm ngặt thành hai tầng độc lập để phục vụ mô hình B2B SaaS mở rộng không giới hạn:

### Tầng 1: Lõi thông minh đa doanh nghiệp (Core Engine - Multi-tenant Platform)
Giữ nguyên 100% không đổi khi triển khai cho bất kỳ quốc gia hoặc doanh nghiệp nào:
- **Revenue Orchestrator**: Bộ điều phối chu trình 11 bước, phân loại ý định, hội thoại đa vòng, định tuyến Agent (FR-ORC-001, FR-ORC-002).
- **Máy chủ tính giá sàn toán học ($P_{floor}$)**: Kiểm soát chiết khấu tự động, trích lập ngân sách từ hoa hồng sales tiết kiệm được, bảo vệ 100% biên lãi ròng.
- **Hồ sơ khách hàng hợp nhất (Customer 360 Profile & Timeline)**: Quản lý dòng sự kiện thời gian thực (FR-C360-001, FR-C360-002) và phân định bằng chứng (FR-C360-003).
- **Công cụ tích điểm & lòng trung thành (Endowed Progress Engine)**: Quy tắc tích điểm, cấp tiến độ ảo, quản lý ưu đãi.
- **Máy trạng thái quy trình & Bàn giao (State Machine & Handoff Manager)**: Quản lý tiến trình bền vững, khóa xung đột phiên, ngăn bot tự giành quyền.
- **Bộ kiểm soát quyền hạn & Chính sách (Policy & Authority Engine)**: Thực thi mô hình phân quyền 6 cấp (AUTH-0..5) và 10 quy tắc nghiệp vụ (BR-001..BR-010).
- **Kho tri thức Second Brain & RAG**: Cấu trúc tri thức phân cấp 8 thư mục, quản lý phiên bản và phê duyệt tài liệu.

### Tầng 2: Cổng kết nối cắm-rút (Plug-and-Play Adapters)
Hoán đổi linh hoạt theo thị trường bản địa hoặc cấu hình doanh nghiệp:

1. **Cổng kết nối bản địa hóa Đài Loan (Taiwan Localization Adapter)**:
   - **ADPT-TW-001**: Tích hợp trọn gói hệ sinh thái Đài Loan gồm LINE Messaging API (LINE Official Account), LINE Login, cổng thanh toán ECPay, NewebPay, LINE Pay, API bản đồ chọn siêu thị tiện lợi (CVS COD E-Map 7-Eleven / FamilyMart) và cụm máy chủ tuân thủ Taiwan PDPA tại GCP Changhua / AWS Taipei.
2. **Cổng giao tiếp toàn cầu (Global Communication Adapter)**:
   - **ADPT-GL-001**: WhatsApp Business Cloud API, Meta Webhooks (Messenger, Instagram Direct) và Web Chat Widget đa ngôn ngữ (i18n tự động: `en-US`, `ja-JP`, `zh-TW`, `vi-VN`).
3. **Cổng thanh toán & đối soát toàn cầu (Global Payment Adapter)**:
   - **ADPT-GL-002**: Stripe, PayPal Commerce Platform, Apple Pay, Google Pay, Klarna (BNPL) và đối soát đa tiền tệ tự động (USD, EUR, JPY, GBP).
4. **Cổng pháp lý & hạ tầng lưu trữ toàn cầu (Global Compliance & Residency Adapter)**:
   - **ADPT-GL-003**: Cấu hình lưu trữ phân vùng tuân thủ GDPR (AWS Frankfurt), CCPA/CPRA (AWS US East) và APAC PDPA (AWS Singapore), quản lý cookie và thu thập đồng ý.

## 3. Các lớp trách nhiệm hệ thống

| Lớp | Trách nhiệm | Không được làm |
|---|---|---|
| Kênh tương tác / Storefront | Hiển thị, nhận thao tác, xác thực phiên khách theo thiết kế | Giữ khóa API doanh nghiệp, tự quyết giá hoặc trạng thái thanh toán |
| Cổng API và sự kiện | Xác thực bên gọi, gắn phạm vi doanh nghiệp (`tenant_id`), kiểm tra quyền, chống trùng (`effect_key`) | Tin mã doanh nghiệp/khách chỉ vì có trong nội dung gửi lên |
| Điều phối và mô-đun (Core) | Hiểu nhu cầu, tạo câu trả lời/đề xuất từ nguồn Second Brain cho phép | Cấp quyền hoặc xác nhận hành động chưa xảy ra |
| Quy trình và quy tắc máy chủ | Phê duyệt, giá sàn ($P_{floor}$), trạng thái, hẹn giờ, giới hạn, người phụ trách | Giao quyết định rủi ro tài chính chỉ cho mô hình AI |
| Bộ kết nối Adapters | Đọc/ghi đúng API đích, ánh xạ trường, xử lý lỗi mạng, trả bằng chứng xác thực | Cho AI truy cập trực tiếp cơ sở dữ liệu doanh nghiệp |
| Dữ liệu dùng chung | Liên kết khách, hội thoại, quy trình, bằng chứng và nhật ký kiểm toán | Thay nguồn gốc của giá, đơn hoặc thanh toán |
| Command Center | Cấu hình, hàng đợi duyệt, tiếp quản phiên, tra lỗi và báo cáo vận hành | Cho người không có vai trò duyệt thao tác rủi ro |

Luồng thực thi chuẩn: Ngữ cảnh được phép → AI đề xuất → Máy chủ kiểm tra quyền/quy tắc → Adapter thực hiện lệnh → Kiểm chứng kết quả → Phản hồi → Lưu bằng chứng (Evidence Record).

## 4. Đặc tả 5 màn hình Human Command Center

Hệ thống thiết kế 5 màn hình chỉ huy nội bộ thống nhất phục vụ giám sát, can thiệp và kiểm soát rủi ro:

- **SCR-001 - Executive Dashboard**:
  Tổng quan chỉ số kinh doanh theo thời gian thực: Doanh thu tổng (Revenue), Khách tiềm năng (Leads), Tỷ lệ chuyển đổi (Conversion), Chiến dịch đang chạy (Active Campaigns), Doanh thu do AI đóng góp (AI Generated Revenue), Trạng thái vận hành CSKH (CS Status), Tỷ lệ giữ chân (Retention Rate), Tổng số hành động AI (AI Actions), Số yêu cầu chờ duyệt (Approval Pending) và Cảnh báo bất thường (Abnormal Events).
- **SCR-002 - Agent Operations**:
  Quản trị kỹ thuật Agent: Danh sách Agent online/offline, nhiệm vụ hiện tại, lịch sử lần chạy (Run history), nhật ký lỗi (Error log), tần suất gọi tool, độ trễ xử lý (Latency), mức tiêu thụ token/chi phí API thời gian thực và KPI vận hành từng Agent.
- **SCR-003 - Approval Center**:
  Trung tâm phê duyệt dành cho người quản trị với 5 thao tác chuẩn hóa: **Approve** (Duyệt), **Reject** (Từ chối), **Modify** (Chỉnh sửa nội dung/tham số trước khi chạy), **Pause** (Tạm dừng quy trình) và **Cancel** (Hủy bỏ hoàn toàn). Áp dụng bắt buộc cho mọi hành động cấp AUTH-4 (chiến dịch lớn, chiết khấu vượt trần, bồi thường, hoàn tiền, đổi chính sách).
- **SCR-004 - Customer 360**:
  Hiển thị hồ sơ khách hàng hợp nhất trên một Timeline thời gian thực thống nhất: View → Search → Click → Chat → Add to cart → Purchase → Delivery → Support → Review → Repurchase. Tích hợp thẻ bằng chứng (Evidence Card) cho từng sự kiện và phân định rõ ràng giữa sự thật (Fact) và suy diễn (Hypothesis).
- **SCR-005 - Conversation Console**:
  Giao diện theo dõi phiên chat AI - khách hàng trực tiếp. Hỗ trợ nhân viên: giám sát nội dung theo thời gian thực, **Takeover** (ngắt quyền AI ngay lập tức để nhân viên tiếp quản), **Resume** (trả quyền lại cho AI sau khi xử lý xong), sửa câu trả lời nháp (Copilot mode) và chấm điểm đánh giá chất lượng hội thoại (Human Evaluation).

## 5. Phân định ranh giới: Command Center vs Storefront Widgets

Hệ thống phân định rạch ròi giữa bảng điều khiển quản trị nội bộ và giao diện tương tác khách hàng bên ngoài:

| Tiêu chí | Human Command Center (Quản trị nội bộ) | Storefront Widgets (Tương tác khách hàng) |
|---|---|---|
| **Đối tượng sử dụng** | Quản trị viên, Trưởng nhóm kinh doanh, Nhân viên CSKH/Sales nội bộ | Khách truy cập website, người mua hàng B2C/B2B trên kênh số |
| **Môi trường & Vị trí** | Ứng dụng quản trị riêng biệt (Internal Admin Web Application) | Giao diện nhúng trên website thương mại, mobile app, hoặc LINE/WhatsApp |
| **Bảo mật & Xác thực** | Xác thực đa yếu tố (MFA), SSO doanh nghiệp, phân quyền vai trò (RBAC) nghiêm ngặt | Token phiên ngắn hạn, giới hạn ngữ cảnh khách hàng hiện tại; tuyệt đối không giữ khóa API dịch vụ |
| **Thẩm quyền & Nghiệp vụ** | Toàn quyền kiểm soát: duyệt hành động rủi ro (AUTH-4), tiếp quản phiên (Takeover), xem báo cáo tài chính | Giao tiếp hai chiều, hiển thị gợi ý, gửi câu hỏi; không có quyền tự quyết giá, không tự phê duyệt |
| **Xử lý dữ liệu** | Toàn quyền xem Customer 360, Audit Log, Fact/Hypothesis, Second Brain | Chỉ nhận câu trả lời đã được máy chủ phê duyệt; không truy cập dữ liệu thô của khách hàng khác |
| **Kiến trúc công nghệ** | Dashboard thời gian thực (WebSocket/SSE), kết nối cơ sở dữ liệu nội bộ | Web Component / Shadow DOM siêu nhẹ (< 20 KB), tải động (Lazy load), không ảnh hưởng tốc độ trang gốc |

## 6. Kiến trúc triển khai tối thiểu

Bắt đầu bằng một ứng dụng chia phần chức năng và một tiến trình nền lưu trạng thái bền vững. Không tạo microservices phân mảnh hay cơ sở dữ liệu phân tán khi chưa có nhu cầu quy mô lớn.

| Dữ liệu | Phương án khởi đầu |
|---|---|
| Liên kết khách, hội thoại, trạng thái, sự kiện, cấu hình, nhật ký | Cơ sở dữ liệu quan hệ (PostgreSQL) với truy cập cô lập theo `tenant_id` |
| Tài liệu kiến thức | Kho tệp Second Brain được kiểm soát quyền, phân cấp 8 thư mục |
| Chỉ mục tìm kiếm RAG | Dữ liệu dẫn xuất (Vector DB index theo tenant), có thể tái tạo từ tệp nguồn |
| Công việc và lịch chờ | Hàng đợi tác vụ bền vững (Redis queue); chỉ một tiến trình nắm quyền khóa bước |
| Báo cáo | Bảng tổng hợp từ dữ liệu tác vụ và nhật ký kiểm toán có sẵn |

Ưu tiên sử dụng API giao dịch hiện có của doanh nghiệp (API-001). Khi chưa có API phù hợp, sử dụng cơ chế nhập dữ liệu kiểm soát; không cam kết cắm vào mọi hệ thống chưa khảo sát.

## 7. Điều phối giao diện Storefront Widgets

Giao diện nhúng chỉ quản lý trải nghiệm hiển thị (hỏi nhanh, chat, gợi ý). Toàn bộ quyền dữ liệu, tính toán giá sàn, thanh toán và nhật ký kiểm toán bắt buộc phải xử lý tại Core Engine.

| Quy tắc giao diện Storefront | Cách thức áp dụng |
|---|---|
| Không hiển thị chồng chéo | Khi người dùng mở hộp thoại chat hoặc giỏ hàng, tự động ẩn các banner gợi ý tiếp thị |
| Giới hạn tần suất bật | Tối đa một gợi ý tự bật/24 giờ/thiết bị; không sử dụng theo dõi ngầm xuyên thiết bị khi chưa có consent |
| Dễ đóng, không ép buộc | Luôn có nút đóng rõ ràng; không chặn thao tác mua sắm hoặc ép nhập số điện thoại khi chỉ xem hàng |
| Vùng an toàn di động | Không che khuất nút mua hàng gốc; tuân thủ vùng an toàn (Safe Area), kiểm thử tương thích bàn phím ảo |
| Cô lập kiểu hiển thị | Sử dụng Shadow DOM để cô lập CSS/JS, tránh xung đột với giao diện gốc của website khách hàng |
| Tải theo nhu cầu | Chỉ tải tài nguyên khi người dùng tương tác; tuyệt đối không đóng gói mô hình LLM vào mã client |

Ngân sách tài nguyên mã nhúng client: Duy trì dưới 6/7/7 KB từng phần chức năng và dưới 20 KB toàn bộ mã nén. Nếu phát sinh vượt ngân sách, phải tối ưu mã nguồn; không giấu tài nguyên vào các tệp tải ngầm gây ảnh hưởng tốc độ trang.

## 8. Tiêu chí nghiệm thu kiến trúc

1. **TC-E2E-001**: Một tín hiệu hoàn tất trọn vẹn chu trình 11 bước: Signal → Context → Hypothesis → Decision → Plan → Action → Approval → Execution → Evidence → Outcome → Learning.
2. **Đa doanh nghiệp (Multi-tenant - NFR-006)**: Cùng phiên bản phần mềm Core Engine phục vụ tách biệt hoàn toàn giữa các doanh nghiệp; không rò rỉ dữ liệu, vector index, hàng đợi hay báo cáo.
3. **Phân quyền và Định tuyến (FR-ORC-001)**: Mọi yêu cầu được định tuyến đúng Agent thẩm quyền; không cho phép kích hoạt chức năng chưa bật hoặc truy cập dữ liệu tenant khác (BR-008).
4. **Độc quyền phiên hội thoại (SCR-005)**: Một phiên hội thoại không bao giờ có AI và nhân viên đồng thời phát tin nghiệp vụ; thao tác Takeover ngắt bot tức thì và bot không thể tự giành lại quyền khi chưa có `human.resume`.
5. **Kiểm soát phê duyệt (SCR-003)**: Hành động cấp AUTH-4 bắt buộc dừng chờ phê duyệt từ con người; không thể tự động thực thi ngầm (TC-E2E-002).
6. **Bền vững và Chống trùng (NFR-003)**: Khởi động lại hệ thống không làm mất trạng thái công việc đang chờ; thử lại với cùng `effect_key` không gây tác động kép.
7. **Bảo toàn Storefront Widget**: Giao diện nhúng duy trì ngân sách nén dưới 20 KB; khi widget gặp sự cố, luồng mua sắm và giỏ hàng gốc của website vẫn hoạt động bình thường.
8. **Hoán đổi Adapter chuẩn hóa**: Kiểm thử thay thế giữa ADPT-TW-001 (Đài Loan) và ADPT-GL-001/002/003 (Toàn cầu) diễn ra độc lập ở tầng Adapter mà không làm thay đổi bất kỳ dòng mã nào trong Core Engine.

Hợp đồng chi tiết được quy định tại [API và tích hợp](api-and-integrations.md), [Dữ liệu và kiến thức](data-and-knowledge.md) và [Quy trình và bàn giao](workflows-and-handoffs.md).

