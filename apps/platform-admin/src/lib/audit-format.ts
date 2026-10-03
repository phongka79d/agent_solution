import { API_ERROR_CATALOG } from '@agentos/ui-foundation';
import { t } from '@agentos/ui-foundation/i18n';

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  RESET_DRY_RUN: 'Xem trước đặt lại dữ liệu',
  RESET: 'Đặt lại dữ liệu',
  CREATE: 'Tạo mới',
  UPDATE: 'Cập nhật',
  RESOLVE: 'Xử lý thông tin còn thiếu',
  ACTIVATE: 'Kích hoạt',
  PAUSE: 'Tạm dừng',
  RESUME: 'Tiếp tục',
  SUBMIT: 'Gửi duyệt',
  APPROVE: 'Phê duyệt',
  REJECT: 'Từ chối',
  ARCHIVE: 'Lưu trữ',
  MAKE_AVAILABLE: 'Cho phép sử dụng',
  'secret.create': 'Tạo thông tin xác thực',
  'secret.revoke': 'Thu hồi thông tin xác thực',
  'connector.config.put': 'Cập nhật cấu hình kết nối',
  'connector.config.disconnect': 'Ngắt kết nối',
  'connector.probe.recorded': 'Kiểm tra kết nối',
  'llm.config.update': 'Cập nhật cấu hình AI',
  'llm.provider.upsert': 'Cập nhật nhà cung cấp AI',
  'provider.update': 'Cập nhật nhà cung cấp',
  'settings.update': 'Cập nhật cài đặt',
  'skill.agents.replace': 'Cập nhật nhân sự AI của kỹ năng',
  'skill.settings.update': 'Cập nhật cấu hình kỹ năng',
  'company.governance.update': 'Cập nhật chính sách quản trị',
});

const AUDIT_ACTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  OPERATOR: 'Nhân viên',
  SYSTEM: 'Hệ thống',
  USER: 'Người dùng',
  AGENT: 'Nhân sự AI',
});

/** Stable audit operations are human labels; uncatalogued operations stay neutral. */
export function auditActionLabel(action: string): string {
  return Object.hasOwn(AUDIT_ACTION_LABELS, action)
    ? AUDIT_ACTION_LABELS[action] ?? 'Thao tác hệ thống'
    : 'Thao tác hệ thống';
}

export function auditActorKindLabel(kind: string): string {
  return Object.hasOwn(AUDIT_ACTOR_LABELS, kind)
    ? AUDIT_ACTOR_LABELS[kind] ?? 'Người thực hiện'
    : 'Người thực hiện';
}

/** Audit reasons may be operator prose or machine codes; only prose belongs on the main surface. */
export function auditReasonLabel(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason.trim().length === 0) return t('common.empty');
  const code = reason.trim();
  const catalogEntry = Object.hasOwn(API_ERROR_CATALOG, code) ? API_ERROR_CATALOG[code] : undefined;
  if (catalogEntry) return t(catalogEntry.reason_key);
  return /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(reason) ? t('status.unknown') : reason;
}
