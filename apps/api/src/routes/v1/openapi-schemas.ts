import type { FastifyInstance, FastifySchema } from 'fastify';

const jsonScalar = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
} as const;

const params = {
  type: 'object',
  additionalProperties: true,
  propertyNames: { type: 'string' },
} as const;

const companyAttentionItem = {
  $id: 'CompanyAttentionItem',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'severity', 'domain', 'title_key', 'params', 'href', 'source_ref'],
  properties: {
    type: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'danger'] },
    domain: { type: 'string', enum: ['marketing', 'sales', 'care', 'platform'] },
    title_key: { type: 'string' },
    params: { ...params, additionalProperties: jsonScalar },
    href: { type: 'string' },
    source_ref: { type: 'string' },
  },
} as const;

const companyAiTeamAgent = {
  $id: 'CompanyAiTeamAgent',
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'status', 'enabled', 'readiness'],
  properties: {
    domain: { type: 'string', enum: ['marketing', 'sales', 'care'] },
    status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'DISABLED', 'NOT_READY', 'NO_DATA'] },
    enabled: { type: 'boolean' },
    readiness: { type: 'string', enum: ['READY', 'NOT_READY', 'UNKNOWN'] },
    runs_today: { type: 'integer' },
    pending_approvals: { type: 'integer' },
    open_handoffs: { type: 'integer' },
  },
} as const;
const companyAttentionGroup = {
  $id: 'CompanyAttentionGroup',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'severity', 'domain', 'count', 'title_key', 'params', 'href', 'cta_key'],
  properties: {
    type: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'danger'] },
    domain: { type: 'string', enum: ['marketing', 'sales', 'care', 'platform'] },
    count: { type: 'integer', minimum: 1 },
    title_key: { type: 'string' },
    params: { ...params, additionalProperties: jsonScalar },
    href: { type: 'string' },
    cta_key: { type: 'string' },
  },
} as const;
const companyAiTeamStripEntry = {
  $id: 'CompanyAiTeamStripEntry',
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'status', 'reason_key', 'href'],
  properties: {
    domain: { type: 'string', enum: ['marketing', 'sales', 'care'] },
    status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'DISABLED', 'NOT_READY', 'NO_DATA'] },
    reason_key: { type: 'string' },
    counter_key: { type: 'string', enum: ['runs_today', 'pending_approvals', 'open_handoffs'] },
    counter_value: { type: 'integer', minimum: 1 },
    href: { type: 'string' },
  },
} as const;
const companyTodayMetric = {
  $id: 'CompanyTodayMetric',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'count', 'updated_at'],
  properties: {
    key: { type: 'string', enum: ['conversations', 'ai_resolved', 'handed_to_staff', 'approvals_pending', 'campaigns_by_state'] },
    count: { type: 'integer', minimum: 1 },
    updated_at: { type: 'string' },
    params: { ...params, additionalProperties: jsonScalar },
  },
} as const;
const companyOverviewToday = {
  $id: 'CompanyOverviewToday',
  type: 'object',
  additionalProperties: false,
  required: ['updated_at', 'metrics'],
  properties: {
    updated_at: { type: 'string' },
    metrics: { type: 'array', items: { $ref: 'CompanyTodayMetric#' } },
  },
} as const;
const companyWorkspaceChecklistItem = {
  $id: 'CompanyWorkspaceChecklistItem',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'label_key', 'done', 'href'],
  properties: {
    key: { type: 'string' },
    label_key: { type: 'string' },
    done: { type: 'boolean' },
    href: { type: 'string' },
  },
} as const;
const companyOverviewWorkspace = {
  $id: 'CompanyOverviewWorkspace',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'checklist'],
  properties: {
    status: { type: 'string' },
    checklist: { type: 'array', items: { $ref: 'CompanyWorkspaceChecklistItem#' } },
  },
} as const;
const companyOverviewSections = {
  $id: 'CompanyOverviewSections',
  type: 'object',
  additionalProperties: false,
  required: ['attention', 'ai_team', 'today', 'activity', 'workspace'],
  properties: {
    attention: { type: 'string', enum: ['OK', 'ERROR'] },
    ai_team: { type: 'string', enum: ['OK', 'ERROR'] },
    today: { type: 'string', enum: ['OK', 'ERROR'] },
    activity: { type: 'string', enum: ['OK', 'ERROR'] },
    workspace: { type: 'string', enum: ['OK', 'ERROR'] },
  },
} as const;
const companyAiTeamPrerequisite = {
  $id: 'CompanyAiTeamPrerequisite',
  type: 'object',
  additionalProperties: false,
  required: ['reason_key', 'cta'],
  properties: {
    reason_key: { type: 'string' },
    cta: {
      type: 'object',
      additionalProperties: false,
      required: ['href', 'label_key'],
      properties: { href: { type: 'string' }, label_key: { type: 'string' } },
    },
  },
} as const;
const companyAiTeamDomainResponse = {
  $id: 'CompanyAiTeamDomainResponse',
  type: 'object',
  additionalProperties: false,
  required: ['agent', 'activation_status', 'unmet'],
  properties: {
    agent: { $ref: 'CompanyAiTeamAgent#' },
    activation_status: { type: 'string', enum: ['NOT_ACTIVATED', 'ACTIVE', 'PAUSED'] },
    unmet: { type: 'array', items: { $ref: 'CompanyAiTeamPrerequisite#' } },
  },
} as const;

const companyActivityItem = {
  $id: 'CompanyActivityItem',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'sentence_key', 'params', 'run_id', 'domain', 'occurred_at'],
  properties: {
    kind: { type: 'string' },
    sentence_key: { type: 'string' },
    params: { ...params, additionalProperties: jsonScalar },
    run_id: { type: 'string' },
    domain: { type: 'string', enum: ['marketing', 'sales', 'care', 'platform'] },
    occurred_at: { type: 'string' },
  },
} as const;

const runListItem = {
  $id: 'RunListItem',
  type: 'object',
  additionalProperties: false,
  required: [
    'run_id', 'domain', 'agents', 'title_key', 'title_params', 'state', 'state_business', 'state_raw',
    'created_at', 'updated_at', 'duration_ms', 'cost', 'tokens', 'attempts', 'failure',
    'retry_eligibility', 'needs_reconciliation', 'task_version', 'current_step', 'retry_count',
    'last_error_class', 'steps', 'correlation_id',
  ],
  properties: {
    run_id: { type: 'string' },
    domain: { type: 'string' },
    agents: { type: 'array', items: { type: 'string' } },
    title_key: { type: 'string' },
    title_params: { ...params, additionalProperties: jsonScalar },
    state: { type: 'string', enum: ['queued', 'running', 'waiting', 'awaiting_human', 'completed', 'stopped', 'failed'] },
    state_business: { type: 'string' },
    state_raw: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    duration_ms: { type: 'integer', minimum: 0 },
    cost: {
      anyOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: false, required: ['amount', 'currency'], properties: { amount: { type: 'number' }, currency: { type: 'string' } } },
      ],
    },
    tokens: {
      type: 'object', additionalProperties: false, required: ['input', 'output', 'total'],
      properties: { input: { type: 'integer', minimum: 0 }, output: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 0 } },
    },
    attempts: { type: 'integer', minimum: 1 },
    failure: {
      anyOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: false, required: ['code', 'reason_key', 'class'], properties: { code: { type: 'string' }, reason_key: { type: 'string' }, class: { type: 'string' } } },
      ],
    },
    retry_eligibility: {
      type: 'object', additionalProperties: false, required: ['retryable', 'reason_code'],
      properties: { retryable: { type: 'boolean' }, reason_code: { type: 'string' } },
    },
    needs_reconciliation: { type: 'boolean' },
    task_version: { type: 'integer' },
    current_step: { type: 'integer' },
    retry_count: { type: 'integer' },
    last_error_class: { type: ['string', 'null'] },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
    correlation_id: { type: 'string' },
  },
} as const;

const runStoryResponse = {
  $id: 'RunStoryResponse',
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'title_key', 'title_params', 'state', 'retries', 'retry_eligibility', 'steps', 'final_outcome', 'duration_ms'],
  properties: {
    title_key: { type: 'string' },
    title_params: { ...params, additionalProperties: jsonScalar },
    state: { type: 'string' },
    domain: { type: 'string' },
    retries: { type: 'integer', minimum: 0 },
    retry_eligibility: {
      type: 'object', additionalProperties: false, required: ['retryable', 'reason_code'],
      properties: { retryable: { type: 'boolean' }, reason_code: { type: 'string' } },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'status', 'duration_ms', 'summary_key', 'summary'],
        properties: {
          name: { type: 'string' }, status: { type: 'string' }, duration_ms: { type: 'integer', minimum: 0 },
          summary_key: { type: ['string', 'null'] }, summary: { type: 'object', additionalProperties: true },
        },
      },
    },
    final_outcome: {
      type: 'object', additionalProperties: false, required: ['status', 'reason_key', 'reason_code'],
      properties: {
        status: { type: 'string' },
        reason_key: { type: ['string', 'null'] },
        reason_code: { type: ['string', 'null'] },
      },
    },
    duration_ms: { type: 'integer', minimum: 0 },
  },
} as const;

const runTraceResponse = {
  $id: 'RunTraceResponse',
  type: 'object',
  additionalProperties: true,
} as const;

const companyIntegrationItem = {
  $id: 'CompanyIntegrationItem',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'category', 'status', 'detail_key'],
  properties: {
    key: { type: 'string' },
    category: { type: 'string' },
    status: { type: 'string', enum: ['LIVE', 'DEMO_MOCK', 'NOT_CONFIGURED', 'NOT_INTEGRATED'] },
    detail_key: { type: 'string' },
  },
} as const;

const approvalQueueItem = {
  $id: 'ApprovalQueueItem',
  type: 'object',
  additionalProperties: false,
  required: [
    'approval_id',
    'run_id',
    'action_id',
    'effect_key',
    'payload',
    'reason',
    'status',
    'is_paused',
    'decided_by',
    'decided_at',
    'decision_notes',
    'created_at',
    'payload_sha256',
    'summary',
  ],
  properties: {
    approval_id: { type: 'string' },
    run_id: { type: 'string' },
    action_id: { type: 'string' },
    effect_key: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
    reason: { type: 'string' },
    status: {
      type: 'string',
      enum: ['PENDING', 'EXPIRED', 'APPROVED', 'MODIFIED', 'REJECTED', 'CANCELLED', 'PAUSED'],
    },
    is_paused: { type: 'boolean' },
    decided_by: { type: ['string', 'null'] },
    decided_at: { type: ['string', 'null'] },
    decision_notes: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    payload_sha256: { type: 'string' },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'title_key',
        'params',
        'requesting_agent_key',
        'domain',
        'campaign_id',
        'customer_id',
        'risk',
        'evidence_count',
        'modification',
        'expires_at',
      ],
      properties: {
        title_key: { type: 'string' },
        params: { type: 'object', additionalProperties: true },
        requesting_agent_key: { type: 'string' },
        domain: { type: 'string', enum: ['marketing', 'sales', 'care', 'platform'] },
        campaign_id: { type: ['string', 'null'] },
        customer_id: { type: ['string', 'null'] },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        evidence_count: { type: 'integer', minimum: 0 },
        modification: {
          type: ['object', 'null'],
          additionalProperties: true,
        },
        expires_at: { type: 'string' },
      },
    },
  },
} as const;

const approvalDetailResponse = {
  $id: 'ApprovalDetailResponse',
  type: 'object',
  additionalProperties: false,
  required: [...approvalQueueItem.required, 'tenant_id', 'expires_at'],
  properties: {
    ...approvalQueueItem.properties,
    tenant_id: { type: 'string' },
    expires_at: { type: 'string' },
  },
} as const;

const approvalDecisionRequest = {
  $id: 'ApprovalDecisionRequest',
  type: 'object',
  additionalProperties: true,
  required: ['decision', 'reason', 'expected_payload_sha256'],
  properties: {
    decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'MODIFY', 'PAUSE', 'CANCEL'] },
    operator_id: { type: 'string' },
    reason: { type: 'string' },
    expected_payload_sha256: { type: 'string' },
    modified_payload: { type: 'object', additionalProperties: true },
  },
} as const;

const taskErrorProjection = {
  $id: 'TaskErrorProjection',
  type: 'object',
  additionalProperties: false,
  required: ['code', 'class'],
  properties: {
    code: { type: 'string' },
    class: { type: ['string', 'null'] },
  },
} as const;

const taskStateResponse = {
  $id: 'TaskStateResponse',
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'task_version', 'status', 'error', 'correlation_id'],
  properties: {
    task_id: { type: 'string' },
    task_version: { type: 'integer' },
    status: {
      type: 'string',
      enum: ['accepted', 'running', 'waiting', 'awaiting_human', 'in_flight', 'completed', 'stopped', 'failed'],
    },
    answer: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_record_id', 'source_version', 'source_file'],
        properties: {
          source_record_id: { type: 'string' },
          source_version: { type: 'string' },
          source_file: { type: 'string' },
        },
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'status', 'provider_reference'],
        properties: {
          operation: { type: 'string' },
          status: { type: 'string' },
          provider_reference: { type: 'string' },
        },
      },
    },
    evidence_reference: { type: 'string' },
    error: { anyOf: [{ $ref: 'TaskErrorProjection#' }, { type: 'null' }] },
    correlation_id: { type: 'string' },
  },
} as const;
const companyOwnerInputSummary = {
  $id: 'CompanyOwnerInputSummary',
  type: 'object',
  additionalProperties: false,
  required: ['input_id', 'status', 'version', 'resolved_at'],
  properties: {
    input_id: { type: 'string' },
    status: { type: 'string', enum: ['UNRESOLVED', 'RESOLVED'] },
    version: { type: 'integer', minimum: 1 },
    resolved_at: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

const companyOwnerInputResolutionRequest = {
  $id: 'CompanyOwnerInputResolutionRequest',
  type: 'object',
  additionalProperties: false,
  properties: {
    value: { type: 'object', minProperties: 1, maxProperties: 128 },
    value_ref: { type: 'string', minLength: 1, maxLength: 4096 },
  },
  oneOf: [
    { required: ['value'], not: { required: ['value_ref'] } },
    { required: ['value_ref'], not: { required: ['value'] } },
  ],
} as const;

const companyOwnerInputsResponse = {
  $id: 'CompanyOwnerInputsResponse',
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', items: { $ref: 'CompanyOwnerInputSummary#' } },
  },
} as const;

const companyOwnerInputResolutionResponse = {
  $id: 'CompanyOwnerInputResolutionResponse',
  type: 'object',
  additionalProperties: false,
  required: ['input'],
  properties: { input: { $ref: 'CompanyOwnerInputSummary#' } },
} as const;

const schemas = [
  companyOwnerInputSummary,
  companyOwnerInputResolutionRequest,
  companyOwnerInputsResponse,
  companyOwnerInputResolutionResponse,
  taskErrorProjection,
  taskStateResponse,
  companyAttentionItem,
  companyAttentionGroup,
  companyAiTeamAgent,
  companyAiTeamStripEntry,
  companyTodayMetric,
  companyOverviewToday,
  companyWorkspaceChecklistItem,
  companyOverviewWorkspace,
  companyOverviewSections,
  companyAiTeamPrerequisite,
  companyAiTeamDomainResponse,
  companyActivityItem,
  runListItem,
  runStoryResponse,
  runTraceResponse,
  companyIntegrationItem,
  approvalQueueItem,
  approvalDetailResponse,
  approvalDecisionRequest,
  {
    $id: 'ConversationTakeoverRequest',
    type: 'object',
    additionalProperties: true,
    required: ['reason', 'takeover_mode'],
    properties: {
      reason: { type: 'string', minLength: 1, pattern: '\\S' },
      takeover_mode: { type: 'string', enum: ['FULL_CONTROL', 'CO_PILOT'] },
    },
  },
  {
    $id: 'ConversationTakeoverResponse',
    type: 'object',
    additionalProperties: false,
    required: ['conversation_id', 'status', 'operator_id', 'taken_over_at', 'lease_expires_at'],
    properties: {
      conversation_id: { type: 'string' },
      status: { type: 'string', enum: ['HUMAN_TAKEOVER'] },
      operator_id: { type: 'string' },
      taken_over_at: { type: 'string', format: 'date-time' },
      lease_expires_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'ConversationTakeoverHeartbeatRequest',
    type: 'object',
    additionalProperties: true,
    required: ['extend_seconds'],
    properties: { extend_seconds: { type: 'integer', minimum: 1, maximum: 300 } },
  },
  {
    $id: 'ConversationTakeoverHeartbeatResponse',
    type: 'object',
    additionalProperties: false,
    required: ['conversation_id', 'status', 'operator_id', 'lease_expires_at'],
    properties: {
      conversation_id: { type: 'string' },
      status: { type: 'string', enum: ['HUMAN_TAKEOVER'] },
      operator_id: { type: 'string' },
      lease_expires_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'ConversationResumeRequest',
    type: 'object',
    additionalProperties: true,
    properties: {
      handoff_summary: { type: 'string' },
      next_agent_id: { type: 'string' },
    },
  },
  {
    $id: 'ConversationResumeResponse',
    type: 'object',
    additionalProperties: false,
    required: ['conversation_id', 'status', 'resumed_at'],
    properties: {
      conversation_id: { type: 'string' },
      status: { type: 'string', enum: ['ACTIVE'] },
      resumed_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'ConversationOperatorMessageRequest',
    type: 'object',
    additionalProperties: true,
    required: ['message'],
    properties: {
      message: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' },
      idempotency_key: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' },
    },
  },
  {
    $id: 'ConversationOperatorMessageResponse',
    type: 'object',
    additionalProperties: false,
    required: ['conversation_id', 'message_id', 'status'],
    properties: {
      conversation_id: { type: 'string' },
      message_id: { type: 'string' },
      status: { type: 'string', enum: ['persisted'] },
    },
  },
  {
    $id: 'ConversationListParams',
    type: 'object',
    additionalProperties: true,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string', description: 'Reserved; the current conversation reads do not paginate.' },
    },
  },
  {
    $id: 'ConversationOwnership',
    type: 'string',
    enum: ['AI_ACTIVE', 'NEEDS_HUMAN', 'HUMAN_ME', 'HUMAN_OTHER', 'PAUSED_ORPHAN', 'CLOSED'],
  },
  {
    $id: 'ConversationOwner',
    type: 'object',
    additionalProperties: false,
    required: ['operator_id', 'display_name', 'lease_expires_at'],
    properties: {
      operator_id: { type: 'string' },
      display_name: { type: ['string', 'null'] },
      lease_expires_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'ConversationListItem',
    type: 'object',
    additionalProperties: true,
    required: ['conversation_id', 'customer', 'channel', 'state', 'last_message_at', 'ownership', 'owner'],
    properties: {
      conversation_id: { type: 'string' },
      customer: {
        type: 'object',
        additionalProperties: true,
        required: ['customer_id', 'display_name'],
        properties: {
          customer_id: { type: ['string', 'null'] },
          display_name: { type: ['string', 'null'] },
        },
      },
      channel: { type: 'string' },
      state: { type: 'string' },
      last_message_at: { type: 'string', format: 'date-time' },
      ownership: { $ref: 'ConversationOwnership#' },
      owner: { anyOf: [{ $ref: 'ConversationOwner#' }, { type: 'null' }] },
    },
  },
  {
    $id: 'ConversationListResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array', items: { $ref: 'ConversationListItem#' } },
      next_cursor: { type: ['string', 'null'] },
    },
  },
  {
    $id: 'ConversationMessage',
    type: 'object',
    additionalProperties: true,
    required: ['message_id', 'sender_type', 'sender_id', 'content', 'created_at'],
    properties: {
      message_id: { type: 'string' },
      sender_type: { type: 'string', enum: ['customer', 'agent', 'operator', 'system'] },
      sender_id: { type: 'string' },
      content: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'ConversationMessagesResponse',
    type: 'object',
    additionalProperties: false,
    required: ['conversation_id', 'items', 'next_cursor'],
    properties: {
      conversation_id: { type: 'string' },
      items: { type: 'array', items: { $ref: 'ConversationMessage#' } },
      next_cursor: { type: ['string', 'null'] },
    },
  },
  {
    $id: 'ConversationSummaryResponse',
    type: 'object',
    additionalProperties: true,
    required: ['conversation_id', 'customer', 'ownership', 'owner', 'escalation', 'channel', 'last_message_at'],
    properties: {
      conversation_id: { type: 'string' },
      customer: {
        type: ['object', 'null'],
        additionalProperties: true,
        required: ['customer_id', 'display_name', 'tier', 'classification', 'email', 'phone'],
        properties: {
          customer_id: { type: ['string', 'null'] },
          display_name: { type: ['string', 'null'] },
          tier: { type: ['string', 'null'] },
          classification: { type: 'string', enum: ['FACT', 'SIGNAL', 'HYPOTHESIS', 'DECISION', 'ACTION', 'UNCLASSIFIED'] },
          email: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
        },
      },
      ownership: { $ref: 'ConversationOwnership#' },
      owner: { anyOf: [{ $ref: 'ConversationOwner#' }, { type: 'null' }] },
      escalation: {
        type: 'object',
        additionalProperties: true,
        required: ['state', 'takeover_operator_id'],
        properties: {
          state: { type: 'string' },
          takeover_operator_id: { type: ['string', 'null'] },
        },
      },
      channel: { type: 'string' },
      last_message_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'CustomerTimelineParams',
    type: 'object',
    additionalProperties: true,
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  },
  {
    $id: 'CustomerTimelineEntry',
    type: 'object',
    additionalProperties: true,
    required: ['occurred_at', 'event_id', 'event_type', 'stage', 'canonical_event', 'classification'],
    properties: {
      occurred_at: { type: 'string', format: 'date-time' },
      source_record_id: { type: 'string' },
      event_id: { type: 'string' },
      event_type: { type: 'string' },
      stage: { type: 'string' },
      canonical_event: { type: ['string', 'null'] },
      classification: { type: 'string', enum: ['FACT', 'SIGNAL', 'HYPOTHESIS', 'DECISION', 'ACTION'] },
      domain: { type: 'string', enum: ['MARKETING', 'SALES', 'COMMERCE', 'SUPPORT', 'ORCHESTRATOR'] },
      summary: { type: 'string' },
      evidence_reference: { type: 'string' },
      gap_reason: { type: 'string' },
    },
  },
  {
    $id: 'CustomerTimelineResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array', items: { $ref: 'CustomerTimelineEntry#' } },
      next_cursor: { type: ['string', 'null'] },
    },
  },
  {
    $id: 'CompanyAttentionResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'CompanyAttentionItem#' } } },
  },
  {
    $id: 'CompanyAiTeamResponse',
    type: 'object',
    additionalProperties: false,
    required: ['agents'],
    properties: { agents: { type: 'array', items: { $ref: 'CompanyAiTeamAgent#' } } },
  },
  {
    $id: 'CompanyActivityResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array', items: { $ref: 'CompanyActivityItem#' } },
      next_cursor: { type: ['string', 'null'] },
    },
  },
  {
    $id: 'RunListResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: { $ref: 'RunListItem#' } }, next_cursor: { type: ['string', 'null'] } },
  },
  {
    $id: 'CompanyIntegrationsResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'CompanyIntegrationItem#' } } },
  },
  {
    $id: 'CompanyOverviewResponse',
    type: 'object',
    additionalProperties: false,
    required: ['attention', 'ai_team', 'activity', 'sections'],
    properties: {
      attention: { type: 'array', items: { $ref: 'CompanyAttentionGroup#' } },
      ai_team: { type: 'array', items: { $ref: 'CompanyAiTeamStripEntry#' } },
      today: { $ref: 'CompanyOverviewToday#' },
      activity: { type: 'array', items: { $ref: 'CompanyActivityItem#' } },
      workspace: { $ref: 'CompanyOverviewWorkspace#' },
      sections: { $ref: 'CompanyOverviewSections#' },
    },
  },
  {
    $id: 'CompanyGovernanceResponse',
    type: 'object',
    additionalProperties: false,
    required: [
      'require_distinct_approver',
      'approval_expiry_hours',
      'takeover_lease_seconds',
      'version',
    ],
    properties: {
      require_distinct_approver: { type: 'boolean' },
      approval_expiry_hours: { type: 'integer', minimum: 1, maximum: 720 },
      takeover_lease_seconds: { type: 'integer', minimum: 30, maximum: 600 },
      version: { type: 'integer', minimum: 1 },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'CompanyGovernanceUpdateRequest',
    type: 'object',
    additionalProperties: false,
    required: ['require_distinct_approver', 'approval_expiry_hours', 'takeover_lease_seconds'],
    properties: {
      require_distinct_approver: { type: 'boolean' },
      approval_expiry_hours: { type: 'integer', minimum: 1, maximum: 720 },
      takeover_lease_seconds: { type: 'integer', minimum: 30, maximum: 600 },
    },
  },
  {
    $id: 'ApprovalListResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array', items: { $ref: 'ApprovalQueueItem#' } },
      next_cursor: { type: ['string', 'null'] },
    },
  },
  {
    $id: 'ApprovalDecisionResponse',
    type: 'object',
    additionalProperties: false,
    required: ['approval_id', 'task_id', 'status', 'queued_at', 'correlation_id'],
    properties: {
      approval_id: { type: 'string' },
      task_id: { type: 'string' },
      status: { type: 'string', enum: ['QUEUED'] },
      queued_at: { type: 'string' },
      correlation_id: { type: 'string' },
    },
  },
  {
    $id: 'PlatformTenant',
    type: 'object',
    additionalProperties: false,
    required: ['tenant_id', 'display_name', 'status', 'created_at', 'enabled_modules'],
    properties: {
      tenant_id: { type: 'string' },
      display_name: { type: 'string' },
      status: { type: 'string' },
      created_at: { type: 'string' },
      enabled_modules: { type: ['array', 'null'], items: { type: 'string' } },
    },
  },
  {
    $id: 'PlatformReadiness',
    type: 'object',
    additionalProperties: false,
    required: [
      'tenant_id',
      'capability_count',
      'capability_statuses',
      'connector_count',
      'connector_statuses',
      'owner_input_count',
      'owner_input_statuses',
      'workspace_status',
      'residency_status',
    ],
    properties: {
      tenant_id: { type: 'string' },
      capability_count: { type: ['integer', 'null'] },
      capability_statuses: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
      connector_count: { type: ['integer', 'null'] },
      connector_statuses: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
      owner_input_count: { type: ['integer', 'null'] },
      owner_input_statuses: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
      workspace_status: { type: ['string', 'null'] },
      residency_status: { type: ['string', 'null'] },
    },
  },
  {
    $id: 'PlatformUsage',
    type: 'object',
    additionalProperties: false,
    required: [
      'tenant_id',
      'display_name',
      'usage_day',
      'domain',
      'model',
      'currency',
      'cost_recorded',
      'record_count',
      'input_tokens_total',
      'output_tokens_total',
      'cached_tokens_total',
      'tokens_total',
      'cost_total',
      'monthly_token_budget',
    ],
    properties: {
      tenant_id: { type: 'string' },
      display_name: { type: 'string' },
      usage_day: { type: 'string' },
      domain: { type: ['string', 'null'] },
      model: { type: ['string', 'null'] },
      currency: { type: ['string', 'null'] },
      cost_recorded: { type: 'boolean' },
      record_count: { type: 'integer' },
      input_tokens_total: { type: 'integer' },
      output_tokens_total: { type: 'integer' },
      cached_tokens_total: { type: 'integer' },
      tokens_total: { type: 'integer' },
      cost_total: { type: ['string', 'null'] },
      monthly_token_budget: { type: ['integer', 'null'] },
    },
  },
  {
    $id: 'PlatformProvider',
    type: 'object',
    additionalProperties: false,
    required: ['provider', 'configured', 'mode'],
    properties: {
      provider: { type: 'string' },
      configured: { type: 'boolean' },
      mode: { type: 'string' },
    },
  },
  {
    $id: 'PlatformLlmProvider',
    type: 'object',
    additionalProperties: false,
    required: [
      'provider_id',
      'display_name',
      'base_url',
      'reasoning_model',
      'fast_model',
      'timeout_ms',
      'structured_mode',
      'status',
      'is_default',
      'secret_configured',
      'config_version',
      'updated_at',
      'last_probe',
      'secret_fingerprint',
      'secret_last4',
    ],
    properties: {
      provider_id: { type: 'string' },
      display_name: { type: 'string' },
      base_url: { type: 'string' },
      reasoning_model: { type: 'string' },
      fast_model: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 },
      structured_mode: { type: 'string', enum: ['json_object', 'json_schema'] },
      status: { type: 'string', enum: ['CONFIGURED', 'VERIFIED', 'FAILED'] },
      is_default: { type: 'boolean' },
      secret_configured: { type: 'boolean' },
      config_version: { type: 'string' },
      updated_at: { type: 'string', format: 'date-time' },
      last_probe: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['outcome', 'latency_ms', 'http_status', 'error_class', 'probed_at'],
        properties: {
          outcome: { type: 'string', enum: ['PASS', 'FAIL'] },
          latency_ms: { type: ['integer', 'null'] },
          http_status: { type: ['integer', 'null'] },
          error_class: { type: ['string', 'null'] },
          probed_at: { type: 'string', format: 'date-time' },
        },
      },
      secret_fingerprint: { type: ['string', 'null'] },
      secret_last4: { type: ['string', 'null'] },
    },
  },
  {
    $id: 'PlatformCompanyUser',
    type: 'object',
    additionalProperties: false,
    required: [
      'user_id',
      'display_name',
      'email',
      'role_bundle',
      'status',
      'last_sign_in_at',
      'created_at',
      'updated_at',
    ],
    properties: {
      user_id: { type: 'string' },
      display_name: { type: ['string', 'null'] },
      email: { type: 'string', format: 'email' },
      role_bundle: { type: 'string', enum: ['COMPANY_ADMIN', 'OPERATOR', 'VIEWER'] },
      status: { type: 'string', enum: ['INVITED', 'ACTIVE', 'DEACTIVATED'] },
      last_sign_in_at: { type: ['string', 'null'], format: 'date-time' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  {
    $id: 'CompanyUsersResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'PlatformCompanyUser#' } } },
  },
  {
    $id: 'PlatformCompanyUsersResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'PlatformCompanyUser#' } } },
  },
  {
    $id: 'PlatformTenantsResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'PlatformTenant#' } } },
  },
  {
    $id: 'PlatformUsageResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'PlatformUsage#' } } },
  },
  {
    $id: 'PlatformProvidersResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items', 'providers'],
    properties: {
      items: { type: 'array', items: { $ref: 'PlatformProvider#' } },
      providers: { type: 'array', items: { $ref: 'PlatformLlmProvider#' } },
    },
  },
  {
    $id: 'PlatformAdmin',
    type: 'object',
    additionalProperties: false,
    required: ['user_id', 'display_name', 'email', 'status', 'last_sign_in_at', 'created_at', 'updated_at', 'role'],
    properties: {
      user_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      display_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      email: { type: 'string' },
      status: { type: 'string', enum: ['INVITED', 'ACTIVE', 'DEACTIVATED'] },
      last_sign_in_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      created_at: { type: 'string' },
      updated_at: { type: 'string' },
      role: { type: 'string', const: 'PLATFORM_ADMIN' },
    },
  },
  {
    $id: 'PlatformAdminsResponse',
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'PlatformAdmin#' } } },
  },
  {
    $id: 'PlatformAdminInvitation',
    type: 'object',
    additionalProperties: false,
    required: ['invitation_id', 'email', 'expires_at'],
    properties: {
      invitation_id: { type: 'string' },
      email: { type: 'string' },
      expires_at: { type: 'string' },
    },
  },
  {
    $id: 'PlatformAdminInvitationRequest',
    type: 'object',
    additionalProperties: false,
    required: ['email'],
    properties: { email: { type: 'string', minLength: 3, maxLength: 320 } },
  },
  {
    $id: 'PlatformAdminInvitationResponse',
    type: 'object',
    additionalProperties: false,
    required: ['invitation_id', 'email', 'expires_at'],
    properties: {
      invitation_id: { type: 'string' },
      email: { type: 'string' },
      expires_at: { type: 'string' },
    },
  },
  {
    $id: 'PlatformSkillCatalogItem',
    type: 'object',
    additionalProperties: true,
    required: ['skill_id', 'runs_24h', 'success_rate_24h', 'p95_ms_24h'],
    properties: {
      skill_id: { type: 'string' },
      runs_24h: { type: 'integer', minimum: 0 },
      success_rate_24h: { anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, { type: 'null' }] },
      p95_ms_24h: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    },
  },
  {
    $id: 'PlatformSkillCatalogResponse',
    type: 'object',
    additionalProperties: false,
    required: ['catalog'],
    properties: { catalog: { type: 'array', items: { $ref: 'PlatformSkillCatalogItem#' } } },
  },
  {
    $id: 'ErrorResponse',
    type: 'object',
    additionalProperties: false,
    required: ['error_code', 'message', 'retryable', 'correlation_id'],
    properties: {
      error_code: { type: 'string' },
      message: { type: 'string' },
      retryable: { type: 'boolean' },
      correlation_id: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
    },
  },
] as const;

/**
 * The refusal envelope every gateway operation can answer with (`06` §1 `ErrorResponse`), mounted
 * as the 4xx/5xx response by the contract emit so an operation is never documented without one.
 */
export const errorEnvelopeResponse = {
  description: 'ErrorResponse — the gateway vocabulary for a refusal.',
  content: { 'application/json': { schema: { $ref: 'ErrorResponse#' } } },
} as const;

/** The liveness payload (`GET /health`), which sits outside the `/api/v1` prefix. */
export const healthRouteSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'service', 'dependencies'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        service: { type: 'string' },
        dependencies: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

export const taskStateRouteSchema: FastifySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['task_id'],
    properties: { task_id: { type: 'string' } },
  },
  response: { 200: { $ref: 'TaskStateResponse#' } },
};

export const conversationTakeoverRouteSchema: FastifySchema = {
  body: { $ref: 'ConversationTakeoverRequest#' },
  response: { 200: { $ref: 'ConversationTakeoverResponse#' } },
};
export const conversationTakeoverHeartbeatRouteSchema: FastifySchema = {
  body: { $ref: 'ConversationTakeoverHeartbeatRequest#' },
  response: { 200: { $ref: 'ConversationTakeoverHeartbeatResponse#' } },
};
export const conversationResumeRouteSchema: FastifySchema = {
  // An omitted body is valid: Fastify validates it as null.
  body: { anyOf: [{ $ref: 'ConversationResumeRequest#' }, { type: 'null' }] },
  response: { 200: { $ref: 'ConversationResumeResponse#' } },
};
export const conversationOperatorMessageRouteSchema: FastifySchema = {
  body: { $ref: 'ConversationOperatorMessageRequest#' },
  response: { 201: { $ref: 'ConversationOperatorMessageResponse#' } },
};
export const conversationListRouteSchema: FastifySchema = {
  querystring: { $ref: 'ConversationListParams#' },
  response: { 200: { $ref: 'ConversationListResponse#' } },
};
export const conversationMessagesRouteSchema: FastifySchema = {
  querystring: { $ref: 'ConversationListParams#' },
  response: { 200: { $ref: 'ConversationMessagesResponse#' } },
};
export const conversationSummaryRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'ConversationSummaryResponse#' } },
};
export const customerTimelineRouteSchema: FastifySchema = {
  querystring: { $ref: 'CustomerTimelineParams#' },
  response: { 200: { $ref: 'CustomerTimelineResponse#' } },
};

export const companyAttentionRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyAttentionResponse#' } },
};
export const companyAiTeamRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyAiTeamResponse#' } },
};
export const companyAiTeamDomainRouteSchema: FastifySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['domain'],
    properties: { domain: { type: 'string', enum: ['marketing', 'sales', 'care'] } },
  },
  response: { 200: { $ref: 'CompanyAiTeamDomainResponse#' } },
};
export const companyOwnerInputsRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyOwnerInputsResponse#' } },
};
export const companyOwnerInputResolveRouteSchema: FastifySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9-]+$' } },
  },
  headers: {
    type: 'object',
    additionalProperties: true,
    required: ['if-match'],
    properties: { 'if-match': { type: 'string', maxLength: 32 } },
  },
  body: { $ref: 'CompanyOwnerInputResolutionRequest#' },
  response: { 200: { $ref: 'CompanyOwnerInputResolutionResponse#' } },
};
export const companyActivityRouteSchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: true,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' },
    },
  },
  response: { 200: { $ref: 'CompanyActivityResponse#' } },
};
export const campaignsListRouteSchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: true,
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
  },
};

export const runListRouteSchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: true,
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      agent_id: { type: 'string' },
      state: { type: 'string', enum: ['queued', 'running', 'waiting', 'awaiting_human', 'completed', 'stopped', 'failed'] },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
    },
  },
  response: { 200: { $ref: 'RunListResponse#' } },
};
export const runStoryRouteSchema: FastifySchema = {
  params: { type: 'object', additionalProperties: false, required: ['run_id'], properties: { run_id: { type: 'string', minLength: 1, maxLength: 64 } } },
  response: { 200: { $ref: 'RunStoryResponse#' } },
};
export const runTraceRouteSchema: FastifySchema = {
  params: { type: 'object', additionalProperties: false, required: ['run_id'], properties: { run_id: { type: 'string', minLength: 1, maxLength: 64 } } },
  response: { 200: { $ref: 'RunTraceResponse#' } },
};
export const companyIntegrationsRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyIntegrationsResponse#' } },
};
export const companyOverviewRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyOverviewResponse#' } },
};
export const companyGovernanceRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyGovernanceResponse#' } },
};
export const companyGovernancePutRouteSchema: FastifySchema = {
  headers: {
    type: 'object',
    additionalProperties: true,
    required: ['if-match'],
    properties: { 'if-match': { type: 'string', description: 'The settings version returned as ETag.' } },
  },
  body: { $ref: 'CompanyGovernanceUpdateRequest#' },
  response: { 200: { $ref: 'CompanyGovernanceResponse#' } },
};

export const platformTenantsRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'PlatformTenantsResponse#' } },
};
export const platformTenantRouteSchema: FastifySchema = {
  params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
  response: { 200: { $ref: 'PlatformTenant#' } },
};
export const platformReadinessRouteSchema: FastifySchema = {
  params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
  response: { 200: { $ref: 'PlatformReadiness#' } },
};
export const platformUsageRouteSchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: true,
    required: ['from', 'to'],
    properties: {
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
    },
  },
  response: { 200: { $ref: 'PlatformUsageResponse#' } },
};
export const platformProvidersRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'PlatformProvidersResponse#' } },
};
export const platformCompanyUsersRouteSchema: FastifySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
  },
  response: { 200: { $ref: 'PlatformCompanyUsersResponse#' } },
};
export const platformCompanyAutonomyRouteSchema: FastifySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
  },
  response: {
    200: {
      type: 'object',
      additionalProperties: true,
      required: ['tenant_id', 'paused', 'current', 'history'],
      properties: {
        tenant_id: { type: 'string' },
        paused: { type: 'boolean' },
        current: { type: 'array', items: { type: 'object', additionalProperties: true } },
        history: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
  },
};
export const platformAdminsRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'PlatformAdminsResponse#' } },
};
export const platformAdminInvitationRouteSchema: FastifySchema = {
  body: { $ref: 'PlatformAdminInvitationRequest#' },
  response: { 201: { $ref: 'PlatformAdminInvitationResponse#' } },
};

export const platformSkillCatalogRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'PlatformSkillCatalogResponse#' } },
};

export const companyUsersRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyUsersResponse#' } },
};
export const companyUserResponseRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'PlatformCompanyUser#' } },
};

export const approvalsListRouteSchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: true,
    properties: {
      status: { type: 'string', enum: ['PENDING', 'DECIDED'] },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
  },
  response: { 200: { $ref: 'ApprovalListResponse#' } },
};
export const approvalDetailRouteSchema: FastifySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['approval_id'],
    properties: { approval_id: { type: 'string' } },
  },
  response: { 200: { $ref: 'ApprovalDetailResponse#' } },
};
export const approvalDecisionRouteSchema: FastifySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['approval_id'],
    properties: { approval_id: { type: 'string' } },
  },
  body: { $ref: 'ApprovalDecisionRequest#' },
  response: { 202: { $ref: 'ApprovalDecisionResponse#' } },
};

export function registerOpenApiSchemas(app: FastifyInstance): void {
  for (const schema of schemas) {
    if (app.getSchema(schema.$id) === undefined) app.addSchema(schema);
  }
}
