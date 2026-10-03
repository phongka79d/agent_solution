/**
 * Shared types, Vietnamese labels, document templates and a small line diff used by
 * the company knowledge-management screens (spec §7.9).
 */

import { t } from '@agentos/ui-foundation/i18n';

import { secureBrowserFetch } from '../../lib/tenant-console-client';

export type KnowledgeStatus = 'DRAFT' | 'REVIEW' | 'APPROVED' | 'AVAILABLE' | 'ARCHIVED';

export const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = [
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'AVAILABLE',
  'ARCHIVED',
];

export const KNOWLEDGE_NAMESPACES = [
  'company',
  'product',
  'brand',
  'marketing',
  'sales',
  'customer-care',
  'policy',
] as const;

export type KnowledgeNamespace = (typeof KNOWLEDGE_NAMESPACES)[number];

export const KNOWLEDGE_TYPES = [
  'FAQ',
  'SHIPPING',
  'RETURNS',
  'WARRANTY',
  'BRAND_VOICE',
  'SALES_GUIDELINE',
  'MARKETING_GUIDELINE',
  'AUTHORITY_POLICY',
] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export interface KnowledgeDocument {
  readonly document_id: string;
  readonly namespace: KnowledgeNamespace;
  readonly type: KnowledgeType;
  readonly slug: string;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly data_class: string;
  readonly status: KnowledgeStatus;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** Populated from the usage endpoint for AVAILABLE documents. */
  readonly agents?: readonly string[];
}

export interface KnowledgeVersion {
  readonly document_id: string;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface KnowledgeUsage {
  readonly document_id: string;
  readonly agents: readonly string[];
  readonly skills: null;
}

const STATUS_BADGES: Readonly<Record<KnowledgeStatus, string>> = {
  DRAFT: 'NO_DATA',
  REVIEW: 'APPROVAL_PENDING',
  APPROVED: 'ACTIVE',
  AVAILABLE: 'AI_ACTIVE',
  ARCHIVED: 'PAUSED',
};

export function statusLabel(status: string): string {
  return t(`knowledge.status.${status}`);
}

export function statusBadge(status: string): string {
  return STATUS_BADGES[status as KnowledgeStatus] ?? 'UNKNOWN';
}

export function namespaceLabel(namespace: string): string {
  return t(`knowledge.namespace.${namespace}`);
}

export function typeLabel(type: string): string {
  return t(`knowledge.type.${type}`);
}

export interface KnowledgeTemplate {
  readonly id: string;
  readonly label: string;
  readonly type: KnowledgeType;
  readonly namespace: KnowledgeNamespace;
  readonly title: string;
  readonly body: string;
}

export const KNOWLEDGE_TEMPLATES: readonly KnowledgeTemplate[] = [
  {
    id: 'faq',
    label: t('knowledge.template.faq'),
    type: 'FAQ',
    namespace: 'company',
    title: 'Câu hỏi thường gặp',
    body: [
      '# Câu hỏi thường gặp',
      '',
      '## Khách hàng có thể đổi trả trong bao lâu?',
      'Trả lời trong vòng 7 ngày kể từ khi nhận hàng.',
      '',
      '## Làm sao để liên hệ hỗ trợ?',
      'Gọi hotline hoặc trả lời trực tiếp trong hội thoại.',
      '',
    ].join('\n'),
  },
  {
    id: 'returns',
    label: t('knowledge.template.returns'),
    type: 'RETURNS',
    namespace: 'policy',
    title: 'Chính sách đổi trả',
    body: [
      '# Chính sách đổi trả',
      '',
      '- Thời hạn đổi trả: 7 ngày.',
      '- Điều kiện: sản phẩm còn nguyên tem, chưa qua sử dụng.',
      '- Phương thức hoàn tiền: chuyển khoản trong 3–5 ngày làm việc.',
      '',
    ].join('\n'),
  },
  {
    id: 'shipping',
    label: t('knowledge.template.shipping'),
    type: 'SHIPPING',
    namespace: 'policy',
    title: 'Chính sách vận chuyển',
    body: [
      '# Chính sách vận chuyển',
      '',
      '- Nội thành: 1–2 ngày làm việc.',
      '- Ngoại thành: 3–5 ngày làm việc.',
      '- Miễn phí vận chuyển cho đơn từ 500.000đ.',
      '',
    ].join('\n'),
  },
  {
    id: 'warranty',
    label: t('knowledge.template.warranty'),
    type: 'WARRANTY',
    namespace: 'policy',
    title: 'Chính sách bảo hành',
    body: [
      '# Chính sách bảo hành',
      '',
      '- Thời hạn bảo hành: 12 tháng.',
      '- Phạm vi: lỗi kỹ thuật từ nhà sản xuất.',
      '- Không áp dụng cho hư hỏng do người dùng.',
      '',
    ].join('\n'),
  },
  {
    id: 'brand-voice',
    label: t('knowledge.template.brand-voice'),
    type: 'BRAND_VOICE',
    namespace: 'brand',
    title: 'Giọng thương hiệu',
    body: [
      '# Giọng thương hiệu',
      '',
      '- Thân thiện, gần gũi, ngắn gọn.',
      '- Xưng "chúng tôi", gọi khách là "bạn".',
      '- Không dùng từ ngữ phóng đại, cam kết quá mức.',
      '',
    ].join('\n'),
  },
];

export function templateById(id: string): KnowledgeTemplate | undefined {
  return KNOWLEDGE_TEMPLATES.find((template) => template.id === id);
}

/** Slugifies a title the same way the API derives a slug from an uploaded filename. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

export type DiffLineKind = 'add' | 'remove' | 'same';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly value: string;
}

/** Line diff (LCS) between a previous and a current version of a document body. */
export function diffLines(previous: string, current: string): readonly DiffLine[] {
  const before = previous.length === 0 ? [] : previous.split('\n');
  const after = current.length === 0 ? [] : current.split('\n');
  const rows = before.length;
  const cols = after.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i]![j] = before[i]! === after[j]! ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i]! === after[j]!) {
      result.push({ kind: 'same', value: before[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      result.push({ kind: 'remove', value: before[i]! });
      i += 1;
    } else {
      result.push({ kind: 'add', value: after[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    result.push({ kind: 'remove', value: before[i]! });
    i += 1;
  }
  while (j < cols) {
    result.push({ kind: 'add', value: after[j]! });
    j += 1;
  }
  return result;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Thin fetch wrapper that surfaces the API error message for failed knowledge requests. */
export async function knowledgeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  // The BFF refuses mutations without the session's CSRF token; the shared fetch attaches it.
  const response = await secureBrowserFetch(fetch)(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? payload.message : t('knowledge.action_error');
    throw new Error(message);
  }
  return payload as T;
}
