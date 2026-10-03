'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DemoBadge, EmptyState, PageHeader } from '@agentos/ui-foundation/react';
import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { SalesTryChat } from '../../../../../components/testing/SalesTryChat';
type CatalogItem = { readonly sku_id: string; readonly name: string; readonly description?: string; readonly list_price?: number; readonly currency?: string };
async function readJson(response: Response): Promise<Record<string, unknown>> {
  try { const value: unknown = await response.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}


function money(value: number | undefined, currency: string | undefined): string {
  if (value === undefined) return 'Chưa có dữ liệu';
  if (!currency) return `${value.toLocaleString()} (mã tiền tệ chưa có)`;
  try { return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(value); } catch { return `${value.toLocaleString()} ${currency}`; }
}

function SalesTryContent() {
  const [catalog, setCatalog] = useState<readonly CatalogItem[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const consumePromptSuggestion = useCallback(() => setPromptSuggestion(null), []);

  useEffect(() => {
    let active = true;
    void fetch('/api/v1/demo/catalog', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(async (response) => {
      const payload = await readJson(response);
      if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : 'Không thể tải danh mục.');
      const rows = Array.isArray(payload.items) ? payload.items : [];
      if (active) setCatalog(rows.filter((item): item is CatalogItem => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).sku_id === 'string' && typeof (item as Record<string, unknown>).name === 'string'));
    }).catch((reason: unknown) => { if (active) setCatalogError(reason instanceof Error ? reason.message : 'Không thể tải danh mục.'); });
    return () => { active = false; };
  }, []);

  return <div className="space-y-6">
    <PageHeader title="Thử trợ lý Sales" description="Hỏi về sản phẩm và đề xuất dựa trên dữ liệu có bằng chứng." actions={<><DemoBadge /><Link href="/" className="ui-button ui-button--secondary">Quay lại</Link></>} />
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-ink">Danh mục</h2>
        {catalogError ? <p role="alert" className="text-sm text-danger">{catalogError}</p> : catalog.length === 0 ? <EmptyState status="NO_DATA" title="Chưa có dữ liệu" /> : <div className="grid gap-3 sm:grid-cols-2">{catalog.map((item) => <article key={item.sku_id} className="rounded-xl border border-line bg-surface p-4"><h3 className="font-medium text-ink">{item.name}</h3><p className="mt-2 line-clamp-2 text-sm text-muted">{item.description ?? 'Chưa có dữ liệu'}</p><p className="mt-3 text-sm font-semibold text-ink">{money(item.list_price, item.currency)}</p><button type="button" className="ui-button ui-button--quiet mt-3" onClick={() => setPromptSuggestion(`Tư vấn cho tôi về ${item.name}.`)}>Hỏi trợ lý</button></article>)}</div>}
      </section>
      <SalesTryChat promptSuggestion={promptSuggestion} onPromptSuggestionConsumed={consumePromptSuggestion} />
    </div>
  </div>;
}

export default function SalesTryPage() { return <RequirePermission permission="conversation:takeover"><SalesTryContent /></RequirePermission>; }
