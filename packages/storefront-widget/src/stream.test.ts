import { describe, expect, it } from 'vitest';

import {
  buildStorefrontEventRequestBody,
  buildStorefrontStreamRequestBody,
  isOriginAllowed,
  parseReceipt,
  parseSseChunk,
  parseStreamChunk,
} from './stream.js';

describe('parseSseChunk', () => {
  it('extracts the payload of every data line and ignores other fields', () => {
    const chunk = 'event: delta\nid: 7\ndata: {"token":"hello"}\ndata: [DONE]\n\n';

    expect(parseSseChunk(chunk)).toEqual(['{"token":"hello"}', '[DONE]']);
  });

  it('returns nothing for a chunk without data lines', () => {
    expect(parseSseChunk(': keep-alive\n\n')).toEqual([]);
  });

  it('preserves spacing and handles multiple consecutive data lines', () => {
    const chunk = 'data: first line\ndata:  second line with leading space\n';
    expect(parseSseChunk(chunk)).toEqual(['first line', ' second line with leading space']);
  });
});

describe('parseReceipt', () => {
  it('extracts task_id, conversation_id, and status from valid JSON receipt', () => {
    const json = JSON.stringify({
      task_id: 'run-12345',
      conversation_id: 'conv-67890',
      status: 'accepted',
      correlation_id: 'corr-abcde',
      task_version: 1,
    });

    const receipt = parseReceipt(json);
    expect(receipt).toEqual({
      task_id: 'run-12345',
      conversation_id: 'conv-67890',
      status: 'accepted',
      correlation_id: 'corr-abcde',
      task_version: 1,
    });
  });

  it('returns null for non-JSON or ordinary message text', () => {
    expect(parseReceipt('Hello world, how are you?')).toBeNull();
    expect(parseReceipt('{"other_field": 123}')).toBeNull();
    expect(parseReceipt('')).toBeNull();
  });
});

describe('parseStreamChunk', () => {
  it('parses plain text chunk with receipt and message text', () => {
    const receiptLine = JSON.stringify({ task_id: 't-1', conversation_id: 'c-1', status: 'accepted' });
    const chunk = `${receiptLine}\nHello, I am your support agent.`;

    const result = parseStreamChunk(chunk);
    expect(result.receipt).toEqual({
      task_id: 't-1',
      conversation_id: 'c-1',
      status: 'accepted',
      correlation_id: undefined,
      task_version: undefined,
    });
    expect(result.text).toBe('Hello, I am your support agent.');
    expect(result.isDone).toBe(false);
  });

  it('extracts status markers from stream lines', () => {
    const chunk = '[pending: awaiting_human]\n';
    const result = parseStreamChunk(chunk);
    expect(result.statusMarker).toBe('awaiting_human');
  });

  it('parses SSE chunk with token deltas and [DONE] signal', () => {
    const chunk = 'data: {"token":"Help"}\ndata: {"token":" is on the way."}\ndata: [DONE]\n';
    const result = parseStreamChunk(chunk);
    expect(result.text).toBe('Help is on the way.');
    expect(result.isDone).toBe(true);
  });
});

describe('buildStorefrontStreamRequestBody (R11 contract)', () => {
  it('constructs request body with message, idempotency_key, and session_id', () => {
    const body = buildStorefrontStreamRequestBody('Need help with checkout', 'idemp-key-123', 'sess-456');
    expect(body).toEqual({
      message: 'Need help with checkout',
      idempotency_key: 'idemp-key-123',
      session_id: 'sess-456',
    });
  });

  it('omits session_id when null or undefined for anonymous binding', () => {
    const body = buildStorefrontStreamRequestBody('First turn message', 'idemp-key-first');
    expect(body).toEqual({
      message: 'First turn message',
      idempotency_key: 'idemp-key-first',
    });
    expect('session_id' in body).toBe(false);
  });
});

describe('buildStorefrontEventRequestBody (R12 platform event contract)', () => {
  it('constructs platform event envelope with required fields', () => {
    const body = buildStorefrontEventRequestBody('cart.add', { item_id: 'prod-999', quantity: 2 }, 'sess-456');
    expect(body.event_type).toBe('cart.add');
    expect(body.source).toBe('storefront_widget');
    expect(body.session_id).toBe('sess-456');
    expect(body.payload).toEqual({ item_id: 'prod-999', quantity: 2 });
    expect(typeof body.event_id).toBe('string');
    expect(body.event_id.length).toBeGreaterThan(0);
    expect(typeof body.occurred_at).toBe('string');
    expect(body.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('isOriginAllowed (UI-TEST-007 origin rejection contract)', () => {
  const HOST = 'https://store.merchant.com';

  it('accepts exact matching origin', () => {
    expect(isOriginAllowed('https://store.merchant.com', HOST)).toBe(true);
  });

  it('rejects completely different origin', () => {
    expect(isOriginAllowed('https://evil.attacker.com', HOST)).toBe(false);
  });

  it('rejects prefix or subdomain attacks', () => {
    expect(isOriginAllowed('https://store.merchant.com.evil.com', HOST)).toBe(false);
    expect(isOriginAllowed('https://sub.store.merchant.com', HOST)).toBe(false);
  });

  it('rejects port mismatches', () => {
    expect(isOriginAllowed('https://store.merchant.com:8443', HOST)).toBe(false);
  });

  it('rejects scheme mismatches', () => {
    expect(isOriginAllowed('http://store.merchant.com', HOST)).toBe(false);
  });

  it('rejects wildcard origin string', () => {
    expect(isOriginAllowed('*', HOST)).toBe(false);
    expect(isOriginAllowed('https://store.merchant.com', '*')).toBe(false);
  });

  it('rejects empty or missing origins', () => {
    expect(isOriginAllowed('', HOST)).toBe(false);
    expect(isOriginAllowed('https://store.merchant.com', '')).toBe(false);
  });
});
