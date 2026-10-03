/**
 * @file Unit matrix of the live availability resolver plus its engine integration (PLAN T4.3).
 *
 * Every reason in the vocabulary is exercised through its own port, and every port is also made to
 * throw, because "gate outage fails closed" is the property the resolver exists to guarantee. The
 * engine suite at the bottom proves that the gate is an AND with the row flag and that a shared
 * breaker table is keyed `tenant + dependency`.
 */

import { describe, expect, it } from 'vitest';

import { SkillError } from '../contracts/index.js';
import { createSkillBreakerRegistry, createSkillAvailability, type SkillAvailabilityOptions } from './availability.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { createHarness, dispatchRequest } from '../testing/harness.js';

/** A fully-admitting set of ports; each test overrides exactly the gate under test. */
function admittingPorts(): SkillAvailabilityOptions {
  return {
    settings: () => ({ enabled: true, connector_id: 'connector-1', version: '1' }),
    catalog: () => ({
      entitled: true,
      retired: false,
      connector_kinds: ['catalog'],
      allowed_agents: ['CS-01'],
      dependency: 'API-001.CatalogConnector',
      contract_version: '1',
    }),
    connectors: () => ({ status: 'BOUND' }),
    agents: () => [{ agent_code: 'CS-01', active: true }],
    autonomy: () => ({ paused: false, parked: false }),
    breakers: () => false,
    ownerInputs: () => 0,
  };
}

async function reasonFor(overrides: Partial<SkillAvailabilityOptions>): Promise<string> {
  const gate = createSkillAvailability({ ...admittingPorts(), ...overrides });
  return (await gate.available('tenant-1', 'skill.sales.check_price')).reason;
}

describe('createSkillAvailability reason matrix', () => {
  it('admits a skill only when every gate passes', async () => {
    const gate = createSkillAvailability(admittingPorts());
    expect(await gate.available('tenant-1', 'skill.sales.check_price')).toEqual({
      available: true,
      reason: 'OK',
    });
  });

  it('refuses DISABLED_BY_TENANT when the row is absent or disabled', async () => {
    expect(await reasonFor({ settings: () => null })).toBe('DISABLED_BY_TENANT');
    expect(
      await reasonFor({ settings: () => ({ enabled: false, connector_id: 'connector-1', version: '1' }) }),
    ).toBe('DISABLED_BY_TENANT');
  });

  it('refuses NOT_ENTITLED when the catalog entry is absent, retired or not entitled', async () => {
    expect(await reasonFor({ catalog: () => null })).toBe('NOT_ENTITLED');
    expect(
      await reasonFor({
        catalog: () => ({
          entitled: true,
          retired: true,
          connector_kinds: [],
          allowed_agents: [],
          dependency: null,
          contract_version: '1',
        }),
      }),
    ).toBe('NOT_ENTITLED');
    expect(
      await reasonFor({
        catalog: () => ({
          entitled: false,
          retired: false,
          connector_kinds: [],
          allowed_agents: [],
          dependency: null,
          contract_version: '1',
        }),
      }),
    ).toBe('NOT_ENTITLED');
  });

  it('refuses CONNECTOR_UNBOUND when the contract needs a connector and none is bound', async () => {
    expect(
      await reasonFor({ settings: () => ({ enabled: true, connector_id: null, version: '1' }) }),
    ).toBe('CONNECTOR_UNBOUND');
    expect(await reasonFor({ connectors: () => null })).toBe('CONNECTOR_UNBOUND');
    expect(await reasonFor({ connectors: () => ({ status: 'UNBOUND' }) })).toBe('CONNECTOR_UNBOUND');
  });

  it('never requires a connector for a contract that declares none', async () => {
    expect(
      await reasonFor({
        catalog: () => ({
          entitled: true,
          retired: false,
          connector_kinds: [],
          allowed_agents: [],
          dependency: null,
          contract_version: '1',
        }),
        connectors: () => {
          throw new Error('connector port must not be consulted');
        },
      }),
    ).toBe('OK');
  });

  it('refuses CONNECTOR_UNHEALTHY for DEGRADED and DISABLED bindings', async () => {
    expect(await reasonFor({ connectors: () => ({ status: 'DEGRADED' }) })).toBe('CONNECTOR_UNHEALTHY');
    expect(await reasonFor({ connectors: () => ({ status: 'DISABLED' }) })).toBe('CONNECTOR_UNHEALTHY');
  });

  it('refuses NO_ASSIGNED_AGENT for an empty assignment and AGENT_INACTIVE when none is activated', async () => {
    expect(await reasonFor({ agents: () => [] })).toBe('NO_ASSIGNED_AGENT');
    expect(await reasonFor({ agents: () => [{ agent_code: 'CS-01', active: false }] })).toBe('AGENT_INACTIVE');
  });

  it('refuses PARKED_UNTIL_PROMOTED and AUTONOMY_PAUSED separately', async () => {
    expect(await reasonFor({ autonomy: () => ({ paused: false, parked: true }) })).toBe('PARKED_UNTIL_PROMOTED');
    expect(await reasonFor({ autonomy: () => ({ paused: true, parked: false }) })).toBe('AUTONOMY_PAUSED');
    // A tenant pause outranks a parked draft: nothing in the tenant may run.
    expect(await reasonFor({ autonomy: () => ({ paused: true, parked: true }) })).toBe('PARKED_UNTIL_PROMOTED');
  });

  it('refuses only a skill whose dependency projection has unresolved owner inputs', async () => {
    expect(await reasonFor({ breakers: () => true })).toBe('BREAKER_OPEN');
    const dependencies: Readonly<Record<string, number>> = {
      'skill.mkt.segment_audience': 1,
    };
    const gate = createSkillAvailability({
      ...admittingPorts(),
      ownerInputs: (_tenant_id, skill_id) => dependencies[skill_id] ?? 0,
    });

    expect((await gate.available('tenant-1', 'skill.mkt.segment_audience')).reason).toBe('OWNER_INPUT_UNRESOLVED');
    expect((await gate.available('tenant-1', 'skill.care.search_faq')).reason).toBe('OK');
  });

  it('fails closed with each gate reason when a port throws', async () => {
    const boom = () => {
      throw new Error('database unavailable');
    };
    expect(await reasonFor({ settings: boom })).toBe('DISABLED_BY_TENANT');
    expect(await reasonFor({ catalog: boom })).toBe('NOT_ENTITLED');
    expect(await reasonFor({ connectors: boom })).toBe('CONNECTOR_UNHEALTHY');
    expect(await reasonFor({ agents: boom })).toBe('AGENT_INACTIVE');
    expect(await reasonFor({ autonomy: boom })).toBe('AUTONOMY_PAUSED');
    expect(await reasonFor({ breakers: boom })).toBe('BREAKER_OPEN');
    expect(await reasonFor({ ownerInputs: boom })).toBe('OWNER_INPUT_UNRESOLVED');
  });
});

describe('createSkillAvailability cache', () => {
  it('caches a verdict for at most five seconds and recomputes after the TTL', async () => {
    let clock = 0;
    let broken = false;
    const gate = createSkillAvailability({
      ...admittingPorts(),
      now: () => clock,
      breakers: () => broken,
    });
    expect((await gate.available('tenant-1', 'skill.sales.check_price')).reason).toBe('OK');

    broken = true;
    expect((await gate.available('tenant-1', 'skill.sales.check_price')).reason).toBe('OK');
    clock += 5_001;
    expect((await gate.available('tenant-1', 'skill.sales.check_price')).reason).toBe('BREAKER_OPEN');
  });

  it('clamps an over-long TTL and invalidates when the settings or contract version advances', async () => {
    let clock = 0;
    let version = '1';
    const gate = createSkillAvailability({
      ...admittingPorts(),
      now: () => clock,
      ttlMs: 60_000,
      settings: () => ({ enabled: true, connector_id: 'connector-1', version }),
    });
    expect((await gate.available('tenant-1', 'skill.sales.check_price')).reason).toBe('OK');

    version = '2';
    expect((await gate.available('tenant-1', 'skill.sales.check_price')).reason).toBe('OK');
    clock += 5_001;
    version = '3';
    gate.invalidate('tenant-1');
    expect((await gate.available('tenant-1', 'skill.sales.check_price')).reason).toBe('OK');
  });
});

describe('skill engine gate integration', () => {
  it('refuses SKILL_UNAVAILABLE naming the reason and never reaches the adapter', async () => {
    const harness = createHarness({
      engine: {
        gate: { available: async () => ({ available: false, reason: 'CONNECTOR_UNHEALTHY' }) },
      },
    });
    const failure = await harness.engine.dispatch(dispatchRequest()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SkillError);
    expect((failure as SkillError).code).toBe('SKILL_UNAVAILABLE');
    expect((failure as SkillError).message).toContain('CONNECTOR_UNHEALTHY');
    expect(harness.invocations).toHaveLength(0);
  });

  it('fails closed when the gate itself throws', async () => {
    const harness = createHarness({
      engine: {
        gate: {
          available: () => {
            throw new Error('settings database is down');
          },
        },
      },
    });
    const failure = await harness.engine.dispatch(dispatchRequest()).catch((error: unknown) => error);
    expect((failure as SkillError).code).toBe('SKILL_UNAVAILABLE');
    expect(harness.invocations).toHaveLength(0);
  });

  it('dispatches normally when the gate admits and the row is enabled', async () => {
    const harness = createHarness({
      engine: { gate: { available: async () => ({ available: true, reason: 'OK' }) } },
    });
    const result = await harness.engine.dispatch(dispatchRequest());
    expect(result.verdict).toBe('AUTO_APPROVED');
    expect(harness.invocations).toHaveLength(1);
  });
});

describe('shared breaker table', () => {
  it('keys state by tenant and dependency, not by skill', async () => {
    let clock = 0;
    const registry = createSkillBreakerRegistry({ now: () => clock });
    const first = registry.forDependency('tenant-1', 'API-001.CatalogConnector');
    expect(first).toBe(registry.forDependency('tenant-1', 'API-001.CatalogConnector'));
    expect(first).not.toBe(registry.forDependency('tenant-2', 'API-001.CatalogConnector'));
    expect(first).not.toBe(registry.forDependency('tenant-1', 'API-001.OrderConnector'));

    for (let i = 0; i < 5; i += 1) registry.forDependency('tenant-1', 'API-001.CatalogConnector').recordFailure();
    expect(registry.isOpen('tenant-1', 'API-001.CatalogConnector')).toBe(true);
    expect(registry.isOpen('tenant-2', 'API-001.CatalogConnector')).toBe(false);

    clock += 30_000;
    expect(registry.isOpen('tenant-1', 'API-001.CatalogConnector')).toBe(false);
  });

  it('evicts idle CLOSED entries to stay within its configured maximum', () => {
    let clock = 0;
    const registry = createSkillBreakerRegistry({ now: () => clock, ttlMs: 10, maxEntries: 2 });
    const idle = registry.forDependency('tenant-idle', 'API-001.CatalogConnector');

    clock = 10;
    registry.forDependency('tenant-active', 'API-001.CatalogConnector');
    expect(registry.forDependency('tenant-idle', 'API-001.CatalogConnector')).not.toBe(idle);
  });

  it('retains an idle OPEN breaker through cooldown and while its HALF_OPEN probe is in flight', () => {
    let clock = 0;
    const registry = createSkillBreakerRegistry({ now: () => clock, ttlMs: 10, maxEntries: 2 });
    const open = registry.forDependency('tenant-open', 'API-001.CatalogConnector');
    for (let i = 0; i < 5; i += 1) open.recordFailure();
    expect(open.getState()).toBe('OPEN');

    registry.forDependency('tenant-idle', 'API-001.CatalogConnector');
    clock = 10;
    registry.forDependency('tenant-new', 'API-001.CatalogConnector');

    expect(registry.forDependency('tenant-open', 'API-001.CatalogConnector')).toBe(open);
    expect(registry.isOpen('tenant-open', 'API-001.CatalogConnector')).toBe(true);
    expect(open.canExecute()).toBe(false);

    clock = 30_000;
    expect(registry.forDependency('tenant-open', 'API-001.CatalogConnector')).toBe(open);
    expect(open.canExecute()).toBe(true);
    clock += 10;
    registry.forDependency('tenant-next', 'API-001.CatalogConnector');
    expect(registry.forDependency('tenant-open', 'API-001.CatalogConnector')).toBe(open);
    expect(open.canExecute()).toBe(false);
  });

  it('refuses new entries rather than evicting OPEN or HALF_OPEN recovery state at capacity', () => {
    let clock = 0;
    const registry = createSkillBreakerRegistry({ now: () => clock, ttlMs: 10, maxEntries: 1 });
    const breaker = registry.forDependency('tenant-open', 'API-001.CatalogConnector');
    for (let i = 0; i < 5; i += 1) breaker.recordFailure();

    clock = 10;
    expect(() => registry.forDependency('tenant-other', 'API-001.CatalogConnector'))
      .toThrow('BREAKER_REGISTRY_FULL');
    expect(registry.forDependency('tenant-open', 'API-001.CatalogConnector')).toBe(breaker);

    clock = 30_000;
    expect(breaker.canExecute()).toBe(true);
    clock += 10;
    expect(() => registry.forDependency('tenant-other', 'API-001.CatalogConnector'))
      .toThrow('BREAKER_REGISTRY_FULL');
    expect(breaker.canExecute()).toBe(false);
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });

  it('releases a half-open probe when a call never records an outcome', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker(1, 30_000, () => clock);
    expect(breaker.canExecute()).toBe(true);
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');

    clock += 30_000;
    expect(breaker.canExecute()).toBe(true);
    // The single probe is in flight and refuses a second caller in the same window.
    expect(breaker.canExecute()).toBe(false);
    expect(breaker.wouldAdmit()).toBe(false);
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
  });
});
