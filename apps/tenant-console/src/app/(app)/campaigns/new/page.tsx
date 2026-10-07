'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { RequirePermission } from '../../../../components/auth/RequirePermission';
import { Button, Field, Input, PageHeader, Select } from '@agentos/ui-foundation/react';

function csrfToken(): string | undefined { const entry = typeof document === 'undefined' ? undefined : document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('agentos_tenant_csrf=')); if (!entry) return undefined; try { return decodeURIComponent(entry.slice('agentos_tenant_csrf='.length)); } catch { return entry.slice('agentos_tenant_csrf='.length); } }
async function readJson(response: Response): Promise<Record<string, unknown>> { try { const value: unknown = await response.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }

function NewCampaignContent() {
  const router = useRouter();
  const [segment, setSegment] = useState('inactive_90d');
  const [objective, setObjective] = useState('winback');
  const [instruction, setInstruction] = useState('');
  const [channel, setChannel] = useState('EMAIL_HTML');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(null);
    const key = `campaign-draft-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' }); const csrf = csrfToken(); if (csrf) headers.set('x-csrf-token', csrf);
    try {
      const response = await fetch('/api/v1/campaigns/drafts', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ idempotency_key: key, segment_id: segment.trim(), objective: objective.trim(), instruction: instruction.trim() || undefined, content_constraints: { channel, locale: 'vi-VN' } }) });
      const payload = await readJson(response); if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : typeof payload.error === 'string' ? payload.error : 'Không thể tạo bản nháp.');
      const runId = typeof payload.task_id === 'string' ? payload.task_id : typeof payload.run_id === 'string' ? payload.run_id : undefined;
      if (runId) router.push(`/campaigns/${encodeURIComponent(runId)}`); else setError('Bản nháp đã được tiếp nhận nhưng chưa có mã thực thi.');
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Không thể tạo bản nháp.'); } finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-2xl space-y-6"><PageHeader title="Tạo bản nháp chiến dịch" description="Bản nháp chỉ được tiếp nhận; không gửi nội dung khi chưa có phê duyệt." /><form onSubmit={submit} className="space-y-5 rounded-xl border border-line bg-surface p-5"><Field label="Phân khúc"><Input value={segment} onChange={(event) => setSegment(event.target.value)} required /></Field><Field label="Mục tiêu"><Input value={objective} onChange={(event) => setObjective(event.target.value)} required /></Field><Field label="Kênh"><Select value={channel} onChange={(event) => setChannel(event.target.value)} options={[{ value: 'EMAIL_HTML', label: 'Email' }, { value: 'SMS_TEXT', label: 'SMS' }, { value: 'ZALO_ZNS', label: 'Zalo' }]} /></Field><Field label="Hướng dẫn"><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={2000} rows={5} className="ui-input w-full" placeholder="Mô tả nội dung cần soạn…" /></Field>{error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>}<div className="flex justify-end"><Button type="submit" disabled={busy || !segment.trim() || !objective.trim()} loading={busy}>{busy ? 'Đang tạo…' : 'Tạo bản nháp'}</Button></div></form></div>;
}
export default function NewCampaignPage() { return <RequirePermission permission="campaign:draft"><NewCampaignContent /></RequirePermission>; }
