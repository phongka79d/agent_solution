export const RESPONSE_KINDS = ['ANSWER', 'CLARIFICATION', 'REFUSAL', 'NO_ANSWER', 'HANDOFF_ACK'] as const;
export type ResponseKind = typeof RESPONSE_KINDS[number];

export const TEMPLATE_SOURCE = 'Core.Template@1' as const;

export const TEMPLATE_KEYS = [
  'sales.need_budget',
  'sales.need_sku',
  'sales.identity_required',
  'sales.need_shipping_or_payment',
  'sales.need_more_detail',
  'sales.price_unavailable',
  'care.need_order_reference',
  'care.need_more_detail',
  'care.identity_required',
  'care.order_status',
  'care.order_not_found',
  'care.faq_no_answer_offer_handoff',
  'core.cannot_help',
  'core.skill_unavailable',
  'core.handoff_ack',
  'core.run_failed_system',
] as const;
export type TemplateKey = typeof TEMPLATE_KEYS[number];
export type ResponseLocale = 'vi' | 'en';

const TEMPLATES: Readonly<Record<TemplateKey, Readonly<Record<ResponseLocale, string>>>> = {
  'sales.need_budget': {
    vi: 'Bạn dự định chi khoảng bao nhiêu cho sản phẩm này? Mức ngân sách sẽ giúp tôi tư vấn phù hợp hơn.',
    en: 'What is your approximate budget for this product? That will help me tailor my recommendation.',
  },
  'sales.need_sku': {
    vi: 'Bạn cho tôi xin mã sản phẩm (SKU) hoặc tên sản phẩm cần kiểm tra nhé.',
    en: 'Please share the product SKU or name you would like me to check.',
  },
  'sales.identity_required': {
    vi: 'Để tiếp tục đặt hàng, bạn vui lòng xác minh danh tính trước nhé.',
    en: 'Please verify your identity before I can continue with this order.',
  },
  'sales.need_shipping_or_payment': {
    vi: 'Để tiếp tục đặt hàng, vui lòng cập nhật địa chỉ giao hàng mặc định trong hồ sơ và cho biết phương thức thanh toán được hỗ trợ.',
    en: 'To continue with this order, update your default shipping address in your profile and tell me which supported payment method you prefer.',
  },
  'sales.price_unavailable': {
    vi: 'Tôi chưa lấy được giá chính thức lúc này. Bạn vui lòng thử lại sau.',
    en: 'I could not retrieve the official price right now. Please try again later.',
  },
  'sales.need_more_detail': {
    vi: 'Bạn có thể chia sẻ thêm nhu cầu hoặc thông tin sản phẩm bạn đang quan tâm không?',
    en: 'Could you share a little more about what you need or which product you are interested in?',
  },
  'care.need_order_reference': {
    vi: 'Bạn vui lòng cung cấp mã đơn hàng để tôi kiểm tra giúp nhé.',
    en: 'Please provide your order reference so I can check it for you.',
  },
  'care.need_more_detail': {
    vi: 'Xin chào! Tôi có thể hỗ trợ bạn điều gì hôm nay?',
    en: 'Hello! How can I help you today?',
  },
  'care.identity_required': {
    vi: 'Để bảo vệ thông tin cá nhân, bạn vui lòng xác minh danh tính trước khi tôi tra cứu đơn hàng.',
    en: 'To protect your personal information, please verify your identity before I look up an order.',
  },
  'care.order_status': {
    vi: 'Tình trạng đơn hàng {order_id}: {status}.',
    en: 'Order {order_id} status: {status}.',
  },
  'care.order_not_found': {
    vi: 'Tôi chưa tìm thấy đơn hàng phù hợp với tài khoản của bạn.',
    en: 'I could not find an order matching your account.',
  },
  'care.faq_no_answer_offer_handoff': {
    vi: 'Tôi chưa tìm thấy thông tin chính xác cho câu hỏi này. Bạn có muốn tôi chuyển yêu cầu đến nhân viên hỗ trợ không?',
    en: 'I could not find a reliable answer to that question. Would you like me to pass it to a support representative?',
  },
  'core.cannot_help': {
    vi: 'Tôi chưa thể hỗ trợ yêu cầu này. Bạn vui lòng cung cấp thêm thông tin hoặc liên hệ nhân viên để được hỗ trợ.',
    en: 'I cannot help with this request yet. Please provide more information or contact a support representative.',
  },
  'core.skill_unavailable': {
    vi: 'Tính năng cần thiết cho yêu cầu này hiện chưa sẵn sàng, nên tôi chưa thể trả lời chính xác. Bạn vui lòng liên hệ nhân viên để được hỗ trợ.',
    en: 'The capability required for this request is not available right now, so I cannot answer accurately. Please contact a support representative.',
  },
  'core.run_failed_system': {
    vi: 'Trợ lý chưa trả lời được. Nhân viên sẽ hỗ trợ bạn.',
    en: 'The assistant could not answer. A support representative will help you.',
  },
  'core.handoff_ack': {
    vi: 'Tôi đã ghi nhận yêu cầu chuyển đến nhân viên hỗ trợ. Nhân viên sẽ sớm liên hệ với bạn.',
    en: 'Your request has been passed to a support representative, who will follow up with you.',
  },
};

export function renderResponseTemplate(
  key: TemplateKey,
  params: Record<string, string> = {},
  locale: ResponseLocale = 'vi',
): { text: string; source: typeof TEMPLATE_SOURCE; template_key: TemplateKey } {
  let text = TEMPLATES[key][locale];
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, value);
  }
  return { text, source: TEMPLATE_SOURCE, template_key: key };
}

function terminalConversationId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  if ('context' in payload && typeof payload.context === 'object' && payload.context !== null
    && 'working_memory' in payload.context) {
    const memory = payload.context.working_memory;
    if (typeof memory === 'object' && memory !== null && 'conversation_id' in memory
      && typeof memory.conversation_id === 'string' && memory.conversation_id.length > 0) {
      return memory.conversation_id;
    }
  }
  if ('signal' in payload && typeof payload.signal === 'object' && payload.signal !== null
    && 'subject' in payload.signal) {
    const subject = payload.signal.subject;
    if (typeof subject === 'object' && subject !== null && 'conversation_id' in subject
      && typeof subject.conversation_id === 'string' && subject.conversation_id.length > 0) {
      return subject.conversation_id;
    }
  }
  return undefined;
}

/**
 * Failed/stopped conversation runs owe one support notice, including AUTH-4 checkpoints which
 * retain the verified binding in hydrated working memory rather than the original signal.
 * Both approval consumption and worker finalization use the same message request key so replay,
 * or the two paths observing the same stop, cannot append a second notice.
 */
export async function appendTerminalRunNotice(
  task: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly state: string;
    readonly state_payload: unknown;
  },
  conversations: {
    appendMessage(input: {
      readonly tenant_id: string;
      readonly conversation_id: string;
      readonly sender_type: 'system';
      readonly sender_id: 'system';
      readonly content: string;
      readonly request_id: string;
    }): Promise<string>;
  },
): Promise<void> {
  if (task.state !== 'failed' && task.state !== 'stopped') return;
  const conversation_id = terminalConversationId(task.state_payload);
  if (conversation_id === undefined) return;
  await conversations.appendMessage({
    tenant_id: task.tenant_id,
    conversation_id,
    sender_type: 'system',
    sender_id: 'system',
    content: renderResponseTemplate('core.run_failed_system').text,
    request_id: `run-failed:${task.run_id}`,
  });
}
