/**
 * Localized formatting vocabulary for the operations console (T8.3).
 *
 * Raw codes never reach the operator: failure classes, domains and reconciliation reasons each map
 * to a Vietnamese phrase. Unknown values fall back to a neutral, honest label instead of the code.
 */

import type {
  PlatformRunDetail,
  PlatformRunTrace,
  ReconciliationResolution,
} from './types';

const FAILURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  RETRYABLE: 'Lỗi tạm thời (an toàn để thử lại)',
  FATAL: 'Lỗi không thể khắc phục',
  UNKNOWN: 'Kết quả chưa xác định (cần đối soát)',
  SCHEMA_VALIDATION_FAILURE: 'Dữ liệu không hợp lệ',
  AUTHORITY_DENY: 'Không đủ quyền thực thi',
  FAIL_CLOSED: 'Từ chối an toàn',
  PRE_DISPATCH_PROVIDER_REJECTION: 'Nhà cung cấp từ chối trước khi thực thi',
});

const DOMAIN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  sales: 'Bán hàng',
  marketing: 'Marketing',
  support: 'CSKH',
  care: 'CSKH',
  unknown: 'Chưa xác định',
});

const RECONCILIATION_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  INDETERMINATE_OUTCOME: 'Kết quả không xác định',
  RECONCILIATION_REQUIRED: 'Quá hạn tự đối soát, cần xử lý thủ công',
});

export const RESOLUTION_LABELS: Readonly<Record<ReconciliationResolution, string>> = Object.freeze({
  PROVIDER_CONFIRMED_SUCCEEDED: 'Provider xác nhận thành công',
  PROVIDER_CONFIRMED_ABSENT: 'Provider xác nhận không có',
  ESCALATE_MANUALLY: 'Chuyển xử lý thủ công',
});

/** Visible, localized failure cause; no raw class code leaks when unknown. */
export function failureLabel(failureClass: string | null | undefined): string {
  if (failureClass === null || failureClass === undefined || failureClass.length === 0) {
    return 'Không ghi nhận';
  }
  return FAILURE_LABELS[failureClass] ?? 'Lỗi khác (xem chi tiết kỹ thuật)';
}

export function domainLabel(domain: string | null | undefined): string {
  if (domain === null || domain === undefined || domain.length === 0) return 'Chưa xác định';
  return DOMAIN_LABELS[domain] ?? domain;
}

export function reconciliationReasonLabel(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason.length === 0) return 'Không ghi nhận';
  return RECONCILIATION_REASON_LABELS[reason] ?? 'Cần người xử lý';
}

/** `vi-VN` timestamp; invalid input degrades to an explicit marker rather than `Invalid Date`. */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('vi-VN');
}

export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} giây`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} phút ${Math.round(seconds % 60)} giây`;
}

const SENSITIVE_EXPORT_KEY = /email|phone|mobile|telephone/i;

function omitSensitiveExportKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitSensitiveExportKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_EXPORT_KEY.test(key))
      .map(([key, entry]) => [key, omitSensitiveExportKeys(entry)]),
  );
}

/** The platform trace is already allowlisted; this preserves that contract in downloaded JSON. */
export function buildRunDetailExportJson(detail: PlatformRunDetail, trace: PlatformRunTrace): string {
  return JSON.stringify(omitSensitiveExportKeys({ detail, trace }), null, 2);
}
