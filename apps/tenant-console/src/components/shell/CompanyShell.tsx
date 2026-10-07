'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, BookOpen, Bot, LayoutDashboard, Megaphone, MessagesSquare, Plug, Settings, ShieldCheck, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { can, canAny, type AuthSession, type Permission } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { DemoBadge } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from '../auth/SessionProvider';

type NavItem = {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly permission?: Permission;
  readonly permissions?: readonly Permission[];
  readonly demo?: boolean;
};


const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: t('nav.overview'), description: t('nav.description.overview'), icon: LayoutDashboard, permission: 'telemetry:read' },
  { href: '/ai-team', label: t('nav.ai_team'), description: t('nav.description.ai_team'), icon: Bot, permission: 'telemetry:read' },
  { href: '/customers', label: t('nav.customers'), description: t('nav.description.customers'), icon: Users, permission: 'customer:read' },
  { href: '/conversations', label: t('nav.conversations'), description: t('nav.description.conversations'), icon: MessagesSquare, permissions: ['conversation:takeover', 'customer:read'] },
  { href: '/campaigns', label: t('nav.campaigns'), description: t('nav.description.campaigns'), icon: Megaphone, permissions: ['campaign:draft', 'approval:read'] },
  { href: '/approvals', label: t('nav.approvals'), description: t('nav.description.approvals'), icon: ShieldCheck, permission: 'approval:read' },
  { href: '/knowledge', label: t('nav.knowledge'), description: t('nav.description.knowledge'), icon: BookOpen, permission: 'telemetry:read' },
  { href: '/integrations', label: t('nav.integrations'), description: t('nav.description.integrations'), icon: Plug, permission: 'telemetry:read' },
  { href: '/analytics', label: t('nav.analytics'), description: t('nav.description.analytics'), icon: BarChart3, permission: 'telemetry:read' },
  { href: '/settings', label: t('nav.settings'), description: t('nav.description.settings'), icon: Settings },
  { href: '/ai-team/sales/try', label: t('nav.try_assistant'), description: t('nav.description.try_assistant'), icon: Sparkles, permission: 'conversation:takeover', demo: true },
];


function hasPermission(session: AuthSession | null, item: NavItem): boolean {
  if (item.permissions) return canAny(session, item.permissions);
  return item.permission === undefined || can(session, item.permission);
}

function pageLabel(pathname: string): string {
  if (pathname === '/') return t('nav.overview');
  if (pathname.startsWith('/ai-team')) return t('nav.ai_team');
  if (pathname.startsWith('/customers')) return t('nav.customers');
  if (pathname.startsWith('/conversations') || pathname.startsWith('/takeover')) return t('nav.conversations');
  if (pathname.startsWith('/approvals')) return t('nav.approvals');
  if (pathname.startsWith('/campaigns') || pathname.startsWith('/demo/campaigns')) return t('nav.campaigns');
  if (pathname.startsWith('/knowledge')) return t('nav.knowledge');
  if (pathname.startsWith('/integrations')) return t('nav.integrations');
  if (pathname.startsWith('/analytics')) return t('nav.analytics');
  if (pathname.startsWith('/settings')) return t('nav.settings');
  if (pathname.startsWith('/demo/')) return t('nav.try_assistant');
  return t('auth.company_workspace');
}

function MenuIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" /></svg>;
}

function CloseIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" /></svg>;
}

export function CompanyShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() || '/';
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  }

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((item) => hasPermission(session, item)),
    [session],
  );


  async function logout() {
    setLoggingOut(true);
    try {
      await tenantConsoleClient.signOut();
    } finally {
      window.location.assign('/sign-in');
    }
  }

  return (
    <div className="app-shell tenant-shell" data-app="tenant" data-responsive-shell="true">
      <a className="app-shell__skip-link ui-focus-ring" href="#main-content">Skip to content</a>
      <button
        type="button"
        aria-label="Đóng menu"
        className={`tenant-shell__scrim fixed inset-0 z-20 lg:hidden ${menuOpen ? 'block' : 'hidden'}`}
        onClick={closeMenu}
      />
      <aside
        className="app-sidebar tenant-sidebar"
        data-open={menuOpen}
        aria-label="Company navigation"
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen ? true : undefined}
      >
        <div className="tenant-sidebar__inner">
          <Link href="/" className="tenant-brand ui-focus-ring" aria-label="AgentOS company overview">
            <span className="tenant-brand__mark" aria-hidden="true">A</span>
            <span className="min-w-0">
              <span className="tenant-brand__name">AgentOS</span>
              <span className="tenant-brand__context">Company workspace</span>
            </span>
          </Link>

          <div className="tenant-workspace">
            <p className="tenant-sidebar__eyebrow">Workspace</p>
            <p className="tenant-workspace__name" title={session?.membership.tenant_id}>
              {session?.membership.tenant_name ?? session?.membership.tenant_id ?? 'Sign in to identify'}
            </p>
            <span className="tenant-workspace__status"><span aria-hidden="true" /> Production</span>
          </div>

          <nav className="tenant-sidebar__nav" aria-label="Company sections">
            <ul>
              {visibleItems.map((item) => {
                const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href.split('?')[0] ?? item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={`app-sidebar__link tenant-nav-link ui-focus-ring ${active ? 'app-sidebar__link--active' : ''}`}
                    >
                      <span className="tenant-nav-link__icon" aria-hidden="true"><Icon aria-hidden="true" size={16} /></span>
                      <span className="app-sidebar__label tenant-nav-link__copy">
                        <span>{item.label}</span>
                        {item.demo ? <DemoBadge /> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="tenant-sidebar__footer">
            <nav aria-label="Company settings">
              <Link
                href="/settings"
                aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
                className={`app-sidebar__link tenant-nav-link ui-focus-ring ${pathname.startsWith('/settings') ? 'app-sidebar__link--active' : ''}`}
              >
                <span className="tenant-nav-link__icon" aria-hidden="true"><Settings aria-hidden="true" size={16} /></span>
                <span className="app-sidebar__label tenant-nav-link__copy"><span>{t('nav.settings')}</span></span>
              </Link>
            </nav>
            <div className="tenant-user">
              <span className="tenant-user__avatar" aria-hidden="true">{session?.identity.display_name.slice(0, 1).toUpperCase() ?? '?'}</span>
              <span className="tenant-user__copy">
                <span>{session?.identity.display_name ?? 'Workspace user'}</span>
                <small>{session?.identity.email ?? 'Session-owned identity'}</small>
              </span>
              {session ? (
                <button
                  type="button"
                  className="tenant-user__logout ui-focus-ring"
                  onClick={() => void logout()}
                  disabled={loggingOut}
                  aria-label="Sign out"
                >
                  {loggingOut ? '…' : '↗'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <button type="button" className="mobile-menu-button tenant-sidebar__close ui-focus-ring" aria-label="Đóng menu" onClick={closeMenu}><CloseIcon /></button>
      </aside>

      <div className="app-main">
        <header className="app-topbar tenant-topbar" role="banner">
          <div className="app-topbar__leading">
            <button
              ref={menuButtonRef}
              type="button"
              className="mobile-menu-button ui-focus-ring"
              aria-label="Mở menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <MenuIcon />
            </button>
            <p className="app-topbar__title">{pageLabel(pathname)}</p>
          </div>
          <div className="tenant-search" role="search" aria-label="Search workspace">
            <span aria-hidden="true">⌕</span>
            <span>Search workspace</span>
            <kbd>⌘K</kbd>
          </div>
          <div className="app-topbar__actions">
            {session ? <DemoBadge /> : null}
            <span className="tenant-topbar__email">{session?.identity.email ?? 'Session not loaded'}</span>
            <span className="tenant-topbar__avatar" aria-hidden="true">{session?.identity.display_name.slice(0, 1).toUpperCase() ?? '?'}</span>
          </div>
        </header>
        <main id="main-content" className="app-content">{children}</main>
      </div>
    </div>
  );
}
