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
    status: { type: 'string', enum: ['ACTIVE', 'DISABLED', 'NOT_READY', 'NO_DATA'] },
    enabled: { type: 'boolean' },
    readiness: { type: 'string', enum: ['READY', 'NOT_READY', 'UNKNOWN'] },
    runs_today: { type: 'integer' },
    pending_approvals: { type: 'integer' },
    open_handoffs: { type: 'integer' },
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
  ],
  properties: {
    approval_id: { type: 'string' },
    run_id: { type: 'string' },
    action_id: { type: 'string' },
    effect_key: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
    reason: { type: 'string' },
    status: { type: 'string', enum: ['PENDING', 'EXPIRED'] },
    is_paused: { type: 'boolean' },
    decided_by: { type: ['string', 'null'] },
    decided_at: { type: ['string', 'null'] },
    decision_notes: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    payload_sha256: { type: 'string' },
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

const schemas = [
  companyAttentionItem,
  companyAiTeamAgent,
  companyActivityItem,
  companyIntegrationItem,
  approvalQueueItem,
  approvalDetailResponse,
  approvalDecisionRequest,
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
    required: ['attention', 'agents', 'activity'],
    properties: {
      attention: { type: 'array', items: { $ref: 'CompanyAttentionItem#' } },
      agents: { type: 'array', items: { $ref: 'CompanyAiTeamAgent#' } },
      activity: { type: 'array', items: { $ref: 'CompanyActivityItem#' } },
      metrics: { type: 'object', additionalProperties: { type: 'number' } },
    },
  },
  {
    $id: 'CompanyGovernanceResponse',
    type: 'object',
    additionalProperties: false,
    required: ['require_distinct_approver'],
    properties: {
      require_distinct_approver: { type: 'boolean' },
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
      'runs_count',
      'token_cost_records_count',
      'estimated_cost_total',
      'input_tokens_total',
      'output_tokens_total',
      'cached_tokens_total',
    ],
    properties: {
      tenant_id: { type: 'string' },
      runs_count: { type: ['integer', 'null'] },
      token_cost_records_count: { type: ['integer', 'null'] },
      estimated_cost_total: { type: ['string', 'null'] },
      input_tokens_total: { type: ['integer', 'null'] },
      output_tokens_total: { type: ['integer', 'null'] },
      cached_tokens_total: { type: ['integer', 'null'] },
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
    required: ['items'],
    properties: { items: { type: 'array', items: { $ref: 'PlatformProvider#' } } },
  },
] as const;

export const companyAttentionRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyAttentionResponse#' } },
};
export const companyAiTeamRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyAiTeamResponse#' } },
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
export const companyIntegrationsRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyIntegrationsResponse#' } },
};
export const companyOverviewRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'CompanyOverviewResponse#' } },
};
export const companyGovernanceRouteSchema: FastifySchema = {
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
    properties: { from: { type: 'string' }, to: { type: 'string' } },
  },
  response: { 200: { $ref: 'PlatformUsageResponse#' } },
};
export const platformProvidersRouteSchema: FastifySchema = {
  response: { 200: { $ref: 'PlatformProvidersResponse#' } },
};

export const approvalsListRouteSchema: FastifySchema = {
  querystring: {
    type: 'object',
    additionalProperties: true,
    properties: {
      status: { type: 'string', enum: ['PENDING'] },
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
