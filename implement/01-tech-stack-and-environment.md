# Tech Stack & Environment Specification

> **BLUEPRINT STATUS — Gate P0 target design, not an inventory of existing files.**
> This document is the target design for the **Gate P0 (Foundation)** deliverable defined in SRS
> AI-REV-SRS-001 §24. Every Docker Compose service, SQL script, environment variable, source file, and
> configuration snippet below is a **blueprint to be implemented later**; none of them currently exists in
> this documentation-only repository (there are no runnable packages, manifests, images, or containers).
> Ports, service names, table names, and sample values are design proposals, not verified runtime facts.
> Numeric latency, throughput, availability, and cost figures are **provisional design targets pending
> ASM-002 (KPI baseline) and the NFR-009 benchmark**, not committed SLAs.

## 1. Architectural Justification Matrix (NFR-001 through NFR-010)

The selection of every framework, database, cache, and runtime component within the AI Revenue & Engagement Platform is directly derived from the 10 core Non-Functional Requirements (NFR-001..NFR-010) defined in Section 19 of the Software Requirements Specification (AI-REV-SRS-001).

| NFR Identifier | Requirement Name & Requirement Mandate | Technical Choice | Architectural Justification & Implementation Mechanism |
|---|---|---|---|
| **NFR-001** | **Security & Authority Boundaries** (MUST)<br>Strict containment within the agent's assigned clearance: `AUTH-0`..`AUTH-3` are autonomous levels, `AUTH-4` routes the prepared action to human approval, and `AUTH-5` is a hard deny that is never a numeric superuser level. Prompt injection defense (BR-009). Server-side deny by default. | **Node.js (TypeScript 5.x) core runtime** with static type enforcement and schema validators. A Python (FastAPI) service is an **optional auxiliary worker only** (for Python-specific ML/NLP libraries), subject to ASM-001 and never a second core runtime. | LLM outputs are never directly executed. Responses are validated against strict Zod schemas in the Node core (Pydantic only inside an optional Python worker, if one is ever approved). Tool invocations pass through an independent, deterministic Policy Engine running outside the LLM context. Unrecognized tokens or privilege escalation attempts trigger an immediate `DENY` before dispatch. |
| **NFR-002** | **Auditability** (MUST)<br>100% of external actions and approval decisions must generate an immutable Evidence Record with `run_id`, `tenant_id`, timestamp, latency, token consumption, cost, and agent/operator ID. | **PostgreSQL 16 (Append-Only Tables)** + **OpenTelemetry Span Context** | Every skill invocation and state transition creates an immutable record in `evidences` and `executions` tables. Postgres write-ahead logs (WAL) ensure transaction durability. OpenTelemetry `correlation_id` propagates through all distributed services, connecting client events to backend database writes. |
| **NFR-003** | **Idempotency** (MUST)<br>External mutations and outgoing messages must carry an `effect_key`. Replays must not duplicate orders, financial transactions, or messages. | **Redis 7.2 (SET NX EX)** + **PostgreSQL Unique Constraints** | Distributed 72-hour idempotency cache in Redis (`tenant:{id}:effect:{effect_key}`) with atomic `SET NX EX 259200`. Secondary permanent deduplication enforced in PostgreSQL via `UNIQUE (tenant_id, effect_key)` on the `executions` table. **Identical replay** of an already-executed `effect_key` (byte-identical canonical payload) returns the **cached execution receipt** and performs no new external effect; only a **payload mismatch under the same key** returns `IDEMPOTENCY_CONFLICT` (HTTP 409). |
| **NFR-004** | **Availability & Auto-Recovery**<br>Durable workflows with finite exponential backoff, circuit breaking, timeouts, and state checkpointing. | **Temporal.io / BullMQ 5.x** backed by Redis & PostgreSQL | Multi-step workflows (e.g., Abandoned Cart Recovery, Campaign Dispatch, Escalation Routing) are persisted as durable state machines. If a worker process crashes, Temporal/BullMQ resumes execution from the exact last verified step without repeating prior side effects. |
| **NFR-005** | **Explainability & Transparency**<br>100% of qualification scores, recommendations, discounts, and routing decisions must store a logic `reason` and verified `evidence`. | **PostgreSQL JSONB Evidence Contracts** | Recommendations and lead evaluations strictly enforce the 7 mandatory fields (FR-SAL-003) and 5-tier evidence separation (FR-C360-003: `FACT`, `SIGNAL`, `HYPOTHESIS`, `DECISION`, `ACTION`). Inferences (`HYPOTHESIS`) are prevented from corrupting ground-truth records (`FACT`). |
| **NFR-006** | **Data Isolation** (MUST)<br>SRS semantic: data belonging to verified customer A must never appear in the context of customer B. Tenant-to-tenant isolation is an **additional** platform requirement layered on top of this customer-level isolation. | **PostgreSQL Row-Level Security (RLS)**, **Qdrant Namespaces / Collections**, **Tenant-Prefixed Redis Keys**, plus **subject-scoped query binding** | PostgreSQL enforces RLS on all 28 canonical tables using `tenant_id = current_setting('app.current_tenant_id')` **and** customer-subject predicates bound to the verified customer of the conversation. Qdrant enforces tenant-filtered payloads on vector searches; Redis isolates all cache and lock keys under `tenant:{tenant_id}:*`. Queries lacking tenant context, or whose subject scope does not match the verified customer, are rejected at the data gateway. |
| **NFR-007** | **Human Override**<br>Operators must be able to Pause, Cancel, Modify pending actions (SCR-003) and Take Over live chat sessions (SCR-005) instantly. | **Next.js 14 (App Router) + Server-Sent Events (SSE) / WebSockets** + **Redis Pub/Sub** | Command Center operators hold hard override locks. Invoking `takeover` acquires a Redis session lock (`tenant:{id}:session:{session_id}:takeover_lock`), instantly pausing the AI agent and routing subsequent channel messages directly to the human agent's WebSocket feed. |
| **NFR-008** | **Failure Safety — Fail Closed** (MUST)<br>Missing price, unverified inventory, authority doubt, or absent consent must halt execution and route to human support. | **Deterministic Guardrail Middleware (Core Engine)** | Pre-execution skill filters run prior to any external call. If API-001 fails to return authoritative price or inventory, or if consent validation returns `false` (BR-004), the pipeline halts with `FAIL_CLOSED`, logs an audit warning, and notifies the supervisor queue. |
| **NFR-009** | **Performance & Latency**<br>Conversational responses designed for near-real-time; **the example figures p95 < 1.5 s and widget < 20 KB are provisional design targets pending the NFR-009 benchmark**, which is what locks the official SLA (SRS §19). Lightweight Storefront Widget with zero host DOM interference. | **Vanilla TypeScript Web Component (Shadow DOM)** + **Node.js streaming responses** (a FastAPI worker would only inherit the same contract if the optional Python service is approved). | The Storefront Widget is compiled without external libraries (no React/Vue runtime); the example gzipped bundle budget (< 18 KB) and the initial-token target (~350 ms) are provisional design targets pending the NFR-009 benchmark. Streaming responses use Server-Sent Events (SSE), while background orchestrations run asynchronously in workers. |
| **NFR-010** | **Cost Observability** (MUST)<br>Real-time calculation of token usage (input, output, cached), LLM model costs, and adapter API fees. Aggregation to cost-per-run and cost-per-customer. | **Prometheus Metrics** + **PostgreSQL Cost Aggregation Tables** | Every LLM call wrapper extracts token usage from provider response metadata, applies per-model pricing matrices, and records exact micro-dollar costs in the `executions` record. Data is aggregated hourly for display on executive dashboards SCR-001 and SCR-002. |

---

## 2. Docker Compose Local Development Environment (Gate P0 Blueprint — Not Yet Present)

**Blueprint notice:** the `docker-compose.yml` file and the `docker/postgres/init.sql` script shown in this
section **do not exist in this repository**; this documentation-only tree ships no manifests, images, or
runnable services. They are the target Gate P0 local-development blueprint to be created during Sprint 1.

The target local development environment replicates all production backing services using containerized images. It provisions PostgreSQL 16 with the `pgvector` extension, Redis 7.2 in standalone persistence mode, Qdrant Vector Search Engine, and a dedicated Mock ERP / Commerce API service that simulates API-001 (ERP/OMS) and API-002 (Event Ingestion).

### docker-compose.yml (target blueprint)

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
  # 4. Mock ERP & Commerce Service: simulates API-001 & API-002 for local/CI only
  #    Source: services/mock-erp/ (02 §1 tree). NEVER deployed to staging, the
  #    production-like pilot sandbox, or production — those tiers use the approved
  #    real SoR boundary (§6; 09 §8).
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
      APP_ENV: local
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
      APP_ENV: local
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
      APP_ENV: local
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: super_secret_jwt_encryption_key_min_32_characters_long
      # Gateway origin only — no /api/v1 suffix in this variable. Browser clients append
      # absolute /api/v1/** paths themselves (07 §7.2; 02 §2 network edges).
      NEXT_PUBLIC_API_URL: http://localhost:4000
      # No database credential: the Command Center reads and mutates only through the
      # /api/v1 gateway (02 §5 ownership table; 07 UI contract). A hidden DATABASE_URL
      # here would create a second, unaudited path to tenant data and is prohibited.
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

### PostgreSQL Initialization Script (`docker/postgres/init.sql`) — target blueprint

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

## 2.2. Staging & Production Infrastructure Topology (Gate P0 Blueprint — Not Yet Present)

**Blueprint notice:** the topology, PgBouncer configuration, replication URLs, and example latency figures below
are target design proposals for later environments. They describe no deployed infrastructure.

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

To support thousands of concurrent chat sessions and webhook dispatches without exhausting PostgreSQL process limits, the target staging/production topology places PgBouncer in front of PostgreSQL as the intermediary pooler (the `[databases]`/`[pgbouncer]` block below is a design proposal, not a deployed configuration):

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

| Connection URL | Target Host & Topology | Permitted Operations | Latency Target (provisional, pending NFR-009 benchmark) |
|---|---|---|---|
| `POSTGRES_PRIMARY_URL` | RDS Primary Multi-AZ (Active-Standby synchronous failover; RPO = 0 and RTO < 30 s are design targets, not measured guarantees) | INSERT, UPDATE, DELETE, and immediate transactional SELECT queries. | < 5ms p95 (provisional) |
| `POSTGRES_REPLICA_URL` | RDS Read Replica (Asynchronous streaming replication, target lag < 100ms) | Analytical read-only workloads: SCR-001 Executive Dashboard, SCR-002 Reports, segment batch evaluation. | < 10ms p95 (provisional) |

---

## 3. Configuration & Environment Variables Specification (Gate P0 Blueprint — Not Yet Present)

**Blueprint notice:** `.env.example` and the boot-time validators below are target design artifacts. No
environment file, schema module, or runtime config loader exists in this repository.

The target design enforces strict schema validation at application boot time using Zod in the Node core; Pydantic applies **only** inside the optional Python auxiliary worker if that service is ever approved (see NFR-001). If any mandatory variable is absent or improperly formatted, the server **fails closed** immediately and refuses to start.

### `.env.example` (target blueprint; placeholder values only — never real credentials)

```bash
# =============================================================================
# 1. RUNTIME & SYSTEM
# =============================================================================
# APP_ENV selects the deployment profile (local|ci|staging|sandbox|production).
# NODE_ENV is the Node runtime mode only (development|test|production) and is NOT the
# profile selector: staging and the production-like pilot sandbox both run with
# NODE_ENV=production (§3.1 mapping table). The boot validator rejects a missing or
# unknown APP_ENV and rejects placeholder values outside local/CI.
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
AUDIT_HMAC_SECRET=local_only_audit_chain_signing_placeholder
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

# Baseline API-003 channels: Email and SMS (provider selection unconfirmed — ASM-001)
EMAIL_PROVIDER=sendgrid
EMAIL_FROM_ADDRESS=no-reply@example.invalid
EMAIL_API_KEY=mock_email_provider_api_key
EMAIL_WEBHOOK_SIGNING_KEY=mock_email_webhook_signing_key

SMS_PROVIDER=twilio
SMS_SENDER_ID=MockSender
SMS_API_KEY=mock_sms_provider_api_key
SMS_WEBHOOK_SIGNING_KEY=mock_sms_webhook_signing_key

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
# Cost coefficients are PROVISIONAL configuration inputs (illustrative provider list pricing),
# NOT measured unit economics. Final cost targets require the ASM-002 KPI baseline and NFR-009 benchmark.
COST_PER_1K_PROMPT_TOKENS_GPT4O=0.005
COST_PER_1K_COMPLETION_TOKENS_GPT4O=0.015
COST_PER_1K_PROMPT_TOKENS_MINI=0.00015
COST_PER_1K_COMPLETION_TOKENS_MINI=0.0006
```

### 3.1. Deployment profile mapping `[BLUEPRINT][SRS §19 / NFR-001, NFR-008]`

`APP_ENV` selects the deployment profile and therefore the placeholder and mock-boundary policy; `NODE_ENV` is only the Node runtime mode. The two MUST NOT be used interchangeably, and `NODE_ENV` alone never selects an environment:

| Environment row (§6) | `APP_ENV` | `NODE_ENV` | Placeholder/mock policy in that profile |
|---|---|---|---|
| Local | `local` | `development` | Placeholders (`mock-*`, `example.invalid`, banner secrets) and `MOCK_ERP_ENABLED=true` allowed; no real outbound effect |
| CI | `ci` | `test` | Placeholders allowed; intercepted boundaries and the mock SoR container only |
| Staging | `staging` | `production` | Placeholder secrets refused at boot (catalog §8 rule 2); sandbox providers and approved SoR sandbox |
| Production-like sandbox (pilot) | `sandbox` | `production` | Placeholder secrets refused; locked sandbox/production-like SoR and pilot allowlist only (`09` §8) |
| Production | `production` | `production` | Placeholder secrets refused; owner-approved real providers only |

A missing or unknown `APP_ENV`, or any `mock-*` / `example.invalid` / banner placeholder value under `staging`, `sandbox`, or `production`, refuses startup before any dependency connection is used for work (catalog §8 rules 1–2; scenario `ENV-02`). The §4 validators implement this mapping and MUST be extended, not bypassed, when a new profile is introduced.

---

## 4. Strict Environment Schema Validation (Gate P0 blueprint)

**Blueprint notice:** both validators below are target design artifacts for the Node core and, optionally, for a
future Python auxiliary worker. Neither file (`packages/core-engine/src/config/env.validator.ts`,
`apps/api-py/config/env.py`) exists in this repository.

### TypeScript Boot-Time Validator — Node core (`packages/core-engine/src/config/env.validator.ts`, target blueprint)

```typescript
import { z } from 'zod';

/**
 * Strict Environment Schema definition using Zod.
 * Enforces fail-closed boot semantics if any required variable is missing or malformed.
 */
export const EnvironmentSchema = z.object({
  // Deployment profile selector (§3.1). Not the Node runtime mode: staging and the
  // production-like pilot sandbox run NODE_ENV=production with APP_ENV=staging/sandbox.
  APP_ENV: z.enum(['local', 'ci', 'staging', 'sandbox', 'production']),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  SERVICE_NAME: z.string().min(1).default('agentos-api'),
  
  // Security
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters for AES-256 compatibility'),
  INTERNAL_API_KEY: z.string().min(32),
  WEBHOOK_HMAC_SECRET: z.string().min(16),
  AUDIT_HMAC_SECRET: z.string().min(16),
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
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(259200), // 72 h replay window (provisional design value; the NFR-003 invariant is no duplicate effect)

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

  // Optional provider adapters — credentials are NEVER defaulted. An absent value leaves the
  // adapter disabled (06 §9.2 CAPABILITY_NOT_ENABLED); a mock/default credential must never
  // enable a real capability, and managed profiles reject placeholders (see superRefine).

  // Taiwan Adapter (ADPT-TW-001)
  LINE_CHANNEL_ID: z.string().min(1).optional(),
  LINE_CHANNEL_SECRET: z.string().min(1).optional(),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1).optional(),
  ECPAY_MERCHANT_ID: z.string().min(1).optional(),
  NEWEBPAY_MERCHANT_ID: z.string().min(1).optional(),

  // Baseline API-003 channels: Email & SMS (provider selection unconfirmed — ASM-001)
  EMAIL_PROVIDER: z.enum(['sendgrid', 'mailgun', 'smtp']).optional(),
  EMAIL_API_KEY: z.string().min(1).optional(),
  EMAIL_WEBHOOK_SIGNING_KEY: z.string().min(1).optional(),
  SMS_PROVIDER: z.enum(['twilio', 'chunghwa_telecom', 'gateway_rest']).optional(),
  SMS_API_KEY: z.string().min(1).optional(),
  SMS_WEBHOOK_SIGNING_KEY: z.string().min(1).optional(),

  // Global Payment (ADPT-GL-002)
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  PAYPAL_CLIENT_ID: z.string().min(1).optional(),

  // Object Storage
  STORAGE_PROVIDER: z.enum(['s3', 'r2', 'local']).default('s3'),
  STORAGE_BUCKET: z.string().default('agentos-assets-dev'),

  // Observability & Cost Tracking (NFR-010)
  OTEL_SERVICE_NAME: z.string().default('agentos-revenue-platform'),
  COST_PER_1K_PROMPT_TOKENS_GPT4O: z.coerce.number().positive().default(0.005),
  COST_PER_1K_COMPLETION_TOKENS_GPT4O: z.coerce.number().positive().default(0.015),
  COST_PER_1K_PROMPT_TOKENS_MINI: z.coerce.number().positive().default(0.00015),
  COST_PER_1K_COMPLETION_TOKENS_MINI: z.coerce.number().positive().default(0.0006),
}).superRefine((env, ctx) => {
  // Rule 1 — placeholders are local/CI only (catalog §8 rule 2; scenario ENV-02). A mock or
  // banner value must never satisfy a managed profile and thereby "approve" a real capability.
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') {
    const placeholderPattern =
      /(mock|placeholder|example\.invalid|super_secret|agentos_internal_service_mesh_key|hmac_signature_validation_secret|local_only_audit_chain_signing|change[_-]?me|test[_-]?(secret|key|password))/i;
    for (const key of Object.keys(env) as Array<keyof typeof env>) {
      const value = env[key];
      if (typeof value === 'string' && placeholderPattern.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Placeholder value rejected for APP_ENV=${env.APP_ENV}; inject the real value from the secret store`,
        });
      }
    }
  }

  // Rule 2 — adapter credential sets are all-or-nothing (catalog §8 rule 3). A partial set
  // would leave an adapter half-configured; the adapter is enabled only with its complete set,
  // otherwise the whole set stays unset and the adapter refuses calls with CAPABILITY_NOT_ENABLED.
  const credentialSets: ReadonlyArray<ReadonlyArray<keyof typeof env>> = [
    ['LINE_CHANNEL_ID', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'],
    ['EMAIL_API_KEY', 'EMAIL_WEBHOOK_SIGNING_KEY'],
    ['SMS_API_KEY', 'SMS_WEBHOOK_SIGNING_KEY'],
  ];
  for (const set of credentialSets) {
    const present = set.filter((key) => env[key] !== undefined).length;
    if (present !== 0 && present !== set.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [set[0]],
        message: `Incomplete credential set for ${String(set[0])}; set the full set to enable the adapter or leave it unset (adapter stays disabled)`,
      });
    }
  }
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

### Python Boot-Time Validator — OPTIONAL auxiliary worker only (`apps/api-py/config/env.py`, target blueprint)

```python
"""Strict boot-time environment validator using Pydantic v2 Settings."""

import re
import sys
from typing import Literal, Optional
from pydantic import Field, PostgresDsn, HttpUrl, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppEnvironmentSettings(BaseSettings):
    """Production environment configuration with strict validation."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    APP_ENV: Literal["local", "ci", "staging", "sandbox", "production"]
    NODE_ENV: Literal["development", "test", "production"] = "development"
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
    IDEMPOTENCY_TTL_SECONDS: int = Field(default=259200, gt=0)  # 72 h replay window (provisional design value)

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

    @model_validator(mode="after")
    def reject_placeholders_in_managed_profiles(self) -> "AppEnvironmentSettings":
        """Placeholders are local/CI only (catalog §8 rule 2; scenario ENV-02)."""
        if self.APP_ENV in ("local", "ci"):
            return self
        placeholder = re.compile(
            r"(mock|placeholder|example\.invalid|super_secret|agentos_internal_service_key|agentos_internal_service_mesh_key|hmac_signature_validation_secret|local_only_audit_chain_signing|change[_-]?me|test[_-]?(secret|key|password))",
            re.IGNORECASE,
        )
        for name, value in self.model_dump().items():
            if isinstance(value, str) and placeholder.search(value):
                raise ValueError(f"Placeholder value rejected for {name} in APP_ENV={self.APP_ENV}")
        return self


def load_and_validate_env() -> AppEnvironmentSettings:
    """Instantiate and validate environment variables at startup."""
    try:
        return AppEnvironmentSettings()
    except ValidationError as exc:
        sys.stderr.write(f"FATAL: Environment validation failed:\n{exc}\n")
        sys.exit(1)
```

---

## 5. Runtime Reconciliation Note (Node core vs. optional Python service)

- **Core runtime — Node.js (TypeScript 5.x).** API gateway, Revenue Orchestrator, agent runtime, skills,
  adapters, durable workers, and the Next.js Command Center are all Node.js artifacts.
- **Optional auxiliary runtime — Python (FastAPI).** A Python service MAY be introduced later for
  Python-only ML/NLP libraries. It is **not** part of the monorepo layout in
  `02-project-structure.md`, is **not** required by any SRS NFR, and must be justified under ASM-001
  before it appears in any topology. Until then, every Python snippet in this document is an
  illustrative alternative, not a planned component.
- **Neither runtime currently exists.** This repository is documentation-only; the code paths named in
  this document are target file locations for the Gate P0 build, not present files.

## 5.1. Document Contract, Boundary, and Rollout Prerequisites `[BLUEPRINT][SRS §19, §24]`

- **Purpose.** Define the target runtime platform for the Gate P0 (Foundation) deliverable in SRS §24: services, backing dependencies, environment boundaries, configuration, readiness order, trust zones, bounded resource assumptions, and failure behavior.
- **Responsibility boundary.** This document owns environment names, configuration variable names/types/requirements, startup and readiness order, network/trust zones, and environment-level failure semantics. It does **not** own DDL/RLS policy (`03`), route/wire contracts (`06`), SCR screens (`07`), authority verdicts and business rules (`08`), or gate/pilot sign-off (`09`); those are linked, never redefined here.
- **Inputs.** SRS §19 (NFR-001..NFR-010), §24 (gates), §26 (ASM-001..ASM-005); `03` DDL/RLS contract; `06` `/api/v1` surface; `09` §7 gate contract and §8 pilot runbook.
- **Outputs.** Environment matrix (§6), startup/readiness contract (§7), configuration catalog (§8), network/authentication matrix (§9), bounded resource assumptions (§10), failure matrix (§11), environment verification scenarios (§12). Every artifact is a **target specification**; none is implemented, deployed, or measured, and no snippet is runtime evidence.
Authority boundary reminder: agents receive only `AUTH-0..AUTH-3` grants; `AUTH-4` routes a prepared action to approval and `AUTH-5` is a terminal deny verdict. Neither verdict is a grant or a numeric rank; this environment document only supplies configuration and trust prerequisites for the owner contract in `08`.
- **Rollout prerequisites, ordered (aligns with `09` §7 Gate P0).** (1) environment owner named and secret store selected; (2) PostgreSQL schema + RLS rehearsal passing; (3) Redis, Qdrant, and SoR-boundary probes passing; (4) gateway boots on schema-validated configuration; (5) worker/orchestrator lease and durable-state probes pass; (6) Command Center read/stream authorization probe passes; (7) tenant-context propagation and no-secret-leak checks recorded. A missing prerequisite blocks promotion to the next environment tier; mock-only evidence cannot close a gate (`09` §7).
- **Non-negotiable cross-document guardrail.** No price-bearing action may dispatch without an owner-approved, provenance-bearing floor decision, and ownership/formula/mode/rounding remain `[OWNER-DECISION-REQUIRED]` until the Solution Architect and Business/Finance record it — see `README.md` §8.1. No configuration value in §8 may be interpreted as authorizing a price, discount, refund, or subsidy policy.

## 6. Environment Responsibility Matrix `[BLUEPRINT][SRS §19 / NFR-001..NFR-010]`

The environments below are target boundaries, not existing deployments. Each MUST have a named owner, MUST refuse startup when required configuration or trust boundary is absent, and MUST NOT be treated as interchangeable.

| Environment | Named owner | Data class | Connector class | Secret source | Network boundary | Allowed side effects | Observability level | Gate prerequisites (`09` §7) |
|---|---|---|---|---|---|---|---|---|
| Local | Developer workstation owner (platform `01`) | Synthetic fixtures only | Mock ERP simulator (§2) and intercepted providers | Developer-local `.env` placeholders; never shared or committed | Loopback plus private Compose bridge network | No real outbound customer/provider mutation | Structured debug logs; optional local OTLP collector; no KPI, SLA, or audit claims | P0 schema/RLS rehearsal passing |
| CI | CI platform owner | Ephemeral synthetic fixtures per job | Intercepted boundaries plus mock SoR container | CI secret references only; repository values are forbidden | Ephemeral job network; no inbound from public network | None outside the job sandbox | Job logs artifact; no external telemetry export; no production credential | P0 contract artifacts plus `test:rls-policies` (`09` §10) |
| Staging | Platform/DevOps owner `[UNCONFIRMED][ASM-001]` | Masked or synthetic tenant data | Sandbox providers and approved SoR sandbox | Managed secret store, versioned `[UNCONFIRMED][ASM-001]` | Private service network with egress allowlist | Sandbox allowlist only; no real customer outreach | OTLP traces/metrics to staging collector; dashboards live; alerts to team channel | P0 signed; P1 prerequisites scoped |
| Production-like sandbox | Pilot owner (`09` §8 runbook) | Approved pilot tenant and data scope only | Locked sandbox or production-like SoR (`09` §8) | Managed secret store plus operator-held rotation | Segmented gateway/core/worker/data zones; signed ingress | Pilot allowlist recipients only | Full OTel plus audit dashboards; evidence-bundle capture enabled | Signed pilot bundle for the pilot under test |
| Production | Named service owner plus on-call rota `[UNCONFIRMED][ASM-001]` | Real tenant data under RLS and customer-subject binding | Owner-approved real providers | Secret manager/KMS with rotation `[UNCONFIRMED][ASM-001]` | Zero-trust private network; signed ingress; no browser-to-data-zone path | Policy-authorized effects only, subject to §8.1 floor guardrail | Full OTel, audit hash chain, NFR-010 cost dashboards, paging alerts | `09` §7 P5 plus NFR-001..NFR-010 evidence |

Owner names, secret-manager product selection, and provider allowlists remain `[OWNER-DECISION-REQUIRED]`/`[UNCONFIRMED][ASM-001]`; the safe interim rule is that an unnamed owner or unselected secret source blocks startup rather than defaulting to a shared placeholder.

## 7. Component Startup and Dependency Graph `[BLUEPRINT][SRS §19 / NFR-004, NFR-008]`

Target readiness order: **PostgreSQL → Redis → Qdrant → mock/real SoR connector boundary → API gateway → worker/orchestrator → Command Center**. The gateway and worker MUST NOT accept traffic before their own dependencies report ready; the Command Center is a client of `/api/v1` and never of the data zone (`06` §1.1, `09` §8).

| # | Component | Health probe (target) | Readiness condition | Retry/backoff on failure | Fail-closed / startup refusal | Audit or operator signal |
|---|---|---|---|---|---|---|
| 1 | PostgreSQL | `pg_isready` plus application query `SELECT 1` | Authenticated connection, expected migration version, and RLS probe (`current_setting('app.current_tenant_id')` round-trip) pass (`03` §2) | Finite startup backoff (bounded attempts, no infinite loop); migration never auto-repaired | Refuse API and worker readiness; no query executes without tenant context | Startup failure logged with dependency name and attempt count; operator restores database |
| 2 | Redis | `PING` with authentication | Authenticated ping, key-prefix convention (`tenant:{tenant_id}:*`, `03` §3), and mutex probe pass | Finite backoff; repeated failure escalates to dependency-down state | No mutation dispatch, no session takeover, and no local fallback lock | Dependency-down state surfaced to SCR-002 and recorded as an operational event |
| 3 | Qdrant | HTTP `/healthz` or gRPC health | Authenticated collection and payload-filter probe pass for the Second Brain collection (`03` §4) | Bounded read retry with classification; no write retry loop | No fabricated knowledge answer and no evidence card emitted without retrieval citation | Degraded-knowledge state logged; operator re-indexes or disables knowledge answers |
| 4 | SoR / connector boundary (API-001, API-002, API-003) | Per-adapter TLS/HMAC/mTLS probe plus tenant binding (`06` §9) | Signature/credential verification and tenant binding pass for every enabled adapter | Adapter policy: finite retry for idempotent reads; a dispatched mutation with no acknowledgement becomes `UNKNOWN` and reconciles by `effect_key` (`04` §4.4) | Price, inventory, order, and receipt-dependent actions stop; unknown outcome is never blind-retried | Reconciliation record plus operator route (`06` retry route); no fabricated success |
| 5 | API gateway (`apps/api`) | Liveness probe endpoint — path is owned by `06` and is not yet in the §1.1 route inventory | Config schema valid, auth middleware registered, tenant binding active, route registry loaded (`04`, `06`) | Restart only after bounded failure; readiness stays false while any dependency is down | Reject requests without verified tenant context; refuse boot on invalid configuration | Boot rejection cites the failing variable name (never its value); SCR-002 dependency banner |
| 6 | Worker/orchestrator (`apps/worker`) | Worker lease heartbeat plus workflow-store probe | Durable queue lease acquired, workflow store reachable, optimistic-version read succeeds (`04` §4.2–4.3) | Lease retry with bounded backoff and optimistic version; expired lease re-queues the task | No new step and no new effect; resume only from durable state | Lease/lost-lease events recorded; operator inspects run history in SCR-002 |
| 7 | Command Center (`apps/command-center`) | Authenticated read of `/api/v1/telemetry/kpi-snapshot` | `/api/v1` read route and stream authorization probe pass with operator session | Reconnect with exponential backoff for streams (`07`) | Show unavailable/stale/unauthenticated state; never imply backend success or fabricate a value | UI state is one of the `07` shared UI states (loading/empty/stale/permission denied/dependency unavailable) |

Startup is all-or-nothing per process: a process whose **required** dependency fails readiness MUST exit non-zero rather than serve partially, and MUST NOT substitute an internal default for a missing dependency or credential (NFR-008 fail closed).

**Required vs. optional dependency scoping (a disabled capability never blocks an unrelated process).** The required set is computed per process role and per enabled capability — never as "every service in the diagram":

- A disabled capability removes its dependency from that process's readiness gate: `MOCK_ERP_ENABLED=false`, the durable workflow engine off, knowledge answers off, or an adapter disabled per tenant (`06` §9.2). The gateway, worker, and Command Center MUST still boot and serve the capabilities that remain enabled.
- A capability's dependency joins the readiness gate as soon as the capability is enabled; enabling it with an absent, incomplete, or placeholder credential set is a startup failure (catalog §8 rules 1–3), not a silent fallback.
- Credential absence never enables anything. Missing provider credentials leave the adapter disabled and it refuses calls with `CAPABILITY_NOT_ENABLED`; conversely, a mock/default credential MUST NOT satisfy a capability that the environment profile or pilot scope declares required (`09` §7–§8), which is why the §4 validator has no mock defaults and rejects placeholders outside local/CI.
- The Compose `depends_on` lists in §2 reflect the local default profile where every local service is enabled. A profile that disables a service omits it from `depends_on` instead of gating on a service it does not run.

## 8. Configuration Catalog `[MUST][SRS §19 / NFR-001, NFR-006, NFR-008]`

Every variable that appears in the `.env.example` blueprint (§3), the boot-time validators (§4), or the target Compose topology (§2) has exactly one row below. Legend: **Req** `MUST` = required in every profile and rejected when absent; `COND` = required when the consuming adapter/feature is enabled; `OPT` = optional with an explicit safe default. **Secret** `YES`/`NO`/`COND`. Consumers: `api` = `apps/api`, `worker` = `apps/worker`, `cc` = `apps/command-center`, `mig` = migration runner, `mock` = `services/mock-erp` local simulator.

Global rules (apply to every row):

1. Secrets are injected by the environment. They MUST NOT be committed, echoed in logs, rendered in the Command Center, or used as defaults; a missing or invalid secret for an enabled consumer refuses readiness (NFR-008).
2. Placeholder values (`mock-*`, `example.invalid`, the literal banners in §3/§2) are **local/CI only** and MUST be rejected by the staging, production-like sandbox, and production profiles.
3. `COND` variables are optional only while their adapter is disabled; enabling an adapter with an incomplete credential set is a startup failure, never a silent fallback. Credential sets are all-or-nothing, and absence never enables: a missing set leaves the adapter disabled (`CAPABILITY_NOT_ENABLED` at the boundary), and a mock/default credential MUST NOT enable or "approve" a real capability in any profile (§7 scoping rule; §4 validator).
4. Every cost, timeout, TTL, cap, and quota value below is `[PROVISIONAL][ASM-002]` and MUST NOT be read as an approved business, pricing, or SLA commitment. No value here authorizes a price, discount, refund, or subsidy policy (see §5.1 guardrail and `README.md` §8.1).
5. Rotation is operator-driven in Gate P0: managed tiers bump the secret-manager version and roll the consumer; local placeholders are never rotated or shared.

### 8.1 Runtime, security, and data-store variables (rows 1–31)

| Name | Type | Req | Owner | Secret | Safe placeholder / validation rule | Rotation | Consumer |
|---|---|---|---|---|---|---|---|
| `NODE_ENV` | enum `development\|test\|production` | MUST | `01` | NO | Node runtime mode only — never the profile selector (§3.1); validator rejects unknown values | n/a | api, worker, cc |
| `APP_ENV` | enum `local\|ci\|staging\|sandbox\|production` | MUST | `01` | NO | MUST match the §6 environment row; no default — absence refuses startup; selects the placeholder policy (§3.1) | n/a | api (startup gate) |
| `PORT` | int 1–65535 | MUST | `01` | NO | local `4000`; must match the published container port | n/a | api |
| `API_BASE_URL` | url | MUST | `01` | NO | local `http://localhost:4000`; production = signed ingress host | n/a | api (callback generation), cc |
| `WEB_BASE_URL` | url | MUST | `07` | NO | local `http://localhost:3000` | n/a | api (links), provider callback allowlist |
| `CORS_ALLOWED_ORIGINS` | csv(url) | MUST | `07` | NO | explicit origin list; `*` rejected outside local/CI | n/a | api |
| `LOG_LEVEL` | enum `error\|warn\|info\|debug` | OPT (`info`) | `08` | NO | `debug` only in local/CI; logs MUST NOT contain secrets or unmasked PII | n/a | api, worker |
| `SERVICE_NAME` | string | MUST | `01` | NO | `agentos-api` / `agentos-worker` per process | n/a | api, worker (OTel resource) |
| `JWT_SECRET` | string ≥32 | MUST | `08` | YES | local-only placeholder; staging/production inject a random ≥32-char value | security runbook; version bump + rolling restart | api, cc (session signing) |
| `JWT_EXPIRES_IN` | duration | OPT (`24h`) | `08` | NO | operator session lifetime; not an authority value | n/a | api |
| `INTERNAL_API_KEY` | string ≥32 | MUST | `08` | YES | service-to-service authentication; local-only placeholder | on incident and on operator change | api, worker |
| `WEBHOOK_HMAC_SECRET` | string ≥16 | MUST | `06` | YES | generic callback signature secret; per-provider secrets win where defined | with provider; overlap window for in-flight callbacks | api |
| `AUDIT_HMAC_SECRET` | string ≥16 | MUST | `08` | YES | local-only placeholder; managed tiers inject a KMS/secret-manager value and reject banner/mock values | rotate with audit-signing key version; preserve verification keys for historical chains | api, worker |
| `ENCRYPTION_KEY_AES256` | 64-char hex | MUST | `08` | YES | 32-byte field-encryption key; local-only placeholder | only with re-encryption + versioned key id | api, worker |
| `DATABASE_URL` | postgres URI | MUST | `03` | YES | local placeholder; non-local MUST use `sslmode=verify-full` + least-privilege role (§2.2) | with role credential rotation | api, worker, mig |
| `DATABASE_POOL_MIN` | int ≥1 | OPT (`5`) | `03` | NO | must be ≤ `DATABASE_POOL_MAX`; pool ownership = database package (`02` §5) | n/a | api, worker |
| `DATABASE_POOL_MAX` | int ≥5 | OPT (`20`) | `03` | NO | `[PROVISIONAL][ASM-002]`; re-baseline with NFR-009 | n/a | api, worker |
| `DATABASE_STATEMENT_TIMEOUT_MS` | int ms | OPT (`10000`) | `03` | NO | safety bound, not an SLA | n/a | api, worker |
| `REDIS_HOST` | host | MUST | `03` | NO | local `localhost`; private network in managed tiers | n/a | api, worker |
| `REDIS_PORT` | int 1–65535 | OPT (`6379`) | `03` | NO | must match the Redis listener | n/a | api, worker |
| `REDIS_PASSWORD` | string | MUST | `03` | YES | local-only placeholder; managed tiers inject from secret manager | security runbook | api, worker |
| `REDIS_DB` | int ≥0 | OPT (`0`) | `03` | NO | dedicated logical DB per environment; no cross-tenant logical split | n/a | api, worker |
| `REDIS_KEY_PREFIX` | string | OPT (`agentos:`) | `03` | NO | MUST stay consistent with `tenant:{tenant_id}:*` key contract (`03` §3) | n/a | api, worker |
| `SESSION_MUTEX_TTL_SECONDS` | int seconds | OPT (`30`) | `04` | NO | `[PROVISIONAL]`; bounds the one-responder session mutex (`tenant:{tid}:session:{sid}:mutex`, `03` §3, `06` §9.2). It is **not** the human takeover lease: that lease has its own 60 s TTL renewed every 30 s with `extend_seconds` 1–300 and is owned by `06` | n/a | worker |
| `IDEMPOTENCY_TTL_SECONDS` | int seconds | OPT (`259200`) | `04` | NO | `[PROVISIONAL]` 72 h replay window (design value, not an SRS-fixed number); the NFR-003 invariant is one effect per `effect_key`, and durable dedup remains in PostgreSQL | n/a | api, worker |
| `TEMPORAL_ADDRESS` | host:port | COND | `04` | NO | required when the durable workflow engine is enabled | n/a | worker |
| `TEMPORAL_NAMESPACE` | string | COND | `04` | NO | one namespace per environment; tenant split is by `tenant_id`, never by namespace | n/a | worker |
| `QDRANT_URL` | url | MUST | `03` | NO | local `http://localhost:6333`; no browser ingress | n/a | api, worker |
| `QDRANT_API_KEY` | string | MUST | `03` | YES | local-only placeholder; managed tiers inject from secret manager | security runbook | api, worker |
| `EMBEDDING_MODEL_PROVIDER` | enum `openai\|local` | COND | `03` | NO | provider choice is `[UNCONFIRMED][ASM-001]`; a change requires re-indexing | re-index on model change | worker |
| `EMBEDDING_MODEL_NAME` | string | COND | `03` | NO | `[PROVISIONAL]` default `text-embedding-3-small` | re-index on model change | worker |
| `EMBEDDING_DIMENSIONS` | int >0 | MUST | `03` | NO | MUST equal the collection dimension in `03` §4; mismatch refuses startup | re-index on change | worker |

### 8.2 LLM, provider, and connector variables (rows 32–98)

| Name | Type | Req | Owner | Secret | Safe placeholder / validation rule | Rotation | Consumer |
|---|---|---|---|---|---|---|---|
| `OPENAI_API_KEY` | string | MUST | `04` | YES | org-scoped key; never logged; local placeholder rejected in managed tiers | provider rotation policy `[UNCONFIRMED][ASM-001]` | api, worker |
| `ANTHROPIC_API_KEY` | string | COND | `04` | YES | `[OPTIONAL-EXTENSION]`; required only if that provider is selected | provider rotation policy `[UNCONFIRMED][ASM-001]` | api, worker |
| `DEFAULT_LLM_PROVIDER` | enum `openai\|anthropic` | OPT (`openai`) | `04` | NO | provider selection is `[UNCONFIRMED][ASM-001]`; no policy meaning | n/a | api, worker |
| `PRIMARY_REASONING_MODEL` | string | OPT (`gpt-4o`) | `04` | NO | `[PROVISIONAL]`; model swap requires prompt/eval re-review | on model change | api, worker |
| `FAST_COMPLETION_MODEL` | string | OPT (`gpt-4o-mini`) | `04` | NO | `[PROVISIONAL]`; used for low-risk completion paths only | on model change | api, worker |
| `MAX_TOKENS_PER_RUN` | int >0 | OPT (`4096`) | `04` | NO | `[PROVISIONAL][ASM-002]` cost guard; a run that exceeds it fails closed, never truncates evidence | n/a | api, worker |
| `LLM_REQUEST_TIMEOUT_MS` | int ms | OPT (`15000`) | `04` | NO | `[PROVISIONAL]`; timeout produces `UNKNOWN`, never a fabricated answer | n/a | api, worker |
| `MOCK_ERP_ENABLED` | bool | OPT (`true` local/CI) | `06` | NO | MUST be `false` in staging, pilot sandbox, and production; `true` there refuses startup | n/a | api, worker |
| `ERP_API_BASE_URL` | url | MUST | `06` | NO | local = `services/mock-erp`; managed tiers = approved SoR endpoint | n/a | api, worker |
| `ERP_CLIENT_ID` | string | COND | `06` | YES | SoR-issued client identity; placeholder rejected outside local | SoR policy `[UNCONFIRMED][ASM-001]` | api, worker |
| `ERP_CLIENT_SECRET` | string | COND | `06` | YES | SoR-issued secret | SoR policy | api, worker |
| `ERP_TIMEOUT_MS` | int ms | OPT (`5000`) | `06` | NO | `[PROVISIONAL]`; timeout ⇒ `UNKNOWN` + reconciliation by `effect_key` | n/a | api, worker |
| `EVENT_INGESTION_BASE_URL` | url | MUST | `06` | NO | API-002 ingestion base; local = mock SoR | n/a | api |
| `EVENT_INGESTION_HMAC_SECRET` | string | MUST | `06` | YES | verifies inbound event authenticity; local-only placeholder | with SoR; overlap window | api |
| `LINE_CHANNEL_ID` | string | COND | `06` §5.1 `[OPTIONAL-EXTENSION]` | NO | Taiwan adapter credential `[UNCONFIRMED][ASM-001]` | provider policy | api |
| `LINE_CHANNEL_SECRET` | string | COND | `06` §5.1 | YES | webhook signature secret | provider policy | api |
| `LINE_CHANNEL_ACCESS_TOKEN` | string | COND | `06` §5.1 | YES | outbound messaging token | provider policy | api, worker |
| `LINE_LOGIN_CHANNEL_ID` | string | COND | `06` §5.1 | NO | LINE Login channel (identity linking) | provider policy | api |
| `LINE_LOGIN_CHANNEL_SECRET` | string | COND | `06` §5.1 | YES | LINE Login secret | provider policy | api |
| `LINE_LOGIN_CALLBACK_URL` | url | COND | `06` §5.1 | NO | MUST match the registered provider callback exactly | with provider config change | api |
| `ECPAY_MERCHANT_ID` | string | COND | `06` §5.1 | NO | Taiwan payment adapter `[UNCONFIRMED][ASM-001]` | provider policy | worker |
| `ECPAY_HASH_KEY` | string | COND | `06` §5.1 | YES | request/response integrity key | provider policy | worker |
| `ECPAY_HASH_IV` | string | COND | `06` §5.1 | YES | integrity IV | provider policy | worker |
| `NEWEBPAY_MERCHANT_ID` | string | COND | `06` §5.1 | NO | alternative payment adapter | provider policy | worker |
| `NEWEBPAY_HASH_KEY` | string | COND | `06` §5.1 | YES | integrity key | provider policy | worker |
| `NEWEBPAY_HASH_IV` | string | COND | `06` §5.1 | YES | integrity IV | provider policy | worker |
| `CVS_EMAP_CALLBACK_URL` | url | COND | `06` §5.1 | NO | CVS e-map callback; MUST be registered with the carrier service | with carrier config change | api |
| `CVS_711_STORE_CODE` | string | COND | `06` §5.1 | NO | carrier store identifier (business data, not a secret) | when store mapping changes | worker |
| `CVS_FAMILYMART_STORE_CODE` | string | COND | `06` §5.1 | NO | carrier store identifier | when store mapping changes | worker |
| `WHATSAPP_PHONE_NUMBER_ID` | string | COND | `06` §5.2 | NO | global messaging `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-001]` | provider policy | api, worker |
| `WHATSAPP_ACCESS_TOKEN` | string | COND | `06` §5.2 | YES | send token | provider policy | api, worker |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | string | COND | `06` §5.2 | YES | webhook challenge token | provider policy | api |
| `META_APP_ID` | string | COND | `06` §5.2 | NO | Meta app identity | provider policy | api |
| `META_APP_SECRET` | string | COND | `06` §5.2 | YES | app secret used for signature verification | provider policy | api |
| `INSTAGRAM_ACCOUNT_ID` | string | COND | `06` §5.2 | NO | account binding for messaging | n/a | api |
| `ZALO_OA_ID` | string | COND | `06` §5.2 | NO | Zalo OA identity | provider policy | api, worker |
| `ZALO_OA_SECRET` | string | COND | `06` §5.2 | YES | OA secret | provider policy | api |
| `ZALO_APP_ACCESS_TOKEN` | string | COND | `06` §5.2 | YES | send token | provider policy | api, worker |
| `TIKTOK_APP_ID` | string | COND | `06` §5.2 | NO | TikTok app identity | provider policy | api |
| `TIKTOK_APP_SECRET` | string | COND | `06` §5.2 | YES | app secret | provider policy | api |
| `TIKTOK_ACCESS_TOKEN` | string | COND | `06` §5.2 | YES | send token | provider policy | api, worker |
| `EMAIL_PROVIDER` | enum `sendgrid\|mailgun\|smtp` | COND | `06` §4.0 | NO | required together with the Email credential set when the channel is enabled; provider `[UNCONFIRMED][ASM-001]`; no default | n/a | worker |
| `EMAIL_FROM_ADDRESS` | email | COND | `06` §4.0 | NO | MUST be a verified sender domain in managed tiers | n/a | worker |
| `EMAIL_API_KEY` | string | COND | `06` §4.0 | YES | provider API key | provider policy | worker |
| `EMAIL_WEBHOOK_SIGNING_KEY` | string | COND | `06` §4.0 | YES | inbound event/link signature verification | provider policy | api |
| `SMS_PROVIDER` | enum `twilio\|chunghwa_telecom\|gateway_rest` | COND | `06` §4.0 | NO | required together with the SMS credential set when the channel is enabled; provider `[UNCONFIRMED][ASM-001]`; no default | n/a | worker |
| `SMS_SENDER_ID` | string | COND | `06` §4.0 | NO | alphanumeric sender identifier where the carrier supports it | with carrier registration | worker |
| `SMS_API_KEY` | string | COND | `06` §4.0 | YES | provider API key | provider policy | worker |
| `SMS_WEBHOOK_SIGNING_KEY` | string | COND | `06` §4.0 | YES | inbound delivery-status signature key | provider policy | api |
| `STRIPE_SECRET_KEY` | string | COND | `06` §5.2 `[OPTIONAL-EXTENSION]` | YES | test key in sandbox; live key only in production | provider policy | worker |
| `STRIPE_WEBHOOK_SECRET` | string | COND | `06` §5.2 | YES | webhook signature secret | provider policy | api |
| `PAYPAL_CLIENT_ID` | string | COND | `06` §5.2 | NO | OAuth client identity | provider policy | worker |
| `PAYPAL_CLIENT_SECRET` | string | COND | `06` §5.2 | YES | OAuth client secret | provider policy | worker |
| `PAYPAL_MODE` | enum `sandbox\|live` | COND | `06` §5.2 | NO | `live` MUST be rejected outside production | n/a | worker |
| `STORAGE_PROVIDER` | enum `s3\|r2\|local` | OPT (`s3`) | `06` | NO | `local` only in local/CI | n/a | api, worker |
| `STORAGE_ENDPOINT` | url | COND | `06` | NO | provider endpoint; must match the selected region/account | n/a | api, worker |
| `STORAGE_BUCKET` | string | COND | `06` | NO | one bucket per environment; no cross-tenant object paths | n/a | api, worker |
| `STORAGE_ACCESS_KEY_ID` | string | COND | `06` | YES | object-store identity (secret-grade) | provider/security policy | api, worker |
| `STORAGE_SECRET_ACCESS_KEY` | string | COND | `06` | YES | object-store secret | provider/security policy | api, worker |
| `STORAGE_REGION` | string | COND | `06` | NO | must match the endpoint and the data-residency decision `[OWNER-DECISION-REQUIRED]` | n/a | api, worker |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | url | OPT | `01` | NO | local collector; empty disables export (local/CI only) | n/a | api, worker |
| `OTEL_SERVICE_NAME` | string | OPT (`agentos-revenue-platform`) | `01` | NO | resource attribute used by trace correlation (NFR-002) | n/a | api, worker |
| `METRICS_PORT` | int 1–65535 | OPT (`9090`) | `01` | NO | Prometheus scrape port; MUST NOT be exposed publicly | n/a | api, worker |
| `COST_PER_1K_PROMPT_TOKENS_GPT4O` | float >0 | OPT (`0.005`) | `08` | NO | `[PROVISIONAL][ASM-002]` illustrative list price; never a contractual cost | update on provider price change with review | worker |
| `COST_PER_1K_COMPLETION_TOKENS_GPT4O` | float >0 | OPT (`0.015`) | `08` | NO | `[PROVISIONAL][ASM-002]` | as above | worker |
| `COST_PER_1K_PROMPT_TOKENS_MINI` | float >0 | OPT (`0.00015`) | `08` | NO | `[PROVISIONAL][ASM-002]` | as above | worker |
| `COST_PER_1K_COMPLETION_TOKENS_MINI` | float >0 | OPT (`0.0006`) | `08` | NO | `[PROVISIONAL][ASM-002]` | as above | worker |

### 8.3 Topology-only variables (rows 99–120)

These appear only in the target Compose blueprint (§2) or the staging/production topology (§2.2). They are infrastructure inputs; none is a business parameter, and none may be exposed to the browser or the storefront widget.

| Name | Type | Req | Owner | Secret | Safe placeholder / validation rule | Rotation | Consumer |
|---|---|---|---|---|---|---|---|
| `POSTGRES_DB` | string | COND (local Compose) | `01` | NO | local dev database name | n/a | postgres container |
| `POSTGRES_USER` | string | COND | `01` | NO | local bootstrap superuser; not the application role | n/a | postgres container |
| `POSTGRES_PASSWORD` | string | COND | `01` | YES | local-only placeholder; MUST be replaced in any shared environment | with role rotation | postgres container |
| `PGDATA` | path | COND | `01` | NO | container data directory; volume-mounted | n/a | postgres container |
| `QDRANT__SERVICE__HTTP_PORT` | int | COND | `01` | NO | must match `QDRANT_URL` | n/a | qdrant container |
| `QDRANT__SERVICE__GRPC_PORT` | int | COND | `01` | NO | gRPC listener | n/a | qdrant container |
| `QDRANT__SERVICE__ENABLE_CORS` | bool | COND | `01` | NO | `true` local only; MUST be `false` in managed tiers (no browser ingress) | n/a | qdrant container |
| `QDRANT__SERVICE__API_KEY` | string | COND | `03` | YES | must equal `QDRANT_API_KEY` | security runbook | qdrant container |
| `MOCK_SECRET_KEY` | string | COND (local/CI only) | `06` | YES | simulator-only secret; the simulator MUST NOT be deployed outside local/CI | n/a | mock |
| `SIMULATE_LATENCY_MS` | int ms | OPT (`50`) | `06` | NO | test-only latency injection | n/a | mock |
| `SIMULATE_FAILURE_RATE` | float 0–1 | OPT (`0.0`) | `06` | NO | test-only fault injection; used by timeout/quota test scenarios (§12) | n/a | mock |
| `DB` | enum `postgresql` | COND (Temporal) | `04` | NO | durable workflow store driver | n/a | temporal container |
| `DB_PORT` | int | COND | `04` | NO | must match the PostgreSQL listener | n/a | temporal container |
| `POSTGRES_PWD` | string | COND | `04` | YES | Temporal bootstrap credential `[UNCONFIRMED][ASM-001]`; prefer a dedicated role in managed tiers | with role rotation | temporal container |
| `POSTGRES_SEEDS` | host | COND | `04` | NO | Temporal database host | n/a | temporal container |
| `DYNAMIC_CONFIG_FILE_PATH` | path | OPT | `04` | NO | local dynamic-config path; production uses a managed config map | n/a | temporal container |
| `TEMPORAL_CORS_ORIGINS` | csv(url) | COND | `07` | NO | Temporal UI origin allowlist; UI is a local operator convenience only | n/a | temporal-ui container |
| `NEXTAUTH_URL` | url | MUST | `07` | NO | Command Center origin; must match the registered callback | n/a | cc |
| `NEXTAUTH_SECRET` | string ≥32 | MUST | `07` | YES | operator session secret; injected per environment | security runbook | cc |
| `NEXT_PUBLIC_API_URL` | url | MUST | `07` | NO | gateway **origin only** (scheme + host + port — e.g. `http://localhost:4000`); MUST NOT include the `/api/v1` suffix and MUST NOT carry any secret — browser clients append absolute `/api/v1/**` paths themselves (`07` §7.2; `02` §2 network edges) | n/a | cc |
| `POSTGRES_PRIMARY_URL` | postgres URI | COND (staging/production) | `03` | YES | write/transactional-read endpoint via the pooler; `sslmode=verify-full` | with role rotation | api, worker |
| `POSTGRES_REPLICA_URL` | postgres URI | COND (staging/production) | `03` | YES | read-only analytics endpoint; MUST NOT accept writes | with role rotation | api (SCR-001/002 reads) |

Catalog size: **120 variable rows** — 98 from `.env.example` (§3), 20 that appear only in the Compose blueprint (§2), and 2 topology URLs (§2.2). Known gap, to be closed before the dependent feature is enabled: the §4 Zod/Pydantic schemas now cover `APP_ENV`/`NODE_ENV`, the required secrets, the core data-store settings, and the optional adapter credential sets (with managed-profile placeholder rejection and all-or-nothing set checks), but still omit `JWT_EXPIRES_IN`, `TEMPORAL_*`, `REDIS_DB`, `SESSION_MUTEX_TTL_SECONDS`, storage credentials, and topology URLs; the validators MUST be extended to cover every `MUST` row above, and until then those variables are contract-defined here but not yet boot-enforced.

Two non-variable configuration items also live in the Compose blueprint and are catalogued for completeness: Redis container arguments (`--requirepass` = secret with the same rotation rule as `REDIS_PASSWORD`; `--maxmemory`, `--maxmemory-policy`, `--appendonly`, `--appendfsync` = `[PROVISIONAL]` capacity/durability settings owned by `03`), and the PgBouncer `pool_mode = transaction` setting (§2.2) which is an RLS invariant owned by `03` and MUST NOT be changed to session pooling without re-validating tenant-context reset.

## 9. Network and Trust Zones `[BLUEPRINT][SRS §19 / NFR-001, NFR-006]`

Default posture: deny by default, no ingress to the data zone, and no connection without an authenticated tenant context. Every edge below is a target contract, not a deployed configuration.

| # | Source zone | Destination zone | Protocol / direction | Authentication and authorization | Allowed payload | Explicitly forbidden |
|---|---|---|---|---|---|---|
| 1 | Browser / storefront widget | Gateway `/api/v1` | HTTPS + SSE/WS upgrade, inbound | Browser-safe session token only; tenant and customer identity derived server-side from the session binding (`07` widget contract) | Public conversation and storefront payloads | Enterprise secret in the client; client-asserted `tenant_id`, customer identity, authority, or approval |
| 2 | Operator browser (SCR-001..005) | Gateway `/api/v1` | HTTPS + SSE/WS, inbound | Authenticated operator session + tenant RBAC (`06` §8) | Tenant-scoped reads; approval/takeover mutations authorized in `07` | Cross-tenant reads; AUTH-5 queue entry; raw SQL; price/policy override outside `08` |
| 3 | Gateway process | Core engine / orchestrator | In-process module boundary | Import graph only (`02` §5 DAG) | Validated stage envelopes (`04` §2) | Any dispatch that bypasses the PEP (`08`) |
| 4 | Gateway / worker | PostgreSQL | PostgreSQL wire over TLS, outbound only | Least-privilege application role bound through `withTenantContext()` (RLS, `03` §2) | Tenant- and subject-scoped rows | Unscoped queries; the `BYPASSRLS` migration role outside migration runs |
| 5 | Gateway / worker | Redis | RESP (TLS in managed tiers), outbound only | Credential/ACL; all keys under `tenant:{tenant_id}:*` (`03` §3) | Cache, mutex, lease, idempotency reservation | Keys without tenant prefix; using Redis as the durable system of record |
| 6 | Worker | Qdrant | HTTPS/gRPC, outbound only | API key plus mandatory tenant payload filter (`03` §4) | Approved organizational-knowledge vectors | Unfiltered vector search; customer-private data promoted into shared knowledge |
| 7 | Worker | Durable workflow store (Temporal) | gRPC, outbound only | Namespace credential `[UNCONFIRMED][ASM-001]` | Workflow state and documented checkpoints (`04` §4.2) | Persisting raw conversation/Special-Category data as workflow payload |
| 8 | Gateway / worker | SoR (API-001) | HTTPS with mTLS/HMAC per adapter (`06` §9), outbound only | Adapter credential + tenant binding; the AI never queries the SoR database directly | Authoritative price/inventory/order reads; approved mutations | Reading the platform's own database as if it were the SoR; fabricated receipts |
| 9 | SoR, communication and payment providers | Gateway callbacks (API-002/API-003) | HTTPS, inbound | Provider signature/HMAC/mTLS verification + timestamp freshness window + dedup by `event_id`/`effect_key` | Inbound events and delivery receipts | Unsigned payloads; tenant taken from the body instead of the verified binding |
| 10 | Gateway / worker | Communication and payment providers | HTTPS, outbound | Provider token + consent check before outreach (`08` BR-004) + approval state for AUTH-4 classes | Outbound messages and payment intents within approval scope | Dispatch without consent or approval; AUTH-5 classes; sending under a human hold (`07` SCR-005) |
| 11 | Gateway / worker | OTel collector | OTLP over TLS, outbound | Collector credential | Traces/metrics with PII masking | Secrets, unmasked PII, or raw conversation bodies in span attributes |
| 12 | Operators / CI runners | Secret store | TLS, outbound | Workload identity or operator session `[UNCONFIRMED][ASM-001]` | Secret fetch at boot or deploy time | Secrets written into images, Compose files, repository files, or logs |
| 13 | Command Center container | PostgreSQL | **Prohibited** | — | None | Any direct database connection (`01` §8.3; `02` §5) |
| 14 | Public internet | PostgreSQL / Redis / Qdrant | **Prohibited** | — | None | Publishing 5432 / 6379 / 6333 / 6334 (or the mapped equivalents) beyond the private network |

## 10. Resource, Scaling, and Failure Bounds `[PROVISIONAL][ASM-002][SRS §19 / NFR-003, NFR-004, NFR-009, NFR-010]`

No resource may be unbounded. Each bound below is a target constant with an owner and an enforcement point; exceeding a bound produces the behavior in §11, never a silent degrade.

| Resource | Bounded target | Owner | Status | Enforcement point | Verified by |
|---|---|---|---|---|---|
| Database connections per process | `DATABASE_POOL_MIN` 5 / `DATABASE_POOL_MAX` 20 (§8.1) | `03` | `[PROVISIONAL][ASM-002]` | database package pool (the only owner of pool configuration) | §12 `ENV-07` |
| Pooler client ceiling | `max_client_conn` 2000, `default_pool_size` 50, transaction pooling (§2.2) | `03` / platform ops | `[PROVISIONAL][ASM-002]` | PgBouncer | §12 `ENV-07` |
| Redis memory and eviction | `maxmemory` 512 MB, `volatile-lru`, AOF `everysec` (local blueprint) | `03` | `[PROVISIONAL]` | Redis container configuration | §12 `ENV-06` |
| Worker concurrency | Bounded per tenant and per queue; no unbounded fan-out | `04` | `[PROVISIONAL][ASM-002]` | worker/orchestrator scheduler | §12 `ENV-04` |
| Vector query size | Bounded top-k per retrieval call | `03` (`03` §4) | `[PROVISIONAL]` | knowledge retrieval skill | §12 `ENV-08` |
| Widget bundle | Initial-token target ≈350 ms; gzipped bundle budget <18 KB (hard cap 20 KB) | `07` | `[PROVISIONAL][ASM-002]`, locked only by the NFR-009 benchmark | widget build (zero runtime deps) | §12 `ENV-12` |
| Conversational turn latency | p95 <1.5 s target | `04`, `07` | `[PROVISIONAL][ASM-002]`; not an SLA | gateway + streaming path | NFR-009 benchmark (`09` §6.3) |
| Retention — audit/evidence | Append-only, non-expiring unless a retention owner sets a policy | `03`, `08` | `[UNCONFIRMED][ASM-005]` for retention policy | append-only tables + hash chain | `03` §10 scenarios |
| Retention — idempotency | 72 h Redis window + permanent PostgreSQL uniqueness | `04` | `[PROVISIONAL]` design value (the SRS NFR-003 invariant is no duplicate effect, not the 72 h number) | Redis + unique constraint | §12 `ENV-09` |
| Memory-layer TTLs | Per-layer TTL from `03` §7 | `03` | `[UNCONFIRMED][ASM-005]` | memory manager | `03` §10 scenarios |
| Cost per session | ECN-003 session budget (design goal) | `08` | `[PROVISIONAL][ASM-002]`, `[OPTIONAL-EXTENSION]` | cost accounting (NFR-010) | `09` §6.3 |
| Provider quota | Per-provider ceiling with declared reset window | `06`, `08` | `[UNCONFIRMED][ASM-001]` | adapter dispatcher | §12 `ENV-10` |
| Log/metric retention | Per-environment, provisional | `01`, `08` | `[PROVISIONAL]` | observability pipeline | `09` CI artifacts |

## 11. Failure Matrix `[MUST][SRS §19 / NFR-004, NFR-008]`

| Failure | Detection | Immediate behavior | Retry / recovery | Fallback | Audit / evidence signal | Operator action |
|---|---|---|---|---|---|---|
| Missing required configuration | Boot-time schema validation (§4) | Refuse startup, exit non-zero; the error names the variable, never its value | None until corrected | None | Boot rejection record; gate failure | Provide the variable in env/secret store; restart |
| Invalid or placeholder secret in a managed profile | Format/length rules + placeholder denylist (§8 rules 1–2) | Refuse startup for the consuming process | None | None | Config-rejection event | Rotate/inject a real secret; verify no secret echoed in logs |
| Dependency timeout (PostgreSQL, Redis, Qdrant, SoR, LLM) | Bounded per-call timeout | Reads: bounded retry then fail closed. A dispatched mutation with no acknowledgement is recorded `execution_status='failed'` with `error.outcome='UNKNOWN'` (`04` §4.4) and reconciled by `effect_key` | Finite exponential backoff with jitter within the step deadline; `UNKNOWN` is never blind-retried | None for price, inventory, order, or receipt-dependent actions | Execution record + reconciliation record (`06` §1.1 retry route) | Reconcile from the persisted record; retry only when the failure is verified side-effect-free |
| TLS or signature failure (callback, SoR, provider) | Certificate/signature/timestamp verification (`06` §9) | Reject the request with a failure envelope; no effect and no queue entry | Never retry an unverified payload | None | Security event with request id | Repair trust material/provider config; investigate as a possible attack |
| Database unavailable | Readiness probe + query error class | Block stateful mutation and tenant-scoped reads (fail closed) | Finite backoff; no automatic migration repair | None; no local file substitute | Dependency-down event | Restore, then confirm no lost durable work and no partial write |
| Redis unavailable | Ping/mutex acquisition failure | Refuse mutex/lease acquisition and idempotency reservation ⇒ no mutation dispatch, no takeover, no local fallback lock | Finite backoff | None (a process-local lock MUST NOT be substituted) | Dependency-down event | Restore; check for split-brain lock risk before resuming dispatch |
| Qdrant unavailable | Readiness probe + search error | Knowledge answers disabled; the agent MUST NOT fabricate an answer | Bounded read retry | Answer only from approved non-vector sources or escalate to a human (`08`) | Degraded-knowledge event | Restore and re-index; verify citation presence |
| Provider quota exhausted / rate limited | Provider error class (rate-limit/quota) | Stop dispatch to that provider; queued work is retained, never silently dropped | Retry after the declared reset window with capped attempts | Only the declared safe fallback (defer + notify); switching provider requires owner approval | Quota event with deferred-item count | Raise quota or approve a channel change; re-drive deferred work |
| Migration or RLS probe failure | Migration rehearsal / readiness probe (`03` §9) | Refuse readiness; no partial migration is left applied silently | None automatic; fix forward with a new migration | None | Rehearsal failure artifact | Author a corrective migration; never destructively roll back audit/evidence |
| Secret store unreachable | Fetch error at boot/deploy | Refuse startup/deploy rather than reuse a stale cached value beyond process lifetime | Finite backoff | None | Config-source event | Restore the store; rotate anything suspected of exposure |
| OTel collector unreachable | Export error | Continue serving — audit/evidence writes go to PostgreSQL, not OTel, and MUST NOT be dropped | Bounded buffer/retry; drop metrics when the buffer is full | Local structured logs (trace gaps are `[NOT-RUNTIME-EVIDENCE]`) | Telemetry-gap event | Restore the collector; confirm audit chain integrity is unaffected |
| Clock skew across services | Signed-timestamp freshness window | Reject stale or future-dated callbacks; flag audit ordering anomalies | Resume after clock resync | None | Security/ordering event | Synchronize the time source; re-verify hash-chain ordering |

Cross-cutting rule: when the failure is a **missing owner-approved pricing floor decision**, the dispatch is refused with `P_FLOOR_UNAVAILABLE` (`08` §7.3) — never with a locally computed price, and never by queueing the action for approval (§5.1 guardrail; `README.md` §8.1).

## 12. Environment Verification Scenarios `[BLUEPRINT][SRS §19 / NFR-001, NFR-003, NFR-004, NFR-006, NFR-008]`

Every row below is a **specification for a future check**. Nothing here has been executed, and no environment exists in this repository: all rows are `[NOT-RUNTIME-EVIDENCE]`. Gate reference is `09` §7 (P0 unless noted).

| ID | Scenario | Precondition | Expected observable result | Evidence artifact | Gate |
|---|---|---|---|---|---|
| `ENV-01` | Configuration-schema rejection | Start the gateway with one `MUST` variable removed (§8) | Process exits non-zero during boot; the error names the variable and never prints its value; no traffic is served | Boot log + exit code | P0 |
| `ENV-02` | Placeholder rejection in a managed profile | Run with `APP_ENV=staging` and any `mock-*` / `example.invalid` / banner placeholder secret | Startup refused before any dependency connection is used for work | Config-rejection event | P0 |
| `ENV-03` | Invalid secret format | Supply `ENCRYPTION_KEY_AES256` with a wrong length (or an invalid `DATABASE_URL` scheme) | Startup refused; no fallback key or cropped value is silently accepted | Config-rejection event | P0 |
| `ENV-04` | Dependency readiness order and disabled-capability scoping | Boot the gateway before an enabled dependency reports ready (PostgreSQL always; Qdrant while knowledge answers are enabled). Then boot a profile with a capability disabled (`MOCK_ERP_ENABLED=false`, no durable workflow engine configured, or an uncredentialed adapter) | In the first case readiness stays false and no request is accepted; after recovery, readiness becomes true in the §7 order. In the second case the process boots and serves the remaining capabilities, and the disabled capability refuses with `CAPABILITY_NOT_ENABLED` instead of blocking startup | Readiness probe transcript + capability refusal | P0 |
| `ENV-05` | Tenant-context propagation | Issue a request under tenant A through the gateway | Every tenant-scoped query executes inside `withTenantContext()`; a query issued outside the wrapper returns zero rows rather than another tenant's rows (`03` §2, §10) | Query/audit trace | P0 |
| `ENV-06` | Redis outage mutex refusal | Stop Redis while a dispatch/takeover attempt is in flight | Dispatch and takeover are refused; no process-local lock substitutes; after restore no duplicate effect appears | Dependency-down event + effect count | P0 |
| `ENV-07` | Connection-bound enforcement | Drive concurrent load beyond `DATABASE_POOL_MAX` (§8.1) and the pooler ceiling (§2.2) | Connections stay bounded (queue or refusal); memory does not grow unbounded; no cross-tenant session reuse in transaction pooling | Pool metrics | P0 |
| `ENV-08` | Qdrant unavailable behavior | Stop Qdrant and request a knowledge-dependent answer | No fabricated answer; the path uses the approved non-vector fallback or escalates to a human; a degraded-knowledge event is recorded | Degraded event + response | P0 |
| `ENV-09` | Provider timeout with reconciliation | Inject a timeout after dispatch using `SIMULATE_FAILURE_RATE` (§8.3) | Execution is recorded `failed` with `error.outcome='UNKNOWN'`; the retry route refuses a blind retry; reconciliation resolves to exactly one external action (`04` §4.4; `06` §1.1) | Execution + reconciliation records | P0 |
| `ENV-10` | Provider quota exhaustion | Provider returns quota/rate-limit class errors | Dispatch stops for that provider, deferred work is retained (not dropped), and the quota event records the deferred count; recovery follows an owner-approved action | Quota event + deferred queue state | P0 |
| `ENV-11` | TLS/signature enforcement | Send an unsigned or stale-timestamp callback to the gateway | Request rejected with no side effect and no queue entry; security event recorded | Security event | P0 |
| `ENV-12` | No secret leakage in logs or UI | Run local and staging profiles with `LOG_LEVEL=debug` | Secret values/patterns appear zero times in logs, traces, and Command Center output; the widget bundle contains no enterprise secret | Log/trace scan result | P0 |
| `ENV-13` | Graceful shutdown without lost durable work | Send SIGTERM to the worker during a durable step | The step completes or is resumed from durable state after restart; no evidence/audit gap; leases released | Shutdown log + run history | P0 |
| `ENV-14` | Configuration catalog coverage (documentation check) | Compare §3 `.env.example` and the §2 Compose blueprint against §8 | Every variable appears exactly once in §8 with owner, secret class, and rotation; no variable is invented in the catalog | Catalog diff report | — |

A green `ENV-*` row proves environment behavior only for the environment and build under test; it never substitutes for the pilot evidence required by `09` §7–§8, and `ENV-14` is a documentation-consistency check, not runtime validation.
