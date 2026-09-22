# Báo Cáo Trạng Thái Dự Án AgentOS Customer360

> **Tài liệu đọc chính của dự án.** Báo cáo này được cập nhật mỗi khi có kết quả mới từ quá trình thiết kế, triển khai local, kiểm thử, sandbox hoặc production.
>
> **Trạng thái hiện tại:** Dự án đang ở giai đoạn thiết kế/blueprint. Chưa có application runtime, chưa có dữ liệu khách hàng thật và chưa được phép vận hành production.

## 1. Thông Tin Báo Cáo

| Mục | Giá trị |
|---|---|
| Dự án | AgentOS Customer360 |
| Ngày cập nhật | 21/09/2026 |
| Nhánh làm việc | `bao` |
| Môi trường hiện tại | Local repository, design-only |
| Trạng thái vận hành | Chưa vận hành production |
| Dữ liệu | Chỉ có dữ liệu mẫu synthetic/offline; không có dữ liệu khách hàng thật |
| Người duyệt | Đã duyệt tiếp tục bổ sung thiết kế theo yêu cầu hiện tại |

## 2. Hiện Trạng Hệ Thống

### 2.1 Hiện trạng tổng quan

Đây là bộ hồ sơ thiết kế cho nền tảng AI đa tenant phục vụ ba nhóm nghiệp vụ:

- Marketing
- Sales
- Customer Support

Kiến trúc mục tiêu đã được mô tả ở mức blueprint, gồm Revenue Orchestrator, các agent chuyên biệt, Customer 360, knowledge/memory, policy enforcement, approval queue, Command Center, connector và observability.

Hiện tại repository chưa có mã nguồn runtime để khởi động hệ thống. Các đoạn code, DDL, API contract, pipeline và test case hiện có là đặc tả mục tiêu, không phải bằng chứng hệ thống đã triển khai.

### 2.2 Tài liệu thiết kế đã có

- `implement/01` đến `implement/09`: nền tảng kỹ thuật, cấu trúc, dữ liệu, orchestrator, skill, connector, UI, security và roadmap.
- `implement/10`: data sovereignty và source of truth.
- `implement/11`: pricing policy và promotion governance.
- `implement/12`: identity, consent và access boundary.
- `implement/13`: approval readiness và governance gates.
- `implement/14`: incident response, rollback và operational runbook.
- `implement/15`: MVP v1 scope, release strategy và out-of-scope boundary.
- `testcases/`: acceptance specifications và synthetic offline fixtures.

### 2.3 Tình trạng kiểm thử hiện tại

Bộ test hiện là đặc tả chấp nhận, chưa phải test runtime đã chạy:

- 383 case tổng cộng.
- 370 case offline.
- 13 case live/sandbox.
- 419 file generated được kiểm tra nhất quán.
- 94/94 requirement được phủ.
- 143/143 facet bắt buộc được phủ.
- Trạng thái mặc định của test case là `NOT_RUN`.

Lệnh kiểm tra cấu trúc hiện tại:

```powershell
python testcases/_generate.py --check
```

Kết quả gần nhất: đạt, không có lỗi hoặc cảnh báo; generator không ghi thay đổi nào.

## 3. Luồng Xử Lý Hiện Tại

Đây là luồng xử lý **được thiết kế**, chưa phải luồng runtime đã triển khai:

```text
Tín hiệu / sự kiện
    -> Xác định tenant và customer context
    -> Kiểm tra identity và consent
    -> Nạp dữ liệu từ nguồn sự thật được chỉ định
    -> Truy hồi knowledge/memory có phạm vi phù hợp
    -> Agent tạo hypothesis/recommendation
    -> Policy Engine kiểm tra authority, pricing, consent và business rules
    -> Quyết định tự xử lý hoặc đưa vào approval queue
    -> Người có thẩm quyền approve / reject / modify / cancel
    -> Connector thực thi nếu đủ điều kiện
    -> Ghi evidence và outcome
    -> Theo dõi, học hỏi có kiểm soát và xử lý sự cố nếu cần
```

Revenue Orchestrator được mô tả theo 11 bước:

```text
SIGNAL -> CONTEXT -> HYPOTHESIS -> DECISION -> PLAN -> ACTION
-> APPROVAL -> EXECUTION -> EVIDENCE -> OUTCOME -> LEARNING
```

Nguyên tắc quan trọng:

- AI không phải source of truth cho giá, tồn kho, đơn hàng hoặc identity.
- Material action phải qua approval theo policy đã duyệt.
- Identity, consent, provenance hoặc policy không rõ thì fail closed.
- Không được để một agent tự ý gọi trực tiếp agent khác; điều phối đi qua orchestrator.
- Mỗi tenant và customer phải giữ đúng phạm vi context.

## 4. Vấn Đề Đã Gặp Phải

### 4.1 Vấn đề kiến trúc và governance

- Ranh giới giữa AI recommendation và source of truth cần được làm rõ.
- Pricing/promotion không được để AI tự quyết.
- Identity và consent cần có vòng đời, không chỉ là một cờ trạng thái.
- Approval trước material action chưa đủ rõ nếu chỉ mô tả ở mức UI.
- Chưa có runbook đầy đủ cho incident, safe mode và rollback.
- Phạm vi nền tảng lớn, dễ mở rộng vượt quá khả năng kiểm duyệt của MVP.

### 4.2 Vấn đề triển khai

- Chưa có application runtime.
- Chưa có database runtime, worker, API server hoặc frontend chạy thật.
- Chưa kết nối ERP/POS/provider thật.
- Chưa có production metrics, incident metrics hoặc KPI baseline.
- Chưa thể kết luận hệ thống xử lý đúng chỉ từ việc generator và fixture hợp lệ.

## 5. Nguyên Nhân

- Dự án đang ở giai đoạn thiết kế, nên nhiều thành phần mới dừng ở contract và blueprint.
- Phạm vi business gồm nhiều module và nhiều thị trường, trong khi authority và governance phải được chốt trước khi code.
- Một số giả định ASM-001..005 chưa được khóa bởi các owner tương ứng.
- Chưa có dữ liệu thật và connector sandbox được duyệt để kiểm chứng hành vi ngoài đời.
- Acceptance cases đã được viết rộng để bảo vệ yêu cầu, nhưng runtime thực thi chưa được xây dựng.

## 6. Phương Án Xử Lý

### 6.1 Đã bổ sung ở mức thiết kế

1. Thiết lập data sovereignty và phân loại source of truth, mirror, derived data, cache.
2. Tách pricing policy engine khỏi AI recommendation.
3. Thiết kế identity verification, consent lifecycle và session isolation.
4. Thiết kế approval readiness, governance gates và human sign-off.
5. Thiết kế incident response, safe mode, tenant pause, global stop, rollback và return-to-service gate.
6. Giới hạn MVP v1 thành một release supervised, dùng synthetic data và sandbox trước production.
7. Định nghĩa rõ phần out-of-scope để không tự động mở rộng phạm vi.

### 6.2 Phương án triển khai được đề xuất

```text
R0 Design Review
    -> R1 Offline Contract Validation
    -> R2 Internal Supervised Demo
    -> R3 Isolated Sandbox Pilot
    -> R4 Controlled Tenant Pilot
    -> R5 Production Expansion Review
```

Không chuyển thẳng từ blueprint sang production. Mỗi bước phải có evidence, owner, điều kiện thoát và quyền dừng.

### 6.3 Nguyên tắc ưu tiên

- Ưu tiên Customer Support read-only trước các hành động tài chính.
- Ưu tiên một tenant và một workflow trước multi-tenant rollout rộng.
- Ưu tiên approval và audit evidence trước autonomous execution.
- Ưu tiên offline fixture và contract test trước connector thật.
- Chỉ tăng authority khi có kết quả kiểm thử và phê duyệt rõ ràng.

## 7. Phương Pháp Luận

Phương pháp luận của dự án gồm:

1. **Source-anchored design:** lấy SRS, business plan và các contract hiện có làm nguồn đối chiếu.
2. **Risk-based delivery:** xử lý trước các điểm có thể gây thiệt hại về tiền, dữ liệu, quyền riêng tư và uy tín.
3. **Human-in-the-loop:** material action không được tự động vượt qua người duyệt.
4. **Fail-closed:** thiếu identity, consent, provenance, policy hoặc connector evidence thì dừng an toàn.
5. **Offline-first:** dùng dữ liệu mẫu synthetic và thời gian cố định trước khi dùng sandbox.
6. **Evidence-first:** mỗi quyết định quan trọng phải truy ngược được request, policy, approver, execution và outcome.
7. **Incremental release:** mở rộng từng workflow, tenant, connector và authority level theo gate riêng.
8. **Design/runtime separation:** phân biệt rõ tài liệu mục tiêu, kết quả local, kết quả sandbox và kết quả production.

## 8. Hành Động

### 8.1 Hành động - Local

> Phần này sẽ được cập nhật khi bắt đầu viết và chạy mã nguồn local.

- Tiêu đề hành động local:
- Mục tiêu:
- File/module liên quan:
- Lệnh hoặc cách thực hiện:
- Người thực hiện:
- Ngày thực hiện:
- Trạng thái:

### 8.2 Hành động - Production

> Phần này để trống cho đến khi có phê duyệt production, connector lock, sandbox evidence và kế hoạch phát hành được duyệt.

- Tiêu đề hành động production:
- Mục tiêu:
- Phạm vi tenant/workflow:
- Điều kiện phê duyệt:
- Kế hoạch rollback:
- Người chịu trách nhiệm:
- Ngày thực hiện:
- Trạng thái:

## 9. Kết Quả

### 9.1 Kết quả - Local

> Phần này sẽ được cập nhật sau mỗi lần có kết quả kiểm thử, build, chạy runtime hoặc thay đổi mã nguồn local.

- Tiêu đề kết quả local:
- Kết quả quan sát được:
- Lệnh kiểm chứng:
- Evidence/link:
- Vấn đề còn lại:
- Ngày cập nhật:

### 9.2 Kết quả - Production

> Chưa có kết quả production. Không được ghi `PASS`, KPI, uptime, conversion hoặc kết luận vận hành vào đây nếu chưa có evidence production tương ứng.

- Tiêu đề kết quả production:
- Kết quả quan sát được:
- Tenant/workflow:
- Evidence/provider receipt:
- Incident hoặc rollback liên quan:
- Người xác nhận:
- Ngày cập nhật:

## 10. Quy Tắc Cập Nhật Báo Cáo

Mỗi thay đổi hoặc kết quả mới phải cập nhật tối thiểu:

- ngày và môi trường: local, sandbox hay production,
- hành động đã thực hiện,
- kết quả quan sát được,
- lệnh hoặc evidence dùng để kiểm chứng,
- vấn đề mới phát sinh,
- quyết định tiếp theo và người chịu trách nhiệm.

Không ghi kết quả production dựa trên kết quả local. Không ghi `PASS` cho test specification khi runtime chưa chạy. Không đưa dữ liệu khách hàng thật, secret, token hoặc credential vào báo cáo.

## 11. Lịch Sử Cập Nhật

| Ngày | Môi trường | Cập nhật | Kết quả |
|---|---|---|---|
| 21/09/2026 | Local/design | Tạo báo cáo trạng thái làm tài liệu đọc chính; tổng hợp hiện trạng, luồng, vấn đề, nguyên nhân, phương án và phương pháp luận. | Blueprint đã có 15 tài liệu implement; chưa có runtime; fixture integrity check đạt. |
| 21/09/2026 | Local/design | Bổ sung tài liệu incident response/runbook và MVP v1 scope/release strategy. | Đã cập nhật index; chưa triển khai code hoặc production. |
| 21/09/2026 | Local/design | Bổ sung approval readiness, data sovereignty, pricing policy, identity/consent. | Đã có thiết kế governance trước vận hành. |

## 12. Kết Luận Hiện Tại

Dự án đang ở trạng thái **đủ hồ sơ để tiếp tục review và chuẩn bị implementation planning**, nhưng **chưa đủ điều kiện để gọi là hệ thống đã triển khai hoặc production-ready**.

Bước hợp lý tiếp theo là chọn một MVP workflow nhỏ, được duyệt rõ, rồi bắt đầu viết runtime local với synthetic fixtures. Mọi kết quả code, test, sandbox và production về sau sẽ được ghi vào các mục Hành động/Kết quả tương ứng trong báo cáo này.