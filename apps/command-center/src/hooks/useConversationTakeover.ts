/**
 * @file apps/command-center/src/hooks/useConversationTakeover.ts
 * Custom hook holding the SCR-005 takeover lease: acquire, 30s heartbeat renewal, resume on release.
 * Strict adherence to /api/v1 routes in implement/06-api-and-connectors-spec.md and implement/07-human-command-center-ui.md.
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiClient, ApiError } from '../lib/api-client';
import type { TakeoverMode } from '../lib/api-types';
import type { CopilotDraft, TakeoverLeaseState } from '../components/conversation/types';

/** Lease heartbeat interval: 30 seconds against a 60s lease (extend_seconds <= 300). */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_EXTEND_SECONDS = 60;

export interface UseConversationTakeoverParams {
  readonly conversationId: string;
  readonly tenantId: string;
  readonly operatorId: string;
}

export function useConversationTakeover({
  conversationId,
  tenantId,
  operatorId,
}: UseConversationTakeoverParams) {
  const [isTakenOver, setIsTakenOver] = useState(false);
  const [leaseState, setLeaseState] = useState<TakeoverLeaseState>('idle');
  const [leaseExpiresAt, setLeaseExpiresAt] = useState<string | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copilotDraft, setCopilotDraft] = useState<CopilotDraft | null>(null);

  const heartbeatTimerRef = useRef<NodeJS.Timeout | number | null>(null);
  const isTakenOverRef = useRef(isTakenOver);
  isTakenOverRef.current = isTakenOver;

  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  const operatorIdRef = useRef(operatorId);
  operatorIdRef.current = operatorId;

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== null) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  /**
   * Releases the operator takeover lease and returns the conversation to autonomous agent control.
   * Route: POST /api/v1/conversations/{id}/resume
   * This is the ONLY contracted release route for the lease.
   */
  const resumeConversation = useCallback(
    async (options?: { handoffSummary?: string; nextAgentId?: string }): Promise<boolean> => {
      const activeConvId = conversationIdRef.current;
      const activeTenantId = tenantIdRef.current;
      const activeOperatorId = operatorIdRef.current;

      if (!activeConvId || !activeOperatorId) {
        return false;
      }

      setLeaseState('releasing');
      stopHeartbeat();

      try {
        await apiClient.resumeConversation(
          activeConvId,
          {
            operator_id: activeOperatorId,
            handoff_summary: options?.handoffSummary,
            next_agent_id: options?.nextAgentId,
          },
          { tenantId: activeTenantId, operatorId: activeOperatorId }
        );

        setIsTakenOver(false);
        setLeaseState('idle');
        setLeaseExpiresAt(null);
        setErrorMessage(null);
        return true;
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to release takeover lease.';
        console.error('Failed to resume conversation:', err);
        setErrorMessage(message);
        // Even on error, operator has surrendered control locally
        setIsTakenOver(false);
        setLeaseState('idle');
        return false;
      }
    },
    [stopHeartbeat]
  );

  /**
   * Acquires the exclusive operator lease for the conversation.
   * Route: POST /api/v1/conversations/{id}/takeover
   */
  const acquireTakeover = useCallback(
    async (params?: { reason?: string; takeoverMode?: TakeoverMode }): Promise<boolean> => {
      if (!conversationId || !operatorId) {
        setErrorMessage('Cannot acquire takeover: missing conversation or operator identifier.');
        return false;
      }

      setLeaseState('acquiring');
      setErrorMessage(null);

      try {
        const response = await apiClient.takeoverConversation(
          conversationId,
          {
            operator_id: operatorId,
            reason: params?.reason || 'OPERATOR_MANUAL_TAKEOVER',
            takeover_mode: params?.takeoverMode || 'FULL_CONTROL',
          },
          { tenantId, operatorId }
        );

        setIsTakenOver(true);
        setLeaseState('held');
        setLeaseExpiresAt(response.lease_expires_at);
        setErrorMessage(null);

        // Start 30s heartbeat renewal timer (60s lease, extend_seconds: 60)
        stopHeartbeat();
        heartbeatTimerRef.current = setInterval(async () => {
          try {
            const hb = await apiClient.heartbeatTakeover(
              conversationIdRef.current,
              {
                operator_id: operatorIdRef.current,
                extend_seconds: HEARTBEAT_EXTEND_SECONDS,
              },
              { tenantId: tenantIdRef.current, operatorId: operatorIdRef.current }
            );

            setLeaseExpiresAt(hb.lease_expires_at);
            setLastHeartbeatAt(new Date().toISOString());
          } catch (err) {
            console.error('Takeover heartbeat renewal failed:', err);
            stopHeartbeat();
            setIsTakenOver(false);

            if (err instanceof ApiError && err.status === 409) {
              setLeaseState('conflict');
              setErrorMessage(
                'Takeover lease was revoked or claimed by another operator (409 Conflict). Control returned to agent.'
              );
            } else {
              setLeaseState('stale');
              setErrorMessage(
                'Takeover lease renewal timed out or failed. Autonomous agent control restored.'
              );
            }
          }
        }, HEARTBEAT_INTERVAL_MS);

        return true;
      } catch (err) {
        stopHeartbeat();
        setIsTakenOver(false);

        if (err instanceof ApiError && err.status === 409) {
          setLeaseState('conflict');
          setErrorMessage(
            'Lease conflict: Conversation is currently locked by another operator (409 Conflict).'
          );
        } else {
          setLeaseState('error');
          const message = err instanceof Error ? err.message : 'Failed to acquire takeover lease.';
          setErrorMessage(message);
        }
        return false;
      }
    },
    [conversationId, operatorId, tenantId, stopHeartbeat]
  );

  // Clear timers and release lease on component unmount or conversation switch
  useEffect(() => {
    // When conversation ID changes, reset local takeover state
    stopHeartbeat();
    setIsTakenOver(false);
    setLeaseState('idle');
    setLeaseExpiresAt(null);
    setErrorMessage(null);
    setCopilotDraft(null);

    return () => {
      stopHeartbeat();
      if (isTakenOverRef.current && conversationIdRef.current) {
        // Controlled release on navigation/unmount via POST /api/v1/conversations/{id}/resume
        // No beacon to uncontracted routes; resume is the only release route.
        void apiClient.resumeConversation(
          conversationIdRef.current,
          {
            operator_id: operatorIdRef.current,
            handoff_summary: 'OPERATOR_NAVIGATED_AWAY',
          },
          { tenantId: tenantIdRef.current, operatorId: operatorIdRef.current }
        ).catch(() => {
          // Ignore background cleanup failures on teardown
        });
      }
    };
  }, [conversationId, tenantId, operatorId, stopHeartbeat]);

  return {
    isTakenOver,
    leaseState,
    leaseExpiresAt,
    lastHeartbeatAt,
    errorMessage,
    copilotDraft,
    setCopilotDraft,
    acquireTakeover,
    resumeConversation,
    setErrorMessage,
  };
}
