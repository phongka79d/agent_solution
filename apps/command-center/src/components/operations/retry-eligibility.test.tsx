/**
 * @file apps/command-center/src/components/operations/retry-eligibility.test.tsx
 * UI contract tests for SCR-002: Agent Operations Run Retry Eligibility.
 *
 * Observable contracts:
 * 1. SCR-002 retry eligibility strictly rejects unknown or indeterminate outcomes ('UNKNOWN').
 * 2. Only runs with verified side-effect-free failures (SCHEMA_VALIDATION_FAILURE,
 *    AUTHORITY_DENY, FAIL_CLOSED, PRE_DISPATCH_PROVIDER_REJECTION) are eligible for retry.
 * 3. Indeterminate outcomes require reconciliation by effect_key (R18), never blind retry.
 * 4. RunTable renders the Retry button as disabled with explanatory tooltip when a run has UNKNOWN error.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRunProjection } from './types';
import {
  RETRYABLE_FAILURE_CLASSES,
  getRetryEligibility,
  isRunRetryable,
} from './retry-helpers';
import { RunTable } from './RunTable';

describe('SCR-002 Retry Eligibility Contract', () => {
  const baseRun: AgentRunProjection = {
    run_id: 'run-001',
    agent_id: 'CS-01',
    task_version: 1,
    state: 'failed',
    execution_status: 'failed',
    current_step: 2,
    retry_count: 0,
    last_error_class: null,
    started_at: '2026-09-23T11:00:00Z',
  };

  // --------------------------------------------------------------------------
  // 1. Rejection of UNKNOWN / Indeterminate Outcomes
  // --------------------------------------------------------------------------
  describe('Rejection of UNKNOWN / Indeterminate Outcomes', () => {
    it('omits UNKNOWN from the set of retryable failure classes', () => {
      expect(RETRYABLE_FAILURE_CLASSES).not.toContain('UNKNOWN');
      expect(RETRYABLE_FAILURE_CLASSES).toEqual([
        'SCHEMA_VALIDATION_FAILURE',
        'AUTHORITY_DENY',
        'FAIL_CLOSED',
        'PRE_DISPATCH_PROVIDER_REJECTION',
      ]);
    });

    it('rejects retry when last_error_class is UNKNOWN', () => {
      const unknownRun: AgentRunProjection = {
        ...baseRun,
        last_error_class: 'UNKNOWN',
      };

      expect(isRunRetryable(unknownRun)).toBe(false);

      const eligibility = getRetryEligibility(unknownRun);
      expect(eligibility.retryable).toBe(false);
      expect(eligibility.reason).toBe('UNKNOWN');
      expect(eligibility.explanation).toContain('Indeterminate failure outcome (UNKNOWN)');
      expect(eligibility.explanation).toContain('reconciliation via effect_key');
      expect(eligibility.explanation).toContain('not blind retry');
    });

    it('rejects retry when last_error_class is missing or null', () => {
      const noErrorClassRun: AgentRunProjection = {
        ...baseRun,
        last_error_class: null,
      };

      expect(isRunRetryable(noErrorClassRun)).toBe(false);
      const eligibility = getRetryEligibility(noErrorClassRun);
      expect(eligibility.retryable).toBe(false);
      expect(eligibility.reason).toBe('NO_ERROR_CLASS');
    });

    it('rejects retry for non-failed runs even if an error is present', () => {
      const runningRun: AgentRunProjection = {
        ...baseRun,
        state: 'running',
        execution_status: 'executing',
        last_error_class: 'SCHEMA_VALIDATION_FAILURE',
      };

      expect(isRunRetryable(runningRun)).toBe(false);
      const eligibility = getRetryEligibility(runningRun);
      expect(eligibility.retryable).toBe(false);
      expect(eligibility.reason).toBe('NOT_FAILED');
    });

    it('rejects retry for null or undefined run references', () => {
      expect(isRunRetryable(null)).toBe(false);
      expect(isRunRetryable(undefined)).toBe(false);
      expect(getRetryEligibility(null).retryable).toBe(false);
    });

    it('rejects retry for unclassified or fatal runtime errors', () => {
      const fatalErrors = [
        'FATAL_CRASH',
        'TIMEOUT_POST_DISPATCH',
        'DATABASE_CORRUPTION',
        'OUT_OF_MEMORY',
      ];

      for (const err of fatalErrors) {
        const run: AgentRunProjection = {
          ...baseRun,
          last_error_class: err,
        };
        expect(isRunRetryable(run)).toBe(false);
        const eligibility = getRetryEligibility(run);
        expect(eligibility.retryable).toBe(false);
        expect(eligibility.reason).toBe('NON_RETRYABLE_ERROR_CLASS');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Acceptance of Verified Side-Effect-Free Failures
  // --------------------------------------------------------------------------
  describe('Acceptance of Verified Side-Effect-Free Failures', () => {
    it('accepts SCHEMA_VALIDATION_FAILURE for operator retry', () => {
      const run: AgentRunProjection = {
        ...baseRun,
        last_error_class: 'SCHEMA_VALIDATION_FAILURE',
      };
      expect(isRunRetryable(run)).toBe(true);
      expect(getRetryEligibility(run).retryable).toBe(true);
    });

    it('accepts AUTHORITY_DENY for operator retry', () => {
      const run: AgentRunProjection = {
        ...baseRun,
        last_error_class: 'AUTHORITY_DENY',
      };
      expect(isRunRetryable(run)).toBe(true);
      expect(getRetryEligibility(run).retryable).toBe(true);
    });

    it('accepts FAIL_CLOSED for operator retry', () => {
      const run: AgentRunProjection = {
        ...baseRun,
        last_error_class: 'FAIL_CLOSED',
      };
      expect(isRunRetryable(run)).toBe(true);
      expect(getRetryEligibility(run).retryable).toBe(true);
    });

    it('accepts PRE_DISPATCH_PROVIDER_REJECTION for operator retry', () => {
      const run: AgentRunProjection = {
        ...baseRun,
        last_error_class: 'PRE_DISPATCH_PROVIDER_REJECTION',
      };
      expect(isRunRetryable(run)).toBe(true);
      expect(getRetryEligibility(run).retryable).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 3. RunTable Observable UI Rendering
  // --------------------------------------------------------------------------
  describe('RunTable UI Retry Button State', () => {
    it('renders disabled Retry button with explanatory tooltip for UNKNOWN outcome', () => {
      const unknownRun: AgentRunProjection = {
        ...baseRun,
        run_id: 'run-unknown-999',
        last_error_class: 'UNKNOWN',
      };

      const html = renderToStaticMarkup(
        <RunTable
          runs={[unknownRun]}
          isLoading={false}
          selectedRunId={null}
          onSelectRun={() => {}}
          onRetryRun={() => {}}
          nextCursor={null}
          cursorStackLength={0}
          onNextPage={() => {}}
          onPrevPage={() => {}}
        />
      );

      // Must display the run in the table
      expect(html).toContain('run-unknown-999');
      expect(html).toContain('UNKNOWN');

      // The button must be disabled
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Retry[^<]*<\/button>/);
      // Tooltip must explain retry is unavailable
      expect(html).toContain('title="Retry unavailable (only verified side-effect-free failures can be retried)"');
    });

    it('renders enabled Retry button for verified side-effect-free failure', () => {
      const retryableRun: AgentRunProjection = {
        ...baseRun,
        run_id: 'run-safe-123',
        last_error_class: 'SCHEMA_VALIDATION_FAILURE',
      };

      const html = renderToStaticMarkup(
        <RunTable
          runs={[retryableRun]}
          isLoading={false}
          selectedRunId={null}
          onSelectRun={() => {}}
          onRetryRun={() => {}}
          nextCursor={null}
          cursorStackLength={0}
          onNextPage={() => {}}
          onPrevPage={() => {}}
        />
      );

      expect(html).toContain('run-safe-123');
      expect(html).toContain('SCHEMA_VALIDATION_FAILURE');

      // The button must NOT be disabled
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Retry[^<]*<\/button>/);
      // Tooltip indicates safe operator retry
      expect(html).toContain('title="Execute safe operator retry"');
    });

    it('renders totalCount when provided', () => {
      const html = renderToStaticMarkup(
        <RunTable
          runs={[baseRun]}
          isLoading={false}
          selectedRunId={null}
          onSelectRun={() => {}}
          onRetryRun={() => {}}
          nextCursor={null}
          cursorStackLength={0}
          onNextPage={() => {}}
          onPrevPage={() => {}}
          totalCount={42}
        />
      );

      expect(html).toContain('Showing 1 run of 42');
    });

    it('renders correctly when totalCount is undefined or omitted', () => {
      const html = renderToStaticMarkup(
        <RunTable
          runs={[baseRun]}
          isLoading={false}
          selectedRunId={null}
          onSelectRun={() => {}}
          onRetryRun={() => {}}
          nextCursor={null}
          cursorStackLength={0}
          onNextPage={() => {}}
          onPrevPage={() => {}}
          totalCount={undefined}
        />
      );

      expect(html).toContain('Showing 1 run');
      expect(html).not.toContain(' of ');
    });
  });
});
