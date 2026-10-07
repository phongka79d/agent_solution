'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
}

/** Keeps keyboard focus inside a transient surface and restores the opener on close. */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onEscape?: () => void,
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    const activeContainer: HTMLElement = container;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = focusableElements(activeContainer);
    (focusable[0] ?? activeContainer).focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        const target = event.target;
        const activeInside = document.activeElement instanceof Node && activeContainer.contains(document.activeElement);
        if (activeContainer.contains(target as Node | null) || activeInside) {
          event.preventDefault();
          onEscapeRef.current?.();
        }
        return;
      }
      if (!activeContainer.contains(event.target as Node | null)) return;
      if (event.key !== 'Tab') return;

      const elements = focusableElements(activeContainer);
      if (elements.length === 0) {
        event.preventDefault();
        activeContainer.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    };
  }, [containerRef, enabled]);
}
