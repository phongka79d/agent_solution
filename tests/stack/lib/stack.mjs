import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signRequest } from '../../../services/mock-erp/src/hmac.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STATE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../.state/stack.json');
const REQUIRED_KEYS = ['apiUrl', 'mockErpUrl', 'llmStubUrl', 'superDatabaseUrl', 'tenantId', 'personas', 'erpTimeoutMs'];
const STACK_SERVICE_CONTROL_TIMEOUT_MS = 120_000;
const STACK_SERVICE_ACTIONS = new Set(['kill', 'restart', 'start', 'stop', 'up']);
const STACK_SERVICES = new Set([
  'postgres',
  'redis',
  'qdrant',
  'mock-erp',
  'temporal',
  'temporal-ui',
  'api',
  'worker',
  'tenant-console',
  'platform-admin',
]);

/**
 * Controls one allowlisted service in the isolated test project only.
 * The fixed project and compose files prevent tests from targeting another running project.
 */
export async function controlStackService(action, service) {
  if (!STACK_SERVICE_ACTIONS.has(action)) throw new TypeError('unsupported stack service action');
  if (!STACK_SERVICES.has(service)) throw new TypeError('unsupported stack service name');

  const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const args = [
    'compose',
    '--env-file', '.env.example',
    '--project-name', 'agentos_stacktest',
    '--file', 'docker-compose.yml',
    '--file', 'tests/stack/compose.stack.yml',
  ];
  if (action === 'up') {
    args.push('up', '--detach', '--no-deps', '--no-recreate', '--wait', service);
  } else {
    args.push(action, service);
  }

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(docker, args, {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => settle(() => {
      child.kill();
      rejectPromise(new Error(
        `docker compose ${action} ${service} timed out after ${STACK_SERVICE_CONTROL_TIMEOUT_MS}ms`,
      ));
    }), STACK_SERVICE_CONTROL_TIMEOUT_MS);

    child.once('error', (error) => settle(() => rejectPromise(new Error(
      `docker compose ${action} ${service} could not start (${error.code ?? error.name})`,
    ))));
    child.once('close', (code, signal) => settle(() => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(
        `docker compose ${action} ${service} failed (exit ${code ?? signal ?? 'unknown'})`,
      ));
    }));
  });
}

/** Reads the state written by the stack global setup. */
export function readStackState() {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  for (const key of REQUIRED_KEYS) {
    if (!(key in state)) throw new Error(`Stack state is missing ${key}`);
  }
  return state;
}

/** Applies a signed, tenant-scoped mock ERP simulation control. */
export async function mockErpControl(settings) {
  const { mockErpUrl, tenantId } = readStackState();
  const secret = process.env.MOCK_SECRET_KEY;
  if (!secret) throw new Error('stack mock ERP signing key is unavailable');
  const path = '/__sim/control';
  const rawBody = JSON.stringify({ tenant_id: tenantId, ...settings });
  const response = await fetch(new URL(path, mockErpUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'x-mock-signature': signRequest(secret, 'POST', path, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(5000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Surface the status if the service fails without its JSON response contract.
  }
  if (!response.ok || body?.control === undefined) {
    throw new Error(`mock ERP simulation control returned HTTP ${response.status}`);
  }
  return body.control;
}

/** Reads or updates the local LLM stub's one-shot fault scenarios. */
export async function llmStubControl({ faults, readOnly = false }) {
  const { llmStubUrl } = readStackState();
  const controlToken = process.env.LLM_STUB_CONTROL_TOKEN;
  if (!controlToken) throw new Error('stack LLM stub control token is unavailable');
  const method = readOnly ? 'GET' : 'POST';
  const response = await fetch(new URL('/__stub/control', llmStubUrl), {
    method,
    headers: {
      accept: 'application/json',
      'x-llm-stub-control-token': controlToken,
      ...(readOnly ? {} : { 'content-type': 'application/json' }),
    },
    ...(readOnly ? {} : { body: JSON.stringify({ faults }) }),
    signal: AbortSignal.timeout(5000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Surface the status if the service fails without its JSON response contract.
  }
  if (!response.ok || !Array.isArray(body?.faults)) {
    throw new Error(`LLM stub control returned HTTP ${response.status}`);
  }
  return body.faults;
}
