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

## 2. Trạng thái thống nhất

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

## 3. Một chuỗi nhắc của bản đầu

Quy trình thuộc lõi/Bán hàng, không phải chăm sóc chiến dịch của Tiếp thị. Mặc định tắt nếu chưa chốt kênh, điều kiện liên hệ, nội dung và người chịu trách nhiệm.

1. Nhận sự kiện khách đủ điều kiện `lead.qualified` hoặc sự kiện tương đương đã ánh xạ; yêu cầu còn mở và điều kiện nghiệp vụ đã được xác nhận.
2. Chống trùng lần chạy và liên kết lại cơ hội/yêu cầu sẵn có.
3. Có người/nhóm chịu trách nhiệm; thiếu người thì chờ, không gửi.
4. Kiểm tra ngay trước gửi: mục đích/kênh được phép, chưa trả lời/từ chối, còn trong giờ, chưa đạt giới hạn tần suất, AI còn quyền và mô-đun vẫn bật.
5. Gửi tin nhắc đầu bằng mã tác động cố định; lưu mã thông báo từ nhà cung cấp.
6. Chờ thời gian đã duyệt, ví dụ 24 giờ; thời gian này không phải mặc định cho mọi ngành.
7. Kiểm tra lại toàn bộ điều kiện; nếu còn hợp lệ gửi tối đa một tin nhắc nữa.
8. Kết thúc với lý do rõ: khách trả lời, chuyển người, đủ số tin, không còn đủ điều kiện hoặc lỗi.

Tối đa hai tin là tổng giới hạn của một chuỗi, không phải hai tin mỗi ngày. Khóa nghiệp vụ và lịch sử liên hệ phải ngăn việc đổi mã sự kiện để lách giới hạn.

Điểm trên 80 trong kế hoạch cũ chỉ là ví dụ. Không yêu cầu mọi B2C phải có điểm hay tạo cơ hội CRM; nếu cấu hình dùng chấm điểm, phải có ngưỡng và xác nhận trường bắt buộc. Điểm không thay đồng ý liên hệ.

| Tín hiệu dừng | Tác động |
|---|---|
| Khách trả lời | Dừng chuỗi nhắc, chuyển tin tới bên đang phụ trách |
| Rút đồng ý / yêu cầu ngừng | Dừng các lịch liên hệ tương ứng và ghi bằng chứng |
| Yêu cầu/cơ hội đã đóng, mua hoặc từ chối | Dừng chuỗi liên quan; không tự chuyển thành chiến dịch mới |
| Nhân viên tiếp quản / mô-đun tắt / mất quyền | Ngừng AI thực thi |
| Ngoài giờ / kênh bị chặn / chạm giới hạn tần suất | Dừng chuỗi hiện tại; muốn bắt đầu lại cần quyết định hợp lệ mới |
| Quá số lần thử | Thất bại có người xử lý tiếp, không tiếp tục gửi ngầm |

Kiểm tra đồng ý và quyền gửi cần ở bước thực thi cuối, xử lý tranh chấp với sự kiện dừng. Không chỉ kiểm tra từ lúc lên lịch.

<a id=section-14></a>

## 4. Người duyệt và người tiếp quản

Các chế độ vận hành: AI quan sát không gửi → AI soạn nháp cho người → tự động tác vụ rủi ro thấp → mở rộng có kiểm soát. Mỗi lần tăng quyền phải có bằng chứng và người duyệt.

| Khi cần người | AI được chuẩn bị |
|---|---|
| Đơn lớn, giá ngoại lệ, ngân sách không đủ | Nhu cầu, điều khoản gốc, phép tính và hành động đề xuất |
| Hoàn tiền, hủy, đổi trả, thay tài khoản | Ý định, xác minh cần thiết, thông tin và quy trình |
| Bảo mật, an toàn, tranh chấp hoặc thiếu nguồn | Tóm tắt và bằng chứng, không hướng dẫn rủi ro |
| Khách yêu cầu người thật | Bàn giao ngay, không bắt tiếp tục bộ câu hỏi |
| Thử phiếu bù giá, công bố nội dung, liên hệ đối tác | Bản nháp, chi phí, điều kiện và nguồn |

Người duyệt một hành động không nhất thiết tiếp quản toàn bộ hội thoại. Người tiếp quản hội thoại thì AI ngừng trả lời nghiệp vụ. Phải ghi rõ loại quyết định, phạm vi và thời hạn.

Trình tự bàn giao:

1. Tạo yêu cầu có người/nhóm chịu trách nhiệm, nội dung và hạn phản hồi.
2. Giữ trạng thái đang chờ; AI không tiếp tục xử lý phần đã chuyển người.
3. Bên nhận chấp nhận qua sự kiện có xác thực; đổi chủ sở hữu một lần.
4. Nhân viên xử lý hoặc phân công lại; mọi tin mới tới đúng bên đang phụ trách.
5. Chỉ trả quyền cho AI bằng sự kiện tiếp tục rõ ràng, kiểm tra lại điều kiện trước hành động.

Không có phản hồi, hết thời gian hoặc gửi thông báo thành công đều không phải phê duyệt. Quyết định hết hạn/bị từ chối dẫn tới dừng hoặc người xử lý khác, không tự cấp ưu đãi.

## 5. Thử lại, đối soát và phục hồi

| Sự cố | Cách xử lý |
|---|---|
| Lỗi mạng tạm thời, giới hạn tốc độ | Thử lại hữu hạn, tăng khoảng chờ, dùng cùng mã tác động |
| Sai dữ liệu, bị từ chối quyền/chính sách | Không thử lại tự động; sửa đầu vào hoặc chuyển người |
| Hết thời gian chờ sau khả năng ghi thành công | Tra hệ thống nguồn theo mã đối soát trước khi ghi lại |
| Sự kiện lặp | Trả lại kết quả đã có; khác nội dung cùng khóa là xung đột |
| Khởi động lại / hết quyền giữ bước | Đọc lại trạng thái, đối soát, không gửi lại mù |
| Tín hiệu dừng trong lúc chờ thử lại | Hủy lần thử còn lại và ghi lý do |
| Không xác định được tác động | Giữ `uncertain` ở kết quả hành động, phân công người; không bịa thất bại rồi làm lại |

Thao tác bù trừ, hoàn tiền hoặc hủy tác động là hành động mới có quyền riêng. Quay lại cấu hình cũ không được phát lại đơn, thanh toán hay tin nhắn cũ.

## 6. Quy trình sau bản đầu

| Quy trình | Điều kiện bổ sung |
|---|---|
| Tiếp thị chăm sóc / giới thiệu | Mô-đun bật, nguồn hợp lệ, nội dung được duyệt, quyền liên hệ |
| Mặc cả → báo giá → thanh toán | Ngân sách, giá sàn, báo giá có hạn, kiểm tra lúc tạo đơn, đối soát |
| Bù giá → cấp phiếu → thông báo | Điều kiện đơn, ngân sách, duyệt, chống cấp trùng và kiểm soát tổng đã bù |
| Mua lại / gia hạn / nâng cấp | Tín hiệu còn hiệu lực, không trùng cơ hội, Bán hàng hoặc người nhận |
| Phản hồi → sửa kiến thức | Bằng chứng → chủ tài liệu duyệt → xuất bản phiên bản → chạy lại bộ thử |

## 7. Bằng chứng nghiệm thu

Thử sự kiện trùng, khóa xung đột, tiến trình chết, hai tiến trình giành một bước, lỗi sau ghi, mất thông báo kết quả và phục hồi bằng truy vấn trạng thái. Kết quả phải nối được mã lần chạy tới tác động nguồn.

Kiểm tra từng tín hiệu dừng ngay trước tin đầu, tin thứ hai và trong lúc chờ thử lại. Phải không gửi thêm khi bị chặn; thay đổi quyền hoặc đồng ý hiện tại phải có hiệu lực dù cấu hình cũ đã được lưu.

Thử bàn giao chưa người nhận, nhận hai lần, phê duyệt hết hạn, từ chối, tiếp quản và trả quyền AI. Không tình huống nào được biến trạng thái chờ thành thành công mà thiếu bằng chứng.
