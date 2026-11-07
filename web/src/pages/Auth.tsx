import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Database, KeyRound, Moon, ShieldCheck, Sun, UserPlus } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BrandMark } from '../components/Layout';
import { Alert, Button, ErrorAlert, Field, Input, cx } from '../components/ui';
import { ApiError, post, setCsrfToken } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';
import { useTheme } from '../lib/theme';

function AuthShell({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  const { branding } = useSession();
  const { resolved, toggle } = useTheme();
  const { lang, setLang } = useI18n();
  return (
    <div className="relative grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-brand lg:block">
        <div className="absolute inset-0 opacity-25" style={{ background: 'radial-gradient(circle at 20% 20%, white 0, transparent 40%), radial-gradient(circle at 80% 70%, black 0, transparent 45%)' }} />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-white/15 p-1 backdrop-blur">
              <BrandMark size={40} />
            </div>
            <span className="text-lg font-semibold">{branding?.panelName ?? 'Ads Command Center'}</span>
          </div>
          <div className="max-w-md">
            <h2 className="text-3xl leading-tight font-semibold">All your Meta ad accounts. One calm place to run them.</h2>
            <ul className="mt-8 space-y-3 text-white/90">
              {['Create paused campaigns across many accounts at once', 'Real numbers from Meta, with sync time always shown', `Ask ${branding?.aiAssistantName ?? 'AI Ads Copilot'} in বাংলা or English`].map((s) => (
                <li key={s} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white/20">
                    <Check className="size-3.5" />
                  </span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div className="text-sm text-white/70">Nothing goes live without your approval.</div>
        </div>
      </div>
      <div className="flex flex-col">
        <div className="flex justify-end gap-1 p-4">
          <button onClick={() => setLang(lang === 'bn' ? 'en' : 'bn')} className="h-9 rounded-lg px-3 text-sm font-medium text-ink-2 hover:bg-surface-2">
            {lang === 'bn' ? 'English' : 'বাংলা'}
          </button>
          <button onClick={toggle} className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Toggle dark mode">
            {resolved === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <div className="animate-in w-full max-w-sm">
            <div className="mb-8 lg:hidden">
              <BrandMark size={44} />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-ink-2">{subtitle}</p>}
            <div className="mt-8">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { t } = useI18n();
  const { branding, refresh } = useSession();
  const nav = useNavigate();
  usePageTitle(t('signIn'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => post<{ csrfToken: string }>('/auth/login', { email, password }),
    onSuccess: async (r) => {
      setCsrfToken(r.csrfToken);
      await refresh();
      nav('/', { replace: true });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <AuthShell title={t('welcome')} subtitle={`${t('signIn')} — ${branding?.panelName ?? 'Ads Command Center'}`}>
      <form onSubmit={submit} className="space-y-5" noValidate>
        {m.error && <ErrorAlert error={m.error} />}
        <Field label={t('email')} htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label={t('password')} htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={m.isPending} icon={<ArrowRight className="size-4" />}>
          {t('signIn')}
        </Button>
      </form>
    </AuthShell>
  );
}

/** First-run wizard: 1) install the database (no SSH, bug 3), 2) create the Super Admin. */
export function SetupPage() {
  const { bootstrap, refresh } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  usePageTitle('Setup');
  const needsToken = bootstrap?.setupTokenRequired ?? true;
  const schemaReady = bootstrap?.schema.upToDate ?? false;
  const [token, setToken] = useState('');
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });

  const install = useMutation({
    mutationFn: () => post('/setup/migrate', { setupToken: token || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bootstrap'] }),
  });
  const create = useMutation({
    mutationFn: () => post<{ csrfToken: string }>('/setup/admin', { ...form, setupToken: token || undefined }),
    onSuccess: async (r) => {
      setCsrfToken(r.csrfToken);
      await refresh();
      nav('/', { replace: true });
    },
  });
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const step = schemaReady ? 2 : 1;

  return (
    <AuthShell title="Set up your command center" subtitle="Two steps, about a minute. You only do this once.">
      <ol className="mb-8 flex items-center gap-3 text-sm">
        {[
          { n: 1, label: 'Install database', icon: Database },
          { n: 2, label: 'Create admin', icon: UserPlus },
        ].map((s, i) => (
          <li key={s.n} className="flex items-center gap-3">
            {i > 0 && <span className="h-px w-6 bg-line-strong" />}
            <span className={cx('flex items-center gap-2 font-medium', step >= s.n ? 'text-ink' : 'text-ink-3')}>
              <span className={cx('grid size-7 place-items-center rounded-full text-xs', step > s.n ? 'bg-good text-white' : step === s.n ? 'bg-brand text-white' : 'bg-surface-3 text-ink-3')}>
                {step > s.n ? <Check className="size-4" /> : s.n}
              </span>
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {needsToken && (
        <div className="mb-5">
          <Field label="Setup token" htmlFor="token" hint="The SETUP_TOKEN value from your hosting environment. It stops strangers from claiming a fresh install.">
            <div className="relative">
              <KeyRound className="pointer-events-none absolute top-3 left-3 size-4 text-ink-3" />
              <Input id="token" type="password" className="pl-9" value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
          </Field>
        </div>
      )}

      {step === 1 ? (
        <div className="space-y-4">
          <Alert tone="info" title={`Database schema: version ${bootstrap?.schema.current ?? 0} of ${bootstrap?.schema.required ?? '?'}`}>
            This creates the tables in the empty database named in DB_NAME. It refuses to run if setup was already completed.
          </Alert>
          {install.error && <ErrorAlert error={install.error} />}
          <Button size="lg" className="w-full" loading={install.isPending} onClick={() => install.mutate()} icon={<Database className="size-4" />}>
            Install database
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          noValidate
        >
          {create.error && !Object.keys(fields).length && <ErrorAlert error={create.error} />}
          <Field label="Business name" htmlFor="org" error={fields.orgName} hint="Shown in reports. You can rename the panel later in Settings.">
            <Input id="org" value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} aria-invalid={Boolean(fields.orgName)} />
          </Field>
          <Field label="Your name" htmlFor="name" error={fields.name}>
            <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={Boolean(fields.name)} />
          </Field>
          <Field label="Email" htmlFor="semail" error={fields.email}>
            <Input id="semail" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-invalid={Boolean(fields.email)} />
          </Field>
          <Field label="Password" htmlFor="spw" error={fields.password} hint="At least 12 characters. A short sentence works well.">
            <Input id="spw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-invalid={Boolean(fields.password)} />
          </Field>
          <Button type="submit" size="lg" className="w-full" loading={create.isPending} icon={<ShieldCheck className="size-4" />}>
            Create Super Admin and sign in
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
