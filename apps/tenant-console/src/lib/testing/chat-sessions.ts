import 'server-only';
import { randomBytes } from 'node:crypto';

export interface StoredChatSession {
  readonly widgetToken: string;
  readonly sessionId: string;
  readonly widgetOrigin: string;
  readonly conversationId?: string;
  readonly exp: number;
  readonly ownerSessionId: string;
}

type ChatSessionStore = Map<string, StoredChatSession>;

declare global {
  // eslint-disable-next-line no-var
  var __agentosTestingChatSessions: ChatSessionStore | undefined;
}

function store(): ChatSessionStore {
  return globalThis.__agentosTestingChatSessions ??= new Map<string, StoredChatSession>();
}

export function resetChatSessionsForTests(): void {
  globalThis.__agentosTestingChatSessions = new Map<string, StoredChatSession>();
}

export function createChatSession(session: StoredChatSession): string {
  sweepChatSessions();
  let id: string;
  do {
    id = randomBytes(32).toString('base64url');
  } while (store().has(id));
  store().set(id, session);
  return id;
}

export function getChatSession(id: string, now = Date.now()): StoredChatSession | undefined {
  const current = store().get(id);
  if (current && current.exp <= now) {
    store().delete(id);
    return undefined;
  }
  return current;
}

export function updateChatSession(id: string, session: StoredChatSession): void {
  store().set(id, session);
}

function sweepChatSessions(now = Date.now()): void {
  for (const [id, session] of store()) {
    if (session.exp <= now) store().delete(id);
  }
}
