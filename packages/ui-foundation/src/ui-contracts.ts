import type {
  ProductCapabilityStatus,
  SourceFreshness,
  SourceStatus,
  UiRequestState,
} from './types/common.js';

export interface CapabilityState {
  readonly status: ProductCapabilityStatus;
  readonly label: string;
  readonly reason?: string | null;
  readonly href?: string | null;
}

export interface SourceState {
  readonly status: SourceStatus;
  readonly freshness: SourceFreshness;
  readonly observedAt?: string | null;
  readonly reason?: string | null;
}

export interface RequestState {
  readonly state: UiRequestState;
  readonly message: string;
  readonly correlationId?: string | null;
  readonly retryable?: boolean;
}

export interface EvidenceReference {
  readonly source: string;
  readonly observedAt?: string | null;
  readonly scope?: string | null;
}

export interface RunState {
  readonly runId: string;
  readonly lifecycle: string;
  readonly status: string;
  readonly observedAt?: string | null;
}

export interface TenantIdentity {
  readonly tenantId: string | null;
  readonly tenantLabel?: string | null;
  readonly role: string | null;
  readonly environment: string | null;
  readonly readOnly: boolean;
}

export interface MetricSnapshot<TValue = number | string> {
  readonly value: TValue | null;
  readonly source: SourceState;
  readonly window?: string | null;
  readonly provisional?: boolean;
}
