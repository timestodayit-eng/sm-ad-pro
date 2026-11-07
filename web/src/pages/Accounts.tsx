import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckSquare, ExternalLink, FolderPlus, Link2, RefreshCw, Search, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, Dot, EmptyState, ErrorAlert, Input, PageHeader, Segmented, Select, Skeleton, cx, timeAgo } from '../components/ui';
import { get, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';

interface Account {
  id: number;
  account_id: string;
  name: string;
  currency: string;
  timezone_name: string | null;
  account_status: number | null;
  business_name: string | null;
  last_synced_at: string | null;
  connection_status: string;
  meta_user_name: string | null;
  page_id: string | null;
  brand_name: string | null;
  readiness: { level: 'ready' | 'warning' | 'blocked'; issues: string[] };
}

const STATUS: Record<number, string> = { 1: 'Active', 2: 'Disabled', 3: 'Unsettled', 7: 'Pending review', 8: 'Pending closure', 9: 'In grace period', 100: 'Pending closure', 101: 'Closed', 201: 'Any active', 202: 'Any closed' };

export function AccountsPage() {
  const { t } = useI18n();
  const { me, can } = useSession();
  usePageTitle(t('adAccounts'));
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [currency, setCurrency] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState('');
  const pageSize = 50;

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => setPage(1), [debounced, status, currency]);

  const conns = useQuery({ queryKey: ['meta-connections'], queryFn: () => get('/meta/connections') });
  const list = useQuery({
    queryKey: ['accounts', debounced, status, currency, page],
    queryFn: () => post<{ items: Account[]; total: number }>('/accounts/search', { q: debounced || undefined, status, currency: currency || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
  });

  const connect = useMutation({
    mutationFn: () => get<{ url: string }>('/meta/connect-url'),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
  });
  const sync = useMutation({
    mutationFn: (id: number) => post(`/meta/connections/${id}/sync`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meta-connections'] }),
  });
  const makeGroup = useMutation({
    mutationFn: () => post('/account-groups', { name: groupName, accountIds: [...selected] }),
    onSuccess: () => {
      setSelected(new Set());
      setGroupName('');
      qc.invalidateQueries({ queryKey: ['account-groups'] });
    },
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const allOnPage = items.length > 0 && items.every((a) => selected.has(a.id));
  const currencies = useMemo(() => [...new Set(items.map((a) => a.currency))].sort(), [items]);
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const connected = params.get('connected');
  const oauthError = params.get('error');

  return (
    <>
      <PageHeader
        title={t('adAccounts')}
        description="Every Meta ad account your connected logins can reach. No limit on how many."
        actions={
          can('meta.connect') && (
            <Button
              onClick={() => connect.mutate()}
              loading={connect.isPending}
              disabled={me ? !me.features.meta : false}
              title={me && !me.features.meta ? 'Add the Meta app settings to the server first (see the notice below).' : undefined}
              icon={<Link2 className="size-4" />}
            >
              {conns.data?.items?.length ? 'Connect another Meta login' : 'Connect Meta'}
            </Button>
          )
        }
      />

      <div className="space-y-4">
        {connected && (
          <Alert tone="good" title={`Connected as ${connected}`} action={<button onClick={() => setParams({})} aria-label="Dismiss"><X className="size-4 text-ink-3" /></button>}>
            Your ad accounts are being imported in the background and will appear here within a minute.
            {params.get('missing') && <div className="mt-1 text-warn">Missing permissions: {params.get('missing')}. Some features may not work until you reconnect and approve them.</div>}
          </Alert>
        )}
        {oauthError && (
          <Alert tone="bad" title="Meta connection failed" action={<button onClick={() => setParams({})} aria-label="Dismiss"><X className="size-4 text-ink-3" /></button>}>
            {params.get('message')} <span className="font-mono text-xs text-ink-3">({oauthError})</span>
          </Alert>
        )}
        {connect.error && <ErrorAlert error={connect.error} title="Could not start Meta login" />}
        {me && !me.features.meta && (
          <Alert tone="warn" title="Meta app is not configured on the server">
            Add META_APP_ID, META_APP_SECRET, META_CONFIG_ID, META_API_VERSION and META_REDIRECT_URI to the hosting environment. docs/META_SETUP.md walks through it.
          </Alert>
        )}
      </div>

      {(conns.data?.items?.length ?? 0) > 0 && (
        <Card className="mt-6">
          <CardHeader title="Meta logins" description="Tokens are encrypted on the server and never sent to the browser." />
          <ul className="divide-y divide-line">
            {conns.data.items.map((c: any) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <Dot tone={c.status === 'active' ? 'good' : 'bad'} />
                <span className="font-medium text-ink">{c.meta_user_name ?? c.meta_user_id}</span>
                <Badge tone={c.status === 'active' ? 'good' : 'bad'}>{c.status}</Badge>
                <span className="text-ink-3">Checked {timeAgo(c.last_checked_at)}</span>
                {c.token_expires_at && <span className="text-ink-3">Token expires {new Date(c.token_expires_at).toLocaleDateString()}</span>}
                {c.last_error && <span className="text-bad">{c.last_error}</span>}
                {can('accounts.manage') && (
                  <Button size="sm" variant="secondary" className="ml-auto" icon={<RefreshCw className="size-3.5" />} loading={sync.isPending && sync.variables === c.id} onClick={() => sync.mutate(c.id)}>
                    Sync now
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-3 left-3 size-4 text-ink-3" />
            <Input placeholder="Search by name, ID or business" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" />
          </div>
          <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Not active' }]} />
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-32" aria-label="Currency">
            <option value="">All currencies</option>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </div>

        {selected.size > 0 && can('accounts.manage') && (
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2 px-4 py-3 text-sm">
            <span className="font-medium text-ink">{selected.size} selected</span>
            <Input placeholder="New group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} className="h-9 w-56" />
            <Button size="sm" icon={<FolderPlus className="size-4" />} disabled={groupName.trim().length < 2} loading={makeGroup.isPending} onClick={() => makeGroup.mutate()}>
              Save as group
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            {makeGroup.error && <span className="text-bad">{(makeGroup.error as Error).message}</span>}
            {makeGroup.isSuccess && <span className="text-good">Group saved</span>}
          </div>
        )}

        {list.error && (
          <div className="p-4">
            <ErrorAlert error={list.error} />
          </div>
        )}

        {list.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Building2 className="size-6" />} title={debounced || status !== 'all' || currency ? 'No accounts match these filters' : 'No ad accounts yet'}>
            {debounced || status !== 'all' || currency ? 'Try a different search or clear the filters.' : 'Connect Meta to import every ad account your login can access.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="w-10 px-4 py-3">
                    <button
                      aria-label={allOnPage ? 'Unselect page' : 'Select page'}
                      onClick={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          items.forEach((a) => (allOnPage ? n.delete(a.id) : n.add(a.id)));
                          return n;
                        })
                      }
                    >
                      {allOnPage ? <CheckSquare className="size-4 text-brand" /> : <Square className="size-4" />}
                    </button>
                  </th>
                  <th className="px-2 py-3">Account</th>
                  <th className="px-2 py-3">Status</th>
                  <th className="px-2 py-3">Currency</th>
                  <th className="px-2 py-3">Publishing readiness</th>
                  <th className="px-2 py-3">Last sync</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((a) => (
                  <tr key={a.id} className={cx('transition-colors hover:bg-surface-2', selected.has(a.id) && 'bg-surface-2')}>
                    <td className="px-4 py-3">
                      <button aria-label={`Select ${a.name}`} onClick={() => toggle(a.id)}>
                        {selected.has(a.id) ? <CheckSquare className="size-4 text-brand" /> : <Square className="size-4 text-ink-3" />}
                      </button>
                    </td>
                    <td className="px-2 py-3">
                      <div className="font-medium text-ink">{a.name}</div>
                      <div className="text-xs text-ink-3">
                        act_{a.account_id}
                        {a.business_name ? ` · ${a.business_name}` : ''}
                      </div>
                    </td>
                    <td className="px-2 py-3">
                      <Badge tone={a.account_status === 1 ? 'good' : 'bad'}>{a.account_status != null ? STATUS[a.account_status] ?? `Status ${a.account_status}` : 'Unknown'}</Badge>
                    </td>
                    <td className="px-2 py-3 font-medium text-ink-2">{a.currency}</td>
                    <td className="px-2 py-3">
                      <div className="flex items-center gap-2" title={a.readiness.issues.join('\n')}>
                        <Dot tone={a.readiness.level === 'ready' ? 'good' : a.readiness.level === 'warning' ? 'warn' : 'bad'} />
                        <span className="text-ink-2">{a.readiness.level === 'ready' ? 'Ready' : a.readiness.issues[0]}</span>
                        {a.readiness.issues.length > 1 && <span className="text-xs text-ink-3">+{a.readiness.issues.length - 1}</span>}
                      </div>
                    </td>
                    <td className="px-2 py-3 text-ink-3">{timeAgo(a.last_synced_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <a href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${a.account_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                        Ads Manager <ExternalLink className="size-3" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-ink-3">
            <span>
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={page * pageSize >= total} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

export function AccountGroupsPage() {
  const { t } = useI18n();
  usePageTitle(t('accountGroups'));
  const q = useQuery({ queryKey: ['account-groups'], queryFn: () => get('/account-groups') });
  return (
    <>
      <PageHeader title={t('accountGroups')} description="Saved selections of ad accounts, for example one group per brand. Create a group by selecting accounts on the Ad Accounts page." />
      {q.error && <ErrorAlert error={q.error} />}
      <Card>
        {q.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : !q.data?.items?.length ? (
          <EmptyState icon={<FolderPlus className="size-6" />} title="No groups yet">
            Go to Ad Accounts, tick the accounts you want, and choose “Save as group”.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.items.map((g: any) => (
              <li key={g.id} className="flex items-center justify-between gap-3 px-5 py-4">
                <div>
                  <div className="font-medium text-ink">{g.name}</div>
                  {g.description && <div className="text-sm text-ink-3">{g.description}</div>}
                </div>
                <Badge tone="brand">{g.members} accounts</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

