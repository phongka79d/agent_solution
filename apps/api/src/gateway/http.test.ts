import { describe, expect, it } from 'vitest';

import { mapError } from './http.js';

describe('gateway approval refusal mapping', () => {
  it('preserves the core REQUIRE_HUMAN_APPROVAL decision code', () => {
    const response = mapError(
      { name: 'SkillError', code: 'REQUIRE_HUMAN_APPROVAL' },
      'correlation-approval',
    );

    expect(response.error_code).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(response.correlation_id).toBe('correlation-approval');
  });

  it('maps repository pagination and limit errors to VALIDATION_FAILED', () => {
    const errorCodes = [
      'CAMPAIGN_LIST_LIMIT_INVALID',
      'CAMPAIGN_LIST_CURSOR_INVALID',
      'CUSTOMER_LIST_LIMIT_INVALID',
      'CUSTOMER_LIST_CURSOR_INVALID',
      'CUSTOMER_EVENT_CURSOR_INVALID',
      'CUSTOMER_EVENT_LIMIT_INVALID',
      'CUSTOMER_EVENT_RANGE_INVALID',
      'CUSTOMER_EVENT_CUSTOMER_ID_REQUIRED',
      'CUSTOMER_EVENT_CUSTOMER_ID_INVALID',
      'PLATFORM_USAGE_WINDOW_INVALID',
      'CONVERSATION_LIMIT_INVALID',
      'CONVERSATION_MESSAGE_LIMIT_INVALID',
      'HANDOFF_LIMIT_INVALID',
      'APPROVAL_EXPIRY_LIMIT_INVALID',
    ];

    for (const code of errorCodes) {
      const response = mapError(new Error(`${code}: test detail message`), 'corr-123');
      expect(response.error_code).toBe('VALIDATION_FAILED');
      expect(response.message).toContain(code);
      expect(response.correlation_id).toBe('corr-123');
    }
  });
});

