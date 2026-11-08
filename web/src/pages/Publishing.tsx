import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Loader2, Rocket, XCircle, Clock, Ban } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, PageHeader, Skeleton, cx, formatDateTime, timeAgo } from '../components/ui';
import { get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { money } from './Live';

const STAGES = ['video', 'processing', 'campaign', 'adset', 'creative', 'ad', 'check', 'done'];

function StatusBadge({ s }: { s: string }) {
  if (s === 'done') return <Badge tone="good">Created (paused)</Badge>;
  if (s === 'working') return <Badge tone="brand"><Loader2 className="mr-1 inline size-3 animate-spin" />Working</Badge>;
  if (s === 'queued') return <Badge tone="neutral"><Clock className="mr-1 inline size-3" />Waiting</Badge>;
  if (s === 'cancelled') return <Badge tone="neutral"><Ban className="mr-1 inline size-3" />Cancelled</Badge>;
  if (s === 'needs_review') return <Badge tone="warn">Needs a look</Badge>;
  return <Badge tone="bad"><XCircle className="mr-1 inline size-3" />Failed</Badge>;
}

function Stages({ stage, status }: { stage: string; status: string }) {
  const at = STAGES.indexOf(stage);
  return (
    <div className="flex items-center gap-1" title={`Step ${Math.min(at + 1, 7)} of 7`}>
      {STAGES.slice(0, 7).map((s, i) => (
        <span key={s} className={cx('h-1.5 w-4 rounded-full', i < at || status === 'done' ? 'bg-good' : i === at && status === 'working' ? 'bg-brand' : i === at && (status === 'failed' || status === 'needs_review') ? 'bg-bad' : 'bg-line')} />
      ))}
    </div>
  );
}

function LaunchDetail({ id }: { id: number }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['launches', id], queryFn: () => get(`/launches/${id}`), refetchInterval: (query) => (query.state.data?.items?.some((i: any) => i.status === 'queued' || i.status === 'working') ? 4000 : false) });
  const act = useMutation({
    mutationFn: ({ itemId, what }: { itemId: number; what: 'retry' | 'cancel' }) => post(`/launches/${id}/items/${itemId}/${what}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['launches'] }),
  });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const items: any[] = d.items;
  const pending = items.filter((i) => i.status === 'queued' || i.status === 'working').length;
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed' || i.status === 'needs_review').length;
  return (
    <Card className="mb-4">
      <CardHeader
        title={d.name}
        description={<>{d.goal === 'call' ? 'Call ads' : 'Website ads'} · started {formatDateTime(d.createdAt)}{d.by ? ` by ${d.by}` : ''} · {done} of {items.length} created{pending ? `, ${pending} in progress` : ''}{failed ? `, ${failed} stopped` : ''}</>}
        actions={<Link to="/publishing" className="text-sm font-medium text-brand hover:underline">All launches</Link>}
      />
      {pending > 0 && <div className="px-5 pt-4"><Alert tone="info" title="Creating on Meta in the background">Each account goes through 7 steps: upload the video, wait for Meta to process it, create the campaign, the ad set, the creative, the ad, then check it. This page refreshes itself.</Alert></div>}
      {done === items.length && items.length > 0 && <div className="px-5 pt-4"><Alert tone="good" title="All ads are created and paused">Review them in Ads Manager and switch them on there when you are ready.</Alert></div>}
      {act.error && <div className="px-5 pt-4"><ErrorAlert error={act.error} /></div>}
      <div className="overflow-x-auto p-5">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
              <th className="w-8 py-2 text-right">#</th><th className="px-3 py-2">Account</th><th className="px-2 py-2 text-right">Budget</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Step</th><th className="px-2 py-2">Meta IDs</th><th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((i) => (
              <tr key={i.id} className={cx(i.status === 'failed' || i.status === 'needs_review' ? 'bg-bad-bg/30' : '')}>
                <td className="py-3 text-right text-xs text-ink-3 tabular-nums">{i.position}</td>
                <td className="px-3 py-3"><div className="font-medium text-ink">{i.accountName}</div><div className="text-xs text-ink-3">act_{i.accountId} · Page {i.pageId}</div></td>
                <td className="px-2 py-3 text-right tabular-nums">{money(i.budget, i.currency)}<div className="text-xs text-ink-3">{i.budgetKind === 'daily' ? 'a day' : 'lifetime'}</div></td>
                <td className="px-2 py-3"><StatusBadge s={i.status} />{i.adStatus && i.status === 'done' && <div className="mt-0.5 text-xs text-ink-3">Meta says: {i.adStatus.toLowerCase()}</div>}</td>
                <td className="px-2 py-3">
                  <Stages stage={i.stage} status={i.status} />
                  <div className="mt-1 text-xs text-ink-3">{i.status === 'done' ? `finished ${timeAgo(i.updatedAt)}` : i.stageLabel}</div>
                  {i.error && <div className="mt-1 max-w-[320px] text-xs text-bad">{i.error.message}{i.error.hint && <span className="text-ink-3"> {i.error.hint}</span>}</div>}
                  {i.warning && <div className="mt-1 max-w-[320px] text-xs text-warn">{i.warning}</div>}
                </td>
                <td className="px-2 py-3 text-xs text-ink-3 tabular-nums">
                  {i.campaignId ? <div>Campaign {i.campaignId}</div> : null}
                  {i.adsetId ? <div>Ad set {i.adsetId}</div> : null}
                  {i.ads && i.ads.length > 1 ? i.ads.filter((a: any) => a.adId).map((a: any) => <div key={a.position}>Ad {a.position}: {a.adId}</div>) : i.adId ? <div>Ad {i.adId}</div> : null}
                  {!i.campaignId && !i.videoId ? '—' : null}
                  {i.videoId && !i.campaignId ? <div>Video {i.videoId}</div> : null}
                </td>
                <td className="px-2 py-3 text-right whitespace-nowrap">
                  {i.campaignId && (
                    <a href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${i.accountId}&selected_campaign_ids=${i.campaignId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                      Ads Manager <ExternalLink className="size-3" />
                    </a>
                  )}
                  {can('campaigns.publish') && (i.status === 'failed' || i.status === 'needs_review') && (
                    <div className="mt-1 flex justify-end gap-1">
                      <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => act.mutate({ itemId: i.id, what: 'retry' })}>Retry</Button>
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ itemId: i.id, what: 'cancel' })}>Cancel</Button>
                    </div>
                  )}
                  {can('campaigns.publish') && i.status === 'queued' && <div className="mt-1"><Button size="sm" variant="ghost" onClick={() => act.mutate({ itemId: i.id, what: 'cancel' })}>Cancel</Button></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-5 py-3 text-xs text-ink-3">Retry checks Meta for anything an earlier attempt already created before creating more, so a retry never makes a duplicate. Cancel only stops rows that have not started.</div>
    </Card>
  );
}

export function PublishingPage() {
  usePageTitle('Publishing');
  const [params] = useSearchParams();
  const launchId = Number(params.get('launch')) || null;
  const list = useQuery({ queryKey: ['launches'], queryFn: () => get('/launches'), refetchInterval: 15_000 });
  const items: any[] = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="Publishing" description="Every Easy Ads launch, with live progress per account and the real IDs Meta returned." actions={<Link to="/easy-ads"><Button icon={<Rocket className="size-4" />}>New launch</Button></Link>} />
      {launchId && <LaunchDetail id={launchId} />}
      {list.error && <ErrorAlert error={list.error} />}
      <Card>
        <CardHeader title="Launches" />
        {list.isLoading ? (
          <div className="p-5"><Skeleton className="h-40" /></div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Rocket className="size-6" />} title="No launches yet" action={<Link to="/easy-ads" className="text-sm font-medium text-brand hover:underline">Create ads with Easy Ads</Link>}>Launches you create show here with their progress.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                <th className="px-5 py-3">Launch</th><th className="px-2 py-3">Goal</th><th className="px-2 py-3 text-right">Accounts</th><th className="px-2 py-3">Progress</th><th className="px-5 py-3">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((l) => (
                <tr key={l.id} className={cx('hover:bg-surface-2', l.id === launchId && 'bg-surface-2')}>
                  <td className="px-5 py-3"><Link to={`/publishing?launch=${l.id}`} className="font-medium text-ink hover:text-brand hover:underline">{l.name}</Link>{l.by && <div className="text-xs text-ink-3">by {l.by}</div>}</td>
                  <td className="px-2 py-3">{l.goal === 'call' ? 'Calls' : 'Website'}</td>
                  <td className="px-2 py-3 text-right tabular-nums">{l.items}</td>
                  <td className="px-2 py-3">
                    <span className="inline-flex items-center gap-1 text-good"><CheckCircle2 className="size-3.5" />{l.done}</span>
                    {l.pending > 0 && <span className="ml-3 inline-flex items-center gap-1 text-brand"><Loader2 className="size-3.5 animate-spin" />{l.pending}</span>}
                    {l.failed > 0 && <span className="ml-3 inline-flex items-center gap-1 text-bad"><XCircle className="size-3.5" />{l.failed}</span>}
                  </td>
                  <td className="px-5 py-3 text-ink-3">{formatDateTime(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
