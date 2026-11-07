import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bell, ChevronDown, Languages, LogOut, Menu, Monitor, Moon, ShieldCheck, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { get } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { NAV } from '../lib/nav';
import { useSession } from '../lib/session';
import { useTheme, type ThemeChoice } from '../lib/theme';
import { cx } from './ui';

export function BrandMark({ size = 36 }: { size?: number }) {
  const { branding } = useSession();
  if (branding?.logoUrl) return <img src={branding.logoUrl} alt="" className="rounded-xl object-contain" style={{ width: size, height: size }} />;
  return (
    <div className="grid place-items-center rounded-xl bg-brand text-white shadow-card" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 17l5-10 4 7 2-3 5 7" />
      </svg>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const { branding } = useSession();
  return (
    <div className="flex h-full flex-col">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-3 px-5 pt-5 pb-4">
        <BrandMark />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-ink">{branding?.panelName ?? 'Ads Command Center'}</div>
          <div className="text-xs text-ink-3">Meta Ads OS</div>
        </div>
      </Link>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6" aria-label="Main">
        {NAV.map((g) => (
          <div key={g.label}>
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{t(g.label)}</div>
            <ul className="space-y-0.5">
              {g.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        isActive ? 'brand-soft text-brand' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                      )
                    }
                  >
                    <item.icon className="size-[18px] shrink-0" aria-hidden />
                    <span className="truncate">{t(item.label)}</span>
                    {item.phase && item.phase > 2 && <span className="ml-auto rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-ink-3">P{item.phase}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

function ThemeMenu() {
  const { choice, setChoice, resolved } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const opts: { v: ThemeChoice; label: string; Icon: typeof Sun }[] = [
    { v: 'light', label: t('lightMode'), Icon: Sun },
    { v: 'dark', label: t('darkMode'), Icon: Moon },
    { v: 'system', label: t('systemMode'), Icon: Monitor },
  ];
  const Current = resolved === 'dark' ? Moon : Sun;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label="Change theme" aria-expanded={open}>
        <Current className="size-[18px]" />
      </button>
      {open && (
        <div className="animate-in absolute right-0 z-50 mt-2 w-40 rounded-xl border border-line bg-surface p-1 shadow-pop" role="menu">
          {opts.map(({ v, label, Icon }) => (
            <button
              key={v}
              role="menuitemradio"
              aria-checked={choice === v}
              onClick={() => {
                setChoice(v);
                setOpen(false);
              }}
              className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm', choice === v ? 'brand-soft text-brand' : 'text-ink-2 hover:bg-surface-2')}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me, signOut } = useSession();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (!me) return null;
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 hover:bg-surface-2" aria-expanded={open}>
        <span className="grid size-8 place-items-center rounded-full bg-brand text-xs font-semibold text-white">{initials}</span>
        <span className="hidden text-left sm:block">
          <span className="block text-sm leading-tight font-medium text-ink">{me.user.name}</span>
          <span className="block text-xs leading-tight text-ink-3">{me.user.roleLabel}</span>
        </span>
        <ChevronDown className="size-4 text-ink-3" />
      </button>
      {open && (
        <div className="animate-in absolute right-0 z-50 mt-2 w-56 rounded-xl border border-line bg-surface p-1 shadow-pop" role="menu">
          <div className="px-3 py-2 text-xs text-ink-3">{me.user.email}</div>
          <Link to="/security" onClick={() => setOpen(false)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-2 hover:bg-surface-2" role="menuitem">
            <ShieldCheck className="size-4" /> Security
            {me.mfa?.enabled === false && <span className="ml-auto rounded-full bg-warn-bg px-1.5 text-[10px] font-medium text-warn">Off</span>}
          </Link>
          <button onClick={signOut} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-2 hover:bg-surface-2" role="menuitem">
            <LogOut className="size-4" /> {t('signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

/** A banner on every page when background jobs are not running (bug 5: never silent). */
function SchedulerBanner() {
  const { can } = useSession();
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get('/dashboard/summary'), refetchInterval: 60_000 });
  const s = q.data?.scheduler;
  if (!s || (s.state === 'running' && s.schema?.upToDate !== false)) return null;
  if (s.schema && !s.schema.upToDate)
    return (
      <div className="border-b border-warn/30 bg-warn-bg px-4 py-2.5 text-sm sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1">
          <AlertTriangle className="size-4 text-warn" aria-hidden />
          <span className="font-medium text-ink">Background jobs are waiting for the database upgrade</span>
          <span className="text-ink-2">
            The database is at version {s.schema.current}; this release needs {s.schema.required}. Apply it in Settings → Database, or import upgrade-from-schema-{s.schema.current}-to-{s.schema.required}.sql in phpMyAdmin.
          </span>
          {can('schema.migrate') && (
            <Link to="/settings" className="ml-auto font-medium text-brand hover:underline">Open Settings →</Link>
          )}
        </div>
      </div>
    );
  return (
    <div className="border-b border-warn/30 bg-warn-bg px-4 py-2.5 text-sm sm:px-8">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1">
        <AlertTriangle className="size-4 text-warn" aria-hidden />
        <span className="font-medium text-ink">{t('schedulerDown')}</span>
        <span className="text-ink-2">{s.state === 'never_started' ? 'The scheduler has never run. Sync, publishing and reports will not happen until the cron job is set up.' : `Last successful run was ${s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : 'unknown'}.`}</span>
        {can('health.read') && (
          <Link to="/health" className="ml-auto font-medium text-brand hover:underline">
            {t('viewDetails')} →
          </Link>
        )}
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { lang, setLang } = useI18n();
  const loc = useLocation();
  const unread = useQuery({ queryKey: ['dashboard'], queryFn: () => get('/dashboard/summary') }).data?.notificationsUnread ?? 0;

  useEffect(() => setMobileOpen(false), [loc.pathname]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="animate-in absolute inset-y-0 left-0 w-72 border-r border-line bg-surface shadow-pop">
            <button onClick={() => setMobileOpen(false)} className="absolute top-4 right-3 grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Close menu">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-surface/85 px-4 backdrop-blur sm:px-8">
          <button onClick={() => setMobileOpen(true)} className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 lg:hidden" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <div className="flex-1" />
          <button onClick={() => setLang(lang === 'bn' ? 'en' : 'bn')} className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label={lang === 'bn' ? 'Switch to English' : 'বাংলায় দেখুন'}>
            <Languages className="size-[18px]" />
            {lang === 'bn' ? 'English' : 'বাংলা'}
          </button>
          <ThemeMenu />
          <Link to="/notifications" className="relative grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <Bell className="size-[18px]" />
            {unread > 0 && <span className="absolute top-1.5 right-1.5 grid min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span>}
          </Link>
          <div className="mx-1 h-6 w-px bg-line" />
          <UserMenu />
        </header>
        <SchedulerBanner />
        <main className="flex-1 overflow-y-auto">
          <div className="animate-in mx-auto max-w-7xl px-4 py-8 sm:px-8" key={loc.pathname}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
