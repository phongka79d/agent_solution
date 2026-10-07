export interface SessionStore<T> {
  get(id: string): Promise<T | undefined>;
  set(id: string, session: T): Promise<void>;
  delete(id: string): Promise<T | undefined>;
  deleteByIdentity(identityId: string): Promise<T[]>;
  sweep(now: number): Promise<T[]>;
}

export interface MemorySessionStoreOptions<T> {
  readonly identityOf: (session: T) => string;
  readonly expiresAtOf: (session: T) => number;
}

/** The BFF defaults to this process-local store when AUTH_SESSION_STORE is unset or memory. */
export class MemorySessionStore<T> implements SessionStore<T> {
  private readonly sessions = new Map<string, T>();
  private readonly identityOf: (session: T) => string;
  private readonly expiresAtOf: (session: T) => number;

  constructor(options: MemorySessionStoreOptions<T>) {
    this.identityOf = options.identityOf;
    this.expiresAtOf = options.expiresAtOf;
  }

  async get(id: string): Promise<T | undefined> {
    return this.sessions.get(id);
  }

  async set(id: string, session: T): Promise<void> {
    this.sessions.set(id, session);
  }

  async delete(id: string): Promise<T | undefined> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    return session;
  }

  async deleteByIdentity(identityId: string): Promise<T[]> {
    const deleted: T[] = [];
    for (const [id, session] of this.sessions) {
      if (this.identityOf(session) !== identityId) continue;
      this.sessions.delete(id);
      deleted.push(session);
    }
    return deleted;
  }

  async sweep(now: number): Promise<T[]> {
    const deleted: T[] = [];
    for (const [id, session] of this.sessions) {
      if (this.expiresAtOf(session) > now) continue;
      this.sessions.delete(id);
      deleted.push(session);
    }
    return deleted;
  }

  /** Test and diagnostics support; callers should use the SessionStore methods for auth behavior. */
  get size(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }
}

/**
 * Minimal asynchronous subset used by the BFF. The app deliberately has no Redis dependency;
 * an adapter can inject a client from the host runtime. Set AUTH_SESSION_STORE=redis and provide
 * REDIS_URL when constructing the store in that runtime. Keys are scoped by keyPrefix.
 */
export interface RedisSessionClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<readonly string[]>;
}

export interface RedisSessionStoreOptions<T> extends MemorySessionStoreOptions<T> {
  readonly client: RedisSessionClient;
  readonly keyPrefix?: string;
}

export class RedisSessionStore<T> implements SessionStore<T> {
  private readonly client: RedisSessionClient;
  private readonly keyPrefix: string;
  private readonly identityOf: (session: T) => string;
  private readonly expiresAtOf: (session: T) => number;

  constructor(options: RedisSessionStoreOptions<T>) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? 'agentos:auth:tenant:session:';
    this.identityOf = options.identityOf;
    this.expiresAtOf = options.expiresAtOf;
  }

  private key(id: string): string {
    return `${this.keyPrefix}${id}`;
  }

  private idFromKey(key: string): string | undefined {
    return key.startsWith(this.keyPrefix) ? key.slice(this.keyPrefix.length) || undefined : undefined;
  }

  private async readKey(key: string): Promise<{ id: string; session: T } | undefined> {
    const id = this.idFromKey(key);
    if (!id) return undefined;
    const encoded = await this.client.get(key);
    if (!encoded) return undefined;
    try {
      const session: unknown = JSON.parse(encoded);
      return { id, session: session as T };
    } catch {
      await this.client.del(key);
      return undefined;
    }
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.readKey(this.key(id)))?.session;
  }

  async set(id: string, session: T): Promise<void> {
    await this.client.set(this.key(id), JSON.stringify(session));
  }

  async delete(id: string): Promise<T | undefined> {
    const session = await this.get(id);
    await this.client.del(this.key(id));
    return session;
  }

  async deleteByIdentity(identityId: string): Promise<T[]> {
    const deleted: T[] = [];
    for (const key of await this.client.keys(`${this.keyPrefix}*`)) {
      const found = await this.readKey(key);
      if (!found || this.identityOf(found.session) !== identityId) continue;
      await this.client.del(key);
      deleted.push(found.session);
    }
    return deleted;
  }

  async sweep(now: number): Promise<T[]> {
    const deleted: T[] = [];
    for (const key of await this.client.keys(`${this.keyPrefix}*`)) {
      const found = await this.readKey(key);
      if (!found || this.expiresAtOf(found.session) > now) continue;
      await this.client.del(key);
      deleted.push(found.session);
    }
    return deleted;
  }

  async clear(): Promise<void> {
    for (const key of await this.client.keys(`${this.keyPrefix}*`)) await this.client.del(key);
  }
}

/** Only AUTH_SESSION_STORE and REDIS_URL are read; `process.env` satisfies this shape. */
export type SessionStoreEnvironment = Readonly<Record<string, string | undefined>>;

export interface ConfiguredSessionStoreOptions<T> extends MemorySessionStoreOptions<T> {
  readonly env?: SessionStoreEnvironment;
  readonly redisClient?: RedisSessionClient;
  readonly redisKeyPrefix?: string;
}

/**
 * Selects memory by default. Redis selection is explicit and fail-closed: the host must provide
 * REDIS_URL and inject its already-configured RedisSessionClient; this package never creates a
 * connection or adds a Redis dependency.
 */
export function createConfiguredSessionStore<T>(options: ConfiguredSessionStoreOptions<T>): SessionStore<T> {
  const env = options.env ?? process.env;
  const selection = env.AUTH_SESSION_STORE?.trim().toLowerCase() || 'memory';
  if (selection === 'memory') {
    return new MemorySessionStore(options);
  }
  if (selection !== 'redis') throw new Error('AUTH_SESSION_STORE must be memory or redis');
  if (!env.REDIS_URL?.trim()) throw new Error('REDIS_URL is required when AUTH_SESSION_STORE=redis');
  if (!options.redisClient) throw new Error('A RedisSessionClient is required when AUTH_SESSION_STORE=redis');
  return new RedisSessionStore({
    identityOf: options.identityOf,
    expiresAtOf: options.expiresAtOf,
    client: options.redisClient,
    ...(options.redisKeyPrefix === undefined ? {} : { keyPrefix: options.redisKeyPrefix }),
  });
}
