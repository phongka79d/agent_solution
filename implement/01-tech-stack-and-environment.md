# Tech Stack & Environment Specification

## 1. Architectural Justification Matrix (NFR-001 through NFR-010)

The selection of every framework, database, cache, and runtime component within the AI Revenue & Engagement Platform is directly derived from the 10 core Non-Functional Requirements (NFR-001..NFR-010) defined in Section 19 of the Software Requirements Specification (AI-REV-SRS-001).

| NFR Identifier | Requirement Name & Requirement Mandate | Technical Choice | Architectural Justification & Implementation Mechanism |
|---|---|---|---|
| **NFR-001** | **Security & Authority Boundaries** (MUST)<br>Strict containment within assigned authority level (`AUTH-0` to `AUTH-3`). Prompt injection defense (BR-009). Server-side deny by default. | **Node.js (TypeScript 5.x) & Python (FastAPI)** with static type enforcement and AST schema validators. | LLM outputs are never directly executed. Responses are validated against strict Zod/Pydantic schemas. Tool invocations pass through an independent, deterministic Policy Engine running outside the LLM context. Unrecognized tokens or privilege escalation attempts trigger an immediate `DENY` before dispatch. |
| **NFR-002** | **Auditability** (MUST)<br>100% of external actions and approval decisions must generate an immutable Evidence Record with `run_id`, `tenant_id`, timestamp, latency, token consumption, cost, and agent/operator ID. | **PostgreSQL 16 (Append-Only Tables)** + **OpenTelemetry Span Context** | Every skill invocation and state transition creates an immutable record in `evidences` and `executions` tables. Postgres write-ahead logs (WAL) ensure transaction durability. OpenTelemetry `correlation_id` propagates through all distributed services, connecting client events to backend database writes. |
| **NFR-003** | **Idempotency** (MUST)<br>External mutations and outgoing messages must carry an `effect_key`. Replays must not duplicate orders, financial transactions, or messages. | **Redis 7.2 (SET NX EX)** + **PostgreSQL Unique Constraints** | Distributed 72-hour idempotency cache in Redis (`tenant:{id}:effect:{effect_key}`) with atomic `SET NX EX 259200`. Secondary permanent deduplication enforced in PostgreSQL via `UNIQUE (tenant_id, effect_key)` on the `executions` table. Divergent payloads with identical keys trigger `IDEMPOTENCY_CONFLICT`. |
| **NFR-004** | **Availability & Auto-Recovery**<br>Durable workflows with finite exponential backoff, circuit breaking, timeouts, and state checkpointing. | **Temporal.io / BullMQ 5.x** backed by Redis & PostgreSQL | Multi-step workflows (e.g., Abandoned Cart Recovery, Campaign Dispatch, Escalation Routing) are persisted as durable state machines. If a worker process crashes, Temporal/BullMQ resumes execution from the exact last verified step without repeating prior side effects. |
| **NFR-005** | **Explainability & Transparency**<br>100% of qualification scores, recommendations, discounts, and routing decisions must store a logic `reason` and verified `evidence`. | **PostgreSQL JSONB Evidence Contracts** | Recommendations and lead evaluations strictly enforce the 7 mandatory fields (FR-SAL-003) and 5-tier evidence separation (FR-C360-003: `FACT`, `SIGNAL`, `HYPOTHESIS`, `DECISION`, `ACTION`). Inferences (`HYPOTHESIS`) are prevented from corrupting ground-truth records (`FACT`). |
| **NFR-006** | **Multi-Tenant Data Isolation** (MUST)<br>Zero data leakage across tenants in DB, Vector DB, Cache, or Runtime Memory. | **PostgreSQL Row-Level Security (RLS)**, **Qdrant Namespaces / Collections**, **Tenant-Prefixed Redis Keys** | PostgreSQL enforces RLS on all 28 canonical tables using `tenant_id = current_setting('app.current_tenant_id')`. Qdrant enforces tenant-filtered payloads on vector searches. Redis isolates all cache and lock keys under `tenant:{tenant_id}:*`. Queries lacking tenant context are rejected at the data gateway. |
| **NFR-007** | **Human Override**<br>Operators must be able to Pause, Cancel, Modify pending actions (SCR-003) and Take Over live chat sessions (SCR-005) instantly. | **Next.js 14 (App Router) + Server-Sent Events (SSE) / WebSockets** + **Redis Pub/Sub** | Command Center operators hold hard override locks. Invoking `takeover` acquires a Redis session lock (`tenant:{id}:session:{session_id}:takeover_lock`), instantly pausing the AI agent and routing subsequent channel messages directly to the human agent's WebSocket feed. |
| **NFR-008** | **Failure Safety — Fail Closed** (MUST)<br>Missing price, unverified inventory, authority doubt, or absent consent must halt execution and route to human support. | **Deterministic Guardrail Middleware (Core Engine)** | Pre-execution skill filters run prior to any external call. If API-001 fails to return authoritative price or inventory, or if consent validation returns `false` (BR-004), the pipeline halts with `FAIL_CLOSED`, logs an audit warning, and notifies the supervisor queue. |
| **NFR-009** | **Performance & Latency**<br>Conversational response p95 < 1.5s. Lightweight Storefront Widget (< 20 KB) with zero host DOM interference. | **Vanilla TypeScript Web Component (Shadow DOM)** + **FastAPI / Node.js Streaming Responses** | The Storefront Widget is compiled without external libraries (no React/Vue runtime), achieving a gzipped bundle size < 18 KB. Streaming responses use Server-Sent Events (SSE) to display initial tokens within 350ms, while background orchestrations run asynchronously in workers. |
| **NFR-010** | **Cost Observability** (MUST)<br>Real-time calculation of token usage (input, output, cached), LLM model costs, and adapter API fees. Aggregation to cost-per-run and cost-per-customer. | **Prometheus Metrics** + **PostgreSQL Cost Aggregation Tables** | Every LLM call wrapper extracts token usage from provider response metadata, applies per-model pricing matrices, and records exact micro-dollar costs in the `executions` record. Data is aggregated hourly for display on executive dashboards SCR-001 and SCR-002. |

---

## 2. Docker Compose Local Development Environment

The local development environment replicates all production backing services using containerized images. It provisions PostgreSQL 16 with the `pgvector` extension, Redis 7.2 in standalone persistence mode, Qdrant Vector Search Engine, and a dedicated Mock ERP / Commerce API service that simulates API-001 (ERP/OMS) and API-002 (Event Ingestion).

### docker-compose.yml

```yaml
version: '3.8'

services:
  # ---------------------------------------------------------------------------
  # 1. Primary Relational Database: PostgreSQL 16 with pgvector & RLS support
  # ---------------------------------------------------------------------------
  postgres:
    image: pgvector/pgvector:pg16
    container_name: agentos-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: agentos_dev
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres_dev_secret_password
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d agentos_dev"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - agentos-network

  # ---------------------------------------------------------------------------
  # 2. In-Memory Cache, Session Mutex & Idempotency Store: Redis 7.2
  # ---------------------------------------------------------------------------
  redis:
    image: redis:7.2-alpine
    container_name: agentos-redis
    restart: unless-stopped
    command: >
      redis-server
      --requirepass redis_dev_secret_password
      --maxmemory 512mb
      --maxmemory-policy volatile-lru
      --appendonly yes
      --appendfsync everysec
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "redis_dev_secret_password", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - agentos-network

  # ---------------------------------------------------------------------------
  # 3. Vector Database for Second Brain Knowledge Base: Qdrant
  # ---------------------------------------------------------------------------
  qdrant:
    image: qdrant/qdrant:v1.9.2
    container_name: agentos-qdrant
    restart: unless-stopped
    ports:
      - "6333:6333" # REST API
      - "6334:6334" # gRPC API
    environment:
      QDRANT__SERVICE__HTTP_PORT: 6333
      QDRANT__SERVICE__GRPC_PORT: 6334
      QDRANT__SERVICE__ENABLE_CORS: "true"
      QDRANT__SERVICE__API_KEY: qdrant_dev_secret_api_key
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD-SHELL", "bash -c '</dev/tcp/localhost/6333'"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - agentos-network

  # ---------------------------------------------------------------------------
  # 4. Mock ERP & Commerce Service: Implements API-001 & API-002 Contracts
  # ---------------------------------------------------------------------------
  mock-erp:
    build:
      context: ./services/mock-erp
      dockerfile: Dockerfile
    container_name: agentos-mock-erp
    restart: unless-stopped
    ports:
      - "8081:8081"
    environment:
      PORT: 8081
      MOCK_SECRET_KEY: mock_erp_hmac_secret_key
      SIMULATE_LATENCY_MS: 50
      SIMULATE_FAILURE_RATE: 0.0
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:8081/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - agentos-network

  # ---------------------------------------------------------------------------
  # 5. Temporal Orchestration Server (Optional for Local Durable Workflows)
  # ---------------------------------------------------------------------------
  temporal:
    image: temporalio/auto-setup:1.23.0
    container_name: agentos-temporal
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=postgres
      - POSTGRES_PWD=postgres_dev_secret_password
      - POSTGRES_SEEDS=postgres
      - DYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/development-sql.yaml
    ports:
      - "7233:7233"
    networks:
      - agentos-network

  temporal-ui:
    image: temporalio/ui:2.26.2
    container_name: agentos-temporal-ui
    restart: unless-stopped
    depends_on:
      - temporal
    environment:
      - TEMPORAL_ADDRESS=temporal:7233
      - TEMPORAL_CORS_ORIGINS=http://localhost:3000
    ports:
      - "8080:8080"
    networks:
      - agentos-network

  # ---------------------------------------------------------------------------
  # 6. Core API Gateway Service: Fastify / Node.js
  # ---------------------------------------------------------------------------
  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.api
    container_name: agentos-api
    restart: unless-stopped
    ports:
      - "4000:4000"
    environment:
      NODE_ENV: development
      PORT: 4000
      DATABASE_URL: postgresql://agentos_app:agentos_app_password@postgres:5432/agentos_dev?schema=agentos
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: redis_dev_secret_password
      QDRANT_URL: http://qdrant:6333
      QDRANT_API_KEY: qdrant_dev_secret_api_key
      ERP_API_BASE_URL: http://mock-erp:8081/api/v1
      JWT_SECRET: super_secret_jwt_encryption_key_min_32_characters_long
      INTERNAL_API_KEY: agentos_internal_service_mesh_key_64_characters_min
      WEBHOOK_HMAC_SECRET: hmac_signature_validation_secret_for_external_webhooks
      ENCRYPTION_KEY_AES256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      OPENAI_API_KEY: ${OPENAI_API_KEY:-mock-key}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      qdrant:
        condition: service_healthy
      mock-erp:
        condition: service_healthy
    networks:
      - agentos-network

  # ---------------------------------------------------------------------------
  # 7. Asynchronous Workflow Worker: Temporal / BullMQ
  # ---------------------------------------------------------------------------
  worker:
    build:
      context: .
      dockerfile: docker/Dockerfile.worker
    container_name: agentos-worker
    restart: unless-stopped
    environment:
      NODE_ENV: development
      DATABASE_URL: postgresql://agentos_app:agentos_app_password@postgres:5432/agentos_dev?schema=agentos
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: redis_dev_secret_password
      TEMPORAL_ADDRESS: temporal:7233
      QDRANT_URL: http://qdrant:6333
      QDRANT_API_KEY: qdrant_dev_secret_api_key
      ERP_API_BASE_URL: http://mock-erp:8081/api/v1
      OPENAI_API_KEY: ${OPENAI_API_KEY:-mock-key}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      temporal:
        condition: service_started
    networks:
      - agentos-network

  # ---------------------------------------------------------------------------
  # 8. Administrative Command Center Dashboard: Next.js 14
  # ---------------------------------------------------------------------------
  command-center:
    build:
      context: .
      dockerfile: docker/Dockerfile.command-center
    container_name: agentos-command-center
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: development
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: super_secret_jwt_encryption_key_min_32_characters_long
      NEXT_PUBLIC_API_URL: http://localhost:4000
      DATABASE_URL: postgresql://agentos_app:agentos_app_password@postgres:5432/agentos_dev?schema=agentos
    depends_on:
      - api
    networks:
      - agentos-network

volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
  qdrant_data:
    driver: local

networks:
  agentos-network:
    driver: bridge
```

### PostgreSQL Initialization Script (`docker/postgres/init.sql`)

```sql
-- Create required database extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Create application schema and tenant context functions
CREATE SCHEMA IF NOT EXISTS agentos;

-- Create application operational roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    CREATE ROLE agentos_app WITH LOGIN PASSWORD 'agentos_app_password' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'agentos_migrator') THEN
    CREATE ROLE agentos_migrator WITH LOGIN PASSWORD 'agentos_migrator_password' BYPASSRLS;
  END IF;
END $$;

GRANT ALL PRIVILEGES ON SCHEMA agentos TO agentos_migrator;
GRANT USAGE ON SCHEMA agentos TO agentos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agentos GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agentos GRANT USAGE, SELECT ON SEQUENCES TO agentos_app;

-- Helper function to retrieve active tenant from session variable
CREATE OR REPLACE FUNCTION agentos.current_tenant_id() 
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;
```

---

## 2.2. Staging & Production Infrastructure Topology

In staging and production environments, the platform transitions from standalone containers to high-availability managed infrastructure enforcing connection pooling, strict TLS, and read/write splitting.

```text
                                 [ Ingress / ALB ]
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
         [ apps/api (Node) ]                            [ apps/worker (Temporal) ]
                 │                                               │
                 └───────────────────────┬───────────────────────┘
                                         ▼
                             [ PgBouncer Connection Pooler ]
                             (Transaction Pooling, Port 6432)
                                         │
                     ┌───────────────────┴───────────────────┐
                     ▼ (Write / Transactional Read)          ▼ (Async Read Replica)
             [ AWS RDS PostgreSQL ]                  [ AWS RDS Read Replica ]
             Primary Multi-AZ (Sync)                 (Analytics & Vectors)
```

### 1. PgBouncer Connection Pooling Specification

To support thousands of concurrent chat sessions and webhook dispatches without exhausting PostgreSQL process limits, PgBouncer is deployed as an intermediary pooler:

```ini
[databases]
agentos = host=rds-primary.internal port=5432 dbname=agentos_prod pool_mode=transaction

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 50
reserve_pool_size = 10
reserve_pool_timeout = 5.0
server_idle_timeout = 60.0
server_lifetime = 3600.0
server_connect_timeout = 5.0
```

> **Critical RLS Invariant**: When running in `pool_mode = transaction`, PostgreSQL session variables set via `SET LOCAL app.current_tenant_id = '...'` remain strictly bound to the immediate transaction block (`BEGIN ... COMMIT / ROLLBACK`). When the transaction completes, the connection returned to the pool is automatically wiped clean, guaranteeing zero cross-tenant session bleeding.

### 2. Strict SSL / TLS 1.3 Transport Security

All database connections outside the local loopback must enforce strict certificate validation:

```text
DATABASE_URL=postgresql://agentos_app:PASSWORD@pgbouncer.internal:6432/agentos?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-ca-2024.pem&schema=agentos
```

### 3. Read/Write Replication & URL Topology

| Connection URL | Target Host & Topology | Permitted Operations | Latency SLA |
|---|---|---|---|
| `POSTGRES_PRIMARY_URL` | RDS Primary Multi-AZ (Active-Standby synchronous failover, RPO = 0, RTO < 30s) | INSERT, UPDATE, DELETE, and immediate transactional SELECT queries. | < 5ms p95 |
| `POSTGRES_REPLICA_URL` | RDS Read Replica (Asynchronous streaming replication, lag < 100ms) | Analytical read-only workloads: SCR-001 Executive Dashboard, SCR-002 Reports, segment batch evaluation. | < 10ms p95 |

---

## 3. Configuration & Environment Variables Specification

The system enforces strict schema validation at application boot time using Zod (TypeScript) and Pydantic (Python). If any mandatory variable is absent or improperly formatted, the server **fails closed** immediately and refuses to start.

### `.env.example`

```bash
# =============================================================================
# 1. RUNTIME & SYSTEM
# =============================================================================
NODE_ENV=development
APP_ENV=local
PORT=4000
API_BASE_URL=http://localhost:4000
WEB_BASE_URL=http://localhost:3000
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8080
LOG_LEVEL=debug
SERVICE_NAME=agentos-api

# =============================================================================
# 2. SECURITY & AUTHENTICATION (NFR-001, NFR-006)
# =============================================================================
JWT_SECRET=super_secret_jwt_encryption_key_min_32_characters_long
JWT_EXPIRES_IN=24h
INTERNAL_API_KEY=agentos_internal_service_mesh_key_64_characters_min
WEBHOOK_HMAC_SECRET=hmac_signature_validation_secret_for_external_webhooks
ENCRYPTION_KEY_AES256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# =============================================================================
# 3. RELATIONAL DATABASE (POSTGRESQL 16)
# =============================================================================
DATABASE_URL=postgresql://agentos_app:agentos_app_password@localhost:5432/agentos_dev?schema=agentos
DATABASE_POOL_MIN=5
DATABASE_POOL_MAX=20
DATABASE_STATEMENT_TIMEOUT_MS=10000

# =============================================================================
# 4. CACHE, MUTEX & WORKFLOW QUEUE (REDIS 7.2 / TEMPORAL)
# =============================================================================
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=redis_dev_secret_password
REDIS_DB=0
REDIS_KEY_PREFIX=agentos:
SESSION_MUTEX_TTL_SECONDS=30
IDEMPOTENCY_TTL_SECONDS=259200
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default

# =============================================================================
# 5. VECTOR DATABASE (QDRANT / SECOND BRAIN)
# =============================================================================
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=qdrant_dev_secret_api_key
EMBEDDING_MODEL_PROVIDER=openai
EMBEDDING_MODEL_NAME=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536

# =============================================================================
# 6. LLM PROVIDERS & MODEL ORCHESTRATION
# =============================================================================
OPENAI_API_KEY=sk-proj-mock-or-valid-openai-key-here
ANTHROPIC_API_KEY=sk-ant-mock-or-valid-anthropic-key-here
DEFAULT_LLM_PROVIDER=openai
PRIMARY_REASONING_MODEL=gpt-4o
FAST_COMPLETION_MODEL=gpt-4o-mini
MAX_TOKENS_PER_RUN=4096
LLM_REQUEST_TIMEOUT_MS=15000

# =============================================================================
# 7. EXTERNAL CONNECTORS & ADAPTERS (API-001 & API-002)
# =============================================================================
MOCK_ERP_ENABLED=true
ERP_API_BASE_URL=http://localhost:8081/api/v1
ERP_CLIENT_ID=agentos_client_id
ERP_CLIENT_SECRET=agentos_client_secret
ERP_TIMEOUT_MS=5000

EVENT_INGESTION_BASE_URL=http://localhost:8081/events/v1
EVENT_INGESTION_HMAC_SECRET=event_stream_validation_secret

# Taiwan Adapter (ADPT-TW-001)
LINE_CHANNEL_ID=mock_line_channel_id
LINE_CHANNEL_SECRET=mock_line_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=mock_line_access_token
LINE_LOGIN_CHANNEL_ID=mock_line_login_channel_id
LINE_LOGIN_CHANNEL_SECRET=mock_line_login_channel_secret
LINE_LOGIN_CALLBACK_URL=http://localhost:4000/api/v1/auth/line/callback

ECPAY_MERCHANT_ID=mock_ecpay_merchant_id
ECPAY_HASH_KEY=mock_ecpay_hash_key
ECPAY_HASH_IV=mock_ecpay_hash_iv

NEWEBPAY_MERCHANT_ID=mock_newebpay_merchant_id
NEWEBPAY_HASH_KEY=mock_newebpay_hash_key
NEWEBPAY_HASH_IV=mock_newebpay_hash_iv

CVS_EMAP_CALLBACK_URL=http://localhost:4000/api/v1/shipping/cvs/callback
CVS_711_STORE_CODE=991182
CVS_FAMILYMART_STORE_CODE=018231

# Global Messaging & Omnichannel Adapters (ADPT-GL-001)
WHATSAPP_PHONE_NUMBER_ID=mock_whatsapp_phone_number_id
WHATSAPP_ACCESS_TOKEN=mock_whatsapp_access_token
WHATSAPP_WEBHOOK_VERIFY_TOKEN=mock_whatsapp_webhook_verify_token

META_APP_ID=mock_meta_app_id
META_APP_SECRET=mock_meta_app_secret
INSTAGRAM_ACCOUNT_ID=mock_instagram_account_id

ZALO_OA_ID=mock_zalo_oa_id
ZALO_OA_SECRET=mock_zalo_oa_secret
ZALO_APP_ACCESS_TOKEN=mock_zalo_access_token

TIKTOK_APP_ID=mock_tiktok_app_id
TIKTOK_APP_SECRET=mock_tiktok_app_secret
TIKTOK_ACCESS_TOKEN=mock_tiktok_access_token

# Global Payment Adapters (ADPT-GL-002)
STRIPE_SECRET_KEY=sk_test_mock_stripe_secret_key
STRIPE_WEBHOOK_SECRET=whsec_mock_stripe_webhook_secret
PAYPAL_CLIENT_ID=mock_paypal_client_id
PAYPAL_CLIENT_SECRET=mock_paypal_client_secret
PAYPAL_MODE=sandbox

# =============================================================================
# 8. OBJECT STORAGE & ASSETS REPOSITORY (S3 / CLOUDFLARE R2)
# =============================================================================
STORAGE_PROVIDER=s3
STORAGE_ENDPOINT=https://s3.ap-northeast-1.amazonaws.com
STORAGE_BUCKET=agentos-assets-dev
STORAGE_ACCESS_KEY_ID=mock_s3_access_key
STORAGE_SECRET_ACCESS_KEY=mock_s3_secret_key
STORAGE_REGION=ap-northeast-1

# =============================================================================
# 9. OBSERVABILITY, METRICS & AUDIT (NFR-002, NFR-010)
# =============================================================================
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=agentos-revenue-platform
METRICS_PORT=9090
COST_PER_1K_PROMPT_TOKENS_GPT4O=0.005
COST_PER_1K_COMPLETION_TOKENS_GPT4O=0.015
COST_PER_1K_PROMPT_TOKENS_MINI=0.00015
COST_PER_1K_COMPLETION_TOKENS_MINI=0.0006
```

---

## 4. Strict Environment Schema Validation (TypeScript & Python)

### TypeScript Boot-Time Validator (`packages/core-engine/src/config/env.validator.ts`)

```typescript
import { z } from 'zod';

/**
 * Strict Environment Schema definition using Zod.
 * Enforces fail-closed boot semantics if any required variable is missing or malformed.
 */
export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  SERVICE_NAME: z.string().min(1).default('agentos-api'),
  
  // Security
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters for AES-256 compatibility'),
  INTERNAL_API_KEY: z.string().min(32),
  WEBHOOK_HMAC_SECRET: z.string().min(16),
  ENCRYPTION_KEY_AES256: z.string().length(64, 'ENCRYPTION_KEY_AES256 must be a 64-char hex string (32 bytes)'),

  // Database
  DATABASE_URL: z.string().url().refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), {
    message: 'DATABASE_URL must be a valid PostgreSQL connection URI',
  }),
  DATABASE_POOL_MIN: z.coerce.number().int().min(1).default(5),
  DATABASE_POOL_MAX: z.coerce.number().int().min(5).default(20),

  // Redis & Workflows
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().default('agentos:'),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(259200), // 72 hours

  // Vector DB
  QDRANT_URL: z.string().url(),
  QDRANT_API_KEY: z.string().min(1),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  // LLM Configurations
  OPENAI_API_KEY: z.string().min(1),
  PRIMARY_REASONING_MODEL: z.string().min(1).default('gpt-4o'),
  FAST_COMPLETION_MODEL: z.string().min(1).default('gpt-4o-mini'),

  // ERP & Adapters (API-001 & API-002)
  ERP_API_BASE_URL: z.string().url(),
  ERP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Taiwan Adapter (ADPT-TW-001)
  LINE_CHANNEL_ID: z.string().optional().default('mock_line_id'),
  LINE_CHANNEL_SECRET: z.string().optional().default('mock_line_secret'),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional().default('mock_line_token'),
  ECPAY_MERCHANT_ID: z.string().optional().default('mock_ecpay_id'),
  NEWEBPAY_MERCHANT_ID: z.string().optional().default('mock_newebpay_id'),

  // Global Payment (ADPT-GL-002)
  STRIPE_SECRET_KEY: z.string().optional().default('sk_test_mock'),
  PAYPAL_CLIENT_ID: z.string().optional().default('mock_paypal_id'),

  // Object Storage
  STORAGE_PROVIDER: z.enum(['s3', 'r2', 'local']).default('s3'),
  STORAGE_BUCKET: z.string().default('agentos-assets-dev'),

  // Observability & Cost Tracking (NFR-010)
  OTEL_SERVICE_NAME: z.string().default('agentos-revenue-platform'),
  COST_PER_1K_PROMPT_TOKENS_GPT4O: z.coerce.number().positive().default(0.005),
  COST_PER_1K_COMPLETION_TOKENS_GPT4O: z.coerce.number().positive().default(0.015),
  COST_PER_1K_PROMPT_TOKENS_MINI: z.coerce.number().positive().default(0.00015),
  COST_PER_1K_COMPLETION_TOKENS_MINI: z.coerce.number().positive().default(0.0006),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * Validates process.env against EnvironmentSchema.
 * Throws an explicit error and exits process immediately if validation fails (NFR-008).
 */
export function validateEnvironment(env: Record<string, unknown> = process.env): Environment {
  const parsed = EnvironmentSchema.safeParse(env);
  
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
      .join('\n  ');

    console.error(`FATAL: Environment validation failed (Fail-Closed triggered):\n  ${errorDetails}`);
    process.exit(1);
  }

  return parsed.data;
}
```

### Python Boot-Time Validator (`apps/api-py/config/env.py`)

```python
"""Strict boot-time environment validator using Pydantic v2 Settings."""

import sys
from typing import Literal, Optional
from pydantic import Field, PostgresDsn, HttpUrl, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppEnvironmentSettings(BaseSettings):
    """Production environment configuration with strict validation."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    NODE_ENV: Literal["development", "staging", "production", "test"] = "development"
    PORT: int = Field(default=8000, gt=0, le=65535)
    SERVICE_NAME: str = "agentos-fastapi-core"

    # Security
    JWT_SECRET: str = Field(..., min_length=32)
    INTERNAL_API_KEY: str = Field(..., min_length=32)
    ENCRYPTION_KEY_AES256: str = Field(..., min_length=64, max_length=64)

    # Database & Storage
    DATABASE_URL: PostgresDsn
    DATABASE_POOL_MIN: int = Field(default=5, ge=1)
    DATABASE_POOL_MAX: int = Field(default=20, ge=5)

    # Cache & Idempotency
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = Field(default=6379, gt=0, le=65535)
    REDIS_PASSWORD: str
    IDEMPOTENCY_TTL_SECONDS: int = Field(default=259200, gt=0) # 72 hours

    # Vector DB
    QDRANT_URL: HttpUrl
    QDRANT_API_KEY: str
    EMBEDDING_DIMENSIONS: int = Field(default=1536, gt=0)

    # LLM
    OPENAI_API_KEY: str = Field(..., min_length=1)
    PRIMARY_REASONING_MODEL: str = "gpt-4o"
    FAST_COMPLETION_MODEL: str = "gpt-4o-mini"

    # Adapters & Storage
    ERP_API_BASE_URL: HttpUrl
    STORAGE_PROVIDER: Literal["s3", "r2", "local"] = "s3"
    STORAGE_BUCKET: str = "agentos-assets-dev"

    # Observability & Cost Tracking (NFR-010)
    OTEL_SERVICE_NAME: str = "agentos-revenue-platform"
    COST_PER_1K_PROMPT_TOKENS_GPT4O: float = Field(default=0.005, gt=0)
    COST_PER_1K_COMPLETION_TOKENS_GPT4O: float = Field(default=0.015, gt=0)
    COST_PER_1K_PROMPT_TOKENS_MINI: float = Field(default=0.00015, gt=0)
    COST_PER_1K_COMPLETION_TOKENS_MINI: float = Field(default=0.0006, gt=0)


def load_and_validate_env() -> AppEnvironmentSettings:
    """Instantiate and validate environment variables at startup."""
    try:
        return AppEnvironmentSettings()
    except ValidationError as exc:
        sys.stderr.write(f"FATAL: Environment validation failed:\n{exc}\n")
        sys.exit(1)
```
