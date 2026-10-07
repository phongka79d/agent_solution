# BÁO CÁO TOÀN DIỆN: KIỂM TOÁN LỖI VÀ ĐỐI CHIẾU MÃ NGUỒN (COMPREHENSIVE BUG AUDIT & RECONCILIATION REPORT)
**Dự án:** AgentOS NovaMart Demo Platform  
**Nhánh làm việc:** `tai` (đối chiếu trực tiếp với `phong/feat/demo-live-3agent` tại commit `3a40819`)  
**Thời gian cập nhật:** 30/09/2026 - 08:35:00 (GMT+7)  
**Tác giả:** Đội ngũ phát triển (Tài & AI Pair Programmer)  
**Trạng thái kiểm thử:** 17/17 Turbo tasks PASS 100% trên nhánh `tai`  

---

## MỤC LỤC
1. [Tổng quan cập nhật từ phía Phong (Commits bd1bf83 -> 3a40819)](#i-tổng-quan-cập-nhật-từ-phía-phong)
2. [Bảng ma trận tổng hợp 25 Bug trên hệ thống (B-01 đến B-25)](#ii-ma-trận-tổng-hợp-25-bug-toàn-hệ-thống)
3. [Phân tích chi tiết từng lỗi & Giải pháp khắc phục](#iii-chi-tiết-từng-lỗi-nguyên-nhân--giải-pháp)
   - [Nhóm A: Lỗi cực kỳ nghiêm trọng (Critical / Blocker)](#nhóm-a-lỗi-cực-kỳ-nghiêm-trọng-critical--blocker)
   - [Nhóm B: Lỗi chức năng & hồi quy cao (High Priority)](#nhóm-b-lỗi-chức-năng--hồi-quy-cao-high-priority)
   - [Nhóm C: Lỗi giao diện, BFF & phân quyền (Medium Priority)](#nhóm-c-lỗi-giao-diện-bff--phân-quyền-medium-priority)
   - [Nhóm D: Lỗi nhỏ & cải thiện môi trường (Low Priority)](#nhóm-d-lỗi-nhỏ--cải-thiện-môi-trường-low-priority)
4. [Lộ trình khuyến nghị triển khai sửa lỗi (Action Plan)](#iv-lộ-trình-khuyến-nghị-triển-khai-sửa-lỗi)

---

## I. TỔNG QUAN CẬP NHẬT TỪ PHÍA PHONG

Tính đến thời điểm hiện tại, remote `phong/feat/demo-live-3agent` (đã được kéo về và theo dõi tại local branch `phong-latest`) đã đẩy thêm **23 commit mới** so với nhánh gốc:
- `bd1bf83`: Tái cấu trúc phân lớp generic demo, thêm migration `0012`, `0013`, tách kịch bản `smoke.mjs` (`--live` và `--offline`), viết lại `turn-classifier.ts`.
- `39999f4`: Bổ sung các bảng chiếu CRM & Company Projection (`company/overview`, `company/attention`, `company/ai-team`, `company/activity`, `company/integrations`).
- `9d4cb93`: `feat(ui-foundation): react primitives, i18n catalog and status vocabulary` - Di chuyển toàn bộ UI Primitives sang package dùng chung, bổ sung i18n Việt/Anh và status view vocabulary.
- `69369a7`: `refactor(consoles): adopt shared primitives and AuthLayout` - Tái cấu trúc console sử dụng primitives và trang sign-in tinh giản.
- `3a40819`: `test(consoles): component test harness` - Bổ sung Testing Library + jsdom test harness cho frontend.

⚠️ **KẾT QUẢ ĐỐI SOÁT:** Mặc dù Phong đã bổ sung rất nhiều tính năng giao diện và cấu trúc foundation mới, quá trình kiểm tra chéo đã phát hiện **25 lỗi thực tế**, trong đó có những lỗi hồi quy phá vỡ toàn bộ kịch bản demo tiếng Việt, gây sập giao diện Storefront khi nhân viên tiếp quản, và race condition làm hỏng kết quả chạy của Worker.

---

## II. MA TRẬN TỔNG HỢP 25 BUG TOÀN HỆ THỐNG

| Mã Bug | Mức độ | Module ảnh hưởng | Tóm tắt lỗi | Trạng thái khuyến nghị |
|:---:|:---:|:---|:---|:---:|
| **B-24** | 🔴 Critical | API / `turn-classifier.ts` | Tiền tệ và ngân sách tiếng Việt (`triệu`, `tr`, `đồng`, `đ`) bị vứt bỏ, sập tư vấn bán hàng | **Phải sửa ngay** |
| **B-20** | 🔴 Critical | Console / `storefront/page.tsx` | Thiếu `task_id` trong receipt `HUMAN_OWNED` làm sập UI chat khi Human Takeover | **Phải sửa ngay** |
| **B-23** | 🔴 Critical | Worker / `worker-polling.ts` | Race condition trong lease heartbeat khiến Task đã hoàn thành bị đánh dấu lỗi | **Phải sửa ngay** |
| **B-13** | 🔴 Critical | Scripts / `smoke.mjs` | `segment_id` dùng UUID làm sập validation `/^inactive_[1-9][0-9]*d$/` trong Smoke Test | **Phải sửa ngay** |
| **B-19** | 🔴 Critical | API / `approvals.ts` | Unbound Governance Setting ném 504 `PROVIDER_TIMEOUT` chặn đứng toàn bộ phê duyệt | **Phải sửa ngay** |
| **B-10** | 🟠 High | Console / `storefront/page.tsx` | Hàm `hasGroundedChatEntry` ẩn toàn bộ câu trả lời của Bot nếu không có citation | **Phải sửa ngay** |
| **B-16** | 🟠 High | API / `turn-classifier.ts` | Map từ khóa "máy tính" -> `"computers"`, trong khi catalog chỉ có `"laptops"` | **Phải sửa ngay** |
| **B-21** | 🟠 High | Database / `company-crm-projections.ts` | `getCustomerProfile` dùng `INNER JOIN` làm khách hàng mới bị lỗi HTTP 404 | **Phải sửa ngay** |
| **B-22** | 🟠 High | Console BFF / `route.ts` & Client | Whitelist proxy của BFF thiếu `/company/*`, chặn 100% màn hình Company mới | **Phải sửa ngay** |
| **B-11** | 🟠 High | Worker / `read-handlers.ts` | Bị revert cơ chế tìm kiếm đa từ khóa ("laptop msi" không ra kết quả) | **Phải sửa ngay** |
| **B-01** | 🟠 High | Worker / `faq-parser.ts` | Câu hỏi rỗng được chấm 1.0 (100%) tin cậy, trả lời sai lệch FAQ chăm sóc khách hàng | **Phải sửa ngay** |
| **B-08** | 🟠 High | API / `turn-classifier.ts` | Bỏ sót ký hiệu `đ` và từ viết tắt `tr` trong biểu thức chính quy số tiền | **Gộp vào B-24** |
| **B-09** | 🟠 High | API / `turn-classifier.ts` | Bắt buộc phải có từ `"cho/dùng cho"` mới nhận diện nhu cầu sử dụng | **Gộp vào B-24** |
| **B-14** | 🟠 High | Worker / `worker-bindings.ts` | Bỏ fallback `CARE_KNOWLEDGE_ROOT`, Marketing mất kết nối tới Second Brain | **Phải sửa ngay** |
| **B-15** | 🟠 High | API / `turn-classifier.ts` | Thiếu danh mục `monitors`, `storage` và use-case `office` trong taxonomy | **Gộp vào B-24** |
| **B-17** | 🟡 Medium | UI / `StatusBadge.tsx` | Không truyền `code` thì icon bị ép thành dấu chấm hỏi `?` (`HelpCircle`) | **Nên sửa** |
| **B-18** | 🟡 Medium | UI / `Tabs.tsx` | `activeTabId` không khớp thì tự chọn tab 0 gây lệch state điều hướng | **Nên sửa** |
| **B-25** | 🟡 Medium | Console Auth / `demo-provider.ts` | Hardcode `DEMO_TENANT_ID` chặn toàn bộ tenant thật đăng nhập | **Nên sửa** |
| **B-12** | 🟡 Medium | Scripts / `seed.mjs` | Chạy lệnh node trực tiếp trên Windows không tự nạp `.env` | *Đã sửa trên `tai`* |
| **B-03** | 🟡 Medium | Worker / `read-handlers.ts` | Thiếu chặn trần `discount_percent <= 100`, nguy cơ sinh giá âm | **Nên sửa** |
| **B-04** | 🟡 Medium | Console / `trace/page.tsx` | Truy cập qua query `?run_id=xxx` không tự động kích hoạt tải trace | *Đã sửa trên `tai`* |
| **B-05** | 🟡 Medium | Console / `operations/page.tsx` | Đổi qua lại giữa các hội thoại làm mất trạng thái lease của operator | *Đã sửa trên `tai`* |
| **B-02** | 🟡 Medium | Worker / `types.ts` & `catalog.ts` | Thiếu trường `specs` trong interface sản phẩm | *Đã sửa trên `tai`* |
| **B-31** | 🔴 Critical | Worker / `marketing/factory.ts` | Giới hạn instruction 500 ký tự lệch hợp đồng API Gateway (2000 ký tự) làm sập Worker | *Đã sửa trên `tai`* |
| **B-32** | 🟠 High | Mock ERP / `server.mjs` | Tra cứu khách hàng & lịch sử theo `key` ở chế độ non-demo bị trả 404 | *Đã sửa trên `tai`* |
| **B-33** | 🟡 Medium | Console / `analytics` & `settings` | Sập 500 khi thiếu biến môi trường `PLATFORM_ADMIN_URL` | *Đã sửa trên `tai`* |
| **B-34** | 🟠 High | API / `demo-widget.ts` & Mock ERP | Sai lệch routing `/catalog/items` và lọc projection khiến catalog sập | *Đã sửa trên `tai`* |
| **B-35** | 🔴 Critical | Console / `ConversationConsole.tsx` & Client | Thiếu `postOperatorMessage` khiến tin nhắn tiếp quản gửi nhầm vào luồng bot | *Đã sửa trên `tai`* |
| **B-06** | 🟢 Low | Mock ERP / `server.mjs` | Tra cứu khách hàng theo `key` ở chế độ non-demo bị thiếu | *Đã xử lý trong B-32* |
| **B-07** | 🟢 Low | API / `demo-widget.ts` | Catalog projection loại bỏ các sản phẩm không có trường `use_case` | *Đã xử lý trong B-34* |

---

## III. CHI TIẾT TỪNG LỖI, NGUYÊN NHÂN & GIẢI PHÁP

### NHÓM A: LỖI CỰC KỲ NGHIÊM TRỌNG (CRITICAL / BLOCKER)

#### 1. Bug B-24: Nhận diện tiền tệ và ngân sách tiếng Việt thất bại trong `turn-classifier.ts`
- **File:** [apps/api/src/routes/v1/turn-classifier.ts](file:///d:/New%20folder/apps/api/src/routes/v1/turn-classifier.ts)
- **Đoạn mã lỗi:**
  ```typescript
  function currencyHint(normalized: string): string | undefined {
    if (normalized.includes('$')) return 'USD';
    if (normalized.includes('€')) return 'EUR';
    if (normalized.includes('£')) return 'GBP';
    const match = normalized.match(
      /\b([a-z]{3})\b(?=\s*[0-9])|\b([a-z]{3})\b(?=\s*(?:under|below|for|to)\b)|\b[0-9][0-9.,]*\s*(?:million|m|billion|b|thousand|k|trieu|nghin)?\s*([a-z]{3})\b/i,
    );
    return (match?.[1] ?? match?.[2] ?? match?.[3])?.toUpperCase();
  }
  function budgetHint(normalized: string): SalesBudget | undefined {
    const currency = currencyHint(normalized);
    if (currency === undefined) return undefined;
    // ...
    const multiplier = unit === 'million' || unit === 'm' || unit === 'trieu' ? 1_000_000 : ...;
  }
  ```
- **Nguyên nhân gốc rễ:**
  1. `currencyHint` chỉ chấp nhận mã 3 ký tự `[a-z]{3}`. Từ tiếng Việt như `trieu` (5 ký tự), `dong` (4 ký tự) đều bị bỏ qua.
  2. Khi khách gõ: *"Tư vấn laptop dưới 20 triệu"*, `currencyHint` trả về `undefined`.
  3. Hàm `budgetHint` thấy `currency === undefined` thì **lập tức hủy luôn việc đọc số tiền** và trả về `undefined`.
  4. Đơn vị viết tắt `tr` bị bỏ sót khỏi regex hệ số nhân, khiến *"20tr vnd"* bị nhân với 1 thành `20 VND`.
  5. Trong [read-handlers.ts](file:///d:/New%20folder/apps/worker/src/runtime/sales/skills/read-handlers.ts), worker so khớp `list_price > advisorBudget.amount`. Với ngân sách 20 VND, toàn bộ laptop trong catalog (~18.900.000 VND) đều bị loại bỏ, bot văng lỗi `AUTHORITATIVE_SOURCE_UNAVAILABLE`.
- **Giải pháp khắc phục:**
  - Tự động nhận diện `VND` khi câu có các từ khóa tiếng Việt (`trieu`, `tr`, `nghin`, `k`, `d`, `dong`, `vnd`).
  - Bổ sung `tr` vào regex `(million|m|billion|b|thousand|k|trieu|nghin|tr)`.
  - Mặc định currency là `VND` cho tenant NovaMart nếu khách không chỉ định ngoại tệ khác.

---

#### 2. Bug B-20: Giao diện Storefront sập khi Human Takeover do thiếu `task_id` trong `HUMAN_OWNED`
- **File:** [apps/api/src/routes/v1/care-turn.ts:L316-L337](file:///d:/New%20folder/apps/api/src/routes/v1/care-turn.ts#L316-L337) và [apps/tenant-console/src/app/(app)/demo/storefront/page.tsx:L180-L218](file:///d:/New%20folder/apps/tenant-console/src/app/%28app%29/demo/storefront/page.tsx#L180-L218)
- **Đoạn mã lỗi:**
  - Phía API (`care-turn.ts`):
    ```typescript
    const receipt: TaskAcceptedResponse = {
      status: 'HUMAN_OWNED',
      conversation_id: session.conversation_id,
      correlation_id: resolvedCorrelationId,
    };
    ```
  - Phía Frontend (`storefront/page.tsx`):
    ```typescript
    function parseReceiptLine(line: string): TaskAcceptedResponse | null {
      // ...
      if (typeof record.task_id !== 'string' || record.task_id.length === 0) return null;
      return record as unknown as TaskAcceptedResponse;
    }
    // ...
    if (!receipt) throw new Error('The storefront stream ended without a valid task receipt');
    ```
- **Nguyên nhân gốc rễ:** Khi nhân viên đã bật Human Takeover (`paused_takeover`), tin nhắn khách gửi đến không sinh task xử lý nền cho bot mà chuyển ngay cho con người, nên payload không có trường `task_id`. Nhưng hàm `parseReceiptLine` trên client lại bắt buộc `task_id` phải là string, dẫn đến trả về `null`. Kết thúc luồng stream, client ném ngoại lệ làm sập toàn bộ giao diện chat của khách.
- **Giải pháp khắc phục:** Cập nhật `parseReceiptLine` chấp nhận trạng thái `record.status === 'HUMAN_OWNED'`, hiển thị trạng thái *"Đã chuyển đến chuyên viên tư vấn"* thay vì báo lỗi kết nối.

---

#### 3. Bug B-23: Race condition trong Heartbeat của Worker Poller reject nhầm Task đã chạy xong
- **File:** [apps/worker/src/worker-polling.ts:L65-L85](file:///d:/New%20folder/apps/worker/src/worker-polling.ts#L65-L85)
- **Đoạn mã lỗi:**
  ```typescript
  const heartbeat = async (): Promise<void> => {
    if (settled || controller.signal.aborted) return;
    try {
      const current = await options.workflowRepository.getTask(tenant_id, taskRecord.run_id);
      const parked = current?.state === 'waiting' || current?.state === 'awaiting_human';
      if (
        current === null
        || (current.state !== 'running' && !parked)
        || current.lease_owner !== options.workerId
      ) {
        throw new Error('TASK_LEASE_NOT_HELD: execution lease is no longer owned by this worker');
      }
  ```
- **Nguyên nhân gốc rễ:** Khi `processTask` hoàn tất, nó chuyển trạng thái task trong cơ sở dữ liệu sang `'completed'`. Nếu timer heartbeat kích hoạt trước khi promise của `processTask` resolve hoàn toàn, heartbeat thấy `current.state === 'completed'` (khác `'running'`), liền ném lỗi `TASK_LEASE_NOT_HELD`, gọi `controller.abort()` và reject `leaseLost`. `Promise.race([taskPromise, leaseLost])` bắt phải ngoại lệ này và ghi nhận task thất bại dù thực tế đã chạy thành công!
- **Giải pháp khắc phục:** Nếu `current?.state === 'completed' || current?.state === 'failed'`, heartbeat chỉ cần gọi `stopHeartbeat()` và thoát êm.

---

#### 4. Bug B-13: `segment_id` dùng UUID làm sập validation trong Smoke Test
- **File:** [scripts/demo/smoke.mjs:L226](file:///d:/New%20folder/scripts/demo/smoke.mjs#L226) vs [apps/worker/src/runtime/marketing/factory.ts:L178-L185](file:///d:/New%20folder/apps/worker/src/runtime/marketing/factory.ts#L178-L185)
- **Đoạn mã lỗi:**
  - `smoke.mjs`:
    ```javascript
    segment_id: stableUuid('segment', 'inactive90'),
    ```
  - `factory.ts`:
    ```typescript
    if (typeof segment_id !== 'string' || !/^inactive_[1-9][0-9]*d$/.test(segment_id)) {
      throw new OrchestratorError('VALIDATION_FAILED', 'campaign.requested segment_id must be a server-normalized inactive_Nd segment');
    }
    ```
- **Nguyên nhân gốc rễ:** `smoke.mjs` truyền UUID 36 ký tự (ví dụ `3e70cfeb-...`), trong khi worker `factory.ts` dùng biểu thức chính quy bắt buộc phải có dạng `inactive_90d`. Kịch bản chạy `node scripts/demo/smoke.mjs --live` sẽ bị từ chối ngay lập tức tại bước Marketing.
- **Giải pháp khắc phục:** Sửa `smoke.mjs` truyền `segment_id: 'inactive_90d'`.

---

#### 5. Bug B-19: Unbound Governance Setting ném lỗi 504 chặn đứng toàn bộ phê duyệt
- **File:** [apps/api/src/routes/v1/approvals.ts:L188-L214](file:///d:/New%20folder/apps/api/src/routes/v1/approvals.ts#L188-L214)
- **Đoạn mã lỗi:**
  ```typescript
  if (deps.governance === undefined) {
    throw new Error('GOVERNANCE_SETTINGS_UNBOUND');
  }
  // Trong catch:
  return fail('PROVIDER_TIMEOUT', 'governance settings could not be read');
  ```
- **Nguyên nhân gốc rễ:** `governance` được định nghĩa là port tùy chọn (`readonly governance?: GovernancePort`). Khi chạy ở môi trường test hoặc tenant chưa cấu hình chính sách quản trị, mã nguồn ném lỗi và biến thành mã lỗi HTTP 504 `PROVIDER_TIMEOUT`, làm tê liệt tính năng duyệt chiến dịch.
- **Giải pháp khắc phục:** Khi `deps.governance === undefined`, fallback về mặc định an toàn: `require_distinct_approver = false`.

---

### NHÓM B: LỖI CHỨC NĂNG & HỒI QUY CAO (HIGH PRIORITY)

#### 6. Bug B-10: Giao diện Storefront tự động giấu câu trả lời của Bot nếu không có trích dẫn nguồn
- **File:** [apps/tenant-console/src/app/(app)/demo/storefront/page.tsx](file:///d:/New%20folder/apps/tenant-console/src/app/%28app%29/demo/storefront/page.tsx)
- **Nguyên nhân:** Khi bot trả lời câu chào hỏi, câu hỏi làm rõ (clarification prompt) hoặc hướng dẫn chung, bot chỉ trả lời `text` mà không kèm mảng `sources`. Hàm `hasGroundedChatEntry` trả về `false` và UI giấu luôn câu trả lời của bot, hiển thị thông báo xám: *"Unavailable: the task completed without a grounded answer and citation"*.
- **Giải pháp khắc phục:** Cho phép hiển thị nội dung `entry.text` nếu là tin nhắn đối thoại thông thường hoặc câu hỏi làm rõ nhu cầu.

#### 7. Bug B-16: Category Taxonomy map "máy tính" -> "computers" trong khi catalog chỉ có "laptops"
- **File:** [apps/api/src/routes/v1/turn-classifier.ts](file:///d:/New%20folder/apps/api/src/routes/v1/turn-classifier.ts)
- **Nguyên nhân:** Bảng taxonomy của Phong gán regex `may tinh` thành danh mục `'computers'`. Trong khi đó, toàn bộ sản phẩm máy tính của NovaMart trong [novamart.json](file:///d:/New%20folder/services/mock-erp/src/demo/novamart.json) đều được phân loại là `'laptops'`. Khi khách gõ *"Tư vấn máy tính văn phòng"*, bộ lọc của Sales worker sẽ tìm danh mục `computers` và loại bỏ 100% sản phẩm.
- **Giải pháp khắc phục:** Map các từ khóa máy tính/laptop về danh mục hợp lệ trong catalog: `'laptops'`.

#### 8. Bug B-21: `getCustomerProfile` trả về 404 cho khách hàng hợp lệ do `INNER JOIN`
- **File:** [packages/database/src/repositories/company-crm-projections.ts:L289-L292](file:///d:/New%20folder/packages/database/src/repositories/company-crm-projections.ts#L289-L292)
- **Nguyên nhân:** Câu lệnh SQL truy vấn: `FROM agentos.customer_360_profiles p JOIN agentos.customers c ON ...`. Nếu khách hàng có trong `customers` nhưng chưa có hàng tổng hợp trong bảng `customer_360_profiles`, truy vấn trả về rỗng và API trả về `404 Not Found`.
- **Giải pháp khắc phục:** Chuyển sang `FROM agentos.customers c LEFT JOIN agentos.customer_360_profiles p ON p.tenant_id = c.tenant_id AND p.customer_id = c.id WHERE c.tenant_id = $1 AND c.id = $2`.

#### 9. Bug B-22: Các endpoint Company Projection bị thiếu trong Whitelist Proxy của Tenant Console BFF
- **File:** [apps/tenant-console/src/app/api/v1/[...path]/route.ts](file:///d:/New%20folder/apps/tenant-console/src/app/api/v1/%5B...path%5D/route.ts) & [tenant-console-client.ts](file:///d:/New%20folder/apps/tenant-console/src/lib/tenant-console-client.ts)
- **Nguyên nhân:** Phong đã xây dựng các route backend `/company/overview`, `/company/attention`, `/company/ai-team`, `/company/activity`, `/company/integrations`, nhưng trong file proxy `route.ts` của BFF, hàm `isAllowedPath` không bổ sung regex `company/*`. Mọi request từ trình duyệt đều bị chặn với mã lỗi 404.
- **Giải pháp khắc phục:** Thêm `^company\/(?:overview|attention|ai-team|activity|integrations|settings\/governance)$` vào `isAllowedPath()` và bổ sung các hàm tương ứng trong `tenantConsoleClient`.

#### 10. Bug B-11: Revert mất tính năng tìm kiếm đa từ khóa trong `read-handlers.ts`
- **File:** [apps/worker/src/runtime/sales/skills/read-handlers.ts](file:///d:/New%20folder/apps/worker/src/runtime/sales/skills/read-handlers.ts)
- **Nguyên nhân:** Commit của Phong dùng `searchable.includes(query)`. Khi tìm kiếm `"laptop msi"`, chuỗi con không khớp liên tục với `"MSI Modern 14 Laptop"`, làm rớt sản phẩm.
- **Giải pháp khắc phục:** Khôi phục cơ chế token hóa: `terms.every(term => searchable.includes(term))`.

#### 11. Bug B-01: Lỗi tính điểm FAQ chấm 100% tin cậy cho câu hỏi rỗng
- **File:** [apps/worker/src/runtime/care/skills/faq-parser.ts:L67-L71](file:///d:/New%20folder/apps/worker/src/runtime/care/skills/faq-parser.ts#L67-L71) & [faq-handler.ts:L52-L60](file:///d:/New%20folder/apps/worker/src/runtime/care/skills/faq-handler.ts#L52-L60)
- **Nguyên nhân:** Khi chuỗi tìm kiếm rỗng `""`, `string.includes("")` luôn trả về `true` cho mọi câu FAQ trong kho, khiến bot chăm sóc khách hàng đưa ra câu trả lời sai.
- **Giải pháp khắc phục:** Kiểm tra `queryText.trim().length === 0` thì trả về điểm 0. Chuyển chữ thường (`toLowerCase()`) trước khi so khớp.

#### 12. Bug B-14: Worker Marketing mất đường dẫn Second Brain do bỏ fallback `CARE_KNOWLEDGE_ROOT`
- **File:** [apps/worker/src/worker-bindings.ts:L452-L460](file:///d:/New%20folder/apps/worker/src/worker-bindings.ts#L452-L460)
- **Nguyên nhân:** Code chỉ đọc `env.KNOWLEDGE_ROOT`. Nếu biến này chưa được cấu hình trong `.env`, đường dẫn tri thức của Marketing bị `undefined`.
- **Giải pháp khắc phục:** Giữ fallback: `env.KNOWLEDGE_ROOT ?? env.CARE_KNOWLEDGE_ROOT`.

---

### NHÓM C: LỖI GIAO DIỆN, BFF & PHÂN QUYỀN (MEDIUM PRIORITY)

#### 13. Bug B-17: Tất cả StatusBadge không truyền `code` bị render sai icon thành HelpCircle (`?`)
- **File:** [packages/ui-foundation/src/react/StatusBadge.tsx](file:///d:/New%20folder/packages/ui-foundation/src/react/StatusBadge.tsx) & [status-view.ts](file:///d:/New%20folder/packages/ui-foundation/src/status-view.ts)
- **Nguyên nhân:** Khi gọi `<StatusBadge label="Integrated" tone="success" />`, `code` không được truyền, component fallback về `{ icon: 'HelpCircle' }`. Dẫn đến trên giao diện xuất hiện hàng loạt icon dấu hỏi cạnh các trạng thái thành công ("Integrated", "Active").
- **Giải pháp khắc phục:** Nếu không có `code`, tự động map icon mặc định theo `tone`: `success -> CheckCircle2`, `danger -> XCircle`, `warning -> AlertTriangle`, `info -> Clock`.

#### 14. Bug B-18: `Tabs.tsx` fallback sai khi `activeTabId` không tồn tại
- **File:** [packages/ui-foundation/src/react/Tabs.tsx](file:///d:/New%20folder/packages/ui-foundation/src/react/Tabs.tsx)
- **Nguyên nhân:** Khi `activeTabId` truyền vào một id không tồn tại trong danh sách tabs, hàm `findIndex` trả về `-1`, `Math.max(0, -1)` thành `0`. Component tự động chọn tab đầu tiên và render panel 0, gây bất đồng bộ giữa URL query và UI tab.
- **Giải pháp khắc phục:** Kiểm tra `findIndex >= 0`, nếu không tìm thấy thì giữ `undefined` hoặc chỉ fallback khi không ở chế độ controlled.

#### 15. Bug B-25: Hardcode `DEMO_TENANT_ID` chặn mọi tenant khác đăng nhập
- **File:** [apps/tenant-console/src/lib/auth/demo-provider.ts:L114](file:///d:/New%20folder/apps/tenant-console/src/lib/auth/demo-provider.ts#L114)
- **Nguyên nhân:** Hàm `parseAuthSession` kiểm tra cứng `tenantId !== DEMO_TENANT_ID`. Bất kỳ tenant thực tế nào ngoài demo khi đăng nhập đều bị BFF từ chối và quăng lỗi `502 DEMO_UNAVAILABLE`.
- **Giải pháp khắc phục:** Cho phép nhận `tenantId` hợp lệ từ session token mà không bị gán cứng vào UUID của demo tenant.

#### 16. Bug B-03: Thiếu chặn trần phần trăm giảm giá `<= 100%`
- **File:** [apps/worker/src/runtime/sales/skills/read-handlers.ts:L608](file:///d:/New%20folder/apps/worker/src/runtime/sales/skills/read-handlers.ts#L608)
- **Nguyên nhân:** Chỉ kiểm tra `requested_discount_percent > 0` mà không kiểm tra `<= 100`. Nếu người dùng yêu cầu giảm 150%, giá sẽ ra số âm.
- **Giải pháp khắc phục:** Thêm điều kiện `input.requested_discount_percent <= 100`.

#### 17. Bug B-04: Màn hình Trace Console không tự tải khi có URL `?run_id=xxx`
- **File:** [apps/tenant-console/src/app/demo/trace/page.tsx](file:///d:/New%20folder/apps/tenant-console/src/app/demo/trace/page.tsx)
- **Nguyên nhân:** Có nhận param `run_id` trên thanh địa chỉ nhưng thiếu `useEffect` tự động gọi API `loadTrace()` khi mở trang.
- **Giải pháp khắc phục:** Thêm hook `useEffect` kích hoạt tải vết thực thi khi có `run_id`.

#### 21. Bug B-26: Customer Care Intent & Order Reference Extraction thất bại với mẫu câu tiếng Việt tự nhiên
- **File:** [apps/worker/src/runtime/care/agent-runtime.ts:L314-L401](file:///d:/New%20folder/apps/worker/src/runtime/care/agent-runtime.ts#L314-L401)
- **Nguyên nhân gốc rễ:**
  1. `extractOrderReference` chỉ bắt các tiền tố `(ORD|SO)-` và từ khóa tiếng Anh `order|tracking|package|shipment`. Hoàn toàn thiếu tiền tố `DH-` (Đơn Hàng) và từ khóa tiếng Việt như `đơn hàng`, `mã đơn`, `mã vận đơn`, `đơn`.
  2. `classifyCareIntent` có regex `order_status` chỉ bắt `\b(don hang.*(dau|nao|toi dau)|tinh trang don|don cua toi)\b`. Khi người dùng gõ câu hỏi tự nhiên như *"kiểm tra đơn hàng 12345"*, *"tra cứu đơn DH-9988"*, regex không khớp và `orderRef` là `null`, khiến yêu cầu bị rơi xuống `requires_clarification` thay vì tra cứu đơn.
  3. `isOrderStatusMessage` và `isQuestionMessage` không chạy qua `normalizeIntentText`, làm mất khả năng nhận diện tiếng Việt không dấu hoặc có dấu khi không có ký tự `?`.
- **Giải pháp khắc phục:** Bổ sung tiền tố `DH-`, mở rộng regex keyword tiếng Việt (`don hang|ma don|ma van don|don`) và tích hợp `normalizeIntentText` vào `isOrderStatusMessage`, `isQuestionMessage`.

#### 22. Bug B-27: Mất Heartbeat Lease khi Operator chuyển qua lại giữa các hội thoại trong Operations Console
- **File:** [apps/tenant-console/src/app/demo/operations/page.tsx:L202-L221](file:///d:/New%20folder/apps/tenant-console/src/app/demo/operations/page.tsx#L202-L221)
- **Nguyên nhân gốc rễ:** Hook `useEffect` của heartbeat chỉ thiết lập interval cho duy nhất `selectedId`. Khi operator đang giữ lease của Conversation A, nếu click sang xem Conversation B (chưa có lease), `lease` của conversation hiện tại là `null`, interval heartbeat bị hủy. Sau 60 giây (TTL backend), lease của Conversation A sẽ âm thầm hết hạn trên Redis/server mà operator không hề hay biết.
- **Giải pháp khắc phục:** Thiết lập heartbeat định kỳ chạy trên toàn bộ danh sách `leases` đang hoạt động (`Object.entries(leases)`), đồng thời gọi `setLease(null, convId)` riêng biệt cho từng conversation gặp lỗi thay vì phụ thuộc vào `selectedId`.

#### 23. Bug B-28: Nút hành động phê duyệt trong Campaigns Console bị disable vĩnh viễn khi list endpoint thiếu digest
- **File:** [apps/tenant-console/src/app/demo/campaigns/page.tsx:L272](file:///d:/New%20folder/apps/tenant-console/src/app/demo/campaigns/page.tsx#L272)
- **Nguyên nhân gốc rễ:** Trong `handleDecision()`, tác giả đã chủ động xử lý fallback gọi API `GET /api/v1/approvals/:id` để đọc `payload_sha256` nếu item danh sách chưa có. Tuy nhiên, trên nút bấm giao diện (Approve, Reject, Pause, Cancel), điều kiện lại để: `disabled={approvalBusy === approval.approval_id || !approval.payload_sha256}`. Điều này chặn người dùng bấm nút khi digest chưa có, biến đoạn logic fallback lấy detail thành dead code.
- **Giải pháp khắc phục:** Bỏ `|| !approval.payload_sha256` trên nút bấm để cho phép người dùng click kích hoạt quy trình kiểm tra và tải digest authoritative.

#### 24. Bug B-29: Sales Worker `handleCheckPrice` trả về `discount_allowed: true` khi phần trăm giảm giá không hợp lệ
- **File:** [apps/worker/src/runtime/sales/skills/read-handlers.ts:L605-L622](file:///d:/New%20folder/apps/worker/src/runtime/sales/skills/read-handlers.ts#L605-L622)
- **Nguyên nhân gốc rễ:** Biến `let discount_allowed = true;` được khởi tạo mặc định. Khi người dùng truyền `requested_discount_percent` âm (`< 0`) hoặc vượt trần (`> 100`), điều kiện `if` bị bỏ qua và giá giữ nguyên `list_price`. Tuy nhiên kết quả trả về vẫn là `discount_allowed: true`, gây hiểu nhầm cho agent/UI rằng mức giảm giá yêu cầu đã được chấp thuận.
- **Giải pháp khắc phục:** Khởi tạo `discount_allowed = false;` nếu có yêu cầu giảm giá nhưng không hợp lệ hoặc không đủ điều kiện so với sàn giá (`p_floor`).

#### 25. Bug B-30: Storefront Stream ghi `[pending: unknown]` cho hội thoại đã chuyển giao người (`HUMAN_OWNED`) & Mất tin nhắn khi lỗi
- **File:** [apps/api/src/routes/v1/storefront.ts:L426-L431](file:///d:/New%20folder/apps/api/src/routes/v1/storefront.ts#L426-L431) & [apps/tenant-console/src/app/demo/storefront/page.tsx:L415](file:///d:/New%20folder/apps/tenant-console/src/app/demo/storefront/page.tsx#L415)
- **Nguyên nhân gốc rễ:**
  1. Khi hội thoại đã chuyển giao quyền điều khiển cho con người (`HUMAN_OWNED`), receipt không có `task_id`. Backend `storefront.ts` ghi vào luồng stream chunk `\n[pending: unknown]\n`. Đây là thông tin sai lệch ngữ nghĩa (trạng thái thực tế là đã chuyển giao cho chuyên viên tư vấn).
  2. Trên Storefront UI, `setMessage('')` được gọi ngay trước khi gửi request. Nếu request bị ngắt kết nối mạng hoặc server trả 500, nội dung tin nhắn của khách bị mất trắng.
- **Giải pháp khắc phục:** Không xuất `[pending: unknown]` khi status là `HUMAN_OWNED`, và khôi phục lại input text khi `fetch` bị lỗi.

#### 26. Bug B-31: Lệch giới hạn độ dài chỉ thị Marketing giữa API Gateway và Worker Runtime gây sập tác vụ
- **File:** [apps/worker/src/runtime/marketing/factory.ts:L200](file:///d:/New%20folder/apps/worker/src/runtime/marketing/factory.ts#L200), [apps/api/src/routes/v1/campaigns.ts:L29](file:///d:/New%20folder/apps/api/src/routes/v1/campaigns.ts#L29), [apps/tenant-console/src/app/demo/campaigns/page.tsx:L264](file:///d:/New%20folder/apps/tenant-console/src/app/demo/campaigns/page.tsx#L264)
- **Nguyên nhân gốc rễ:**
  - Giao diện Tenant Console thiết lập `maxLength={2000}` trên ô nhập chỉ thị chiến dịch tiếp thị.
  - API Gateway định nghĩa và xác thực theo `MAX_INSTRUCTION_LENGTH = 2000`, chấp thuận các chỉ thị dài đến 2000 ký tự và trả về mã HTTP 202 Accepted.
  - Tuy nhiên, Marketing Worker trong `factory.ts` dòng 200 lại chặn: `instruction.length > 500` và ném lỗi `MARKETING_CAMPAIGN_INVALID`.
  - Hậu quả: Khi nhà quản trị tạo chiến dịch có hướng dẫn chi tiết dài từ 501 đến 2000 ký tự, API Gateway trả về thành công nhưng Worker lập tức sập quy trình sinh kế hoạch tiếp thị.
- **Giải pháp khắc phục:** Cập nhật điều kiện độ dài trong `apps/worker/src/runtime/marketing/factory.ts` thành `instruction.length > 2000` để đồng bộ hoàn toàn với hợp đồng API Gateway và UI, đồng thời bổ sung bộ test kiểm chứng độ dài tới 2000 ký tự.

#### 27. Bug B-32: Mock ERP Customer Lookup & Sales History làm rơi trường generic `key` khi chạy non-demo
- **File:** [services/mock-erp/src/server.mjs:L458-L525](file:///d:/New%20folder/services/mock-erp/src/server.mjs#L458-L525)
- **Nguyên nhân gốc rễ:**
  - Adapter ERP chuẩn (`packages/adapters/src/erp/api-001-erp.ts`) khi đọc resource `customers` và `customer_sales_history` gửi body theo format chuẩn generic `{ key: input.key }`.
  - Trong Mock ERP server, nhánh fallback khi không có `demoPack` (dùng cho CI hoặc local dev chuẩn) chỉ kiểm tra `if (body.customer_id !== CUSTOMER.customer_id)`.
  - Do client gửi `key` nên `body.customer_id` bị `undefined`, dẫn đến so sánh luôn sai và trả về mã lỗi HTTP 404 `AUTHORITATIVE_SOURCE_UNAVAILABLE`.
- **Giải pháp khắc phục:** Trích xuất định danh khách hàng linh hoạt `const customerId = typeof body?.customer_id === 'string' ? body.customer_id : (typeof body?.key === 'string' ? body.key : null);` cho cả 2 endpoint và ràng buộc `tenant_id` theo `scope` chuẩn xác.

#### 28. Bug B-33: Tenant Console `/analytics` và `/settings` gặp lỗi máy chủ 500 khi thiếu cấu hình `PLATFORM_ADMIN_URL`
- **File:** [apps/tenant-console/src/app/(dashboard)/analytics/page.tsx:L6-L16](file:///d:/New%20folder/apps/tenant-console/src/app/(dashboard)/analytics/page.tsx#L6-L16) & [apps/tenant-console/src/app/(dashboard)/settings/page.tsx:L6-L16](file:///d:/New%20folder/apps/tenant-console/src/app/(dashboard)/settings/page.tsx#L6-L16)
- **Nguyên nhân gốc rễ:**
  - Cả hai trang trực tiếp gọi `platformAdminUrl(path)`, ném một unhandled exception: `throw new Error('PLATFORM_ADMIN_URL is required for tenant-console redirects.')` nếu biến môi trường `PLATFORM_ADMIN_URL` chưa được khai báo.
  - Khi người dùng hoặc người đánh giá chạy ứng dụng ở chế độ local hoặc demo độc lập, việc click vào menu Analytics hoặc Settings sẽ làm sập trang trắng với lỗi 500 Internal Server Error.
- **Giải pháp khắc phục:** Cập nhật hàm điều hướng để trả về `null` khi thiếu `PLATFORM_ADMIN_URL` và tự động fallback về route nội bộ phù hợp (`/demo/operations`), bảo đảm trải nghiệm mượt mà không crash.

#### 29. Bug B-34: Sai lệch URL route `/catalog/items` và lọc projection khiến endpoint Catalog sập khi chạy non-demo
- **File:** [apps/api/src/routes/v1/demo-widget.ts:L26-L39, L99](file:///d:/New%20folder/apps/api/src/routes/v1/demo-widget.ts#L26-L39), [services/mock-erp/src/server.mjs:L250](file:///d:/New%20folder/services/mock-erp/src/server.mjs#L250), [services/mock-erp/src/fixtures.mjs:L4-L12](file:///d:/New%20folder/services/mock-erp/src/fixtures.mjs#L4-L12)
- **Nguyên nhân gốc rễ:**
  1. Khi biến `ERP_API_BASE_URL` trỏ vào root `http://localhost:8081` (không có hậu tố `/api/v1`), `demo-widget.ts` gọi fetch đến `/catalog/items`, nhưng Mock ERP chỉ lắng nghe `/api/v1/catalog/items`, trả về 404 NOT_FOUND.
  2. Ở chế độ non-demo hoặc fixture tối giản, `CATALOG_ITEM` dùng các trường gốc (`sku`, `original_list_price`) thay vì `sku_id` và `list_price`, đồng thời thiếu các trường metadata giao diện (`brand`, `category`, `use_case`, `description`). Hàm `projectCatalogItem` kiểm tra cứng nhắc `typeof item[field] === 'string'` và loại bỏ 100% sản phẩm, khiến API ném lỗi `CAPABILITY_NOT_ENABLED: demo catalog contains no active products`.
- **Giải pháp khắc phục:**
  - Hỗ trợ bí danh route `/catalog/items` song song với `/api/v1/catalog/items` trong Mock ERP server.
  - Làm giàu `CATALOG_ITEM` fixture và mở rộng `projectCatalogItem` để đọc linh hoạt `sku_id ?? sku`, `list_price ?? original_list_price` cùng các giá trị mặc định cho metadata hiển thị.

#### 30. Bug B-35: SCR-005 Conversation Console & Client thiếu tích hợp endpoint `postOperatorMessage` khiến tin nhắn tiếp quản gửi nhầm vào luồng bot
- **File:** [apps/tenant-console/src/lib/tenant-console-client.ts:L245-L265](file:///d:/New%20folder/apps/tenant-console/src/lib/tenant-console-client.ts#L245-L265), [apps/tenant-console/src/components/conversation/ConversationConsole.tsx:L134-L151](file:///d:/New%20folder/apps/tenant-console/src/components/conversation/ConversationConsole.tsx#L134-L151)
- **Nguyên nhân gốc rễ:**
  - Trong quy trình tiếp quản con người (Human Takeover), operator giữ quyền điều khiển thông qua mutex lease. Mọi tin nhắn phản hồi của nhân viên phải được gửi đến `POST /api/v1/conversations/{id}/operator-messages` để ghi nhận trực tiếp vào lịch sử hội thoại dưới vai trò `operator`.
  - Tuy nhiên, `TenantConsoleClient` hoàn toàn không có hàm `postOperatorMessage`. Component `ConversationConsole.tsx` gọi `postConversationMessage` (luồng `/messages` dành cho lượt nói của khách hàng vào bot/AI agent), dẫn đến tin nhắn bị từ chối hoặc agent AI hiểu nhầm và tự động kích hoạt workflow sai.
- **Giải pháp khắc phục:** Bổ sung phương thức `postOperatorMessage` vào `TenantConsoleClient`, cập nhật `ConversationConsole.tsx` để điều hướng tin nhắn chính xác tới `/operator-messages` khi `isTakenOver` đang hoạt động, đồng thời thêm unit test bảo chứng hợp đồng.


### B-36. Bất đồng bộ giao thức Stream SSE khi kích hoạt Human Takeover
- **Mức độ nghiêm trọng:** HIGH (Phá vỡ UX luồng chat khi chuyển giao con người)
- **File:** [apps/api/src/routes/v1/storefront.ts](file:///d:/New%20folder/apps/api/src/routes/v1/storefront.ts), [packages/storefront-widget/src/stream.ts](file:///d:/New%20folder/packages/storefront-widget/src/stream.ts)
- **Nguyên nhân gốc rễ:**
  - API Storefront stream gửi chunk `\n[awaiting_human]\n` khi task rơi vào trạng thái chờ nhân viên tiếp quản (`awaiting_human`).
  - Trong khi đó, `parseStreamChunk` trong widget client yêu cầu định dạng `^[pending: ...]`, dẫn đến token stream bị bỏ qua hoặc hiển thị nguyên bản dạng text thô ra giao diện người dùng.
- **Giải pháp khắc phục:** Chuẩn hóa luồng emit stream `\n[pending: awaiting_human]\n` từ API, đồng thời nâng cấp regex parser trong `storefront-widget` để tương thích ngược cả hai định dạng.

### B-37. Lỗi Binding DTO và hiển thị "Mục dữ liệu" trên Customer 360 Profile
- **Mức độ nghiêm trọng:** MEDIUM (Ảnh hưởng trực tiếp giao diện hiển thị dữ liệu khách hàng)
- **File:** [apps/tenant-console/src/components/customer/Customer360Profile.tsx](file:///d:/New%20folder/apps/tenant-console/src/components/customer/Customer360Profile.tsx)
- **Nguyên nhân gốc rễ:**
  - DTO trả về từ API/DB dùng `display_name`, `customer_tier`, `total_spent`, `campaign_engagement`. Component console lại chỉ đọc `customer.name`, `customer.tier`, `customer.ltv` (fallback TWD) và `customer.marketing`, khiến tên luôn rơi về `"Khách hàng"`, tiền tệ sai và tab Marketing luôn rỗng.
  - Component `ListItems` chỉ kiểm tra `item.title ?? item.name`, trong khi các bảng đơn hàng, hỗ trợ, gợi ý có các trường định danh riêng (`order_number`, `subject`, `reason`, `case_number`), khiến 100% dòng dữ liệu hiển thị thành nhãn vô nghĩa `"Mục dữ liệu"`.
- **Giải pháp khắc phục:** Đồng bộ toàn bộ các trường dữ liệu DTO, hỗ trợ tiền tệ VND cho LTV/tổng chi tiêu, và bổ sung bộ phân giải nhãn thông minh `formatListItemText`.

### B-38. Lỗi Catch-22 khi điều hướng trực tiếp bằng URL tới Approval ID
- **Mức độ nghiêm trọng:** HIGH (Không thể mở link trực tiếp tới lượt phê duyệt)
- **File:** [apps/tenant-console/src/components/approvals/ApprovalCenter.tsx](file:///d:/New%20folder/apps/tenant-console/src/components/approvals/ApprovalCenter.tsx#L232)
- **Nguyên nhân gốc rễ:**
  - `useEffect` kiểm tra `if (!initialApprovalId || selectedItemId === initialApprovalId || !items[initialApprovalId]) return;`.
  - Khi người dùng bấm vào đường dẫn chia sẻ `/approvals/[id]`, danh sách `items` ban đầu chưa chứa item này (hoặc item đã qua trang khác), điều kiện `!items[initialApprovalId]` chặn không bao giờ gọi `handleSelectItem`, khiến màn hình trống trơn.
- **Giải pháp khắc phục:** Bỏ ràng buộc `!items[initialApprovalId]` để cho phép hàm `handleSelectItem` tự động fetch trực tiếp chi tiết phê duyệt từ backend theo ID.

### B-39. Mất Heartbeat Lease khi chuyển đổi qua lại giữa các hội thoại
- **Mức độ nghiêm trọng:** CRITICAL (Mất quyền tiếp quản khách hàng ngầm sau 30-60 giây)
- **File:** [apps/tenant-console/src/components/conversation/ConversationWorkspace.tsx](file:///d:/New%20folder/apps/tenant-console/src/components/conversation/ConversationWorkspace.tsx)
- **Nguyên nhân gốc rễ:**
  - `ConversationWorkspace` lưu `lease` dưới dạng state đơn lẻ. Khi operator chọn một hội thoại khác trong danh sách, `setLease(null)` được gọi ngay lập tức và timer heartbeat bị hủy cho hội thoại trước đó.
  - Hậu quả: Hội thoại mà operator đã tiếp quản trước đó bị quá hạn lease trên server (thường sau 60s), tự động trả quyền lại cho AI hoặc khóa phiên khi operator quay lại.
- **Giải pháp khắc phục:** Chuyển đổi cơ chế lưu lease thành dictionary `Record<string, Lease>`, duy trì timer định kỳ gia hạn tất cả các phiên tiếp quản hợp lệ của operator đang đăng nhập.

### B-40. Lỗi 500 Unhandled khi phân trang Danh sách Chiến dịch & Khách hàng
- **Mức độ nghiêm trọng:** MEDIUM (Sập 500 không mong muốn thay vì trả 400 Bad Request)
- **File:** [apps/api/src/gateway/http.ts](file:///d:/New%20folder/apps/api/src/gateway/http.ts), [apps/api/src/routes/v1/campaigns.ts](file:///d:/New%20folder/apps/api/src/routes/v1/campaigns.ts)
- **Nguyên nhân gốc rễ:**
  - Database repository ném các lỗi mã hóa `CAMPAIGN_LIST_LIMIT_INVALID`, `CAMPAIGN_LIST_CURSOR_INVALID`, `CUSTOMER_LIST_LIMIT_INVALID`, `CUSTOMER_LIST_CURSOR_INVALID` khi tham số `limit` hoặc `cursor` sai.
  - Tuy nhiên `REPOSITORY_CODE_MAP` trong `http.ts` bỏ sót các mã này, dẫn tới việc gateway chuyển thành lỗi 500 `INTERNAL_ERROR`. Đồng thời `campaigns.ts` không tiền kiểm tra định dạng số nguyên dương của `limit`.
- **Giải pháp khắc phục:** Bổ sung ánh xạ vào `REPOSITORY_CODE_MAP` sang mã HTTP 400 `VALIDATION_FAILED`, đồng thời kiểm tra chặt chẽ `limit` trong `handleCampaignList`.

### B-41. Khuyết từ vựng Tiếng Việt tự nhiên trong Sales Intent Classifier & Trạng thái Đơn hàng Care
- **Mức độ nghiêm trọng:** HIGH (Agent bán hàng không nhận diện ý định mua sắm cơ bản của người Việt)
- **File:** [apps/worker/src/runtime/sales/intent-classifier.ts](file:///d:/New%20folder/apps/worker/src/runtime/sales/intent-classifier.ts), [apps/worker/src/runtime/care/skills/order-handler.ts](file:///d:/New%20folder/apps/worker/src/runtime/care/skills/order-handler.ts)
- **Nguyên nhân gốc rễ:**
  - Khách hàng nói "tôi cần mua laptop", "mình muốn mua chuột gaming", "bên bạn có bán bàn phím không" thì phân loại `product_search` chỉ có các từ "tìm", "xem", "danh mục" mà không hề có các động từ "mua", "cần mua", "muốn mua", "có bán". Hậu quả: Intent rơi vào `unknown` và từ chối hỗ trợ.
  - Trong Care Worker, đơn hàng trạng thái `COMPLETED` từ ERP ném ngoại lệ `Unmappable provider order status` vì danh sách map chỉ có `DELIVERED`, `SHIPPED`, v.v.
- **Giải pháp khắc phục:** Bổ sung các cụm từ hành vi mua sắm tiếng Việt vào `BUILTIN_SALES_LEXICON.product_search` (với unit test đầy đủ) và ánh xạ trạng thái `COMPLETED` sang `DELIVERED`.

### B-42. Giới hạn sai quyền truy cập menu Hội thoại trên Console Navigation
- **Mức độ nghiêm trọng:** LOW (Khó khăn phân quyền người dùng)
- **File:** [apps/tenant-console/src/components/shell/CompanyShell.tsx](file:///d:/New%20folder/apps/tenant-console/src/components/shell/CompanyShell.tsx)
- **Nguyên nhân gốc rễ:**
  - API endpoint `/conversations` cho phép nhân viên có quyền `customer:read` hoặc `conversation:takeover` đọc danh sách hội thoại.
  - Tuy nhiên thanh điều hướng `CompanyShell.tsx` chỉ gán duy nhất `permission: 'conversation:takeover'`, khiến các tài khoản giám sát viên/nhân viên chỉ có quyền đọc khách hàng bị ẩn mất tab Hội thoại.
- **Giải pháp khắc phục:** Cập nhật quyền của mục điều hướng sang `permissions: ['conversation:takeover', 'customer:read']`.

### B-43. Bỏ qua `proposed_price` trong `handleCheckPrice` dẫn đến tính giá sai khi khách đề xuất giá trực tiếp
- **Mức độ nghiêm trọng:** HIGH (Lỗi tính giá kinh doanh & cam kết giá cho khách hàng)
- **File:** [apps/worker/src/runtime/sales/skills/read-handlers.ts](file:///d:/New%20folder/apps/worker/src/runtime/sales/skills/read-handlers.ts), [apps/worker/src/runtime/sales/skills/quote-price.test.ts](file:///d:/New%20folder/apps/worker/src/runtime/sales/skills/quote-price.test.ts)
- **Nguyên nhân gốc rễ:**
  - Khi khách hàng thương lượng giá bằng cách đưa ra một mức giá cụ thể (ví dụ: trả giá 90 TWD cho món hàng niêm yết 100 TWD với giá sàn 80 TWD), hàm `handleCheckPrice` gửi `proposed_price` cho pricing engine nhưng khi tính toán `final_price` và token quote ký số, code chỉ tính lại giá nếu có `requested_discount_percent`!
  - Kết quả: Khách hàng đề xuất giá hợp lệ nhưng token báo giá vẫn bị ký ở mức giá gốc niêm yết (100 TWD) thay vì 90 TWD. Ngược lại nếu trả giá dưới sàn mà không có discount percent thì token vẫn bị ký giá niêm yết mà cờ `discount_allowed` không được gắn chính xác.
- **Giải pháp khắc phục:** Bổ sung logic xử lý `proposed_price`: nếu `proposed_price >= p_floor` và `<= list_price`, chấp nhận giá đề xuất làm `final_price` và bật `discount_allowed = true`; nếu `proposed_price < p_floor`, giữ nguyên `list_price` và đặt `discount_allowed = false`. Bổ sung unit test toàn diện cho cả 2 trường hợp.

### B-44. Thiếu fallback `extend_seconds` trong Takeover Heartbeat gây lỗi 400 khi client gửi payload rỗng
- **Mức độ nghiêm trọng:** MEDIUM (Đứt gãy heartbeat duy trì phiên tiếp quản của nhân viên)
- **File:** [apps/api/src/routes/v1/conversations-takeover.ts](file:///d:/New%20folder/apps/api/src/routes/v1/conversations-takeover.ts), [apps/tenant-console/src/lib/types/tenant-console.ts](file:///d:/New%20folder/apps/tenant-console/src/lib/types/tenant-console.ts), [apps/api/src/routes/v1/conversations-takeover.test.ts](file:///d:/New%20folder/apps/api/src/routes/v1/conversations-takeover.test.ts)
- **Nguyên nhân gốc rễ:**
  - Route `POST /conversations/:id/takeover/heartbeat` kiểm tra `typeof extend_seconds !== 'number'`. Nếu client gửi `{}` (ping heartbeat tiêu chuẩn), API từ chối với lỗi 400 `VALIDATION_FAILED`.
  - Type `ConversationTakeoverHeartbeatRequest` trong tenant console cũng yêu cầu bắt buộc trường `extend_seconds`.
- **Giải pháp khắc phục:** Cho phép `extend_seconds` nhận giá trị mặc định là 60 giây khi bị bỏ qua (`body?.['extend_seconds'] ?? 60`), đồng thời nới lỏng interface `ConversationTakeoverHeartbeatRequest` thành `extend_seconds?: number | undefined`, bổ sung unit test kiểm tra cả payload rỗng và payload chỉ định rõ số giây.

### B-45. Thiếu các phương thức quản lý Campaign và Run Trace trong `TenantConsoleClient`
- **Mức độ nghiêm trọng:** MEDIUM (Thiếu đồng bộ API client giữa frontend và BFF Proxy)
- **File:** [apps/tenant-console/src/lib/tenant-console-client.ts](file:///d:/New%20folder/apps/tenant-console/src/lib/tenant-console-client.ts), [apps/tenant-console/src/lib/tenant-console-client.test.ts](file:///d:/New%20folder/apps/tenant-console/src/lib/tenant-console-client.test.ts)
- **Nguyên nhân gốc rễ:**
  - Proxy BFF của Tenant Console đã allowlist các endpoint `/campaigns`, `/campaigns/:id`, `/campaigns/drafts` và `/runs/:id/trace`.
  - Tuy nhiên `TenantConsoleClient` không cung cấp các phương thức tương ứng (`getCampaigns`, `getCampaign`, `createCampaignDraft`, `getRunTrace`), khiến các view và caller phải dùng fetch thô hoặc không gọi được API.
- **Giải pháp khắc phục:** Bổ sung đầy đủ các phương thức type-safe vào `TenantConsoleClient`, viết kèm bộ 4 unit tests kiểm tra URL, method và payload JSON tương ứng.

### B-46. Bổ sung ánh xạ lỗi phân trang Database Repository & Chuẩn hóa nút bấm Approval Modal
- **Mức độ nghiêm trọng:** MEDIUM (Tránh lỗi 500 khi client gửi tham số trang sai và hoàn thiện trải nghiệm tiếng Việt)
- **File:** [apps/api/src/gateway/http.ts](file:///d:/New%20folder/apps/api/src/gateway/http.ts), [apps/api/src/gateway/http.test.ts](file:///d:/New%20folder/apps/api/src/gateway/http.test.ts), [apps/tenant-console/src/components/approvals/ApprovalPayloadDiffModal.tsx](file:///d:/New%20folder/apps/tenant-console/src/components/approvals/ApprovalPayloadDiffModal.tsx)
- **Nguyên nhân gốc rễ:**
  - Database repository ném các lỗi tiền tố mã hóa như `CUSTOMER_EVENT_CURSOR_INVALID`, `CUSTOMER_EVENT_LIMIT_INVALID`, `CONVERSATION_LIMIT_INVALID`, `CONVERSATION_MESSAGE_LIMIT_INVALID`, `HANDOFF_LIMIT_INVALID`, `APPROVAL_EXPIRY_LIMIT_INVALID`. Khi gặp các lỗi này, do chưa có trong `REPOSITORY_CODE_MAP`, API gateway ném 500 `INTERNAL_ERROR` thay vì 400 `VALIDATION_FAILED`.
  - Trong `ApprovalPayloadDiffModal.tsx`, các nút "Close", "Approve", "Cancel Edit", "Submit MODIFY Revision", "Cancel", "Confirm REJECT" bị sót tiếng Anh trong khi các nút khác đã được Việt hóa ("Tạm dừng", "Hủy", "Sửa", "Từ chối…").
- **Giải pháp khắc phục:** Bổ sung toàn bộ các mã lỗi phân trang vào `REPOSITORY_CODE_MAP` (kèm unit test kiểm tra), và dịch chuẩn xác toàn bộ nhãn nút bấm sang tiếng Việt ("Đóng", "Phê duyệt", "Hủy sửa", "Gửi bản sửa đổi", "Xác nhận từ chối").

### B-47. Khớp khách hàng và lịch sử đơn hàng linh hoạt theo customer_code, logical ref, phone, email trong Mock ERP
- **Mức độ nghiêm trọng:** HIGH (Gãy truy vấn thông tin khách hàng và lịch sử mua sắm khi dùng mã khách hàng)
- **File:** [services/mock-erp/src/server.mjs](file:///d:/New%20folder/services/mock-erp/src/server.mjs), [services/mock-erp/test/server.test.mjs](file:///d:/New%20folder/services/mock-erp/test/server.test.mjs)
- **Nguyên nhân gốc rễ:**
  - Trong Mock ERP, endpoint `/api/v1/customers/lookup` và `/api/v1/customers/sales-history` chỉ so khớp bằng UUID `candidate.customer_id === customerId`. Khi caller truyền `customer_code: "C01"` hoặc `logical_customer_ref: "c01"`, hệ thống trả về 404.
  - Ngay cả khi tìm thấy khách hàng, truy vấn lịch sử đơn hàng trong demo pack lại lọc theo chuỗi `order.customer_id === customerId`. Do `order.customer_id` lưu UUID nên khi tìm theo `"C01"` kết quả đơn hàng trả về rỗng `[]` và `customer_id` trả về bị sai lệch thành `"C01"` thay vì UUID chuẩn.
  - Tương tự, tra cứu trạng thái đơn hàng (`/orders/status`) từ chối khi caller truyền `customer_id` dạng mã khách hàng (`C01`) dù đơn hàng thuộc về khách hàng đó.
- **Giải pháp khắc phục:** Mở rộng cơ chế so khớp khách hàng chấp nhận cả `customer_id`, `customer_code`, `logical_customer_ref`, `email`, `phone`, và `channel_identifier`. Đảm bảo lọc đơn hàng theo canonical `customer.customer_id` (hoặc mã/ref tương ứng) và trả về canonical `customer_id`. Bổ sung unit test toàn diện cho luồng tra cứu này.

### B-48. Bounded Memory Eviction chống rò rỉ bộ nhớ trong InMemoryTurnRateLimiter
- **Mức độ nghiêm trọng:** HIGH (Rò rỉ bộ nhớ gateway khi vận hành lâu dài với hàng nghìn phiên người dùng)
- **File:** [apps/api/src/routes/v1/care-turn.ts](file:///d:/New%20folder/apps/api/src/routes/v1/care-turn.ts), [apps/api/src/routes/v1/care-turn-limiter.test.ts](file:///d:/New%20folder/apps/api/src/routes/v1/care-turn-limiter.test.ts)
- **Nguyên nhân gốc rễ:**
  - `InMemoryTurnRateLimiter` lưu token bucket trong `Map<string, TokenBucket>` cho mỗi cặp `${tenant_id}:${session_id}` nhưng không có bất kỳ cơ chế dọn dẹp (eviction/pruning) nào.
  - Với gateway chat trực tuyến có hàng nghìn lượt session webchat tạm thời mỗi ngày, Map sẽ phình to không giới hạn gây nguy cơ OOM (Out Of Memory).
- **Giải pháp khắc phục:** Bổ sung cấu hình trần bộ nhớ `max_buckets` (mặc định 5,000) và ngưỡng hết hạn `stale_after_ms` (mặc định 1 giờ). Khi đạt trần, tự động quét và loại bỏ các bucket không hoạt động, nếu vẫn quá tải sẽ loại bỏ các bucket cũ nhất (FIFO). Thêm getter `size` và viết bộ 4 unit test kiểm tra cơ chế token và dọn dẹp bộ nhớ.

### B-49. Ánh xạ toàn diện lỗi thời gian và tham số repository sang 400 VALIDATION_FAILED
- **Mức độ nghiêm trọng:** MEDIUM (Tránh lỗi 500 khi client gửi tham số thời gian hoặc mã đối tượng không hợp lệ)
- **File:** [apps/api/src/gateway/http.ts](file:///d:/New%20folder/apps/api/src/gateway/http.ts), [apps/api/src/gateway/http.test.ts](file:///d:/New%20folder/apps/api/src/gateway/http.test.ts)
- **Nguyên nhân gốc rễ:**
  - Khi client gửi tham số thời gian sai định dạng (`from="yesterday"`), hoặc thiếu ID, database repository ném các lỗi `CUSTOMER_EVENT_RANGE_INVALID`, `CUSTOMER_EVENT_CUSTOMER_ID_REQUIRED`, `CUSTOMER_EVENT_CUSTOMER_ID_INVALID`, `PLATFORM_USAGE_WINDOW_INVALID`, v.v.
  - Các mã này chưa có trong `REPOSITORY_CODE_MAP` dẫn đến gateway trả về HTTP 500 `INTERNAL_ERROR` thay vì HTTP 400 `VALIDATION_FAILED`.
- **Giải pháp khắc phục:** Bổ sung đầy đủ 12 mã lỗi kiểm định repository vào `REPOSITORY_CODE_MAP` và cập nhật unit test gateway.

### B-50. Bổ sung phương thức getDemoCatalog trên TenantConsoleClient đồng bộ với BFF proxy
- **Mức độ nghiêm trọng:** MEDIUM (Thiếu phương thức client cho route BFF allowlisted)
- **File:** [apps/tenant-console/src/lib/tenant-console-client.ts](file:///d:/New%20folder/apps/tenant-console/src/lib/tenant-console-client.ts), [apps/tenant-console/src/lib/tenant-console-client.test.ts](file:///d:/New%20folder/apps/tenant-console/src/lib/tenant-console-client.test.ts)
- **Nguyên nhân gốc rễ:**
  - BFF Proxy đã allowlist endpoint `GET demo/catalog` và API gateway có route `/demo/catalog`, nhưng `TenantConsoleClient` thiếu phương thức `getDemoCatalog()`.
- **Giải pháp khắc phục:** Bổ sung phương thức type-safe `getDemoCatalog(options?)` vào `TenantConsoleClient` kèm unit test kiểm tra gọi đúng route `GET /api/v1/demo/catalog`.

---

## IV. LỘ TRÌNH KHUYẾN NGHỊ TRIỂN KHAI SỬA LỖI

### Giai đoạn 1: Vá ngay các lỗi Block kịch bản Demo trực tiếp (Đã hoàn thành trên nhánh `tai`)
1. **Sửa Bug B-24 & B-15:** Viết lại bộ regex nhận diện tiền tệ, ngân sách và phân loại danh mục trong `turn-classifier.ts` để thông suốt kịch bản tư vấn bằng tiếng Việt tự nhiên. *(Đã xong)*
2. **Sửa Bug B-20:** Cập nhật `storefront/page.tsx` và `care-turn.ts` xử lý êm receipt `HUMAN_OWNED` khi con người tiếp quản hội thoại. *(Đã xong)*
3. **Sửa Bug B-01, B-03, B-04, B-05:** Vá lỗi FAQ parser, giới hạn trần discount, trace autoload và duy trì map lease theo conversation ID. *(Đã xong)*

### Giai đoạn 2: Vá các lỗi sâu mới phát hiện (B-26 đến B-30) (Đã hoàn thành trên nhánh `tai`)
1. **Sửa Bug B-26:** Mở rộng nhận diện mã đơn hàng tiếng Việt (`DH-`, `đơn hàng`, `mã đơn`) trong Care Worker runtime. *(Đã xong)*
2. **Sửa Bug B-27:** Cải tiến heartbeat lease đa hội thoại trong Operations Console. *(Đã xong)*
3. **Sửa Bug B-28:** Mở khóa nút phê duyệt chiến dịch trong Campaigns Console để kích hoạt fallback nạp detail digest. *(Đã xong)*
4. **Sửa Bug B-29:** Điều chỉnh logic cờ `discount_allowed` trong `handleCheckPrice` của Sales Worker. *(Đã xong)*
5. **Sửa Bug B-30:** Chuẩn hóa stream phản hồi cho trạng thái `HUMAN_OWNED` và bảo toàn input text khi gặp lỗi kết nối. *(Đã xong)*

### Giai đoạn 3: Vá các lỗi hợp đồng & hệ sinh thái Mock/Console (B-31 đến B-33) (Đã hoàn thành trên nhánh `tai`)
1. **Sửa Bug B-31:** Đồng bộ độ dài chỉ thị chiến dịch 2000 ký tự trong Marketing Worker runtime (`factory.ts`), bổ sung unit test. *(Đã xong)*
2. **Sửa Bug B-32:** Hỗ trợ generic `key` cho Customer Lookup & Sales History trong Mock ERP (`server.mjs`), bổ sung unit test. *(Đã xong)*
3. **Sửa Bug B-33:** Thêm fallback êm cho `/analytics` và `/settings` khi không có `PLATFORM_ADMIN_URL`, chống sập 500. *(Đã xong)*

### Giai đoạn 4: Hoàn thiện tính năng tương tác Demo Catalog & Human Takeover Console (B-34 đến B-35) (Đã hoàn thành trên nhánh `tai`)
1. **Sửa Bug B-34:** Đồng bộ route `/catalog/items`, làm giàu fixture và chuẩn hóa projection sản phẩm trong `demo-widget.ts`, bổ sung unit test Mock ERP. *(Đã xong)*
2. **Sửa Bug B-35:** Tích hợp `postOperatorMessage` vào `TenantConsoleClient` và kết nối với `ConversationConsole.tsx` cho phiên tiếp quản con người, bổ sung unit test. *(Đã xong)*

### Giai đoạn 5: Tối ưu hoá toàn diện giao thức Streaming, Customer 360 DTO, Lease Heartbeat & Tiếng Việt Tự Nhiên (B-36 đến B-42) (Đã hoàn thành trên nhánh `tai`)
1. **Sửa Bug B-36:** Đồng bộ stream chunk `[pending: awaiting_human]` giữa API và storefront widget. *(Đã xong)*
2. **Sửa Bug B-37:** Khắc phục triệt để lỗi hiển thị "Mục dữ liệu" và mapping các trường DTO Customer 360. *(Đã xong)*
3. **Sửa Bug B-38:** Khắc phục lỗi trực kết nối URL trực tiếp của Approval Center. *(Đã xong)*
4. **Sửa Bug B-39:** Triển khai quản lý lease đa hội thoại chống timeout ngầm cho operator. *(Đã xong)*
5. **Sửa Bug B-40:** Ánh xạ lỗi phân trang thành 400 Bad Request thay vì 500 Internal Server Error. *(Đã xong)*
6. **Sửa Bug B-41:** Bổ sung từ vựng mua sắm tiếng Việt tự nhiên và hỗ trợ trạng thái đơn hàng `COMPLETED`. *(Đã xong)*
7. **Sửa Bug B-42:** Cân bằng quyền hiển thị menu Hội thoại theo chuẩn API. *(Đã xong)*

### Giai đoạn 6: Tính giá theo Đề xuất Trực tiếp, Takeover Heartbeat Fallback, Parity Client & Database Error Mapping (B-43 đến B-46) (Đã hoàn thành trên nhánh `tai`)
1. **Sửa Bug B-43:** Hỗ trợ tính giá và ký số quote token chuẩn xác theo `proposed_price` trực tiếp trong Sales Worker. *(Đã xong)*
2. **Sửa Bug B-44:** Hỗ trợ giá trị mặc định `extend_seconds = 60` cho Takeover Heartbeat, chống lỗi 400 khi client gửi `{}`. *(Đã xong)*
3. **Sửa Bug B-45:** Bổ sung các phương thức Campaign và Run Trace cho `TenantConsoleClient` đồng bộ với BFF proxy. *(Đã xong)*
4. **Sửa Bug B-46:** Bổ sung ánh xạ toàn diện lỗi phân trang database repository sang 400 `VALIDATION_FAILED` và hoàn thiện Việt hóa nút bấm modal phê duyệt. *(Đã xong)*

### Giai đoạn 7: Khớp Đa Định Danh Mock ERP, Bounded Rate Limiter Memory, Hoàn Thiện Repository Error Mapping & Catalog Client Parity (B-47 đến B-50) (Đã hoàn thành trên nhánh `tai`)
1. **Sửa Bug B-47:** Cho phép tra cứu khách hàng, lịch sử bán hàng và đơn hàng trong Mock ERP bằng `customer_code`, `logical_customer_ref`, `phone`, `email`; bảo toàn `customer.customer_id` chuẩn xác. *(Đã xong)*
2. **Sửa Bug B-48:** Thêm cơ chế bounded pruning chống rò rỉ bộ nhớ vô hạn trong `InMemoryTurnRateLimiter`. *(Đã xong)*
3. **Sửa Bug B-49:** Ánh xạ 12 mã lỗi thời gian/ID repository sang 400 `VALIDATION_FAILED` thay vì 500 `INTERNAL_ERROR`. *(Đã xong)*
4. **Sửa Bug B-50:** Bổ sung `getDemoCatalog()` vào `TenantConsoleClient` đồng bộ với BFF allowlist proxy. *(Đã xong)*

### Giai đoạn 8: Limit Validation, Structured Response Whitelist, Worker Race Condition & Cross-Domain Journey Resume (B-51 đến B-57) (Đã hoàn thành trên nhánh `tai`)

1. **Sửa Bug B-51:** Validate `limit` query param bằng regex + `Number.parseInt` trong `approvals.ts` và `operations.ts` trước khi truyền vào repository — tránh `NaN`/`Infinity`/`0` silent. *(Đã xong)*
2. **Sửa Bug B-53:** Thêm `RECOMMENDATION_SOURCE_FILE` và `INVENTORY_SOURCE_FILE` vào whitelist sales domain của `structuredResponse` trong `response.ts` — tránh `finalizerRefusal` sai cho phản hồi hợp lệ từ Recommendation/Inventory. *(Đã xong)*
3. **Sửa Bug B-55:** Thêm `expected_task_version` vào 2 lệnh `recordFailure` thiếu CAS guard khi unbound orchestrator trong `worker.ts`. *(Đã xong)*
4. **Sửa Bug B-57:** Thêm `handoff.marketing_to_sales`, `handoff.sales_to_care`, `handoff.care_to_retention` vào `RESUME_EVENT_TYPES` trong `worker.ts` — cross-domain journey resume không còn bị block với `RESUME_EVENT_INVALID`. *(Đã xong)*
5. **Sửa Bug B-52:** `DomainPolicyEngine.agentGrantCache` tích lũy vô hạn — bổ sung bounded FIFO eviction (giới hạn 1000 mục) ngăn ngừa rò rỉ bộ nhớ dài hạn. *(Đã xong)*
6. **Sửa Bug B-54:** `approval-expiry-sweeper` race condition `stop()+start()` — thêm cờ `isStopping` ngăn việc schedule timer mới trong khi sweeper đang đợi tác vụ in-flight kết thúc, bổ sung unit test. *(Đã xong)*
7. **Sửa Bug B-56:** `erp-http-transport` phân loại sai `TIMEOUT` vs `UNKNOWN` khi dual-abort signal — ưu tiên kiểm tra `input.signal?.aborted` trước để đảm bảo hủy từ caller luôn trả về `UNKNOWN`, bổ sung unit test. *(Đã xong)*
8. **Sửa Bug B-58:** API Gateway (`campaigns.ts`) không validate `objective` trước khi tạo task — bất kỳ chuỗi nào đều được chấp nhận, nhưng worker từ chối nếu không phải `reactivation`/`winback`. Hệ quả: task được cấp phát (202) nhưng ngay lập tức thất bại. Thêm `CAMPAIGN_OBJECTIVES` whitelist + check tại gateway. *(Đã xong)*
9. **Sửa Bug B-59:** API Gateway (`campaigns.ts`) không validate format `segment_id` — worker yêu cầu khớp pattern `^inactive_[1-9][0-9]*d$` (ví dụ `inactive_90d`). Giá trị sai như UUID hay `all_customers` qua được gateway nhưng bị worker từ chối. Thêm `SEGMENT_ID_PATTERN` regex validation tại gateway. *(Đã xong)*
10. **Sửa Bug B-60:** Kiểm tra ranh giới demo (`pnpm check:demo-boundary`) thất bại do chuỗi `'NovaMart'` bị gán cứng làm fallback brand trong hàm chiếu catalog `demo-widget.ts` (thuộc production root `apps/api/src/routes`). Thay thế bằng `'general'` chuẩn hóa theo category/use_case để vượt qua hoàn toàn bộ kiểm tra ranh giới bản dựng. *(Đã xong)*

### Giai đoạn 9: API Gateway Attachments Validation, Worker ERP Price/Quantity Guard & Takeover Reason Bound (B-61 đến B-63) (Đã hoàn thành trên nhánh `tai`)

1. **Sửa Bug B-61:** API Gateway (`conversations.ts`) thiếu validation `attachments` ở endpoint `POST /api/v1/conversations/:id/messages`. Khi client gửi `attachments` không phải array (chuỗi string, object, number, null) hoặc array chứa kiểu không phải string, toán tử spread `[...input.attachments]` trong `care-turn.ts` ném uncaught `TypeError`, gây crash HTTP 500 `INTERNAL_ERROR` thay vì HTTP 400 `VALIDATION_FAILED`. Đã bổ sung helper `attachmentsOf(body)` để reject dữ liệu không hợp lệ và hoàn thiện bộ unit test. *(Đã xong)*
2. **Sửa Bug B-62:** Worker Care Skill (`order-handler.ts`) thiếu validation `quantity <= 0`, `NaN` / negative `unit_price`, và `NaN` / negative `total_price` khi map đơn hàng từ ERP. Dữ liệu bẩn từ ERP có thể lọt qua ranh giới thẩm định của Care Agent và làm sai lệch tính toán tài chính downstream trong refund/warranty. Đã siết chặt kiểm tra `Number.isInteger(quantity) && quantity > 0`, `Number.isFinite(unit_price) && unit_price >= 0`, và `Number.isFinite(total_price) && total_price >= 0` với mã lỗi `AUTHORITATIVE_SOURCE_UNAVAILABLE`, bổ sung unit test. *(Đã xong)*
3. **Sửa Bug B-63:** API Gateway (`conversations-takeover.ts`) unbounded payload trường `reason` (tại endpoint Takeover) và `handoff_summary` (tại endpoint Resume). Thiếu giới hạn độ dài tiềm ẩn nguy cơ DoS và làm tràn bộ nhớ audit storage. Đã áp đặt `MAX_REASON_LENGTH = 1000` và `MAX_HANDOFF_SUMMARY_LENGTH = 2000`, bổ sung unit test. *(Đã xong)*

### Giai đoạn 10: Sales Cart/Order Input Boundary, Storefront Widget Attachments, Operator Port Typing & Demo Auth Email Boundary (B-64 đến B-68) (Đã hoàn thành trên nhánh `tai`)

1. **Sửa Bug B-64:** Worker Sales Skill (`mutation-handlers.ts`) trong `executeCreateCart` thiếu validation kiểu dữ liệu cho `sku_id` và số lượng `quantity`. Khi client gửi `quantity` âm hoặc bằng 0 (ví dụ: `-1`), phép so sánh tồn kho `available < item.quantity` trả về `false` (bỏ qua bước kiểm tra tồn kho SoR), đồng thời tạo giỏ hàng có số lượng âm. Đã bổ sung kiểm tra nghiêm ngặt `sku_id` non-empty string và `quantity` là số nguyên dương (`Number.isInteger(quantity) && quantity > 0`), ném mã lỗi `INVALID_INPUT`, bổ sung unit test. *(Đã xong)*
2. **Sửa Bug B-65:** Worker Sales Skill (`mutation-handlers.ts`) trong `executeCreateOrder` chỉ kiểm tra falsy của `cart_id` và `payment_method`, dẫn đến chuỗi chỉ chứa khoảng trắng (`"   "`) vẫn vượt qua được validation và gây lỗi không nhất quán downstream. Đã siết chặt kiểm tra `typeof === 'string' && trim().length > 0`, ném mã lỗi `INVALID_INPUT`, bổ sung unit test. *(Đã xong)*
3. **Sửa Bug B-66:** Storefront Widget SDK (`packages/storefront-widget/src/stream.ts`) hàm `buildStorefrontStreamRequestBody` thiếu hỗ trợ trường `attachments`. Trong khi API Gateway đã hỗ trợ nhận `attachments`, widget SDK client không thể gửi tệp đính kèm khi gọi streaming API. Đã cập nhật kiểu `StorefrontStreamRequestBody` và hàm `buildStorefrontStreamRequestBody` hỗ trợ `attachments`, bổ sung unit test. *(Đã xong)*
4. **Sửa Bug B-67:** API Gateway (`apps/api/src/routes/v1/operator-conversations.ts`) interface `OperatorConversationPort.appendMessage` thiếu trường `request_id`, mặc dù implementation truyền `request_id: operator-reply:...`. Đã bổ sung `readonly request_id?: string;` vào interface để đảm bảo tính toàn vẹn type safety của port contract. *(Đã xong)*
5. **Sửa Bug B-68:** Tenant Console BFF Auth Provider (`apps/tenant-console/src/lib/auth/demo-provider.ts`) hàm `signIn` chỉ kiểm tra `!email` thay vì gọi helper `isValidLoginEmail(email)`, cho phép chuỗi khoảng trắng hoặc email vượt quá 320 ký tự lọt vào gateway upstream. Đã chuyển sang sử dụng `isValidLoginEmail(email)`, bổ sung unit test cho auth provider. *(Đã xong)*

### Giai đoạn 11: Worker Care/Sales Skill Input Boundary, BFF Idempotency Forwarding, UI Status Normalization & Turn Classifier Vietnamese Currency (B-69 đến B-75) (Đã hoàn thành trên nhánh `tai`)

1. **Sửa Bug B-69:** Worker Care Skill (`faq-handler.ts` & `faq-parser.ts`) khi `top_k: NaN` khiến `Math.max(1, NaN) === NaN`, làm `matching.slice(0, NaN)` trả về `[]`, gây ra `TypeError: Cannot read properties of undefined (reading 'score')` trên `topMatches[0]!.score`. Đồng thời `scoreFaqMatch` so sánh `qLower.includes(tokenLower)`, khi token rỗng hoặc toàn khoảng trắng trả về true 100% cho mọi câu hỏi. Đã kiểm tra `Number.isInteger(rawTopK) && rawTopK > 0 ? rawTopK : 5` và lọc token rỗng trong parser, bổ sung unit test. *(Đã xong)*
2. **Sửa Bug B-70:** Tenant Console BFF Proxy (`apps/tenant-console/src/app/api/v1/[...path]/route.ts`) danh sách `FORWARDED_REQUEST_HEADERS` thiếu header chuẩn HTTP `'idempotency-key'` (chỉ có `'x-idempotency-key'`), khiến các mutation idempotency của client bị drop khi đi qua BFF proxy. Đã bổ sung `'idempotency-key'`, bổ sung unit test proxy. *(Đã xong)*
3. **Sửa Bug B-71:** Worker Sales Skill (`apps/worker/src/runtime/sales/skills/read-handlers.ts`) trong `handleSearchProduct` và `handleCheckStock` thực thi `.trim()` trực tiếp trên `input.query` và `input.sku_id` trước khi kiểm tra `typeof === 'string'`. Khi input thiếu hoặc không phải chuỗi, ném uncaught `TypeError` thay vì ném `SalesSkillToolError` có cấu trúc (`MALFORMED_QUERY` / `AUTHORITATIVE_SOURCE_UNAVAILABLE`). Đã thêm type check an toàn, bổ sung unit test. *(Đã xong)*
4. **Sửa Bug B-72:** UI Foundation Status View (`packages/ui-foundation/src/status-view.ts`) thiếu các trạng thái cốt lõi `HUMAN_TAKEOVER`, `OPEN`, `CLOSED` trong `STATUS_DEFINITIONS` (bị rơi vào fallback `status.unknown`), đồng thời `statusView` không chuẩn hóa chữ hoa/chữ thường khiến các trạng thái chữ thường như `'active'`, `'closed'` không tra cứu được. Đã bổ sung định nghĩa và chuẩn hóa `.trim().toUpperCase()`, bổ sung unit test. *(Đã xong)*
5. **Sửa Bug B-73:** Modal phê duyệt (`apps/tenant-console/src/components/approvals/ApprovalPayloadDiffModal.tsx`) truy cập trực tiếp `item.payload.customer_id` mà không dùng optional chaining, gây crash React khi item không có payload hoặc payload là null/undefined. Đã chuyển sang optional chaining `item.payload?.customer_id`. *(Đã xong)*
6. **Sửa Bug B-74:** API Gateway Turn Classifier (`apps/api/src/routes/v1/turn-classifier.ts`) hàm `salesRequirementsFor` chuẩn hóa thông điệp bằng `.replace(/[đĐ]/g, 'd')`, nhưng regex `SYMBOL_CURRENCY_PATTERNS` và `currencyHint` chỉ so sánh `đ`/`₫`, khiến các cú pháp phổ biến tiếng Việt như `"15.000.000đ"`, `"dưới 20 triệu đ"`, `"dưới 20 triệu đồng"` bị rớt nhận diện tiền tệ VND và làm mất yêu cầu ngân sách khách hàng. Đã bổ sung nhận diện hậu tố `d\b`, `dong`, `đ` chuẩn xác, bổ sung unit test. *(Đã xong)*
7. **Sửa Bug B-75:** Worker Sales Skill (`apps/worker/src/runtime/sales/skills/mutation-handlers.ts`) trong `handleSendMessage` thiếu validation chuỗi không rỗng cho `recipient_id`, `channel`, và `content`, có thể dẫn đến gửi tin nhắn trống hoặc sai kênh. Đã bổ sung validation chặt chẽ với mã lỗi `INVALID_INPUT`, bổ sung unit test. *(Đã xong)*

### Giai đoạn 12: Payload Bound, Stream Receipt Guard, Platform Admin BFF Proxy & Worker Skill Object Guard (B-76 đến B-79) (Đã hoàn thành trên nhánh `tai`)

1. **Sửa Bug B-76:** API Gateway (`operations.ts` & `approvals.ts`) không giới hạn độ dài payload trường `reason` trên các endpoint vận hành và phê duyệt:
   - `POST /api/v1/operations/runs/:run_id/retry`: cho phép gửi `reason` không phải string hoặc chuỗi dài tùy ý.
   - `POST /api/v1/operations/runs/:run_id/reconciliation`: không kiểm tra giới hạn độ dài của `reason`.
   - `POST /api/v1/approvals/:approval_id/decision`: không kiểm tra giới hạn độ dài của `candidate.reason`.
   Thiếu giới hạn độ dài tiềm ẩn nguy cơ cạn kiệt bộ nhớ và phình to bản ghi audit trail/database. Đã áp đặt `MAX_REASON_LENGTH = 1000` trên cả 3 endpoint, trả về `400 VALIDATION_FAILED` khi vượt quá giới hạn và bổ sung đầy đủ unit tests. *(Đã xong)*

2. **Sửa Bug B-77:** Storefront Widget Stream Parser (`packages/storefront-widget/src/stream.ts`) hàm `parseStreamChunk`:
   Hàm `parseReceipt(payload)` và `parseReceipt(trimmed)` được gọi vô điều kiện trên mọi chunk SSE và chunk plain text stream. Khi assistant phản hồi tin nhắn có chứa JSON đề cập tới thông tin phiên/hội thoại (ví dụ: `{"conversation_id": "...", "task_id": "..."}`), hàm `parseReceipt` nhận diện nhầm khối JSON này là `StreamReceipt`, ghi đè lên receipt ban đầu của luồng và thực hiện lệnh `continue;`, dẫn đến việc nuốt chửng và làm mất hoàn toàn nội dung phản hồi của trợ lý ảo. Đã bổ sung điều kiện bảo vệ `if (receipt === null)` trước khi parse receipt, bổ sung unit tests kiểm tra cả SSE và plain text stream. *(Đã xong)*

3. **Sửa Bug B-78:** Platform Admin BFF Proxy (`apps/platform-admin/src/lib/auth/demo-provider.ts`) hàm `forwardedHeaders` và `proxyResponse`:
   Danh sách header chuyển tiếp bị thiếu `'x-idempotency-key'`, `'x-request-id'`, `'if-match'`, `'if-none-match'`, và response header thiếu `'x-request-id'`, `'etag'`. Điều này làm mất tính bất biến của các request mang header `x-idempotency-key` từ platform admin console khi gửi tới API Gateway. Đã đồng bộ đầy đủ các header chuyển tiếp tương thích với tenant console proxy. *(Đã xong)*

4. **Sửa Bug B-79:** Worker Care Skills Handlers (`case-handler.ts`, `handoff-handler.ts`, `order-handler.ts`):
   Cả 3 handler đều ép kiểu trực tiếp `invocation.input as ...` và truy cập thuộc tính hoặc destructuring ngay lập tức:
   - `case-handler.ts`: `const { effect_key: callerEffectKey, ...businessInput } = input;` văng uncaught `TypeError: Cannot destructure property 'effect_key' of 'input' as it is null/undefined`.
   - `handoff-handler.ts`: `input.tenant_id !== trustedTenantId` văng uncaught `TypeError: Cannot read properties of null/undefined`.
   - `order-handler.ts`: `input.tenant_id !== contextTenantId` văng uncaught `TypeError: Cannot read properties of null/undefined`.
   Khi LLM invocation tool phát sinh payload null hoặc không phải object, runtime crash với lỗi không được kiểm soát. Đã bổ sung validation an toàn `typeof invocation.input !== 'object' || invocation.input === null` và ném `CareSkillToolError('VALIDATION_FAILED', 'tool invocation input must be an object')`, bổ sung unit test. *(Đã xong)*

---
*Báo cáo được lưu trữ và cập nhật trực tiếp tại: `docs/demo/BUG_AUDIT_REPORT.md`.*








