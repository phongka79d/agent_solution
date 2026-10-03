import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../auth/SessionProvider';
import KnowledgePage from '../../app/(app)/knowledge/page';
import { KnowledgeEditor } from './KnowledgeEditor';
import { KnowledgeList } from './KnowledgeList';
import { KnowledgeReviewDrawer } from './KnowledgeReviewDrawer';
import {
  diffLines,
  slugify,
  statusLabel,
  type KnowledgeDocument,
  type KnowledgeVersion,
} from './types';

const DOCUMENT: KnowledgeDocument = {
  document_id: 'doc-1',
  namespace: 'policy',
  type: 'RETURNS',
  slug: 'returns',
  version: 2,
  title: 'Chính sách đổi trả',
  body: '# Đổi trả\n- 7 ngày',
  content_sha256: 'a'.repeat(64),
  data_class: 'PRODUCTION',
  status: 'REVIEW',
  created_by: 'author',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const VERSIONS: readonly KnowledgeVersion[] = [
  {
    document_id: 'doc-1', version: 1, title: 'Chính sách đổi trả', body: '# Đổi trả\n- 5 ngày',
    content_sha256: 'b'.repeat(64), created_by: 'author', created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    document_id: 'doc-1', version: 2, title: 'Chính sách đổi trả', body: '# Đổi trả\n- 7 ngày',
    content_sha256: 'a'.repeat(64), created_by: 'author', created_at: '2026-01-02T00:00:00.000Z',
  },
];

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('knowledge helpers', () => {
  it('maps lifecycle statuses to Vietnamese labels', () => {
    expect(statusLabel('DRAFT')).toBe('Nháp');
    expect(statusLabel('REVIEW')).toBe('Chờ duyệt');
    expect(statusLabel('APPROVED')).toBe('Đã duyệt');
    expect(statusLabel('AVAILABLE')).toBe('Đang được AI dùng');
    expect(statusLabel('ARCHIVED')).toBe('Lưu trữ');
  });

  it('derives a slug and a line diff against the previous version', () => {
    expect(slugify('Chinh sach doi tra')).toBe('chinh-sach-doi-tra');
    const rows = diffLines('- 5 ngày', '- 7 ngày');
    expect(rows.some((row) => row.kind === 'remove' && row.value === '- 5 ngày')).toBe(true);
    expect(rows.some((row) => row.kind === 'add' && row.value === '- 7 ngày')).toBe(true);
  });
});

describe('KnowledgeList', () => {
  const base = {
    items: [{ ...DOCUMENT, status: 'AVAILABLE', agents: ['Care Agent'] }] as readonly KnowledgeDocument[],
    selectedId: null,
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onReview: vi.fn(),
    onArchive: vi.fn(),
    isLoading: false,
    error: null,
  };

  afterEach(cleanup);

  it('renders Vietnamese status and used-by agents without approve for managers', () => {
    render(<KnowledgeList {...base} canApprove={false} />);
    expect(screen.getAllByText('Đang được AI dùng').length).toBeGreaterThan(0);
    expect(screen.getByText('Care Agent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Duyệt' })).toBeNull();
  });

  it('shows the approve action only for reviewers', () => {
    render(<KnowledgeList {...base} items={[{ ...DOCUMENT, status: 'REVIEW' }]} canApprove />);
    expect(screen.getByRole('button', { name: 'Duyệt' })).toBeTruthy();
  });
});

describe('KnowledgeEditor', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('creates a draft then submits it for review, each mutation carrying the CSRF token', async () => {
    document.cookie = 'agentos_tenant_csrf=csrf-token-1; path=/';
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/v1/knowledge/documents' && init?.method === 'POST') {
        return response({ ...DOCUMENT, status: 'DRAFT', version: 1 });
      }
      if (url === '/api/v1/knowledge/documents/doc-1/submit') {
        return response({ ...DOCUMENT, status: 'REVIEW' });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    render(<KnowledgeEditor open document={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Tiêu đề'), { target: { value: 'Chính sách đổi trả' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi duyệt' }));

    await waitFor(() => {
      const created = fetchMock.mock.calls.find(([input]) => String(input) === '/api/v1/knowledge/documents');
      expect(created).toBeDefined();
      const body = JSON.parse(String(created?.[1]?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ title: 'Chính sách đổi trả', type: 'FAQ', namespace: 'company' });
      expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/v1/knowledge/documents/doc-1/submit')).toBe(true);
      // The BFF refuses a mutation without the session's CSRF token (403 CSRF_INVALID).
      for (const [, init] of fetchMock.mock.calls) {
        expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-token-1');
      }
    });
  });

  it('blocks saving without a title', async () => {
    render(<KnowledgeEditor open document={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

describe('KnowledgePage', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows the empty state with document templates for a company admin', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response({ items: [], next_cursor: null }));
    const session: AuthSession = {
      identity: { user_id: 'op-1', email: 'admin@example.test', display_name: 'Quản trị' },
      membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'admin', scope: 'company' },
      permissions: ['knowledge:manage', 'knowledge:approve'],
      expires_at: '2099-01-01T00:00:00.000Z',
    };

    render(<SessionProvider session={session}><KnowledgePage /></SessionProvider>);

    expect(await screen.findByText('Chưa có tài liệu')).toBeTruthy();
    expect(screen.getByText(/Chưa có tài liệu\. Thêm câu hỏi thường gặp/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chính sách đổi trả' })).toBeTruthy();
  });
});

describe('KnowledgeReviewDrawer', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('requires a reason before returning a document and posts approve otherwise', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/versions')) return response(VERSIONS);
      if (url.endsWith('/reject')) return response({ ...DOCUMENT, status: 'DRAFT' });
      throw new Error(`Unexpected request ${url}`);
    });
    const onDecided = vi.fn();

    render(
      <KnowledgeReviewDrawer open document={DOCUMENT} canApprove canManage onClose={vi.fn()} onDecided={onDecided} />,
    );
    await screen.findByText('So sánh với bản trước');
    fireEvent.click(screen.getByRole('button', { name: 'Trả lại' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/reject'))).toBe(false);

    fireEvent.change(screen.getByLabelText('Lý do trả lại'), { target: { value: 'Cần bổ sung điều kiện' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trả lại' }));
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ status: 'DRAFT' }), 'reject'));
  });
});
