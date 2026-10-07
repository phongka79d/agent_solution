import type { AutonomyPolicyRecord, AutonomyStore } from './types.js';

function key(tenant_id: string, skill_id: string, policy_version: string): string {
  return [tenant_id, skill_id, policy_version].join('\u0000');
}

function copyRecord(record: AutonomyPolicyRecord): AutonomyPolicyRecord {
  return {
    ...record,
    parameters: { ...record.parameters },
    provenance: { ...record.provenance },
    rollback: { ...record.rollback },
  };
}

/** In-memory durable-store test double. The interface is asynchronous so PostgreSQL can bind later. */
export class MemoryAutonomyStore implements AutonomyStore {
  private readonly current = new Map<string, AutonomyPolicyRecord>();
  private readonly history = new Map<string, AutonomyPolicyRecord[]>();
  private readonly pausedTenants = new Set<string>();
  private readonly killSwitchTenants = new Set<string>();

  constructor(initial: readonly AutonomyPolicyRecord[] = []) {
    for (const record of initial) this.put(record);
  }

  getCurrent(input: { tenant_id: string; skill_id: string; policy_version: string }): AutonomyPolicyRecord | undefined {
    const record = this.current.get(key(input.tenant_id, input.skill_id, input.policy_version));
    return record === undefined ? undefined : copyRecord(record);
  }

  put(record: AutonomyPolicyRecord): void {
    const stored = copyRecord(record);
    const scoped = key(record.tenant_id, record.skill_id, record.policy_version);
    this.current.set(scoped, stored);
    const events = this.history.get(scoped) ?? [];
    events.push(copyRecord(stored));
    this.history.set(scoped, events);
  }

  listCurrent(tenant_id: string): readonly AutonomyPolicyRecord[] {
    return [...this.current.values()]
      .filter((record) => record.tenant_id === tenant_id)
      .map(copyRecord);
  }

  listHistory(tenant_id: string): readonly AutonomyPolicyRecord[] {
    const rows: AutonomyPolicyRecord[] = [];
    for (const events of this.history.values()) {
      for (const record of events) if (record.tenant_id === tenant_id) rows.push(copyRecord(record));
    }
    return rows;
  }

  isTenantPaused(tenant_id: string): boolean {
    return this.pausedTenants.has(tenant_id);
  }

  setTenantPaused(tenant_id: string, paused: boolean): void {
    if (paused) this.pausedTenants.add(tenant_id);
    else this.pausedTenants.delete(tenant_id);
  }
  isKillSwitchSet(tenant_id: string): boolean {
    return this.killSwitchTenants.has(tenant_id);
  }

  setKillSwitch(tenant_id: string, on: boolean): void {
    if (on) this.killSwitchTenants.add(tenant_id);
    else this.killSwitchTenants.delete(tenant_id);
  }
}
