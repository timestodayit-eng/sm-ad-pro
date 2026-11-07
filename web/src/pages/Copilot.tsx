import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, MessageSquarePlus, Send, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, Modal, PageHeader, Skeleton, cx, timeAgo } from '../components/ui';
import { get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { money } from './Live';

const STARTERS = ['Which account spent the most in the last 7 days?', 'কোন অ্যাকাউন্টে কল সবচেয়ে সস্তা?', 'Any account about to run out of money?', 'Kon campaign e result nai kintu spend hocche?', 'Propose budgets 20, 22, 24 down my order'];

function Proposal({ p, onApplied }: { p: any; onApplied: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const apply = useMutation({
    mutationFn: () => post('/budgets/apply', { confirm: true, items: p.items.map((i: any) => ({ accountRowId: i.accountRowId, adsetId: i.adsetId, dailyBudget: i.next })) }),
    onSuccess: (r: any) => { setResult(r); onApplied(); },
  });
  const currencies = [...new Set(p.items.map((i: any) => i.currency))] as string[];
  return (
    <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><Wallet className="size-4 text-brand" /> Budget proposal{p.reason ? <span className="font-normal text-ink-2"> · {p.reason}</span> : null}</div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-ink-3 uppercase"><th className="py-1">#</th><th>Account</th><th>Ad set</th><th className="text-right">Now</th><th className="text-right">Proposed</th></tr></thead>
        <tbody className="divide-y divide-line">
          {p.items.map((i: any) => <tr key={i.adsetId}><td className="py-1 text-xs text-ink-3">{i.position}</td><td>{i.accountName}</td><td className="max-w-[200px] truncate text-ink-2" title={i.adsetName}>{i.adsetName}</td><td className="text-right tabular-nums">{money(i.current, i.currency)}</td><td className="text-right font-medium tabular-nums">{money(i.next, i.currency)}</td></tr>)}
        </tbody>
      </table>
      {p.notReady?.length > 0 && <p className="mt-2 text-xs text-ink-3">Left out: {p.notReady.map((n: any) => `${n.accountName} (${n.status})`).join(', ')}. Use the Budgets page to pick ad sets by hand.</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-3">Nothing has been changed. {currencies.map((c) => `${money(p.summary?.totals?.find((t: any) => t.currency === c)?.current ?? null, c)} → ${money(p.summary?.totals?.find((t: any) => t.currency === c)?.next ?? null, c)}`).join(' · ')} a day.</span>
        {result ? <Badge tone={result.summary.failed || result.summary.mismatch ? 'warn' : 'good'}>{result.summary.done} changed{result.summary.failed ? `, ${result.summary.failed} failed` : ''}{result.summary.mismatch ? `, ${result.summary.mismatch} mismatch` : ''}</Badge>
          : can('campaigns.manage') ? <Button size="sm" onClick={() => setOpen(true)} disabled={!p.items.length}>Review and apply…</Button> : <span className="text-xs text-ink-3">Your role cannot change budgets.</span>}
      </div>
      {result && <p className="mt-2 text-xs text-ink-2">Details are on the <Link to="/budgets" className="text-brand hover:underline">Budgets page history</Link>.</p>}
      <Modal open={open} onClose={() => setOpen(false)} title="Apply these budgets on Meta?" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Back</Button><Button loading={apply.isPending} onClick={() => apply.mutate(undefined, { onSettled: () => setOpen(false) })}>Yes, change {p.items.length} ad set{p.items.length === 1 ? '' : 's'}</Button></>}>
        <p className="text-sm text-ink-2">The panel writes each ad set's daily budget to Meta one by one, in your account order, and reads it back. This is the same as pressing Apply on the Budgets page.</p>
        {apply.error && <div className="mt-3"><ErrorAlert error={apply.error} /></div>}
      </Modal>
    </div>
  );
}

export function CopilotPage() {
  usePageTitle('AI Ads Copilot');
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: () => get('/ai/status') });
  const list = useQuery({ queryKey: ['ai', 'conversations'], queryFn: () => get('/ai/conversations') });
  const [current, setCurrent] = useState<number | null>(null);
  const conv = useQuery({ queryKey: ['ai', 'conversation', current], queryFn: () => get(`/ai/conversations/${current}`), enabled: current != null });
  const [text, setText] = useState('');
  const [pending, setPending] = useState<any[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const send = useMutation({
    mutationFn: (content: string) => post(`/ai/conversations/${current ?? 'new'}/messages`, { content }),
    onMutate: (content) => setPending((p) => [...p, { role: 'user', content, id: `p${Date.now()}` }]),
    onSuccess: (r: any) => {
      setPending([]);
      setCurrent(r.conversationId);
      qc.invalidateQueries({ queryKey: ['ai', 'conversations'] });
      qc.invalidateQueries({ queryKey: ['ai', 'conversation', r.conversationId] });
    },
    onError: () => setPending([]),
  });
  const messages: any[] = [...(conv.data?.messages ?? []), ...pending];
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length, send.isPending]);
  const name = status.data?.assistantName ?? 'AI Ads Copilot';
  const configured = status.data?.configured;
  const submit = () => { const t = text.trim(); if (!t || send.isPending) return; setText(''); send.mutate(t); };

  return (
    <>
      <PageHeader title={name} description="Ask about your accounts in Bengali, Banglish or English. Every answer comes from the panel's synced Meta data. Budget changes are shown as proposals and need your approval." actions={<Button variant="secondary" icon={<MessageSquarePlus className="size-4" />} onClick={() => { setCurrent(null); setPending([]); }}>New chat</Button>} />
      {status.data && !configured && <div className="mb-4"><Alert tone="warn" title="The assistant is not configured yet">Add OPENAI_API_KEY and OPENAI_MODEL to the hosting settings (never paste keys into the panel or chat), restart the app, then come back. AI Analytics findings work without a key.</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="max-h-[70vh] overflow-y-auto">
          <div className="border-b border-line px-4 py-3 text-xs font-semibold tracking-wide text-ink-3 uppercase">Your chats</div>
          {list.isLoading ? <div className="p-3"><Skeleton className="h-24" /></div> : !list.data?.items?.length ? <p className="p-4 text-sm text-ink-3">No chats yet.</p> : (
            <ul className="divide-y divide-line">
              {list.data.items.map((c: any) => (
                <li key={c.id}><button onClick={() => { setCurrent(c.id); setPending([]); }} className={cx('block w-full px-4 py-2.5 text-left text-sm hover:bg-surface-2', c.id === current && 'bg-surface-2 font-medium')}><div className="truncate text-ink">{c.title}</div><div className="text-xs text-ink-3">{timeAgo(c.updatedAt)}</div></button></li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="flex min-h-[60vh] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {conv.error && <ErrorAlert error={conv.error} />}
            {messages.length === 0 && !send.isPending ? (
              <EmptyState icon={<Bot className="size-6" />} title={`Ask ${name}`}>
                <div className="mt-3 flex flex-wrap justify-center gap-2">{STARTERS.map((s) => <button key={s} onClick={() => { setText(s); }} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:border-brand hover:text-brand">{s}</button>)}</div>
              </EmptyState>
            ) : messages.map((m) => (
              <div key={m.id} className={cx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                {m.proposal ? <div className="w-full max-w-2xl"><Proposal p={m.proposal} onApplied={() => qc.invalidateQueries({ queryKey: ['budgets'] })} /></div>
                  : <div className={cx('max-w-2xl rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap', m.role === 'user' ? 'bg-brand text-white' : 'bg-surface-2 text-ink')}>{m.content}</div>}
              </div>
            ))}
            {send.isPending && <div className="flex justify-start"><div className="rounded-2xl bg-surface-2 px-4 py-2.5 text-sm text-ink-3">Reading your data…</div></div>}
            {send.error && <ErrorAlert error={send.error} />}
            <div ref={bottom} />
          </div>
          <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <textarea className="min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none" rows={2} placeholder={configured === false ? 'Not configured yet' : 'Ask about spend, results, balances, launches… (Enter to send, Shift+Enter for a new line)'} value={text} disabled={configured === false} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} maxLength={4000} />
            <Button type="submit" icon={<Send className="size-4" />} loading={send.isPending} disabled={!text.trim() || configured === false}>Send</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
