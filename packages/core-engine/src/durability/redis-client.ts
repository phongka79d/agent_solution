import { Redis } from 'ioredis';

import type { RedisInjectedClient } from '@agentos/database/contracts';

/** Minimal managed Redis client used by runtime composition roots. */
export interface RuntimeRedisClient extends RedisInjectedClient {
  quit(): Promise<string>;
}

/** The ioredis command overloads are wider than the injected structural port; this adapter narrows them. */
class IoredisRuntimeClient implements RuntimeRedisClient {
  constructor(private readonly client: Redis) {}

  async set(
    key: string,
    value: string,
    ...args: ReadonlyArray<string | number>
  ): Promise<string | null> {
    const reply = await this.client.call('SET', key, value, ...args);
    return typeof reply === 'string' ? reply : null;
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }

  eval(script: string, numberOfKeys: number, ...args: ReadonlyArray<string | number>): Promise<unknown> {
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
