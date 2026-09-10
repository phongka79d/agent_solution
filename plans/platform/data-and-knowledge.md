# Dữ liệu khách hàng, bằng chứng và kho kiến thức

[Mục lục](../README.md) · [Kiến trúc](architecture.md) · [API](api-and-integrations.md)

Trạng thái: thiết kế đề xuất. Chỉ lưu dữ liệu cần thiết được cấp quyền; không yêu cầu doanh nghiệp chuyển toàn bộ cơ sở dữ liệu sang AgentOS.

<a id=section-11></a>

## 1. Customer360 — Hồ sơ khách hàng hợp nhất

Customer360 nối thông tin được phép giữa các mô-đun, không thay phần mềm quản lý khách hàng (CRM).

| Nhóm bản ghi | Nội dung tối thiểu |
|---|---|
| Danh tính | Doanh nghiệp, khách/phiên, mã nguồn, bằng chứng xác minh, thời điểm |
| Liên hệ và đồng ý | Kênh, mục đích, trạng thái, nguồn đồng ý/rút lại, phiên bản thông báo |
| Nguồn và nhu cầu | Chiến dịch/đối tác nếu có, sản phẩm, nhu cầu, thời điểm dự kiến do khách cung cấp |
| Hội thoại | Tin cần lưu, tóm tắt, người đang phụ trách, bàn giao, việc tiếp theo |
| Thương mại | Liên kết cơ hội, báo giá, đơn, thanh toán, giao hàng; trạng thái riêng từng loại |
| Hỗ trợ và tăng trưởng | Vụ việc, bước đã thử, kết quả, mở lại, nhu cầu mua thêm/giới thiệu có nguồn |
| Suy luận | Điểm phù hợp, tín hiệu, quy tắc/phiên bản, bằng chứng và giới hạn |

Một lượt xem là hoạt động của phiên, chưa phải người được xác minh. Mã đơn, email hoặc số điện thoại tự khai không đủ để xem hồ sơ riêng. Liên kết danh tính cần nguồn đáng tin trong cùng doanh nghiệp; nghi ngờ trùng thì giữ riêng, nhờ xác minh, không hợp nhất tự động.

### Nguồn nào giữ giá trị chính thức?

| Nguồn | Giá trị chính thức |
|---|---|
| Ứng dụng/CRM doanh nghiệp | Tài khoản, khách, yêu cầu, cơ hội và chủ sở hữu theo ánh xạ |
| Danh mục/kho/hệ thống bán hàng | Sản phẩm, giá, tồn kho, đơn và điều kiện áp dụng |
| Ngân hàng/nhà cung cấp thanh toán được chọn | Giao dịch, số tiền và trạng thái thanh toán được đối soát |
| Hệ thống vận chuyển/phiếu hỗ trợ | Trạng thái giao hàng, vụ việc, người nhận theo khả năng nguồn |
| Nguồn đối tác/quảng cáo | Mã nguồn, sự kiện giới thiệu, chi phí được cấp quyền |
| AgentOS | Liên kết, hội thoại, quy trình, cấu hình, nhật ký và suy luận có nguồn |

Phải có bảng sở hữu từng trường trước kết nối. Không tự ghi đè nguồn gốc bằng tóm tắt AI. Dữ liệu lưu đệm cần mã nguồn, phiên bản/thời điểm và hạn dùng; giá, tồn kho, quyền và trạng thái quan trọng được kiểm tra lại trước hành động.

## 2. Tín hiệu thị trường khác hồ sơ cá nhân

Phiếu nghiên cứu gồm vấn đề, phân khúc, nguồn, thời gian quan sát, tín hiệu sớm, tổ chức liên quan, giả thuyết và phép thử. Mặc định dùng dữ liệu tổng hợp, tài liệu được cấp quyền hoặc thông tin công khai phù hợp mục đích.

Không nối một quan sát thị trường với người cụ thể chỉ bằng suy đoán. Không lấy danh sách học viên, thành viên nhóm, hồ sơ nhạy cảm hoặc dữ liệu đăng nhập để “tìm nhu cầu sớm”. Đối tác có thể được ghi như tổ chức và nguồn giới thiệu; quyền đối tác chỉ bao phủ dữ liệu cần thiết đã thỏa thuận.

Tín hiệu phải có thời hạn hữu ích. Ví dụ thời điểm chuyến đi đã qua không còn là lý do tiếp tục chăm sóc chiến dịch đó; hệ thống cần cập nhật hoặc ngừng dùng.

## 3. Đồng ý liên hệ theo mục đích

| Tình huống | Quy tắc thiết kế |
|---|---|
| Khách hỏi thông tin công khai | Có thể trả lời hợp lệ mà không ép đăng ký tiếp thị |
| Khách đặt giao hàng | Chỉ thu thông tin giao nhận cần thiết; không tự bật quảng cáo |
| Khách đăng ký nhận ưu đãi | Lưu kênh, mục đích, cách xác nhận, thời gian và phiên bản nội dung |
| Khách rút đồng ý | Ngừng lịch gửi tương ứng, ghi lý do và sự kiện rút lại |
| Chuyển mô-đun hoặc đối tác | Không mở rộng mục đích/đối tượng nhận dữ liệu chỉ vì đã có hồ sơ |

Phân loại thông báo giao dịch, quyền lợi và quảng cáo phải được người phụ trách rà soát. Mọi lần gửi kiểm tra điều kiện hiện tại, không chỉ ảnh chụp cấu hình lúc bắt đầu.

### Lưu món chưa đăng nhập

Chỉ áp dụng khi bật tính năng sau P1. Bộ nhớ trình duyệt chỉ lưu mã sản phẩm và phiên bản dữ liệu cần thiết, không lưu hồ sơ, khóa dịch vụ hay thông tin ngân hàng.

Khi đăng nhập, xác minh tài khoản → đề nghị/áp dụng cách hợp nhất đã công bố → máy chủ xác nhận → mới xóa bản tạm. Hợp nhất lỗi thì không xóa mất dữ liệu. Thiết bị dùng chung cần cách xóa và xử lý đăng xuất; mã phiên không phải bằng chứng danh tính.

<a id=section-12></a>

## 4. Kho kiến thức và thẻ bằng chứng

Mỗi tài liệu cần chủ sở hữu, nguồn, phiên bản, trạng thái duyệt, quyền xem, ngày hiệu lực/hết hạn và sản phẩm liên quan.

Luồng trả lời: câu hỏi → lọc doanh nghiệp/quyền/sản phẩm → tìm nguồn hiện hành → tạo câu trả lời được nguồn hỗ trợ → lưu tham chiếu. AI không tự sửa hoặc phê duyệt kho kiến thức trong lúc trả lời.

| Loại nội dung | Cách sử dụng |
|---|---|
| Công dụng, thông số, hướng dẫn hãng | Giải thích và so sánh đúng điều kiện |
| Câu hỏi phổ biến, xử lý lỗi | Hướng dẫn trong danh sách được duyệt |
| Giao hàng, bảo hành, đổi trả | Giải thích chính sách; không thay quyền phê duyệt |
| Tài liệu nội bộ | Chỉ dùng theo vai trò; không trích nội dung riêng cho khách |
| Nghiên cứu/nhận xét thị trường | Hỗ trợ giả thuyết; không coi là chính sách hoặc sự thật về cá nhân |

Thẻ bằng chứng dùng chung gồm: phát biểu/đề xuất, loại sự kiện hay suy luận, nguồn và vị trí, phiên bản/ngày tra, điều kiện áp dụng, giới hạn và người duyệt nếu cần.

Ngữ cảnh AI chỉ lấy tin gần đây, tóm tắt, thông tin đã xác minh, trạng thái đang xử lý và nguồn liên quan. Không gửi cả hồ sơ chỉ vì có sẵn. Nội dung tài liệu, trang web và kết quả công cụ là dữ liệu không đáng tin về mặt chỉ dẫn; không thể cấp quyền bằng câu “bỏ qua quy tắc”.

Truy xuất hai giai đoạn hoặc xếp hạng lại là lựa chọn cải thiện khi bộ thử cho thấy cần; không yêu cầu cơ sở dữ liệu véc-tơ hoặc mô hình riêng ngay từ đầu. Mức tự tin AI tự báo không thay bằng chứng.

<a id=section-18></a>

## 5. Danh mục sản phẩm và dữ liệu giá

Dùng API danh mục hiện có hoặc bản nhập được kiểm soát. Không tạo hệ thống sản phẩm thứ hai nếu không cần.

| Nhóm | Trường cần thiết |
|---|---|
| Nhận diện | Mã hàng, biến thể, phiên bản, tên, nhóm và đơn vị bán |
| Phù hợp | Nhu cầu đáp ứng, giới hạn, tương thích, điều kiện dùng |
| Điều khoản | Tiền tệ, giá, cách tính thuế/phí, đơn vị thời gian nếu thuê bao |
| Khả dụng | Tồn kho/khả năng cung cấp, vùng phục vụ, thời điểm cập nhật |
| Bằng chứng | Nguồn thông số, mô tả đã duyệt, điều kiện đo |
| Khuyến mãi | Chương trình, điều kiện, thời hạn, cách cộng dồn |
| Kinh tế nội bộ | Giá vốn/chi phí/giới hạn chỉ cho bộ tính giá và vai trò được phép, không đưa nguyên vào ngữ cảnh khách |

Thiếu giá hoặc điều kiện quan trọng thì không phát hành báo giá tự động. Lưu phiên bản/ảnh chụp điều khoản với đề xuất; kiểm tra lại trước tạo đơn. Công thức giá sàn ở [đo lường](../delivery/analytics.md#unit-economics), quyền thực thi ở [Bán hàng](../modules/sales.md).

## 6. Vòng đời dữ liệu và kiểm thử

1. Tài liệu mới chưa duyệt không được dùng trả lời.
2. Nguồn hết hạn, thu hồi quyền hoặc bị gỡ phải bị loại khỏi truy xuất và bộ nhớ đệm liên quan.
3. Yêu cầu xuất/xóa dữ liệu phải bao phủ bản lưu, tệp, chỉ mục dẫn xuất, bản sao lưu theo thời hạn và nhật ký theo chính sách được duyệt; không hứa xóa tức thì mọi bản sao nếu chưa có cơ chế.
4. Ghi rõ thời hạn lưu, vai trò truy cập, dữ liệu gửi nhà cung cấp AI và quy trình sự cố.
5. Không dùng dữ liệu giữa doanh nghiệp hoặc huấn luyện lại cho mục đích khác nếu chưa có quyền thích hợp.

Kiểm thử phải chứng minh không truy xuất chéo doanh nghiệp, không xem đơn bằng mã tự khai, không dùng tài liệu bị gỡ, không hợp nhất danh tính mơ hồ, không mất danh sách món khi hợp nhất lỗi và không tiếp tục gửi sau rút đồng ý.
