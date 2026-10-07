'use client';
import type {
  PlatformProvider,
  PlatformProvidersResponse,
  PlatformReadiness,
  PlatformTenant,
  PlatformTenantsResponse,
  PlatformUsage,
  PlatformUsageResponse,
} from '@agentos/api-contract';

export type {
  PlatformProvider,
  PlatformProvidersResponse,
  PlatformReadiness,
  PlatformTenant,
  PlatformTenantsResponse,
  PlatformUsage,
  PlatformUsageResponse,
} from '@agentos/api-contract';

export async function platformJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/${path.replace(/^\//, '')}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* malformed/non-JSON errors are handled below */ }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'message' in payload && typeof payload.message === 'string'
      ? payload.message : 'Unable to load data.';
    throw new Error(message);
  }
  return payload as T;
}

export async function listTenants(): Promise<readonly PlatformTenant[]> {
  const data = await platformJson<PlatformTenantsResponse>('platform/tenants');
  return Array.isArray(data.items) ? data.items : [];
}

export async function getTenant(id: string): Promise<PlatformTenant> {
  return platformJson<PlatformTenant>(`platform/tenants/${encodeURIComponent(id)}`);
}

export async function getReadiness(id: string): Promise<PlatformReadiness> {
  return platformJson<PlatformReadiness>(`platform/tenants/${encodeURIComponent(id)}/readiness`);
}

export async function getUsage(from: string, to: string): Promise<readonly PlatformUsage[]> {
  const query = new URLSearchParams({ from, to });
  const data = await platformJson<PlatformUsageResponse>(`platform/usage?${query.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function listProviders(): Promise<readonly PlatformProvider[]> {
  const data = await platformJson<PlatformProvidersResponse>('platform/providers');
  return Array.isArray(data.items) ? data.items : [];
}
