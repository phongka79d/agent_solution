/**
 * @file apps/command-center/src/app/(dashboard)/takeover/page.tsx
 * Command Center page hosting SCR-005: Conversation Console.
 * Reads conversation id, tenant id, and operator id from URL search parameters without inventing mock conversations.
 */
'use client';

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ConversationConsole } from '../../../components/conversation/ConversationConsole';

function TakeoverPageContent() {
  const searchParams = useSearchParams();

  // Extract identifiers from query parameters; do not invent mock conversations when omitted
  const conversationId =
    searchParams.get('id') ||
    searchParams.get('conversation_id') ||
    searchParams.get('conversationId') ||
    '';

  const tenantId =
    searchParams.get('tenant_id') ||
    searchParams.get('tenantId') ||
    '';

  const operatorId =
    searchParams.get('operator_id') ||
    searchParams.get('operatorId') ||
    '';

  return (
    <main className="min-h-screen bg-slate-950 flex flex-col">
      <ConversationConsole
        initialConversationId={conversationId}
        initialTenantId={tenantId}
        initialOperatorId={operatorId}
      />
    </main>
  );
}

export default function TakeoverPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-8 text-slate-400">
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-ping" />
            <span>Loading Conversation Console (SCR-005)...</span>
          </div>
        </div>
      }
    >
      <TakeoverPageContent />
    </Suspense>
  );
}
