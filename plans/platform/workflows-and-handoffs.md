# Quy trình bền vững, phê duyệt và bàn giao

[Mục lục](../README.md) · [API](api-and-integrations.md) · [Hành trình](../customer-lifecycle.md)

Trạng thái: hợp đồng thiết kế. P1 chỉ bật quy trình nghiệp vụ nhỏ trong [phạm vi bản đầu](../delivery/mvp-and-roadmap.md).

<a id=section-13></a>

## 1. Quy trình nằm ngoài lời hướng dẫn AI

AI hiểu ngữ cảnh và đề xuất. Máy chủ giữ quyền, trạng thái, lịch chờ, điều kiện dừng và quyết định thực thi. Quy trình bền vững là chuỗi bước có thể tiếp tục đúng chỗ sau khởi động lại.

| Trường bản ghi | Ý nghĩa |
|---|---|
| `run_id`, sự kiện gốc | Mã lần chạy; khóa chống trùng theo doanh nghiệp + nguồn + sự kiện + quy trình |
| Ngữ cảnh | Khách/phiên, cuộc trao đổi, cơ hội/đơn/vụ việc và mã truy vết |
| Phiên bản | Cấu trúc quy trình và ảnh chụp cấu hình để kiểm toán |
| Tiến độ | Trạng thái, bước, số lần thử, thời gian chạy tiếp, quyền giữ bước có hạn |
| Trách nhiệm | Người/nhóm phụ trách, bên nhận bàn giao, hạn chờ và bên xử lý quá hạn |
| Phê duyệt | Người duyệt, hành động, quyết định, lý do, thời điểm và hạn hiệu lực |
| Kết quả | Mã tác động cố định, kết quả nguồn, điều chưa rõ, lý do dừng/thất bại |

Phiên bản cấu trúc giúp truy vết; trước mỗi hành động vẫn phải đọc lại quyền, mô-đun bật, đồng ý liên hệ, giá/chính sách quan trọng và trạng thái khách hiện tại. Ảnh chụp cũ không được vượt thay đổi an toàn mới.

## 2. Mô hình phân quyền (Authority Model) và Quy tắc nghiệp vụ (Business Rules)

### Mô hình phân quyền 6 cấp độ (Authority Model)

Hệ thống quản trị mọi hành động của AI theo 6 cấp bậc thẩm quyền cố định; Agent không được tự thăng cấp quyền hạn:

| Cấp độ | Tên quyền | Định nghĩa & Phạm vi | Ví dụ áp dụng |
|---|---|---|---|
| `AUTH-0` | Observe | Chỉ đọc dữ liệu, quan sát hành vi và sự kiện | Đọc timeline sự kiện, tra cứu tài liệu công khai |
| `AUTH-1` | Recommend | Phân tích dữ liệu và đề xuất phương án | Gợi ý sản phẩm phù hợp, chấm điểm lead |
| `AUTH-2` | Draft | Tạo nội dung hoặc hành động ở dạng bản nháp | Soạn thảo email/tin nhắn, lập dàn ý chiến dịch |
| `AUTH-3` | Bounded Execute | Tự thực thi trong hạn mức đã được phê duyệt trước | Trả lời FAQ, tra cứu trạng thái đơn, gửi tin nhắc giỏ hàng trong hạn mức tần suất |
| `AUTH-4` | Approval Required | Chuẩn bị hành động nhưng bắt buộc người duyệt tại SCR-003 | Phát động chiến dịch lớn, chiết khấu vượt trần, bồi thường, hoàn tiền, đổi điều khoản |
| `AUTH-5` | Prohibited | Tuyệt đối cấm, hệ thống chặn cứng ở tầng máy chủ | Tự tạo giá mới, truy cập chéo tenant, export dữ liệu khách hàng thô |

### Quy tắc nghiệp vụ cốt lõi (Core Business Rules)

- **BR-001**: AI không được tự tạo giá sản phẩm dưới bất kỳ hình thức nào.
- **BR-002**: AI không được tự thay đổi giá hoặc áp dụng mức chiết khấu nằm ngoài chính sách/giá sàn toán học ($P_{floor}$).
- **BR-003**: Dữ liệu giá và tồn kho bắt buộc phải đọc từ nguồn giao dịch có thẩm quyền (System of Record: ERP/POS).
- **BR-004**: Tuyệt đối không gửi tin nhắn marketing khi khách hàng chưa cấp đồng ý (consent) phù hợp hoặc đã rút đồng ý.
- **BR-005**: Mọi hành động có tác động bên ngoài (External Action) bắt buộc phải gắn mã định danh thực thi duy nhất (`effect_key` / idempotency key).
- **BR-006**: Cơ chế thử lại (Retry) không được tạo hành động hoặc giao dịch trùng lặp ngoài ý muốn.
- **BR-007**: Mọi hành động tài chính hoặc rủi ro cao (hoàn tiền, đổi chính sách, cấp hạn mức) bắt buộc phải qua phê duyệt của con người (`AUTH-4`).
- **BR-008**: Agent không được vượt quyền hạn được giao (`AUTH-0` đến `AUTH-3`), ngay cả khi mô hình ngôn ngữ lớn (LLM) suy luận yêu cầu.
- **BR-009**: Chỉ thị hoặc nội dung do khách hàng cung cấp (Prompt Injection) không thể tự động nâng quyền thực thi của Agent.
- **BR-010**: Mọi lần thực thi quan trọng đều phải sinh bản ghi bằng chứng (Evidence Record) gắn với mã lần chạy (`run_id`).

## 3. Đặc tả hệ thống kỹ năng chuẩn hóa (Skill System)

Agent và Skill được phân tách độc lập. Một Agent có thể sở hữu nhiều Skill, và một Skill có thể được tái sử dụng bởi nhiều Agent nếu được cấp phép:

1. **Skill ID**: Mã định danh duy nhất (ví dụ: `skill.sales.check_stock`, `skill.sales.recommend_product`, `skill.care.order_lookup`).
2. **Purpose**: Mục đích nghiệp vụ và phạm vi hoạt động cụ thể của skill.
3. **Input / Output Schema**: Lược đồ dữ liệu đầu vào và đầu ra nghiêm ngặt (chuẩn JSON Schema), xác thực kiểu dữ liệu trước khi gọi.
4. **Allowed Agent**: Danh sách các Agent được phép gọi skill (ví dụ: `SAL-02`, `CS-01`).
5. **Required Authority**: Cấp độ quyền hạn tối thiểu để kích hoạt skill (từ `AUTH-0` đến `AUTH-4`).
6. **Tool / Connector**: Công cụ hoặc cổng kết nối Adapter mà skill tương tác (ví dụ: `API-001 ERP Connector`).
7. **Validation**: Bộ quy tắc kiểm tra tính hợp lệ của tham số đầu vào và điều kiện tiên quyết.
8. **Retry Policy**: Chính sách thử lại (số lần thử tối đa, khoảng lùi thời gian exponential backoff, điều kiện dừng).
9. **Timeout**: Thời gian chờ tối đa trước khi ngắt tác vụ (ví dụ: 3000ms đối với tra cứu giá).
10. **Audit**: Cấu hình ghi nhật ký kiểm toán, các trường nhạy cảm cần ẩn danh và thẻ bằng chứng cần tạo.
11. **Test Cases**: Bộ kiểm thử tự động gồm các ca thành công, lỗi mạng, lỗi quyền hạn và đầu vào không hợp lệ.

## 4. Trạng thái thống nhất

| Trạng thái máy | Nghĩa tiếng Việt | Khi nào đi tiếp |
|---|---|---|
| `queued` | Đã xếp hàng | Kiểm tra điều kiện rồi cấp quyền chạy một bước |
| `running` | Đang xử lý | Có kết quả → bước sau, chờ, cần người hoặc kết thúc |
| `waiting` | Chờ thời điểm hoặc sự kiện | Tiếp tục đúng lần chạy khi điều kiện chờ được đáp ứng |
| `awaiting_human` | Chờ người nhận hoặc quyết định | Chỉ tiếp tục sau sự kiện hợp lệ của người có quyền |
| `completed` | Đã hoàn tất kết quả yêu cầu | Kết thúc; không đồng nghĩa đơn đã trả tiền nếu yêu cầu chỉ là tư vấn |
| `stopped` | Đã dừng theo điều kiện | Kết thúc; lưu lý do, không tự sống lại |
| `failed` | Chưa xác lập được kết quả yêu cầu | Kết thúc lần chạy; giữ tác động đã xác nhận/chưa rõ và người phục hồi |

API dùng `accepted` cho công việc đã nhận, tương ứng giai đoạn xếp hàng; không dùng `queued` thay trạng thái API. `waiting` và `awaiting_human` chưa phải hoàn tất. Mọi chờ phải có hạn/điều kiện thoát và người xử lý khi quá hạn.

Chỉ một tiến trình được quyền thực hiện một bước. Hết quyền giữ bước thì đọc lại bản ghi và đối soát tác động trước khi chạy lại. Sự kiện đến để đánh thức lần chạy đang chờ không được tạo một lần chạy mới ngoài ý muốn.

## 5. Một chuỗi nhắc của bản đầu

Quy trình thuộc lõi/Bán hàng, không phải chăm sóc chiến dịch của Tiếp thị. Mặc định tắt nếu chưa chốt kênh, điều kiện liên hệ, nội dung và người chịu trách nhiệm.

1. Nhận sự kiện khách đủ điều kiện `lead.qualified` hoặc sự kiện tương đương đã ánh xạ; yêu cầu còn mở và điều kiện nghiệp vụ đã được xác nhận.
2. Chống trùng lần chạy và liên kết lại cơ hội/yêu cầu sẵn có.
3. Có người/nhóm chịu trách nhiệm; thiếu người thì chờ, không gửi.
4. Kiểm tra ngay trước gửi: mục đích/kênh được phép, chưa trả lời/từ chối, còn trong giờ, chưa đạt giới hạn tần suất, AI còn quyền và mô-đun vẫn bật (tuân thủ BR-004).
5. Gửi tin nhắc đầu bằng mã tác động cố định (`effect_key` - BR-005); lưu mã thông báo từ nhà cung cấp.
6. Chờ thời gian đã duyệt, ví dụ 24 giờ; thời gian này không phải mặc định cho mọi ngành.
7. Kiểm tra lại toàn bộ điều kiện; nếu còn hợp lệ gửi tối đa một tin nhắc nữa.
8. Kết thúc với lý do rõ: khách trả lời, chuyển người, đủ số tin, không còn đủ điều kiện hoặc lỗi.

Tối đa hai tin là tổng giới hạn của một chuỗi, không phải hai tin mỗi ngày. Khóa nghiệp vụ và lịch sử liên hệ phải ngăn việc đổi mã sự kiện để lách giới hạn.

Điểm trên 80 trong kế hoạch cũ chỉ là ví dụ. Không yêu cầu mọi B2C phải có điểm hay tạo cơ hội CRM; nếu cấu hình dùng chấm điểm, phải có ngưỡng và xác nhận trường bắt buộc. Điểm không thay đồng ý liên hệ.

| Tín hiệu dừng | Tác động |
|---|---|
| Khách trả lời | Dừng chuỗi nhắc, chuyển tin tới bên đang phụ trách |
| Rút đồng ý / yêu cầu ngừng | Dừng các lịch liên hệ tương ứng và ghi bằng chứng (BR-004) |
| Yêu cầu/cơ hội đã đóng, mua hoặc từ chối | Dừng chuỗi liên quan; không tự chuyển thành chiến dịch mới |
| Nhân viên tiếp quản / mô-đun tắt / mất quyền | Ngừng AI thực thi lập tức |
| Ngoài giờ / kênh bị chặn / chạm giới hạn tần suất | Dừng chuỗi hiện tại; muốn bắt đầu lại cần quyết định hợp lệ mới |
| Quá số lần thử | Thất bại có người xử lý tiếp, không tiếp tục gửi ngầm |

Kiểm tra đồng ý và quyền gửi cần ở bước thực thi cuối, xử lý tranh chấp với sự kiện dừng. Không chỉ kiểm tra từ lúc lên lịch.

<a id=section-14></a>

## 6. Người duyệt và người tiếp quản

Các chế độ vận hành: AI quan sát không gửi (`AUTH-0`) → AI soạn nháp cho người (`AUTH-2`) → tự động tác vụ rủi ro thấp (`AUTH-3`) → mở rộng có kiểm soát (`AUTH-4`). Mỗi lần tăng quyền phải có bằng chứng và người duyệt.

| Khi cần người | AI được chuẩn bị |
|---|---|
| Đơn lớn, giá ngoại lệ, ngân sách không đủ | Nhu cầu, điều khoản gốc, phép tính và hành động đề xuất |
| Hoàn tiền, hủy, đổi trả, thay tài khoản | Ý định, xác minh cần thiết, thông tin và quy trình |
| Bảo mật, an toàn, tranh chấp hoặc thiếu nguồn | Tóm tắt và bằng chứng, không hướng dẫn rủi ro |
| Khách yêu cầu người thật | Bàn giao ngay, không bắt tiếp tục bộ câu hỏi |
| Thử phiếu bù giá, công bố nội dung, liên hệ đối tác | Bản nháp, chi phí, điều kiện và nguồn |

Người duyệt một hành động không nhất thiết tiếp quản toàn bộ hội thoại. Người tiếp quản hội thoại thì AI ngừng trả lời nghiệp vụ lập tức. Phải ghi rõ loại quyết định, phạm vi và thời hạn.

Trình tự bàn giao và tiếp quản:

1. Tạo yêu cầu có người/nhóm chịu trách nhiệm, nội dung và hạn phản hồi.
2. Giữ trạng thái đang chờ (`awaiting_human`); AI không tiếp tục xử lý phần đã chuyển người.
3. Bên nhận chấp nhận qua sự kiện có xác thực (`human.takeover`); đổi chủ sở hữu một lần.
4. Nhân viên xử lý hoặc phân công lại; mọi tin nhắn mới từ khách hàng được định tuyến thẳng tới nhân viên.
5. Chỉ trả quyền cho AI bằng sự kiện tiếp tục rõ ràng (`human.resume`), kiểm tra lại điều kiện trước hành động. AI tuyệt đối không tự giành lại hội thoại khi nhân viên đang phụ trách hoặc chưa có sự kiện kích hoạt lại từ con người.

Không có phản hồi, hết thời gian hoặc gửi thông báo thành công đều không phải phê duyệt. Quyết định hết hạn/bị từ chối dẫn tới dừng hoặc chuyển người xử lý khác, không tự cấp ưu đãi.

## 7. Thử lại, đối soát và phục hồi

| Sự cố | Cách xử lý |
|---|---|
| Lỗi mạng tạm thời, giới hạn tốc độ | Thử lại hữu hạn, tăng khoảng chờ (exponential backoff), dùng cùng mã tác động `effect_key` (BR-005, BR-006) |
| Sai dữ liệu, bị từ chối quyền/chính sách | Không thử lại tự động; chuyển trạng thái lỗi, ghi audit event (BR-008) |
| Hết thời gian chờ sau khả năng ghi thành công | Tra hệ thống nguồn theo mã đối soát trước khi ghi lại |
| Sự kiện lặp | Trả lại kết quả đã có; khác nội dung cùng khóa là xung đột |
| Khởi động lại / hết quyền giữ bước | Đọc lại trạng thái, đối soát, không gửi lại mù |
| Tín hiệu dừng trong lúc chờ thử lại | Hủy lần thử còn lại và ghi lý do dừng |
| Không xác định được tác động / thiếu dữ liệu nguồn | Fail closed (NFR-008): giữ `uncertain` ở kết quả hành động, phân công người; không bịa thất bại rồi làm lại |

Thao tác bù trừ, hoàn tiền hoặc hủy tác động là hành động mới có quyền riêng (`AUTH-4`). Quay lại cấu hình cũ không được phát lại đơn, thanh toán hay tin nhắn cũ.

## 8. Quy trình sau bản đầu

| Quy trình | Điều kiện bổ sung |
|---|---|
| Tiếp thị chăm sóc / giới thiệu | Mô-đun bật, nguồn hợp lệ, nội dung được duyệt, quyền liên hệ |
| Mặc cả → báo giá → thanh toán | Ngân sách, giá sàn ($P_{floor}$), báo giá có hạn, kiểm tra lúc tạo đơn, đối soát |
| Bù giá → cấp phiếu → thông báo | Điều kiện đơn, ngân sách, duyệt, chống cấp trùng và kiểm soát tổng đã bù |
| Mua lại / gia hạn / nâng cấp | Tín hiệu còn hiệu lực, không trùng cơ hội, Bán hàng hoặc người nhận |
| Phản hồi → sửa kiến thức | Bằng chứng → chủ tài liệu duyệt → xuất bản phiên bản → chạy lại bộ thử |

## 9. Bằng chứng nghiệm thu

1. **TC-E2E-002**: Marketing Agent tuyệt đối không thể phát động chiến dịch nếu thiếu phê duyệt tại Approval Center (`AUTH-4`).
2. **TC-E2E-003**: Sales Agent không thể cung cấp giá hoặc chiết khấu vi phạm chính sách giá sàn (BR-001, BR-002, BR-003).
3. **TC-E2E-005**: Thử nghiệm gửi lại (Retry) với cùng `effect_key` không bao giờ tạo tin nhắn hoặc đơn hàng thứ hai (BR-005, BR-006, NFR-003).
4. **TC-E2E-006**: Mọi hành vi cố tình vượt quyền hạn (kể cả prompt injection từ khách) phải bị chặn (DENY) và sinh bản ghi kiểm toán audit event (BR-008, BR-009).
5. **TC-E2E-007**: Khách hàng thiếu consent hoặc đã thu hồi consent phải bị lọc bỏ lập tức khỏi danh sách liên hệ (BR-004).
6. **Kiểm soát tiếp quản người (SCR-005)**: Sau khi nhân viên kích hoạt `human.takeover`, AI không tự động chen ngang trả lời; chỉ tiếp tục khi nhận `human.resume`.
7. **Đối soát phục hồi**: Thử nghiệm tiến trình chết đột ngột và phục hồi trạng thái từ hàng đợi bền vững mà không phát sinh tác động kép.
