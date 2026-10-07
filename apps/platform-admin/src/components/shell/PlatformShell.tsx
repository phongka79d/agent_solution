'use client';

import { AppShell, DemoBadge, IconButton, MobileNavDrawer, Sidebar, Topbar, type SidebarItem } from '@agentos/ui-foundation/react';
import { Activity, Bot, Building2, CreditCard, Gauge, LayoutDashboard, Settings2, ShieldCheck } from 'lucide-react';
import { t } from '@agentos/ui-foundation/i18n';
import { usePathname } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
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

export function PlatformShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() || '/';
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const navItems = useMemo<readonly SidebarItem[]>(() => NAV_ITEMS.map((item) => ({
    href: item.href,
    label: item.label,
    icon: item.href === '/' ? <LayoutDashboard size={16} /> : item.href === '/companies' ? <Building2 size={16} /> : item.href === '/operations' ? <Activity size={16} /> : item.href === '/usage' ? <Gauge size={16} /> : item.href === '/providers' ? <Bot size={16} /> : item.href === '/system-health' ? <ShieldCheck size={16} /> : item.href === '/subscriptions' ? <CreditCard size={16} /> : <Settings2 size={16} />,
    active: item.href === '/' ? pathname === '/' : pathname.startsWith(item.href),
    badge: item.demo ? <span className="text-[10px] uppercase tracking-wide text-muted">Demo</span> : undefined,
  })), [pathname]);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'x-csrf-token': cookieToken('agentos_platform_csrf') },
      });
    } finally {
      window.location.assign('/sign-in');
    }
  }

  const workspace = (
    <>
      <a href="/" className="ui-focus-ring flex items-center gap-3 rounded-md text-ink" aria-label={t('platform.overview')}>
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-surface" aria-hidden="true">A</span>
        <span><span className="block text-sm font-semibold tracking-tight text-ink">AgentOS</span><span className="block text-[11px] text-muted">{t('platform.brand_subtitle')}</span></span>
      </a>
      <div className="platform-card mt-5 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{t('platform.authority_scope')}</p>
        <p className="mt-1 text-sm font-semibold text-ink">{t('platform.current_tenant')}</p>
        <p className="mt-1 truncate font-mono text-xs text-muted" title={session?.membership.tenant_id}>{session?.membership.tenant_id ?? t('platform.sign_in_to_identify')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2"><DemoBadge /></div>
      </div>
      <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{t('platform.platform_operations')}</p>
    </>
  );
  const footer = (
    <div className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-deep" aria-hidden="true">{session.identity.display_name.slice(0, 1).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-ink">{session.identity.display_name}</p><p className="truncate text-xs text-muted">{session.identity.email}</p></div><IconButton label={t('auth.sign_out')} variant="ghost" size="sm" onClick={() => void logout()} disabled={loggingOut}>{loggingOut ? '…' : '↗'}</IconButton></div>
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
