import styles from './styles.css?inline';
import {
  buildStorefrontEventRequestBody,
  buildStorefrontStreamRequestBody,
  isOriginAllowed,
  parseStreamChunk,
} from './stream.js';

export const WIDGET_TAG = 'agent-storefront-widget';

interface QueuedMessage {
  readonly id: string;
  readonly message: string;
  /** Reused verbatim on replay so a re-send cannot create a second chat turn (06 §1, BR-006). */
  readonly idempotencyKey: string;
  readonly timestamp: number;
}

interface BridgeIncomingMessage {
  readonly type?: string;
  readonly payload?: {
    readonly focusInput?: boolean;
    readonly eventName?: string;
    readonly eventData?: Record<string, unknown>;
  };
}

/**
 * Embeddable Storefront Customer Widget Web Component (07 §7.2).
 *
 * Constraints:
 * - Zero runtime dependencies (Vanilla TypeScript).
 * - Closed Shadow DOM isolation.
 * - SessionStorage-only conversation and session identifiers.
 * - Browser-safe tenant token and attributes; no enterprise secrets.
 * - Strict host-origin postMessage JSON RPC bridge; outbound messages never target '*'.
 * - Reusable per-message idempotency keys for offline/reconnect replay.
 * - Explicit offline, unavailable, conflict, and empty states.
 */
export class AgentStorefrontWidget extends HTMLElement {
  readonly #root: ShadowRoot;

  private isOpen = false;
  private isOnline = true;
  private isSending = false;

  private tenantId = '';
  private apiUrl = '';
  private hostOrigin = '';
  private tenantToken = '';

  private readonly offlineQueueKey = 'agent_storefront_offline_queue';

  // Event handler references bound for cleanup in disconnectedCallback
  private readonly onWindowMessage = (event: MessageEvent): void => {
    this.handleHostPostMessage(event);
  };

  private readonly onWindowOnline = (): void => {
    this.handleNetworkChange(true);
  };

  private readonly onWindowOffline = (): void => {
    this.handleNetworkChange(false);
  };

  constructor() {
    super();

    this.#root = this.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = styles;
    this.#root.append(style);
  }

  static get observedAttributes(): string[] {
    return ['tenant-id', 'api-url', 'host-origin', 'tenant-token', 'session-token'];
  }

  public attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    const val = newValue ?? '';
    if (name === 'tenant-id') this.tenantId = val;
    if (name === 'api-url') this.apiUrl = val.replace(/\/$/, '');
    if (name === 'host-origin') this.hostOrigin = val;
    if (name === 'tenant-token' || name === 'session-token') this.tenantToken = val;
  }

  public connectedCallback(): void {
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

    // Read attributes if already present
    if (!this.tenantId) this.tenantId = this.getAttribute('tenant-id') ?? '';
    if (!this.apiUrl) this.apiUrl = (this.getAttribute('api-url') ?? '').replace(/\/$/, '');
    if (!this.hostOrigin) this.hostOrigin = this.getAttribute('host-origin') ?? '';
    if (!this.tenantToken) {
      this.tenantToken =
        this.getAttribute('tenant-token') ?? this.getAttribute('session-token') ?? '';
    }

    this.render();
    this.attachDomEvents();
    this.attachWindowEvents();
    this.updateOnlineBadge();

    // Drain any pending messages queued in sessionStorage
    if (this.isOnline) {
      void this.drainOfflineQueue();
    }
  }

  public disconnectedCallback(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.onWindowMessage);
      window.removeEventListener('online', this.onWindowOnline);
      window.removeEventListener('offline', this.onWindowOffline);
    }
  }

  // ============================================================================
  // Session & Storage Management (sessionStorage-only)
  // ============================================================================

  private getSessionId(): string {
    if (typeof sessionStorage === 'undefined') {
      return 'widget-session-fallback';
    }
    let sid = sessionStorage.getItem('agent_session_id');
    if (!sid) {
      sid =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('agent_session_id', sid);
    }
    return sid;
  }

  private setConversationId(cid: string): void {
    if (typeof sessionStorage !== 'undefined' && cid) {
      sessionStorage.setItem('agent_conversation_id', cid);
    }
  }

  private getOfflineQueue(): QueuedMessage[] {
    if (typeof sessionStorage === 'undefined') return [];
    try {
      const raw = sessionStorage.getItem(this.offlineQueueKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveOfflineQueue(queue: QueuedMessage[]): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      if (queue.length === 0) {
        sessionStorage.removeItem(this.offlineQueueKey);
      } else {
        sessionStorage.setItem(this.offlineQueueKey, JSON.stringify(queue));
      }
    } catch {
      // Ignore quota exceeded
    }
  }

  private enqueueOfflineMessage(message: string, idempotencyKey: string): void {
    const queue = this.getOfflineQueue();
    queue.push({
      id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message,
      idempotencyKey,
      timestamp: Date.now(),
    });
    this.saveOfflineQueue(queue);
    this.updateStatusBanner('offline', `Offline: ${queue.length} message(s) queued for reconnect.`);
  }

  private async drainOfflineQueue(): Promise<void> {
    const queue = this.getOfflineQueue();
    if (queue.length === 0) return;

    // Clear queue before replaying to prevent duplicate bursts
    this.saveOfflineQueue([]);
    for (const item of queue) {
      // Replay preserving the exact original idempotency key
      await this.dispatchStreamMessage(item.message, item.idempotencyKey);
    }
  }

  // ============================================================================
  // DOM Rendering & Event Handling
  // ============================================================================

  private render(): void {
    if (this.#root.querySelector('.chat-container') !== null) {
      return;
    }

    const template = document.createElement('div');
    template.innerHTML = `
      <div class="chat-container" id="chatContainer" role="dialog" aria-modal="true" aria-label="Support Chat">
        <div class="chat-header">
          <div class="chat-title-group">
            <span class="chat-title">Customer Support Assistant</span>
            <div class="chat-status-badge" id="statusBadge">
              <span class="status-dot" id="statusDot"></span>
              <span id="statusText">Online</span>
            </div>
          </div>
          <button class="close-btn" id="closeBtn" aria-label="Close support chat" title="Close chat">&times;</button>
        </div>

        <div id="bannerSlot"></div>

        <div class="chat-body" id="chatBody" role="log" aria-live="polite">
          <div class="empty-state" id="emptyState">
            <div class="empty-state-title">How can we help you today?</div>
            <p class="empty-state-subtitle">Ask any question about products, orders, or support.</p>
          </div>
        </div>

        <div class="chat-footer">
          <input
            type="text"
            class="chat-input"
            id="chatInput"
            placeholder="Ask a question..."
            aria-label="Type your message"
            autocomplete="off"
          />
          <button class="send-btn" id="sendBtn" aria-label="Send message">Send</button>
        </div>
      </div>

      <button class="launcher-btn" id="launcherBtn" aria-label="Open support chat" role="button" tabindex="0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </button>
    `;

    while (template.firstChild) {
      this.#root.appendChild(template.firstChild);
    }
  }

  private attachDomEvents(): void {
    const launcherBtn = this.#root.getElementById('launcherBtn');
    const closeBtn = this.#root.getElementById('closeBtn');
    const sendBtn = this.#root.getElementById('sendBtn');
    const chatInput = this.#root.getElementById('chatInput') as HTMLInputElement | null;
    const chatContainer = this.#root.getElementById('chatContainer');

    launcherBtn?.addEventListener('click', () => {
      this.toggleChat(true, true);
    });

    launcherBtn?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleChat(true, true);
      }
    });

    closeBtn?.addEventListener('click', () => {
      this.toggleChat(false);
    });

    sendBtn?.addEventListener('click', () => {
      if (chatInput) this.handleSend(chatInput);
    });

    chatInput?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend(chatInput);
      }
    });

    chatContainer?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.toggleChat(false);
      }
    });
  }

  private attachWindowEvents(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('message', this.onWindowMessage);
    window.addEventListener('online', this.onWindowOnline);
    window.addEventListener('offline', this.onWindowOffline);
  }

  public toggleChat(open: boolean, focusInput = false): void {
    this.isOpen = open;
    const container = this.#root.getElementById('chatContainer');
    const launcher = this.#root.getElementById('launcherBtn');
    const chatInput = this.#root.getElementById('chatInput') as HTMLInputElement | null;

    if (container && launcher) {
      container.classList.toggle('active', open);
      launcher.classList.toggle('hidden', open);
    }

    if (open) {
      if (focusInput && chatInput) {
        setTimeout(() => chatInput.focus(), 50);
      }
    } else {
      launcher?.focus();
    }

    // Outbound bridge message: exact target origin, never '*'
    this.postToHost('AGENT_WIDGET_STATE_CHANGE', { isOpen: this.isOpen });
  }

  private updateOnlineBadge(): void {
    const dot = this.#root.getElementById('statusDot');
    const text = this.#root.getElementById('statusText');
    if (!dot || !text) return;

    if (this.isOnline) {
      dot.className = 'status-dot';
      text.textContent = 'Online';
      this.clearStatusBanner();
    } else {
      dot.className = 'status-dot offline';
      text.textContent = 'Offline';
      this.updateStatusBanner('offline', 'You appear offline. Messages will send upon reconnect.');
    }
  }

  private handleNetworkChange(online: boolean): void {
    this.isOnline = online;
    this.updateOnlineBadge();
    if (online) {
      void this.drainOfflineQueue();
    }
  }

  private updateStatusBanner(type: 'offline' | 'unavailable' | 'error' | 'info', message: string): void {
    const slot = this.#root.getElementById('bannerSlot');
    if (!slot) return;
    slot.innerHTML = `<div class="banner-notice ${type}" role="alert">${message}</div>`;
  }

  private clearStatusBanner(): void {
    const slot = this.#root.getElementById('bannerSlot');
    if (slot) slot.innerHTML = '';
  }

  // ============================================================================
  // Message Handling & Streaming Fetch
  // ============================================================================

  private handleSend(input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text || this.isSending) return;

    input.value = '';

    // Remove empty state placeholder on first message
    const emptyState = this.#root.getElementById('emptyState');
    if (emptyState) {
      emptyState.remove();
    }

    this.appendMessage('user', text);

    // Mint deterministic idempotency key for this turn
    const idempotencyKey =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `idemp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    void this.dispatchStreamMessage(text, idempotencyKey);
  }

  private appendMessage(sender: 'user' | 'agent' | 'system', content: string): HTMLDivElement | null {
    const body = this.#root.getElementById('chatBody');
    if (!body) return null;

    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${sender}`;

    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${sender}`;
    bubble.textContent = content;

    wrapper.appendChild(bubble);
    body.appendChild(wrapper);
    body.scrollTop = body.scrollHeight;

    return bubble;
  }

  private showTypingIndicator(): HTMLElement | null {
    const body = this.#root.getElementById('chatBody');
    if (!body) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper agent';
    wrapper.id = 'activeTypingIndicator';

    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

    wrapper.appendChild(indicator);
    body.appendChild(wrapper);
    body.scrollTop = body.scrollHeight;

    return wrapper;
  }

  private removeTypingIndicator(): void {
    const el = this.#root.getElementById('activeTypingIndicator');
    el?.remove();
  }

  /**
   * Dispatches one chat turn to POST /api/v1/storefront/stream (R11).
   * Streams response deltas into the UI and records conversation receipt.
   * Replays original idempotencyKey on retry to avoid duplicating turns.
   */
  public async dispatchStreamMessage(message: string, idempotencyKey: string): Promise<void> {
    if (!this.isOnline || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      this.enqueueOfflineMessage(message, idempotencyKey);
      return;
    }

    this.isSending = true;
    this.showTypingIndicator();

    const url = `${this.apiUrl}/api/v1/storefront/stream`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.tenantToken) {
      headers['Authorization'] = `Bearer ${this.tenantToken}`;
    }
    if (this.tenantId) {
      headers['x-tenant-id'] = this.tenantId;
    }

    const body = JSON.stringify(
      buildStorefrontStreamRequestBody(message, idempotencyKey, this.getSessionId()),
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });

      this.removeTypingIndicator();

      // Handle specific HTTP error envelopes
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.updateStatusBanner('unavailable', 'Service unavailable: permission denied.');
          this.appendMessage('system', 'Unable to send: permission denied.');
          return;
        }

        if (response.status === 409) {
          this.updateStatusBanner('error', 'Request conflict: message already processed.');
          this.appendMessage('system', 'Conflict: message was previously processed or has expired.');
          return;
        }

        // Retryable server errors (500, 502, 503)
        this.enqueueOfflineMessage(message, idempotencyKey);
        this.updateStatusBanner('unavailable', 'Support service is temporarily unavailable. Queued for retry.');
        this.appendMessage('system', 'Service unavailable. Queued for automatic retry.');
        return;
      }

      if (!response.body) {
        throw new Error('Stream response body is missing');
      }

      // Stream parsing loop
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let agentBubble: HTMLDivElement | null = null;
      let accumulatedText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const rawChunk = decoder.decode(value, { stream: true });
        const parsed = parseStreamChunk(rawChunk);

        if (parsed.receipt?.conversation_id) {
          this.setConversationId(parsed.receipt.conversation_id);
        }

        if (parsed.text) {
          if (!agentBubble) {
            agentBubble = this.appendMessage('agent', '');
          }
          accumulatedText += parsed.text;
          if (agentBubble) {
            agentBubble.textContent = accumulatedText;
          }
        }

        if (parsed.statusMarker) {
          const lowerMarker = parsed.statusMarker.toLowerCase();
          if (lowerMarker.includes('pending') || lowerMarker.includes('awaiting_human')) {
            this.appendMessage('system', `Request status: ${parsed.statusMarker}`);
          }
        }
      }
    } catch {
      this.removeTypingIndicator();
      // Network interruption or aborted fetch: queue with original idempotencyKey
      this.enqueueOfflineMessage(message, idempotencyKey);
      this.appendMessage('system', 'Connection interrupted. Queued for automatic retry.');
    } finally {
      this.isSending = false;
    }
  }

  // ============================================================================
  // First-party Storefront Events (R12 / API-002)
  // ============================================================================

  public async sendStorefrontEvent(
    eventName: string,
    eventData?: Record<string, unknown>,
  ): Promise<void> {
    const url = `${this.apiUrl}/api/v1/storefront/events`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.tenantToken) {
      headers['Authorization'] = `Bearer ${this.tenantToken}`;
    }
    if (this.tenantId) {
      headers['x-tenant-id'] = this.tenantId;
    }

    const payload = buildStorefrontEventRequestBody(eventName, eventData, this.getSessionId());

    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch {
      // Granular telemetry event drop is non-fatal for chat interaction
    }
  }

  // ============================================================================
  // postMessage JSON RPC Bridge (07 §7.3, UI-TEST-007)
  // ============================================================================

  private handleHostPostMessage(event: MessageEvent): void {
    if (!isOriginAllowed(event.origin, this.hostOrigin)) {
      // Discard messages from unauthorized or mismatched origins
      return;
    }

    const data = event.data as BridgeIncomingMessage;
    if (!data || typeof data !== 'object' || !data.type) {
      return;
    }

    switch (data.type) {
      case 'AGENT_WIDGET_OPEN':
        this.toggleChat(true, Boolean(data.payload?.focusInput));
        break;

      case 'AGENT_WIDGET_SEND_EVENT':
        if (data.payload?.eventName) {
          void this.sendStorefrontEvent(data.payload.eventName, data.payload.eventData);
        }
        break;
    }
  }

  /**
   * Posts a bridge message to window.parent targeting the exact configured host-origin.
   * Wildcard '*' is strictly prohibited (07 §7.3, UI-TEST-007).
   */
  private postToHost(type: string, payload: unknown): void {
    if (typeof window === 'undefined' || !this.hostOrigin) {
      return;
    }

    window.parent.postMessage(
      {
        type,
        payload,
      },
      this.hostOrigin,
    );
  }

  /**
   * Dispatches checkout navigation request to merchant host page via postMessage.
   * Keeps merchant checkout unblocked (07 §7.3).
   */
  public requestHostCheckout(cartId: string, checkoutUrl: string): void {
    this.postToHost('AGENT_NAVIGATE_CHECKOUT', { cartId, checkoutUrl });
  }
}

if (typeof customElements !== 'undefined' && customElements.get(WIDGET_TAG) === undefined) {
  customElements.define(WIDGET_TAG, AgentStorefrontWidget);
}
