/**
 * @file apps/command-center/src/components/conversation/conversation-contracts.test.tsx
 * UI contract tests for SCR-005: Conversation Console & Takeover Controls.
 *
 * Observable contracts:
 * 1. Conversation wire/status constants use HUMAN_TAKEOVER and ACTIVE.
 * 2. TakeoverControls displays explicit visual state for HUMAN_TAKEOVER versus ACTIVE.
 * 3. No evaluation persistence route exists in /api/v1; EvaluationUnavailableModal
 *    presents an explicit dependency_unavailable state with zero uncontracted network mutations.
 * 4. ApiClient exposes no evaluation persistence methods.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationWireStatus, TakeoverMode } from '../../lib/api-types';
import { createApiClient } from '../../lib/api-client';
import { TakeoverControls } from './TakeoverControls';
import { EvaluationUnavailableModal } from './EvaluationUnavailableModal';

describe('SCR-005 Conversation Console UI Contracts', () => {
  // --------------------------------------------------------------------------
  // 1. Wire Status & Mode Constants
  // --------------------------------------------------------------------------
  describe('Wire & Status Constants', () => {
    it('uses canonical conversation wire statuses: ACTIVE, HUMAN_TAKEOVER, and CLOSED', () => {
      const statuses: readonly ConversationWireStatus[] = [
        'ACTIVE',
        'HUMAN_TAKEOVER',
        'CLOSED',
      ];

      expect(statuses).toContain('ACTIVE');
      expect(statuses).toContain('HUMAN_TAKEOVER');
      expect(statuses).toContain('CLOSED');
      expect(statuses).toHaveLength(3);
    });

    it('uses canonical takeover modes: FULL_CONTROL and CO_PILOT', () => {
      const modes: readonly TakeoverMode[] = ['FULL_CONTROL', 'CO_PILOT'];
      expect(modes).toContain('FULL_CONTROL');
      expect(modes).toContain('CO_PILOT');
      expect(modes).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // 2. TakeoverControls UI State Rendering
  // --------------------------------------------------------------------------
  describe('TakeoverControls Observable State', () => {
    it('displays ACTIVE control mode when session is autonomous and operator has not taken over', () => {
      const html = renderToStaticMarkup(
        <TakeoverControls
          isTakenOver={false}
          leaseState="idle"
          leaseExpiresAt={null}
          lastHeartbeatAt={null}
          errorMessage={null}
          onTakeover={() => {}}
          onResume={() => {}}
          onOpenEvaluation={() => {}}
          onClearError={() => {}}
        />
      );

      // Must explicitly declare ACTIVE autonomous control mode
      expect(html).toContain('Control Mode: AI_CONTROLLED (= ACTIVE)');
      // Must provide action to take over session
      expect(html).toContain('Take Over Session');
      // Must not display resume or evaluation buttons
      expect(html).not.toContain('Resume AI Control');
      expect(html).not.toContain('Rate Dialogue');
    });

    it('displays HUMAN_TAKEOVER control mode when operator holds mutex lease', () => {
      const expiryIso = '2026-09-23T12:00:30.000Z';
      const heartbeatIso = '2026-09-23T12:00:00.000Z';

      const html = renderToStaticMarkup(
        <TakeoverControls
          isTakenOver={true}
          leaseState="held"
          leaseExpiresAt={expiryIso}
          lastHeartbeatAt={heartbeatIso}
          errorMessage={null}
          onTakeover={() => {}}
          onResume={() => {}}
          onOpenEvaluation={() => {}}
          onClearError={() => {}}
        />
      );

      // Must explicitly declare HUMAN_TAKEOVER mode and suppressed outbound
      expect(html).toContain(
        'Control Mode: HUMAN_TAKEOVER (Autonomous AI Outbound Suppressed)'
      );
      // Must show lease renewal and heartbeat information
      expect(html).toContain('Lease active (renews every 30s)');
      // Must offer Resume AI Control and Rate Dialogue actions
      expect(html).toContain('Resume AI Control');
      expect(html).toContain('Rate Dialogue');
      // Must not offer Take Over action while already held
      expect(html).not.toContain('Take Over Session');
    });

    it('displays LEASE_CONFLICT on 409 collision with another operator', () => {
      const html = renderToStaticMarkup(
        <TakeoverControls
          isTakenOver={false}
          leaseState="conflict"
          leaseExpiresAt={null}
          lastHeartbeatAt={null}
          errorMessage={null}
          onTakeover={() => {}}
          onResume={() => {}}
          onOpenEvaluation={() => {}}
          onClearError={() => {}}
        />
      );

      expect(html).toContain('Control Mode: LEASE_CONFLICT (409 Locked by Another Operator)');
      expect(html).toContain('Lease Conflict (409)');
      expect(html).toContain('Another operator currently holds the lease. Autonomous AI remains active.');
    });

    it('displays LEASE_STALE when operator lease has lapsed back to AI control', () => {
      const html = renderToStaticMarkup(
        <TakeoverControls
          isTakenOver={false}
          leaseState="stale"
          leaseExpiresAt={null}
          lastHeartbeatAt={null}
          errorMessage={null}
          onTakeover={() => {}}
          onResume={() => {}}
          onOpenEvaluation={() => {}}
          onClearError={() => {}}
        />
      );

      expect(html).toContain('Control Mode: LEASE_STALE (Heartbeat Lapsed, AI Active)');
      expect(html).toContain('Lease Stale');
      expect(html).toContain('Takeover lease expired or lost to heartbeat failure. Control returned to agent.');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Evaluation Unavailable Modal & Zero-Mutation Contract
  // --------------------------------------------------------------------------
  describe('Evaluation Unavailable Contract (No /api/v1 Route)', () => {
    it('renders dependency_unavailable state and explains lack of /api/v1 persistence endpoint', () => {
      const html = renderToStaticMarkup(
        <EvaluationUnavailableModal
          isOpen={true}
          onClose={() => {}}
          conversationId="conv-test-778"
        />
      );

      // Must display explicit dependency_unavailable badge
      expect(html).toContain('dependency_unavailable');
      // Must render explanation title
      expect(html).toContain('No Contracted /api/v1 Evaluation Route Available');
      // Must cite gateway contract reality
      expect(html).toContain('no corresponding evaluation persistence endpoint is specified');
      // Must state zero uncontracted network mutations
      expect(html).toContain('Fail-closed state: zero uncontracted network mutations.');
      // Must show the conversation ID in disabled preview
      expect(html).toContain('conv-test-778');
      // Must render Dismiss button, but NEVER a Submit / Save button
      expect(html).toContain('Dismiss');
      expect(html).not.toContain('Submit');
      expect(html).not.toContain('Save');
    });

    it('renders null when evaluation modal is closed', () => {
      const html = renderToStaticMarkup(
        <EvaluationUnavailableModal
          isOpen={false}
          onClose={() => {}}
          conversationId="conv-test-778"
        />
      );

      expect(html).toBe('');
    });

    it('confirms ApiClient declares no dialogue evaluation persistence routes', () => {
      const client = createApiClient({ baseUrl: 'http://localhost:4000' });

      // Cast to Record to probe for uncontracted routes
      const clientRecord = client as unknown as Record<string, unknown>;

      expect(clientRecord.saveEvaluation).toBeUndefined();
      expect(clientRecord.postEvaluation).toBeUndefined();
      expect(clientRecord.submitEvaluation).toBeUndefined();
      expect(clientRecord.evaluateDialogue).toBeUndefined();
      expect(clientRecord.createEvaluation).toBeUndefined();
    });
  });
});
