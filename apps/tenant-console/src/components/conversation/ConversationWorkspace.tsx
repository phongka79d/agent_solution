'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@agentos/ui-foundation';
import { AdvancedDetails, Drawer, EmptyState, LoadingState, StatusBadge } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from '../auth/SessionProvider';

type JsonRecord = Record<string, unknown>;

type Conversation = {
  readonly id: string;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly channel: string | null;
  readonly owner: 'AI' | 'HUMAN';
  readonly state: string;
  readonly lastMessageAt: string | null;
};

type Message = {
  readonly id: string;
  readonly sender: 'customer' | 'ai' | 'operator' | 'other';
  readonly content: string;
  readonly createdAt: string | null;
};

type Lease = { readonly operatorId: string; readonly expiresAt: string };

type Summary = JsonRecord;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeConversation(value: unknown): Conversation | null {
  const item = record(value);
  const id = text(item.conversation_id) ?? text(item.id);
  if (!id) return null;
  const ownerValue = String(item.owner ?? item.active_agent ?? item.control_mode ?? item.state ?? '').toUpperCase();
  const owner: Conversation['owner'] = ownerValue.includes('HUMAN') || ownerValue.includes('TAKEOVER') || Boolean(item.takeover_operator_id)
    ? 'HUMAN'
    : 'AI';
  const customer = record(item.customer);
  return {
    id,
    customerId: text(item.customer_id) ?? text(customer.customer_id) ?? text(customer.id),
    customerName: text(item.customer_name) ?? text(customer.name) ?? text(item.name),
    channel: text(item.channel),
    owner,
    state: text(item.state) ?? (owner === 'HUMAN' ? 'HUMAN_TAKEOVER' : 'ACTIVE'),
    lastMessageAt: text(item.last_message_at) ?? text(item.updated_at) ?? text(item.created_at),
  };
}

function normalizeMessage(value: unknown, index: number): Message {
  const item = record(value);
  const senderValue = String(item.sender_type ?? item.sender ?? item.role ?? '').toLowerCase();
  const sender: Message['sender'] = senderValue.includes('operator') || senderValue.includes('human')
    ? 'operator'
    : senderValue.includes('customer') || senderValue.includes('user')
      ? 'customer'
      : senderValue.includes('ai') || senderValue.includes('agent') || senderValue.includes('assistant')
        ? 'ai'
        : 'other';
  return {
    id: text(item.message_id) ?? text(item.id) ?? `message-${index}`,
    sender,
    content: text(item.content) ?? text(item.message) ?? '',
    createdAt: text(item.created_at) ?? text(item.occurred_at) ?? text(item.timestamp),
  };
}

function responseItems(payload: unknown): unknown[] {
  const item = record(payload).items;
  if (Array.isArray(item)) return item;
  const events = record(payload).messages;
  return Array.isArray(events) ? events : [];
}

function cursor(payload: unknown): string | null {
  const value = record(payload).next_cursor ?? record(payload).nextCursor;
  return typeof value === 'string' && value ? value : null;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function apiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

export interface ConversationWorkspaceProps {
  readonly initialConversationId?: string | undefined;
}

export function ConversationWorkspace({ initialConversationId = '' }: ConversationWorkspaceProps) {
  const router = useRouter();
  const session = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialConversationId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [leases, setLeases] = useState<Record<string, Lease>>({});
  const [reason, setReason] = useState('Khách hàng cần nhân viên hỗ trợ');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const selected = useMemo(() => conversations.find((item) => item.id === selectedId) ?? (selectedId ? {
    id: selectedId,
    customerId: null,
    customerName: null,
    channel: null,
    owner: 'AI' as const,
    state: 'ACTIVE',
    lastMessageAt: null,
  } : null), [conversations, selectedId]);
  const currentLease = selectedId ? leases[selectedId] ?? null : null;
  const holdsLease = Boolean(currentLease && currentLease.operatorId === session?.identity.user_id && Date.parse(currentLease.expiresAt) > Date.now());

  const loadConversations = useCallback(async (append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const payload = await tenantConsoleClient.getConversations({ limit: 50, ...(append && nextCursor ? { cursor: nextCursor } : {}) });
      const items = responseItems(payload).map(normalizeConversation).filter((item): item is Conversation => item !== null);
      setConversations((previous) => append ? [...previous, ...items.filter((item) => !previous.some((old) => old.id === item.id))] : items);
      setNextCursor(cursor(payload));
      if (!selectedId && items[0]) setSelectedId(items[0].id);
    } catch (reasonValue: unknown) {
      setError(apiError(reasonValue, 'Không thể tải danh sách hội thoại.'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [nextCursor, selectedId]);

  const loadConversation = useCallback(async (id: string) => {
    if (!id) {
      setMessages([]);
      setSummary(null);
      return;
    }
    setLoadingMessages(true);
    setError(null);
    try {
      const [messagePayload, summaryPayload] = await Promise.all([
        tenantConsoleClient.getConversationMessages(id, { limit: 100 }),
        tenantConsoleClient.getConversationSummary(id),
      ]);
      setMessages(responseItems(messagePayload).map(normalizeMessage));
      setSummary(record(summaryPayload));
      const leaseRecord = record(record(summaryPayload).lease);
      const leaseSource: JsonRecord = Object.keys(leaseRecord).length ? leaseRecord : record(summaryPayload);
      const operatorId = text(leaseSource.operator_id);
      const expiresAt = text(leaseSource.lease_expires_at);
      if (operatorId && expiresAt && Date.parse(expiresAt) > Date.now()) {
        setLeases((prev) => ({ ...prev, [id]: { operatorId, expiresAt } }));
      } else {
        setLeases((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    } catch (reasonValue: unknown) {
      setMessages([]);
      setSummary(null);
      setError(apiError(reasonValue, 'Không thể tải nội dung hội thoại.'));
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (initialConversationId && initialConversationId !== selectedId) {
      setSelectedId(initialConversationId);
    }
  }, [initialConversationId, selectedId]);

  useEffect(() => { void loadConversations(); }, [loadConversations]);
  useEffect(() => {
    setNotice(null);
    void loadConversation(selectedId);
  }, [loadConversation, selectedId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const interval = window.setInterval(() => {
      void loadConversation(selectedId);
      void loadConversations();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [loadConversation, loadConversations, selectedId]);

  useEffect(() => {
    const currentUserId = session?.identity.user_id;
    if (!currentUserId) return undefined;
    const timer = window.setInterval(() => {
      const activeEntries = Object.entries(leases).filter(
        ([_, l]) => l.operatorId === currentUserId && Date.parse(l.expiresAt) > Date.now()
      );
      for (const [convId] of activeEntries) {
        void tenantConsoleClient.heartbeatTakeover(convId, { extend_seconds: 60 })
          .then((payload) => {
            setLeases((prev) => ({
              ...prev,
              [convId]: { operatorId: payload.operator_id, expiresAt: payload.lease_expires_at },
            }));
          })
          .catch((reasonValue: unknown) => {
            setLeases((prev) => {
              if (!prev[convId]) return prev;
              const next = { ...prev };
              delete next[convId];
              return next;
            });
            if (convId === selectedId) {
              setError(apiError(reasonValue, 'Phiên tiếp quản đã hết hạn.'));
            }
          });
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [leases, selectedId, session?.identity.user_id]);

  async function takeOver(): Promise<void> {
    if (!selectedId || !reason.trim()) return;
    setMutating(true); setError(null); setNotice(null);
    try {
      const payload = await tenantConsoleClient.takeoverConversation(selectedId, { reason: reason.trim(), takeover_mode: 'FULL_CONTROL' });
      setLeases((prev) => ({ ...prev, [selectedId]: { operatorId: payload.operator_id, expiresAt: payload.lease_expires_at } }));
      setNotice('Đã tiếp quản hội thoại.');
      await loadConversations();
    } catch (reasonValue: unknown) {
      setError(apiError(reasonValue, 'Không thể tiếp quản hội thoại.'));
    } finally { setMutating(false); }
  }

  async function resume(): Promise<void> {
    if (!selectedId || !holdsLease) return;
    setMutating(true); setError(null); setNotice(null);
    try {
      await tenantConsoleClient.resumeConversation(selectedId, { handoff_summary: 'Nhân viên đã trả lại hội thoại cho AI.' });
      setLeases((prev) => {
        if (!prev[selectedId]) return prev;
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
      setNotice('Đã trả lại hội thoại cho AI.');
      await loadConversations();
    } catch (reasonValue: unknown) {
      setError(apiError(reasonValue, 'Không thể trả lại hội thoại cho AI.'));
    } finally { setMutating(false); }
  }

  async function sendReply(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedId || !holdsLease || !reply.trim()) return;
    setMutating(true); setError(null); setNotice(null);
    try {
      await tenantConsoleClient.postConversationMessage(selectedId, { message: reply.trim(), sender: 'operator' });
      setReply('');
      setNotice('Đã gửi tin nhắn.');
      await loadConversation(selectedId);
    } catch (reasonValue: unknown) {
      setError(apiError(reasonValue, 'Không thể gửi tin nhắn.'));
    } finally { setMutating(false); }
  }

  const summaryCustomer = record(summary?.customer);
  const summaryCustomerId = selected?.customerId ?? text(summaryCustomer.customer_id) ?? text(summaryCustomer.id);
  const summaryContent = (
    <>
      <h2 className="font-semibold">Thông tin khách hàng</h2>
      {summaryCustomerId ? (
        <>
          <p className="mt-3 text-sm">{text(summaryCustomer.name) ?? selected?.customerName ?? 'Khách hàng'}</p>
          <a className="mt-3 inline-block text-sm text-primary underline" href={`/customers/${encodeURIComponent(summaryCustomerId)}`}>Xem hồ sơ khách hàng</a>
          <AdvancedDetails summary="Chi tiết kỹ thuật"><pre className="overflow-auto text-xs">{JSON.stringify(summary ?? {}, null, 2)}</pre></AdvancedDetails>
        </>
      ) : <EmptyState title="Chưa có dữ liệu" description="Hội thoại chưa liên kết khách hàng." />}
    </>
  );
  if (loading) return <LoadingState label="Đang tải hội thoại…" />;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-semibold text-ink">Hội thoại</h1><p className="mt-1 text-sm text-muted">Theo dõi hội thoại và hỗ trợ khách hàng.</p></div>
        <div className="flex gap-2"><button type="button" className="ui-button ui-button--secondary hidden md:inline-flex xl:hidden" onClick={() => setSummaryOpen(true)}>Thông tin khách hàng</button><button type="button" className="ui-button ui-button--secondary" onClick={() => void loadConversations()} disabled={loadingMore}>Làm mới</button></div>
      </header>
      {error ? <p role="alert" className="rounded-md border border-danger bg-surface p-3 text-sm text-danger">{error}</p> : null}
      {notice ? <p role="status" className="rounded-md border border-success bg-surface p-3 text-sm text-success">{notice}</p> : null}
      <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
        <aside className="ui-section-card overflow-hidden" aria-label="Danh sách hội thoại">
          <div className="flex items-center justify-between border-b border-line p-3"><h2 className="font-semibold">Danh sách</h2>{nextCursor ? <button type="button" className="text-xs text-primary" onClick={() => void loadConversations(true)} disabled={loadingMore}>{loadingMore ? 'Đang tải…' : 'Xem thêm'}</button> : null}</div>
          {conversations.length === 0 ? <EmptyState title="Chưa có dữ liệu" /> : <ul className="max-h-[36rem] divide-y divide-line overflow-auto">{conversations.map((item) => <li key={item.id}><button type="button" className={`w-full p-3 text-left hover:bg-canvas ${selectedId === item.id ? 'bg-canvas' : ''}`} onClick={() => { setSelectedId(item.id); router.push(`/conversations/${encodeURIComponent(item.id)}`); }}><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{item.customerName ?? 'Khách hàng'}</span><span className="shrink-0 text-xs text-muted">{item.owner === 'HUMAN' ? 'Nhân viên' : 'AI'}</span></div><p className="mt-1 truncate text-xs text-muted">{item.channel ?? 'Hội thoại'} · {formatTime(item.lastMessageAt)}</p></button></li>)}</ul>}
        </aside>

        <section className="ui-section-card flex min-h-[32rem] flex-col overflow-hidden" aria-label="Luồng hội thoại">
          {!selected ? <EmptyState title="Chọn một hội thoại" /> : <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4"><div><h2 className="font-semibold">{selected.customerName ?? 'Khách hàng'}</h2><div className="mt-1 flex flex-wrap items-center gap-2"><span className="rounded-full border border-line px-2 py-0.5 text-xs">{selected.owner === 'HUMAN' ? 'Nhân viên' : 'AI'}</span><StatusBadge code={selected.state} /></div></div><div className="flex gap-2">{holdsLease ? <button type="button" className="ui-button ui-button--secondary" onClick={() => void resume()} disabled={mutating}>Trả lại cho AI</button> : <button type="button" className="ui-button ui-button--primary" onClick={() => void takeOver()} disabled={mutating || selected.state === 'CLOSED'}>Tiếp quản</button>}</div></div>
            {!holdsLease ? <div className="border-b border-line p-3"><label className="text-xs text-muted" htmlFor="takeover-reason">Lý do tiếp quản</label><input id="takeover-reason" className="ui-input mt-1 w-full" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} /></div> : null}
            {loadingMessages ? <LoadingState label="Đang tải tin nhắn…" /> : <div className="flex-1 space-y-3 overflow-auto p-4" aria-live="polite">{messages.length === 0 ? <EmptyState title="Chưa có dữ liệu" /> : messages.map((message) => <article key={message.id} className={`rounded-md border border-line p-3 ${message.sender === 'operator' ? 'ml-6 bg-canvas' : 'mr-6 bg-surface'}`}><div className="flex justify-between gap-2 text-xs text-muted"><span>{message.sender === 'operator' ? 'Nhân viên' : message.sender === 'customer' ? 'Khách hàng' : message.sender === 'ai' ? 'AI' : 'Hệ thống'}</span><time>{formatTime(message.createdAt)}</time></div><p className="mt-2 whitespace-pre-wrap text-sm">{message.content || 'Tin nhắn không có nội dung hiển thị.'}</p></article>)}</div>}
            {holdsLease ? <form onSubmit={(event) => void sendReply(event)} className="border-t border-line p-4"><label htmlFor="operator-reply" className="text-sm font-medium">Tin nhắn của nhân viên</label><textarea id="operator-reply" className="ui-input mt-2 min-h-24 w-full" value={reply} onChange={(event) => setReply(event.target.value)} disabled={mutating} placeholder="Nhập phản hồi…" /><button type="submit" className="ui-button ui-button--primary mt-2" disabled={mutating || !reply.trim()}>Gửi</button></form> : null}
          </>}
        </section>

        <aside className="ui-section-card p-4 md:hidden xl:block" aria-label="Thông tin khách hàng">{summaryContent}</aside>
      </div>
      <Drawer open={summaryOpen} onClose={() => setSummaryOpen(false)} title="Thông tin khách hàng">{summaryContent}</Drawer>
    </div>
  );
}
