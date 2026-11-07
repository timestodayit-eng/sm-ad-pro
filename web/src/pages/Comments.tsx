import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, Eye, MessageSquare, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, PageHeader, Select, Skeleton, cx, timeAgo } from '../components/ui';
import { get, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';

const textareaCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none';

function CommentRow({ c, post: p, page, aiOn }: { c: any; post: any; page: any; aiOn: boolean }) {
  const { can } = useSession();
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['comments', page.id] });
  const suggest = useMutation({ mutationFn: () => post('/comments/suggest', { comment: c.message, post: p.message, pageName: page.name, language: lang }), onSuccess: (r: any) => { if (r.text && !r.suggestHide) setText(r.text); } });
  const reply = useMutation({ mutationFn: () => post('/comments/reply', { pageId: page.id, commentId: c.id, message: text.trim() }), onSuccess: () => { setText(''); setOpen(false); refresh(); } });
  const hide = useMutation({ mutationFn: (hidden: boolean) => post('/comments/hide', { pageId: page.id, commentId: c.id, hidden }), onSuccess: refresh });
  const canAct = can('campaigns.manage');
  const replied = c.handled.some((h: any) => h.action === 'reply');
  return (
    <li className={cx('px-5 py-3', c.hidden && 'opacity-60')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm"><span className="font-medium text-ink">{c.from}</span> <span className="text-xs text-ink-3">{timeAgo(c.createdAt)}</span> {c.hidden && <Badge tone="neutral">hidden</Badge>} {replied && <Badge tone="good">replied</Badge>}</div>
          <p className="mt-0.5 text-sm whitespace-pre-wrap text-ink-2">{c.message || <i>(no text)</i>}</p>
        </div>
        {canAct && (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" disabled={!c.canReply} onClick={() => setOpen((o) => !o)}>Reply</Button>
            <Button size="sm" variant="ghost" icon={c.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />} disabled={!c.canHide} loading={hide.isPending} onClick={() => hide.mutate(!c.hidden)}>{c.hidden ? 'Unhide' : 'Hide'}</Button>
          </div>
        )}
      </div>
      {hide.error && <div className="mt-2"><ErrorAlert error={hide.error} /></div>}
      {open && (
        <div className="mt-2 rounded-lg border border-line bg-surface-2 p-3">
          <textarea className={textareaCls} rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Write a reply…" aria-label={`Reply to ${c.from}`} />
          {suggest.data?.suggestHide && <p className="mt-1 text-xs text-warn">The assistant thinks this is spam or abuse and suggests hiding it instead of replying.</p>}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" />} loading={suggest.isPending} disabled={!aiOn} title={aiOn ? undefined : 'Set OPENAI_API_KEY to enable'} onClick={() => suggest.mutate()}>Draft with the assistant</Button>
            <div className="flex items-center gap-2"><span className="text-xs text-ink-3">Nothing is sent until you press Send.</span><Button size="sm" icon={<Send className="size-4" />} loading={reply.isPending} disabled={!text.trim()} onClick={() => reply.mutate()}>Send reply</Button></div>
          </div>
          {(reply.error || suggest.error) && <div className="mt-2"><ErrorAlert error={reply.error ?? suggest.error} /></div>}
        </div>
      )}
    </li>
  );
}

export function CommentsPage() {
  usePageTitle('Comments');
  const pages = useQuery({ queryKey: ['comments', 'pages'], queryFn: () => get('/comments/pages') });
  const [pageId, setPageId] = useState('');
  const current = pageId || pages.data?.items?.[0]?.id || '';
  const q = useQuery({ queryKey: ['comments', current], queryFn: () => get(`/comments/pages/${current}`), enabled: Boolean(current), refetchInterval: 120_000 });
  const items: any[] = pages.data?.items ?? [];
  const page = items.find((p) => p.id === current);
  const d = q.data;
  return (
    <>
      <PageHeader title="Comments" description="Comments on your Pages’ recent posts, ads included, read live from Meta. Reply or hide where your Page role allows. The assistant can draft a reply; nothing is sent until you press Send." actions={items.length > 1 ? <Select className="w-64" value={current} onChange={(e) => setPageId(e.target.value)} aria-label="Page">{items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select> : undefined} />
      {pages.error && <ErrorAlert error={pages.error} />}
      {q.error && <ErrorAlert error={q.error} />}
      {page?.missingScopes?.length > 0 && <div className="mb-4"><Alert tone="warn" title="Reconnect Meta to answer comments">The Meta login was connected without {page.missingScopes.join(' and ')}. Reconnect Meta from Ad Accounts (the panel now asks for these permissions), then come back.</Alert></div>}
      {d?.warning && <div className="mb-4"><Alert tone="warn" title={d.warning} /></div>}
      {pages.isLoading ? <Skeleton className="h-64 rounded-2xl" /> : items.length === 0 ? (
        <Card><EmptyState icon={<MessageSquare className="size-6" />} title="No Facebook Pages imported">Pages come from your Meta login. Reconnect Meta under Ad Accounts with the Pages permissions.</EmptyState></Card>
      ) : q.isLoading || !d ? <Skeleton className="h-64 rounded-2xl" /> : d.posts.length === 0 ? (
        <Card><EmptyState icon={<MessageSquare className="size-6" />} title="No posts found">Meta returned no recent posts for {page?.name}.</EmptyState></Card>
      ) : d.posts.map((p: any) => (
        <Card key={p.id} className="mb-4">
          <CardHeader title={<span className="line-clamp-2 text-sm font-medium">{p.message || '(post without text)'}</span>} description={<>{timeAgo(p.createdAt)} · {p.comments.length} comment{p.comments.length === 1 ? '' : 's'}{p.url ? <> · <a href={p.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">Open on Facebook</a></> : null}</>} />
          {p.comments.length === 0 ? <p className="px-5 py-3 text-sm text-ink-3">No comments yet.</p> : <ul className="divide-y divide-line">{p.comments.map((c: any) => <CommentRow key={c.id} c={c} post={p} page={d.page} aiOn={Boolean(pages.data?.aiConfigured)} />)}</ul>}
        </Card>
      ))}
      {(pages.data?.actions ?? []).length > 0 && (
        <Card>
          <CardHeader title="What the panel did" description="Replies and hides made from here." />
          <ul className="divide-y divide-line">{pages.data.actions.slice(0, 20).map((a: any) => <li key={a.id} className="px-5 py-2 text-sm"><Badge tone={a.action === 'reply' ? 'good' : 'neutral'}>{a.action}</Badge> <span className="text-ink-2">{a.page}</span>{a.text ? <span className="text-ink"> · “{a.text}”</span> : null} <span className="text-xs text-ink-3">· {a.by ?? ''} · {timeAgo(a.at)}</span></li>)}</ul>
        </Card>
      )}
    </>
  );
}
