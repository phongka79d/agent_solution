/**
 * @file In-memory execution lease (implement/04 §4.3, §4.4).
 *
 * Implements `DurableLeaseManager` without Redis: the §4.3 contract, not its transport. The lease
 * is the fast coordinator that keeps two workers from running the same `(tenant_id, run_id)`; the
 * durable `task.claim` guard is still the authority, so this binding may be replaced by the Redis
 * mutex without any caller changing.
 *
 * Semantics mirrored from §4.3: a live lease held by another worker refuses acquisition (it is
 * never stolen on a whim), the owning worker may re-acquire it (the retry path refreshes its own
 * lock rather than fighting itself), and a lease past its TTL is reclaimable by anyone because its
 * owner is presumed dead. `releaseLease` deletes only the caller's own lease: a stale worker must
 * never delete the live owner's lock.
 */

import type { DurableLeaseManager } from '../contracts/ports.js';

export interface MemoryLeaseManagerOptions {
  /** Injectable clock (milliseconds since epoch) so TTL expiry is testable without waiting. */
  readonly now?: () => number;
  /** Lease TTL in milliseconds. Defaults to the §4.3 value (30 s). */
  readonly lease_ttl_ms?: number;
}

/** §4.3: `leaseTtlMs = 30000` — short enough that a crashed worker is recoverable, long enough
 * that a live step is not stolen mid-flight. */
const DEFAULT_LEASE_TTL_MS = 30_000;

interface LeaseRow {
  owner: string;
  expires_at: number;
}

export class MemoryLeaseManager implements DurableLeaseManager {
  private readonly leases = new Map<string, LeaseRow>();
  private readonly now: () => number;
  private readonly leaseTtlMs: number;

  constructor(options: MemoryLeaseManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.leaseTtlMs = options.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS;
  }

  /**
   * @returns `true` when the lease is now held by `worker_id` (freshly acquired, refreshed, or
   *   reclaimed after expiry); `false` while another worker holds a live lease. Nothing is mutated
   *   on refusal.
   */
  public async acquireLease(tenant_id: string, run_id: string, worker_id: string): Promise<boolean> {
    const key = `${tenant_id}\u0000${run_id}`;
    const held = this.leases.get(key);
    const now = this.now();
    if (held !== undefined && held.owner !== worker_id && held.expires_at > now) {
      return false;
    }
    this.leases.set(key, { owner: worker_id, expires_at: now + this.leaseTtlMs });
    return true;
  }

  /** Releases the lease. A caller that does not own it is a no-op (§4.3 Lua compare-and-delete). */
  public async releaseLease(tenant_id: string, run_id: string, worker_id: string): Promise<void> {
    const key = `${tenant_id}\u0000${run_id}`;
    const held = this.leases.get(key);
    if (held !== undefined && held.owner === worker_id) {
      this.leases.delete(key);
    }
  }
}
