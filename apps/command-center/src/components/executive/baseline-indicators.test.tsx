/**
 * @file apps/command-center/src/components/executive/baseline-indicators.test.tsx
 * UI contract tests for SCR-001: Executive Dashboard Baseline Indicators.
 *
 * Observable contracts:
 * 1. SCR-001 baseline definition includes exactly ten canonical indicators.
 * 2. Absent/unreturned metrics are represented explicitly as NOT_INSTRUMENTED
 *    and never replaced with fabricated zeros, placeholder values, or dropped from the UI.
 * 3. All ten indicators are consistently rendered in the grid even with partial or empty snapshots.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_INDICATOR_DEFINITIONS,
  type BaselineIndicatorDefinition,
  type KpiMetricItem,
  type SourceStatus,
} from './types';
import { MetricCard, getBadgeStyle } from './MetricCard';
import { MetricCardGrid } from './MetricCardGrid';

describe('SCR-001 Baseline Indicators Contract', () => {
  // --------------------------------------------------------------------------
  // 1. Exactly Ten Baseline Indicator Definitions
  // --------------------------------------------------------------------------
  describe('Baseline Indicator Inventory', () => {
    it('defines exactly ten canonical baseline indicators', () => {
      expect(BASELINE_INDICATOR_DEFINITIONS).toHaveLength(10);
    });

    it('contains the expected ten canonical indicator keys in canonical order', () => {
      const keys = BASELINE_INDICATOR_DEFINITIONS.map((def) => def.key);
      expect(keys).toEqual([
        'revenue_twd',
        'leads',
        'conversion_rate',
        'active_campaigns',
        'ai_generated_revenue_twd',
        'cs_status',
        'retention',
        'ai_actions',
        'approval_pending',
        'abnormal_events',
      ]);
    });

    it('each indicator definition declares valid format, label, and description', () => {
      const validFormats: Record<BaselineIndicatorDefinition['format'], true> = {
        currency: true,
        number: true,
        percent: true,
        status: true,
      };

      for (const def of BASELINE_INDICATOR_DEFINITIONS) {
        expect(def.key).toBeTruthy();
        expect(def.label).toBeTruthy();
        expect(validFormats[def.format]).toBe(true);
        expect(def.description).toBeTruthy();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Absent Metrics Represented as NOT_INSTRUMENTED
  // --------------------------------------------------------------------------
  describe('Absent Metric Representation (NOT_INSTRUMENTED)', () => {
    const revenueDef = BASELINE_INDICATOR_DEFINITIONS.find((d) => d.key === 'revenue_twd')!;
    const leadsDef = BASELINE_INDICATOR_DEFINITIONS.find((d) => d.key === 'leads')!;

    it('renders NOT_INSTRUMENTED badge when metric is undefined (absent from snapshot)', () => {
      const html = renderToStaticMarkup(
        <MetricCard definition={revenueDef} metric={undefined} />
      );

      // Must display the explicit NOT_INSTRUMENTED badge
      expect(html).toContain('NOT_INSTRUMENTED');
      // Must display aria-label indicating NOT_INSTRUMENTED status
      expect(html).toContain('1. Revenue indicator: NOT_INSTRUMENTED');
      // Must display reason for absence
      expect(html).toContain('Not returned in snapshot');
      // Must display the "—" empty value placeholder, never "$0" or "0"
      expect(html).toContain('—');
      expect(html).not.toContain('$0');
      expect(html).not.toContain('NT$0');
    });

    it('renders NOT_INSTRUMENTED when source_status is explicitly NOT_INSTRUMENTED', () => {
      const metric: KpiMetricItem = {
        metric: 'revenue_twd',
        value: null,
        source_status: 'NOT_INSTRUMENTED',
        observed_at: null,
      };

      const html = renderToStaticMarkup(
        <MetricCard definition={revenueDef} metric={metric} />
      );

      expect(html).toContain('NOT_INSTRUMENTED');
      expect(html).toContain('Not instrumented');
      expect(html).toContain('—');
    });

    it('renders all ten baseline cards as NOT_INSTRUMENTED when empty metrics array is provided', () => {
      const html = renderToStaticMarkup(<MetricCardGrid metrics={[]} />);

      // All 10 definitions must be rendered
      for (const def of BASELINE_INDICATOR_DEFINITIONS) {
        expect(html).toContain(def.label);
      }

      // Every card should have the NOT_INSTRUMENTED badge (at least 10 occurrences)
      const matches = html.match(/NOT_INSTRUMENTED/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(10);
    });

    it('renders partial metrics while absent indicators remain NOT_INSTRUMENTED without dropping them', () => {
      const partialMetrics: KpiMetricItem[] = [
        {
          metric: 'revenue_twd',
          value: 1250000,
          source_status: 'LIVE',
          observed_at: '2026-09-23T12:00:00Z',
        },
        {
          metric: 'leads',
          value: 450,
          source_status: 'LIVE',
          observed_at: '2026-09-23T12:00:00Z',
        },
      ];

      const html = renderToStaticMarkup(<MetricCardGrid metrics={partialMetrics} />);

      // The 2 present metrics must render with LIVE status
      expect(html).toContain('LIVE');
      expect(html).toContain('1. Revenue indicator: LIVE');
      expect(html).toContain('2. Leads indicator: LIVE');

      // The remaining 8 indicators must still be present as NOT_INSTRUMENTED
      const remainingDefs = BASELINE_INDICATOR_DEFINITIONS.filter(
        (d) => d.key !== 'revenue_twd' && d.key !== 'leads'
      );
      expect(remainingDefs).toHaveLength(8);

      for (const def of remainingDefs) {
        expect(html).toContain(def.label);
        expect(html).toContain(`${def.label} indicator: NOT_INSTRUMENTED`);
      }

      const notInstrumentedMatches = html.match(/NOT_INSTRUMENTED/g);
      expect(notInstrumentedMatches).not.toBeNull();
      expect(notInstrumentedMatches!.length).toBeGreaterThanOrEqual(8);
    });

    it('resolves dictionary metrics and marks unlisted keys as NOT_INSTRUMENTED', () => {
      const dictMetrics = {
        revenue_twd: {
          value: 98000,
          source_status: 'LIVE',
        },
        // All other 9 indicators are omitted
      };

      const html = renderToStaticMarkup(<MetricCardGrid metrics={dictMetrics} />);

      expect(html).toContain('1. Revenue indicator: LIVE');
      // The other indicators must still appear with NOT_INSTRUMENTED
      expect(html).toContain('2. Leads indicator: NOT_INSTRUMENTED');
      expect(html).toContain('3. Conversion Rate indicator: NOT_INSTRUMENTED');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Status Badge Styles
  // --------------------------------------------------------------------------
  describe('SourceStatus Badge Classes', () => {
    it('provides distinct badge styling for all defined source statuses', () => {
      const statuses: SourceStatus[] = [
        'LIVE',
        'STALE',
        'NO_DATA',
        'NOT_INSTRUMENTED',
        'UNAVAILABLE',
        'FAIL_CLOSED',
      ];

      for (const status of statuses) {
        const badgeStyle = getBadgeStyle(status);
        expect(badgeStyle).toBeTruthy();
        expect(typeof badgeStyle).toBe('string');
      }
    });
  });
});
