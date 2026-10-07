'use client';

import type { ReactNode } from 'react';

export interface SidebarItem {
  readonly href: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly active?: boolean;
  readonly badge?: ReactNode;
}

export interface SidebarProps {
  readonly items: readonly SidebarItem[];
  readonly collapsed?: boolean;
  readonly workspace?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function Sidebar({ items, collapsed = false, workspace, footer, className = '' }: SidebarProps) {
  return (
    <aside
      className={`app-sidebar ${collapsed ? 'app-sidebar--collapsed' : ''} ${className}`.trim()}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {workspace ? <div className="app-sidebar__workspace">{workspace}</div> : null}
      <ul className="app-sidebar__items">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              className={`ui-focus-ring app-sidebar__link ${item.active ? 'app-sidebar__link--active' : ''}`.trim()}
              aria-current={item.active ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
            >
              {item.icon ? <span className="app-sidebar__icon" aria-hidden="true">{item.icon}</span> : null}
              <span className={collapsed ? 'app-sidebar__label sr-only' : 'app-sidebar__label'}>{item.label}</span>
              {item.badge ? <span className="app-sidebar__badge">{item.badge}</span> : null}
            </a>
          </li>
        ))}
      </ul>
      {footer ? <div className="app-sidebar__footer">{footer}</div> : null}
    </aside>
  );
}
