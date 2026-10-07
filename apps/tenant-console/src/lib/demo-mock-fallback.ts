import { jsonResponse } from './auth/session';

export function getDemoMockResponse(path: string, method: string): Response | null {
  const verb = method.toUpperCase();

  if (verb === 'GET') {
    if (path === 'company/overview') {
      return jsonResponse({
        attention: [
          {
            type: 'approval',
            severity: 'warning',
            domain: 'marketing',
            title_key: 'Đề xuất chiến dịch Flash Sale Cuối Tuần đang chờ phê duyệt ngân sách',
            params: {},
            source_ref: 'camp-101',
            href: '/approvals',
          },
          {
            type: 'handoff',
            severity: 'info',
            domain: 'care',
            title_key: 'Hội thoại #1082 đã được chuyển tiếp nhân viên chăm sóc do yêu cầu đổi trả',
            params: {},
            source_ref: 'case-88',
            href: '/conversations',
          },
        ],
        agents: [
          { domain: 'marketing', name: 'Growth Lead', status: 'ACTIVE', runs_today: 14 },
          { domain: 'sales', name: 'Sales Advisor', status: 'ACTIVE', runs_today: 52 },
          { domain: 'care', name: 'Customer Care Specialist', status: 'ACTIVE', runs_today: 31 },
        ],
        activity: [],
        metrics: { runs: 97, completed_runs: 95, revenue: 158000000 },
      });
    }

    if (path === 'company/ai-team') {
      return jsonResponse({
        agents: [
          { domain: 'marketing', name: 'Growth Marketing Lead', status: 'ACTIVE', runs_today: 14 },
          { domain: 'sales', name: 'Sales Advisor', status: 'ACTIVE', runs_today: 52 },
          { domain: 'care', name: 'Customer Care Specialist', status: 'ACTIVE', runs_today: 31 },
        ],
      });
    }

    if (path === 'company/attention') {
      return jsonResponse({
        items: [
          {
            type: 'approval',
            severity: 'warning',
            domain: 'marketing',
            title_key: 'Đề xuất chiến dịch Flash Sale Cuối Tuần đang chờ phê duyệt ngân sách',
            params: {},
            source_ref: 'camp-101',
            href: '/approvals',
          },
          {
            type: 'handoff',
            severity: 'info',
            domain: 'care',
            title_key: 'Hội thoại #1082 đã được chuyển tiếp nhân viên chăm sóc do yêu cầu đổi trả',
            params: {},
            source_ref: 'case-88',
            href: '/conversations',
          },
        ],
      });
    }

    if (path === 'company/activity') {
      return jsonResponse({
        items: [
          {
            kind: 'sales_quote',
            domain: 'sales',
            occurred_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
            sentence_key: 'aiTeam.runs.sales_success',
            params: { name: 'iPhone 15 Pro Max' },
            run_id: 'run-sales-101',
          },
          {
            kind: 'care_resolved',
            domain: 'care',
            occurred_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
            sentence_key: 'aiTeam.runs.care_resolved',
            params: { customer: 'Nguyễn Văn An' },
            run_id: 'run-care-204',
          },
        ],
        next_cursor: null,
      });
    }

    if (path === 'telemetry/kpi-snapshot') {
      return jsonResponse({
        window: '24h',
        timezone: 'Asia/Ho_Chi_Minh',
        observed_at: new Date().toISOString(),
        metrics: [
          { metric: 'revenue_twd', value: 158000000, source_status: 'FRESH' },
          { metric: 'leads', value: 412, source_status: 'FRESH' },
          { metric: 'conversion_rate', value: 5.2, source_status: 'FRESH' },
          { metric: 'active_campaigns', value: 6, source_status: 'FRESH' },
          { metric: 'ai_generated_revenue_twd', value: 74000000, source_status: 'FRESH' },
          { metric: 'cs_status', value: 'ONLINE', source_status: 'FRESH' },
          { metric: 'retention', value: 89.2, source_status: 'FRESH' },
          { metric: 'ai_actions', value: 1380, source_status: 'FRESH' },
          { metric: 'approval_pending', value: 1, source_status: 'FRESH' },
          { metric: 'abnormal_events', value: 0, source_status: 'FRESH' },
        ],
        cursor: null,
      });
    }

    if (path === 'demo/catalog') {
      return jsonResponse({
        items: [
          { sku_id: 'SKU-IP15-128', name: 'iPhone 15 Pro Max 256GB Natural Titanium', description: 'Chip A17 Pro, Camera 48MP, Khung Titan siêu nhẹ', list_price: 29990000, currency: 'VND' },
          { sku_id: 'SKU-MBP14-M3', name: 'MacBook Pro 14 M3 Pro 18GB/512GB', description: 'Màn hình Liquid Retina XDR 120Hz, Pin 18 tiếng', list_price: 49990000, currency: 'VND' },
          { sku_id: 'SKU-AP-PRO2', name: 'AirPods Pro 2 MagSafe (USB-C)', description: 'Chống ồn chủ động 2X, Âm thanh không gian cá nhân hóa', list_price: 5490000, currency: 'VND' },
        ],
      });
    }

    if (path === 'conversations') {
      return jsonResponse({
        items: [
          {
            id: 'conv-101',
            customer_id: 'cust-88',
            customer_name: 'Nguyễn Văn An',
            channel: 'WEB_CHAT',
            owner: 'AI',
            state: 'ACTIVE',
            last_message_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
          },
          {
            id: 'conv-102',
            customer_id: 'cust-92',
            customer_name: 'Trần Thị Mai',
            channel: 'MESSENGER',
            owner: 'HUMAN',
            state: 'HUMAN_TAKEOVER',
            last_message_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          },
        ],
        next_cursor: null,
      });
    }

    if (/^conversations\/[^/]+\/messages$/.test(path)) {
      return jsonResponse({
        items: [
          { id: 'm1', sender: 'customer', content: 'Em muốn hỏi tư vấn mua iPhone 15 Pro Max bản 256GB màu titan tự nhiên ạ?', occurred_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
          { id: 'm2', sender: 'ai', content: 'Chào anh An! Bản iPhone 15 Pro Max 256GB Natural Titanium bên em hiện đang có sẵn hàng với giá ưu đãi 29.990.000₫ tặng kèm củ sạc 20W và bảo hành 12 tháng chính hãng ạ.', occurred_at: new Date(Date.now() - 4 * 60 * 1000).toISOString() },
        ],
      });
    }

    if (/^conversations\/[^/]+\/summary$/.test(path)) {
      return jsonResponse({
        conversation_id: 'conv-101',
        customer: { customer_id: 'cust-88', name: 'Nguyễn Văn An' },
        state: 'ACTIVE',
        owner: 'AI',
      });
    }

    if (path === 'customers') {
      return jsonResponse({
        items: [
          { customer_id: 'cust-88', name: 'Nguyễn Văn An', email: 'an.nguyen@example.com', phone: '0987654321', segment: 'VIP', total_orders: 8, total_spend: 128500000 },
          { customer_id: 'cust-92', name: 'Trần Thị Mai', email: 'mai.tran@example.com', phone: '0912345678', segment: 'LOYAL', total_orders: 4, total_spend: 42000000 },
        ],
      });
    }

    if (/^customers\/[^/]+\/profile$/.test(path)) {
      return jsonResponse({
        customer_id: 'cust-88',
        name: 'Nguyễn Văn An',
        email: 'an.nguyen@example.com',
        phone: '0987654321',
        segment: 'VIP',
        created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        metrics: { total_spend: 128500000, total_orders: 8, avg_order_value: 16062500 },
      });
    }

    if (/^customers\/[^/]+\/timeline$/.test(path)) {
      return jsonResponse({
        items: [
          {
            event_id: 'tl-1',
            stage: 'PURCHASE',
            occurred_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
            classification: 'FACT',
            canonical_event: 'order.completed',
            source_record_id: 'ord-9921',
            evidence_reference: 'ev-ord-9921',
          },
          {
            event_id: 'tl-2',
            stage: 'SUPPORT',
            occurred_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
            classification: 'ACTION',
            canonical_event: 'care.ticket_resolved',
            source_record_id: 'case-88',
            evidence_reference: 'ev-case-88',
          },
        ],
        next_cursor: null,
      });
    }

    if (path === 'approvals') {
      return jsonResponse({
        items: [
          {
            id: 'appr-01',
            type: 'CAMPAIGN_BUDGET',
            domain: 'marketing',
            title: 'Phê duyệt ngân sách chiến dịch Flash Sale 50.000.000₫',
            status: 'PENDING',
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            deadline: new Date(Date.now() + 22 * 60 * 60 * 1000).toISOString(),
            requester: 'Growth Marketing Lead (AI)',
          },
        ],
        next_cursor: null,
      });
    }
  }

  if (verb === 'POST') {
    if (path === 'demo/widget-session') {
      return jsonResponse({
        session_id: 'demo-sess-001',
        access_token: 'demo-widget-token-abc',
      });
    }

    if (path === 'storefront/stream') {
      const sseContent = 'event: receipt\ndata: {"answer":"Chào bạn! Mình là AI Sales Advisor của NovaMart. Bạn đang cần tư vấn sản phẩm nào ạ?","status":"COMPLETED","evidence_ids":["ev-sku-ip15"]}\n\n';
      return new Response(sseContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
    }

    if (/^conversations\/[^/]+\/takeover$/.test(path)) {
      return jsonResponse({
        operator_id: 'demo-user-1',
        lease_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
    }

    if (/^conversations\/[^/]+\/resume$/.test(path)) {
      return jsonResponse({
        status: 'RESUMED',
      });
    }

    if (/^conversations\/[^/]+\/operator-messages$/.test(path)) {
      return jsonResponse({
        status: 'SENT',
      });
    }

    if (/^approvals\/[^/]+\/decision$/.test(path)) {
      return jsonResponse({
        status: 'ACCEPTED',
      });
    }
  }

  return null;
}
