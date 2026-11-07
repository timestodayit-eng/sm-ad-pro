import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Database, History, Monitor, Moon, Palette, Sun, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '../components/Layout';
import { Alert, Badge, Button, Card, CardHeader, ErrorAlert, Field, Input, PageHeader, Segmented, Select, Skeleton, cx, formatDateTime } from '../components/ui';
import { ApiError, get, patch, post, put } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession, type Branding } from '../lib/session';
import { useTheme } from '../lib/theme';

const SWATCHES = ['#4f46e5', '#2563eb', '#0f766e', '#16a34a', '#ea580c', '#db2777', '#7c3aed', '#0f172a'];

function AppearanceCard() {
  const { choice, setChoice } = useTheme();
  const { lang, setLang } = useI18n();
  return (
    <Card>
      <CardHeader title="Your appearance" description="Only affects you, on this device." icon={<Monitor className="size-4" />} />
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        <Field label="Theme">
          <Segmented
            label="Theme"
            value={choice}
            onChange={setChoice}
            options={[
              { value: 'light', label: 'Light', icon: <Sun className="size-3.5" /> },
              { value: 'dark', label: 'Dark', icon: <Moon className="size-3.5" /> },
              { value: 'system', label: 'System', icon: <Monitor className="size-3.5" /> },
            ]}
          />
        </Field>
        <Field label="Language">
          <Segmented label="Language" value={lang} onChange={setLang} options={[{ value: 'bn', label: 'বাংলা' }, { value: 'en', label: 'English' }]} />
        </Field>
      </div>
    </Card>
  );
}

function BrandingCard() {
  const { branding, can, refresh } = useSession();
  const qc = useQueryClient();
  const [form, setForm] = useState<Branding | null>(null);
  useEffect(() => {
    if (branding && !form) setForm(branding);
  }, [branding, form]);
  const save = useMutation({
    mutationFn: (b: Branding) => put<Branding>('/settings/branding', b),
    onSuccess: async () => {
      await refresh();
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
  const fields = save.error instanceof ApiError ? save.error.fields : {};
  const editable = can('settings.manage');
  if (!form) return <Skeleton className="h-96 rounded-2xl" />;
  const set = <K extends keyof Branding>(k: K, v: Branding[K]) => setForm({ ...form, [k]: v });

  return (
    <Card>
      <CardHeader title="Panel branding" description="White-label name, colours and defaults. Shown on the login page, sidebar, browser tab and reports." icon={<Palette className="size-4" />} />
      <form
        className="grid gap-6 p-5 lg:grid-cols-[1fr_280px]"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <fieldset disabled={!editable} className="grid gap-5 sm:grid-cols-2">
          <Field label="Panel name" htmlFor="pn" error={fields.panelName}>
            <Input id="pn" value={form.panelName} onChange={(e) => set('panelName', e.target.value)} aria-invalid={Boolean(fields.panelName)} />
          </Field>
          <Field label="AI assistant name" htmlFor="ai" error={fields.aiAssistantName}>
            <div className="relative">
              <Bot className="pointer-events-none absolute top-3 left-3 size-4 text-ink-3" />
              <Input id="ai" className="pl-9" value={form.aiAssistantName} onChange={(e) => set('aiAssistantName', e.target.value)} />
            </div>
          </Field>
          <Field label="Logo URL" htmlFor="logo" error={fields.logoUrl} hint="Square image, https. Upload via the Media Library once it ships.">
            <Input id="logo" value={form.logoUrl ?? ''} placeholder="https://…" onChange={(e) => set('logoUrl', e.target.value || null)} />
          </Field>
          <Field label="Favicon URL" htmlFor="fav" error={fields.faviconUrl}>
            <Input id="fav" value={form.faviconUrl ?? ''} placeholder="https://…" onChange={(e) => set('faviconUrl', e.target.value || null)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Brand colour" error={fields.primaryColor}>
              <div className="flex flex-wrap items-center gap-2">
                {SWATCHES.map((c) => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => set('primaryColor', c)}
                    className={cx('size-8 rounded-full border-2 transition', form.primaryColor.toLowerCase() === c ? 'scale-110 border-ink' : 'border-transparent')}
                    style={{ background: c }}
                    aria-label={`Use colour ${c}`}
                  />
                ))}
                <input type="color" value={form.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} className="size-8 cursor-pointer rounded-full border border-line bg-transparent" aria-label="Custom colour" />
                <span className="font-mono text-xs text-ink-3">{form.primaryColor}</span>
              </div>
            </Field>
          </div>
          <Field label="Default theme for new users">
            <Select value={form.defaultTheme} onChange={(e) => set('defaultTheme', e.target.value as Branding['defaultTheme'])}>
              <option value="system">Follow device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Field>
          <Field label="Default language">
            <Select value={form.defaultLanguage} onChange={(e) => set('defaultLanguage', e.target.value as Branding['defaultLanguage'])}>
              <option value="bn">বাংলা</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label="Reporting currency" error={fields.defaultCurrency} hint="Used only when a disclosed conversion is applied.">
            <Select value={form.defaultCurrency} onChange={(e) => set('defaultCurrency', e.target.value)}>
              {['USD', 'BDT', 'EUR', 'GBP', 'SAR', 'AED', 'MYR'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Time zone" error={fields.timezone} hint="Defines “today” and “yesterday” in reports.">
            <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {['Asia/Dhaka', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Europe/London', 'UTC'].map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Field>
          <Field label="Sidebar style">
            <Select value={form.sidebarStyle} onChange={(e) => set('sidebarStyle', e.target.value as Branding['sidebarStyle'])}>
              <option value="default">Comfortable</option>
              <option value="compact">Compact</option>
            </Select>
          </Field>
        </fieldset>

        <div>
          <div className="mb-2 text-sm font-medium text-ink">Preview</div>
          <div className="overflow-hidden rounded-xl border border-line" style={{ ['--brand' as string]: form.primaryColor }}>
            <div className="flex items-center gap-2.5 border-b border-line bg-surface px-4 py-3">
              {form.logoUrl ? <img src={form.logoUrl} alt="" className="size-7 rounded-lg object-contain" /> : <BrandMark size={28} />}
              <span className="truncate text-sm font-semibold text-ink">{form.panelName || 'Panel name'}</span>
            </div>
            <div className="space-y-1.5 bg-surface p-3">
              <div className="rounded-lg px-3 py-2 text-sm font-medium" style={{ background: `color-mix(in srgb, ${form.primaryColor} 12%, transparent)`, color: form.primaryColor }}>
                Dashboard
              </div>
              <div className="px-3 py-2 text-sm text-ink-2">Easy Ads</div>
              <div className="px-3 py-2 text-sm text-ink-2">{form.aiAssistantName || 'AI assistant'}</div>
              <div className="pt-2">
                <span className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium text-white" style={{ background: form.primaryColor }}>
                  Primary button
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
          {editable ? (
            <Button type="submit" loading={save.isPending}>
              Save branding
            </Button>
          ) : (
            <Badge tone="neutral">Only Admins can change branding</Badge>
          )}
          {save.isSuccess && <span className="text-sm text-good">Saved. Everyone sees the new branding on their next page load.</span>}
          {save.error && !Object.keys(fields).length && <ErrorAlert error={save.error} />}
        </div>
      </form>
    </Card>
  );
}

function UsersCard() {
  const qc = useQueryClient();
  const { me } = useSession();
  const q = useQuery({ queryKey: ['users'], queryFn: () => get('/users') });
  const [form, setForm] = useState({ name: '', email: '', role: 'media_buyer', password: '' });
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: () => post('/users', form),
    onSuccess: () => {
      setForm({ name: '', email: '', role: 'media_buyer', password: '' });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const toggleActive = useMutation({ mutationFn: (u: any) => patch(`/users/${u.id}`, { isActive: !u.is_active }), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  return (
    <Card>
      <CardHeader
        title="Team members"
        description="Roles decide what each person can do. AI permission levels arrive with the Copilot."
        icon={<Users className="size-4" />}
        actions={
          <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={() => setOpen((o) => !o)}>
            Add member
          </Button>
        }
      />
      {open && (
        <form
          className="grid gap-4 border-b border-line bg-surface-2 p-5 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name" error={fields.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email" error={fields.email}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {(q.data?.roles ?? []).map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Temporary password" error={fields.password}>
            <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" className="w-full" loading={create.isPending}>
              Create
            </Button>
          </div>
          {create.error && !Object.keys(fields).length && (
            <div className="sm:col-span-2 lg:col-span-5">
              <ErrorAlert error={create.error} />
            </div>
          )}
        </form>
      )}
      {q.isLoading ? (
        <div className="p-5">
          <Skeleton className="h-12" />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {(q.data?.users ?? []).map((u: any) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-ink">
                  {u.name} {u.id === me?.user.id && <span className="text-ink-3">(you)</span>}
                </div>
                <div className="text-ink-3">{u.email}</div>
              </div>
              <Badge tone={u.role === 'super_admin' ? 'brand' : 'neutral'}>{u.roleLabel}</Badge>
              {!u.is_active && <Badge tone="bad">Deactivated</Badge>}
              <span className="hidden text-xs text-ink-3 md:block">Last sign-in {u.last_login_at ? formatDateTime(u.last_login_at) : 'never'}</span>
              {u.id !== me?.user.id && (
                <Button size="sm" variant="ghost" onClick={() => toggleActive.mutate(u)}>
                  {u.is_active ? 'Deactivate' : 'Reactivate'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DatabaseCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['schema'], queryFn: () => get('/admin/schema') });
  const run = useMutation({ mutationFn: () => post('/admin/schema/migrate'), onSuccess: () => ['schema', 'health', 'bootstrap'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })) });
  const s = q.data;
  return (
    <Card>
      <CardHeader title="Database migrations" description="Upgrades run in order and are recorded. Never run the fresh-install SQL over a live database." icon={<Database className="size-4" />} />
      <div className="space-y-4 p-5">
        {q.error && <ErrorAlert error={q.error} />}
        {s && (
          <>
            <Alert tone={s.upToDate ? 'good' : 'warn'} title={s.upToDate ? `Schema v${s.current} matches this build` : `Schema v${s.current}, this build needs v${s.required}`}>
              {!s.upToDate && `${s.pending.length} pending migration(s). Publishing stays blocked until they are applied.`}
            </Alert>
            {!s.upToDate && (
              <Button onClick={() => run.mutate()} loading={run.isPending}>
                Apply pending migrations
              </Button>
            )}
            {run.error && <ErrorAlert error={run.error} />}
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs text-ink-3">
                  <tr>
                    <th className="px-3 py-2 font-medium">Migration</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Applied</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s.history.map((h: any) => (
                    <tr key={h.version}>
                      <td className="px-3 py-2 font-mono text-xs text-ink">{h.name}</td>
                      <td className="px-3 py-2">
                        <Badge tone={h.status === 'applied' ? 'good' : 'bad'}>{h.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-ink-3">
                        {formatDateTime(h.applied_at)} {h.applied_by && `by ${h.applied_by}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function AuditCard() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => get('/audit') });
  return (
    <Card>
      <CardHeader title="Audit log" description="Every sign-in, setting change, recovery and approval. Append-only." icon={<History className="size-4" />} />
      <ul className="max-h-96 divide-y divide-line overflow-y-auto">
        {(q.data?.items ?? []).map((a: any) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
            <span className="font-mono text-xs text-ink">{a.action}</span>
            <span className="text-ink-2">{a.actor_name ?? a.actor_kind}</span>
            {a.target_type && (
              <span className="text-ink-3">
                {a.target_type} {a.target_id}
              </span>
            )}
            <span className="ml-auto text-xs text-ink-3">{formatDateTime(a.created_at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  usePageTitle(t('settings'));
  return (
    <>
      <PageHeader title={t('settings')} description="Branding, team, database and audit history." />
      <div className="space-y-6">
        <AppearanceCard />
        <BrandingCard />
        {can('users.manage') && <UsersCard />}
        {can('schema.migrate') && <DatabaseCard />}
        {can('audit.read') && <AuditCard />}
      </div>
    </>
  );
}
