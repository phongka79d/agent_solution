import { Redis } from 'ioredis';

import type { RedisInjectedClient } from '@agentos/database/contracts';

/** Minimal managed Redis client used by runtime composition roots. */
export interface RuntimeRedisClient extends RedisInjectedClient {
  scan(cursor: string, pattern: string, count: number): Promise<{
    readonly cursor: string;
    readonly keys: readonly string[];
  }>;
  del(keys: readonly string[]): Promise<number>;
  quit(): Promise<string>;
}

/** The ioredis command overloads are wider than the injected structural port; this adapter narrows them. */
class IoredisRuntimeClient implements RuntimeRedisClient {
  private connecting: Promise<void> | null = null;

  constructor(private readonly client: Redis) {}

  /**
   * `lazyConnect` defers the socket until first use, and with the offline queue disabled ioredis
   * refuses commands until the socket is ready. Open it once on demand; later outages still fail
   * fast instead of queueing commands.
   */
  private async ready(): Promise<void> {
    if (this.client.status !== 'wait') return;
    this.connecting ??= this.client.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async set(
    key: string,
    value: string,
    ...args: ReadonlyArray<string | number>
  ): Promise<string | null> {
    await this.ready();
    const reply = await this.client.call('SET', key, value, ...args);
    return typeof reply === 'string' ? reply : null;
  }

  async get(key: string): Promise<string | null> {
    await this.ready();
    return this.client.get(key);
  }

  async pttl(key: string): Promise<number> {
    await this.ready();
    return this.client.pttl(key);
  }
  async scan(cursor: string, pattern: string, count: number): Promise<{
    readonly cursor: string;
    readonly keys: readonly string[];
  }> {
    await this.ready();
    const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    return { cursor: nextCursor, keys };
  }

  async del(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    await this.ready();
    return this.client.del(...keys);
  }


  async eval(script: string, numberOfKeys: number, ...args: ReadonlyArray<string | number>): Promise<unknown> {
    await this.ready();
    return this.client.eval(script, numberOfKeys, ...args);
  }

  quit(): Promise<string> {
    return this.client.quit();
  }
}

export interface RuntimeRedisClientOptions {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly db: number;
}

/**
 * Constructs the shared Redis transport without connecting until the first command.
 *
 * Configuration validation normally runs before a composition root calls this function, but the
 * boundary validates again so tests and alternate hosts cannot create a client pointed at an empty
 * or invalid target.
 */
export function createRuntimeRedisClient(options: RuntimeRedisClientOptions): RuntimeRedisClient {
  if (options.host.trim().length === 0) {
    throw new Error('REDIS_HOST_REQUIRED: the Redis runtime client requires a non-empty host');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('REDIS_PORT_INVALID: the Redis runtime client port must be an integer from 1 to 65535');
  }
  if (options.password.length === 0) {
    throw new Error('REDIS_PASSWORD_REQUIRED: the Redis runtime client requires authentication');
  }
  if (!Number.isInteger(options.db) || options.db < 0) {
    throw new Error('REDIS_DB_INVALID: the Redis database index must be an integer greater than or equal to zero');
  }

  return new IoredisRuntimeClient(
    new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      db: options.db,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectionName: 'agentos-api-takeover',
    }),
  );
}
