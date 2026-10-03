'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, BookOpen, Bot, FlaskConical, LayoutDashboard, Megaphone, MessagesSquare, Plug, Settings, ShieldCheck, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { can, canAny, type AuthSession, type Permission } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { DataClassBadge, useFocusTrap } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { SessionExpiryDialog } from '../auth/SessionExpiryDialog';
import { useSession } from '../auth/SessionProvider';

type BadgeKind = 'conversations' | 'approvals';

type NavItem = {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly permission?: Permission;
  readonly permissions?: readonly Permission[];
  readonly badge?: BadgeKind;
};

type NavGroup = {
  readonly labelKey?: string;
  readonly items: readonly NavItem[];
};

const OVERVIEW_GROUP: NavGroup = {
  items: [
    { href: '/', label: t('nav.overview'), icon: LayoutDashboard, permission: 'telemetry:read' },
  ],
};

const TODO_GROUP: NavGroup = {
  labelKey: 'nav.group.todo',
  items: [
    { href: '/conversations', label: t('nav.conversations'), icon: MessagesSquare, permission: 'conversation:takeover', badge: 'conversations' },
    { href: '/approvals', label: t('nav.approvals'), icon: ShieldCheck, permission: 'approval:read', badge: 'approvals' },
  ],
};

const BUSINESS_GROUP: NavGroup = {
  labelKey: 'nav.group.business',
  items: [
    { href: '/customers', label: t('nav.customers'), icon: Users, permission: 'customer:read' },
    { href: '/campaigns', label: t('nav.campaigns'), icon: Megaphone, permissions: ['campaign:draft', 'approval:read'] },
  ],
};

const AI_GROUP: NavGroup = {
  labelKey: 'nav.group.ai',
  items: [
    { href: '/ai-team', label: t('nav.ai_team'), icon: Bot, permission: 'telemetry:read' },
    { href: '/knowledge', label: t('nav.knowledge'), icon: BookOpen, permission: 'telemetry:read' },
    { href: '/integrations', label: t('nav.integrations'), icon: Plug, permission: 'telemetry:read' },
    { href: '/analytics', label: t('nav.analytics'), icon: BarChart3, permission: 'telemetry:read' },
  ],
};

const NAV_GROUPS: readonly NavGroup[] = [OVERVIEW_GROUP, TODO_GROUP, BUSINESS_GROUP, AI_GROUP];

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
  if (pathname.startsWith('/testing')) return t('nav.test_lab');
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
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [badges, setBadges] = useState<Record<BadgeKind, number>>({ conversations: 0, approvals: 0 });
  const [dataClass, setDataClass] = useState<string | null>(null);
  const [testDataEnabled, setTestDataEnabled] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  function closeMenu() {
    setMenuOpen(false);
  }

  useFocusTrap(sidebarRef, menuOpen, closeMenu);

  useEffect(() => {
    setMenuOpen(false);
    setUserMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const attention = await tenantConsoleClient.getCompanyAttention();
        if (cancelled) return;
        const items = attention.items ?? [];
        setBadges({
          conversations: items.filter((item) => item.type === 'HUMAN_HANDOFF').length,
          approvals: items.filter((item) => item.type === 'APPROVAL_PENDING').length,
        });
      } catch {
        // A badge is additive chrome; keep the last known counts on failure.
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session]);

  useEffect(() => {
    if (!session || !can(session, 'testdata:manage')) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await tenantConsoleClient.getTestingStatus();
        if (cancelled) return;
        setDataClass(status.data_class);
        setTestDataEnabled(status.enabled);
      } catch {
        // Without the status probe the Test lab entry stays hidden and no chip is shown.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const tenantName = session?.membership.tenant_name?.trim() || 'Công ty';
  // Environment chip vocabulary: Production is hidden, the demo/test classes are named.
  const envCode = dataClass === 'DEMO' || dataClass === 'TEST' ? dataClass : null;

  const visibleGroups = useMemo(
    () =>
      NAV_GROUPS
        .map((group) => ({ ...group, items: group.items.filter((item) => hasPermission(session, item)) }))
        .filter((group) => group.items.length > 0),
    [session],
  );

  const showTestLab = session !== null && can(session, 'testdata:manage') && testDataEnabled;

  async function logout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await tenantConsoleClient.signOut();
      window.location.assign('/sign-in');
    } catch {
      setLogoutError(t('auth.sign_out_failed'));
    } finally {
      setLoggingOut(false);
    }
  }

  function renderItem(item: NavItem): ReactNode {
    const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
    const Icon = item.icon;
    const count = item.badge ? badges[item.badge] : 0;
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className={`app-sidebar__link tenant-nav-link ui-focus-ring ${active ? 'app-sidebar__link--active' : ''}`}
        >
          <span className="tenant-nav-link__icon" aria-hidden="true"><Icon aria-hidden="true" size={16} /></span>
          <span className="app-sidebar__label tenant-nav-link__copy"><span>{item.label}</span></span>
          {count > 0 ? (
            <span
              className="tenant-nav-link__badge"
              aria-label={t('shell.nav_badge', { count, label: item.label })}
            >
              {count}
            </span>
          ) : null}
        </Link>
      </li>
    );
  }

  return (
    <div className="app-shell tenant-shell" data-app="tenant" data-responsive-shell="true">
      <a className="app-shell__skip-link ui-focus-ring" href="#main-content">{t('common.skip_to_content')}</a>
      <div
        className={`tenant-shell__scrim fixed inset-0 z-20 lg:hidden ${menuOpen ? 'block' : 'hidden'}`}
        aria-hidden="true"
        onClick={closeMenu}
      />
      <aside
        ref={sidebarRef}
        className="app-sidebar tenant-sidebar"
        data-open={menuOpen}
        aria-label={t('shell.navigation')}
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen ? true : undefined}
      >
        <div className="tenant-sidebar__inner">
          <Link href="/" className="tenant-brand ui-focus-ring" aria-label={t('shell.brand_label')}>
            <span className="tenant-brand__mark" aria-hidden="true">A</span>
            <span className="min-w-0">
              <span className="tenant-brand__name">AgentOS</span>
              <span className="tenant-brand__context">{t('shell.company_workspace')}</span>
            </span>
          </Link>

          <div className="tenant-workspace">
            <p className="tenant-sidebar__eyebrow">{t('shell.workspace')}</p>
            <p className="tenant-workspace__name">{tenantName}</p>
            {envCode ? <DataClassBadge code={envCode} /> : null}
          </div>

          <nav className="tenant-sidebar__nav" aria-label={t('shell.navigation')}>
            {visibleGroups.map((group, index) => (
              <section key={group.labelKey ?? `group-${index}`} className="tenant-sidebar__group">
                {group.labelKey ? <h2 className="tenant-sidebar__group-title">{t(group.labelKey)}</h2> : null}
                <ul>{group.items.map((item) => renderItem(item))}</ul>
              </section>
            ))}
          </nav>

          <div className="tenant-sidebar__footer">
            <nav aria-label={t('shell.footer_navigation')}>
              <ul>
                {showTestLab ? (
                  <li>
                    <Link
                      href="/testing/customers"
                      aria-current={pathname.startsWith('/testing') ? 'page' : undefined}
                      className={`app-sidebar__link tenant-nav-link ui-focus-ring ${pathname.startsWith('/testing') ? 'app-sidebar__link--active' : ''}`}
                    >
                      <span className="tenant-nav-link__icon" aria-hidden="true"><FlaskConical aria-hidden="true" size={16} /></span>
                      <span className="app-sidebar__label tenant-nav-link__copy"><span>{t('nav.test_lab')}</span></span>
                    </Link>
                  </li>
                ) : null}
                <li>
                  <Link
                    href="/settings"
                    aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
                    className={`app-sidebar__link tenant-nav-link ui-focus-ring ${pathname.startsWith('/settings') ? 'app-sidebar__link--active' : ''}`}
                  >
                    <span className="tenant-nav-link__icon" aria-hidden="true"><Settings aria-hidden="true" size={16} /></span>
                    <span className="app-sidebar__label tenant-nav-link__copy"><span>{t('nav.settings')}</span></span>
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
        </div>
        <button type="button" className="mobile-menu-button tenant-sidebar__close ui-focus-ring" aria-label={t('shell.close_menu')} onClick={closeMenu}><CloseIcon /></button>
      </aside>

      <div className="app-main">
        <header className="app-topbar tenant-topbar" role="banner">
          <div className="app-topbar__leading">
            <button
              ref={menuButtonRef}
              type="button"
              className="mobile-menu-button ui-focus-ring"
              aria-label={t('shell.open_menu')}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <MenuIcon />
            </button>
            <nav className="tenant-breadcrumb" aria-label={t('shell.breadcrumb')}>
              <ol>
                <li>{tenantName}</li>
                <li aria-current="page">{pageLabel(pathname)}</li>
              </ol>
            </nav>
          </div>
          <div className="app-topbar__actions">
            <SessionExpiryDialog />
            {session ? (
              <div className="tenant-user-menu">
                <button
                  type="button"
                  className="tenant-user-menu__trigger ui-focus-ring"
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  aria-label={t('shell.user_menu')}
                  onClick={() => setUserMenuOpen((open) => !open)}
                >
                  <span className="tenant-user-menu__avatar" aria-hidden="true">{session.identity.display_name.slice(0, 1).toUpperCase()}</span>
                  <span className="tenant-user-menu__name">{session.identity.display_name}</span>
                </button>
                {userMenuOpen ? (
                  <div className="tenant-user-menu__panel" role="menu">
                    <span className="tenant-user-menu__identity">
                      <span>{session.identity.display_name}</span>
                      <small>{session.identity.email}</small>
                    </span>
                    <button
                      type="button"
                      role="menuitem"
                      className="tenant-user-menu__logout ui-focus-ring"
                      onClick={() => void logout()}
                      disabled={loggingOut}
                    >
                      {loggingOut ? t('common.loading') : t('auth.sign_out')}
                    </button>
                    {logoutError ? (
                      <p role="alert" className="tenant-user-menu__error ui-state ui-state--error">{logoutError}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
        <main id="main-content" className="app-content">{children}</main>
      </div>
    </div>
  );
}
