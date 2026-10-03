const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_REQUEST_TIMEOUT_MS = 15_000;

function taskApiBase(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new TypeError('baseUrl must be a non-empty string');
  }
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

/**
 * Poll the tenant-scoped task endpoint until one of the caller's terminal states is observed.
 * `baseUrl` may be either the API origin or its `/api/v1` base.
 */
export async function waitTask({ baseUrl, token, taskId, terminalStates, timeoutMs, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('token must be a non-empty string');
  if (typeof taskId !== 'string' || taskId.length === 0) throw new TypeError('taskId must be a non-empty string');
  if (!Array.isArray(terminalStates) || terminalStates.length === 0) {
    throw new TypeError('terminalStates must be a non-empty array');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const terminal = new Set(terminalStates);
  const endpoint = `${taskApiBase(baseUrl)}/tasks/${encodeURIComponent(taskId)}`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`DEMO_TASK_TIMEOUT: task ${taskId} did not reach a terminal state within ${timeoutMs}ms`);
    }

    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(MAX_REQUEST_TIMEOUT_MS, remainingMs))),
    });
    if (!response.ok) {
      throw new Error(`DEMO_TASK_WAIT_FAILED: task ${taskId} returned HTTP ${response.status}`);
    }

    let task;
    try {
      task = await response.json();
    } catch {
      throw new Error(`DEMO_TASK_WAIT_FAILED: task ${taskId} returned invalid JSON`);
    }
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.status !== 'string') {
      throw new Error(`DEMO_TASK_WAIT_FAILED: task ${taskId} response has no status`);
    }
    if (terminal.has(task.status)) return task;

    const delayMs = Math.min(DEFAULT_POLL_INTERVAL_MS, deadline - Date.now());
    if (delayMs <= 0) {
      throw new Error(`DEMO_TASK_TIMEOUT: task ${taskId} did not reach a terminal state within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
