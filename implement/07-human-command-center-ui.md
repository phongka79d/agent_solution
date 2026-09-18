# Implement 07: Human Command Center UI & Storefront Customer Widget Specification

## 1. System Overview & Architecture

The Human Command Center is the centralized operational and governance interface for the AI Revenue Platform. It provides business operators, sales supervisors, and customer support engineers with real-time observability, policy enforcement, interactive session takeovers, and auditability across all autonomous agents.

```
+-----------------------------------------------------------------------------------+
|                           Human Command Center (Next.js 14)                       |
|                                                                                   |
|  +-----------------+  +------------------+  +-----------------+  +-------------+  |
|  | SCR-001         |  | SCR-002          |  | SCR-003         |  | SCR-004     |  |
|  | Executive Dash  |  | Agent Operations |  | Approval Center |  | Cust 360    |  |
|  +-----------------+  +------------------+  +-----------------+  +-------------+  |
|  +-----------------------------------------------------------------------------+  |
|  | SCR-005: Conversation Console (Takeover Mutex, Copilot Draft, Score)        |  |
|  +-----------------------------------------------------------------------------+  |
|                                                                                   |
|         State Management: Zustand Stores (Telemetry, Approvals, Session)          |
+-----------------------------------------------------------------------------------+
              ^                                                 ^
              | SSE (/api/v1/telemetry/stream)                  | WS (/ws/v1/stream)
              v                                                 v
+-----------------------------------------------------------------------------------+
|                                Core Platform API Gateway                          |
|             (Tenant Context, Authentication, RBAC Interceptor, Rate Limiter)      |
+-----------------------------------------------------------------------------------+
                                        ^
                                        | postMessage Bridge (Cross-Origin RPC)
                                        v
+-----------------------------------------------------------------------------------+
|                       Storefront Customer Widget (< 20KB)                         |
|      (Vanilla TS Web Component, Shadow DOM, Offline Resilience, Mobile Safe)      |
+-----------------------------------------------------------------------------------+
```

### 1.1 Technical Stack & Component Boundary Strategy
- **Framework**: Next.js 14 using the App Router (`/app/(dashboard)` route group).
- **Rendering Architecture**: React Server Components (RSC) for initial page loads, static layout skeletons, server-side data fetching with Suspense boundaries; Client Components (`"use client"`) strictly isolated to interactive leaves, real-time widgets, and forms.
- **State Management**: Zustand stores with fine-grained selectors and `immer` middleware to eliminate unnecessary re-renders.
- **Real-Time Data Layer**:
  - **Server-Sent Events (SSE)** via HTTP/2 for unidirectional telemetry, live analytics streaming, and queue updates (`/api/v1/telemetry/stream`).
  - **WebSocket (`/ws/v1/stream`)** with exponential reconnect backoff and ping/pong heartbeats (30s interval) for bidirectional chat monitoring, operator keystroke sync, and session takeover mutex locking.
- **Styling & UI Library**: Tailwind CSS with CSS Variables for theming, Radix UI primitives for unstyled, accessible modals, tooltips, and dropdowns.
- **Icons**: Lucide-React SVG icons (strictly non-emoji UI).

### 1.2 Multi-Tenant Context & Session Propagation
Every incoming HTTP request and WebSocket handshake enforces strict multi-tenant context extraction:
1. The Edge Middleware (`middleware.ts`) extracts the `x-tenant-id` header or sub-domain origin, verifies the operator's JWT claims, and validates organization membership.
2. The authenticated context (`TenantContext: { tenantId: string, operatorId: string, role: OperatorRole }`) is injected into the React Component Tree via RSC headers and exposed to client hooks via a dedicated context provider.
3. Every mutating API call and WebSocket command automatically appends the cryptographic signature and `tenant_id` to prevent cross-tenant data leaks.

```typescript
/**
 * @file app/context/TenantContext.tsx
 * Context definition for multi-tenant propagation within Command Center.
 */
import React, { createContext, useContext, ReactNode } from 'react';

export interface TenantContextValue {
  readonly tenantId: string;
  readonly operatorId: string;
  readonly operatorName: string;
  readonly permissions: readonly string[];
}

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({
  value,
  children,
}: {
  readonly value: TenantContextValue;
  readonly children: ReactNode;
}) {
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider hierarchy.');
  }
  return context;
}
```

---

## 2. SCR-001: Executive Dashboard Specification

### 2.1 Screen Purpose & Real-Time KPIs
SCR-001 delivers high-level business intelligence to C-level executives, sales leaders, and marketing directors. It tracks aggregated revenue attribution, agent work volume, conversion lift, and operational anomalies.

```
+------------------------------------------------------------------------------------+
| EXECUTIVE DASHBOARD                                        Tenant: ACME-ECOM-01    |
+------------------------------------------------------------------------------------+
| [ Total Revenue ]     [ AI Attributed Rev ]   [ AI Conversion ]   [ Active Anom ]  |
| $1,284,500 (+14%)     $342,120 (26.6%)        4.82% (+1.2% vs BM) 0 Critical       |
+------------------------------------------------------------------------------------+
| REVENUE ATTRIBUTION STREAM (Real-time vs Baseline)                                 |
| [Line Chart: Total Rev vs Baseline Cohort vs Direct AI Assisted Cart Recovery]     |
+------------------------------------------------------------------------------------+
| AGENT ACTIVITY SPECTRUM               | REAL-TIME ANOMALY DETECTION ENGINE         |
| Marketing (MKT): 14,200 Actions       | [WARN] 09:14 Cart abandoned spike (+42%)   |
| Sales (SAL):      8,450 Interactions  | [INFO] 08:30 LLM latency stabilized 820ms  |
| Support (CS):    12,110 Tickets       | [OK]   All P_floor price boundaries intact |
+------------------------------------------------------------------------------------+
```

### 2.2 Component Hierarchy & Data Contracts
```
app/(dashboard)/executive/
├── page.tsx                           // Server Component (Data prefetch)
├── loading.tsx                        // Suspense Skeleton
├── components/
│   ├── MetricCardGrid.tsx             // RSC: Renders 4 primary KPI metrics
│   ├── RevenueAttributionChart.tsx    // Client Component: Streaming canvas
│   ├── AgentActivitySpectrum.tsx      // RSC + SSE hydration
│   └── AnomalyAlertFeed.tsx           // Client Component: WebSocket subscriber
```

#### Metric Payload Schema
```typescript
export interface ExecutiveMetricsPayload {
  readonly tenantId: string;
  readonly timestamp: string; // ISO 8601 UTC
  readonly metrics: {
    readonly totalRevenue: number;
    readonly organicBaselineRevenue: number;
    readonly aiAttributedRevenue: {
      readonly directCheckout: number;
      readonly cartRecovery: number;
      readonly crossSellUpsell: number;
      readonly total: number;
    };
    readonly conversionRate: {
      readonly aiAssisted: number;
      readonly unassisted: number;
      readonly relativeLiftPercent: number;
    };
    readonly activeAnomaliesCount: number;
  };
}
```

### 2.3 Real-Time Chart Implementation
The `RevenueAttributionChart` subscribes to the SSE channel `/api/v1/telemetry/stream?metric=revenue_attribution`. It buffers incoming data points and renders a multi-series area chart displaying Organic Baseline vs. AI Attributed Revenue with sliding 24-hour and 30-day timeframes.

```typescript
/**
 * @file components/executive/RevenueAttributionChart.tsx
 * Streaming revenue attribution chart component.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface AttributionPoint {
  readonly time: string;
  readonly baseline: number;
  readonly aiAttributed: number;
}

export function RevenueAttributionChart({ initialData }: { readonly initialData: AttributionPoint[] }) {
  const [dataPoints, setDataPoints] = useState<AttributionPoint[]>(initialData);

  useEffect(() => {
    const eventSource = new EventSource('/api/v1/telemetry/stream?metric=revenue_attribution');

    eventSource.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as AttributionPoint;
        setDataPoints((prev) => [...prev.slice(-47), payload]); // Keep trailing 48 intervals
      } catch (err) {
        console.error('Failed to parse SSE attribution payload', err);
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  return (
    <div className="w-full h-80 bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="text-sm font-semibold text-slate-200 mb-2">Revenue Attribution (USD)</div>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={dataPoints}>
          <XAxis dataKey="time" stroke="#64748b" fontSize={12} />
          <YAxis stroke="#64748b" fontSize={12} />
          <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155' }} />
          <Area type="monotone" dataKey="baseline" stackId="1" stroke="#38bdf8" fill="#0284c7" fillOpacity={0.2} />
          <Area type="monotone" dataKey="aiAttributed" stackId="1" stroke="#4ade80" fill="#22c55e" fillOpacity={0.4} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

---

## 3. SCR-002: Agent Operations Console Specification

### 3.1 Screen Purpose & Technical Telemetry
SCR-002 provides DevOps engineers and AI Operations teams with granular visibility into agent runtime states, execution latencies (p50, p90, p95, p99), external tool call failure rates, and execution stack traces.

```
+------------------------------------------------------------------------------------+
| AGENT OPERATIONS CONSOLE                                    Filter: [All Agents v] |
+------------------------------------------------------------------------------------+
| AGENT STATUS DIRECTORY                                                             |
| MKT-01 (Market Signal): [HEALTHY] Latency p95: 1,240ms | Active Runs: 4            |
| SAL-02 (Sales Advisor): [HEALTHY] Latency p95: 1,820ms | Active Runs: 28           |
| CS-01  (Support Care):  [DEGRADED] Latency p95: 3,420ms | Active Runs: 52 (ERP lag) |
+------------------------------------------------------------------------------------+
| EXECUTION RUN HISTORY (Virtual Table)                                              |
| Run ID      | Agent  | Trigger          | Status   | Latency | Authority | Action   |
| run-912a81  | SAL-04 | cart.abandoned   | SUCCESS  | 1,120ms | AUTH-3    | [Inspect]|
| run-881b42  | CS-01  | order.lookup     | FAILED   | 4,110ms | AUTH-3    | [Inspect]|
+------------------------------------------------------------------------------------+
| RUN INSPECTION DRAWER (run-881b42)                                                 |
| Trace ID: tr-9921-bc  | Correlation ID: corr-88129                                 |
| Tool Invocation: API-001.InventoryConnector -> HTTP 504 Gateway Timeout            |
| Error Stack: GatewayTimeoutException at WmsAdapter.fetchStockStatus (line 142)     |
| Raw Context Snapshot: { customer_id: "c-102", sku: "SKU-99", warehouse: "TW-01" } |
+------------------------------------------------------------------------------------+
```

### 3.2 Agent Operational Status Model
Each agent registers a heartbeat every 15 seconds. The status is derived as:
- `HEALTHY`: Heartbeat active within last 30s, p95 latency < 2,500ms, error rate < 1%.
- `DEGRADED`: Heartbeat active, but p95 latency >= 2,500ms OR error rate between 1% and 5%.
- `OFFLINE`: No heartbeat received for > 45s.
- `DRAINING`: Marked by operator; finishes current runs without accepting new triggers.

### 3.3 Run History & Virtualized Table Contract
```typescript
export interface AgentRunRecord {
  readonly runId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly trigger: string;
  readonly skill: string;
  readonly tool: string;
  readonly authority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
  readonly executionStatus: 'pending' | 'executing' | 'success' | 'failed' | 'denied' | 'aborted';
  readonly latencyMs: number;
  readonly tokenUsage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalCostTwd: number;
  };
  readonly errorDetails: {
    readonly errorCode: string;
    readonly message: string;
    readonly stackTrace: string;
  } | null;
  readonly startedAt: string;
  readonly completedAt: string;
}
```

### 3.4 React Component Implementation for SCR-002

#### 1. AgentStatusDirectory.tsx
```typescript
/**
 * @file components/operations/AgentStatusDirectory.tsx
 * Real-time agent status grid with health badges, p50/p95 latency metrics, and run counts.
 */
'use client';

import React from 'react';

export interface AgentHealthMetric {
  readonly agentId: string;
  readonly domain: 'MARKETING' | 'SALES' | 'CARE';
  readonly name: string;
  readonly status: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'DRAINING';
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly activeRuns: number;
  readonly errorRatePercent: number;
}

export function AgentStatusDirectory({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  readonly agents: readonly AgentHealthMetric[];
  readonly selectedAgentId: string | null;
  readonly onSelectAgent: (id: string | null) => void;
}) {
  const getBadgeClass = (status: AgentHealthMetric['status']) => {
    switch (status) {
      case 'HEALTHY':
        return 'bg-emerald-950 text-emerald-400 border-emerald-800';
      case 'DEGRADED':
        return 'bg-amber-950 text-amber-400 border-amber-800';
      case 'OFFLINE':
        return 'bg-rose-950 text-rose-400 border-rose-800';
      case 'DRAINING':
        return 'bg-slate-800 text-slate-300 border-slate-700';
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      {agents.map((agent) => (
        <div
          key={agent.agentId}
          onClick={() => onSelectAgent(selectedAgentId === agent.agentId ? null : agent.agentId)}
          className={`p-4 rounded-lg border cursor-pointer transition-all ${
            selectedAgentId === agent.agentId
              ? 'bg-slate-800 border-sky-500 shadow-md'
              : 'bg-slate-900 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold text-slate-100">{agent.agentId} - {agent.name}</div>
            <span className={`px-2 py-0.5 text-xs font-mono rounded border ${getBadgeClass(agent.status)}`}>
              {agent.status}
            </span>
          </div>
          <div className="text-xs text-slate-400 grid grid-cols-2 gap-y-1">
            <div>Latency p50: <span className="font-mono text-slate-200">{agent.latencyP50Ms}ms</span></div>
            <div>Latency p95: <span className="font-mono text-slate-200">{agent.latencyP95Ms}ms</span></div>
            <div>Active Runs: <span className="font-mono text-slate-200">{agent.activeRuns}</span></div>
            <div>Error Rate: <span className="font-mono text-slate-200">{agent.errorRatePercent}%</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

#### 2. RunInspectionDrawer.tsx
```typescript
/**
 * @file components/operations/RunInspectionDrawer.tsx
 * Slide-out drawer displaying run trace, tool calls, error stack traces, and retry triggers.
 */
'use client';

import React from 'react';
import { AgentRunRecord } from './AgentOperationsConsole';

export function RunInspectionDrawer({
  run,
  onClose,
  onRetry,
}: {
  readonly run: AgentRunRecord | null;
  readonly onClose: () => void;
  readonly onRetry: (runId: string) => Promise<void>;
}) {
  if (!run) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-slate-900 border-l border-slate-800 shadow-2xl z-50 p-6 overflow-y-auto flex flex-col justify-between">
      <div>
        <div className="flex justify-between items-center pb-4 border-b border-slate-800 mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100">Run Inspection: {run.runId}</h2>
            <p className="text-xs text-slate-400">Agent: {run.agentId} | Trigger: {run.trigger}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100"
          >
            Close
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div className="p-3 bg-slate-950 rounded border border-slate-800">
              <span className="text-slate-400">Execution Status:</span>
              <div className="font-mono font-bold mt-1 text-slate-200">{run.executionStatus.toUpperCase()}</div>
            </div>
            <div className="p-3 bg-slate-950 rounded border border-slate-800">
              <span className="text-slate-400">Latency / Authority:</span>
              <div className="font-mono font-bold mt-1 text-slate-200">{run.latencyMs}ms ({run.authority})</div>
            </div>
          </div>

          <div>
            <span className="text-xs font-semibold text-slate-300">Tool Binding:</span>
            <div className="mt-1 p-2 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-sky-400">
              {run.tool} ({run.skill})
            </div>
          </div>

          {run.errorDetails && (
            <div>
              <span className="text-xs font-semibold text-rose-400">Error Details & Stack Trace:</span>
              <div className="mt-1 p-3 bg-rose-950/40 border border-rose-900/60 rounded text-xs font-mono text-rose-200 overflow-x-auto">
                <div className="font-bold">{run.errorDetails.errorCode}: {run.errorDetails.message}</div>
                <pre className="mt-2 text-slate-400 whitespace-pre-wrap">{run.errorDetails.stackTrace}</pre>
              </div>
            </div>
          )}

          <div>
            <span className="text-xs font-semibold text-slate-300">Token & Resource Cost:</span>
            <div className="mt-1 p-3 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-slate-300 grid grid-cols-3 gap-2">
              <div>Prompt: {run.tokenUsage.promptTokens}</div>
              <div>Completion: {run.tokenUsage.completionTokens}</div>
              <div>Cost: {run.tokenUsage.totalCostTwd} TWD</div>
            </div>
          </div>
        </div>
      </div>

      <div className="pt-6 border-t border-slate-800 flex justify-end gap-3 mt-6">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          Dismiss
        </button>
        {run.executionStatus === 'failed' && (
          <button
            onClick={() => onRetry(run.runId)}
            className="px-4 py-2 rounded text-xs font-semibold bg-sky-600 text-white hover:bg-sky-500"
          >
            Retry Execution
          </button>
        )}
      </div>
    </div>
  );
}
```

#### 3. AgentOperationsConsole.tsx
```typescript
/**
 * @file components/operations/AgentOperationsConsole.tsx
 * Root client component for SCR-002: Agent Operations Console.
 */
'use client';

import React, { useState } from 'react';
import { AgentStatusDirectory, AgentHealthMetric } from './AgentStatusDirectory';
import { RunInspectionDrawer } from './RunInspectionDrawer';

export interface AgentRunRecord {
  readonly runId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly trigger: string;
  readonly skill: string;
  readonly tool: string;
  readonly authority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
  readonly executionStatus: 'pending' | 'executing' | 'success' | 'failed' | 'denied' | 'aborted';
  readonly latencyMs: number;
  readonly tokenUsage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalCostTwd: number;
  };
  readonly errorDetails: {
    readonly errorCode: string;
    readonly message: string;
    readonly stackTrace: string;
  } | null;
  readonly startedAt: string;
  readonly completedAt: string;
}

export function AgentOperationsConsole({
  initialAgents,
  initialRuns,
}: {
  readonly initialAgents: readonly AgentHealthMetric[];
  readonly initialRuns: readonly AgentRunRecord[];
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [inspectedRun, setInspectedRun] = useState<AgentRunRecord | null>(null);

  const filteredRuns = selectedAgentId
    ? initialRuns.filter((r) => r.agentId === selectedAgentId)
    : initialRuns;

  const handleRetry = async (runId: string) => {
    await fetch(`/api/v1/operations/runs/${runId}/retry`, { method: 'POST' });
    setInspectedRun(null);
  };

  return (
    <div className="p-6 bg-slate-950 min-h-screen text-slate-100">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-xl font-bold">SCR-002: Agent Operations Console</h1>
          <p className="text-xs text-slate-400">Technical telemetry, p50/p95 distribution, and execution run history.</p>
        </div>
      </div>

      <AgentStatusDirectory
        agents={initialAgents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
      />

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-slate-800 font-semibold text-sm flex justify-between items-center">
          <span>Execution Run History ({filteredRuns.length})</span>
          {selectedAgentId && (
            <button
              onClick={() => setSelectedAgentId(null)}
              className="text-xs text-sky-400 hover:underline"
            >
              Clear Filter
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono">
              <tr>
                <th className="p-3">Run ID</th>
                <th className="p-3">Agent</th>
                <th className="p-3">Trigger</th>
                <th className="p-3">Authority</th>
                <th className="p-3">Status</th>
                <th className="p-3">Latency</th>
                <th className="p-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-mono">
              {filteredRuns.map((run) => (
                <tr key={run.runId} className="hover:bg-slate-800/50">
                  <td className="p-3 text-slate-300">{run.runId.substring(0, 10)}...</td>
                  <td className="p-3 font-semibold text-slate-200">{run.agentId}</td>
                  <td className="p-3 text-slate-400">{run.trigger}</td>
                  <td className="p-3 text-slate-400">{run.authority}</td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] ${
                      run.executionStatus === 'success' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'
                    }`}>
                      {run.executionStatus}
                    </span>
                  </td>
                  <td className="p-3 text-slate-300">{run.latencyMs}ms</td>
                  <td className="p-3">
                    <button
                      onClick={() => setInspectedRun(run)}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-400"
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <RunInspectionDrawer
        run={inspectedRun}
        onClose={() => setInspectedRun(null)}
        onRetry={handleRetry}
      />
    </div>
  );
}
```

---

## 4. SCR-003: Approval Center Specification

### 4.1 Screen Purpose & Risk Governance
SCR-003 is the mandatory human-in-the-loop checkpoint for high-risk operations classified under **AUTH-4**. Operations are held in a durable `awaiting_human` state until an authorized human operator reviews and executes one of the 5 standardized actions.

### 4.2 Standardized 5 Actions Workflow
Every item in the approval queue supports exactly five atomic operations:

```
+-----------------------------------------------------------------------------+
| APPROVAL ITEM #APV-9812                               Status: AWAITING_HUMAN|
| Agent: MKT-05 | Campaign: Flash_Sale_Line_01 | Audience: 12,450 Users       |
| Triggered: 2026-09-18 09:10:00 UTC | Expiry TTL: 09:40:00 (30m countdown)  |
+-----------------------------------------------------------------------------+
| Action Payload Diff:                                                        |
|   Discount Code: "FLASH15" (15% off)                                        |
|   Estimated Budget Consumption: 186,750 TWD                                 |
|   Floor Price Compliance: PASS (All SKU prices >= P_floor)                   |
+-----------------------------------------------------------------------------+
| Available Operator Actions:                                                 |
|  [ 1. Approve ]      -> Signs payload with HMAC token, releases to queue    |
|  [ 2. Reject ]       -> Rejects with mandatory reason code, terminates task |
|  [ 3. Modify ]       -> Opens schema form to edit payload before re-check   |
|  [ 4. Pause ]        -> Freezes workflow step timer for investigation       |
|  [ 5. Cancel ]       -> Terminates run and releases all atomic reservations |
+-----------------------------------------------------------------------------+
```

1. **Approve**: Operator verifies evidence. Core generates a cryptographically signed approval ticket (`approver_id`, `timestamp`, `signature`), transitioning the task from `awaiting_human` to `queued` for execution.
2. **Reject**: Requires selection of a standardized rejection code (`BUDGET_EXCEEDED`, `BRAND_VIOLATION`, `UNACCEPTABLE_MARGIN`, `INAPPROPRIATE_TIMING`) plus freeform rationale. Transitions task to `stopped`.
3. **Modify**: Opens an in-place JSON / structured form editor. Changes to parameters (e.g., lowering discount from 15% to 10% or trimming target audience) re-trigger deterministic business rules validation. If validated, the operator then submits as approved.
4. **Pause**: Freezes the workflow execution timer without aborting. Sets state to `paused`. Used when internal inventory or external systems are undergoing maintenance.
5. **Cancel**: Irrevocably aborts the workflow run, marks status as `aborted`, logs the action in the immutable audit store, and immediately releases any held atomic budget or inventory reservations.

### 4.3 Zustand Approval State Store
```typescript
/**
 * @file stores/useApprovalStore.ts
 * State store managing pending AUTH-4 approval queue.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface ApprovalItem {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly riskReason: string;
  readonly expiresAt: string;
  readonly status: 'awaiting_human' | 'approved' | 'rejected' | 'paused' | 'cancelled';
}

interface ApprovalState {
  readonly items: Record<string, ApprovalItem>;
  readonly selectedItemId: string | null;
  readonly setQueue: (items: ApprovalItem[]) => void;
  readonly selectItem: (id: string | null) => void;
  readonly executeAction: (
    id: string,
    action: 'approve' | 'reject' | 'modify' | 'pause' | 'cancel',
    meta?: { reason?: string; modifiedPayload?: Record<string, unknown> }
  ) => Promise<void>;
}

export const useApprovalStore = create<ApprovalState>()(
  immer((set, get) => ({
    items: {},
    selectedItemId: null,
    setQueue: (items) => {
      set((state) => {
        state.items = items.reduce<Record<string, ApprovalItem>>((acc, item) => {
          acc[item.id] = item;
          return acc;
        }, {});
      });
    },
    selectItem: (id) => {
      set((state) => {
        state.selectedItemId = id;
      });
    },
    executeAction: async (id, action, meta) => {
      const target = get().items[id];
      if (!target) return;

      const response = await fetch(`/api/v1/approvals/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...meta }),
      });

      if (!response.ok) {
        throw new Error(`Failed to execute approval action: ${action}`);
      }

      set((state) => {
        if (action === 'approve') state.items[id].status = 'approved';
        if (action === 'reject') state.items[id].status = 'rejected';
        if (action === 'pause') state.items[id].status = 'paused';
        if (action === 'cancel') state.items[id].status = 'cancelled';
        if (action === 'modify' && meta?.modifiedPayload) {
          state.items[id].payload = meta.modifiedPayload;
          state.items[id].status = 'approved';
        }
      });
    },
  }))
);
```

### 4.4 React Component Implementation for SCR-003

#### 1. ApprovalQueueList.tsx
```typescript
/**
 * @file components/approvals/ApprovalQueueList.tsx
 * Interactive list displaying pending AUTH-4 approval requests with risk metrics and countdowns.
 */
'use client';

import React from 'react';
import { ApprovalItem } from '../../stores/useApprovalStore';

export function ApprovalQueueList({
  items,
  selectedId,
  onSelect,
}: {
  readonly items: readonly ApprovalItem[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const getStatusBadge = (status: ApprovalItem['status']) => {
    switch (status) {
      case 'awaiting_human':
        return 'bg-amber-950 text-amber-400 border-amber-800 animate-pulse';
      case 'approved':
        return 'bg-emerald-950 text-emerald-400 border-emerald-800';
      case 'rejected':
        return 'bg-rose-950 text-rose-400 border-rose-800';
      case 'paused':
        return 'bg-sky-950 text-sky-400 border-sky-800';
      case 'cancelled':
        return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const isSelected = item.id === selectedId;
        const expiresDate = new Date(item.expiresAt);
        const minutesLeft = Math.max(0, Math.round((expiresDate.getTime() - Date.now()) / 60000));

        return (
          <div
            key={item.id}
            onClick={() => onSelect(item.id)}
            className={`p-4 rounded-lg border cursor-pointer transition-all ${
              isSelected
                ? 'bg-slate-800 border-sky-500 shadow-md'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex justify-between items-start mb-2">
              <div>
                <span className="text-xs font-mono text-slate-400 mr-2">{item.id}</span>
                <span className="font-semibold text-sm text-slate-100">{item.title}</span>
              </div>
              <span className={`px-2 py-0.5 text-[10px] font-mono rounded border ${getStatusBadge(item.status)}`}>
                {item.status.toUpperCase()}
              </span>
            </div>

            <p className="text-xs text-slate-400 mb-3">{item.riskReason}</p>

            <div className="flex justify-between items-center text-[11px] text-slate-500 font-mono">
              <span>Agent: <strong className="text-slate-300">{item.agentId}</strong></span>
              <span>TTL Remaining: <strong className={minutesLeft < 10 ? 'text-rose-400' : 'text-amber-400'}>{minutesLeft}m</strong></span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

#### 2. ApprovalPayloadDiffModal.tsx
```typescript
/**
 * @file components/approvals/ApprovalPayloadDiffModal.tsx
 * Modal displaying action payload, editable parameters for "Modify", and the 5 governance buttons.
 */
'use client';

import React, { useState } from 'react';
import { ApprovalItem } from '../../stores/useApprovalStore';

export function ApprovalPayloadDiffModal({
  item,
  onClose,
  onExecute,
}: {
  readonly item: ApprovalItem | null;
  readonly onClose: () => void;
  readonly onExecute: (
    id: string,
    action: 'approve' | 'reject' | 'modify' | 'pause' | 'cancel',
    meta?: { reason?: string; modifiedPayload?: Record<string, unknown> }
  ) => Promise<void>;
}) {
  const [isModifying, setIsModifying] = useState(false);
  const [modifiedJson, setModifiedJson] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  if (!item) return null;

  const handleStartModify = () => {
    setModifiedJson(JSON.stringify(item.payload, null, 2));
    setIsModifying(true);
  };

  const handleSaveModify = async () => {
    try {
      const parsed = JSON.parse(modifiedJson);
      await onExecute(item.id, 'modify', { modifiedPayload: parsed });
      setIsModifying(false);
      onClose();
    } catch {
      alert('Invalid JSON in modified payload.');
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectReason.trim()) {
      alert('Rejection reason code is mandatory.');
      return;
    }
    await onExecute(item.id, 'reject', { reason: rejectReason });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-2xl w-full p-6 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center pb-4 border-b border-slate-800 mb-4">
          <div>
            <h3 className="font-bold text-lg text-slate-100">Review Approval #{item.id}</h3>
            <p className="text-xs text-slate-400">Agent: {item.agentId} | Risk Reason: {item.riskReason}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">Close</button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          <div className="p-3 bg-slate-950 rounded border border-slate-800">
            <span className="text-xs font-semibold text-slate-400 block mb-2">Payload Parameters:</span>
            {isModifying ? (
              <textarea
                value={modifiedJson}
                onChange={(e) => setModifiedJson(e.target.value)}
                className="w-full h-48 bg-slate-900 border border-slate-700 rounded p-2 text-xs font-mono text-emerald-400 outline-none"
              />
            ) : (
              <pre className="text-xs font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(item.payload, null, 2)}
              </pre>
            )}
          </div>

          {showRejectInput && (
            <div className="p-3 bg-rose-950/40 border border-rose-900/60 rounded">
              <label className="text-xs font-semibold text-rose-300 block mb-1">
                Mandatory Rejection Rationale Code:
              </label>
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. BUDGET_EXCEEDED, POOR_TIMING, MARGIN_VIOLATION"
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs text-slate-200 outline-none"
              />
            </div>
          )}
        </div>

        {/* 5 Standardized Actions Bar */}
        <div className="pt-4 border-t border-slate-800 flex justify-between items-center mt-4">
          <div className="flex gap-2">
            <button
              onClick={() => onExecute(item.id, 'pause')}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-sky-400"
            >
              Pause
            </button>
            <button
              onClick={() => onExecute(item.id, 'cancel')}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-400"
            >
              Cancel
            </button>
          </div>

          <div className="flex gap-2">
            {isModifying ? (
              <button
                onClick={handleSaveModify}
                className="px-4 py-1.5 rounded text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white"
              >
                Save & Approve
              </button>
            ) : (
              <button
                onClick={handleStartModify}
                className="px-3 py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-amber-400"
              >
                Modify
              </button>
            )}

            {showRejectInput ? (
              <button
                onClick={handleConfirmReject}
                className="px-4 py-1.5 rounded text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white"
              >
                Confirm Reject
              </button>
            ) : (
              <button
                onClick={() => setShowRejectInput(true)}
                className="px-3 py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-rose-400"
              >
                Reject
              </button>
            )}

            <button
              onClick={() => {
                onExecute(item.id, 'approve');
                onClose();
              }}
              className="px-4 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

#### 3. ApprovalCenter.tsx
```typescript
/**
 * @file components/approvals/ApprovalCenter.tsx
 * Main screen component for SCR-003: Approval Center.
 */
'use client';

import React from 'react';
import { useApprovalStore } from '../../stores/useApprovalStore';
import { ApprovalQueueList } from './ApprovalQueueList';
import { ApprovalPayloadDiffModal } from './ApprovalPayloadDiffModal';

export function ApprovalCenter() {
  const { items, selectedItemId, selectItem, executeAction } = useApprovalStore();
  const itemList = Object.values(items);
  const selectedItem = selectedItemId ? items[selectedItemId] ?? null : null;

  const pendingCount = itemList.filter((i) => i.status === 'awaiting_human').length;

  return (
    <div className="p-6 bg-slate-950 min-h-screen text-slate-100">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-xl font-bold">SCR-003: Approval Center</h1>
          <p className="text-xs text-slate-400">
            Mandatory governance checkpoint for high-risk AUTH-4 operations.
          </p>
        </div>
        <div className="px-3 py-1 bg-amber-950/60 border border-amber-800 rounded-full text-xs font-mono text-amber-400">
          Pending Sign-offs: {pendingCount}
        </div>
      </div>

      <div className="max-w-4xl">
        <ApprovalQueueList
          items={itemList}
          selectedId={selectedItemId}
          onSelect={selectItem}
        />
      </div>

      <ApprovalPayloadDiffModal
        item={selectedItem}
        onClose={() => selectItem(null)}
        onExecute={executeAction}
      />
    </div>
  );
}
```

---

## 5. SCR-004: Customer 360 & Timeline Console Specification

### 5.1 Screen Purpose & Unified Event Stream
SCR-004 consolidates all touchpoints across Web/Storefront, Marketing campaigns, Sales conversations, ERP order history, and Support tickets into a unified, chronological timeline.

```
+-----------------------------------------------------------------------------+
| CUSTOMER 360: LIN WEI-TING (ID: CUST-TW-88219)        Tier: VERIFIED (2FA)  |
| Lifetime Value: 34,200 TWD | AOV: 4,275 TWD | Churn Risk: LOW (Score 0.12)  |
| Consent: Marketing (YES, LINE OA) | Transactional (YES) | Opt-Out: NONE     |
+-----------------------------------------------------------------------------+
| UNIFIED TIMELINE                                                            |
| 09:12:00 [SUPPORT] Case #CAS-912 created. Intent: Shipping delay            |
|          Evidence: ERP Tracking #TW-8891 status DELAYED (Typhoon Warning)   |
| 08:45:10 [COMMERCE] Add to Cart: SKU-BAT-01 (Quantity: 1, Price: 2,500 TWD) |
| 08:42:00 [SALES] Chat Session initiated via Storefront Widget (Web)         |
| 08:30:00 [MARKETING] Clicked LINE Broadcast Campaign #CAMP-EV-09           |
|          Evidence: LINE webhook message_id msg-tw-99120                     |
+-----------------------------------------------------------------------------+
| FACT VS HYPOTHESIS DICHOTOMY DRAWER                                         |
| Verified Facts (Source of Truth):                                           |
|   - Purchased Gogoro S2 (ERP Serial #GOG-9921 on 2025-11-20)               |
|   - Delivery address verified: Da'an District, Taipei City                  |
| Inferred Hypotheses (AI Model Predictions):                                 |
|   - Commutes > 35km daily (Confidence: 0.88, Evidence: Battery swap cadence)|
|   - High price sensitivity for accessories (Confidence: 0.74)               |
+-----------------------------------------------------------------------------+
```

### 5.2 Identity Verification Tiers
1. **Tier 0: Anonymous Guest**: Device fingerprint or anonymous cookie identifier only. No access to historical orders or personal data.
2. **Tier 1: Identified Lead**: Phone number or email captured, unverified. May view cart, but cannot view previous delivery addresses.
3. **Tier 2: Verified Customer**: Authenticated via LINE Login, SMS OTP, or Storefront Session token. Authorized for real-time ERP order lookups and warranty cases.

### 5.3 Evidence Card Contract
Every critical timeline item links to an unalterable Evidence Card:
```typescript
export interface EvidenceCard {
  readonly evidenceId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly classification: 'FACT' | 'HYPOTHESIS';
  readonly sourceOfTruth: 'ERP' | 'POS' | 'WMS' | 'PAYMENT_GATEWAY' | 'AI_INFERENCE';
  readonly confidenceScore: number; // 1.0 for FACT; 0.0-0.99 for HYPOTHESIS
  readonly rawRecordRef: {
    readonly system: string;
    readonly externalId: string;
    readonly verifiedAt: string;
  };
  readonly payload: Record<string, unknown>;
}
```

### 5.4 React Component Implementation for SCR-004

#### 1. FactHypothesisDrawer.tsx
```typescript
/**
 * @file components/customer/FactHypothesisDrawer.tsx
 * Slide-out drawer displaying verified Facts vs. AI-inferred Hypotheses with evidence cards.
 */
'use client';

import React from 'react';
import { EvidenceCard } from './Customer360Timeline';

export function FactHypothesisDrawer({
  evidenceCards,
  isOpen,
  onClose,
}: {
  readonly evidenceCards: readonly EvidenceCard[];
  readonly isOpen: boolean;
  readonly onClose: () => void;
}) {
  if (!isOpen) return null;

  const facts = evidenceCards.filter((e) => e.classification === 'FACT');
  const hypotheses = evidenceCards.filter((e) => e.classification === 'HYPOTHESIS');

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-slate-900 border-l border-slate-800 shadow-2xl z-50 p-6 overflow-y-auto">
      <div className="flex justify-between items-center pb-4 border-b border-slate-800 mb-6">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Fact vs. Hypothesis Dichotomy</h2>
          <p className="text-xs text-slate-400">Strict segregation between ground truth and AI inferences.</p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">Close</button>
      </div>

      <div className="space-y-6">
        {/* Verified Facts Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider">
              Verified Facts ({facts.length})
            </h3>
          </div>
          <div className="space-y-2">
            {facts.map((fact) => (
              <div key={fact.evidenceId} className="p-3 bg-slate-950 rounded border border-emerald-950">
                <div className="flex justify-between text-xs font-mono text-slate-400 mb-1">
                  <span>Source: <strong className="text-emerald-300">{fact.sourceOfTruth}</strong></span>
                  <span>ID: {fact.rawRecordRef.externalId}</span>
                </div>
                <div className="text-xs text-slate-200">{fact.eventType}</div>
                <pre className="mt-2 text-[11px] font-mono text-slate-400 bg-slate-900 p-2 rounded overflow-x-auto">
                  {JSON.stringify(fact.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>

        {/* Inferred Hypotheses Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
            <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">
              Inferred Hypotheses ({hypotheses.length})
            </h3>
          </div>
          <div className="space-y-2">
            {hypotheses.map((hyp) => (
              <div key={hyp.evidenceId} className="p-3 bg-slate-950 rounded border border-amber-950">
                <div className="flex justify-between text-xs font-mono text-slate-400 mb-1">
                  <span>Model Confidence: <strong className="text-amber-400">{Math.round(hyp.confidenceScore * 100)}%</strong></span>
                  <span>Source: {hyp.sourceOfTruth}</span>
                </div>
                <div className="text-xs text-slate-200 mb-1">{hyp.eventType}</div>
                <pre className="text-[11px] font-mono text-slate-400 bg-slate-900 p-2 rounded overflow-x-auto">
                  {JSON.stringify(hyp.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

#### 2. Customer360Timeline.tsx
```typescript
/**
 * @file components/customer/Customer360Timeline.tsx
 * Unified chronological event timeline for SCR-004: Customer 360.
 */
'use client';

import React, { useState } from 'react';
import { FactHypothesisDrawer } from './FactHypothesisDrawer';

export interface TimelineEvent {
  readonly eventId: string;
  readonly domain: 'MARKETING' | 'SALES' | 'COMMERCE' | 'SUPPORT';
  readonly eventType: string;
  readonly summary: string;
  readonly timestamp: string;
  readonly evidenceCard?: EvidenceCard;
}

export interface EvidenceCard {
  readonly evidenceId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly classification: 'FACT' | 'HYPOTHESIS';
  readonly sourceOfTruth: 'ERP' | 'POS' | 'WMS' | 'PAYMENT_GATEWAY' | 'AI_INFERENCE';
  readonly confidenceScore: number;
  readonly rawRecordRef: {
    readonly system: string;
    readonly externalId: string;
    readonly verifiedAt: string;
  };
  readonly payload: Record<string, unknown>;
}

export function Customer360Timeline({
  customerProfile,
  timelineEvents,
}: {
  readonly customerProfile: {
    readonly customerId: string;
    readonly name: string;
    readonly tier: 'GUEST' | 'IDENTIFIED' | 'VERIFIED';
    readonly ltvTwd: number;
    readonly aovTwd: number;
    readonly churnRiskScore: number;
  };
  readonly timelineEvents: readonly TimelineEvent[];
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const evidenceCards = timelineEvents
    .map((e) => e.evidenceCard)
    .filter((e): e is EvidenceCard => Boolean(e));

  const getDomainColor = (domain: TimelineEvent['domain']) => {
    switch (domain) {
      case 'MARKETING': return 'text-purple-400 border-purple-800 bg-purple-950/40';
      case 'SALES': return 'text-blue-400 border-blue-800 bg-blue-950/40';
      case 'COMMERCE': return 'text-emerald-400 border-emerald-800 bg-emerald-950/40';
      case 'SUPPORT': return 'text-amber-400 border-amber-800 bg-amber-950/40';
    }
  };

  return (
    <div className="p-6 bg-slate-950 min-h-screen text-slate-100">
      {/* Customer Header Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-bold">{customerProfile.name}</h1>
            <span className="text-xs font-mono text-slate-400">({customerProfile.customerId})</span>
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${
              customerProfile.tier === 'VERIFIED'
                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                : 'bg-slate-800 text-slate-400'
            }`}>
              Tier: {customerProfile.tier}
            </span>
          </div>
          <div className="flex gap-4 text-xs text-slate-400 font-mono">
            <span>LTV: <strong className="text-slate-200">{customerProfile.ltvTwd.toLocaleString()} TWD</strong></span>
            <span>AOV: <strong className="text-slate-200">{customerProfile.aovTwd.toLocaleString()} TWD</strong></span>
            <span>Churn Risk: <strong className="text-emerald-400">{customerProfile.churnRiskScore}</strong></span>
          </div>
        </div>

        <button
          onClick={() => setDrawerOpen(true)}
          className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700"
        >
          View Facts & Hypotheses ({evidenceCards.length})
        </button>
      </div>

      {/* Unified Timeline Feed */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h2 className="text-sm font-bold text-slate-200 mb-4 uppercase tracking-wider">Unified Event Timeline</h2>
        <div className="relative border-l border-slate-800 ml-4 space-y-6">
          {timelineEvents.map((evt) => (
            <div key={evt.eventId} className="relative pl-6">
              <span className="absolute -left-1.5 top-1 w-3 h-3 rounded-full bg-slate-700 border-2 border-slate-900"></span>
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-2 py-0.5 text-[10px] font-mono rounded border ${getDomainColor(evt.domain)}`}>
                  {evt.domain}
                </span>
                <span className="text-xs font-semibold text-slate-200">{evt.eventType}</span>
                <span className="text-[11px] text-slate-500 font-mono ml-auto">
                  {new Date(evt.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-xs text-slate-400">{evt.summary}</p>
              {evt.evidenceCard && (
                <div className="mt-2 text-[11px] font-mono text-slate-400 bg-slate-950 p-2 rounded border border-slate-800/80 flex justify-between items-center">
                  <span>Evidence: [{evt.evidenceCard.classification}] via {evt.evidenceCard.sourceOfTruth}</span>
                  <span className="text-sky-400">Ref: {evt.evidenceCard.rawRecordRef.externalId}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <FactHypothesisDrawer
        evidenceCards={evidenceCards}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
```

---

## 6. SCR-005: Conversation Console Specification

### 6.1 Screen Purpose & Live Supervision
SCR-005 allows human operators to monitor live customer-agent dialogues across Web, LINE OA, and WhatsApp. It features a distributed mutex lock for immediate session takeover, automated Copilot draft suggestions, and post-resolution dialogue evaluation scoring.

```
+------------------------------------------------------------------------------------+
| CONVERSATION CONSOLE: Session #SES-9821                                           |
| Channel: LINE OA | Customer: CUST-TW-88219 | Status: AI_CONTROLLED                |
+------------------------------------------------------------------------------------+
| MESSAGE HISTORY                                                                    |
| [09:10:02] Customer: When will my replacement battery arrive?                      |
| [09:10:04] AI (CS-01): Tracking shows expected delivery by 5 PM today at 7-Eleven.|
| [09:10:20] Customer: That is too late! I have an emergency trip at 2 PM!          |
|                                                                                    |
| OPERATOR CONTROLS:                                                                 |
| [ TAKE OVER SESSION ] -> Acquires Mutex Lock, Silences AI Responses Instantly      |
+------------------------------------------------------------------------------------+
| COPILOT ASSISTANT (Operator Draft Mode - AUTH-2)                                   |
| AI Suggested Response:                                                             |
| "I understand your urgency. I can reroute the parcel to a fast-dispatch depot     |
| nearby or coordinate an immediate battery swap at Showroom X."                     |
| [ Insert into Composer ] [ Regenerate ] [ Discard ]                                |
+------------------------------------------------------------------------------------+
| OPERATOR COMPOSER                                                                  |
| [ Type message to customer...                                            ] [ Send ]|
| Mode: HUMAN_ACTIVE (Bot hard-locked)                      [ RESUME AI CONTROL ]   |
+------------------------------------------------------------------------------------+
```

### 6.2 Session Takeover Mutex Lock Architecture

#### State Machine Sequence
```
     +---------------+
     | AI_CONTROLLED |
     +---------------+
             |
             | Customer escalation / Operator clicks "Takeover"
             v
  +----------------------+
  |  HANDOVER_REQUESTED  |
  +----------------------+
             |
             | Distributed Redis Lock acquired: SET mutex:session:{id}
             v
   +--------------------+
   |   HUMAN_TAKEOVER   | <--- AI Agent hard-locked (AUTH-5 for outbound messages)
   +--------------------+      AI switches to Copilot Mode (AUTH-2 internal drafts)
             |
             | Operator finishes intervention, clicks "Resume AI"
             v
   +--------------------+
   |   RESUME_AUDIT     | <--- Re-validates consent, context, and pending orders
   +--------------------+
             |
             | Redis Lock released
             v
     +---------------+
     | AI_CONTROLLED |
     +---------------+
```

#### Mutex Lock Technical Implementation
The session lock is enforced at the server API layer via Redis Distributed Locks (Redlock pattern) with a sliding TTL:
- Key format: `session:mutex:{tenant_id}:{session_id}`
- Value: `{ "operator_id": "OP-99", "acquired_at": "2026-09-18T09:11:00Z" }`
- When locked, any incoming message generation task dispatched by the Core Orchestrator for that session is terminated with HTTP `409 Conflict: Session Locked by Human Operator`.

```typescript
/**
 * @file server/services/SessionMutexService.ts
 * Redis-backed distributed mutex lock for human takeover.
 */
import Redis from 'ioredis';

export class SessionMutexService {
  private readonly redis: Redis;

  constructor(redisClient: Redis) {
    this.redis = redisClient;
  }

  public async acquireTakeover(
    tenantId: string,
    sessionId: string,
    operatorId: string,
    ttlSeconds = 900
  ): Promise<boolean> {
    const key = `session:mutex:${tenantId}:${sessionId}`;
    const payload = JSON.stringify({
      operatorId,
      acquiredAt: new Date().toISOString(),
    });

    // SET key value NX EX ttl
    const result = await this.redis.set(key, payload, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  public async releaseTakeover(tenantId: string, sessionId: string, operatorId: string): Promise<boolean> {
    const key = `session:mutex:${tenantId}:${sessionId}`;
    const luaScript = `
      local current = redis.call('get', KEYS[1])
      if not current then return 1 end
      local data = cjson.decode(current)
      if data.operatorId == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(luaScript, 1, key, operatorId);
    return result === 1;
  }

  public async isLocked(tenantId: string, sessionId: string): Promise<boolean> {
    const key = `session:mutex:${tenantId}:${sessionId}`;
    const exists = await this.redis.exists(key);
    return exists === 1;
  }
}
```

### 6.3 Copilot Draft Mode & Evaluation Scoring
- **Copilot Draft Mode**: While the session is under `HUMAN_TAKEOVER`, the background agent continues streaming suggested drafts to the operator's workspace via WebSocket. These suggestions are strictly tagged with `AUTH-2` (Internal Draft) and are completely invisible to the storefront customer.
- **Dialogue Quality Evaluation (Human Evaluation Score)**: Upon session resolution, the operator assigns a mandatory score:
  - Rating: 1 to 5 Stars.
  - Category Flags: `ACCURACY`, `BRAND_VOICE`, `LATENCY`, `REASONING_COMPLIANCE`.
  - Stored directly into the `EvaluationStore` to feed the learning and prompt optimization memory cycle.

### 6.4 React Component Implementation & Custom Hook for SCR-005

#### 1. useSessionTakeover.ts (Custom Hook)
```typescript
/**
 * @file hooks/useSessionTakeover.ts
 * Custom hook maintaining distributed mutex lock with 30s renewal heartbeat and automatic unmount release.
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export function useSessionTakeover({
  tenantId,
  sessionId,
  operatorId,
}: {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly operatorId: string;
}) {
  const [isTakenOver, setIsTakenOver] = useState(false);
  const [copilotDraft, setCopilotDraft] = useState<string | null>(null);
  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);

  const releaseLock = useCallback(async () => {
    try {
      await fetch(`/api/v1/sessions/${sessionId}/takeover`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify({ operatorId }),
      });
    } catch (err) {
      console.error('Failed to release takeover mutex', err);
    } finally {
      setIsTakenOver(false);
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    }
  }, [sessionId, tenantId, operatorId]);

  const acquireLock = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}/takeover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify({ operatorId, ttlSeconds: 60 }),
      });

      if (!response.ok) return false;

      setIsTakenOver(true);

      // Start 30s heartbeat to renew Redis mutex lock
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = setInterval(async () => {
        try {
          await fetch(`/api/v1/sessions/${sessionId}/takeover/heartbeat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-tenant-id': tenantId,
            },
            body: JSON.stringify({ operatorId, extendSeconds: 60 }),
          });
        } catch (err) {
          console.error('Takeover heartbeat failed', err);
        }
      }, 30_000);

      return true;
    } catch {
      return false;
    }
  }, [sessionId, tenantId, operatorId]);

  // Clean up lock on component unmount or browser tab navigation
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isTakenOver) {
        navigator.sendBeacon(
          `/api/v1/sessions/${sessionId}/takeover/release-beacon`,
          JSON.stringify({ tenantId, operatorId })
        );
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (isTakenOver) {
        releaseLock();
      }
    };
  }, [isTakenOver, sessionId, tenantId, operatorId, releaseLock]);

  return {
    isTakenOver,
    copilotDraft,
    setCopilotDraft,
    acquireLock,
    releaseLock,
  };
}
```

#### 2. TakeoverControls.tsx
```typescript
/**
 * @file components/conversation/TakeoverControls.tsx
 * Control bar for operator takeover, AI silencer, resume command, and evaluation trigger.
 */
'use client';

import React from 'react';

export function TakeoverControls({
  isTakenOver,
  onTakeover,
  onResume,
  onOpenEvaluation,
}: {
  readonly isTakenOver: boolean;
  readonly onTakeover: () => Promise<void>;
  readonly onResume: () => Promise<void>;
  readonly onOpenEvaluation: () => void;
}) {
  return (
    <div className="p-3 bg-slate-900 border-b border-slate-800 flex justify-between items-center">
      <div className="flex items-center gap-3">
        <span className={`w-3 h-3 rounded-full ${isTakenOver ? 'bg-amber-500 animate-ping' : 'bg-emerald-500'}`} />
        <span className="text-xs font-mono font-semibold text-slate-200">
          Control Mode: {isTakenOver ? 'HUMAN_OPERATOR (Bot Silenced)' : 'AUTONOMOUS_AI_ACTIVE'}
        </span>
      </div>

      <div className="flex gap-2">
        {isTakenOver ? (
          <>
            <button
              onClick={onOpenEvaluation}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300"
            >
              Rate Dialogue
            </button>
            <button
              onClick={onResume}
              className="px-4 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm"
            >
              Resume AI Control
            </button>
          </>
        ) : (
          <button
            onClick={onTakeover}
            className="px-4 py-1.5 rounded text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white shadow-sm"
          >
            Take Over Session
          </button>
        )}
      </div>
    </div>
  );
}
```

#### 3. CopilotComposer.tsx
```typescript
/**
 * @file components/conversation/CopilotComposer.tsx
 * Operator chat composer with AI Copilot draft suggestion card (AUTH-2).
 */
'use client';

import React, { useState } from 'react';

export function CopilotComposer({
  copilotDraft,
  onSendMessage,
  onDiscardDraft,
}: {
  readonly copilotDraft: string | null;
  readonly onSendMessage: (content: string) => Promise<void>;
  readonly onDiscardDraft: () => void;
}) {
  const [inputText, setInputText] = useState('');

  const handleSend = async () => {
    if (!inputText.trim()) return;
    await onSendMessage(inputText);
    setInputText('');
  };

  const handleApplyDraft = () => {
    if (copilotDraft) {
      setInputText(copilotDraft);
      onDiscardDraft();
    }
  };

  return (
    <div className="p-4 bg-slate-900 border-t border-slate-800 space-y-3">
      {/* Copilot Suggested Response Card (AUTH-2 Draft Mode) */}
      {copilotDraft && (
        <div className="p-3 bg-slate-950 border border-sky-900/60 rounded-lg">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[11px] font-mono font-semibold text-sky-400">
              Copilot Suggestion (AUTH-2 Internal Draft)
            </span>
            <div className="flex gap-2">
              <button
                onClick={handleApplyDraft}
                className="text-xs text-sky-300 hover:underline font-semibold"
              >
                Insert Draft
              </button>
              <button
                onClick={onDiscardDraft}
                className="text-xs text-slate-500 hover:text-slate-400"
              >
                Discard
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-300 italic">{copilotDraft}</p>
        </div>
      )}

      {/* Operator Keystroke Input Bar */}
      <div className="flex gap-2">
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type message to customer as human operator (Enter to send)..."
          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 outline-none resize-none h-16"
        />
        <button
          onClick={handleSend}
          className="px-5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold self-end h-10"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

#### 4. ConversationConsole.tsx
```typescript
/**
 * @file components/conversation/ConversationConsole.tsx
 * Root component for SCR-005: Conversation Console.
 */
'use client';

import React, { useState } from 'react';
import { useSessionTakeover } from '../../hooks/useSessionTakeover';
import { TakeoverControls } from './TakeoverControls';
import { CopilotComposer } from './CopilotComposer';

export interface ChatMessage {
  readonly id: string;
  readonly sender: 'customer' | 'ai' | 'operator';
  readonly content: string;
  readonly timestamp: string;
}

export function ConversationConsole({
  tenantId,
  sessionId,
  operatorId,
  initialMessages,
}: {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly operatorId: string;
  readonly initialMessages: readonly ChatMessage[];
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([...initialMessages]);
  const { isTakenOver, copilotDraft, setCopilotDraft, acquireLock, releaseLock } = useSessionTakeover({
    tenantId,
    sessionId,
    operatorId,
  });

  const handleSendMessage = async (text: string) => {
    const newMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: 'operator',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newMsg]);

    await fetch(`/api/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({ content: text, sender: 'operator' }),
    });
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      <TakeoverControls
        isTakenOver={isTakenOver}
        onTakeover={async () => {
          await acquireLock();
          setCopilotDraft('I can verify that for you immediately and reroute your order.');
        }}
        onResume={releaseLock}
        onOpenEvaluation={() => alert('Evaluation Modal opened: Rate dialogue quality (1-5 stars).')}
      />

      {/* Message Stream */}
      <div className="flex-1 p-6 overflow-y-auto space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.sender === 'customer' ? 'items-start' : 'items-end'
            }`}
          >
            <div className="flex items-center gap-2 mb-1 text-[11px] text-slate-400 font-mono">
              <span>{msg.sender.toUpperCase()}</span>
              <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
            </div>
            <div
              className={`p-3 rounded-xl max-w-lg text-xs leading-relaxed ${
                msg.sender === 'customer'
                  ? 'bg-slate-900 border border-slate-800 text-slate-200'
                  : msg.sender === 'operator'
                  ? 'bg-amber-600 text-white'
                  : 'bg-sky-700 text-white'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
      </div>

      <CopilotComposer
        copilotDraft={isTakenOver ? copilotDraft : null}
        onSendMessage={handleSendMessage}
        onDiscardDraft={() => setCopilotDraft(null)}
      />
    </div>
  );
}
```

---

## 7. Storefront Customer Widget Specification

### 7.1 Architectural Constraints & Performance Budget
The Storefront Customer Widget is an ultra-lightweight client script embedded on merchant e-commerce storefronts.

| Metric / Parameter | Mandatory Constraint | Enforcement Method |
|---|---|---|
| **Bundle Size Budget** | **< 20 KB (gzipped)** | Webpack / Rollup bundle analyzer CI threshold |
| **Runtime Dependencies** | Zero external frameworks (Vanilla TS) | No React, Vue, or Svelte compiled inside bundle |
| **DOM Isolation** | Strict Shadow DOM (`mode: "closed"`) | Custom Web Component `<agent-storefront-widget>` |
| **Cumulative Layout Shift (CLS)** | **0.00** | Fixed positioned host element with isolated layout |
| **Storage Constraint** | SessionStorage only for conversation ID | Zero secrets, zero API credentials stored client-side |

### 7.2 Web Component Implementation
```typescript
/**
 * @file storefront/AgentStorefrontWidget.ts
 * Zero-dependency Vanilla TS Web Component with Shadow DOM, Offline Queue, Streaming Fetch, and postMessage Bridge.
 */

interface QueuedMessage {
  readonly id: string;
  readonly message: string;
  readonly timestamp: number;
}

class AgentStorefrontWidget extends HTMLElement {
  private shadow: ShadowRoot;
  private isOpen = false;
  private tenantId = '';
  private apiUrl = '';
  private offlineQueueKey = 'agent_storefront_offline_queue';

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'closed' });
  }

  static get observedAttributes(): string[] {
    return ['tenant-id', 'api-url'];
  }

  public attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    if (name === 'tenant-id') this.tenantId = newValue;
    if (name === 'api-url') this.apiUrl = newValue;
  }

  public connectedCallback(): void {
    this.render();
    this.attachEventListeners();
    this.initPostMessageBridge();
    this.initNetworkRecovery();
  }

  private render(): void {
    this.shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .launcher-btn {
          width: 56px;
          height: 56px;
          border-radius: 28px;
          background: var(--agent-brand-color, #0284c7);
          color: #ffffff;
          border: none;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .launcher-btn:hover {
          transform: scale(1.05);
        }
        .chat-container {
          display: none;
          width: 380px;
          height: 580px;
          max-width: calc(100vw - 40px);
          max-height: calc(100vh - 100px);
          background: #ffffff;
          border-radius: 16px;
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.2);
          overflow: hidden;
          flex-direction: column;
        }
        .chat-container.active {
          display: flex;
        }
        .chat-header {
          padding: 16px;
          background: var(--agent-brand-color, #0284c7);
          color: #ffffff;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 600;
        }
        .chat-body {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
          background: #f8fafc;
        }
        .chat-footer {
          padding: 12px;
          border-top: 1px solid #e2e8f0;
          display: flex;
          gap: 8px;
        }
        .chat-input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          outline: none;
          font-size: 14px;
        }
        .send-btn {
          padding: 8px 16px;
          background: var(--agent-brand-color, #0284c7);
          color: #ffffff;
          border: none;
          border-radius: 8px;
          cursor: pointer;
        }
      </style>

      <div class="chat-container" id="chatContainer">
        <div class="chat-header">
          <span>Customer Support Assistant</span>
          <button id="closeBtn" style="background:none;border:none;color:#fff;cursor:pointer;font-size:16px;">X</button>
        </div>
        <div class="chat-body" id="chatBody"></div>
        <div class="chat-footer">
          <input type="text" class="chat-input" id="chatInput" placeholder="Ask a question..." />
          <button class="send-btn" id="sendBtn">Send</button>
        </div>
      </div>

      <button class="launcher-btn" id="launcherBtn" aria-label="Open support chat">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </button>
    `;
  }

  private attachEventListeners(): void {
    const launcherBtn = this.shadow.getElementById('launcherBtn');
    const closeBtn = this.shadow.getElementById('closeBtn');
    const sendBtn = this.shadow.getElementById('sendBtn');
    const chatInput = this.shadow.getElementById('chatInput') as HTMLInputElement;

    launcherBtn?.addEventListener('click', () => this.toggleChat(true));
    closeBtn?.addEventListener('click', () => this.toggleChat(false));
    sendBtn?.addEventListener('click', () => this.handleSend(chatInput));
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSend(chatInput);
    });
  }

  public toggleChat(open: boolean): void {
    this.isOpen = open;
    const container = this.shadow.getElementById('chatContainer');
    const launcher = this.shadow.getElementById('launcherBtn');
    if (container && launcher) {
      container.classList.toggle('active', open);
      launcher.style.display = open ? 'none' : 'flex';
    }

    // Emit AGENT_WIDGET_STATE_CHANGE to host page
    window.parent.postMessage(
      {
        type: 'AGENT_WIDGET_STATE_CHANGE',
        payload: { isOpen: this.isOpen },
      },
      '*'
    );
  }

  private handleSend(input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text) return;
    this.appendMessage('user', text);
    input.value = '';
    this.dispatchStreamMessage(text);
  }

  private appendMessage(sender: 'user' | 'agent', content: string): HTMLSpanElement | null {
    const body = this.shadow.getElementById('chatBody');
    if (!body) return null;
    const msgDiv = document.createElement('div');
    msgDiv.style.margin = '8px 0';
    msgDiv.style.textAlign = sender === 'user' ? 'right' : 'left';

    const span = document.createElement('span');
    span.style.cssText = `display:inline-block;padding:8px 12px;border-radius:8px;font-size:14px;background:${
      sender === 'user' ? '#0284c7' : '#e2e8f0'
    };color:${sender === 'user' ? '#ffffff' : '#0f172a'};max-width:80%;word-break:break-word;`;
    span.textContent = content;

    msgDiv.appendChild(span);
    body.appendChild(msgDiv);
    body.scrollTop = body.scrollHeight;

    return span;
  }

  /**
   * Dispatches message and streams tokens back into chat bubble using ReadableStream.
   */
  private async dispatchStreamMessage(message: string): Promise<void> {
    if (!navigator.onLine) {
      this.enqueueOfflineMessage(message);
      this.appendMessage('agent', 'You appear offline. Message queued and will send upon reconnect.');
      return;
    }

    const agentSpan = this.appendMessage('agent', '...');
    try {
      const response = await fetch(`${this.apiUrl}/v1/storefront/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': this.tenantId,
        },
        body: JSON.stringify({
          message,
          sessionId: sessionStorage.getItem('agent_session_id'),
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Stream request failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        if (agentSpan) {
          agentSpan.textContent = accumulated;
        }
      }
    } catch {
      this.enqueueOfflineMessage(message);
      if (agentSpan) {
        agentSpan.textContent = 'Connection interrupted. Queued for automatic retry.';
      }
    }
  }

  private enqueueOfflineMessage(message: string): void {
    const queue: QueuedMessage[] = JSON.parse(
      localStorage.getItem(this.offlineQueueKey) || '[]'
    );
    queue.push({ id: `offline-${Date.now()}`, message, timestamp: Date.now() });
    localStorage.setItem(this.offlineQueueKey, JSON.stringify(queue));
  }

  private async drainOfflineQueue(): Promise<void> {
    const queue: QueuedMessage[] = JSON.parse(
      localStorage.getItem(this.offlineQueueKey) || '[]'
    );
    if (queue.length === 0) return;

    localStorage.removeItem(this.offlineQueueKey);
    for (const item of queue) {
      await this.dispatchStreamMessage(item.message);
    }
  }

  private initNetworkRecovery(): void {
    window.addEventListener('online', () => {
      this.drainOfflineQueue();
    });
  }

  /**
   * Initializes bidirectional postMessage JSON RPC bridge with host page.
   */
  private initPostMessageBridge(): void {
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; payload?: Record<string, unknown> };
      if (!data?.type) return;

      switch (data.type) {
        case 'AGENT_WIDGET_OPEN':
          this.toggleChat(true);
          if (data.payload?.focusInput) {
            const input = this.shadow.getElementById('chatInput') as HTMLInputElement;
            input?.focus();
          }
          break;

        case 'AGENT_WIDGET_SEND_EVENT':
          // Ingest storefront events (e.g. cart updated, item viewed)
          if (data.payload?.eventName && data.payload?.eventData) {
            fetch(`${this.apiUrl}/v1/storefront/events`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': this.tenantId,
              },
              body: JSON.stringify({
                event: data.payload.eventName,
                data: data.payload.eventData,
                sessionId: sessionStorage.getItem('agent_session_id'),
              }),
            }).catch(() => {});
          }
          break;
      }
    });
  }

  /**
   * Triggers checkout navigation via host postMessage.
   */
  public requestHostCheckout(cartId: string, checkoutUrl: string): void {
    window.parent.postMessage(
      {
        type: 'AGENT_NAVIGATE_CHECKOUT',
        payload: { cartId, checkoutUrl },
      },
      '*'
    );
  }
}

customElements.define('agent-storefront-widget', AgentStorefrontWidget);
```

### 7.3 Host Page postMessage Bridge Contract
To allow external merchant scripts (such as "Click to chat" promotional banners or checkout cart overlays) to interact with the widget safely across frame boundaries, the widget exposes a strict JSON RPC bridge via `window.postMessage`:

| Direction | Event Name | Payload Schema | Action |
|---|---|---|---|
| **Host -> Widget** | `AGENT_WIDGET_OPEN` | `{ focusInput?: boolean }` | Expands widget chat container |
| **Host -> Widget** | `AGENT_WIDGET_SEND_EVENT` | `{ eventName: string, eventData: object }` | Ingests storefront context (e.g. `cart_updated`) |
| **Widget -> Host** | `AGENT_WIDGET_STATE_CHANGE` | `{ isOpen: boolean }` | Notifies host to adjust mobile overlay |
| **Widget -> Host** | `AGENT_NAVIGATE_CHECKOUT` | `{ cartId: string, checkoutUrl: string }` | Requests host to navigate to checkout |

---

## 8. Frontend Engineering Definition of Done & Verification Matrix

Every screen and component in this specification must satisfy the following verification tests prior to release:

| Screen / Component | Test ID | Verification Criteria | Pass Rule |
|---|---|---|---|
| **SCR-001** | `UI-TEST-001` | SSE Telemetry Stream Reconnect | Automatic reconnect within 5s when connection drops without UI crash |
| **SCR-002** | `UI-TEST-002` | Virtual Table Rendering Performance | 10,000 run records scroll smoothly at 60 FPS (DOM node count < 100) |
| **SCR-003** | `UI-TEST-003` | Atomic Action Idempotency | Double clicking "Approve" button issues exactly 1 signed request |
| **SCR-004** | `UI-TEST-004` | Fact vs Hypothesis Visual Badge | 100% of ERP records marked as FACT; AI scores marked as HYPOTHESIS |
| **SCR-005** | `UI-TEST-005` | Mutex Takeover Lock Acquisition | Takeover button locks Redis within 200ms; bot stops emitting tokens |
| **Storefront Widget**| `UI-TEST-006` | Bundle Budget & Host Style Isolation | Gzipped script < 20.0 KB; merchant CSS `* { margin: 50px }` does not leak |
