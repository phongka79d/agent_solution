/**
 * @file The operator WebSocket channel (implement/06 §1.1, §8.1.2 R10).
 *
 * R10 is a read-and-notify surface: it relays server events to an authenticated operator and
 * acknowledges commands, but it never mutates business state — every control action goes through
 * R06/R07/R08. The handshake therefore refuses an unauthenticated or cross-tenant subscription
 * before a single frame is read, and a repeated `command_id` is acknowledged once and never
 * applied twice.
 *
 * There is deliberately no WebSocket dependency in this workspace, and the package DAG grants
 * `apps/api` no provider SDK, so the RFC 6455 server handshake and frame codec are implemented
 * here over `node:http` and `node:crypto`. The surface is intentionally small: text frames,
 * ping/pong, close, and a bounded payload. No extension, no compression, no subprotocol is
 * negotiated — a client that asks for one gets a plain connection.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';

import type { GatewayPrincipal, WsCommand, WsServerEvent } from './contracts.js';
import type { GatewayRuntime } from './ports.js';
import type { CredentialStore, OperatorCredential } from './principal.js';

/** The single operator socket path. */
export const WS_STREAM_PATH = '/api/v1/ws/stream';

/** RFC 6455 handshake constant. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Close codes: 44xx is the application range, so these never collide with protocol codes. */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_CROSS_TENANT = 4403;
export const WS_CLOSE_POLICY_VIOLATION = 4408;

/** Largest accepted frame payload; a larger frame is a policy violation, not a buffer to grow. */
export const WS_MAX_PAYLOAD_BYTES = 262_144;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** One decoded frame. */
interface WsFrame {
  readonly opcode: number;
  readonly payload: Buffer;
  readonly fin: boolean;
}

/**
 * Encodes one unmasked server frame. A server MUST NOT mask, so the mask bit stays clear.
 *
 * @param opcode RFC 6455 opcode.
 * @param payload Frame payload.
 * @returns The wire bytes.
 */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;

  if (length < 126) {
    const header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
    return Buffer.concat([header, payload]);
  }

  if (length < 65_536) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

/**
 * Decodes as many whole frames as the buffer holds.
 *
 * @param buffer Bytes received so far.
 * @returns The decoded frames and the unconsumed remainder.
 * @throws {Error} `WS_PROTOCOL_VIOLATION` for an unmasked client frame, an unsupported opcode or
 *   an oversized payload — each is a refusal, never a partially applied message.
 */
export function decodeFrames(buffer: Buffer): { readonly frames: readonly WsFrame[]; readonly rest: Buffer } {
  const frames: WsFrame[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first === undefined || second === undefined) break;

    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      const wide = buffer.readBigUInt64BE(cursor);
      if (wide > BigInt(WS_MAX_PAYLOAD_BYTES)) throw new Error('WS_PROTOCOL_VIOLATION');
      length = Number(wide);
      cursor += 8;
    }

    if (length > WS_MAX_PAYLOAD_BYTES) throw new Error('WS_PROTOCOL_VIOLATION');
    if (opcode === OPCODE_CONTINUATION) throw new Error('WS_PROTOCOL_VIOLATION');

    // A browser client always masks; an unmasked client frame is a protocol violation.
    if (!masked) throw new Error('WS_PROTOCOL_VIOLATION');

    if (cursor + 4 + length > buffer.length) break;

    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;

    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      const byte = buffer[cursor + index] ?? 0;
      const key = mask[index % 4] ?? 0;
      payload[index] = byte ^ key;
    }
    cursor += length;

    if (opcode !== OPCODE_TEXT && opcode !== OPCODE_BINARY && opcode !== OPCODE_CLOSE && opcode !== OPCODE_PING && opcode !== OPCODE_PONG) {
      throw new Error('WS_PROTOCOL_VIOLATION');
    }

    frames.push({ opcode, payload, fin });
    offset = cursor;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/** The `Sec-WebSocket-Accept` value for a client key. */
export function acceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(`${clientKey}${WEBSOCKET_GUID}`)
    .digest('base64');
}

/** One live operator socket. */
interface WsSession {
  readonly tenant_id: string;
  readonly operator_id: string;
  readonly seen_commands: Set<string>;
  closed: boolean;
  unsubscribe: (() => void) | null;
}

/**
 * Extracts the credential the handshake presented.
 *
 * A browser cannot set an `Authorization` header on a WebSocket, so the operator session may also
 * arrive as a `token` query parameter. Both are treated identically: an opaque value looked up in
 * the credential store. Neither is parsed, decoded or trusted beyond that lookup.
 */
function presentedToken(request: IncomingMessage, url: URL): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }

  const fromQuery = url.searchParams.get('token');
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : null;
}

/** Writes a close frame with the given application code and ends the socket. */
function closeWith(socket: Duplex, code: number): void {
  const reason = Buffer.allocUnsafe(2);
  reason.writeUInt16BE(code, 0);
  if (!socket.destroyed) {
    socket.write(encodeFrame(OPCODE_CLOSE, reason));
    socket.end();
  }
}

/** Sends one JSON text frame when the socket is still usable. */
function send(socket: Duplex, event: WsServerEvent): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(event), 'utf8')));
}

/** Rejects the upgrade with a plain HTTP response: the client never receives a socket. */
function refuseUpgrade(socket: Duplex, status: number, body: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
      'connection: close\r\n' +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body, 'utf8')}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

/** Guards a plain JSON object without asserting a shape the compiler cannot verify. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses one client command. An unparsable frame, a missing `command_id` or a missing `command`
 * is refused in-band with a `stream.error` event; the connection stays open because the operator
 * can correct the command without re-authenticating.
 */
function parseCommand(text: string): WsCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;

  const commandId = parsed['command_id'];
  const command = parsed['command'];
  const payload = parsed['payload'];

  if (typeof commandId !== 'string' || commandId.length === 0) return null;
  if (typeof command !== 'string' || command.length === 0) return null;

  return {
    command_id: commandId,
    command,
    ...(isPlainObject(payload) ? { payload } : {}),
  };
}

/**
 * Attaches the R10 socket to the HTTP server Fastify already owns.
 *
 * @param app The Fastify instance whose server carries the upgrade event.
 * @param deps The gateway runtime and the credential store used at the handshake.
 */
export function registerWebSocketStream(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  const server: Server = app.server;

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://gateway.local');

    // A WebSocket upgrade is complete for this process: any other path is not ours to answer, and
    // destroying the socket here keeps an unknown upgrade from hanging a connection.
    if (url.pathname !== WS_STREAM_PATH) {
      refuseUpgrade(socket, 404, JSON.stringify({ error_code: 'NOT_FOUND', retryable: false }));
      return;
    }

    const clientKey = request.headers['sec-websocket-key'];
    if (typeof clientKey !== 'string' || clientKey.length === 0) {
      refuseUpgrade(socket, 400, JSON.stringify({ error_code: 'VALIDATION_FAILED', retryable: false }));
      return;
    }

    const token = presentedToken(request, url);
    const operator: OperatorCredential | null = token === null ? null : deps.credentials.resolveOperator(token);

    if (operator === null) {
      refuseUpgrade(socket, 401, JSON.stringify({ error_code: 'AUTHENTICATION_FAILED', retryable: false }));
      return;
    }

    // The subscription is tenant-scoped by the credential. A `tenant_id` in the query string is a
    // routing hint at most: a mismatch is refused, never merged (implement/06 §8.0).
    const asserted = url.searchParams.get('tenant_id');
    if (asserted !== null && asserted !== operator.tenant_id) {
      refuseUpgrade(socket, 403, JSON.stringify({ error_code: 'TENANT_BINDING_MISMATCH', retryable: false }));
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${acceptKey(clientKey)}\r\n` +
        '\r\n',
    );

    const session: WsSession = {
      tenant_id: operator.tenant_id,
      operator_id: operator.operator_id,
      seen_commands: new Set<string>(),
      closed: false,
      unsubscribe: null,
    };

    const principal: GatewayPrincipal = {
      kind: 'OPERATOR',
      tenant_id: operator.tenant_id,
      operator_id: operator.operator_id,
      permissions: operator.permissions,
    };

    const abort = new AbortController();

    // Server events are relayed after the handshake; a subscription that cannot be opened is
    // reported in-band rather than silently leaving the operator with a mute socket.
    void (async () => {
      try {
        for await (const frame of deps.runtime.streams.subscribe({
          tenant_id: operator.tenant_id,
          signal: abort.signal,
        })) {
          if (session.closed) break;
          send(socket, { event: frame.event, data: frame.data });
        }
      } catch {
        if (!session.closed) {
          send(socket, { event: 'stream.error', data: { reason: 'subscription_unavailable' } });
        }
      }
    })();

    let buffer: Buffer = Buffer.concat([head]);

    socket.on('data', (chunk: Buffer) => {
      if (session.closed) return;
      buffer = Buffer.concat([buffer, chunk]);

      let decoded: { readonly frames: readonly WsFrame[]; readonly rest: Buffer };
      try {
        decoded = decodeFrames(buffer);
      } catch {
        session.closed = true;
        closeWith(socket, WS_CLOSE_POLICY_VIOLATION);
        return;
      }

      buffer = decoded.rest;

      for (const frame of decoded.frames) {
        if (frame.opcode === OPCODE_CLOSE) {
          session.closed = true;
          closeWith(socket, 1000);
          return;
        }

        if (frame.opcode === OPCODE_PING) {
          socket.write(encodeFrame(OPCODE_PONG, frame.payload));
          continue;
        }

        if (frame.opcode !== OPCODE_TEXT) continue;

        const command = parseCommand(frame.payload.toString('utf8'));
        if (command === null) {
          send(socket, { event: 'stream.error', data: { reason: 'invalid_command' } });
          continue;
        }

        // A replayed command is acknowledged once and never applied twice (`06` §8.1.2 R10).
        if (session.seen_commands.has(command.command_id)) {
          send(socket, {
            event: 'command.duplicate',
            data: { command_id: command.command_id, applied: false },
          });
          continue;
        }
        session.seen_commands.add(command.command_id);

        void (async () => {
          const handler = deps.runtime.streams.onCommand;
          if (handler === undefined) {
            send(socket, {
              event: 'stream.error',
              data: { command_id: command.command_id, reason: 'no_command_handler' },
            });
            return;
          }

          try {
            const result = await handler({
              tenant_id: principal.tenant_id,
              operator_id: principal.operator_id ?? '',
              command: command.command,
              payload: command.payload ?? {},
            });

            send(socket, {
              event: 'command.acknowledged',
              data: { command_id: command.command_id, acknowledged: result.acknowledged },
            });

            for (const event of result.events) {
              send(socket, { event: event.event, data: event.data });
            }
          } catch {
            send(socket, {
              event: 'stream.error',
              data: { command_id: command.command_id, reason: 'command_failed' },
            });
          }
        })();
      }
    });

    const teardown = (): void => {
      if (session.closed) return;
      session.closed = true;
      abort.abort();
      session.unsubscribe?.();
    };

    socket.on('close', teardown);
    socket.on('end', teardown);
    socket.on('error', teardown);
  });
}
