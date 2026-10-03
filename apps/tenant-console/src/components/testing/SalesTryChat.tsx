'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t } from '@agentos/ui-foundation/i18n';

type SalesTryChatProps = {
  readonly promptSuggestion?: string | null;
  readonly onPromptSuggestionConsumed?: () => void;
  readonly customerId?: string;
  readonly customerLabel?: string;
};
type Persona = 'anonymous' | 'C05' | 'C06';
type Entry = { readonly id: number; readonly role: 'customer' | 'assistant' | 'error'; readonly text: string; readonly sources?: readonly unknown[]; readonly completed?: boolean };
type ApiPayload = Record<string, unknown>;
type TaskResult = { readonly status: string; readonly answer?: string; readonly sources?: readonly unknown[]; readonly errorCode?: string };

class ChatApiError extends Error {
  constructor(readonly errorCode: string) { super(errorCode); }
}

async function readPayload(response: Response): Promise<ApiPayload> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ApiPayload : {};
  } catch {
    return {};
  }
}

function csrfHeaders(json = false): Headers {
  const headers = new Headers({ Accept: 'application/json' });
  if (json) headers.set('Content-Type', 'application/json');
  const csrfCookie = typeof document === 'undefined' ? undefined : document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('agentos_tenant_csrf='));
  if (csrfCookie) {
    const value = csrfCookie.slice('agentos_tenant_csrf='.length);
    try { headers.set('x-csrf-token', decodeURIComponent(value)); } catch { headers.set('x-csrf-token', value); }
  }
  return headers;
}

async function requestJson(path: string, init?: RequestInit): Promise<ApiPayload> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin', headers: init?.headers ?? csrfHeaders(init?.method === 'POST') });
  } catch {
    throw new ChatApiError(init?.signal?.aborted ? 'TASK_TIMEOUT' : 'NETWORK_ERROR');
  }
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new ChatApiError(typeof payload.error_code === 'string' ? payload.error_code : 'UNKNOWN_ERROR');
  }
  return payload;
}

function localizedError(code: string): string {
  const normalized = code.toUpperCase();
  const key = normalized === 'FORBIDDEN' || normalized === 'PERMISSION_DENIED' || normalized === 'AUTHORIZATION_FAILED'
    ? 'testing.chat.error.forbidden'
    : normalized === 'UNAUTHORIZED' || normalized === 'AUTHENTICATION_FAILED'
      ? 'testing.chat.error.authentication'
      : normalized === 'VALIDATION_FAILED'
        ? 'testing.chat.error.validation'
        : normalized === 'CAPABILITY_NOT_ENABLED' || normalized === 'PROVIDER_UNAVAILABLE'
          ? 'testing.chat.error.unavailable'
          : normalized === 'TASK_TIMEOUT'
            ? 'testing.chat.error.timeout'
            : 'testing.chat.error.generic';
  return t(key, undefined, 'vi');
}

function taskErrorCode(payload: ApiPayload): string | undefined {
  if (!payload.error || typeof payload.error !== 'object' || Array.isArray(payload.error)) return undefined;
  const error = payload.error as Record<string, unknown>;
  return typeof error.code === 'string' ? error.code : typeof error.error_code === 'string' ? error.error_code : undefined;
}


async function pollTask(chatSessionId: string, taskId: string): Promise<TaskResult> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const query = new URLSearchParams({ chat_session_id: chatSessionId, task_id: taskId });
    const payload = await requestJson(`/api/testing/chat/task?${query.toString()}`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    const status = typeof payload.status === 'string' ? payload.status : '';
    const answer = typeof payload.answer === 'string' ? payload.answer : undefined;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const errorCode = taskErrorCode(payload);
    if (status === 'completed' || status === 'failed' || status === 'stopped' || status === 'awaiting_human') {
      return { status, ...(answer === undefined ? {} : { answer }), sources, ...(errorCode === undefined ? {} : { errorCode }) };
    }
    const delay = Math.min(1_500, Math.max(0, deadline - Date.now()));
    await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
  }
  throw new ChatApiError('TASK_TIMEOUT');
}

export function SalesTryChat({ promptSuggestion = null, onPromptSuggestionConsumed, customerId, customerLabel }: SalesTryChatProps) {
  const [persona, setPersona] = useState<Persona>('anonymous');
  const [sessionReady, setSessionReady] = useState(false);
  const [message, setMessage] = useState('');
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [sending, setSending] = useState(false);
  const [sourcesFor, setSourcesFor] = useState<number | null>(null);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const entryIdRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (promptSuggestion === null) return;
    setMessage(promptSuggestion);
    inputRef.current?.focus();
    onPromptSuggestionConsumed?.();
  }, [promptSuggestion, onPromptSuggestionConsumed]);
  async function openSession(): Promise<string> {
    if (sessionIdRef.current) return sessionIdRef.current;
    const payload = await requestJson('/api/testing/chat/session', {
      method: 'POST',
      headers: csrfHeaders(true),
      body: JSON.stringify(customerId === undefined ? { persona } : { customer_id: customerId }),
    });
    if (typeof payload.chat_session_id !== 'string' || !payload.chat_session_id) throw new ChatApiError('UNKNOWN_ERROR');
    sessionIdRef.current = payload.chat_session_id;
    setSessionReady(true);
    return payload.chat_session_id;
  }

  async function send(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const text = message.trim();
    if (sendingRef.current || !text) return;
    sendingRef.current = true;
    setSending(true);
    setMessage('');
    const entryId = ++entryIdRef.current;
    setEntries((current) => [...current, { id: entryId, role: 'customer', text }, { id: entryId + 1, role: 'assistant', text: 'Đang chờ trợ lý phản hồi…' }]);
    entryIdRef.current += 1;
    try {
      const chatSessionId = await openSession();
      const turn = await requestJson('/api/testing/chat/turn', {
        method: 'POST',
        headers: csrfHeaders(true),
        body: JSON.stringify({ chat_session_id: chatSessionId, message: text }),
      });
      if (typeof turn.task_id !== 'string' || !turn.task_id) throw new ChatApiError('UNKNOWN_ERROR');
      const task = await pollTask(chatSessionId, turn.task_id);
      if (task.status === 'failed' || (task.status === 'completed' && task.answer === undefined)) throw new ChatApiError(task.errorCode ?? 'TASK_FAILED');
      const answer = task.status === 'awaiting_human'
        ? t('testing.chat.status.awaiting_human', undefined, 'vi')
        : task.status === 'stopped'
          ? t('testing.chat.status.stopped', undefined, 'vi')
          : task.answer as string;
      setEntries((current) => current.map((entry) => entry.id === entryId + 1
        ? { ...entry, text: answer, ...(task.status === 'completed' ? { completed: true, sources: task.sources ?? [] } : {}) }
        : entry));
    } catch (error: unknown) {
      const code = error instanceof ChatApiError ? error.errorCode : 'UNKNOWN_ERROR';
      setEntries((current) => current.map((entry) => entry.id === entryId + 1
        ? { ...entry, role: 'error', text: localizedError(code) }
        : entry));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return <section className="flex min-h-[500px] flex-col rounded-xl border border-line bg-surface p-4">
    <div className="flex items-center justify-between gap-3">
      <div><h2 className="font-semibold text-ink">Hội thoại</h2><p className="text-xs text-muted">Phiên riêng cho người dùng hiện tại.</p></div>
      {customerId === undefined
        ? <label className="text-xs text-muted">Khách hàng thử
        <select aria-label="Khách hàng thử" value={persona} disabled={sessionReady || sending} onChange={(event) => setPersona(event.target.value as Persona)} className="ui-input ml-2">
          <option value="anonymous">Khách ẩn danh</option>
          <option value="C05">Khách hàng C05</option>
          <option value="C06">Khách hàng C06</option>
        </select>
      </label>
        : <p className="text-xs text-muted">Đang trò chuyện với: <span className="font-medium text-ink">{customerLabel ?? 'khách hàng thử'}</span></p>}
    </div>
    <div className="mt-4 flex-1 space-y-3 overflow-auto" aria-live="polite">
      {entries.length === 0 ? <p className="py-10 text-center text-sm text-muted">Chưa có hội thoại.</p> : entries.map((entry) => <div key={entry.id} className={entry.role === 'customer' ? 'ml-8 rounded-lg bg-primary/10 p-3 text-sm text-ink' : entry.role === 'error' ? 'mr-4 rounded-lg border border-danger bg-danger/5 p-3 text-sm text-danger' : 'mr-4 rounded-lg border border-line p-3 text-sm text-ink'}>
        {entry.role === 'error' ? <p role="alert">{entry.text}</p> : <p>{entry.text}</p>}
        {entry.completed && <>
          <button type="button" className="mt-2 text-xs text-primary underline" aria-expanded={sourcesFor === entry.id} onClick={() => setSourcesFor((current) => current === entry.id ? null : entry.id)}>Vì sao gợi ý này?</button>
          {sourcesFor === entry.id && <ul aria-label="Nguồn thông tin" className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">{(entry.sources ?? []).length > 0 ? entry.sources?.map((source, index) => <li key={index}>{typeof source === 'string' ? source : JSON.stringify(source)}</li>) : <li>Chưa có nguồn thông tin.</li>}</ul>}
        </>}
      </div>)}
    </div>
    <form onSubmit={(event) => void send(event)} className="mt-4 border-t border-line pt-4">
      <textarea ref={inputRef} aria-label="Tin nhắn" value={message} onChange={(event) => setMessage(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={onKeyDown} disabled={sending} rows={2} className="ui-input w-full" placeholder="Nhập câu hỏi…" />
      <button type="submit" disabled={sending || !message.trim()} className="ui-button ui-button--primary mt-2 w-full">{sending ? 'Đang gửi…' : 'Gửi'}</button>
    </form>
  </section>;
}
