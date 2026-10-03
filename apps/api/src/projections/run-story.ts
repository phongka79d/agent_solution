import { classifyErrorCode, getErrorCatalogEntry } from '@agentos/core-engine';
import type {
  AgentRunLog,
  DurableTaskRecord,
  ImmutableEvidenceRecord,
  ProviderCallLedgerRecord,
  RunStageEventRecord,
  RunStageResultRecord,
} from '@agentos/database';
import type { RunRetryClassification } from '../gateway/ports.js';
import type { RunProjection } from '../gateway/contracts.js';


function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function domainOf(payload: unknown): string {
  const root = record(payload);
  const signal = record(root?.['signal']);
  const signalPayload = record(signal?.['payload']);
  const domain = root?.['domain'] ?? signalPayload?.['module'];
  if (domain === 'sales' || domain === 'care' || domain === 'marketing') return domain;
  const event = signal?.['event_type'];
  if (typeof event === 'string') {
    const prefix = event.split('.', 1)[0];
    if (prefix === 'sales' || prefix === 'care' || prefix === 'marketing') return prefix;
  }
  return 'platform';
}

function stateBusiness(state: DurableTaskRecord['state']): string {
  switch (state) {
    case 'queued': return 'QUEUED';
    case 'running': return 'IN_PROGRESS';
    case 'waiting': return 'NEEDS_RECONCILIATION';
    case 'awaiting_human': return 'AWAITING_HUMAN_APPROVAL';
    case 'completed': return 'COMPLETED';
    case 'failed': return 'FAILED';
    case 'stopped': return 'STOPPED';
  }
}


function errorCode(value: unknown): string | null {
  const obj = record(value);
  return typeof obj?.['code'] === 'string' && obj['code'].length > 0 ? obj['code'] : null;
}

const DOMAIN_DISPLAY: Readonly<Record<string, string>> = {
  marketing: 'tiếp thị',
  sales: 'bán hàng',
  care: 'chăm sóc khách hàng',
  platform: 'nền tảng',
};

function cleanTitleText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length === 0 ? null : clean.slice(0, maximum);
}

function maskedCustomerName(value: unknown): string | null {
  const clean = cleanTitleText(value, 120);
  if (clean === null) return null;
  return clean.split(' ').map((part) => `${[...part][0] ?? '*'}***`).join(' ');
}

function titleSourceText(
  root: Record<string, unknown> | null,
  keys: readonly string[],
  nestedField: 'customer' | 'campaign',
  nestedKeys: readonly string[] = keys,
): unknown {
  if (root === null) return undefined;
  const signal = record(root['signal']);
  const signalPayload = record(signal?.['payload']);
  const payload = record(root['payload']);
  const nested = record(root[nestedField])
    ?? record(payload?.[nestedField])
    ?? record(signalPayload?.[nestedField]);
  const candidates: readonly unknown[] = [
    ...keys.flatMap((key) => [root[key], signal?.[key], signalPayload?.[key], payload?.[key]]),
    ...nestedKeys.map((key) => nested?.[key]),
  ];
  return candidates.find((candidate) => typeof candidate === 'string');
}

export function titleOf(
  domain: string,
  statePayload: unknown,
): { key: string; params: Readonly<Record<string, string | number | boolean>> } {
  const root = record(statePayload);
  const customer = maskedCustomerName(titleSourceText(
    root,
    ['customer_display_name', 'customer_name', 'display_name'],
    'customer',
    ['display_name', 'name'],
  ));
  const campaign = cleanTitleText(titleSourceText(
    root,
    ['campaign_name'],
    'campaign',
    ['name', 'campaign_name'],
  ), 120);
  const safeDomain = Object.hasOwn(DOMAIN_DISPLAY, domain) ? domain : 'platform';
  return {
    key: `company.run.title.${safeDomain}`,
    params: {
      domain: DOMAIN_DISPLAY[safeDomain] ?? DOMAIN_DISPLAY['platform'] ?? 'nền tảng',
      customer: customer ?? 'khách hàng',
      campaign: campaign ?? 'chiến dịch',
    },
  };
}

export type RetryClassification = RunRetryClassification;

export interface RetryEligibility {
  readonly retryable: boolean;
  readonly reason_code: string;
}

export function mapRetryEligibility(
  classification: RetryClassification,
  state: DurableTaskRecord['state'],
): RetryEligibility {
  if (classification.retryable) return { retryable: true, reason_code: 'SAFE_TO_RETRY' };
  if (state === 'waiting') return { retryable: false, reason_code: 'RECONCILIATION_REQUIRED' };
  if (classification.reason === 'UNKNOWN') return { retryable: false, reason_code: 'RETRY_SAFETY_NOT_PROVEN' };
  return { retryable: false, reason_code: classification.reason };
}

function costAndTokens(calls: readonly ProviderCallLedgerRecord[]) {
  let prompt = 0;
  let completion = 0;
  let hasTokens = false;
  const amounts: number[] = [];
  let currency: string | null = null;
  let completeCosts = calls.length > 0;
  for (const call of calls) {
    if (call.prompt_tokens !== null) { prompt += call.prompt_tokens; hasTokens = true; }
    if (call.completion_tokens !== null) { completion += call.completion_tokens; hasTokens = true; }
    if (call.estimated_cost_amount === null || call.currency === null) {
      completeCosts = false;
    } else {
      const amount = Number(call.estimated_cost_amount);
      if (!Number.isFinite(amount) || (currency !== null && currency !== call.currency)) completeCosts = false;
      else { currency = call.currency; amounts.push(amount); }
    }
  }
  return {
    cost: completeCosts && currency !== null
      ? { amount: amounts.reduce((sum, amount) => sum + amount, 0), currency }
      : null,
    tokens: { input: hasTokens ? prompt : 0, output: hasTokens ? completion : 0, total: hasTokens ? prompt + completion : 0 },
  };
}

function durationOf(task: DurableTaskRecord): number {
  const created = Date.parse(task.created_at);
  const updated = Date.parse(task.updated_at);
  return Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : 0;
}

function terminalReasonCodeOf(state_payload: unknown): string | null {
  const root = record(state_payload);
  const plan = record(root?.['plan']);
  const terminalResponse = record(plan?.['terminal_response']);
  const reasonCode = terminalResponse?.['reason_code'];
  return typeof reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)
    ? reasonCode
    : null;
}


/** Produces the bounded, business-facing list row without leaking task payloads or log context. */
export function projectRunListItem(
  task: DurableTaskRecord,
  logs: readonly AgentRunLog[],
  calls: readonly ProviderCallLedgerRecord[],
  classification: RetryClassification,
): RunProjection {
  const domain = domainOf(task.state_payload);
  const title = titleOf(domain, task.state_payload);
  const code = errorCode(task.error_details) ?? (task.state === 'failed' ? 'RUN_FAILURE_UNCLASSIFIED' : null);
  const catalog = code === null ? undefined : getErrorCatalogEntry(code);
  const failed = task.state === 'failed';
  const usage = costAndTokens(calls);
  const payload = record(task.state_payload);
  const requestedAgent = payload?.['agent_id'] ?? payload?.['agent_code'];
  const agents = [...new Set([
    ...logs.map((log) => log.agent_id),
    ...(typeof requestedAgent === 'string' ? [requestedAgent] : []),
  ])].sort();
  return {
    run_id: task.run_id,
    domain,
    agents,
    title_key: title.key,
    title_params: title.params,
    state: task.state,
    state_business: stateBusiness(task.state),
    state_raw: task.state,
    created_at: task.created_at,
    updated_at: task.updated_at,
    duration_ms: durationOf(task),
    cost: usage.cost,
    tokens: usage.tokens,
    attempts: task.retry_count + 1,
    failure: failed ? {
      code: code ?? 'RUN_FAILURE_UNCLASSIFIED',
      reason_key: catalog?.reason_key ?? 'run.failure.unclassified',
      class: catalog?.class ?? (code === null ? (task.last_error_class ?? 'FATAL') : classifyErrorCode(code)),
    } : null,
    retry_eligibility: mapRetryEligibility(classification, task.state),
    needs_reconciliation: task.state === 'waiting',
    // Existing operator clients still use these operational fields during the v2 UI migration.
    task_version: task.task_version,
    current_step: task.current_step,
    retry_count: task.retry_count,
    last_error_class: task.last_error_class,
    steps: [],
    correlation_id: task.correlation_id,
  };
}

const SAFE_DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
  SIGNAL: ['event_type', 'channel', 'domain'],
  CONTEXT: ['customer_verified', 'takeover_active', 'data_class'],
  HYPOTHESIS: ['intent', 'confidence', 'provider_call_index'],
  DECISION: ['target_agent', 'routing_reason_key'],
  PLAN: ['steps'],
  ACTION: ['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status'],
  APPROVAL: ['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status'],
  EXECUTION: ['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status'],
  EVIDENCE: ['agent', 'skill', 'skill_id', 'verdict', 'approval_id', 'attempts', 'evidence_id', 'effect_key_status'],
  OUTCOME: ['outcome_kind', 'outcome_watch_id'],
  LEARNING: ['outcome_kind', 'outcome_watch_id'],
};

function safeDetail(stage: string, value: unknown): Readonly<Record<string, unknown>> {
  const source = record(value);
  if (source === null) return {};
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_DETAIL_KEYS[stage] ?? []) {
    const item = source[key];
    if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      safe[key] = item;
    } else if (key === 'steps' && Array.isArray(item)) {
      safe[key] = item.flatMap((step) => {
        const row = record(step);
        if (row === null) return [];
        const clean: Record<string, unknown> = {};
        for (const allowed of ['agent', 'skill', 'authority', 'mutating']) {
          const part = row[allowed];
          if (typeof part === 'string' || typeof part === 'boolean') clean[allowed] = part;
        }
        return [clean];
      });
    }
  }
  return safe;
}

function displayName(stage: string, skill: string | null): string {
  const label = skill ?? stage.toLowerCase();
  const leaf = label.split('.').at(-1) ?? label;
  return leaf.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stepStatus(status: RunStageResultRecord['status']): string {
  switch (status) {
    case 'completed': return 'COMPLETED';
    case 'failed': return 'FAILED';
    case 'refused': return 'FAILED';
    case 'awaiting_human': return 'AWAITING_HUMAN_APPROVAL';
  }
}

export interface RunStoryProjection {
  readonly domain: string;
  readonly title_key: string;
  readonly title_params: Readonly<Record<string, string | number | boolean>>;
  readonly state: string;
  readonly retries: number;
  readonly retry_eligibility: RetryEligibility;
  readonly steps: readonly {
    readonly name: string;
    readonly status: string;
    readonly duration_ms: number;
    readonly summary_key: string | null;
    readonly summary: Readonly<Record<string, unknown>>;
  }[];
  readonly final_outcome: {
    readonly status: string;
    readonly reason_key: string | null;
    readonly reason_code: string | null;
  };
  readonly duration_ms: number;
}

/** Company-facing narrative: names and allowlisted summaries only; no technical identifiers. */
export function projectRunStory(
  task: DurableTaskRecord,
  stages: readonly RunStageResultRecord[],
  classification: RetryClassification,
): RunStoryProjection {
  const domain = domainOf(task.state_payload);
  const title = titleOf(domain, task.state_payload);
  const ordered = [...stages].sort((a, b) => a.attempt_ordinal - b.attempt_ordinal || a.started_at.localeCompare(b.started_at) || a.step_index - b.step_index);
  let failed: RunStageResultRecord | undefined;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const stage = ordered[index];
    if (stage !== undefined && (stage.status === 'failed' || stage.status === 'refused')) {
      failed = stage;
      break;
    }
  }
  return {
    domain,
    title_key: title.key,
    title_params: title.params,
    state: stateBusiness(task.state),
    retries: task.retry_count,
    retry_eligibility: mapRetryEligibility(classification, task.state),
    steps: ordered.map((stage) => ({
      name: displayName(stage.stage, stage.skill_id),
      status: stepStatus(stage.status),
      duration_ms: stage.duration_ms,
      summary_key: stage.summary_key,
      summary: safeDetail(stage.stage, stage.detail),
    })),
    final_outcome: {
      status: stateBusiness(task.state),
      reason_key: failed?.summary_key ?? (task.state === 'failed' ? (getErrorCatalogEntry(errorCode(task.error_details) ?? '')?.reason_key ?? 'run.failure.unclassified') : null),
      reason_code: terminalReasonCodeOf(task.state_payload),
    },
    duration_ms: ordered.reduce((sum, stage) => sum + stage.duration_ms, 0) || durationOf(task),
  };
}

export interface RunTraceProjection {
  readonly run_id: string;
  readonly correlation_id: string;
  readonly domain: string;
  readonly state: { readonly business: string; readonly raw: string };
  readonly attempts: number;
  readonly duration_ms: number;
  readonly stages: readonly {
    readonly stage: string;
    readonly status: string;
    readonly started_at: string;
    readonly completed_at: string;
    readonly duration_ms: number;
    readonly agent_code: string | null;
    readonly skill_id: string | null;
    readonly summary_key: string | null;
    readonly error_class: string | null;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly evidence_refs: unknown;
  }[];
  readonly stage_events: readonly {
    readonly stage: string;
    readonly entered_at: string;
    readonly detail: Readonly<Record<string, unknown>>;
  }[];
  readonly provider_calls: readonly ProviderCallLedgerRecord[];
  readonly effect_keys: readonly string[];
  readonly approval_id: string | null;
  readonly audit_refs: readonly string[];
  readonly evidence_refs: readonly string[];
}

/** Operator trace adds only persisted technical ledgers; private task payloads and log contexts stay hidden. */
export function projectRunTrace(input: {
  task: DurableTaskRecord;
  stages: readonly RunStageResultRecord[];
  events: readonly RunStageEventRecord[];
  calls: readonly ProviderCallLedgerRecord[];
  logs: readonly AgentRunLog[];
  evidence: readonly ImmutableEvidenceRecord[];
}): RunTraceProjection {
  const { task, stages, events, calls, logs, evidence } = input;
  const effectKeys = new Set<string>();
  for (const log of logs) {
    const action = record(log.action);
    if (typeof action?.['effect_key'] === 'string') effectKeys.add(action['effect_key']);
  }
  const pending = record(record(task.state_payload)?.['pending_action']);
  if (typeof pending?.['effect_key'] === 'string') effectKeys.add(pending['effect_key']);
  return {
    run_id: task.run_id,
    correlation_id: task.correlation_id,
    domain: domainOf(task.state_payload),
    state: { business: stateBusiness(task.state), raw: task.state },
    attempts: task.retry_count + 1,
    duration_ms: durationOf(task),
    stages: stages.map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      started_at: stage.started_at,
      completed_at: stage.completed_at,
      duration_ms: stage.duration_ms,
      agent_code: stage.agent_code,
      skill_id: stage.skill_id,
      summary_key: stage.summary_key,
      error_class: stage.error_class,
      detail: safeDetail(stage.stage, stage.detail),
      evidence_refs: stage.evidence_refs,
    })),
    stage_events: events.map((event) => ({ stage: event.stage, entered_at: event.entered_at, detail: safeDetail(event.stage, event.detail) })),
    provider_calls: calls,
    effect_keys: [...effectKeys].sort(),
    approval_id: task.paused_for_approval_id,
    audit_refs: [],
    evidence_refs: evidence.map((item) => item.evidence_id),
  };
}
