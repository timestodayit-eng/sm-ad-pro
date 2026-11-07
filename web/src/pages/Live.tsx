import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, FolderOpen, ListOrdered, Building2, ExternalLink, Eye, ImageOff, LayoutDashboard, Megaphone, MessageCircle, Phone, RefreshCw, UserPlus, Wallet } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Modal, PageHeader, Segmented, Select, Skeleton, StatCard, cx, timeAgo, type Tone } from '../components/ui';
import { get, post, put } from '../lib/api';
import { AccountOrderEditor } from './AccountOrder';
import { ColumnsMenu, DateFilter, fmtRange, HISTORY_DAYS, normaliseColumns, periodLabel, usePeriod, type ColumnKey, type DashboardPrefs, type SortKey } from './liveControls';
import { usePageTitle, useSession } from '../lib/session';

interface Result { type: string; label: string; count: number; costPer: number | null }
interface Contact { count: number; costPer: number | null }
export interface Metrics { spend: number; impressions: number; clicks: number; linkClicks: number; contacts: { leads: Contact; calls: Contact; messages: Contact }; ctr: number | null; cpc: number | null; cpm: number | null; results: Result[] }

function ContactCell({ c, currency }: { c: Contact; currency: string }) {
  return (
    <div className="whitespace-nowrap text-right">
      <div className={cx('font-medium tabular-nums', c.count ? 'text-ink' : 'text-ink-3')}>{num(c.count)}</div>
      <div className="text-xs text-ink-3 tabular-nums">{c.costPer != null ? `${money(c.costPer, currency)} each` : '—'}</div>
    </div>
  );
}

// ---------- formatting ----------

export function money(n: number | null | undefined, currency: string, compact = false) {
  if (n == null) return '—';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : n >= 1000 ? 0 : 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
export const num = (n: number | null | undefined, compact = false) => (n == null ? '—' : new Intl.NumberFormat('en', { notation: compact ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
export const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(2)}%`);

const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'good' },
  PAUSED: { label: 'Paused', tone: 'neutral' },
  CAMPAIGN_PAUSED: { label: 'Campaign paused', tone: 'neutral' },
  ADSET_PAUSED: { label: 'Ad set paused', tone: 'neutral' },
  DISAPPROVED: { label: 'Rejected', tone: 'bad' },
  PENDING_REVIEW: { label: 'In review', tone: 'warn' },
  PREAPPROVED: { label: 'Pre-approved', tone: 'info' },
  PENDING_BILLING_INFO: { label: 'Billing needed', tone: 'warn' },
  WITH_ISSUES: { label: 'Has issues', tone: 'bad' },
  IN_PROCESS: { label: 'Processing', tone: 'info' },
};
export function DeliveryBadge({ status }: { status: string | null }) {
  const s = (status && STATUS[status]) || { label: status ?? 'Unknown', tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

function ResultCell({ m, currency }: { m: Metrics; currency: string }) {
  const [top, ...rest] = m.results;
  if (!top) return <span className="text-ink-3" title="This objective has no countable result (for example Awareness)">—</span>;
  return (
    <div className="whitespace-nowrap" title={m.results.map((r) => `${r.label}: ${num(r.count)}`).join('\n')}>
      <div className="font-medium text-ink tabular-nums">
        {num(top.count)} <span className="text-xs font-normal text-ink-3">{top.label.toLowerCase()}</span>
      </div>
      <div className="text-xs text-ink-3 tabular-nums">
        {top.costPer != null ? `${money(top.costPer, currency)} each` : 'no results yet'}
        {rest.length > 0 && ` · +${rest.length} other type${rest.length > 1 ? 's' : ''}`}
      </div>
    </div>
  );
}

// ---------- charts (single series: brand colour, no legend, hover for values) ----------

function Sparkline({ data, currency }: { data: { date: string; spend: number }[]; currency: string }) {
  const max = Math.max(...data.map((d) => d.spend), 0);
  const w = 120, h = 32, gap = 1;
  const bw = (w - gap * (data.length - 1)) / data.length;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-brand" role="img" aria-label={`Daily spend, last 30 days, highest ${money(max, currency)}`}>
      <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} className="stroke-line" />
      {data.map((d, i) => {
        const bh = max > 0 ? Math.max((d.spend / max) * (h - 2), d.spend > 0 ? 1.5 : 0) : 0;
        return (
          <rect key={d.date} x={i * (bw + gap)} y={h - 1 - bh} width={bw} height={bh} rx={1} className="fill-current">
            <title>{`${d.date}: ${money(d.spend, currency)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function SpendBars({ data, currency }: { data: { date: string; spend: number }[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [w, setW] = useState(720);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = Math.max(...data.map((d) => d.spend), 0);
  const h = 200, padB = 22, top = 6;
  const slot = w / data.length;
  const gap = 2;
  const bw = Math.min(56, Math.max(2, slot - gap));
  const r = Math.min(4, bw / 2);
  const hv = hover != null ? data[hover] : null;
  const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const every = Math.ceil(data.length / Math.max(2, Math.floor(w / 80)));
  return (
    <div ref={ref}>
      <div className="mb-2 h-5 text-sm text-ink-2 tabular-nums">
        {max === 0 ? <span className="text-ink-3">No spend in this period.</span> : hv ? <><span className="text-ink-3">{label(hv.date)}:</span> <strong className="text-ink">{money(hv.spend, currency)}</strong></> : <span className="text-ink-3">Hover a bar for the day’s spend. Highest day {money(max, currency)}.</span>}
      </div>
      {max > 0 && (
        <svg width={w} height={h} className="block text-brand" role="img" aria-label={`Daily spend, highest day ${money(max, currency)}`} onMouseLeave={() => setHover(null)}>
          <line x1={0} x2={w} y1={top + (h - padB - top) / 2} y2={top + (h - padB - top) / 2} className="stroke-line" strokeDasharray="2 4" />
          <line x1={0} x2={w} y1={h - padB + 0.5} y2={h - padB + 0.5} className="stroke-line" />
          {data.map((d, i) => {
            const bh = (d.spend / max) * (h - padB - top);
            const x = i * slot + (slot - bw) / 2;
            const rr = Math.min(r, bh);
            return (
              <g key={d.date} onMouseEnter={() => setHover(i)}>
                <rect x={i * slot} y={0} width={slot} height={h - padB} fill="transparent" />
                {bh > 0 && (
                  <path
                    d={`M${x},${h - padB} V${h - padB - bh + rr} Q${x},${h - padB - bh} ${x + rr},${h - padB - bh} H${x + bw - rr} Q${x + bw},${h - padB - bh} ${x + bw},${h - padB - bh + rr} V${h - padB} Z`}
                    className={cx('fill-current transition-opacity', hover != null && hover !== i && 'opacity-50')}
                  >
                    <title>{`${label(d.date)}: ${money(d.spend, currency)}`}</title>
                  </path>
                )}
                {i % every === 0 && (
                  <text x={i * slot + slot / 2} y={h - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                    {label(d.date)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ---------- shared header controls ----------

function useRefresh(accountIds?: number[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ queued: number; accounts: number }>('/live/sync', accountIds ? { accountIds } : {}),
    onSuccess: () => {
      // The sync runs in the background; poll a few times so new numbers appear without a reload.
      [8_000, 20_000, 45_000].forEach((ms) => setTimeout(() => qc.invalidateQueries({ queryKey: ['live'] }), ms));
    },
  });
}

function RefreshButton({ accountIds, syncedAt }: { accountIds?: number[]; syncedAt?: string | null }) {
  const refresh = useRefresh(accountIds);
  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-xs text-ink-3 sm:inline">{refresh.isSuccess ? 'Refreshing from Meta…' : syncedAt ? `Updated ${timeAgo(syncedAt)}` : 'Not synced yet'}</span>
      <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
        Refresh
      </Button>
    </div>
  );
}

const oldest = (xs: (string | null)[]) => xs.reduce<string | null>((a, b) => (!b ? a : !a || b < a ? b : a), null);

// ---------- dashboard ----------

type Row = any;
interface ColumnDef {
  key: ColumnKey;
  label: string;
  title?: string;
  align?: 'right';
  /** Value used for sorting; null always sorts last. */
  value: (a: Row) => number | string | null;
  cell: (a: Row) => ReactNode;
  needsMetrics?: boolean;
  /** Default direction on first click. */
  firstDir?: 'asc' | 'desc';
}

const COLUMNS: ColumnDef[] = [
  { key: 'spend', label: 'Spend', align: 'right', needsMetrics: true, value: (a) => a.metrics?.spend ?? null, cell: (a) => <span className="font-medium text-ink tabular-nums">{money(a.metrics.spend, a.currency)}</span> },
  { key: 'leads', label: 'Leads', align: 'right', needsMetrics: true, value: (a) => a.metrics?.contacts.leads.count ?? null, cell: (a) => <ContactCell c={a.metrics.contacts.leads} currency={a.currency} /> },
  { key: 'calls', label: 'Calls', align: 'right', needsMetrics: true, value: (a) => a.metrics?.contacts.calls.count ?? null, cell: (a) => <ContactCell c={a.metrics.contacts.calls} currency={a.currency} /> },
  { key: 'messages', label: 'Messages', align: 'right', needsMetrics: true, value: (a) => a.metrics?.contacts.messages.count ?? null, cell: (a) => <ContactCell c={a.metrics.contacts.messages} currency={a.currency} /> },
  { key: 'results', label: 'Results', title: "Counted by each campaign's objective, like Ads Manager's Results column", needsMetrics: true, value: (a) => a.metrics?.results[0]?.count ?? null, cell: (a) => <ResultCell m={a.metrics} currency={a.currency} /> },
  { key: 'ctr', label: 'CTR', align: 'right', needsMetrics: true, value: (a) => a.metrics?.ctr ?? null, cell: (a) => <span className="tabular-nums">{pct(a.metrics.ctr)}</span> },
  { key: 'cpc', label: 'Cost per click', align: 'right', needsMetrics: true, firstDir: 'asc', value: (a) => a.metrics?.cpc ?? null, cell: (a) => <span className="tabular-nums">{money(a.metrics.cpc, a.currency)}</span> },
  {
    key: 'running', label: 'Running', value: (a) => a.ads.active,
    cell: (a) => (
      <div className="whitespace-nowrap">
        <div className="tabular-nums text-ink">{plural(a.ads.active, 'ad')} <span className="text-ink-3">· {plural(a.campaigns.active, 'campaign')}</span></div>
        {a.ads.disapproved > 0 && <div className="text-xs text-bad">{a.ads.disapproved} rejected</div>}
      </div>
    ),
  },
  { key: 'budget', label: 'Daily budget', align: 'right', value: (a) => a.activeDailyBudget, cell: (a) => <span className="tabular-nums">{money(a.activeDailyBudget, a.currency)}</span> },
  { key: 'trend', label: '30-day trend', title: 'Daily spend for the 30 days up to the end of the chosen period', value: (a) => a.dailySpend?.reduce((n: number, d: any) => n + d.spend, 0) ?? null, cell: (a) => (a.dailySpend ? <Sparkline data={a.dailySpend} currency={a.currency} /> : <span className="text-ink-3">—</span>) },
  {
    key: 'synced', label: 'Synced', firstDir: 'asc', value: (a) => a.syncedAt,
    cell: (a) => a.syncError ? (
      <span className="inline-flex max-w-[220px] items-start gap-1 text-xs text-bad" title={a.syncError}><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="line-clamp-2">{a.syncError}</span></span>
    ) : (
      <span className="whitespace-nowrap text-xs text-ink-3">{timeAgo(a.syncedAt)}</span>
    ),
  },
];
const COL = Object.fromEntries(COLUMNS.map((c) => [c.key, c])) as Record<ColumnKey, ColumnDef>;
const COLUMN_LABELS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])) as Record<ColumnKey, string>;

/** Rows arrive in the panel's account order; a column sort is applied on top. */
function sortRows(ordered: Row[], sort: DashboardPrefs['sort']) {
  if (!sort || sort.key === 'custom') return ordered;
  const val = sort.key === 'name' ? (a: Row) => a.name.toLowerCase() : COL[sort.key].value;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return ordered
    .map((r, i) => ({ r, i, v: val(r) }))
    .sort((a, b) => (a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : b.v == null ? -1 : a.v < b.v ? -dir : a.v > b.v ? dir : a.i - b.i))
    .map((x) => x.r);
}

function useDashboardPrefs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['prefs', 'dashboard'], queryFn: () => get<DashboardPrefs>('/me/preferences/dashboard'), staleTime: Infinity });
  const save = useMutation({
    mutationFn: (p: DashboardPrefs) => put<DashboardPrefs>('/me/preferences/dashboard', p),
    onMutate: (p) => qc.setQueryData(['prefs', 'dashboard'], p),
    onError: () => qc.invalidateQueries({ queryKey: ['prefs', 'dashboard'] }),
  });
  const prefs: DashboardPrefs = { columns: normaliseColumns(q.data?.columns ?? []), sort: q.data?.sort ?? null };
  return { prefs, loaded: q.isSuccess, save: (patch: Partial<DashboardPrefs>) => save.mutate({ ...prefs, ...patch }), saving: save.isPending, error: save.error };
}

/** ?group=ID keeps the chosen account group in the URL, next to the date range. */
export function useGroup() {
  const [sp, setSp] = useSearchParams();
  const raw = Number(sp.get('group'));
  const group = Number.isInteger(raw) && raw > 0 ? raw : null;
  const set = (g: number | null) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (g) next.set('group', String(g));
      else next.delete('group');
      return next;
    }, { replace: true });
  return { group, set, qs: group ? `&group=${group}` : '' };
}

export function GroupPicker({ group, onChange }: { group: number | null; onChange: (g: number | null) => void }) {
  const q = useQuery({ queryKey: ['account-groups'], queryFn: () => get('/account-groups') });
  const groups: any[] = q.data?.items ?? [];
  if (!groups.length && !group) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-ink-3">
      <FolderOpen className="size-4" />
      <span className="sr-only">Account group</span>
      <Select className="h-9 w-56" value={group ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">All working accounts</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.managed} working)</option>)}
      </Select>
    </label>
  );
}

export function LiveDashboard({ greeting }: { greeting: string }) {
  const { can } = useSession();
  const { period, qs, set: setPeriod } = usePeriod('today');
  const { group, set: setGroup, qs: groupQs } = useGroup();
  const q = useQuery({ queryKey: ['live', 'overview', qs, group], queryFn: () => get(`/live/overview?${qs}${groupQs}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const d = q.data;
  const accounts: Row[] = d?.accounts ?? [];
  const syncedAt = oldest(accounts.map((a) => a.syncedAt));
  const range = accounts[0]?.range;
  const linkQs = `?${qs}${groupQs}`;

  return (
    <>
      <PageHeader
        title={greeting}
        description="Live spend, results, campaigns and ads for the accounts you manage. Numbers come straight from Meta."
        actions={d?.managedCount ? <RefreshButton syncedAt={syncedAt} accountIds={group ? accounts.map((a) => a.id) : undefined} /> : undefined}
      />
      {q.error && <ErrorAlert error={q.error} />}

      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-2xl" />)}
        </div>
      ) : d && d.availableCount === 0 ? (
        <Card>
          <EmptyState icon={<Building2 className="size-6" />} title="Connect your Meta Business account" action={<Link to="/accounts"><Button>Go to Ad Accounts</Button></Link>}>
            Sign in with Facebook Login for Business once, and every ad account you can access is imported. Then pick the ones to manage.
          </EmptyState>
        </Card>
      ) : d && d.managedCount === 0 ? (
        <Card>
          <EmptyState
            icon={<LayoutDashboard className="size-6" />}
            title="Choose the accounts you want to manage"
            action={can('accounts.manage') ? <Link to="/accounts?pick=1"><Button icon={<Eye className="size-4" />}>Choose accounts</Button></Link> : undefined}
          >
            {d.availableCount} ad account{d.availableCount === 1 ? ' is' : 's are'} connected. Turn on the ones you want here, and the panel syncs their spend, results, campaigns and ads every 15 minutes.
            {!can('accounts.manage') && ' Ask an admin to choose them.'}
          </EmptyState>
        </Card>
      ) : d ? (
        <>
          <div className="mb-4 flex flex-col gap-3">
            <DateFilter period={period} onChange={setPeriod} range={range} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <GroupPicker group={group} onChange={setGroup} />
                {range && <span className="text-sm text-ink-2">{periodLabel(period)} · <span className="tabular-nums">{fmtRange(range)}</span></span>}
                {q.isFetching && !q.isLoading && <span className="text-xs text-ink-3">Updating…</span>}
              </div>
              {can('accounts.manage') && (
                <Link to="/settings#working-accounts" className="text-sm font-medium text-brand hover:underline">
                  Working accounts: {d.managedCount} of {d.availableCount}
                </Link>
              )}
            </div>
          </div>
          {accounts.some((a) => a.incomplete) && (
            <div className="mb-4"><Alert tone="warn" title="Part of this range is older than the panel keeps">The panel stores the last {HISTORY_DAYS} days. Days before that are not in these totals; use Ads Manager for older reports.</Alert></div>
          )}

          {d.group && accounts.length === 0 ? (
            <Card>
              <EmptyState icon={<FolderOpen className="size-6" />} title={`No dashboard accounts in “${d.group.name}”`} action={<Button variant="secondary" onClick={() => setGroup(null)}>Show all accounts</Button>}>
                This group has {plural(d.group.members, 'account')}, but none of them is a working account. Add them in Settings → Working accounts.
              </EmptyState>
            </Card>
          ) : (
            <>
              {d.totalsByCurrency.length === 0 ? (
                <Alert tone="info" title="First sync in progress">
                  The panel is fetching campaigns, ads and the last {HISTORY_DAYS} days of results from Meta. This usually takes a minute or two.
                </Alert>
              ) : (
                d.totalsByCurrency.map((t: any) => {
                  const active = accounts.filter((a) => a.currency === t.currency);
                  return (
                    <div key={t.currency} className="mb-4">
                      {d.totalsByCurrency.length > 1 && <div className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">{t.currency} accounts · spend is never added across currencies</div>}
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                        <StatCard label="Spend" value={money(t.spend, t.currency)} icon={<Wallet className="size-4" />} sub={`${plural(t.accounts, 'account')} · daily budget ${money(t.activeDailyBudget, t.currency)} · CTR ${pct(t.ctr)}`} />
                        <StatCard label="Leads" value={num(t.contacts.leads.count)} icon={<UserPlus className="size-4" />} sub={t.contacts.leads.costPer != null ? `${money(t.contacts.leads.costPer, t.currency)} per lead` : 'No leads in this period'} />
                        <StatCard label="Calls" value={num(t.contacts.calls.count)} icon={<Phone className="size-4" />} sub={t.contacts.calls.costPer != null ? `${money(t.contacts.calls.costPer, t.currency)} per call` : 'No calls in this period'} />
                        <StatCard label="Messages" value={num(t.contacts.messages.count)} icon={<MessageCircle className="size-4" />} sub={t.contacts.messages.costPer != null ? `${money(t.contacts.messages.costPer, t.currency)} per conversation` : 'No conversations in this period'} />
                        <StatCard
                          label="Running now"
                          value={plural(active.reduce((n, a) => n + a.ads.active, 0), 'ad')}
                          icon={<Megaphone className="size-4" />}
                          tone={active.some((a) => a.ads.disapproved) ? 'warn' : undefined}
                          sub={`${plural(active.reduce((n, a) => n + a.campaigns.active, 0), 'active campaign')}${active.some((a) => a.ads.disapproved) ? ` · ${plural(active.reduce((n, a) => n + a.ads.disapproved, 0), 'rejected ad')}` : ''}`}
                        />
                      </div>
                    </div>
                  );
                })
              )}
              <AccountsTable accounts={accounts} linkQs={linkQs} title={d.group ? `Accounts in “${d.group.name}”` : 'Your accounts'} groupName={d.group?.name} />
            </>
          )}
          <p className="mt-3 text-xs text-ink-3">
            Synced from Meta Insights every 15 minutes (Meta itself can lag up to about 15 minutes). Dates follow each account’s own time zone; “Last 7 days” ends yesterday, like Ads Manager. Leads, calls and messages are counted for every campaign whatever its objective; Results follows each campaign’s objective. Set cost alerts in Settings.
          </p>
        </>
      ) : null}
    </>
  );
}

function AccountsTable({ accounts, linkQs, title, groupName }: { accounts: Row[]; linkQs: string; title: string; groupName?: string }) {
  const { can } = useSession();
  const { prefs, save, error } = useDashboardPrefs();
  const [arranging, setArranging] = useState(false);
  const cols = prefs.columns.filter((c) => c.visible).map((c) => COL[c.key]);
  const sort = prefs.sort ?? { key: 'custom' as const, dir: 'asc' as const };
  const rows = sortRows(accounts, sort);
  const sortBy = (key: SortKey, firstDir: 'asc' | 'desc') => {
    const next = sort.key === key ? { key, dir: sort.dir === 'asc' ? ('desc' as const) : ('asc' as const) } : { key, dir: firstDir };
    save({ sort: next });
  };
  const Th = ({ k, label, align, title: tip, firstDir = 'desc', className }: { k: SortKey; label: string; align?: 'right'; title?: string; firstDir?: 'asc' | 'desc'; className?: string }) => {
    const on = sort.key === k;
    return (
      <th className={cx('py-3', className ?? 'px-2', align === 'right' && 'text-right')} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} title={tip}>
        <button className={cx('inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink', on && 'text-ink')} onClick={() => sortBy(k, firstDir)}>
          {label}
          {on ? (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
        </button>
      </th>
    );
  };

  return (
    <Card className="mt-2">
      <CardHeader
        title={title}
        description={sort.key === 'custom' ? 'In your account order. Click a column name to sort by it. Click an account for campaigns, ads and previews.' : 'Sorted by a column for now. Your account order is still saved.'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {sort.key !== 'custom' && (
              <Button variant="secondary" size="sm" onClick={() => save({ sort: { key: 'custom', dir: 'asc' } })}>Back to my order</Button>
            )}
            {can('accounts.manage') && (
              <Button variant="secondary" size="sm" icon={<ListOrdered className="size-3.5" />} onClick={() => setArranging(true)} disabled={accounts.length < 2}>Arrange order</Button>
            )}
            <ColumnsMenu columns={prefs.columns} labels={COLUMN_LABELS} onChange={(columns) => save({ columns })} />
          </div>
        }
      />
      {error && <div className="px-5 pb-3"><ErrorAlert error={error} title="Could not save your layout" /></div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 300 + cols.length * 110 }}>
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
              <th className="w-10 py-3 pl-5 text-right" title="Place in your account order">
                <button className={cx('uppercase hover:text-ink', sort.key === 'custom' && 'text-ink')} onClick={() => save({ sort: { key: 'custom', dir: 'asc' } })}>#</button>
              </th>
              <Th k="name" label="Account" firstDir="asc" className="px-3" />
              {cols.map((c) => <Th key={c.key} k={c.key} label={c.label} align={c.align} title={c.title} firstDir={c.firstDir} />)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((a: Row) => (
              <tr key={a.id} className="hover:bg-surface-2">
                <td className="py-3 pl-5 text-right text-xs text-ink-3 tabular-nums">{accounts.indexOf(a) + 1}</td>
                <td className="min-w-[230px] px-3 py-3">
                  <Link to={`/live/${a.id}${linkQs}`} className="font-medium text-ink hover:text-brand hover:underline">{a.name}</Link>
                  <div className="text-xs text-ink-3">act_{a.accountId} · {a.currency}{a.accountStatus !== 1 && <span className="text-bad"> · account not active</span>}</div>
                  {!a.metrics && <div className="text-xs text-ink-3">{a.syncError ? 'Could not sync, see Synced' : 'Waiting for the first sync…'}</div>}
                  {a.costAlertsToday > 0 && (
                    <Link to="/notifications" className="mt-1 inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-warn-bg px-1.5 py-0.5 text-xs font-medium text-warn hover:underline">
                      <AlertTriangle className="size-3" /> {plural(a.costAlertsToday, 'cost alert')} today
                    </Link>
                  )}
                </td>
                {cols.map((c) => (
                  <td key={c.key} className={cx('px-2 py-3', c.align === 'right' && 'text-right')}>
                    {c.needsMetrics && !a.metrics ? <span className="text-ink-3">—</span> : c.cell(a)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AccountOrderEditor
        open={arranging}
        onClose={() => setArranging(false)}
        subset={groupName ? accounts.map((a) => a.id) : undefined}
        title={groupName ? `Account order in “${groupName}”` : 'Account order'}
      />
    </Card>
  );
}

// ---------- one account ----------

const FORMATS = [
  { value: 'MOBILE_FEED_STANDARD', label: 'Facebook feed (mobile)' },
  { value: 'INSTAGRAM_STANDARD', label: 'Instagram feed' },
  { value: 'FACEBOOK_REELS_MOBILE', label: 'Facebook Reels' },
  { value: 'INSTAGRAM_REELS', label: 'Instagram Reels' },
  { value: 'INSTAGRAM_STORY', label: 'Instagram Stories' },
  { value: 'FACEBOOK_STORY_MOBILE', label: 'Facebook Stories' },
  { value: 'DESKTOP_FEED_STANDARD', label: 'Facebook feed (desktop)' },
];

function PreviewModal({ ad, onClose }: { ad: any | null; onClose: () => void }) {
  const [format, setFormat] = useState('MOBILE_FEED_STANDARD');
  const q = useQuery({ queryKey: ['live', 'preview', ad?.adId, format], queryFn: () => get(`/live/ads/${ad.adId}/preview?format=${format}`), enabled: !!ad, staleTime: 10 * 60_000 });
  return (
    <Modal open={!!ad} onClose={onClose} title={ad?.name ?? 'Preview'}>
      <div className="space-y-4">
        <Select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Placement">
          {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </Select>
        <div className="grid min-h-[420px] place-items-center rounded-xl bg-surface-2 p-2">
          {q.isLoading ? <Skeleton className="h-[400px] w-[320px]" /> : q.error ? <ErrorAlert error={q.error} /> : q.data?.src ? (
            <iframe title={`Meta preview of ${ad?.name}`} src={q.data.src} className="h-[560px] w-full max-w-[400px] rounded-lg border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-popups" />
          ) : null}
        </div>
        <p className="text-xs text-ink-3">This is Meta’s own rendering of the live ad, loaded from facebook.com.</p>
      </div>
    </Modal>
  );
}

export function LiveAccountPage() {
  const { id } = useParams();
  const { period, qs, set: setPeriod } = usePeriod('7d');
  const [sp] = useSearchParams();
  const [preview, setPreview] = useState<any | null>(null);
  const [adFilter, setAdFilter] = useState<'running' | 'all'>('running');
  const q = useQuery({ queryKey: ['live', 'account', id, qs], queryFn: () => get(`/live/accounts/${id}?${qs}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const d = q.data;
  usePageTitle(d?.account.name ?? 'Account');
  const cur = d?.account.currency ?? 'USD';
  const ads: any[] = (d?.ads ?? []).filter((a: any) => adFilter === 'all' || a.effectiveStatus === 'ACTIVE' || a.effectiveStatus === 'DISAPPROVED' || a.effectiveStatus === 'WITH_ISSUES' || a.effectiveStatus === 'PENDING_REVIEW');

  return (
    <>
      <Link to={`/?${sp.toString()}`} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink"><ArrowLeft className="size-4" /> Dashboard</Link>
      <PageHeader
        title={d?.account.name ?? ' '}
        description={d ? `act_${d.account.accountId} · ${d.account.currency} · ${d.account.timezone ?? 'UTC'}` : undefined}
        actions={
          d && (
            <div className="flex items-center gap-3">
              <RefreshButton accountIds={[d.account.id]} syncedAt={d.account.syncedAt} />
              <a href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${d.account.accountId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                Ads Manager <ExternalLink className="size-3.5" />
              </a>
            </div>
          )
        }
      />
      {q.error && <ErrorAlert error={q.error} />}
      {d?.account.syncError && <div className="mb-4"><Alert tone="bad" title="The last sync failed">{d.account.syncError}</Alert></div>}
      {q.isLoading && <Skeleton className="h-64 rounded-2xl" />}
      {d && !d.account.synced && !d.account.syncError && <Alert tone="info" title="First sync in progress">Campaigns, ads and results appear here within a minute or two.</Alert>}
      {d?.account.synced && (
        <>
          <div className="mb-4 space-y-2">
            <DateFilter period={period} onChange={setPeriod} range={d.range} />
            <div className="text-sm text-ink-2">{periodLabel(period)} · <span className="tabular-nums">{fmtRange(d.range)}</span>{q.isFetching && <span className="ml-2 text-xs text-ink-3">Updating…</span>}</div>
            {d.incomplete && <Alert tone="warn" title="Part of this range is older than the panel keeps">The panel stores the last {HISTORY_DAYS} days. Days before that are not in these totals.</Alert>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <StatCard label="Spend" value={money(d.totals.spend, cur)} icon={<Wallet className="size-4" />} sub={`${num(d.totals.impressions)} impressions · CTR ${pct(d.totals.ctr)}`} />
            <StatCard label="Leads" value={num(d.totals.contacts.leads.count)} icon={<UserPlus className="size-4" />} sub={d.totals.contacts.leads.costPer != null ? `${money(d.totals.contacts.leads.costPer, cur)} per lead` : 'No leads in this period'} />
            <StatCard label="Calls" value={num(d.totals.contacts.calls.count)} icon={<Phone className="size-4" />} sub={d.totals.contacts.calls.costPer != null ? `${money(d.totals.contacts.calls.costPer, cur)} per call` : 'No calls in this period'} />
            <StatCard label="Messages" value={num(d.totals.contacts.messages.count)} icon={<MessageCircle className="size-4" />} sub={d.totals.contacts.messages.costPer != null ? `${money(d.totals.contacts.messages.costPer, cur)} per conversation` : 'No conversations in this period'} />
            <StatCard label="Running now" value={plural(d.ads.filter((a: any) => a.effectiveStatus === 'ACTIVE').length, 'ad')} icon={<Megaphone className="size-4" />} sub={`${d.campaigns.filter((c: any) => c.effectiveStatus === 'ACTIVE').length} of ${d.campaigns.length} campaigns active`} />
          </div>

          {d.dailySpend.length > 1 && (
            <Card className="mt-6">
              <CardHeader title="Daily spend" />
              <div className="px-5 pb-5"><SpendBars data={d.dailySpend} currency={cur} /></div>
            </Card>
          )}

          <Card className="mt-6">
            <CardHeader title="Campaigns" description="Every campaign that is not archived or deleted on Meta." />
            {d.campaigns.length === 0 ? (
              <EmptyState icon={<Megaphone className="size-6" />} title="No campaigns">This account has no active or paused campaigns.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                      <th className="px-5 py-3">Campaign</th>
                      <th className="px-2 py-3">Delivery</th>
                      <th className="px-2 py-3 text-right">Budget</th>
                      <th className="px-2 py-3 text-right">Spend</th>
                      <th className="px-2 py-3 text-right">Leads</th>
                      <th className="px-2 py-3 text-right">Calls</th>
                      <th className="px-2 py-3 text-right">Messages</th>
                      <th className="px-2 py-3">Results</th>
                      <th className="px-5 py-3 text-right">CTR</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.campaigns.map((c: any) => (
                      <tr key={c.campaignId}>
                        <td className="px-5 py-3">
                          <div className="font-medium text-ink">{c.name}</div>
                          <div className="text-xs text-ink-3">{(c.objective ?? '').replace('OUTCOME_', '').toLowerCase()} · {c.adsets} ad set{c.adsets === 1 ? '' : 's'}</div>
                        </td>
                        <td className="px-2 py-3"><DeliveryBadge status={c.effectiveStatus} /></td>
                        <td className="px-2 py-3 text-right tabular-nums">
                          {c.budget ? <>{money(c.budget.amount, cur)}<div className="text-xs text-ink-3">{c.budget.kind}{c.budget.level === 'adset' ? ', ad sets' : ''}</div></> : '—'}
                        </td>
                        <td className="px-2 py-3 text-right font-medium tabular-nums text-ink">{money(c.metrics.spend, cur)}</td>
                        <td className="px-2 py-3"><ContactCell c={c.metrics.contacts.leads} currency={cur} /></td>
                        <td className="px-2 py-3"><ContactCell c={c.metrics.contacts.calls} currency={cur} /></td>
                        <td className="px-2 py-3"><ContactCell c={c.metrics.contacts.messages} currency={cur} /></td>
                        <td className="px-2 py-3"><ResultCell m={c.metrics} currency={cur} /></td>
                        <td className="px-5 py-3 text-right tabular-nums">{pct(c.metrics.ctr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.unlistedSpend > 0 && <div className="border-t border-line px-5 py-3 text-xs text-ink-3">{money(d.unlistedSpend, cur)} of this period’s spend came from campaigns that are now archived or deleted. It is included in the totals above.</div>}
          </Card>

          <Card className="mt-6">
            <CardHeader
              title="Ads"
              description="Thumbnails from Meta. Open a preview to see the ad exactly as Meta shows it."
              actions={<Segmented label="Which ads" value={adFilter} onChange={setAdFilter} options={[{ value: 'running', label: 'Running & issues' }, { value: 'all', label: 'All' }]} />}
            />
            {ads.length === 0 ? (
              <EmptyState icon={<Megaphone className="size-6" />} title={adFilter === 'running' ? 'No ads running right now' : 'No ads'}>{adFilter === 'running' ? 'Switch to “All” to see paused ads.' : 'This account has no active or paused ads.'}</EmptyState>
            ) : (
              <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {ads.map((ad) => (
                  <div key={ad.adId} className="overflow-hidden rounded-xl border border-line bg-surface">
                    <button className="group relative block aspect-square w-full bg-surface-2" onClick={() => setPreview(ad)} aria-label={`Preview ${ad.name}`}>
                      {ad.thumbnailUrl ? (
                        <img src={ad.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
                      ) : (
                        <div className="grid size-full place-items-center text-ink-3"><ImageOff className="size-8" /></div>
                      )}
                      <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-black/55 py-2 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        <Eye className="size-3.5" /> Preview
                      </span>
                    </button>
                    <div className="space-y-2 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink" title={ad.name}>{ad.name}</div>
                          <div className="truncate text-xs text-ink-3" title={`${ad.campaignName} › ${ad.adsetName}`}>{ad.campaignName} › {ad.adsetName}</div>
                        </div>
                        <DeliveryBadge status={ad.effectiveStatus} />
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div><div className="text-ink-3">Spend</div><div className="font-medium tabular-nums text-ink">{money(ad.metrics.spend, cur)}</div></div>
                        <div className="min-w-0"><div className="truncate text-ink-3" title={ad.metrics.results[0]?.label}>{ad.metrics.results[0]?.label ?? 'Results'}</div><div className="font-medium tabular-nums text-ink">{ad.metrics.results[0] ? num(ad.metrics.results[0].count) : '—'}</div></div>
                        <div><div className="text-ink-3">CTR</div><div className="font-medium tabular-nums text-ink">{pct(ad.metrics.ctr)}</div></div>
                      </div>
                      <Button size="sm" variant="secondary" className="w-full" icon={<Eye className="size-3.5" />} onClick={() => setPreview(ad)}>Preview</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
      <PreviewModal ad={preview} onClose={() => setPreview(null)} />
    </>
  );
}
