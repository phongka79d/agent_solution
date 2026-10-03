import net from 'node:net';

import { describe, expect, it } from 'vitest';

import { realProbes } from './probes.mjs';

interface FakeRedis {
  readonly port: number;
  close(): Promise<void>;
}

async function startFakeRedis(onData: (socket: net.Socket, chunk: Buffer) => void): Promise<FakeRedis> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (chunk: Buffer) => onData(socket, chunk));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake Redis server did not bind a TCP port');
  }

  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis probe exceeded its bound')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe('Redis readiness probe', () => {
  it('uses PING and accepts PONG', async () => {
    let command = '';
    const redis = await startFakeRedis((socket, chunk) => {
      command += chunk.toString('latin1');
      if (command === '*1\r\n$4\r\nPING\r\n') socket.write('+PONG\r\n');
    });

    try {
      const result = await realProbes.redis(
        { REDIS_HOST: '127.0.0.1', REDIS_PORT: String(redis.port) },
        { timeoutMs: 200 },
      );

      expect(result).toEqual({ ok: true });
      expect(command).toBe('*1\r\n$4\r\nPING\r\n');
    } finally {
      await redis.close();
    }
  });

  it('returns unreachable when Redis does not answer within the probe timeout', async () => {
    const redis = await startFakeRedis(() => {});
    // A real socket is necessary to exercise Node's inactivity timeout; fake timers cannot trigger it.
    try {
      const result = await bounded(
        realProbes.redis(
          { REDIS_HOST: '127.0.0.1', REDIS_PORT: String(redis.port) },
          { timeoutMs: 50 },
        ),
        500,
      );

      expect(result).toEqual({ ok: false, reason: 'unreachable' });
    } finally {
      await redis.close();
    }
  });
});
