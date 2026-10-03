import { describe, expect, it } from 'vitest';

import { renderResponseTemplate, RESPONSE_KINDS, TEMPLATE_SOURCE } from './templates.js';

describe('response templates', () => {
  it('exposes the stable terminal response kinds', () => {
    expect(RESPONSE_KINDS).toEqual(['ANSWER', 'CLARIFICATION', 'REFUSAL', 'NO_ANSWER', 'HANDOFF_ACK']);
  });

  it('renders localized approved text with template provenance', () => {
    expect(renderResponseTemplate('care.identity_required')).toEqual({
      text: 'Để bảo vệ thông tin cá nhân, bạn vui lòng xác minh danh tính trước khi tôi tra cứu đơn hàng.',
      source: TEMPLATE_SOURCE,
      template_key: 'care.identity_required',
    });
    expect(renderResponseTemplate('care.need_more_detail')).toEqual({
      text: 'Xin chào! Tôi có thể hỗ trợ bạn điều gì hôm nay?',
      source: TEMPLATE_SOURCE,
      template_key: 'care.need_more_detail',
    });
    expect(renderResponseTemplate('core.run_failed_system')).toEqual({
      text: 'Trợ lý chưa trả lời được. Nhân viên sẽ hỗ trợ bạn.',
      source: TEMPLATE_SOURCE,
      template_key: 'core.run_failed_system',
    });
    expect(renderResponseTemplate('sales.identity_required')).toEqual({
      text: 'Để tiếp tục đặt hàng, bạn vui lòng xác minh danh tính trước nhé.',
      source: TEMPLATE_SOURCE,
      template_key: 'sales.identity_required',
    });
    expect(renderResponseTemplate('sales.need_shipping_or_payment', {}, 'en')).toEqual({
      text: 'To continue with this order, update your default shipping address in your profile and tell me which supported payment method you prefer.',
      source: TEMPLATE_SOURCE,
      template_key: 'sales.need_shipping_or_payment',
    });
    expect(renderResponseTemplate('sales.need_sku', {}, 'en')).toEqual({
      text: 'Please share the product SKU or name you would like me to check.',
      source: TEMPLATE_SOURCE,
      template_key: 'sales.need_sku',
    });
    expect(renderResponseTemplate('sales.price_unavailable')).toEqual({
      text: 'Tôi chưa lấy được giá chính thức lúc này. Bạn vui lòng thử lại sau.',
      source: TEMPLATE_SOURCE,
      template_key: 'sales.price_unavailable',
    });
    expect(renderResponseTemplate('care.order_status', {
      order_id: 'ORD-1',
      status: 'Đang xử lý',
    })).toEqual({
      text: 'Tình trạng đơn hàng ORD-1: Đang xử lý.',
      source: TEMPLATE_SOURCE,
      template_key: 'care.order_status',
    });
    expect(renderResponseTemplate('care.order_not_found')).toEqual({
      text: 'Tôi chưa tìm thấy đơn hàng phù hợp với tài khoản của bạn.',
      source: TEMPLATE_SOURCE,
      template_key: 'care.order_not_found',
    });
  });
});
