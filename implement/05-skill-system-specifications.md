# Skill System and Runtime Specifications

Status: Production Engineering Specification
System Component: Skill Engine Runtime and Platform Skill Registry (Layer 1)
Document Version: 1.0.0
Target Directory: `implement/05-skill-system-specifications.md`

---

## 1. Skill Engine Runtime Architecture

The Skill Engine is the isolated execution runtime responsible for validating, arbitrating, and executing deterministic capabilities ("Skills") on behalf of cognitive agents (`MKT-*`, `SAL-*`, `CS-*`).

### 1.1. Core Invariants and Separation of Concerns
1. **Agent vs. Skill Decoupling**: Agents represent LLM-driven cognitive reasoning entities. Skills represent strictly typed, deterministic operational units. An agent never executes tools directly; it requests skill execution through the Revenue Orchestrator.
2. **Hard Authority Enforcement (BR-008, BR-009)**: LLMs cannot upgrade their own execution authority. Authority level (`AUTH-0` to `AUTH-5`) is checked on the server side prior to tool execution.
3. **Idempotency Guarantee (BR-005, NFR-003)**: Mutating skills require a deterministic `effect_key`.
4. **Resilience & Circuit Protection (NFR-004)**: All skills are bounded by strict timeouts, circuit breakers, and exponential backoff retry loops.

```
                           [Orchestrator Request]
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │    Skill Dispatcher     │
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │     Authority Guard     │ ◄── Enforces AUTH-0..5, RLS
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │     Input Validator     │ ◄── JSON Schema / Type Guard
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │     Circuit Breaker     │ ◄── CLOSED / OPEN / HALF-OPEN
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │  Timeout / Abort Guard  │ ◄── Hard Deadline Ceiling
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │       Retry Loop        │ ◄── Exp. Backoff + Jitter
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │  Adapter / Tool Exec    │ ◄── API-001, API-002, Adapters
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │   Evidence / Audit Log  │ ◄── SHA-256 Chained Evidence
                        └─────────────────────────┘
```

---

## 2. Skill Runtime Engine Implementation (TypeScript)

Below is the concrete implementation of the Skill Runtime encompassing Dispatcher, Authority Guard, Circuit Breaker, Timeout Controller, and Retry Loop.

```typescript
/**
 * @file skill-engine-runtime.ts
 * @description Production runtime harness for executing platform skills safely.
 */

import { EventEmitter } from 'events';

export type AuthorityLevel = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';

export interface RetryPolicy {
  readonly max_retries: number;
  readonly initial_interval_ms: number;
  readonly backoff_multiplier: number;
  readonly non_retryable_errors: string[];
}

export interface AuditSpec {
  readonly log_level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  readonly mask_pii_fields: string[];
  readonly evidence_card: string;
  readonly record_latency: boolean;
}

export interface ISkillContract<TInput = unknown, TOutput = unknown> {
  readonly skill_id: string;
  readonly purpose: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly allowed_agents: string[];
  readonly required_authority: AuthorityLevel;
  readonly tool_binding: string;
  readonly validation_rules: string[];
  readonly retry_policy: RetryPolicy;
  readonly timeout_ms: number;
  readonly audit_spec: AuditSpec;
  validateInput(input: unknown): TInput;
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
}

export interface ExecutionContext {
  readonly run_id: string;
  readonly tenant_id: string;
  readonly caller_agent: string;
  readonly correlation_id: string;
  readonly granted_authority: AuthorityLevel;
  readonly effect_key: string;
  readonly signal?: AbortSignal;
}

// ============================================================================
// CIRCUIT BREAKER PATTERN
// ============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private lastStateChangedAt: number = Date.now();

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 30000
  ) {}

  public canExecute(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastStateChangedAt > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.lastStateChangedAt = Date.now();
        return true;
      }
      return false;
    }
    return true;
  }

  public recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  public recordFailure(): void {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.lastStateChangedAt = Date.now();
    }
  }

  public getState(): CircuitState {
    return this.state;
  }
}

// ============================================================================
// SKILL RUNTIME DISPATCHER
// ============================================================================

export class SkillRuntimeEngine {
  private readonly registry = new Map<string, ISkillContract>();
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();

  public registerSkill(skill: ISkillContract): void {
    this.registry.set(skill.skill_id, skill);
    this.circuitBreakers.set(skill.skill_id, new CircuitBreaker(5, 30000));
  }

  public async executeSkill<TIn, TOut>(
    skillId: string,
    rawInput: unknown,
    context: ExecutionContext
  ): Promise<TOut> {
    const skill = this.registry.get(skillId) as ISkillContract<TIn, TOut> | undefined;
    if (!skill) {
      throw new Error(`SKILL_NOT_FOUND: Skill ${skillId} is not registered`);
    }

    // 1. Authority Guard Check (Server Side)
    this.enforceAuthorityGuard(skill, context);

    // 2. Input Validation
    const validatedInput = skill.validateInput(rawInput);

    // 3. Circuit Breaker Check
    const breaker = this.circuitBreakers.get(skillId)!;
    if (!breaker.canExecute()) {
      throw new Error(`CIRCUIT_BREAKER_OPEN: Skill ${skillId} downstream is unavailable`);
    }

    // 4. Execution with Timeout and Retry Loop
    return this.executeWithRetryAndTimeout(skill, validatedInput, context, breaker);
  }

  private enforceAuthorityGuard(skill: ISkillContract, context: ExecutionContext): void {
    // Check Agent Authorization
    if (!skill.allowed_agents.includes(context.caller_agent)) {
      throw new Error(
        `UNAUTHORIZED_AGENT: Agent ${context.caller_agent} not permitted to invoke ${skill.skill_id}`
      );
    }

    // Hierarchy ranking
    const rank: Record<AuthorityLevel, number> = {
      'AUTH-0': 0,
      'AUTH-1': 1,
      'AUTH-2': 2,
      'AUTH-3': 3,
      'AUTH-4': 4,
      'AUTH-5': 5,
    };

    if (rank[context.granted_authority] < rank[skill.required_authority]) {
      throw new Error(
        `INSUFFICIENT_AUTHORITY: Skill requires ${skill.required_authority}, but context has ${context.granted_authority}`
      );
    }
  }

  private async executeWithRetryAndTimeout<TIn, TOut>(
    skill: ISkillContract<TIn, TOut>,
    input: TIn,
    context: ExecutionContext,
    breaker: CircuitBreaker
  ): Promise<TOut> {
    const { retry_policy, timeout_ms } = skill;
    let attempt = 0;
    let delay = retry_policy.initial_interval_ms;

    while (attempt <= retry_policy.max_retries) {
      attempt += 1;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeout_ms);

      try {
        const enrichedContext: ExecutionContext = {
          ...context,
          signal: abortController.signal,
        };

        const result = await skill.execute(input, enrichedContext);
        clearTimeout(timeoutId);
        breaker.recordSuccess();
        return result;
      } catch (err: any) {
        clearTimeout(timeoutId);

        const isAborted = abortController.signal.aborted;
        const errorCode = isAborted ? 'TIMEOUT' : err.code || err.message || 'UNKNOWN_ERROR';

        // Check if error is non-retryable
        const fatal = retry_policy.non_retryable_errors.includes(errorCode) || isAborted;

        if (fatal || attempt > retry_policy.max_retries) {
          breaker.recordFailure();
          throw new Error(
            `SKILL_EXECUTION_FAILED [${skill.skill_id}]: ${errorCode} after ${attempt} attempts`
          );
        }

        // Full Jitter Exponential Backoff
        const jitter = Math.random() * delay;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay *= retry_policy.backoff_multiplier;
      }
    }

    throw new Error(`SKILL_EXECUTION_EXHAUSTED: ${skill.skill_id}`);
  }
}
```

---

## 3. Standard 11-Field Skill Contract Structure

Every platform skill conforms to the 11-field specification:

1. **Skill ID**: Canonical dot-notated identifier (`skill.<domain>.<action>`).
2. **Purpose**: Concrete operational scope and domain boundaries.
3. **Input Schema**: Strict JSON Schema defining parameters.
4. **Output Schema**: Strict JSON Schema defining the returned structure.
5. **Allowed Agents**: Array of agent IDs authorized to call this skill.
6. **Required Authority**: Minimum security clearance (`AUTH-0` to `AUTH-4`).
7. **Tool Binding**: Target adapter or service connector name.
8. **Validation Rules**: Formal business validation constraints prior to invocation.
9. **Retry Policy**: Maximum retries, backoff factor, and fatal error codes.
10. **Timeout**: Maximum execution latency in milliseconds.
11. **Audit Spec**: Audit logging level, PII masking keys, evidence card format.

---

## 4. Complete Specifications for All 23 Platform Skills

---

### 4.1. Marketing Domain Skills (7 Skills)

#### Skill 1: `skill.mkt.analyze_market_signal`
- **1. Skill ID**: `skill.mkt.analyze_market_signal`
- **2. Purpose**: Analyzes external digital trends, competitor catalog movements, and search velocity to derive market signals.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "market_region", "category_id", "observation_window_days"],
  "properties": {
    "tenant_id": { "type": "string" },
    "market_region": { "type": "string", "enum": ["TW", "GLOBAL_US", "GLOBAL_EU", "VN"] },
    "category_id": { "type": "string" },
    "observation_window_days": { "type": "integer", "minimum": 1, "maximum": 90 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["signals", "trend_velocity", "analyzed_at"],
  "properties": {
    "signals": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["signal_id", "keyword", "search_volume_growth", "price_pressure_index"],
        "properties": {
          "signal_id": { "type": "string" },
          "keyword": { "type": "string" },
          "search_volume_growth": { "type": "number" },
          "price_pressure_index": { "type": "number" }
        }
      }
    },
    "trend_velocity": { "type": "string", "enum": ["SLOW", "STABLE", "RAPID", "EXPLOSIVE"] },
    "analyzed_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-01", "MKT-02"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `API-002.EventIngestion`
- **8. Validation Rules**: `["observation_window_days must be between 1 and 90", "tenant_id must be authorized for specified market_region"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 1000, "backoff_multiplier": 2.0, "non_retryable_errors": ["INVALID_REGION", "CATEGORY_NOT_FOUND"]}`
- **10. Timeout**: `3000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_SIGNAL_ANALYSIS", "record_latency": true}`

```typescript
export interface InputMktAnalyzeSignal {
  tenant_id: string;
  market_region: 'TW' | 'GLOBAL_US' | 'GLOBAL_EU' | 'VN';
  category_id: string;
  observation_window_days: number;
}
export interface OutputMktAnalyzeSignal {
  signals: Array<{ signal_id: string; keyword: string; search_volume_growth: number; price_pressure_index: number }>;
  trend_velocity: 'SLOW' | 'STABLE' | 'RAPID' | 'EXPLOSIVE';
  analyzed_at: string;
}
```

---

#### Skill 2: `skill.mkt.segment_audience`
- **1. Skill ID**: `skill.mkt.segment_audience`
- **2. Purpose**: Segments customer cohort by RFM profile, purchase recency, and brand affinity.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "rfm_criteria", "min_days_inactive"],
  "properties": {
    "tenant_id": { "type": "string" },
    "rfm_criteria": { "type": "string", "enum": ["CHAMPIONS", "LOYAL", "POTENTIAL_LOYALIST", "AT_RISK", "HIBERNATING"] },
    "min_days_inactive": { "type": "integer", "minimum": 0 },
    "max_segment_size": { "type": "integer", "default": 5000 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["segment_id", "matched_customer_count", "customer_ids", "generated_at"],
  "properties": {
    "segment_id": { "type": "string" },
    "matched_customer_count": { "type": "integer" },
    "customer_ids": { "type": "array", "items": { "type": "string" } },
    "generated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-02", "MKT-05"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `PostgreSQL.Customer360Store`
- **8. Validation Rules**: `["max_segment_size cannot exceed 50000", "min_days_inactive must be non-negative"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 1000, "backoff_multiplier": 1.5, "non_retryable_errors": ["QUERY_TIMEOUT", "INVALID_RFM"]}`
- **10. Timeout**: `2500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_ids"], "evidence_card": "EV_MKT_AUDIENCE_SEGMENT", "record_latency": true}`

```typescript
export interface InputMktSegmentAudience {
  tenant_id: string;
  rfm_criteria: 'CHAMPIONS' | 'LOYAL' | 'POTENTIAL_LOYALIST' | 'AT_RISK' | 'HIBERNATING';
  min_days_inactive: number;
  max_segment_size?: number;
}
export interface OutputMktSegmentAudience {
  segment_id: string;
  matched_customer_count: number;
  customer_ids: string[];
  generated_at: string;
}
```

---

#### Skill 3: `skill.mkt.check_consent`
- **1. Skill ID**: `skill.mkt.check_consent`
- **2. Purpose**: Verifies opt-in consent and suppression status for marketing channels (BR-004).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "channel"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE", "WHATSAPP", "SMS", "EMAIL", "ZALO", "TIKTOK", "MESSENGER", "INSTAGRAM"] }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["allowed", "consent_timestamp", "suppression_reason"],
  "properties": {
    "allowed": { "type": "boolean" },
    "consent_timestamp": { "type": ["string", "null"], "format": "date-time" },
    "suppression_reason": { "type": ["string", "null"] }
  }
}
```
- **5. Allowed Agents**: `["MKT-02", "MKT-05", "SAL-04"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-002.ConsentStore`
- **8. Validation Rules**: `["customer_id must be valid uuid/cuid", "channel must be configured in tenant settings"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 2.0, "non_retryable_errors": ["CUSTOMER_NOT_FOUND"]}`
- **10. Timeout**: `1000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CONSENT_VERIFICATION", "record_latency": true}`

```typescript
export interface InputMktCheckConsent {
  tenant_id: string;
  customer_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'SMS' | 'EMAIL' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
}
export interface OutputMktCheckConsent {
  allowed: boolean;
  consent_timestamp: string | null;
  suppression_reason: string | null;
}
```

---

#### Skill 4: `skill.mkt.generate_content`
- **1. Skill ID**: `skill.mkt.generate_content`
- **2. Purpose**: Generates multi-channel copy tailored to audience segment and campaign goals.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "campaign_theme", "channel", "locale"],
  "properties": {
    "tenant_id": { "type": "string" },
    "campaign_theme": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE_FLEX", "WHATSAPP_TEMPLATE", "EMAIL_HTML", "SMS_TEXT", "ZALO_ZNS", "TIKTOK_CARD", "MESSENGER_GENERIC", "INSTAGRAM_DIRECT"] },
    "locale": { "type": "string", "enum": ["zh-TW", "en-US", "vi-VN", "ja-JP"] },
    "product_skus": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["draft_id", "headline", "body_content", "cta_text", "channel_payload"],
  "properties": {
    "draft_id": { "type": "string" },
    "headline": { "type": "string" },
    "body_content": { "type": "string" },
    "cta_text": { "type": "string" },
    "channel_payload": {
      "type": "object",
      "required": ["channel_type"],
      "properties": {
        "channel_type": { "type": "string" },
        "line_flex_container": { "type": "object" },
        "whatsapp_template": {
          "type": "object",
          "properties": {
            "template_name": { "type": "string" },
            "parameters": { "type": "array", "items": { "type": "string" } }
          }
        },
        "zalo_zns_template": {
          "type": "object",
          "properties": {
            "template_id": { "type": "string" },
            "template_data": { "type": "object", "additionalProperties": { "type": "string" } }
          }
        },
        "meta_generic_card": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "subtitle": { "type": "string" },
            "image_url": { "type": "string" },
            "cta_button_url": { "type": "string" }
          }
        }
      }
    }
  }
}
```
- **5. Allowed Agents**: `["MKT-03"]`
- **6. Required Authority**: `AUTH-2`
- **7. Tool Binding**: `Core.LLMContentEngine`
- **8. Validation Rules**: `["campaign_theme must not exceed 250 characters", "locale must be supported"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "non_retryable_errors": ["PROMPT_INJECTION_DETECTED"]}`
- **10. Timeout**: `5000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_CONTENT_DRAFT", "record_latency": true}`

```typescript
export interface ChannelSpecificPayload {
  channel_type: string;
  line_flex_container?: Record<string, unknown>;
  whatsapp_template?: { template_name: string; parameters: string[] };
  zalo_zns_template?: { template_id: string; template_data: Record<string, string> };
  meta_generic_card?: { title: string; subtitle: string; image_url?: string; cta_button_url?: string };
}

export interface InputMktGenerateContent {
  tenant_id: string;
  campaign_theme: string;
  channel: 'LINE_FLEX' | 'WHATSAPP_TEMPLATE' | 'EMAIL_HTML' | 'SMS_TEXT' | 'ZALO_ZNS' | 'TIKTOK_CARD' | 'MESSENGER_GENERIC' | 'INSTAGRAM_DIRECT';
  locale: 'zh-TW' | 'en-US' | 'vi-VN' | 'ja-JP';
  product_skus?: string[];
}
export interface OutputMktGenerateContent {
  draft_id: string;
  headline: string;
  body_content: string;
  cta_text: string;
  channel_payload: ChannelSpecificPayload;
}
```

---

#### Skill 5: `skill.mkt.audit_brand_compliance`
- **1. Skill ID**: `skill.mkt.audit_brand_compliance`
- **2. Purpose**: Evaluates draft copy against prohibited claims, brand tone guidelines, and regulatory constraints.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "draft_text", "channel"],
  "properties": {
    "tenant_id": { "type": "string" },
    "draft_text": { "type": "string" },
    "channel": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["compliant", "violations", "confidence_score"],
  "properties": {
    "compliant": { "type": "boolean" },
    "violations": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["rule_id", "severity", "snippet", "suggestion"],
        "properties": {
          "rule_id": { "type": "string" },
          "severity": { "type": "string", "enum": ["LOW", "MEDIUM", "HIGH", "BLOCKING"] },
          "snippet": { "type": "string" },
          "suggestion": { "type": "string" }
        }
      }
    },
    "confidence_score": { "type": "number", "minimum": 0, "maximum": 1 }
  }
}
```
- **5. Allowed Agents**: `["MKT-04"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `SecondBrain.BrandGuard`
- **8. Validation Rules**: `["draft_text length must be > 0 and < 10000 chars"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "non_retryable_errors": ["MALFORMED_INPUT"]}`
- **10. Timeout**: `2000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_BRAND_AUDIT", "record_latency": true}`

```typescript
export interface InputMktAuditBrand {
  tenant_id: string;
  draft_text: string;
  channel: string;
}
export interface OutputMktAuditBrand {
  compliant: boolean;
  violations: Array<{ rule_id: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING'; snippet: string; suggestion: string }>;
  confidence_score: number;
}
```

---

#### Skill 6: `skill.mkt.dispatch_campaign`
- **1. Skill ID**: `skill.mkt.dispatch_campaign`
- **2. Purpose**: Dispatches marketing broadcast to authorized segments (Enforces human approval AUTH-4).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "campaign_id", "segment_id", "channel", "approved_content_id", "approval_signature"],
  "properties": {
    "tenant_id": { "type": "string" },
    "campaign_id": { "type": "string" },
    "segment_id": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE", "WHATSAPP", "EMAIL", "SMS", "ZALO", "TIKTOK", "MESSENGER", "INSTAGRAM"] },
    "approved_content_id": { "type": "string" },
    "approval_signature": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["dispatch_id", "recipient_count", "status", "dispatched_at"],
  "properties": {
    "dispatch_id": { "type": "string" },
    "recipient_count": { "type": "integer" },
    "status": { "type": "string", "enum": ["ENQUEUED", "PROCESSING", "COMPLETED", "FAILED"] },
    "dispatched_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-05"]`
- **6. Required Authority**: `AUTH-4`
- **7. Tool Binding**: `API-003.CommunicationConnector`
- **8. Validation Rules**: `["approval_signature must be verified against approval_queue", "channel quota must be available"]`
- **9. Retry Policy**: `{"max_retries": 0, "initial_interval_ms": 0, "backoff_multiplier": 1.0, "non_retryable_errors": ["AUTH_DENIED", "CAMPAIGN_ALREADY_SENT"]}`
- **10. Timeout**: `5000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_CAMPAIGN_DISPATCH", "record_latency": true}`

```typescript
export interface InputMktDispatchCampaign {
  tenant_id: string;
  campaign_id: string;
  segment_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  approved_content_id: string;
  approval_signature: string;
}
export interface OutputMktDispatchCampaign {
  dispatch_id: string;
  recipient_count: number;
  status: 'ENQUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  dispatched_at: string;
}
```

---

#### Skill 7: `skill.mkt.evaluate_attribution`
- **1. Skill ID**: `skill.mkt.evaluate_attribution`
- **2. Purpose**: Calculates campaign conversion attribution, CAC, and ROAS.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "campaign_id", "attribution_model"],
  "properties": {
    "tenant_id": { "type": "string" },
    "campaign_id": { "type": "string" },
    "attribution_model": { "type": "string", "enum": ["FIRST_TOUCH", "LAST_TOUCH", "LINEAR", "DATA_DRIVEN"] }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["campaign_id", "attributed_revenue", "attributed_orders", "roas", "calculated_at"],
  "properties": {
    "campaign_id": { "type": "string" },
    "attributed_revenue": { "type": "number" },
    "attributed_orders": { "type": "integer" },
    "roas": { "type": "number" },
    "cac": { "type": "number" },
    "calculated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-06"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `PostgreSQL.AnalyticsStore`
- **8. Validation Rules**: `["campaign_id must exist in campaigns table"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 1000, "backoff_multiplier": 1.5, "non_retryable_errors": ["CAMPAIGN_NOT_FOUND"]}`
- **10. Timeout**: `4000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_ATTRIBUTION", "record_latency": true}`

```typescript
export interface InputMktEvaluateAttribution {
  tenant_id: string;
  campaign_id: string;
  attribution_model: 'FIRST_TOUCH' | 'LAST_TOUCH' | 'LINEAR' | 'DATA_DRIVEN';
}
export interface OutputMktEvaluateAttribution {
  campaign_id: string;
  attributed_revenue: number;
  attributed_orders: number;
  roas: number;
  cac?: number;
  calculated_at: string;
}
```

---

### 4.2. Sales Domain Skills (8 Skills)

#### Skill 8: `skill.sales.search_product`
- **1. Skill ID**: `skill.sales.search_product`
- **2. Purpose**: Performs catalog keyword, category, or semantic vector search for products.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "query"],
  "properties": {
    "tenant_id": { "type": "string" },
    "query": { "type": "string", "minLength": 1 },
    "category_id": { "type": "string" },
    "limit": { "type": "integer", "default": 5, "maximum": 20 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["products", "total_found"],
  "properties": {
    "products": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["product_id", "sku", "name", "list_price", "currency", "in_stock"],
        "properties": {
          "product_id": { "type": "string" },
          "sku": { "type": "string" },
          "name": { "type": "string" },
          "list_price": { "type": "number" },
          "currency": { "type": "string" },
          "in_stock": { "type": "boolean" }
        }
      }
    },
    "total_found": { "type": "integer" }
  }
}
```
- **5. Allowed Agents**: `["SAL-01", "SAL-02"]`
- **6. Required Authority**: `AUTH-0`
- **7. Tool Binding**: `API-001.CatalogConnector`
- **8. Validation Rules**: `["query must not contain SQL or prompt injection tokens", "limit <= 20"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "non_retryable_errors": ["MALFORMED_QUERY"]}`
- **10. Timeout**: `1500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_CATALOG_SEARCH", "record_latency": true}`

```typescript
export interface InputSalesSearchProduct {
  tenant_id: string;
  query: string;
  category_id?: string;
  limit?: number;
}
export interface OutputSalesSearchProduct {
  products: Array<{ product_id: string; sku: string; name: string; list_price: number; currency: string; in_stock: boolean }>;
  total_found: number;
}
```

---

#### Skill 9: `skill.sales.check_stock`
- **1. Skill ID**: `skill.sales.check_stock`
- **2. Purpose**: Retrieves real-time available-to-promise inventory across warehouses.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "sku_id"],
  "properties": {
    "tenant_id": { "type": "string" },
    "sku_id": { "type": "string" },
    "warehouse_id": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["sku_id", "available_quantity", "in_stock", "checked_at"],
  "properties": {
    "sku_id": { "type": "string" },
    "available_quantity": { "type": "integer", "minimum": 0 },
    "in_stock": { "type": "boolean" },
    "lead_time_days": { "type": "integer" },
    "checked_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-01", "SAL-02", "CS-01"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-001.InventoryConnector`
- **8. Validation Rules**: `["sku_id must exist in active catalog", "fail closed if WMS offline"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "non_retryable_errors": ["SKU_NOT_FOUND"]}`
- **10. Timeout**: `3000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_INVENTORY_CHECK", "record_latency": true}`

```typescript
export interface InputSalesCheckStock {
  tenant_id: string;
  sku_id: string;
  warehouse_id?: string;
}
export interface OutputSalesCheckStock {
  sku_id: string;
  available_quantity: number;
  in_stock: boolean;
  lead_time_days?: number;
  checked_at: string;
}
```

---

#### Skill 10: `skill.sales.check_price`
- **1. Skill ID**: `skill.sales.check_price`
- **2. Purpose**: Evaluates official list price, eligible tier discounts, and enforces mathematical floor price $P_{floor}$ (BR-001, BR-002).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "sku_id", "customer_id"],
  "properties": {
    "tenant_id": { "type": "string" },
    "sku_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "requested_discount_percent": { "type": "number", "minimum": 0, "maximum": 50 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["sku_id", "list_price", "final_price", "p_floor", "discount_allowed", "currency", "quote_token", "quote_expires_at"],
  "properties": {
    "sku_id": { "type": "string" },
    "list_price": { "type": "number" },
    "final_price": { "type": "number" },
    "p_floor": { "type": "number" },
    "discount_allowed": { "type": "boolean" },
    "currency": { "type": "string" },
    "quote_token": { "type": "string" },
    "quote_expires_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-001.PricingEngine`
- **8. Validation Rules**: `["final_price >= p_floor invariant must hold 100%", "customer tier must be validated", "quote_token must be HMAC-SHA256 signed with secret"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 400, "backoff_multiplier": 1.5, "non_retryable_errors": ["INVALID_SKU"]}`
- **10. Timeout**: `2000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_PRICE_CALCULATION", "record_latency": true}`

```typescript
export interface InputSalesCheckPrice {
  tenant_id: string;
  sku_id: string;
  customer_id: string;
  requested_discount_percent?: number;
}
export interface OutputSalesCheckPrice {
  sku_id: string;
  list_price: number;
  final_price: number;
  p_floor: number;
  discount_allowed: boolean;
  currency: string;
  quote_token: string;
  quote_expires_at: string;
}
```

---

#### Skill 11: `skill.sales.retrieve_customer`
- **1. Skill ID**: `skill.sales.retrieve_customer`
- **2. Purpose**: Hydrates Customer 360 profile, order history, and preferences (AUTH-0 read-only).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_identifier"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_identifier": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["customer_id", "total_orders", "lifetime_value", "verified", "rfm_segment"],
  "properties": {
    "customer_id": { "type": "string" },
    "total_orders": { "type": "integer" },
    "lifetime_value": { "type": "number" },
    "verified": { "type": "boolean" },
    "rfm_segment": { "type": "string" },
    "last_order_date": { "type": ["string", "null"] }
  }
}
```
- **5. Allowed Agents**: `["SAL-01", "SAL-02", "SAL-03", "SAL-04", "SAL-05"]`
- **6. Required Authority**: `AUTH-0`
- **7. Tool Binding**: `PostgreSQL.Customer360Store`
- **8. Validation Rules**: `["tenant isolation boundary verified by RLS"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "non_retryable_errors": ["NOT_FOUND"]}`
- **10. Timeout**: `1500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id", "customer_identifier"], "evidence_card": "EV_CUSTOMER_HYDRATION", "record_latency": true}`

```typescript
export interface InputSalesRetrieveCustomer {
  tenant_id: string;
  customer_identifier: string;
}
export interface OutputSalesRetrieveCustomer {
  customer_id: string;
  total_orders: number;
  lifetime_value: number;
  verified: boolean;
  rfm_segment: string;
  last_order_date: string | null;
}
```

---

#### Skill 12: `skill.sales.recommend_product`
- **1. Skill ID**: `skill.sales.recommend_product`
- **2. Purpose**: Generates cross-sell/upsell/substitute/bundle suggestions conforming strictly to the 7-field contract of FR-SAL-003.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "current_cart_skus"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "current_cart_skus": { "type": "array", "items": { "type": "string" } },
    "recommendation_type": { "type": "string", "enum": ["CROSS_SELL", "UPSELL", "SUBSTITUTE", "BUNDLE", "REPLENISHMENT"], "default": "CROSS_SELL" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**: (Conforms to FR-SAL-003 MUST 7 fields)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["customer", "product", "reason", "evidence", "eligibility", "confidence", "expected_outcome"],
  "properties": {
    "customer": { "type": "string" },
    "product": {
      "type": "object",
      "required": ["sku", "name", "price"],
      "properties": {
        "sku": { "type": "string" },
        "name": { "type": "string" },
        "price": { "type": "number" }
      }
    },
    "reason": { "type": "string" },
    "evidence": {
      "type": "object",
      "required": ["verified_timeline_event_ids", "verified_model"],
      "properties": {
        "verified_timeline_event_ids": { "type": "array", "items": { "type": "string" } },
        "verified_model": { "type": "string" },
        "historical_spend": { "type": "number" },
        "category_affinity": { "type": "string" }
      }
    },
    "eligibility": {
      "type": "object",
      "required": ["stock_available", "consent_verified", "suppression_cleared"],
      "properties": {
        "stock_available": { "type": "boolean" },
        "consent_verified": { "type": "boolean" },
        "suppression_cleared": { "type": "boolean" }
      }
    },
    "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
    "expected_outcome": {
      "type": "object",
      "required": ["conversion_probability", "expected_revenue", "currency"],
      "properties": {
        "conversion_probability": { "type": "number" },
        "expected_revenue": { "type": "number" },
        "currency": { "type": "string" }
      }
    }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-03"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `Core.RecommendationEngine`
- **8. Validation Rules**: `["confidence score >= 0.65 threshold required to yield recommendation", "stock eligibility must be verified", "evidence must contain at least 1 verified timeline event ID from Customer 360 (FR-C360-002)"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "non_retryable_errors": ["EMPTY_CATALOG"]}`
- **10. Timeout**: `2500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer"], "evidence_card": "EV_SALES_RECOMMENDATION", "record_latency": true}`

```typescript
export interface RecommendationEvidence {
  verified_timeline_event_ids: string[];
  verified_model: string;
  historical_spend?: number;
  category_affinity?: string;
}

export interface RecommendationEligibility {
  stock_available: boolean;
  consent_verified: boolean;
  suppression_cleared: boolean;
}

export interface InputSalesRecommendProduct {
  tenant_id: string;
  customer_id: string;
  current_cart_skus: string[];
  recommendation_type?: 'CROSS_SELL' | 'UPSELL' | 'SUBSTITUTE' | 'BUNDLE' | 'REPLENISHMENT';
}
export interface OutputSalesRecommendProduct {
  customer: string;
  product: { sku: string; name: string; price: number };
  reason: string;
  evidence: RecommendationEvidence;
  eligibility: RecommendationEligibility;
  confidence: number;
  expected_outcome: { conversion_probability: number; expected_revenue: number; currency: string };
}
```

---

#### Skill 13: `skill.sales.create_cart`
- **1. Skill ID**: `skill.sales.create_cart`
- **2. Purpose**: Creates or modifies an active shopping cart for the current session.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "session_id", "items", "idempotency_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "session_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku_id", "quantity"],
        "properties": {
          "sku_id": { "type": "string" },
          "quantity": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "idempotency_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["cart_id", "item_count", "subtotal", "currency", "updated_at"],
  "properties": {
    "cart_id": { "type": "string" },
    "item_count": { "type": "integer" },
    "subtotal": { "type": "number" },
    "currency": { "type": "string" },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-002.CommerceCartAPI`
- **8. Validation Rules**: `["items array must not be empty", "all SKUs must have available inventory"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 400, "backoff_multiplier": 1.5, "non_retryable_errors": ["OUT_OF_STOCK", "IDEMPOTENCY_CONFLICT"]}`
- **10. Timeout**: `2000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CART_MUTATION", "record_latency": true}`

```typescript
export interface InputSalesCreateCart {
  tenant_id: string;
  session_id: string;
  customer_id?: string;
  items: Array<{ sku_id: string; quantity: number }>;
  idempotency_key: string;
}
export interface OutputSalesCreateCart {
  cart_id: string;
  item_count: number;
  subtotal: number;
  currency: string;
  updated_at: string;
}
```

---

#### Skill 14: `skill.sales.create_order`
- **1. Skill ID**: `skill.sales.create_order`
- **2. Purpose**: Creates a draft or pending order in ERP with server-verified prices and cryptographic effect key.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "cart_id", "customer_id", "shipping_address", "payment_method", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "cart_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "shipping_address": { "type": "object" },
    "payment_method": { "type": "string", "enum": ["CREDIT_CARD", "CVS_COD", "LINE_PAY", "JKOPAY", "STRIPE", "PAYPAL"] },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["order_id", "order_number", "total_amount", "currency", "status", "created_at"],
  "properties": {
    "order_id": { "type": "string" },
    "order_number": { "type": "string" },
    "total_amount": { "type": "number" },
    "currency": { "type": "string" },
    "status": { "type": "string", "enum": ["DRAFT", "PENDING_PAYMENT", "CONFIRMED"] },
    "payment_url": { "type": "string" },
    "created_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04", "SAL-05"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-001.OrderConnector`
- **8. Validation Rules**: `["effect_key must be unique within 72h Redis cache", "total_amount must match pricing engine quote", "payment_method must be supported in tenant country"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "non_retryable_errors": ["ORDER_ALREADY_EXISTS", "PAYMENT_REJECTED"]}`
- **10. Timeout**: `4000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id", "shipping_address"], "evidence_card": "EV_ORDER_CREATION", "record_latency": true}`

```typescript
export interface InputSalesCreateOrder {
  tenant_id: string;
  cart_id: string;
  customer_id: string;
  shipping_address: Record<string, unknown>;
  payment_method: 'CREDIT_CARD' | 'CVS_COD' | 'LINE_PAY' | 'JKOPAY' | 'STRIPE' | 'PAYPAL';
  effect_key: string;
}
export interface OutputSalesCreateOrder {
  order_id: string;
  order_number: string;
  total_amount: number;
  currency: string;
  status: 'DRAFT' | 'PENDING_PAYMENT' | 'CONFIRMED';
  payment_url?: string;
  created_at: string;
}
```

---

#### Skill 15: `skill.sales.send_message`
- **1. Skill ID**: `skill.sales.send_message`
- **2. Purpose**: Dispatches personalized consultation or cart recovery message via target channel.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "recipient_id", "channel", "message_content", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "recipient_id": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE", "WHATSAPP", "WEB_CHAT", "SMS", "ZALO", "TIKTOK", "MESSENGER", "INSTAGRAM"] },
    "message_content": {
      "type": "object",
      "required": ["text"],
      "properties": {
        "text": { "type": "string" },
        "quick_replies": { "type": "array", "items": { "type": "string" } },
        "template_id": { "type": "string" },
        "template_params": { "type": "object", "additionalProperties": { "type": "string" } },
        "card": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" },
            "image_url": { "type": "string" },
            "action_url": { "type": "string" }
          }
        }
      }
    },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["message_id", "provider_reference", "delivered_at"],
  "properties": {
    "message_id": { "type": "string" },
    "provider_reference": { "type": "string" },
    "delivered_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04", "SAL-05"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-003.CommunicationConnector`
- **8. Validation Rules**: `["recipient must have active consent", "session mutex lock must not be held by human"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 2.0, "non_retryable_errors": ["BLOCKED_BY_USER", "SESSION_EXPIRED"]}`
- **10. Timeout**: `3000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["recipient_id"], "evidence_card": "EV_OUTBOUND_MESSAGE", "record_latency": true}`

```typescript
export interface OutboundMessagePayload {
  text: string;
  quick_replies?: string[];
  template_id?: string;
  template_params?: Record<string, string>;
  card?: { title: string; description: string; image_url?: string; action_url?: string };
}

export interface InputSalesSendMessage {
  tenant_id: string;
  recipient_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'WEB_CHAT' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  message_content: OutboundMessagePayload;
  effect_key: string;
}
export interface OutputSalesSendMessage {
  message_id: string;
  provider_reference: string;
  delivered_at: string;
}
```

---

### 4.3. Customer Care & Retention Domain Skills (8 Skills)

#### Skill 16: `skill.care.search_faq`
- **1. Skill ID**: `skill.care.search_faq`
- **2. Purpose**: Queries approved Second Brain knowledge base (`/customer-care/faq.md`) for verified resolutions.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "query_text"],
  "properties": {
    "tenant_id": { "type": "string" },
    "query_text": { "type": "string", "minLength": 1 },
    "top_k": { "type": "integer", "default": 3, "maximum": 5 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["answers", "match_confidence"],
  "properties": {
    "answers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["faq_id", "question", "approved_answer", "source_file"],
        "properties": {
          "faq_id": { "type": "string" },
          "question": { "type": "string" },
          "approved_answer": { "type": "string" },
          "source_file": { "type": "string" }
        }
      }
    },
    "match_confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `SecondBrain.FAQEngine`
- **8. Validation Rules**: `["answers must be sourced exclusively from approved Second Brain documents"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "non_retryable_errors": ["CORPUS_UNAVAILABLE"]}`
- **10. Timeout**: `1500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_FAQ_QUERY", "record_latency": true}`

```typescript
export interface InputCareSearchFAQ {
  tenant_id: string;
  query_text: string;
  top_k?: number;
}
export interface OutputCareSearchFAQ {
  answers: Array<{ faq_id: string; question: string; approved_answer: string; source_file: string }>;
  match_confidence: number;
}
```

---

#### Skill 17: `skill.care.lookup_order`
- **1. Skill ID**: `skill.care.lookup_order`
- **2. Purpose**: Looks up order history, fulfillment status, and items for customer support inquiries.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "order_identifier"],
  "properties": {
    "tenant_id": { "type": "string" },
    "order_identifier": { "type": "string" },
    "verified_phone": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["order_id", "status", "line_items", "total_price", "currency", "order_date"],
  "properties": {
    "order_id": { "type": "string" },
    "status": { "type": "string", "enum": ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"] },
    "line_items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku_id", "product_name", "quantity", "unit_price", "currency"],
        "properties": {
          "sku_id": { "type": "string" },
          "product_name": { "type": "string" },
          "quantity": { "type": "integer" },
          "unit_price": { "type": "number" },
          "currency": { "type": "string" }
        }
      }
    },
    "total_price": { "type": "number" },
    "currency": { "type": "string" },
    "tracking_number": { "type": ["string", "null"] },
    "order_date": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-001.OrderConnector`
- **8. Validation Rules**: `["caller session customer_id must match order owner unless phone is verified"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 400, "backoff_multiplier": 1.5, "non_retryable_errors": ["ORDER_NOT_FOUND"]}`
- **10. Timeout**: `2000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["verified_phone"], "evidence_card": "EV_ORDER_LOOKUP", "record_latency": true}`

```typescript
export interface OrderLineItemRecord {
  sku_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  currency: string;
}

export interface InputCareLookupOrder {
  tenant_id: string;
  order_identifier: string;
  verified_phone?: string;
}
export interface OutputCareLookupOrder {
  order_id: string;
  status: 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';
  line_items: OrderLineItemRecord[];
  total_price: number;
  currency: string;
  tracking_number: string | null;
  order_date: string;
}
```

---

#### Skill 18: `skill.care.track_shipping`
- **1. Skill ID**: `skill.care.track_shipping`
- **2. Purpose**: Tracks live carrier status (Black Cat, HCT, 7-Eleven / FamilyMart CVS logistics via ADPT-TW-001).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "tracking_number", "carrier"],
  "properties": {
    "tenant_id": { "type": "string" },
    "tracking_number": { "type": "string" },
    "carrier": { "type": "string", "enum": ["BLACK_CAT", "HCT", "SEVEN_ELEVEN_CVS", "FAMILY_MART_CVS", "FEDEX", "DHL"] }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tracking_number", "carrier", "shipping_status", "events"],
  "properties": {
    "tracking_number": { "type": "string" },
    "carrier": { "type": "string" },
    "shipping_status": { "type": "string", "enum": ["PICKED_UP", "IN_TRANSIT", "AT_CVS_STORE", "DELIVERED", "RETURNED"] },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["status_text", "location", "timestamp"],
        "properties": {
          "status_text": { "type": "string" },
          "location": { "type": "string" },
          "timestamp": { "type": "string", "format": "date-time" }
        }
      }
    }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `ADPT-TW-001.LogisticsConnector`
- **8. Validation Rules**: `["tracking_number must match carrier checksum rules"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "non_retryable_errors": ["CARRIER_TRACKING_NOT_FOUND"]}`
- **10. Timeout**: `2500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_SHIPPING_TRACK", "record_latency": true}`

```typescript
export interface InputCareTrackShipping {
  tenant_id: string;
  tracking_number: string;
  carrier: 'BLACK_CAT' | 'HCT' | 'SEVEN_ELEVEN_CVS' | 'FAMILY_MART_CVS' | 'FEDEX' | 'DHL';
}
export interface OutputCareTrackShipping {
  tracking_number: string;
  carrier: string;
  shipping_status: 'PICKED_UP' | 'IN_TRANSIT' | 'AT_CVS_STORE' | 'DELIVERED' | 'RETURNED';
  events: Array<{ status_text: string; location: string; timestamp: string }>;
}
```

---

#### Skill 19: `skill.care.manage_case`
- **1. Skill ID**: `skill.care.manage_case`
- **2. Purpose**: Creates, transitions, and persists Customer Support support cases following Section 8 SRS v0.1 8-state FSM.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "intent", "priority", "conversation_id", "action_type"],
  "properties": {
    "tenant_id": { "type": "string" },
    "case_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "intent": { "type": "string" },
    "priority": { "type": "string", "enum": ["P1", "P2", "P3", "P4"] },
    "conversation_id": { "type": "string" },
    "related_order_id": { "type": ["string", "null"] },
    "evidence_refs": { "type": "array", "items": { "type": "string" } },
    "action_type": { "type": "string", "enum": ["CREATE", "TRANSITION_STATE", "ASSIGN", "RESOLVE", "REOPEN", "CLOSE"] },
    "target_status": { "type": "string", "enum": ["NEW", "CLASSIFIED", "ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED", "REOPENED"] },
    "assigned_owner": { "type": ["string", "null"] },
    "notes": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": [
    "case_id",
    "customer_id",
    "intent",
    "priority",
    "status",
    "conversation_id",
    "related_order_id",
    "evidence_refs",
    "assigned_owner",
    "sla_target_hours",
    "updated_at"
  ],
  "properties": {
    "case_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "intent": { "type": "string" },
    "priority": { "type": "string", "enum": ["P1", "P2", "P3", "P4"] },
    "status": {
      "type": "string",
      "enum": ["NEW", "CLASSIFIED", "ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED", "REOPENED"]
    },
    "conversation_id": { "type": "string" },
    "related_order_id": { "type": ["string", "null"] },
    "evidence_refs": { "type": "array", "items": { "type": "string" } },
    "assigned_owner": { "type": ["string", "null"] },
    "sla_target_hours": { "type": "integer" },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `PostgreSQL.CaseManagementStore`
- **8. Validation Rules**: `["if action_type is TRANSITION_STATE/ASSIGN/RESOLVE, case_id is mandatory", "status transitions must strictly follow SRS Section 8 FSM matrix"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "non_retryable_errors": ["CASE_NOT_FOUND", "INVALID_FSM_TRANSITION"]}`
- **10. Timeout**: `2000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_SUPPORT_CASE", "record_latency": true}`

```typescript
export interface InputCareManageCase {
  tenant_id: string;
  case_id?: string;
  customer_id: string;
  intent: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  conversation_id: string;
  related_order_id?: string | null;
  evidence_refs?: string[];
  action_type: 'CREATE' | 'TRANSITION_STATE' | 'ASSIGN' | 'RESOLVE' | 'REOPEN' | 'CLOSE';
  target_status?: 'NEW' | 'CLASSIFIED' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED' | 'REOPENED';
  assigned_owner?: string | null;
  notes?: string;
}

export interface OutputCareManageCase {
  case_id: string;
  customer_id: string;
  intent: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  status: 'NEW' | 'CLASSIFIED' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED' | 'REOPENED';
  conversation_id: string;
  related_order_id: string | null;
  evidence_refs: string[];
  assigned_owner: string | null;
  sla_target_hours: number;
  updated_at: string;
}
```

---

#### Skill 20: `skill.care.initiate_return`
- **1. Skill ID**: `skill.care.initiate_return`
- **2. Purpose**: Generates reverse logistics return authorization (RMA) requiring human approval (AUTH-4) for refunds.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "order_id", "sku_id", "return_reason", "evidence_images", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "order_id": { "type": "string" },
    "sku_id": { "type": "string" },
    "return_reason": { "type": "string" },
    "evidence_images": { "type": "array", "items": { "type": "string" } },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["rma_number", "status", "return_shipping_label_url", "initiated_at"],
  "properties": {
    "rma_number": { "type": "string" },
    "status": { "type": "string", "enum": ["AWAITING_APPROVAL", "APPROVED", "REJECTED"] },
    "return_shipping_label_url": { "type": ["string", "null"] },
    "initiated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-4`
- **7. Tool Binding**: `ADPT-TW-001.ReverseLogistics`
- **8. Validation Rules**: `["order must be within return window (e.g. 7 days for TW)", "must be approved in SCR-003"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "non_retryable_errors": ["RETURN_WINDOW_EXPIRED"]}`
- **10. Timeout**: `3500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["evidence_images"], "evidence_card": "EV_RMA_INITIATION", "record_latency": true}`

```typescript
export interface InputCareInitiateReturn {
  tenant_id: string;
  order_id: string;
  sku_id: string;
  return_reason: string;
  evidence_images: string[];
  effect_key: string;
}
export interface OutputCareInitiateReturn {
  rma_number: string;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
  return_shipping_label_url: string | null;
  initiated_at: string;
}
```

---

#### Skill 21: `skill.care.escalate_to_human`
- **1. Skill ID**: `skill.care.escalate_to_human`
- **2. Purpose**: Triggers human handoff (`SCR-005`), releasing bot control and transferring context to human inbox.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "session_id", "conversation_id", "escalation_reason"],
  "properties": {
    "tenant_id": { "type": "string" },
    "session_id": { "type": "string" },
    "conversation_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "escalation_reason": { "type": "string" },
    "summary_context": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["handoff_id", "queue_position", "status", "escalated_at"],
  "properties": {
    "handoff_id": { "type": "string" },
    "queue_position": { "type": "integer" },
    "status": { "type": "string", "enum": ["ENQUEUED", "ASSIGNED"] },
    "escalated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01", "CS-02"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `Orchestrator.HandoffBus`
- **8. Validation Rules**: `["locks bot session mutex immediately", "session state set to awaiting_human"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "non_retryable_errors": ["QUEUE_DOWN"]}`
- **10. Timeout**: `1000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_HUMAN_HANDOFF", "record_latency": true}`

```typescript
export interface InputCareEscalateHuman {
  tenant_id: string;
  session_id: string;
  conversation_id: string;
  customer_id?: string;
  escalation_reason: string;
  summary_context?: string;
}
export interface OutputCareEscalateHuman {
  handoff_id: string;
  queue_position: number;
  status: 'ENQUEUED' | 'ASSIGNED';
  escalated_at: string;
}
```

---

#### Skill 22: `skill.care.analyze_churn_risk`
- **1. Skill ID**: `skill.care.analyze_churn_risk`
- **2. Purpose**: Evaluates customer sentiment and inactivity frequency to score churn risk (Tagged strictly as HYPOTHESIS).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "recent_message_snippets": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["customer_id", "churn_probability", "risk_tier", "primary_risk_factors", "classification"],
  "properties": {
    "customer_id": { "type": "string" },
    "churn_probability": { "type": "number", "minimum": 0, "maximum": 1 },
    "risk_tier": { "type": "string", "enum": ["LOW", "MODERATE", "HIGH", "CRITICAL"] },
    "primary_risk_factors": { "type": "array", "items": { "type": "string" } },
    "classification": { "type": "string", "const": "HYPOTHESIS" }
  }
}
```
- **5. Allowed Agents**: `["CS-02"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `Customer360.AnalyticsLayer`
- **8. Validation Rules**: `["result MUST be tagged with classification: HYPOTHESIS", "cannot overwrite FACT"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "non_retryable_errors": ["MODEL_OFFLINE"]}`
- **10. Timeout**: `2500ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CHURN_ANALYSIS", "record_latency": true}`

```typescript
export interface InputCareAnalyzeChurnRisk {
  tenant_id: string;
  customer_id: string;
  recent_message_snippets?: string[];
}
export interface OutputCareAnalyzeChurnRisk {
  customer_id: string;
  churn_probability: number;
  risk_tier: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  primary_risk_factors: string[];
  classification: 'HYPOTHESIS';
}
```

---

#### Skill 23: `skill.care.issue_retention_offer`
- **1. Skill ID**: `skill.care.issue_retention_offer`
- **2. Purpose**: Generates automated retention voucher within authorized tenant budget, or issues 14-day price protection compensation (ECN-004).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "offer_scenario", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "offer_scenario": { "type": "string", "enum": ["CART_RETENTION_VOUCHER", "PRICE_PROTECTION_14D_ECN_004"] },
    "target_cart_id": { "type": "string" },
    "max_discount_value": { "type": "number", "minimum": 1 },
    "price_protection_details": {
      "type": "object",
      "required": ["original_order_id", "eligible_sku", "historical_price", "new_price"],
      "properties": {
        "original_order_id": { "type": "string" },
        "eligible_sku": { "type": "string" },
        "historical_price": { "type": "number" },
        "new_price": { "type": "number" }
      }
    },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["offer_id", "offer_scenario", "voucher_code", "compensation_amount", "currency", "expires_at", "effect_key"],
  "properties": {
    "offer_id": { "type": "string" },
    "offer_scenario": { "type": "string", "enum": ["CART_RETENTION_VOUCHER", "PRICE_PROTECTION_14D_ECN_004"] },
    "voucher_code": { "type": "string" },
    "compensation_amount": { "type": "number" },
    "price_protection_payout": {
      "type": "object",
      "properties": {
        "original_order_id": { "type": "string" },
        "eligible_sku": { "type": "string" },
        "price_difference": { "type": "number" },
        "payout_method": { "type": "string", "enum": ["STORE_CREDIT", "REFUND_TO_CARD", "COMPENSATION_VOUCHER"] }
      }
    },
    "currency": { "type": "string" },
    "expires_at": { "type": "string", "format": "date-time" },
    "effect_key": { "type": "string" }
  }
}
```
- **5. Allowed Agents**: `["CS-02"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `PromotionEngine.FloorPriceGuard`
- **8. Validation Rules**: `["voucher must not reduce cart subtotal below P_floor (BR-001, BR-002)", "customer cannot receive > 1 retention offer per 30 days", "for PRICE_PROTECTION_14D_ECN_004 original_order_id must be within 14 days and historical_price > new_price"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "non_retryable_errors": ["RETENTION_QUOTA_EXCEEDED", "P_FLOOR_BREACH", "ORDER_OUTSIDE_14D_WINDOW"]}`
- **10. Timeout**: `3000ms`
- **11. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_RETENTION_VOUCHER", "record_latency": true}`

```typescript
export interface PriceProtectionDetails {
  original_order_id: string;
  eligible_sku: string;
  historical_price: number;
  new_price: number;
}

export interface InputCareIssueRetentionOffer {
  tenant_id: string;
  customer_id: string;
  offer_scenario: 'CART_RETENTION_VOUCHER' | 'PRICE_PROTECTION_14D_ECN_004';
  target_cart_id?: string;
  max_discount_value?: number;
  price_protection_details?: PriceProtectionDetails;
  effect_key: string;
}

export interface OutputCareIssueRetentionOffer {
  offer_id: string;
  offer_scenario: 'CART_RETENTION_VOUCHER' | 'PRICE_PROTECTION_14D_ECN_004';
  voucher_code: string;
  compensation_amount: number;
  price_protection_payout?: {
    original_order_id: string;
    eligible_sku: string;
    price_difference: number;
    payout_method: 'STORE_CREDIT' | 'REFUND_TO_CARD' | 'COMPENSATION_VOUCHER';
  };
  currency: string;
  expires_at: string;
  effect_key: string;
}
```

---

## 5. Automated Test Suite Matrix for Skills

Every skill must pass the 5-point test matrix:

| Test ID | Test Category | Scenario Description | Expected Outcome |
|---|---|---|---|
| `TC-SKILL-01` | Happy Path | Valid input payload and authorized agent. | Successful execution within SLA; valid output schema. |
| `TC-SKILL-02` | Authority Violation | Agent lacks required clearance (e.g. `AUTH-1` agent calls `AUTH-4` skill). | Throws `INSUFFICIENT_AUTHORITY`; zero side effects. |
| `TC-SKILL-03` | Schema Invalidation | Input missing mandatory fields or containing illegal extra properties. | Throws `SCHEMA_VALIDATION_ERROR` prior to tool dispatch. |
| `TC-SKILL-04` | Timeout Escalation | Downstream adapter hangs past `timeout_ms`. | AbortController aborts; throws `TIMEOUT`; records circuit failure. |
| `TC-SKILL-05` | Idempotency Verification| Submitting request twice with identical `effect_key`. | Second request receives cached result without duplicate side effects. |
