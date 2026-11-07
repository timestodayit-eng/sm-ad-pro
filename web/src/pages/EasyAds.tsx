import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Phone, Rocket, Sparkles, Upload, Globe } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Segmented, Select, Skeleton, cx } from '../components/ui';
import { get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { money } from './Live';

type Row = { accountRowId: number; pageId?: string; dailyBudget?: number; mediaAssetId?: number; caption?: string; title?: string; link?: string; ageMin?: number; ageMax?: number };

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

const textareaCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none';
const COUNTRY_HINT = 'Two-letter codes, separated by commas, for example US or US, CA.';

function Section({ n, title, children, description }: { n: number; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-4">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand/15 text-sm font-semibold text-brand">{n}</span>
        <div>
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

export function EasyAdsPage() {
  usePageTitle('Easy Ads');
  const { can } = useSession();
  const navigate = useNavigate();
  const setup = useQuery({ queryKey: ['launch', 'setup'], queryFn: () => get('/launch/setup') });
  const accounts: any[] = setup.data?.accounts ?? [];
  const pages: any[] = setup.data?.pages ?? [];
  const videos: any[] = setup.data?.videos ?? [];

  const [name, setName] = useState('');
  const [pageId, setPageId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [selected, setSelected] = useState<Record<number, Row>>({});
  const [mediaAssetId, setMediaAssetId] = useState<number | ''>('');
  const [goal, setGoal] = useState<'call' | 'website'>('call');
  const [optimize, setOptimize] = useState('calls');
  const [link, setLink] = useState('');
  const [cta, setCta] = useState('LEARN_MORE');
  const [caption, setCaption] = useState('');
  const [title, setTitle] = useState('');
  const [countries, setCountries] = useState('US');
  const [ageMin, setAgeMin] = useState('18');
  const [ageMax, setAgeMax] = useState('65');
  const [genders, setGenders] = useState<'all' | 'male' | 'female'>('all');
  const [advantage, setAdvantage] = useState(false);
  const [special, setSpecial] = useState<'NONE' | 'EMPLOYMENT'>('NONE');
  const [paidBy, setPaidBy] = useState('');
  const [kind, setKind] = useState<'lifetime' | 'daily'>('lifetime');
  const [startDate, setStartDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10));
  const [hoursOn, setHoursOn] = useState(true);
  const [from, setFrom] = useState('07:00');
  const [to, setTo] = useState('22:00');
  const [placements, setPlacements] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'stepped' | 'same' | 'each'>('stepped');
  const [start, setStart] = useState('20');
  const [step, setStep] = useState('2');
  const [sheetErrors, setSheetErrors] = useState<string[]>([]);
  const [sheetNote, setSheetNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOptimize(goal === 'call' ? 'calls' : 'clicks');
  }, [goal]);

  const rows = useMemo(() => accounts.filter((a) => selected[a.id]).map((a) => selected[a.id]), [accounts, selected]);
  const countryList = countries.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  const body = {
    name: name.trim() || 'Untitled launch', goal, optimize, pageId: pageId || undefined, mediaAssetId: mediaAssetId || undefined, caption, title, link, cta,
    countries: countryList.filter((c) => /^[A-Z]{2}$/.test(c)), ageMin: Number(ageMin) || 18, ageMax: Number(ageMax) || 65, genders,
    advantageAudience: advantage, specialCategory: special, paidBy,
    budget: { kind, mode, start: Number(start) || 0, step: Number(step) || 0 },
    startDate: startDate || undefined, endDate: endDate || undefined,
    hours: hoursOn && kind === 'lifetime' ? { from, to } : undefined,
    placements: placements ?? setup.data?.defaultPlacements ?? [],
    rows,
  };
  const debounced = useDebounced(body);
  const plan = useQuery({
    queryKey: ['launch', 'plan', debounced],
    queryFn: () => post('/launch/plan', debounced),
    enabled: debounced.rows.length > 0 && debounced.countries.length > 0 && debounced.placements.length > 0,
    placeholderData: keepPreviousData,
  });
  const launch = useMutation({
    mutationFn: () => post('/launches', { ...body, name: name.trim(), confirm: true }),
    onSuccess: (r: any) => navigate(`/publishing?launch=${r.id}`),
  });

  const toggle = (a: any, on: boolean) =>
    setSelected((s) => {
      const n = { ...s };
      if (on) n[a.id] = n[a.id] ?? { accountRowId: a.id };
      else delete n[a.id];
      return n;
    });
  const patch = (id: number, p: Partial<Row>) => setSelected((s) => ({ ...s, [id]: { ...(s[id] ?? { accountRowId: id }), ...p } }));

  async function onSheet(file: File) {
    setSheetErrors([]);
    setSheetNote(null);
    try {
      const csv = await file.text();
      const r: any = await post('/launch/sheet', { csv });
      setSheetErrors(r.errors ?? []);
      if (r.rows?.length) {
        const next: Record<number, Row> = {};
        for (const row of r.rows) next[row.accountRowId] = row;
        setSelected(next);
        if (r.rows.some((x: Row) => x.dailyBudget != null) && r.rows.every((x: Row) => x.dailyBudget != null)) setMode('each');
        setSheetNote(`${r.rows.length} account${r.rows.length === 1 ? '' : 's'} read from ${file.name}. Empty cells use the values on this page.`);
      }
    } catch (e: any) {
      setSheetErrors([e?.message ?? 'The file could not be read.']);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const p = plan.data;
  const issues = (p?.rows ?? []).reduce((n: number, r: any) => n + r.issues.length, 0) + (p?.problems?.length ?? 0);
  const canLaunch = can('campaigns.publish');
  const ready = Boolean(p?.ready) && name.trim() !== '' && !plan.isFetching;
  const optimizeOptions: any[] = setup.data?.goals?.[goal] ?? [];

  if (setup.isLoading) return <Skeleton className="h-96 rounded-2xl" />;

  return (
    <>
      <PageHeader
        title="Easy Ads"
        description="Send one video ad to the accounts you choose, in your account order. Each account gets its own campaign, ad set and ad, all created PAUSED on Meta. Nothing goes live until you switch it on."
        actions={<Link to="/publishing" className="text-sm font-medium text-brand hover:underline">Launch history →</Link>}
      />
      {setup.error && <ErrorAlert error={setup.error} />}
      {accounts.length === 0 ? (
        <Card><EmptyState icon={<Sparkles className="size-6" />} title="No working accounts" action={<Link to="/settings#working-accounts" className="text-sm font-medium text-brand hover:underline">Choose working accounts</Link>}>Easy Ads launches to your working accounts.</EmptyState></Card>
      ) : (
        <>
          <Section n={1} title="Accounts, Page, budget and age" description="Tick the accounts, or pick a group. They run in your account order. One Facebook Page runs the ads in every account. The same video, caption and headline go to every account; only the budget and the age range can differ here.">
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <Field label="Facebook Page" hint={pages.length ? 'Used by every account in this launch.' : undefined}>
                <Select value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label="Facebook Page">
                  <option value="">Choose a Page…</option>
                  {pages.map((pg) => <option key={pg.id} value={pg.id}>{pg.name}{pg.canAdvertise ? '' : ' (no advertise access)'}</option>)}
                </Select>
              </Field>
              <Field label="Account group" hint="Ticks the group’s working accounts.">
                <Select value={groupId} onChange={(e) => { const g = (setup.data?.groups ?? []).find((x: any) => String(x.id) === e.target.value); setGroupId(e.target.value); if (g) setSelected(Object.fromEntries(g.accountIds.map((id: number) => [id, selected[id] ?? { accountRowId: id }]))); }} aria-label="Account group">
                  <option value="">Pick accounts below…</option>
                  {(setup.data?.groups ?? []).map((g: any) => <option key={g.id} value={g.id}>{g.name} ({g.accountIds.length})</option>)}
                </Select>
              </Field>
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => { setGroupId(''); setSelected(Object.fromEntries(accounts.map((a) => [a.id, selected[a.id] ?? { accountRowId: a.id }]))); }}>Select all</Button>
              <Button size="sm" variant="ghost" onClick={() => { setGroupId(''); setSelected({}); }}>Clear</Button>
              <span className="mx-1 h-5 w-px bg-line" />
              <a href="/api/launch/sheet-template.csv" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-brand hover:bg-surface-2">
                <Download className="size-4" /> Download sheet template
              </a>
              <Button size="sm" variant="secondary" icon={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>Upload sheet (CSV)</Button>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onSheet(e.target.files[0])} />
            </div>
            {sheetNote && <div className="mb-3"><Alert tone="good" title={sheetNote} /></div>}
            {sheetErrors.length > 0 && (
              <div className="mb-3">
                <Alert tone="warn" title="Some lines in the sheet were not used">
                  <ul className="list-disc pl-5">{sheetErrors.slice(0, 12).map((e) => <li key={e}>{e}</li>)}</ul>
                </Alert>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                    <th className="w-10 py-2" />
                    <th className="w-8 py-2 text-right">#</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-2 py-2 text-right">{kind === 'lifetime' ? 'Lifetime budget' : 'Daily budget'}{mode !== 'each' && <span className="font-normal normal-case"> (optional)</span>}</th>
                    <th className="px-2 py-2">Age range <span className="font-normal normal-case">(optional)</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {accounts.map((a) => {
                    const row = selected[a.id];
                    return (
                      <tr key={a.id} className={cx(row ? '' : 'opacity-60')}>
                        <td className="py-2"><input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={Boolean(row)} onChange={(e) => toggle(a, e.target.checked)} aria-label={`Include ${a.name}`} /></td>
                        <td className="py-2 text-right text-xs text-ink-3 tabular-nums">{a.position}</td>
                        <td className="px-3 py-2"><div className="font-medium text-ink">{a.name}</div><div className="text-xs text-ink-3">act_{a.accountId} · {a.currency}{row?.pageId && row.pageId !== pageId ? ` · Page ${pages.find((pg) => pg.id === row.pageId)?.name ?? row.pageId} (from the sheet)` : ''}</div></td>
                        <td className="px-2 py-2 text-right">
                          <Input className="ml-auto h-9 w-28 text-right" inputMode="decimal" placeholder={mode === 'each' ? 'Amount' : 'auto'} disabled={!row} value={row?.dailyBudget ?? ''}
                            onChange={(e) => patch(a.id, { dailyBudget: e.target.value === '' ? undefined : Number(e.target.value) })} aria-label={`Budget for ${a.name}`} />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            <Input className="h-9 w-16 text-right" inputMode="numeric" placeholder={ageMin} disabled={!row || special === 'EMPLOYMENT'} value={row?.ageMin ?? ''}
                              onChange={(e) => patch(a.id, { ageMin: e.target.value === '' ? undefined : Number(e.target.value) })} aria-label={`Minimum age for ${a.name}`} />
                            <span className="text-xs text-ink-3">to</span>
                            <Input className="h-9 w-16 text-right" inputMode="numeric" placeholder={ageMax} disabled={!row || special === 'EMPLOYMENT'} value={row?.ageMax ?? ''}
                              onChange={(e) => patch(a.id, { ageMax: e.target.value === '' ? undefined : Number(e.target.value) })} aria-label={`Maximum age for ${a.name}`} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pages.length === 0 && <div className="mt-3"><Alert tone="warn" title="No Facebook Pages imported">Pages come from your Meta login. Reconnect Meta under Ad Accounts, with the Pages permission, then refresh.</Alert></div>}
          </Section>

          <Section n={2} title="Video" description="From your media library. It is uploaded to each account once and reused next time.">
            {videos.length === 0 ? (
              <Alert tone="info" title="No videos in the media library yet" action={<Link to="/media" className="text-sm font-medium text-brand hover:underline">Upload a video</Link>} />
            ) : (
              <Select className="max-w-md" value={mediaAssetId} onChange={(e) => setMediaAssetId(e.target.value ? Number(e.target.value) : '')} aria-label="Video">
                <option value="">Choose a video…</option>
                {videos.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            )}
          </Section>

          <Section n={3} title="Goal and ad text">
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="What should people do?">
                <Segmented label="Goal" value={goal} onChange={setGoal} options={[{ value: 'call', label: 'Call', icon: <Phone className="size-4" /> }, { value: 'website', label: 'Visit website', icon: <Globe className="size-4" /> }]} />
              </Field>
              <Field label="Meta optimizes for">
                <Select value={optimize} onChange={(e) => setOptimize(e.target.value)}>{optimizeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
              </Field>
              <Field label={goal === 'call' ? 'Phone number' : 'Website address'} hint={goal === 'call' ? 'With country code, for example +1 555 010 2000. Leave empty to use each account’s saved number.' : 'Starting with https://. Leave empty to use each account’s saved website.'}>
                <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder={goal === 'call' ? '+1 555 010 2000' : 'https://'} />
              </Field>
              {goal === 'website' ? (
                <Field label="Button">
                  <Select value={cta} onChange={(e) => setCta(e.target.value)}>{(setup.data?.ctas ?? []).map((c: string) => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase())}</option>)}</Select>
                </Field>
              ) : (
                <Field label="Button"><Input value="Call now" disabled /></Field>
              )}
              <Field label="Caption (primary text)">
                <textarea className={textareaCls} rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={2000} />
              </Field>
              <Field label="Title (headline)" hint="Optional.">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} />
              </Field>
            </div>
          </Section>

          <Section n={4} title="Audience and placements" description="Fixed placements: the ad shows only where you tick. Advantage+ placements are never used.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Countries" hint={COUNTRY_HINT}><Input value={countries} onChange={(e) => setCountries(e.target.value)} /></Field>
              <Field label="Age (unless set per account above)">
                <div className="flex items-center gap-2">
                  <Input className="w-20" inputMode="numeric" value={ageMin} onChange={(e) => setAgeMin(e.target.value)} aria-label="Minimum age" disabled={special === 'EMPLOYMENT'} />
                  <span className="text-ink-3">to</span>
                  <Input className="w-20" inputMode="numeric" value={ageMax} onChange={(e) => setAgeMax(e.target.value)} aria-label="Maximum age" disabled={special === 'EMPLOYMENT'} />
                </div>
              </Field>
              <Field label="Gender">
                <Select value={genders} onChange={(e) => setGenders(e.target.value as any)} disabled={special === 'EMPLOYMENT'}>
                  <option value="all">Everyone</option><option value="male">Men</option><option value="female">Women</option>
                </Select>
              </Field>
              <Field label="Special ad category" hint={special === 'EMPLOYMENT' ? 'Job ads: Meta allows ages 18–65 and all genders only.' : undefined}>
                <Select value={special} onChange={(e) => setSpecial(e.target.value as any)}><option value="NONE">None</option><option value="EMPLOYMENT">Employment (job ads)</option></Select>
              </Field>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="size-4" checked={advantage} onChange={(e) => setAdvantage(e.target.checked)} />
              Let Meta reach beyond these ages (Advantage+ audience)
            </label>
            <div className="mt-5">
              <div className="mb-2 text-sm font-medium text-ink">Placements</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(setup.data?.placements ?? []).map((pl: any) => {
                  const cur: string[] = placements ?? setup.data?.defaultPlacements ?? [];
                  const on = cur.includes(pl.value);
                  return (
                    <label key={pl.value} className="flex items-center gap-2 text-sm text-ink">
                      <input type="checkbox" className="size-4" checked={on} onChange={(e) => setPlacements(e.target.checked ? [...cur, pl.value] : cur.filter((x) => x !== pl.value))} />
                      {pl.label}
                    </label>
                  );
                })}
              </div>
            </div>
            {p?.problems?.some((x: string) => x.includes('Paid for by')) || paidBy ? (
              <div className="mt-4 max-w-sm"><Field label="Paid for by" hint="Meta requires this for ads shown in the EU."><Input value={paidBy} onChange={(e) => setPaidBy(e.target.value)} /></Field></div>
            ) : null}
          </Section>

          <Section n={5} title="Budget, dates and hours" description="The budget goes on each account’s ad set, down your account order. A budget typed in the table or the sheet wins for that account.">
            <div className="mb-4 flex flex-wrap items-end gap-4">
              <Field label="Budget type"><Segmented label="Budget type" value={kind} onChange={setKind} options={[{ value: 'lifetime', label: 'Lifetime' }, { value: 'daily', label: 'Daily' }]} /></Field>
              <Field label="Start date"><Input type="date" className="w-44" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
              <Field label={kind === 'lifetime' ? 'End date' : 'End date (optional)'}><Input type="date" className="w-44" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
              {kind === 'lifetime' && (
                <>
                  <Field label="Running hours" hint="Every day, in each account’s time zone.">
                    <div className="flex h-10 items-center gap-2">
                      <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" checked={hoursOn} onChange={(e) => setHoursOn(e.target.checked)} /> Only between</label>
                      <div className="w-32"><Input type="time" value={from} disabled={!hoursOn} onChange={(e) => setFrom(e.target.value)} aria-label="From hour" /></div>
                      <span className="text-sm text-ink-3">and</span>
                      <div className="w-32"><Input type="time" value={to} disabled={!hoursOn} onChange={(e) => setTo(e.target.value)} aria-label="To hour" /></div>
                    </div>
                  </Field>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <Segmented label="Budget" value={mode} onChange={setMode} options={[{ value: 'stepped', label: 'Step up' }, { value: 'same', label: 'Same for all' }, { value: 'each', label: 'Each account' }]} />
              {mode !== 'each' && <Field label={mode === 'stepped' ? 'First account' : 'Every account'}><Input className="w-28" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} /></Field>}
              {mode === 'stepped' && <Field label="Add per account"><Input className="w-28" inputMode="decimal" value={step} onChange={(e) => setStep(e.target.value)} /></Field>}
              {mode === 'stepped' && <p className="pb-2 text-sm text-ink-3">For example 20, 22, 24 …</p>}
            </div>
          </Section>

          <Section n={6} title="Review and launch">
            <div className="mb-4 max-w-md">
              <Field label="Launch name" hint="Used in the campaign, ad set and ad names on Meta."><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. November promo" maxLength={120} /></Field>
            </div>
            {plan.error && <ErrorAlert error={plan.error} />}
            {rows.length === 0 ? (
              <p className="text-sm text-ink-3">Tick at least one account above.</p>
            ) : !p ? (
              <Skeleton className="h-40" />
            ) : (
              <>
                {p.problems.length > 0 && <div className="mb-3"><Alert tone="warn" title="Before launching">{p.problems.join(' ')}</Alert></div>}
                <div className="overflow-x-auto rounded-xl border border-line">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b border-line bg-surface-2 text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                        <th className="w-8 py-2 pl-4 text-right">#</th><th className="px-3 py-2">Account</th><th className="px-2 py-2">Page</th><th className="px-2 py-2">Video</th>
                        <th className="px-2 py-2">{goal === 'call' ? 'Phone' : 'Website'}</th><th className="px-2 py-2">Age</th><th className="px-2 py-2 text-right">{kind === 'lifetime' ? 'Lifetime budget' : 'Daily budget'}</th><th className="px-4 py-2">Check</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {p.rows.map((r: any) => (
                        <tr key={r.accountRowId} className={r.issues.length ? 'bg-warn-bg/30' : ''}>
                          <td className="py-2 pl-4 text-right text-xs text-ink-3 tabular-nums">{r.position}</td>
                          <td className="px-3 py-2 font-medium text-ink">{r.accountName}</td>
                          <td className="px-2 py-2">{r.pageName ?? '—'}</td>
                          <td className="max-w-[160px] truncate px-2 py-2" title={r.videoName ?? ''}>{r.videoName ?? '—'}</td>
                          <td className="max-w-[200px] truncate px-2 py-2" title={r.link}>{r.link || '—'}</td>
                          <td className="px-2 py-2 tabular-nums">{r.ageMin}–{r.ageMax}</td>
                          <td className="px-2 py-2 text-right font-medium tabular-nums">{r.budget != null ? money(r.budget, r.currency) : '—'}</td>
                          <td className="px-4 py-2 text-xs">{r.issues.length ? <span className="text-warn">{r.issues.join(' ')}</span> : <Badge tone="good">Ready</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-ink-2">
                    {p.rows.length} account{p.rows.length === 1 ? '' : 's'} · {p.totals.map((t: any) => money(t.total, t.currency)).join(' + ')} {kind === 'lifetime' ? `in total over ${p.days ?? '?'} day${p.days === 1 ? '' : 's'}` : 'a day'} once you switch them on
                    {issues > 0 && <span className="text-warn"> · {issues} thing{issues === 1 ? '' : 's'} to fix</span>}
                  </div>
                  <Button icon={<Rocket className="size-4" />} disabled={!ready || !canLaunch} onClick={() => setConfirming(true)} title={!canLaunch ? 'Your role cannot create ads' : undefined}>
                    Create {p.rows.length} ad{p.rows.length === 1 ? '' : 's'} (paused)
                  </Button>
                </div>
                {!canLaunch && <p className="mt-2 text-right text-xs text-ink-3">Your role can plan but not create ads.</p>}
              </>
            )}
          </Section>

          <Modal
            open={confirming}
            onClose={() => setConfirming(false)}
            title="Create these ads on Meta?"
            footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>Back</Button><Button loading={launch.isPending} icon={<Rocket className="size-4" />} onClick={() => launch.mutate()}>Yes, create them paused</Button></>}
          >
            <p className="text-sm text-ink-2">
              The panel will create {p?.rows.length} campaign{p?.rows.length === 1 ? '' : 's'}, each with one ad set and one ad, in your account order. Everything is created <b>PAUSED</b>, so nothing spends until you switch it on in Ads Manager.
            </p>
            <p className="mt-2 text-sm text-ink-2">{kind === 'lifetime' ? 'Total lifetime budget' : 'Total daily budget'} once switched on: <b>{p?.totals.map((t: any) => money(t.total, t.currency)).join(' + ')}</b>{kind === 'lifetime' && p?.days ? ` over ${p.days} days` : ''}. {hoursOn && kind === 'lifetime' ? `Ads show only ${from}–${to} each day.` : ''} No Advantage+ changes to the video, caption or headline.</p>
            {launch.error && <div className="mt-3"><ErrorAlert error={launch.error} /></div>}
          </Modal>
          <p className="mb-6 flex items-center gap-1.5 text-xs text-ink-3"><FileSpreadsheet className="size-3.5" /> Sheet columns: account, budget, age_min, age_max, page, video, caption, title, phone_or_website. Accounts can be written as “DE 154”. Leave a cell empty to use this page’s value.</p>
        </>
      )}
    </>
  );
}
