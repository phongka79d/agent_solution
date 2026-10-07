'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}

export interface TabsProps {
  readonly tabs: readonly TabItem[];
  readonly defaultTabId?: string;
  readonly activeTabId?: string;
  readonly onTabChange?: (tabId: string) => void;
  readonly className?: string;
}

export function Tabs({ tabs, defaultTabId, activeTabId, onTabChange, className = '' }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [uncontrolledTabId, setUncontrolledTabId] = useState(defaultTabId ?? tabs[0]?.id ?? '');
  const selectedTabId = activeTabId ?? uncontrolledTabId;
  const foundIndex = tabs.findIndex((tab) => tab.id === selectedTabId);
  const selectedIndex = activeTabId !== undefined
    ? foundIndex
    : (foundIndex >= 0 ? foundIndex : 0);
  const selectedTab = selectedIndex >= 0 ? tabs[selectedIndex] : undefined;

  function selectTab(tabId: string): void {
    if (activeTabId === undefined) setUncontrolledTabId(tabId);
    onTabChange?.(tabId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (tabs.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    selectTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <div className={`ui-tabs ${className}`.trim()}>
      <div className="ui-tabs__list" role="tablist">
        {tabs.map((tab, index) => {
          const tabId = `${baseId}-tab-${tab.id}`;
          const panelId = `${baseId}-panel-${tab.id}`;
          const selected = selectedTab?.id === tab.id;
          return (
            <button
              key={tab.id}
              ref={(element) => { tabRefs.current[index] = element; }}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className="ui-focus-ring ui-tabs__tab"
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {selectedTab ? (
        <div
          id={`${baseId}-panel-${selectedTab.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${selectedTab.id}`}
          tabIndex={0}
          className="ui-tabs__panel"
        >
          {selectedTab.content}
        </div>
      ) : null}
    </div>
  );
}
