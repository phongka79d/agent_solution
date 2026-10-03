'use client';

import type { TestingStatusResponse } from '../tenant-console-client';

const CSRF_COOKIE = 'agentos_tenant_csrf';
const CSRF_HEADER = 'x-csrf-token';
const DISALLOWED_BROWSER_HEADERS = ['authorization', 'x-tenant-id', 'x-operator-id'];

export class TestLabError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly correlationId: string | null;

  constructor(status: number, errorCode: string, correlationId: string | null) {
    super(errorCode);
    this.name = 'TestLabError';
    this.status = status;
    this.errorCode = errorCode;
    this.correlationId = correlationId;
  }
}

export interface TestCustomer {
  readonly id: string;
  readonly tenant_id: string;
  readonly display_name: string | null;
  readonly primary_email: string | null;
  readonly primary_phone: string | null;
  readonly external_crm_id: string | null;
  readonly verification_status: string;
  readonly data_class: string;
  readonly created_at: string;
}

export interface TestCustomerIdentity {
  readonly id: string;
  readonly channel_type: string;
  readonly channel_identifier: string;
  readonly is_primary: boolean;
  readonly verified: boolean;
}

export interface TestCustomerConsent {
  readonly id: string;
  readonly consent_type: string;
  readonly channel: string;
  readonly is_granted: boolean;
}

export interface TestCustomerOrder {
  readonly id: string;
  readonly order_number: string;
  readonly status: string;
  readonly currency: string;
  readonly total_amount: number;
  readonly created_at: string;
}

export interface TestCustomerEvent {
  readonly id: string;
  readonly event_name: string;
  readonly channel: string;
  readonly session_id: string;
  readonly occurred_at: string;
}

export interface TestCustomerServiceCase {
  readonly id: string;
  readonly case_number: string;
  readonly state: string;
  readonly subject: string;
  readonly priority: string;
  readonly created_at: string;
}

export interface TestCustomerDetail extends TestCustomer {
  readonly identities: readonly TestCustomerIdentity[];
  readonly consents: readonly TestCustomerConsent[];
  readonly orders: readonly TestCustomerOrder[];
  readonly events: readonly TestCustomerEvent[];
  readonly service_cases: readonly TestCustomerServiceCase[];
}

export interface TestCustomerPage {
  readonly items: readonly TestCustomer[];
  readonly next_cursor: string | null;
}

export interface ResetDryRun {
  readonly dry_run: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly confirm_token?: string;
}

function csrfHeaders(json: boolean): Headers {
  const headers = new Headers({ accept: 'application/json' });
  if (json) headers.set('content-type', 'application/json');
  const raw = typeof document === 'undefined'
    ? undefined
    : document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  if (raw) {
    const value = raw.slice(CSRF_COOKIE.length + 1);
    try {
      headers.set(CSRF_HEADER, decodeURIComponent(value));
    } catch {
      headers.set(CSRF_HEADER, value);
    }
  }
  return headers;
}

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const headers = csrfHeaders(body !== undefined);
  for (const header of DISALLOWED_BROWSER_HEADERS) headers.delete(header);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new TestLabError(0, 'NETWORK_ERROR', null);
  }
  let payload: Record<string, unknown> = {};
  if (response.status !== 204) {
    try {
      const value: unknown = await response.json();
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) payload = value as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    const nested = payload.error !== null && typeof payload.error === 'object' && !Array.isArray(payload.error)
      ? payload.error as Record<string, unknown>
      : undefined;
    const errorCode = typeof payload.error_code === 'string'
      ? payload.error_code
      : typeof nested?.error_code === 'string'
        ? nested.error_code
        : typeof nested?.code === 'string'
          ? nested.code
          : 'UNKNOWN_ERROR';
    const correlationId = typeof payload.correlation_id === 'string' ? payload.correlation_id : null;
    throw new TestLabError(response.status, errorCode, correlationId);
  }
  return payload as T;
}

const BASE = '/api/v1/testing';

export async function getTestingStatus(): Promise<TestingStatusResponse> {
  return call<TestingStatusResponse>(`${BASE}/status`, 'GET');
}

export async function listTestCustomers(params: { limit?: number; cursor?: string; search?: string } = {}): Promise<TestCustomerPage> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor !== undefined) query.set('cursor', params.cursor);
  if (params.search !== undefined && params.search.trim() !== '') query.set('search', params.search.trim());
  const suffix = query.toString();
  return call<TestCustomerPage>(`${BASE}/customers${suffix ? `?${suffix}` : ''}`, 'GET');
}

export async function getTestCustomer(id: string): Promise<TestCustomerDetail> {
  const payload = await call<{ customer: TestCustomerDetail }>(`${BASE}/customers/${encodeURIComponent(id)}`, 'GET');
  return payload.customer;
}

export async function createTestCustomer(input: Record<string, unknown>): Promise<{ customer: TestCustomerDetail; seeded_order_reference?: string }> {
  return call<{ customer: TestCustomerDetail; seeded_order_reference?: string }>(`${BASE}/customers`, 'POST', input);
}

export async function deleteTestCustomer(id: string): Promise<void> {
  await call(`${BASE}/customers/${encodeURIComponent(id)}`, 'DELETE');
}

export async function testCustomerEvent(id: string, input: Record<string, unknown>): Promise<unknown> {
  return call(`${BASE}/customers/${encodeURIComponent(id)}/events`, 'POST', input);
}

export async function testCustomerOrder(id: string, input: Record<string, unknown>): Promise<unknown> {
  return call(`${BASE}/customers/${encodeURIComponent(id)}/orders`, 'POST', input);
}

export async function testCustomerConsent(id: string, input: Record<string, unknown>): Promise<unknown> {
  return call(`${BASE}/customers/${encodeURIComponent(id)}/consent`, 'POST', input);
}

export async function testCustomerSupportRequest(id: string, input: Record<string, unknown>): Promise<unknown> {
  return call(`${BASE}/customers/${encodeURIComponent(id)}/support-requests`, 'POST', input);
}

export async function testCustomerHandoffRequest(id: string, input: Record<string, unknown>): Promise<unknown> {
  return call(`${BASE}/customers/${encodeURIComponent(id)}/handoff-request`, 'POST', input);
}

export async function resetTestData(dryRun: boolean, confirmToken?: string): Promise<ResetDryRun> {
  return call<ResetDryRun>(`${BASE}/reset`, 'POST', {
    dry_run: dryRun,
    ...(confirmToken === undefined ? {} : { confirm_token: confirmToken }),
  });
}
