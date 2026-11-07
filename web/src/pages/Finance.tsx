import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Download, Plus, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Skeleton, StatCard } from '../components/ui';
import { api, get, post, put } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { GroupPicker, money, num, useGroup } from './Live';
import { DateFilter, usePeriod } from './liveControls';

const KIND: Record<string, string> = { topup: 'Top-up', refund: 'Refund', fee: 'Fee', adjustment: 'Adjustment' };

export function FinancePage() {
  usePageTitle('Finance');
  const { can } = useSession();
  const qc = useQueryClient();
  const { group, set: setGroup, qs: gq } = useGroup();
  const { period, set: setPeriod, qs: pq } = usePeriod('this_month');
  const q = useQuery({ queryKey: ['finance', pq, group], queryFn: () => get(`/finance?${pq}${gq}`), placeholderData: keepPreviousData });
  const [entryOpen, setEntryOpen] = useState(false);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [entry, setEntry] = useState({ accountRowId: '', kind: 'topup', amount: '', onDate: new Date().toISOString().slice(0, 10), note: '' });
  const [rate, setRate] = useState({ currency: 'USD', rateToBdt: '', asOf: new Date().toISOString().slice(0, 10), note: '' });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['finance'] });
  const addEntry = useMutation({ mutationFn: () => post('/finance/entries', { ...entry, accountRowId: Number(entry.accountRowId), amount: Number(entry.amount) }), onSuccess: () => { setEntryOpen(false); setEntry({ ...entry, amount: '', note: '' }); invalidate(); } });
  const delEntry = useMutation({ mutationFn: (id: number) => api(`/finance/entries/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  const saveRate = useMutation({ mutationFn: () => put('/finance/rates', { ...rate, currency: rate.currency.toUpperCase(), rateToBdt: Number(rate.rateToBdt) }), onSuccess: () => { setRate({ ...rate, rateToBdt: '' }); invalidate(); } });
  const delRate = useMutation({ mutationFn: (c: string) => api(`/finance/rates/${c}`, { method: 'DELETE' }), onSuccess: invalidate });
  const d = q.data;
  const manage = can('reports.manage');
  return (
    <>
      <PageHeader title="Finance" description="Spend by account, currency and period from synced Meta data; money left as Meta reports it; top-ups you log by hand (Meta does not report payments). Totals in BDT only at a rate you typed in, shown with its date." actions={<a href={`/api/finance/export.csv?${pq}${gq}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-surface-2"><Download className="size-4" /> Export CSV</a>} />
      {q.error && <ErrorAlert error={q.error} />}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3"><GroupPicker group={group} onChange={setGroup} /><DateFilter period={period} onChange={setPeriod} /></div>
        <div className="flex items-center gap-2">
          {manage && <Button variant="secondary" icon={<Coins className="size-4" />} onClick={() => setRatesOpen(true)}>Exchange rates</Button>}
          {manage && <Button icon={<Plus className="size-4" />} onClick={() => setEntryOpen(true)}>Log a top-up</Button>}
        </div>
      </div>
      {q.isLoading || !d ? <Skeleton className="h-64 rounded-2xl" /> : d.accounts.length === 0 ? (
        <Card><EmptyState icon={<Wallet className="size-6" />} title="No working accounts">Choose working accounts in Settings first.</EmptyState></Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {d.totals.map((t: any) => <StatCard key={t.currency} label={`Spend · ${t.currency}`} value={money(t.spend, t.currency)} sub={`${t.accounts} account${t.accounts === 1 ? '' : 's'}${t.topups ? ` · top-ups ${money(t.topups, t.currency)}` : ''}${t.remaining != null ? ` · left ${money(t.remaining, t.currency)}` : ''}`} />)}
            <StatCard label="Spend in BDT" value={d.bdt ? money(d.bdt.spend, "BDT") : "—"} sub={d.bdt ? `At your rate${d.bdt.ratesAsOf.length ? ` of ${d.bdt.ratesAsOf.join(', ')}` : ''}` : `No rate for ${d.missingRates.join(', ')} yet`} />
          </div>
          {d.missingRates.length > 0 && <div className="mb-4"><Alert tone="info" title="BDT totals need a rate">{manage ? `Press Exchange rates and type today’s rate for ${d.missingRates.join(', ')}. The panel never guesses a rate.` : `Ask an admin to set the ${d.missingRates.join(', ')} rate.`}</Alert></div>}
          <Card className="mb-4">
            <CardHeader title="By account" description="In your account order." />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead><tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase"><th className="w-8 py-2 pl-5 text-right">#</th><th className="px-3 py-2">Account</th><th className="px-2 py-2 text-right">Spend</th><th className="px-2 py-2 text-right">Results</th><th className="px-2 py-2 text-right">Cost / result</th><th className="px-2 py-2 text-right">Top-ups</th><th className="px-2 py-2 text-right">Money left</th><th className="px-2 py-2 text-right">Days left</th><th className="px-5 py-2 text-right">Spend in BDT</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {d.accounts.map((a: any) => (
                    <tr key={a.id} className="hover:bg-surface-2">
                      <td className="py-2 pl-5 text-right text-xs text-ink-3 tabular-nums">{a.position}</td>
                      <td className="px-3 py-2"><div className="font-medium text-ink">{a.name}</div><div className="text-xs text-ink-3">act_{a.accountId} · {a.currency}</div></td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">{money(a.spend, a.currency)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{num(a.results)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{a.costPerResult == null ? '—' : money(a.costPerResult, a.currency)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{a.topups ? money(a.topups, a.currency) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{a.remaining == null ? <span className="text-xs text-ink-3">{a.kind === 'postpaid' ? 'billed later' : 'not shown by Meta'}</span> : money(a.remaining, a.currency)}</td>
                      <td className="px-2 py-2 text-right">{a.daysLeft == null ? '—' : <Badge tone={a.daysLeft < 1 ? 'bad' : a.daysLeft < 3 ? 'warn' : 'good'}>{a.daysLeft < 1 ? '< 1' : a.daysLeft}</Badge>}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{a.spendBdt == null ? '—' : money(a.spendBdt, 'BDT')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Last 6 months" description="Spend per month, by currency, all accounts in this view." />
              {d.months.length === 0 ? <p className="p-5 text-sm text-ink-3">No synced spend yet.</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase"><th className="px-5 py-2">Month</th>{d.totals.map((t: any) => <th key={t.currency} className="px-5 py-2 text-right">{t.currency}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">{d.months.map((m: any) => <tr key={m.month}><td className="px-5 py-2 text-ink">{m.month}</td>{m.byCurrency.map((c: any) => <td key={c.currency} className="px-5 py-2 text-right tabular-nums">{money(c.spend, c.currency)}</td>)}</tr>)}</tbody>
                </table>
              )}
            </Card>
            <Card>
              <CardHeader title="Top-ups and entries" description="Logged by your team. Not read from Meta." />
              {d.entries.length === 0 ? <p className="p-5 text-sm text-ink-3">Nothing logged yet.{manage ? ' Press Log a top-up when you add money to an account.' : ''}</p> : (
                <ul className="divide-y divide-line">
                  {d.entries.slice(0, 30).map((e: any) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                      <div><span className="font-medium text-ink">{e.account}</span> <Badge tone={e.kind === 'topup' ? 'good' : 'neutral'}>{KIND[e.kind]}</Badge><div className="text-xs text-ink-3">{e.onDate}{e.note ? ` · ${e.note}` : ''}{e.by ? ` · ${e.by}` : ''}</div></div>
                      <div className="flex items-center gap-2"><span className="font-medium tabular-nums">{money(e.amount, e.currency)}</span>{manage && <button className="text-ink-3 hover:text-bad" aria-label="Delete entry" onClick={() => delEntry.mutate(e.id)}><Trash2 className="size-4" /></button>}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
      <Modal open={entryOpen} onClose={() => setEntryOpen(false)} title="Log a top-up or entry" footer={<><Button variant="ghost" onClick={() => setEntryOpen(false)}>Cancel</Button><Button loading={addEntry.isPending} disabled={!entry.accountRowId || !entry.amount} onClick={() => addEntry.mutate()}>Save</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Account"><Select value={entry.accountRowId} onChange={(e) => setEntry({ ...entry, accountRowId: e.target.value })}><option value="">Choose…</option>{(d?.accounts ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}</Select></Field>
          <Field label="Kind"><Select value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Amount" hint="In the account’s currency."><Input inputMode="decimal" value={entry.amount} onChange={(e) => setEntry({ ...entry, amount: e.target.value })} /></Field>
          <Field label="Date"><Input type="date" value={entry.onDate} onChange={(e) => setEntry({ ...entry, onDate: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Note" hint="Optional, e.g. card ending 1234."><Input value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} maxLength={255} /></Field></div>
        </div>
        {addEntry.error && <div className="mt-3"><ErrorAlert error={addEntry.error} /></div>}
      </Modal>
      <Modal open={ratesOpen} onClose={() => setRatesOpen(false)} title="Exchange rates to BDT" footer={<Button onClick={() => setRatesOpen(false)}>Done</Button>}>
        <p className="mb-3 text-sm text-ink-3">One rate per currency, with the date you took it. The panel shows this date next to every BDT total.</p>
        {(d?.rates ?? []).length > 0 && (
          <ul className="mb-4 divide-y divide-line rounded-lg border border-line">
            {d.rates.map((r: any) => <li key={r.currency} className="flex items-center justify-between px-3 py-2 text-sm"><span className="text-ink">1 {r.currency} = {r.rateToBdt} BDT <span className="text-xs text-ink-3">as of {r.asOf}{r.note ? ` · ${r.note}` : ''}</span></span><button className="text-ink-3 hover:text-bad" aria-label={`Delete ${r.currency} rate`} onClick={() => delRate.mutate(r.currency)}><Trash2 className="size-4" /></button></li>)}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Currency"><Input value={rate.currency} onChange={(e) => setRate({ ...rate, currency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
          <Field label="1 unit = BDT"><Input inputMode="decimal" value={rate.rateToBdt} onChange={(e) => setRate({ ...rate, rateToBdt: e.target.value })} /></Field>
          <Field label="As of"><Input type="date" value={rate.asOf} onChange={(e) => setRate({ ...rate, asOf: e.target.value })} /></Field>
          <div className="flex items-end"><Button loading={saveRate.isPending} disabled={!/^[A-Z]{3}$/.test(rate.currency) || !Number(rate.rateToBdt)} onClick={() => saveRate.mutate()}>Set rate</Button></div>
        </div>
        <div className="mt-3"><Field label="Note" hint="Where the rate came from, e.g. bank rate."><Input value={rate.note} onChange={(e) => setRate({ ...rate, note: e.target.value })} maxLength={255} /></Field></div>
        {saveRate.error && <div className="mt-3"><ErrorAlert error={saveRate.error} /></div>}
      </Modal>
    </>
  );
}
