'use client';

import { AppShell, DemoBadge, IconButton, MobileNavDrawer, Sidebar, Topbar, type SidebarItem } from '@agentos/ui-foundation/react';
import { Activity, Bot, Building2, CreditCard, Gauge, LayoutDashboard, ScrollText, Settings2, ShieldCheck } from 'lucide-react';
import { t } from '@agentos/ui-foundation/i18n';
import { usePathname } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { SessionExpiryDialog } from '../auth/SessionExpiryDialog';
import { useSession } from '../auth/SessionProvider';

type NavItem = {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  readonly demo?: boolean;
};

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: t('nav.overview'), description: 'Tổng quan nền tảng' },
  { href: '/companies', label: t('nav.companies'), description: 'Danh bạ tenant' },
  { href: '/operations', label: t('nav.operations'), description: 'Runs, inspection, retry' },
  { href: '/usage', label: t('nav.usage'), description: 'Mức sử dụng theo thời gian' },
  { href: '/providers', label: t('nav.providers'), description: 'Cấu hình nhà cung cấp' },
  { href: '/system-health', label: t('nav.system_health'), description: 'Readiness probes' },
  { href: '/subscriptions', label: t('nav.subscriptions'), description: 'Gói dịch vụ' },
  { href: '/settings', label: t('nav.settings'), description: 'Tài khoản và cấu hình' },
  { href: '/audit', label: t('nav.audit'), description: 'Nhật ký kiểm toán' },
];


function pageLabel(pathname: string): string {
  if (pathname === '/') return t('nav.overview');
  if (pathname.startsWith('/companies')) return t('nav.companies');
  if (pathname.startsWith('/operations')) return t('nav.operations');
  if (pathname.startsWith('/usage')) return t('nav.usage');
  if (pathname.startsWith('/providers')) return t('nav.providers');
  if (pathname.startsWith('/system-health')) return t('nav.system_health');
  if (pathname.startsWith('/subscriptions')) return t('nav.subscriptions');
  if (pathname.startsWith('/settings')) return t('nav.settings');
  if (pathname.startsWith('/audit')) return t('nav.audit');
  return t('app.name');
}


function cookieToken(name: string): string {
  if (typeof document === 'undefined') return '';
  const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!entry) return '';
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return '';
  }
}

export function PlatformShell({ children, subscriptionsEnabled }: { readonly children: ReactNode; readonly subscriptionsEnabled: boolean }) {
  const pathname = usePathname() || '/';
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const navItems = useMemo<readonly SidebarItem[]>(() => NAV_ITEMS
    .filter((item) => subscriptionsEnabled || item.href !== '/subscriptions')
    .map((item) => ({
      href: item.href,
      label: item.label,
      icon: item.href === '/' ? <LayoutDashboard size={16} /> : item.href === '/companies' ? <Building2 size={16} /> : item.href === '/operations' ? <Activity size={16} /> : item.href === '/usage' ? <Gauge size={16} /> : item.href === '/providers' ? <Bot size={16} /> : item.href === '/system-health' ? <ShieldCheck size={16} /> : item.href === '/subscriptions' ? <CreditCard size={16} /> : item.href === '/audit' ? <ScrollText size={16} /> : <Settings2 size={16} />,
      active: item.href === '/' ? pathname === '/' : pathname.startsWith(item.href),
      badge: item.demo ? <span className="text-[10px] uppercase tracking-wide text-muted">Demo</span> : undefined,
    })), [pathname, subscriptionsEnabled]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'x-csrf-token': cookieToken('agentos_platform_csrf') },
      });
      if (!response.ok) throw new Error(`sign-out failed (${response.status})`);
      window.location.assign('/sign-in');
    } catch {
      setLogoutError(t('auth.sign_out_failed'));
    } finally {
      setLoggingOut(false);
    }
  }

  const workspace = (
    <>
      <a href="/" className="ui-focus-ring flex items-center gap-3 rounded-md text-ink" aria-label={t('platform.overview')}>
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-surface" aria-hidden="true">A</span>
        <span><span className="block text-sm font-semibold tracking-tight text-ink">AgentOS</span><span className="block text-[11px] text-muted">{t('platform.brand_subtitle')}</span></span>
      </a>
      <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{t('platform.platform_operations')}</p>
    </>
  );
  const footer = (
    <div>
      <SessionExpiryDialog />
      <div className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-deep" aria-hidden="true">{session.identity.display_name.slice(0, 1).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-ink">{session.identity.display_name}</p><p className="truncate text-xs text-muted">{session.identity.email}</p></div><IconButton label={t('auth.sign_out')} variant="ghost" size="sm" onClick={() => void logout()} disabled={loggingOut}>{loggingOut ? '…' : '↗'}</IconButton></div>
      {logoutError ? <p role="alert" className="ui-state ui-state--error mt-2 text-xs">{logoutError}</p> : null}
    </div>
  );
  const sidebar = <Sidebar items={navItems} workspace={workspace} footer={footer} />;

  return (
    <>
      <AppShell
        skipLinkLabel={t('common.skip_to_content')}
        sidebar={sidebar}
        topbar={<Topbar title={pageLabel(pathname)} onOpenMenu={() => setMenuOpen(true)} actions={<><div className="platform-search" role="img" aria-label={t('platform.search_hint')}><span aria-hidden="true">⌕</span><span className="truncate">{t('platform.search_placeholder')}</span><kbd className="font-mono text-[10px] text-muted">⌘K</kbd></div><DemoBadge /><span className="hidden text-xs font-medium text-muted sm:inline">{session.identity.display_name}</span><span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-deep" aria-hidden="true">{session.identity.display_name.slice(0, 1).toUpperCase()}</span></>} />}
      >
        <div className="app-content">{children}</div>
      </AppShell>
      <MobileNavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} items={navItems} />
    </>
  );
}
