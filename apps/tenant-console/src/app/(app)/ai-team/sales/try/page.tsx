'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { DemoBadge, Drawer, EmptyState, PageHeader } from '@agentos/ui-foundation/react';
import { RequirePermission } from '../../../../../components/auth/RequirePermission';
import { parseSseChunks, type Receipt } from '../../../../../lib/sse';

type CatalogItem = { readonly sku_id: string; readonly name: string; readonly description?: string; readonly list_price?: number; readonly currency?: string };
type ChatEntry = { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string; readonly evidence?: readonly unknown[]; readonly status?: string };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try { const value: unknown = await response.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

async function readReceipt(response: Response): Promise<Receipt> {
  if (!response.body) throw new Error('Luồng phản hồi không có receipt.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(decoder.decode(next.value, { stream: true }));
    const receipt = parseSseChunks(chunks);
    if (receipt) { await reader.cancel(); return receipt; }
  }
  chunks.push(decoder.decode());
  const receipt = parseSseChunks(chunks);
  if (!receipt) throw new Error('Không nhận được receipt hợp lệ.');
  return receipt;
}

function csrfToken(): string | undefined {
  const entry = typeof document === 'undefined' ? undefined : document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('agentos_tenant_csrf='));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.slice('agentos_tenant_csrf='.length)); } catch { return entry.slice('agentos_tenant_csrf='.length); }
}

function money(value: number | undefined, currency: string | undefined): string {
  if (value === undefined) return 'Chưa có dữ liệu';
  if (!currency) return `${value.toLocaleString()} (mã tiền tệ chưa có)`;
  try { return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(value); } catch { return `${value.toLocaleString()} ${currency}`; }
}

function SalesTryContent() {
  const [catalog, setCatalog] = useState<readonly CatalogItem[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [session, setSession] = useState<{ session_id: string; access_token: string } | null>(null);
  const [message, setMessage] = useState('');
  const [entries, setEntries] = useState<readonly ChatEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<readonly unknown[] | null>(null);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  const openSession = useCallback(async () => {
    setError(null);
    try {
      const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
      const csrf = csrfToken(); if (csrf) headers.set('x-csrf-token', csrf);
      const response = await fetch('/api/v1/demo/widget-session', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ persona: 'anonymous' }) });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : 'Không thể mở phiên trợ lý.');
      if (typeof payload.session_id !== 'string' || typeof payload.access_token !== 'string') throw new Error('Phiên trợ lý không hợp lệ.');
      setSession({ session_id: payload.session_id, access_token: payload.access_token });
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Không thể mở phiên trợ lý.'); }
  }, []);

  async function send(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (sendingRef.current || !session || !message.trim()) return;
    sendingRef.current = true; setSending(true); setError(null);
    const text = message.trim(); setMessage('');
    const userId = `user-${Date.now()}`; const assistantId = `assistant-${Date.now()}`;
    setEntries((current) => [...current, { id: userId, role: 'user', text }, { id: assistantId, role: 'assistant', text: 'Đang chờ receipt…', status: 'pending' }]);
    try {
      const headers = new Headers({ Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, Origin: window.location.origin });
      const csrf = csrfToken(); if (csrf) headers.set('x-csrf-token', csrf);
      const response = await fetch('/api/v1/storefront/stream', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ session_id: session.session_id, message: text, idempotency_key: `turn-${Date.now()}`, module: 'sales' }) });
      if (!response.ok) { const payload = await readJson(response); throw new Error(typeof payload.message === 'string' ? payload.message : `Yêu cầu không được chấp nhận (${response.status}).`); }
      const receipt = await readReceipt(response);
      const receiptEvidence = receipt.evidence_ids ?? (receipt.evidence_reference === undefined ? [] : [receipt.evidence_reference]);
      setEntries((current) => current.map((entry) => entry.id === assistantId ? { ...entry, text: receipt.answer ?? `Đã tiếp nhận (${receipt.status ?? 'đang xử lý'}).`, ...(receipt.status === undefined ? {} : { status: receipt.status }), evidence: receiptEvidence } : entry));
    } catch (reason: unknown) {
      const textError = reason instanceof Error ? reason.message : 'Không thể gửi yêu cầu.';
      setError(textError); setEntries((current) => current.map((entry) => entry.id === assistantId ? { ...entry, text: textError, status: 'failed' } : entry));
    } finally { sendingRef.current = false; setSending(false); }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault(); event.currentTarget.form?.requestSubmit();
  }

  return <div className="space-y-6"><PageHeader title="Thử trợ lý Sales" description="Hỏi về sản phẩm và đề xuất dựa trên dữ liệu có bằng chứng." actions={<><DemoBadge /><Link href="/" className="ui-button ui-button--secondary">Quay lại</Link></>} /><div className="grid gap-6 lg:grid-cols-[1fr_380px]"><section className="space-y-4"><h2 className="text-lg font-semibold text-ink">Danh mục</h2>{catalogError ? <p role="alert" className="text-sm text-danger">{catalogError}</p> : catalog.length === 0 ? <EmptyState status="NO_DATA" title="Chưa có dữ liệu" /> : <div className="grid gap-3 sm:grid-cols-2">{catalog.map((item) => <article key={item.sku_id} className="rounded-xl border border-line bg-surface p-4"><h3 className="font-medium text-ink">{item.name}</h3><p className="mt-2 line-clamp-2 text-sm text-muted">{item.description ?? 'Chưa có dữ liệu'}</p><p className="mt-3 text-sm font-semibold text-ink">{money(item.list_price, item.currency)}</p><button type="button" className="ui-button ui-button--quiet mt-3" onClick={() => { setMessage(`Tư vấn cho tôi về ${item.name}.`); inputRef.current?.focus(); }}>Hỏi trợ lý</button></article>)}</div>}</section><section className="flex min-h-[500px] flex-col rounded-xl border border-line bg-surface p-4"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-ink">Hội thoại</h2><p className="text-xs text-muted">Phiên riêng cho người dùng hiện tại.</p></div>{!session && <button type="button" className="ui-button ui-button--primary" onClick={() => void openSession()}>Mở phiên</button>}</div>{error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}<div className="mt-4 flex-1 space-y-3 overflow-auto" aria-live="polite">{entries.length === 0 ? <p className="py-10 text-center text-sm text-muted">Chưa có hội thoại.</p> : entries.map((entry) => <div key={entry.id} className={entry.role === 'user' ? 'ml-8 rounded-lg bg-primary/10 p-3 text-sm text-ink' : 'mr-4 rounded-lg border border-line p-3 text-sm text-ink'}><p>{entry.text}</p>{entry.role === 'assistant' && <button type="button" className="mt-2 text-xs text-primary underline" onClick={() => setEvidence(entry.evidence ?? [])}>Vì sao gợi ý này?</button>}</div>)}</div><form onSubmit={(event) => void send(event)} className="mt-4 border-t border-line pt-4"><textarea ref={inputRef} value={message} onChange={(event) => setMessage(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={onKeyDown} disabled={!session || sending} rows={2} className="ui-input w-full" placeholder={session ? 'Nhập câu hỏi…' : 'Mở phiên để bắt đầu'} /><button type="submit" disabled={!session || sending || !message.trim()} className="ui-button ui-button--primary mt-2 w-full">{sending ? 'Đang gửi…' : 'Gửi'}</button></form></section></div><Drawer open={evidence !== null} onClose={() => setEvidence(null)} title="Vì sao gợi ý này?"><div className="space-y-3">{evidence && evidence.length > 0 ? <ul className="space-y-2 text-sm text-ink">{evidence.map((item, index) => <li key={index}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>)}</ul> : <p className="text-sm text-muted">Chưa có dữ liệu doanh thu</p>}</div></Drawer></div>;
}

export default function SalesTryPage() { return <RequirePermission permission="conversation:takeover"><SalesTryContent /></RequirePermission>; }
