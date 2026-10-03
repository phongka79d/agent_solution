import type {
  CompanyApprovalProjectionSource,
  CompanyConnectorProjectionSource,
  CompanyHandoffProjectionSource,
  CompanyOwnerInputProjectionSource,
  CompanyReconciliationProjectionSource,
} from '@agentos/database';

export type CompanyDomain = 'marketing' | 'sales' | 'care' | 'platform';
export type AttentionType =
  | 'APPROVAL_PENDING'
  | 'HUMAN_HANDOFF'
  | 'PROVIDER_UNAVAILABLE'
  | 'CONNECTOR_NOT_CONFIGURED'
  | 'POLICY_CONFIGURATION_REQUIRED'
  | 'PARKED_DRAFT'
  | 'RUN_NEEDS_RECONCILIATION';
export type AttentionSeverity = 'info' | 'warning' | 'danger';

export interface AttentionItem {
  readonly type: AttentionType;
  readonly severity: AttentionSeverity;
  readonly domain: CompanyDomain;
  readonly title_key: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly href: string;
  readonly source_ref: string;
}

/**
 * One "Cần bạn xử lý" card: every observed item of one type collapsed into a count and a single
 * primary CTA. `params` carries the count so the copy can read "2 hội thoại cần nhân viên".
 */
export interface AttentionGroup {
  readonly type: AttentionType;
  readonly severity: AttentionSeverity;
  readonly domain: CompanyDomain;
  readonly count: number;
  readonly title_key: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly href: string;
  readonly cta_key: string;
}

const SEVERITY_ORDER: Readonly<Record<AttentionSeverity, number>> = { danger: 0, warning: 1, info: 2 };

/** Collapses attention items by type, strongest first, capped at `max` cards. */
export function groupAttention(items: readonly AttentionItem[], max = 5): readonly AttentionGroup[] {
  const groups = new Map<AttentionType, AttentionGroup>();
  for (const item of items) {
    const existing = groups.get(item.type);
    if (existing === undefined) {
      groups.set(item.type, {
        type: item.type,
        severity: item.severity,
        domain: item.domain,
        count: 1,
        title_key: `company.attention_group.${item.type.toLowerCase()}`,
        params: { count: 1 },
        href: item.href,
        cta_key: `company.attention_cta.${item.type.toLowerCase()}`,
      });
    } else {
      groups.set(item.type, { ...existing, count: existing.count + 1, params: { count: existing.count + 1 } });
    }
  }
  return [...groups.values()]
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || right.count - left.count)
    .slice(0, Math.max(1, max));
}

export interface AttentionProviderSource {
  readonly configured: boolean;
  readonly provider?: string | null;
}
/** A draft-gated MINIMUM policy or durable waiting run: "Bản nháp chờ bạn duyệt". */
export interface CompanyParkedDraftProjectionSource {
  readonly skill_id: string;
  readonly policy_version: string;
  readonly run_id?: string;
  readonly domain?: CompanyDomain | null;
}
export interface AttentionProjectionSources {
  readonly approvals?: readonly (CompanyApprovalProjectionSource & { readonly domain?: CompanyDomain | null })[];
  readonly handoffs?: readonly (CompanyHandoffProjectionSource & { readonly domain?: CompanyDomain | null })[];
  readonly connectors?: readonly CompanyConnectorProjectionSource[];
  readonly owner_inputs?: readonly CompanyOwnerInputProjectionSource[];
  readonly reconciliations?: readonly CompanyReconciliationProjectionSource[];
  readonly parked_drafts?: readonly CompanyParkedDraftProjectionSource[];
  readonly provider?: AttentionProviderSource;
}

function domainFromText(value: string | null | undefined): CompanyDomain {
  const text = value?.toLowerCase() ?? '';
  if (text.includes('marketing') || text.includes('mkt')) return 'marketing';
  if (text.includes('sales') || text.includes('sal')) return 'sales';
  if (text.includes('care') || text.includes('support') || text.includes('cs')) return 'care';
  return 'platform';
}

function attentionForApproval(item: CompanyApprovalProjectionSource & { readonly domain?: CompanyDomain | null }): AttentionItem {
  const domain = item.domain ?? domainFromText(item.skill_name);
  return {
    type: 'APPROVAL_PENDING',
    severity: 'warning',
    domain,
    title_key: 'company.attention.approval_pending',
    params: { approval_id: item.id, run_id: item.run_id },
    href: `/approvals/${encodeURIComponent(item.id)}`,
    source_ref: `approvals:${item.id}`,
  };
}

function attentionForHandoff(item: CompanyHandoffProjectionSource & { readonly domain?: CompanyDomain | null }): AttentionItem {
  const domain = item.domain ?? 'care';
  return {
    type: 'HUMAN_HANDOFF',
    severity: 'danger',
    domain,
    title_key: 'company.attention.human_handoff',
    params: { handoff_id: item.id, run_id: item.run_id, conversation_id: item.conversation_id },
    href: `/conversations/${encodeURIComponent(item.conversation_id)}`,
    source_ref: `care_handoffs:${item.id}`,
  };
}

function reconciliationMarked(item: CompanyReconciliationProjectionSource): boolean {
  if (item.effect_status === 'FAILED' || item.effect_status === 'EXPIRED') return true;
  const state = item.state.toUpperCase();
  if (state.includes('RECONCIL') || state === 'EFFECT_UNKNOWN') return true;
  if (item.state_payload === null || typeof item.state_payload !== 'object' || Array.isArray(item.state_payload)) return false;
  const payload = item.state_payload as Record<string, unknown>;
  return payload['effect_status'] === 'EFFECT_UNKNOWN'
    || payload['reconciliation_required'] === true
    || payload['reconcile_needed'] === true;
}
/** Maps only observed source rows to stable, catalog-resolved attention items. */
export function mapAttention(sources: AttentionProjectionSources): readonly AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const approval of sources.approvals ?? []) {
    if (approval.decision !== 'PENDING') continue;
    items.push(attentionForApproval(approval));
  }
  for (const handoff of sources.handoffs ?? []) {
    if (handoff.status !== 'ENQUEUED' && handoff.status !== 'ASSIGNED') continue;
    items.push(attentionForHandoff(handoff));
  }
  if (sources.provider !== undefined && !sources.provider.configured) {
    items.push({
      type: 'PROVIDER_UNAVAILABLE',
      severity: 'danger',
      domain: 'platform',
      title_key: 'company.attention.provider_unavailable',
      params: { provider_configured: false },
      href: '/integrations',
      source_ref: 'provider:configuration',
    });
  }
  for (const connector of sources.connectors ?? []) {
    if (connector.status !== 'UNBOUND') continue;
    items.push({
      type: 'CONNECTOR_NOT_CONFIGURED',
      severity: 'warning',
      domain: domainFromText(connector.connector_id),
      title_key: 'company.attention.connector_not_configured',
      params: { connector_id: connector.connector_id },
      href: '/integrations',
      source_ref: `connector_configurations:${connector.connector_id}`,
    });
  }
  for (const owner of sources.owner_inputs ?? []) {
    if (owner.status !== 'UNRESOLVED') continue;
    const domain = owner.input_id === 'careOnboardingItinerary' ? 'care' : 'platform';
    items.push({
      type: 'POLICY_CONFIGURATION_REQUIRED',
      severity: 'warning',
      domain,
      title_key: 'company.attention.policy_configuration_required',
      params: { input_id: owner.input_id },
      href: '/settings',
      source_ref: `unresolved_owner_inputs:${owner.input_id}`,
    });
  }
  for (const draft of sources.parked_drafts ?? []) {
    const domain = draft.domain ?? domainFromText(draft.skill_id);
    items.push({
      type: 'PARKED_DRAFT',
      severity: 'warning',
      domain,
      title_key: 'company.attention.parked_draft',
      params: {
        skill_id: draft.skill_id,
        policy_version: draft.policy_version,
        ...(draft.run_id === undefined ? {} : { run_id: draft.run_id }),
      },
      href: `/ai-team/${domain}/skills`,
      source_ref: draft.run_id === undefined
        ? `autonomy_policies:${draft.skill_id}:${draft.policy_version}`
        : `platform_durable_tasks:${draft.run_id}`,
    });
  }
  for (const reconciliation of sources.reconciliations ?? []) {
    if (!reconciliationMarked(reconciliation)) continue;
    items.push({
      type: 'RUN_NEEDS_RECONCILIATION',
      severity: 'danger',
      domain: 'platform',
      title_key: 'company.attention.run_needs_reconciliation',
      params: { run_id: reconciliation.run_id },
      href: `/runs/${encodeURIComponent(reconciliation.run_id)}`,
      source_ref: `platform_durable_tasks:${reconciliation.run_id}`,
    });
  }
  return items;
}

export const projectAttention = mapAttention;
