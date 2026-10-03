/**
 * @file The circuit breaker that guards one tenant/skill execution stream (implement/05 §2, §6.5,
 * NFR-004).
 *
 * Breaker state is scoped by the runtime to `(tenant_id, skill_id)`: one tenant's provider outage
 * never suppresses another tenant, and one skill's failures never suppress a sibling skill that
 * happens to use the same connector. The breaker decides admission only — the engine refuses with
 * `CIRCUIT_BREAKER_OPEN` before any adapter call — and it never dispatches, retries, reserves an
 * effect or reconciles one.
 *
 * The clock is injected: `Date.now` is the default, and a caller that supplies one (the runtime
 * engine does, and a test can) makes the failure threshold and the reset window observable without
 * waiting for them. A supplied clock is the only clock this class reads.
 */

/** Circuit state of one guarded dependency (implement/05 §2). */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Consecutive failures that open a breaker: `5`, `[PROVISIONAL][ASM-002]` per §1.3 — a per-dependency
 * ops baseline, tuned by the operator rather than derived from a measurement.
 */
export const DEFAULT_FAILURE_THRESHOLD = 5;

/**
 * Window an open breaker waits before it admits one half-open probe: `30_000` ms,
 * `[PROVISIONAL][ASM-002]` per §1.3 — a per-dependency ops baseline, like the threshold.
 */
export const DEFAULT_RESET_TIMEOUT_MS = 30_000;

/**
 * Guard of one `guarded_dependency` key (implement/05 §2 `CircuitBreaker`).
 *
 * The state machine makes an unavailable dependency fail fast instead of queueing doomed calls, and
 * it lets recovery traffic back in slowly: `CLOSED -> OPEN` at `failureThreshold` consecutive
 * failures, `OPEN -> HALF_OPEN` once the reset window has fully elapsed, `HALF_OPEN -> CLOSED` on
 * success and `HALF_OPEN -> OPEN` on the next failure, so a dependency that is still broken never
 * sees more than one probe per window.
 *
 * The instance holds injected state only: the consecutive failure count, the stamped state and the
 * timestamp its clock produced. Nothing here reads the ambient time source once a clock is supplied,
 * so a test pins the window exactly.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  /** A single admitted HALF_OPEN call owns this probe until it records a result. */
  private halfOpenProbeInFlight = false;
  /** Stamp of the last state change, read from the injected clock and never from the ambient one. */
  private lastStateChangedAt: number;

  /**
   * Builds a breaker for one tenant/skill stream.
   *
   * @param failureThreshold Consecutive failures that open this breaker; defaults to `5`
   *   (`[PROVISIONAL][ASM-002]`, §1.3).
   * @param resetTimeoutMs Window before an open breaker admits a half-open probe; defaults to
   *   `30_000` ms (`[PROVISIONAL][ASM-002]`, §1.3).
   * @param now Injected clock; defaults to `Date.now`, and the construction stamp is taken from it.
   */
  public constructor(
    private readonly failureThreshold: number = DEFAULT_FAILURE_THRESHOLD,
    private readonly resetTimeoutMs: number = DEFAULT_RESET_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.lastStateChangedAt = this.now();
  }

  /**
   * Decides whether one call to the guarded dependency may proceed.
   *
   * A breaker flips from OPEN to HALF_OPEN once the reset window has elapsed and admits exactly one
   * probe. Further calls are refused until that probe records success or failure; a successful probe
   * closes the breaker and a failed probe re-opens it.
   */
  public canExecute(): boolean {
    if (this.state === 'OPEN') {
      const at = this.now();
      if (at - this.lastStateChangedAt >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.lastStateChangedAt = at;
        this.halfOpenProbeInFlight = true;
        return true;
      }
      return false;
    }
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenProbeInFlight) {
        return false;
      }
      this.halfOpenProbeInFlight = true;
      return true;
    }
    return true;
  }

  /**
   * Records a successful call: the consecutive failure count is reset and the breaker closes.
   *
   * No timestamp is stamped, because the reset window is only ever read while `OPEN`.
   */
  public recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
    this.halfOpenProbeInFlight = false;
  }

  /**
   * Records a failed call: the consecutive count is incremented, and the breaker opens at the
   * threshold — or immediately when the failure came from a `HALF_OPEN` probe, whose single result
   * is the whole test of a dependency that may still be broken.
   *
   * A failure below the threshold leaves the state untouched, so the count is what accumulates over
   * consecutive attempts and a success is what clears it.
   */
  public recordFailure(): void {
    this.failureCount += 1;
    this.halfOpenProbeInFlight = false;
    if (this.failureCount >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.lastStateChangedAt = this.now();
    }
  }

  /**
   * Reports whether a call would be admitted right now, without consuming anything.
   *
   * Waiting for the reset window makes this `true` exactly when the next {@link CircuitBreaker.canExecute}
   * would flip the breaker to `HALF_OPEN` and admit its single probe; a `HALF_OPEN` breaker reports
   * `true` only while no probe is in flight. The availability resolver reads this, so observing a
   * breaker never steals the one probe a caller was owed.
   *
   * @returns `true` when an admitted call would proceed.
   */
  public wouldAdmit(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'HALF_OPEN') return !this.halfOpenProbeInFlight;
    return this.now() - this.lastStateChangedAt >= this.resetTimeoutMs;
  }

  /**
   * Reports the recorded state. It never advances the machine by itself: only `canExecute()` opens
   * the window, so an observer cannot consume the one half-open probe a caller was owed.
   *
   * @returns The current `CircuitState`.
   */
  public getState(): CircuitState {
    return this.state;
  }
}
