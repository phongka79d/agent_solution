import { describe, expect, it } from 'vitest';

import { describeApiError } from './errors.js';
import { ApiError } from './http-client.js';

function envelope(error_code: string, overrides: Partial<{ retryable: boolean; correlation_id: string; message: string }> = {}) {
  return {
    error_code,
    message: overrides.message ?? 'upstream message',
    retryable: overrides.retryable ?? false,
    correlation_id: overrides.correlation_id ?? 'corr-123',
  };
}

describe('describeApiError', () => {
  it('localizes a retryable provider failure and offers a retry CTA', () => {
    const view = describeApiError(new ApiError(503, envelope('PROVIDER_UNAVAILABLE', { retryable: true })));
    expect(view.class).toBe('RETRYABLE');
    expect(view.retryable).toBe(true);
    expect(view.retry_label).toBe('Thử lại');
    expect(view.message).toBe('Dịch vụ liên quan tạm thời không khả dụng. Vui lòng thử lại.');
    expect(view.correlation_id).toBe('corr-123');
  });

  it('localizes provider rejection without offering an automatic retry', () => {
    const view = describeApiError('PROVIDER_REJECTED');
    expect(view.message).toBe('Nhà cung cấp từ chối yêu cầu.');
    expect(view.class).toBe('FATAL');
    expect(view.retryable).toBe(false);
    expect(view.technical).toBe('PROVIDER_REJECTED');
  });

  it('keeps session expiry fatal and carries the correlation id', () => {
    const view = describeApiError(new ApiError(401, envelope('SESSION_EXPIRED')));
    expect(view.retryable).toBe(false);
    expect(view.retry_label).toBeNull();
    expect(view.message).toBe('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    expect(view.correlation_id).toBe('corr-123');
  });

  it('never auto-retries an UNKNOWN effect and points at reconciliation', () => {
    const view = describeApiError(new ApiError(500, envelope('EFFECT_UNKNOWN', { retryable: true })));
    expect(view.class).toBe('UNKNOWN');
    expect(view.retryable).toBe(false);
    expect(view.admin_hint_key).toBe('errors.hint.reconcile');
  });

  it('falls back to the HTTP status when the code is uncatalogued', () => {
    const view = describeApiError(new ApiError(503, envelope('BRAND_NEW_CODE', { retryable: true })));
    expect(view.class).toBe('RETRYABLE');
    expect(view.retryable).toBe(true);
    expect(view.status).toBe(503);
  });

  it('accepts a plain Error, a string and a bare envelope without throwing', () => {
    const fromError = describeApiError(new Error('boom'));
    expect(fromError.code).toBe('UNKNOWN_ERROR');
    expect(fromError.retryable).toBe(false);
    expect(fromError.message).toBe('Không thể hoàn tất yêu cầu. Vui lòng thử lại.');

    const fromString = describeApiError('EFFECT_UNKNOWN');
    expect(fromString.code).toBe('EFFECT_UNKNOWN');
    expect(fromString.retryable).toBe(false);

    const fromEnvelope = describeApiError(envelope('LLM_NOT_CONFIGURED'));
    expect(fromEnvelope.message).toBe('Chưa cấu hình nhà cung cấp AI. Vui lòng liên hệ quản trị viên.');
  });

  it('keeps the raw code only in the technical detail', () => {
    const view = describeApiError(new ApiError(404, envelope('NOT_FOUND')));
    expect(view.technical).toBe('NOT_FOUND (HTTP 404)');
    expect(view.message).not.toContain('NOT_FOUND');
  });

  it('never renders the raw upstream message', () => {
    const view = describeApiError(new ApiError(502, envelope('PROVIDER_UNAVAILABLE', { message: 'ECONNREFUSED 10.0.0.5:7890' })));
    expect(view.message).not.toContain('ECONNREFUSED');
  });
});
