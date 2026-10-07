import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GatewayRuntime, StreamPort } from './ports.js';
import type { TelemetryFrame } from './contracts.js';
import { createCredentialStore } from './principal.js';
import {
  decodeFrames,
  encodeFrame,
  registerWebSocketStream,
  WS_MAX_CONNECTIONS_PER_TENANT,
  WS_MAX_PAYLOAD_BYTES,
  WS_CLOSE_POLICY_VIOLATION,
} from './websocket.js';

const TENANT = 'tenant-ws';
const TOKEN = 'operator-ws';

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  readonly writes: Buffer[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end(): void {
    this.writable = false;
  }

  destroy(): this {
    this.destroyed = true;
    this.writable = false;
    return this;
  }
}

class FakeServer extends EventEmitter {}

function maskedFrame(
  opcode: number,
  payload: Buffer,
  options: { readonly fin?: boolean; readonly rsv?: number } = {},
): Buffer {
  const fin = options.fin ?? true;
  const rsv = options.rsv ?? 0;
  const length = payload.length;
  const header = length < 126
    ? Buffer.from([0x80 | rsv | opcode, 0x80 | length])
    : length < 65_536
      ? (() => {
          const value = Buffer.alloc(4);
          value[0] = 0x80 | rsv | opcode;
          value[1] = 0x80 | 126;
          value.writeUInt16BE(length, 2);
          return value;
        })()
      : (() => {
          const value = Buffer.alloc(10);
          value[0] = 0x80 | rsv | opcode;
          value[1] = 0x80 | 127;
          value.writeBigUInt64BE(BigInt(length), 2);
          return value;
        })();
  if (!fin) header[0] = (header[0] ?? 0) & 0x7f;
  const mask = Buffer.from([1, 2, 3, 4]);
  const encoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    encoded[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, mask, encoded]);
}

function oversizedFrame(): Buffer {
  const frame = Buffer.alloc(2 + 8 + 4 + WS_MAX_PAYLOAD_BYTES + 1);
  frame[0] = 0x81;
  frame[1] = 0x80 | 127;
  frame.writeBigUInt64BE(BigInt(WS_MAX_PAYLOAD_BYTES + 1), 2);
  frame.fill(0, 10, 14);
  return frame;
}

type TestIterator = AsyncIterator<TelemetryFrame> & AsyncIterable<TelemetryFrame>;

function streamWithCleanup(onCommand?: StreamPort['onCommand']) {
  const returnMethods: Array<{ readonly mock: { readonly calls: readonly unknown[][] } }> = [];
  const stream: StreamPort = {
    subscribe: vi.fn(() => {
      let resolveNext: ((result: IteratorResult<TelemetryFrame>) => void) | undefined;
      const returnMethod = vi.fn(async () => {
        resolveNext?.({ done: true, value: undefined });
        return { done: true, value: undefined } as const;
      });
      returnMethods.push(returnMethod);
      const iterator: TestIterator = {
        next: vi.fn(() => new Promise<IteratorResult<TelemetryFrame>>((resolve) => {
          resolveNext = resolve;
        })),
        return: returnMethod,
        [Symbol.asyncIterator]() { return this; },
      };
      return iterator;
    }),
    ...(onCommand === undefined ? {} : { onCommand }),
  };
  return { stream, returnMethods };
}

function buildHarness(onCommand?: StreamPort['onCommand']) {
  const server = new FakeServer();
  const stream = streamWithCleanup(onCommand);
  const credentials = createCredentialStore({
    operators: [{ token: TOKEN, tenant_id: TENANT, operator_id: 'operator-1', permissions: ['run:read'] }],
    sessions: [],
    widgets: [],
  });
  const runtime = { streams: stream.stream } as unknown as GatewayRuntime;
  const app = { server } as unknown as FastifyInstance;
  registerWebSocketStream(app, { runtime, credentials });
  const upgrade = server.listeners('upgrade')[0] as (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  const connect = (headers: Record<string, string>, url = '/api/v1/ws/stream') => {
    const socket = new FakeSocket();
    upgrade({ url, headers } as unknown as IncomingMessage, socket as unknown as Duplex, Buffer.alloc(0));
    return socket;
  };
  return { connect, stream, credentials };
}

describe('WebSocket protocol and lifecycle guards', () => {
  it('accepts credentials only in Authorization or Sec-WebSocket-Protocol, never token query parameters', async () => {
    const { connect, stream, credentials } = buildHarness();
    const resolveOperator = vi.spyOn(credentials, 'resolveOperator');
    const query = connect({ 'sec-websocket-key': 'query-key' }, '/api/v1/ws/stream?token=operator-ws');
    expect(query.writes[0]?.toString()).toContain('401 Unauthorized');
    expect(resolveOperator).not.toHaveBeenCalled();
    expect(stream.stream.subscribe).not.toHaveBeenCalled();

    const authorization = connect({
      'sec-websocket-key': 'authorization-key',
      authorization: 'Bearer operator-ws',
    });
    expect(authorization.writes[0]?.toString()).toContain('101 Switching Protocols');

    const protocol = connect({
      'sec-websocket-key': 'protocol-key',
      'sec-websocket-protocol': 'operator-ws',
    });
    expect(protocol.writes[0]?.toString()).toContain('sec-websocket-protocol: operator-ws');
    expect(resolveOperator).toHaveBeenCalledTimes(2);
    authorization.emit('close');
    protocol.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('evicts the oldest tenant connection, not the most recently active connection', async () => {
    const { connect, stream } = buildHarness();
    const sockets: FakeSocket[] = [];
    let replacement: FakeSocket | undefined;
    try {
      for (let index = 0; index < WS_MAX_CONNECTIONS_PER_TENANT; index += 1) {
        sockets.push(connect({ 'sec-websocket-key': `key-${index}`, authorization: `Bearer ${TOKEN}` }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      sockets[0]?.emit('data', maskedFrame(0x9, Buffer.from('keep-active')));
      replacement = connect({ 'sec-websocket-key': 'replacement-key', authorization: `Bearer ${TOKEN}` });

      expect(sockets[0]?.writes.some((value) => value[0] === (0x80 | 0x8) && value.readUInt16BE(2) === WS_CLOSE_POLICY_VIOLATION)).toBe(true);
      expect(sockets[1]?.writes.some((value) => value[0] === (0x80 | 0x8) && value.readUInt16BE(2) === WS_CLOSE_POLICY_VIOLATION)).toBe(false);
      expect(replacement?.writes[0]?.toString()).toContain('101 Switching Protocols');
      expect(stream.stream.subscribe).toHaveBeenCalledTimes(WS_MAX_CONNECTIONS_PER_TENANT + 1);
    } finally {
      replacement?.emit('close');
      for (const socket of sockets) socket.emit('close');
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  it('does not write command results after the socket is closed', async () => {
    type CommandResult = {
      readonly acknowledged: boolean;
      readonly events: readonly { readonly event: string; readonly data: Record<string, unknown> }[];
    };
    let resolveCommand: ((result: CommandResult) => void) | undefined;
    const commandResult = new Promise<CommandResult>((resolve) => {
      resolveCommand = resolve;
    });
    const onCommand: NonNullable<StreamPort['onCommand']> = vi.fn(async () => commandResult);
    const { connect, stream } = buildHarness(onCommand);
    const socket = connect({ 'sec-websocket-key': 'pending-key', authorization: `Bearer ${TOKEN}` });
    try {
      socket.emit('data', maskedFrame(0x1, Buffer.from(JSON.stringify({
        command_id: 'cmd-1',
        command: 'noop',
        payload: {},
      }), 'utf8')));
      await new Promise((resolve) => setImmediate(resolve));
      expect(onCommand).toHaveBeenCalledTimes(1);
      const writesBeforeClose = socket.writes.length;
      socket.end();
      socket.emit('close');
      resolveCommand?.({ acknowledged: true, events: [{ event: 'command.done', data: {} }] });
      await new Promise((resolve) => setImmediate(resolve));
      expect(socket.writes).toHaveLength(writesBeforeClose);
      expect(stream.returnMethods[0]).toHaveBeenCalledTimes(1);
    } finally {
      socket.emit('close');
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('tears down the stream iterator on socket errors and rejects fragments, RSV bits, and oversized frames', async () => {
    const { connect, stream } = buildHarness();
    try {
      const socket = connect({ 'sec-websocket-key': 'lifecycle-key', authorization: `Bearer ${TOKEN}` });
      await new Promise((resolve) => setImmediate(resolve));
      socket.emit('error', new Error('connection failed'));
      await new Promise((resolve) => setImmediate(resolve));
      const returnMethod = stream.returnMethods[0];
      expect(returnMethod).toHaveBeenCalledTimes(1);

      expect(() => decodeFrames(maskedFrame(0x1, Buffer.from('fragment'), { fin: false }))).toThrow('WS_PROTOCOL_VIOLATION');
      expect(() => decodeFrames(maskedFrame(0x9, Buffer.alloc(126)))).toThrow('WS_PROTOCOL_VIOLATION');
      expect(() => decodeFrames(maskedFrame(0x1, Buffer.from('rsv'), { rsv: 0x40 }))).toThrow('WS_PROTOCOL_VIOLATION');
      expect(() => decodeFrames(oversizedFrame())).toThrow('WS_PROTOCOL_VIOLATION');
      expect(() => encodeFrame(0x1, Buffer.alloc(WS_MAX_PAYLOAD_BYTES + 1))).toThrow('WS_PROTOCOL_VIOLATION');
    } finally {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});
