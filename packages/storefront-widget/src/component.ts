import styles from './styles.css?inline';

export const WIDGET_TAG = 'agent-storefront-widget';

/**
 * Embeddable storefront widget. Isolation is strict: the element renders into a
 * closed shadow root, holds no credential, and performs no network call of its
 * own — host-page code drives it through the `postMessage` bridge (07 §7.3).
 */
export class AgentStorefrontWidget extends HTMLElement {
  readonly #root: ShadowRoot;

  constructor() {
    super();

    this.#root = this.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = styles;
    this.#root.append(style);
  }

  connectedCallback(): void {
    if (this.#root.querySelector('[data-agent-storefront-widget]') !== null) {
      return;
    }

    const placeholder = document.createElement('div');
    placeholder.setAttribute('data-agent-storefront-widget', '');
    placeholder.textContent = 'Agent storefront widget';
    this.#root.append(placeholder);
  }
}

if (typeof customElements !== 'undefined' && customElements.get(WIDGET_TAG) === undefined) {
  customElements.define(WIDGET_TAG, AgentStorefrontWidget);
}
