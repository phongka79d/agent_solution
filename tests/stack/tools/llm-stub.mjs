#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 1_048_576;
const FAULT_MODES = new Set(['429', '500', 'timeout', 'invalid_json']);
const CONTENT_CHANNELS = new Set([
  'LINE_FLEX', 'WHATSAPP_TEMPLATE', 'EMAIL_HTML', 'SMS_TEXT', 'ZALO_ZNS',
  'TIKTOK_CARD', 'MESSENGER_GENERIC', 'INSTAGRAM_DIRECT',
]);

function assertLocalEnvironment() {
  if (process.env.APP_ENV !== 'local' && process.env.APP_ENV !== 'ci') {
    throw new Error('LLM stub may only run when APP_ENV is local or ci');
  }
}

function normalizeFaultScenarios(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.faults)) {
    throw new TypeError('LLM stub scenario file must contain a faults array');
  }
  return parsed.faults.map((fault) => {
    if (fault === null || typeof fault !== 'object' || Array.isArray(fault)
      || !('match' in fault)
      || !FAULT_MODES.has(fault.mode)
      || !Number.isSafeInteger(fault.times) || fault.times < 1) {
      throw new TypeError('Each LLM stub fault needs match, a supported mode, and positive integer times');
    }
    if (typeof fault.match !== 'string' && (fault.match === null || typeof fault.match !== 'object' || Array.isArray(fault.match))) {
      throw new TypeError('LLM stub fault match must be a string or object');
    }
    return { match: fault.match, mode: fault.mode, remaining: fault.times };
  });
}

async function readFaultScenarios(scenarioFile) {
  if (scenarioFile === undefined) return [];
  let parsed;
  try {
    parsed = JSON.parse(await readFile(scenarioFile, 'utf8'));
  } catch {
    throw new Error('LLM stub scenario file must contain valid JSON');
  }
  return normalizeFaultScenarios(parsed);
}

function respondJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function badRequest(response, message = 'Invalid request') {
  respondJson(response, 400, { error: { message, type: 'invalid_request_error' } });
}

async function readRequestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      request.resume();
      return { tooLarge: true };
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    return null;
  }
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function requestMessages(body) {
  return Array.isArray(body.messages)
    ? body.messages.filter((message) => asRecord(message) && typeof message.content === 'string')
    : [];
}

function classifyPrompt(body) {
  const messages = requestMessages(body);
  const systemText = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n').toLowerCase();
  const responseFormat = asRecord(body.response_format);
  const jsonSchema = asRecord(responseFormat?.json_schema);
  const schemaName = typeof jsonSchema?.name === 'string' ? jsonSchema.name.toLowerCase() : '';
  const schema = asRecord(jsonSchema?.schema);
  const properties = asRecord(schema?.properties);
  if (schemaName.includes('intent') || (properties && 'intent' in properties && 'requirements' in properties && 'confidence' in properties)) {
    return 'intent';
  }
  if (schemaName.includes('marketing') || schemaName.includes('content') || schemaName.includes('draft')
    || (properties && 'draft_id' in properties && 'headline' in properties && 'channel_payload' in properties)) {
    return 'marketing';
  }
  if (/classify the customer service intent|turn intent classifier/.test(systemText)) return 'intent';
  if (/marketing campaign draft|generate_content|content draft/.test(systemText)) return 'marketing';
  return null;
}

function userText(body) {
  return requestMessages(body).filter((message) => message.role === 'user').map((message) => message.content).join('\n');
}

function intentContent(body) {
  const text = userText(body).toLowerCase();
  let intent = 'requires_clarification';
  let confidence = 0.4;
  if (/\b(?:speak|talk|connect|transfer|escalate)\s+(?:me\s+)?(?:to|with)\s+(?:a\s+)?(?:real\s+)?(?:person|human|live agent|representative|operator)\b|\b(?:live|human)\s+agent\b|(?:nói chuyện|gặp|chuyển|gọi).{0,24}(?:nhân viên|người thật)|(?:nhân viên|người thật).{0,24}(?:nói chuyện|gặp|chuyển)/.test(text)) {
    intent = 'human_escalation';
    confidence = 0.95;
  } else if (/\b(return|refund|exchange)\b|đổi trả|hoàn tiền/.test(text)) {
    intent = 'return_refund';
    confidence = 0.85;
  } else if (/\b(complaint|broken|damaged|not working|issue|problem|warranty)\b|bảo hành|khiếu nại|bị lỗi|sự cố/.test(text)) {
    intent = 'complaint';
    confidence = 0.85;
  } else if (/\b(track(?:ing)?|shipment|delivery|delivered|shipping)\b|giao hàng/.test(text)) {
    intent = 'shipping';
    confidence = 0.85;
  } else if (/\b(where is my order|order status|my order)\b|đơn hàng/.test(text)) {
    intent = 'order_status';
    confidence = 0.8;
  } else if (/\b(payment|paid|charge|invoice|billing)\b|thanh toán/.test(text)) {
    intent = 'payment';
    confidence = 0.8;
  } else if (/\b(in stock|available|availability|stock)\b|còn hàng/.test(text)) {
    intent = 'stock';
    confidence = 0.8;
  } else if (/\b(price|pricing|how much|cost)\b|\bgiá\b/.test(text)) {
    intent = 'price';
    confidence = 0.8;
  } else if (/\b(usage|how to use|instructions|setup)\b|cách dùng/.test(text)) {
    intent = 'usage';
    confidence = 0.75;
  } else if (/\b(recommend|suggest|product|item|buy|purchase|shop|laptop|phone|camera)\b|sản phẩm|tư vấn|gợi ý/.test(text)) {
    intent = 'product_info';
    confidence = 0.8;
  } else if (text.trim()) {
    intent = 'faq_search';
    confidence = 0.6;
  }
  return { intent, requirements: {}, confidence };
}

function marketingContent(body) {
  let channel = 'EMAIL_HTML';
  for (const message of requestMessages(body)) {
    if (message.role !== 'user') continue;
    try {
      const input = JSON.parse(message.content);
      if (typeof input.channel === 'string' && CONTENT_CHANNELS.has(input.channel)) channel = input.channel;
    } catch {
      // A malformed or non-JSON user message does not alter the safe default channel.
    }
  }
  return {
    draft_id: 'llm-stub-draft',
    headline: 'A thoughtful update',
    body_content: 'Explore a fresh update from us, tailored for your interests.',
    cta_text: 'Learn more',
    channel_payload: { channel_type: channel },
  };
}

function textToMatch(body, pathname, kind) {
  const messages = requestMessages(body);
  return [pathname, kind ?? '', typeof body.model === 'string' ? body.model : '', ...messages.map((message) => message.content)]
    .join('\n').toLowerCase();
}

function matchesScenario(match, body, pathname, kind) {
  const fullText = textToMatch(body, pathname, kind);
  if (typeof match === 'string') return fullText.includes(match.toLowerCase());
  const fields = Object.keys(match);
  if (fields.length === 0) return false;
  return fields.every((key) => {
    const expected = match[key];
    if (typeof expected !== 'string') return false;
    if (key === 'kind') return (kind ?? '').toLowerCase() === expected.toLowerCase();
    if (key === 'path') return pathname === expected;
    if (key === 'model') return body.model === expected;
    if (key === 'contains' || key === 'prompt') return fullText.includes(expected.toLowerCase());
    return false;
  });
}

function selectFault(request, body, pathname, kind, scenarios) {
  const headerMode = request.headers['x-llm-stub-fault'];
  const requestedMode = Array.isArray(headerMode) ? headerMode[0] : headerMode;
  if (typeof requestedMode === 'string' && FAULT_MODES.has(requestedMode)) return requestedMode;
  for (const scenario of scenarios) {
    if (scenario.remaining > 0 && matchesScenario(scenario.match, body, pathname, kind)) {
      scenario.remaining -= 1;
      return scenario.mode;
    }
  }
  return null;
}

function buildCompletion(body, kind, fault, sequence) {
  const content = fault === 'invalid_json'
    ? '{"unterminated":'
    : JSON.stringify(kind === 'intent' ? intentContent(body) : marketingContent(body));
  const promptTokens = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4));
  const completionTokens = Math.max(1, Math.ceil(Buffer.byteLength(content) / 4));
  return {
    id: `chatcmpl-llm-stub-${sequence}`,
    object: 'chat.completion',
    created: 0,
    model: typeof body.model === 'string' ? body.model : 'llm-stub',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

/** Starts a local-only OpenAI-compatible deterministic LLM stub. */
export async function startLlmStub({ port = 0, host = '0.0.0.0', scenarioFile } = {}) {
  assertLocalEnvironment();
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('port must be an integer from 0 to 65535');
  if (typeof host !== 'string' || host.trim().length === 0) throw new TypeError('host must be a non-empty string');
  const scenarios = await readFaultScenarios(scenarioFile);
  const controlToken = randomBytes(32).toString('hex');
  const controlTokenBytes = Buffer.from(controlToken);
  const controlAuthorized = (request) => {
    const candidate = request.headers['x-llm-stub-control-token'];
    if (typeof candidate !== 'string') return false;
    const candidateBytes = Buffer.from(candidate);
    return candidateBytes.length === controlTokenBytes.length && timingSafeEqual(candidateBytes, controlTokenBytes);
  };
  let completionSequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/__stub/control' && ['GET', 'POST'].includes(request.method ?? '')) {
        if (!controlAuthorized(request)) {
          respondJson(response, 401, { error: { message: 'Control token required', type: 'authentication_error' } });
          return;
        }
        if (request.method === 'GET') {
          respondJson(response, 200, { faults: scenarios.map(({ match, mode, remaining }) => ({ match, mode, remaining })) });
          return;
        }
        const control = await readRequestJson(request);
        if (control?.tooLarge) {
          respondJson(response, 413, { error: { message: 'Request too large', type: 'invalid_request_error' } });
          return;
        }
        if (!asRecord(control) || Object.keys(control).some((key) => key !== 'faults')) {
          badRequest(response, 'Control body must contain only a faults array');
          return;
        }
        let nextScenarios;
        try {
          nextScenarios = normalizeFaultScenarios(control);
        } catch {
          badRequest(response, 'Invalid LLM stub fault scenarios');
          return;
        }
        scenarios.splice(0, scenarios.length, ...nextScenarios);
        respondJson(response, 200, { faults: scenarios.map(({ match, mode, remaining }) => ({ match, mode, remaining })) });
        return;
      }
      if (request.method === 'GET' && pathname === '/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [{ id: 'llm-stub', object: 'model', created: 0, owned_by: 'local' }],
        });
        return;
      }
      if (request.method !== 'POST' || (pathname !== '/v1/chat/completions' && pathname !== '/chat/completions')) {
        respondJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
        return;
      }
      const body = await readRequestJson(request);
      if (body?.tooLarge) {
        respondJson(response, 413, { error: { message: 'Request too large', type: 'invalid_request_error' } });
        return;
      }
      if (!asRecord(body) || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
        badRequest(response);
        return;
      }
      const kind = classifyPrompt(body);
      if (kind === null) {
        badRequest(response, 'Prompt kind is not supported');
        return;
      }
      const fault = selectFault(request, body, pathname, kind, scenarios);
      if (fault === 'timeout') return;
      if (fault === '429') {
        respondJson(response, 429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, { 'retry-after': '1' });
        return;
      }
      if (fault === '500') {
        respondJson(response, 500, { error: { message: 'Stub provider unavailable', type: 'server_error' } });
        return;
      }
      const payload = buildCompletion(body, kind, fault, ++completionSequence);
      respondJson(response, 200, payload, { 'x-request-id': payload.id });
    })().catch(() => {
      if (!response.headersSent) badRequest(response);
      else response.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('LLM stub failed to bind a TCP port');
  }
  let closePromise;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    controlToken,
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

function cliOptions(args) {
  let port = 0;
  let scenarioFile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port' || arg === '--scenario-file') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === '--port') {
        if (!/^\d+$/.test(value)) throw new Error('--port must be an integer from 0 to 65535');
        port = Number(value);
      } else {
        scenarioFile = value;
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { port, scenarioFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stub = await startLlmStub(cliOptions(process.argv.slice(2)));
    process.stdout.write(`${stub.url}\n`);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void stub.close().finally(() => { process.exitCode = 0; });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'LLM stub failed'}\n`);
    process.exitCode = 1;
  }
}
