import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, get, post, setCsrfToken } from './api';

export interface Branding {
  panelName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  sidebarStyle: 'default' | 'compact';
  defaultTheme: 'light' | 'dark' | 'system';
  defaultCurrency: string;
  timezone: string;
  defaultLanguage: 'bn' | 'en';
  aiAssistantName: string;
}

export interface Bootstrap {
  branding: Branding;
  schema: { current: number; required: number; upToDate: boolean; pending: number };
  setupRequired: boolean;
  setupTokenRequired: boolean;
}

export interface Me {
  user: { id: number; orgId: number; email: string; name: string; role: string; roleLabel: string; aiLevel: number; allAccounts: boolean };
  permissions: string[];
  csrfToken: string;
  branding: Branding;
  features: { meta: boolean; metaLoginForBusiness: boolean; r2: boolean; openai: boolean; publishEnabled: boolean; activationEnabled: boolean };
}

interface SessionCtx {
  bootstrap: Bootstrap | undefined;
  me: Me | null;
  loading: boolean;
  branding: Branding | undefined;
  can: (perm: string) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => get<Bootstrap>('/public/bootstrap'), staleTime: 60_000 });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const m = await get<Me>('/auth/me');
        // Set synchronously: child pages may fire POST queries before any effect here runs.
        setCsrfToken(m.csrfToken);
        return m;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    enabled: Boolean(boot.data && !boot.data.setupRequired),
    staleTime: 60_000,
  });

  useEffect(() => {
    setCsrfToken(me.data?.csrfToken ?? null);
  }, [me.data?.csrfToken]);

  const branding = me.data?.branding ?? boot.data?.branding;

  // Brand colour, browser title and favicon follow Settings everywhere (spec: white-label).
  useEffect(() => {
    if (!branding) return;
    document.documentElement.style.setProperty('--brand', branding.primaryColor);
    const icon = document.getElementById('app-favicon') as HTMLLinkElement | null;
    if (icon) icon.href = branding.faviconUrl || '/favicon.svg';
  }, [branding]);

  const value: SessionCtx = {
    bootstrap: boot.data,
    me: me.data ?? null,
    loading: boot.isLoading || (Boolean(boot.data && !boot.data.setupRequired) && me.isLoading),
    branding,
    can: (perm) => Boolean(me.data?.permissions.includes(perm)),
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['bootstrap'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    signOut: async () => {
      await post('/auth/logout').catch(() => undefined);
      setCsrfToken(null);
      qc.clear();
      window.location.href = '/login';
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}

/** Sets document.title as "<Page> · <Panel name>". */
export function usePageTitle(page: string) {
  const { branding } = useSession();
  useEffect(() => {
    document.title = branding ? `${page} · ${branding.panelName}` : page;
  }, [page, branding]);
}
