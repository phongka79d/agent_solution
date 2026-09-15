# Kiến trúc và điều phối

[Mục lục](../README.md) · [Dữ liệu](data-and-knowledge.md) · [API](api-and-integrations.md)

Trạng thái: kiến trúc logic đề xuất, chưa phải hệ thống đã triển khai. Không quy định nhà cung cấp hạ tầng trước khi biết doanh nghiệp thử nghiệm.

<a id=section-5></a>

## 1. Bộ điều phối doanh thu (Revenue Orchestrator)

Revenue Orchestrator là lớp điều phối trung tâm vận hành chuỗi giá trị khép kín:
**SIGNAL → CONTEXT → HYPOTHESIS → DECISION → PLAN → ACTION → APPROVAL → EXECUTION → EVIDENCE → OUTCOME → LEARNING**

Hệ thống không cho phép các AI Agent tự do gọi lẫn nhau tùy ý mà phải thông qua Orchestrator để đảm bảo quản trị tập trung, cô lập ngữ cảnh và tuân thủ chính sách doanh nghiệp.

### Yêu cầu điều phối cốt lõi

- **FR-ORC-001 - Routing (Định tuyến trung tâm) - MUST**:
  Orchestrator xác định Agent nào tiếp nhận, skill nào được phép gọi, dữ liệu nào từ Customer 360 / Second Brain được truy cập, tool nào được thi hành và điều kiện phê duyệt (Authority/Approval) tương ứng. Nếu ý định khách hàng chưa rõ ràng, Orchestrator yêu cầu đặt một câu hỏi làm rõ duy nhất hoặc chuyển cho nhân viên, không liên tục tráo đổi Agent.
- **FR-ORC-002 - Multi-Agent Workflow (Quy trình xuyên Agent) - MUST**:
  Hệ thống hỗ trợ quy trình phối hợp xuyên miền (Marketing → Sales → Customer Care / Retention) với ngữ cảnh liền mạch:
  Ví dụ quy trình giỏ hàng bỏ quên: Tín hiệu bỏ giỏ (`SIGNAL`) → Sales Agent phát hiện → Customer 360 nạp lịch sử và consent (`CONTEXT`) → Suy luận độ nhạy giá và nguy cơ rời bỏ (`HYPOTHESIS`) → Quyết định gửi thông điệp kích hoạt (`DECISION`) → Lập kế hoạch thời điểm và kênh (`PLAN`) → Recommendation Skill chọn sản phẩm bổ trợ (`ACTION`) → Policy Engine kiểm tra ngưỡng ưu đãi/ngân sách (`APPROVAL`) → Communication Connector gửi tin qua LINE/Zalo/Web (`EXECUTION`) → Ghi nhận phản hồi và đơn hàng đối soát (`EVIDENCE`) → Đo lường doanh thu và chuyển đổi (`OUTCOME`) → Cập nhật trọng số mô hình đề xuất (`LEARNING`).

| Yêu cầu đầu vào | Miền xử lý chính | Hành vi điều phối |
|---|---|---|
| “Tôi muốn xem có giải pháp nào phù hợp” | Marketing AI / Sales AI | Khám phá nhu cầu; nếu đã có ý định mua cụ thể chuyển Sales AI |
| “Sản phẩm này có hợp với nhu cầu của tôi không?” | Sales AI | Tư vấn, so sánh tính năng, kiểm tra tồn kho và giá thực tế |
| “Tôi không dùng được sản phẩm / Đơn hàng chưa tới” | Customer Care AI | Tra cứu mã đơn, trạng thái vận chuyển, hướng dẫn xử lý lỗi |
| “Tôi muốn mua thêm / Nâng cấp gói” | Sales AI | Phân tích lịch sử mua, đề xuất cross-sell/upsell trong ngân sách |
| “Tôi muốn hủy / Hoàn tiền / Gặp người thật” | Human Handoff | Chuyển ngay hàng đợi nhân viên có thẩm quyền; AI không tự duyệt |
| Tín hiệu nghiên cứu thị trường nội bộ | Marketing AI | Phân tích cohort, tổng hợp báo cáo; không tự phát tán ra ngoài |

Yêu cầu chỉ đích danh mô-đun và yêu cầu tự điều phối `auto` phải qua cùng kiểm tra. `auto` không phải mô-đun thứ tư. Nếu ý định chưa rõ, hỏi tập trung hoặc chuyển người, không liên tục đổi trợ lý.

<a id=section-10></a>

## 2. Kiến trúc hai tầng: Core Engine & Plug-and-Play Adapters

Toàn bộ hệ thống được phân tách nghiêm ngặt thành hai tầng độc lập để phục vụ mở rộng B2B SaaS toàn cầu:

### Tầng 1: Lõi thông minh đa doanh nghiệp (Core Engine - Multi-tenant)
Giữ nguyên 100% khi mở rộng sang bất kỳ quốc gia nào:
- **Bộ điều phối AI (Orchestrator)**: Phân loại ý định, hội thoại đa vòng, hiểu tâm lý mua sắm.
- **Máy chủ tính giá sàn toán học ($P_{floor}$)**: Kiểm soát chiết khấu tự động, trích lập ngân sách từ hoa hồng sales tiết kiệm được, bảo vệ 100% biên lãi ròng.
- **Hồ sơ khách hàng hợp nhất (Customer360 Profile)**: Lưu vết hành vi, sở thích, nguồn gốc và lịch sử giao dịch.
- **Công cụ tích điểm & lòng trung thành (Endowed Progress Engine)**: Quy tắc tích điểm, cấp tiến độ ảo, quản lý ưu đãi.
- **Máy trạng thái quy trình & Bàn giao**: Hàng đợi nhân viên, quy tắc tiếp quản, nhật ký kiểm toán bất biến.

### Tầng 2: Cơ chế phích cắm bản địa hóa (Plug-and-Play Adapters)
Khi phục vụ khách hàng mỏ neo tại Đài Loan hoặc mở rộng sang các quốc gia khác, chỉ hoán đổi 3 cổng kết nối cắm-rút:
1. **Cổng giao tiếp (Communication Adapter)**:
   - *Đài Loan*: LINE Messaging API (LINE Official Account) + Web Widget nhúng.
   - *Quốc tế*: WhatsApp Business API, Telegram Bot, hoặc Web Widget đa ngôn ngữ.
2. **Cổng thanh toán & hoàn tất đơn (Payment & Settlement Adapter)**:
   - *Đài Loan*: ECPay, NewebPay, LINE Pay và hạ tầng nhận hàng siêu thị 7-Eleven/FamilyMart (CVS COD E-Map API).
   - *Quốc tế*: Stripe, PayPal, Apple Pay, Google Pay hoặc bưu cục địa phương.
3. **Cổng pháp lý & hạ tầng lưu trữ (Compliance & Data Residency Adapter)**:
   - *Đài Loan*: Cụm máy chủ GCP Changhua / AWS Taipei tuân thủ Taiwan PDPA.
   - *Quốc tế*: Triển khai theo vùng dữ liệu GDPR (Châu Âu), CCPA (Mỹ), PDPA (Singapore) với module quản lý cookie và thu thập đồng ý.

## 3. Các lớp trách nhiệm

| Lớp | Trách nhiệm | Không được làm |
|---|---|---|
| Website/ứng dụng/kênh hiện có | Hiển thị, nhận thao tác, xác thực phiên khách theo thiết kế | Giữ khóa API doanh nghiệp, tự quyết giá hoặc trạng thái thanh toán |
| Cổng API và sự kiện | Xác thực bên gọi, gắn phạm vi doanh nghiệp, kiểm tra quyền, chống trùng | Tin mã doanh nghiệp/khách chỉ vì có trong nội dung gửi lên |
| Điều phối và mô-đun | Hiểu nhu cầu, tạo câu trả lời/đề xuất từ nguồn cho phép | Cấp quyền hoặc xác nhận hành động chưa xảy ra |
| Quy trình và quy tắc máy chủ | Phê duyệt, giá sàn, trạng thái, hẹn giờ, giới hạn, người phụ trách | Giao quyết định rủi ro chỉ cho lời hướng dẫn AI |
| Bộ kết nối Adapter | Đọc/ghi đúng API bản địa, ánh xạ trường, xử lý lỗi, trả bằng chứng | Cho AI truy cập cơ sở dữ liệu doanh nghiệp không giới hạn |
| Dữ liệu dùng chung | Liên kết khách, hội thoại, quy trình, bằng chứng và nhật ký | Thay nguồn gốc của giá, đơn hoặc thanh toán |
| Bảng điều khiển | Cấu hình, hàng đợi, duyệt, tiếp quản, tra lỗi và báo cáo | Cho người không có vai trò duyệt thao tác rủi ro |

Luồng thực thi: ngữ cảnh được phép → AI đề xuất → máy chủ kiểm tra quyền/quy tắc → bộ kết nối thực hiện nếu cần → kiểm chứng kết quả → phản hồi → lưu bằng chứng.

Customer360 chứa ngữ cảnh và liên kết khách. Kho kiến thức chứa tài liệu đã duyệt. Chúng khác nhau; AI không sửa tài liệu trong lúc trả lời. Dữ liệu giá/đơn/thanh toán có nguồn nghiệp vụ riêng.

## 4. Đặc tả 5 màn hình Human Command Center

Hệ thống thiết kế 5 màn hình chỉ huy thống nhất phục vụ giám sát, can thiệp và kiểm soát rủi ro:

- **SCR-001 - Executive Dashboard**:
  Tổng quan chỉ số kinh doanh theo thời gian thực: Doanh thu tổng (Revenue), Khách tiềm năng (Leads), Tỷ lệ chuyển đổi (Conversion), Chiến dịch đang chạy (Active Campaigns), Doanh thu do AI đóng góp (AI Generated Revenue), Trạng thái vận hành CSKH (CS Status), Tỷ lệ giữ chân (Retention Rate), Tổng số hành động AI (AI Actions), Số yêu cầu chờ duyệt (Approval Pending) và Cảnh báo bất thường (Abnormal Events).
- **SCR-002 - Agent Operations**:
  Quản trị kỹ thuật Agent: Danh sách Agent online/offline, nhiệm vụ hiện tại, lịch sử lần chạy (Run history), lỗi thực thi (Error log), tần suất gọi tool, mức tiêu thụ token/chi phí API và KPI vận hành từng Agent.
- **SCR-003 - Approval Center**:
  Trung tâm phê duyệt dành cho người quản trị với 5 thao tác chuẩn hóa: **Approve** (Duyệt), **Reject** (Từ chối), **Modify** (Chỉnh sửa nội dung/tham số trước khi chạy), **Pause** (Tạm dừng quy trình) và **Cancel** (Hủy bỏ hoàn toàn). Áp dụng cho mọi hành động cấp AUTH-4 (chiến dịch lớn, chiết khấu vượt trần, bồi thường, hoàn tiền, đổi chính sách).
- **SCR-004 - Customer 360**:
  Hiển thị hồ sơ khách hàng hợp nhất trên một Timeline thời gian thực thống nhất: View → Search → Click → Chat → Add to cart → Purchase → Delivery → Support → Review → Repurchase. Đi kèm thẻ bằng chứng (Evidence) cho từng sự kiện và phân định rõ ràng giữa sự thật (Fact) và suy diễn (Hypothesis).
- **SCR-005 - Conversation Console**:
  Giao diện theo dõi phiên chat AI - khách hàng trực tiếp. Hỗ trợ nhân viên: giám sát nội dung, **Takeover** (ngắt AI, nhân viên tiếp quản), **Resume** (trả quyền lại cho AI sau khi xử lý xong), sửa câu trả lời nháp và chấm điểm đánh giá chất lượng hội thoại (Human Evaluation).

## 5. Cách triển khai nhỏ nhất

Bắt đầu bằng **một ứng dụng chia phần chức năng và một tiến trình nền lưu trạng thái bền vững**. Không cần một dịch vụ riêng cho mỗi trợ lý, một bản phần mềm riêng cho mỗi khách hay hệ thống thông điệp phức tạp ngay từ đầu.

| Dữ liệu | Phương án khởi đầu |
|---|---|
| Liên kết khách, hội thoại, trạng thái, sự kiện, cấu hình, nhật ký | Cơ sở dữ liệu quan hệ với truy cập theo doanh nghiệp |
| Tài liệu | Kho tệp được kiểm soát quyền |
| Chỉ mục tìm kiếm | Dữ liệu dẫn xuất, có thể dựng lại; không là bản duy nhất của trạng thái nghiệp vụ |
| Công việc và lịch chờ | Hàng đợi/trạng thái bền vững; chỉ một tiến trình nắm quyền thực hiện một bước |
| Báo cáo | Truy vấn/bảng tổng hợp từ dữ liệu có sẵn; kho phân tích riêng chỉ khi cần |

Dùng bộ kết nối có sẵn hoặc API doanh nghiệp trước. Không có API phù hợp thì chốt nhập dữ liệu có kiểm soát hoặc cầu nối do doanh nghiệp quản lý; không hứa cắm vào mọi hệ thống là chạy.

## 6. Điều phối giao diện khác điều phối nghiệp vụ

Bộ giao diện nhúng đề xuất trong PDF chỉ quản lý trải nghiệm: phần hỏi nhanh, chat, gợi ý và trạng thái. Quyền dữ liệu, AI, giá sàn, thanh toán và nhật ký phải ở máy chủ.

| Quy tắc giao diện tùy chọn | Cách áp dụng |
|---|---|
| Không hiển thị chồng | Mở chat hoặc giỏ thì không tự bật gợi ý tiếp thị |
| Giới hạn tần suất | Ban đầu tối đa một gợi ý tự bật/24 giờ/thiết bị; lưu lượng đo không dựa vào theo dõi ngầm liên thiết bị |
| Dễ tắt, không ép đăng ký | Có nút đóng; không chặn mua hoặc buộc số điện thoại khi chỉ xem |
| Vùng an toàn di động | Không che nút gốc; kiểm thử bàn phím, vùng tai thỏ, trình đọc màn hình; 75 px chỉ là giá trị thử từ PDF |
| Cô lập kiểu hiển thị | Dùng cơ chế cô lập khi cần, chẳng hạn Shadow DOM; kiểm thử tương thích và khả năng tiếp cận |
| Tải theo nhu cầu | Chỉ tải phần được bật; không đóng gói mô hình AI vào mã trình duyệt |

Các mục tiêu dung lượng dưới 6/7/7 KB từng phần và dưới 20 KB toàn bộ trong PDF là ngân sách thử cho mã giao diện nén, không phải tổng dung lượng AI/RAG hay cam kết đã đo. Phải công khai thứ được tính: mã điều phối, phần tải thêm, CSS, ảnh, phông và thư viện. Đo cả ảnh hưởng tốc độ trang; không đạt ngân sách thì báo thật, không giấu vào tệp tải sau.

P1 ưu tiên giao diện đang có; chưa xây bộ mã nhúng đầy đủ chỉ để thỏa tên tệp trong PDF.

## 7. Một yêu cầu qua hệ thống (Chu trình 11 bước E2E)

1. **SIGNAL**: Hệ thống tiếp nhận tín hiệu từ Web/App, POS, mạng xã hội hoặc kênh nhắn tin đã xác thực.
2. **CONTEXT**: Lấy hồ sơ Customer 360, phạm vi quyền hạn và trạng thái đồng ý liên hệ hiện tại.
3. **HYPOTHESIS**: AI phân tích nhu cầu, chấm điểm cơ hội, dự đoán hành vi tiếp theo.
4. **DECISION**: Xác định mục tiêu nghiệp vụ, chọn Agent chuyên trách và Skill phù hợp.
5. **PLAN**: Lập trình tự các bước thực thi, kênh liên hệ và mốc thời gian.
6. **ACTION**: Chuẩn bị nội dung, thông điệp hoặc yêu cầu giao dịch cụ thể.
7. **APPROVAL**: Đối soát Authority Model; nếu thuộc cấp AUTH-4 thì gửi vào SCR-003 chờ người duyệt.
8. **EXECUTION**: Gửi lệnh qua Plug-and-Play Adapter hoặc API hệ thống nguồn kèm `effect_key` chống trùng.
9. **EVIDENCE**: Thu thập bằng chứng xác nhận từ kênh/ERP (mã giao dịch, biên nhận nhà mạng).
10. **OUTCOME**: Đo lường kết quả kinh doanh thực tế (đơn hàng thành công, khiếu nại được giải quyết).
11. **LEARNING**: Cập nhật chỉ số hiệu quả vào Learning Memory để tinh chỉnh chiến lược tiếp theo.

## 8. Điều kiện nghiệm thu kiến trúc

1. **TC-E2E-001**: Một tín hiệu hoàn tất trọn vẹn chu trình 11 bước: Signal → Context → Hypothesis → Decision → Plan → Action → Approval → Execution → Evidence → Outcome → Learning.
2. **Đa doanh nghiệp (Multi-tenant)**: Cùng bản phần mềm chạy tách biệt giữa các doanh nghiệp; không rò rỉ dữ liệu, tìm kiếm, tệp, hàng đợi hay báo cáo (NFR-006).
3. **Phân quyền và Định tuyến (FR-ORC-001)**: Tham số yêu cầu không thể kích hoạt mô-đun chưa bật hoặc truy cập công việc của doanh nghiệp khác; Agent không được vượt ranh giới quyền hạn (BR-008).
4. **Độc quyền phiên hội thoại**: Một cuộc trao đổi không bao giờ có AI và nhân viên đồng thời phát phản hồi nghiệp vụ; quy trình Takeover/Resume tại SCR-005 hoạt động chuẩn xác.
5. **Giới hạn công cụ**: AI không thể gọi công cụ ngoài danh sách đã cấp quyền hay ghi trực tiếp vào cơ sở dữ liệu doanh nghiệp.
6. **Bền vững và Chống trùng (NFR-003)**: Khởi động lại tiến trình không làm mất tác vụ đang chờ; thử lại với cùng `effect_key` không gây tác động kép.
7. **Bảo toàn giao diện nhúng**: Ngân sách mã nhúng duy trì dưới 6/7/7 KB từng phần và dưới 20 KB toàn bộ; thao tác mua gốc trên website vẫn hoạt động bình thường khi trợ lý gặp sự cố.
8. **Kiểm soát người duyệt (SCR-003)**: Hành động AUTH-4 bắt buộc dừng chờ phê duyệt, không thể tự thực thi ngầm (TC-E2E-002).

Hợp đồng chi tiết nằm ở [API](api-and-integrations.md), [dữ liệu](data-and-knowledge.md) và [quy trình](workflows-and-handoffs.md).
