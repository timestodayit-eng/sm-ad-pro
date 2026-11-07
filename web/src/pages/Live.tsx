import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Building2, ExternalLink, Eye, ImageOff, LayoutDashboard, Megaphone, MessageCircle, Phone, RefreshCw, UserPlus, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Modal, PageHeader, Segmented, Select, Skeleton, StatCard, cx, timeAgo, type Tone } from '../components/ui';
import { get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';

export type Period = 'today' | 'yesterday' | '7d' | '30d';
export const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

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

export function LiveDashboard({ greeting }: { greeting: string }) {
  const { can } = useSession();
  const [period, setPeriod] = useState<Period>('today');
  const q = useQuery({ queryKey: ['live', 'overview', period], queryFn: () => get(`/live/overview?period=${period}`), refetchInterval: 60_000 });
  const d = q.data;
  const accounts: any[] = d?.accounts ?? [];
  const syncedAt = oldest(accounts.map((a) => a.syncedAt));

  return (
    <>
      <PageHeader
        title={greeting}
        description="Live spend, results, campaigns and ads for the accounts you manage. Numbers come straight from Meta."
        actions={d?.managedCount ? <RefreshButton syncedAt={syncedAt} /> : undefined}
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
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS} />
            {can('accounts.manage') && (
              <Link to="/accounts?pick=1" className="text-sm font-medium text-brand hover:underline">
                Change accounts ({d.managedCount} of {d.availableCount})
              </Link>
            )}
          </div>

          {d.totalsByCurrency.length === 0 ? (
            <Alert tone="info" title="First sync in progress">
              The panel is fetching campaigns, ads and the last 30 days of results from Meta. This usually takes a minute or two.
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

          <Card className="mt-2">
            <CardHeader title="Your accounts" description={`${PERIODS.find((p) => p.value === period)!.label}, in each account’s own time zone. Click an account for campaigns, ads and previews.`} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1280px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                    <th className="px-5 py-3">Account</th>
                    <th className="px-2 py-3 text-right">Spend</th>
                    <th className="px-2 py-3 text-right">Leads</th>
                    <th className="px-2 py-3 text-right">Calls</th>
                    <th className="px-2 py-3 text-right">Messages</th>
                    <th className="px-2 py-3" title="Counted by each campaign's objective, like Ads Manager's Results column">Results</th>
                    <th className="px-2 py-3 text-right">CTR</th>
                    <th className="px-2 py-3">Running</th>
                    <th className="px-2 py-3 text-right">Daily budget</th>
                    <th className="px-2 py-3">Last 30 days</th>
                    <th className="px-5 py-3">Synced</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {accounts.map((a) => (
                    <tr key={a.id} className="hover:bg-surface-2">
                      <td className="min-w-[230px] px-5 py-3">
                        <Link to={`/live/${a.id}`} className="font-medium text-ink hover:text-brand hover:underline">{a.name}</Link>
                        <div className="text-xs text-ink-3">act_{a.accountId} · {a.currency}{a.accountStatus !== 1 && <span className="text-bad"> · account not active</span>}</div>
                        {a.costAlertsToday > 0 && (
                          <Link to="/notifications" className="mt-1 inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-warn-bg px-1.5 py-0.5 text-xs font-medium text-warn hover:underline">
                            <AlertTriangle className="size-3" /> {plural(a.costAlertsToday, 'cost alert')} today
                          </Link>
                        )}
                      </td>
                      {a.metrics ? (
                        <>
                          <td className="px-2 py-3 text-right font-medium text-ink tabular-nums">{money(a.metrics.spend, a.currency)}</td>
                          <td className="px-2 py-3"><ContactCell c={a.metrics.contacts.leads} currency={a.currency} /></td>
                          <td className="px-2 py-3"><ContactCell c={a.metrics.contacts.calls} currency={a.currency} /></td>
                          <td className="px-2 py-3"><ContactCell c={a.metrics.contacts.messages} currency={a.currency} /></td>
                          <td className="px-2 py-3"><ResultCell m={a.metrics} currency={a.currency} /></td>
                          <td className="px-2 py-3 text-right tabular-nums">{pct(a.metrics.ctr)}</td>
                        </>
                      ) : (
                        <td colSpan={6} className="px-2 py-3 text-ink-3">{a.syncError ? 'Could not sync, see the error on the right' : 'Waiting for the first sync…'}</td>
                      )}
                      <td className="whitespace-nowrap px-2 py-3">
                        <div className="tabular-nums text-ink">{plural(a.ads.active, 'ad')} <span className="text-ink-3">· {plural(a.campaigns.active, 'campaign')}</span></div>
                        {a.ads.disapproved > 0 && <div className="text-xs text-bad">{a.ads.disapproved} rejected</div>}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">{money(a.activeDailyBudget, a.currency)}</td>
                      <td className="px-2 py-3">{a.dailySpend ? <Sparkline data={a.dailySpend} currency={a.currency} /> : <span className="text-ink-3">—</span>}</td>
                      <td className="max-w-[220px] px-5 py-3 text-xs">
                        {a.syncError ? (
                          <span className="inline-flex items-start gap-1 text-bad" title={a.syncError}><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="line-clamp-2">{a.syncError}</span></span>
                        ) : (
                          <span className="whitespace-nowrap text-ink-3">{timeAgo(a.syncedAt)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="mt-3 text-xs text-ink-3">
            Synced from Meta Insights every 15 minutes (Meta itself can lag up to about 15 minutes). Leads, calls and messages are counted for every campaign whatever its objective; Results follows each campaign’s objective like Ads Manager. Set cost alerts in Settings. Pausing, budgets and new ads come in the next releases.
          </p>
        </>
      ) : null}
    </>
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
  const [period, setPeriod] = useState<Period>('7d');
  const [preview, setPreview] = useState<any | null>(null);
  const [adFilter, setAdFilter] = useState<'running' | 'all'>('running');
  const q = useQuery({ queryKey: ['live', 'account', id, period], queryFn: () => get(`/live/accounts/${id}?period=${period}`), refetchInterval: 60_000 });
  const d = q.data;
  usePageTitle(d?.account.name ?? 'Account');
  const cur = d?.account.currency ?? 'USD';
  const ads: any[] = (d?.ads ?? []).filter((a: any) => adFilter === 'all' || a.effectiveStatus === 'ACTIVE' || a.effectiveStatus === 'DISAPPROVED' || a.effectiveStatus === 'WITH_ISSUES' || a.effectiveStatus === 'PENDING_REVIEW');

  return (
    <>
      <Link to="/" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink"><ArrowLeft className="size-4" /> Dashboard</Link>
      <PageHeader
        title={d?.account.name ?? ' '}
        description={d ? `act_${d.account.accountId} · ${d.account.currency} · ${d.account.timezone ?? 'UTC'} · ${d.range.since === d.range.until ? d.range.since : `${d.range.since} to ${d.range.until}`}` : undefined}
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
          <div className="mb-4"><Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS} /></div>
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
