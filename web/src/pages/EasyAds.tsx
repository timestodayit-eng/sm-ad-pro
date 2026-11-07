import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Globe, Phone, Rocket, Search, SlidersHorizontal, Sparkles, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Segmented, Select, Skeleton, cx } from '../components/ui';
import { get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { money } from './Live';

type Row = { accountRowId: number; pageId?: string; dailyBudget?: number; mediaAssetId?: number; caption?: string; title?: string; link?: string; ageMin?: number; ageMax?: number; customAudiences?: { include: string[]; exclude: string[] } };
export type Named = { key: string; name: string; type?: string; detail?: string; countryCode?: string; radius?: number; audience?: number | null };
type SearchType = 'location' | 'interest' | 'behavior' | 'locale';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function useDebounced<T>(v: T, ms = 350) {
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

/** Type a word, pick from Meta's own list. Nothing here is typed from memory: every key comes from Meta's search. */
export function Picker({ type, label, hint, value, onChange, placeholder, radius }: { type: SearchType; label: string; hint?: string; value: Named[]; onChange: (v: Named[]) => void; placeholder?: string; radius?: boolean }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const res = useQuery({ queryKey: ['launch', 'search', type, dq], queryFn: () => get(`/launch/search?type=${type}&q=${encodeURIComponent(dq)}`), enabled: dq.length > 0 || type === 'behavior', staleTime: 60_000 });
  const items: Named[] = (res.data?.items ?? []).filter((x: Named) => !value.some((v) => v.key === x.key));
  const [open, setOpen] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <div className="flex items-center gap-2">
          <Search className="size-4 shrink-0 text-ink-3" />
          <Input value={q} placeholder={placeholder ?? 'Type to search Meta’s list…'} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} aria-label={`Search ${label.toLowerCase()}`} />
        </div>
        {open && (dq || type === 'behavior') && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
            {res.isLoading ? <div className="px-3 py-2 text-sm text-ink-3">Asking Meta…</div>
              : res.error ? <div className="px-3 py-2 text-sm text-bad">{(res.error as any)?.message ?? 'Search failed'}</div>
              : items.length === 0 ? <div className="px-3 py-2 text-sm text-ink-3">Nothing found.</div>
              : items.map((it) => (
                <button key={it.key} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange([...value, { key: it.key, name: it.name, type: it.type, countryCode: it.countryCode, ...(radius && it.type === 'city' ? { radius: 15 } : {}) }]); setQ(''); setOpen(false); }}>
                  <span className="font-medium text-ink">{it.name}</span>
                  {it.type && <span className="ml-2 rounded bg-surface-2 px-1 text-[10px] text-ink-3 uppercase">{it.type}</span>}
                  {it.detail && <span className="ml-2 text-xs text-ink-3">{it.detail}</span>}
                  {it.audience != null && <span className="ml-2 text-xs text-ink-3">· {Number(it.audience).toLocaleString('en')}+</span>}
                </button>
              ))}
          </div>
        )}
      </div>
      {value.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {value.map((v) => (
            <li key={v.key} className="flex items-center gap-1 rounded-full border border-line bg-surface-2 py-0.5 pr-1 pl-2.5 text-xs text-ink">
              {v.name}{v.type && v.type !== 'interest' && v.type !== 'locale' && v.type !== 'behavior' ? <span className="text-ink-3"> · {v.type}</span> : null}
              {radius && v.type === 'city' && (
                <span className="flex items-center gap-1 text-ink-3">+<input className="w-10 rounded border border-line bg-surface px-1 text-right text-xs" inputMode="numeric" value={v.radius ?? ''} aria-label={`Radius around ${v.name} in miles`} onChange={(e) => onChange(value.map((x) => (x.key === v.key ? { ...x, radius: e.target.value === '' ? undefined : Math.min(80, Math.max(1, Number(e.target.value) || 1)) } : x)))} />mi</span>
              )}
              <button type="button" className="rounded-full p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => onChange(value.filter((x) => x.key !== v.key))} aria-label={`Remove ${v.name}`}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

/** Per-account overrides for Advanced Ads: Page, video, text, link and this account's own custom audiences. */
function OverrideModal({ account, row, pages, videos, goal, onClose, onChange }: { account: any; row: Row; pages: any[]; videos: any[]; goal: 'call' | 'website'; onClose: () => void; onChange: (p: Partial<Row>) => void }) {
  const aud = useQuery({ queryKey: ['launch', 'audiences', account.id], queryFn: () => get(`/launch/accounts/${account.id}/audiences`), staleTime: 60_000 });
  const ca = row.customAudiences ?? { include: [], exclude: [] };
  const setCa = (id: string, where: 'include' | 'exclude' | 'none') =>
    onChange({ customAudiences: { include: where === 'include' ? [...new Set([...ca.include, id])] : ca.include.filter((x) => x !== id), exclude: where === 'exclude' ? [...new Set([...ca.exclude, id])] : ca.exclude.filter((x) => x !== id) } });
  return (
    <Modal open onClose={onClose} title={`${account.name}: this account only`} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="mb-3 text-sm text-ink-3">Anything left empty uses the value from the main form.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Facebook Page"><Select value={row.pageId ?? ''} onChange={(e) => onChange({ pageId: e.target.value || undefined })} aria-label={`Page for ${account.name}`}><option value="">Same as the launch</option>{pages.map((pg) => <option key={pg.id} value={pg.id}>{pg.name}</option>)}</Select></Field>
        <Field label="Video"><Select value={row.mediaAssetId ?? ''} onChange={(e) => onChange({ mediaAssetId: e.target.value ? Number(e.target.value) : undefined })} aria-label={`Video for ${account.name}`}><option value="">Same as the launch</option>{videos.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
        <Field label="Title (headline)"><Input value={row.title ?? ''} onChange={(e) => onChange({ title: e.target.value || undefined })} maxLength={255} /></Field>
        <Field label={goal === 'call' ? 'Phone number' : 'Website address'}><Input value={row.link ?? ''} onChange={(e) => onChange({ link: e.target.value || undefined })} /></Field>
      </div>
      <div className="mt-3"><Field label="Caption (primary text)"><textarea className={textareaCls} rows={3} value={row.caption ?? ''} onChange={(e) => onChange({ caption: e.target.value || undefined })} maxLength={2000} /></Field></div>
      <div className="mt-4">
        <div className="mb-1 text-sm font-medium text-ink">Custom audiences in this account</div>
        {aud.isLoading ? <Skeleton className="h-16" /> : aud.error ? <ErrorAlert error={aud.error} /> : !aud.data?.items?.length ? <p className="text-sm text-ink-3">This account has no custom or lookalike audiences on Meta.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-3 uppercase"><th className="py-1">Audience</th><th>Size</th><th className="text-right">Use</th></tr></thead>
            <tbody className="divide-y divide-line">
              {aud.data.items.map((a: any) => {
                const state = ca.include.includes(a.id) ? 'include' : ca.exclude.includes(a.id) ? 'exclude' : 'none';
                return (
                  <tr key={a.id}>
                    <td className="py-1.5"><div className="text-ink">{a.name}</div><div className="text-xs text-ink-3">{a.subtype ?? ''}</div></td>
                    <td className="text-xs text-ink-3 tabular-nums">{a.sizeLow != null ? `${Number(a.sizeLow).toLocaleString('en')}–${Number(a.sizeHigh ?? a.sizeLow).toLocaleString('en')}` : '—'}</td>
                    <td className="text-right"><Select className="h-8 w-28" value={state} onChange={(e) => setCa(a.id, e.target.value as any)} aria-label={`Use ${a.name}`}><option value="none">Not used</option><option value="include">Include</option><option value="exclude">Exclude</option></Select></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

export function EasyAdsPage() {
  usePageTitle('Easy Ads');
  return <LaunchForm advanced={false} />;
}

export function AdvancedAdsPage() {
  usePageTitle('Advanced Ads');
  return <LaunchForm advanced />;
}

/** One form for both pages. Advanced adds every extra control; the launch itself goes through the same plan → confirm → PAUSED path. */
export function LaunchForm({ advanced }: { advanced: boolean }) {
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
  // Advanced Ads only
  const [overrideFor, setOverrideFor] = useState<number | null>(null);
  const [bidStrategy, setBidStrategy] = useState<'LOWEST_COST_WITHOUT_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'COST_CAP'>('LOWEST_COST_WITHOUT_CAP');
  const [bidAmount, setBidAmount] = useState('');
  const [locIn, setLocIn] = useState<Named[]>([]);
  const [locOut, setLocOut] = useState<Named[]>([]);
  const [locTypes, setLocTypes] = useState<string[]>(['home', 'recent']);
  const [interests, setInterests] = useState<Named[]>([]);
  const [behaviors, setBehaviors] = useState<Named[]>([]);
  const [exInterests, setExInterests] = useState<Named[]>([]);
  const [locales, setLocales] = useState<Named[]>([]);
  const [devices, setDevices] = useState<string[]>(['mobile', 'desktop']);
  const [userOs, setUserOs] = useState<string[]>([]);
  const [days, setDays] = useState<number[]>([]);
  const [description, setDescription] = useState('');
  const [urlTags, setUrlTags] = useState('');
  const [enhancements, setEnhancements] = useState(false);
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  // Saved audiences and placement sets (Audience Manager, Placements pages); ?audience= / ?placements= preload one.
  const [sp] = useSearchParams();
  const savedAudiences = useQuery({ queryKey: ['audiences'], queryFn: () => get('/audiences') });
  const savedPlacements = useQuery({ queryKey: ['placement-sets'], queryFn: () => get('/placement-sets') });
  const [audienceId, setAudienceId] = useState(sp.get('audience') ?? '');
  const [placementSetId, setPlacementSetId] = useState(sp.get('placements') ?? '');
  const [savingAudience, setSavingAudience] = useState(false);
  const [audienceName, setAudienceName] = useState('');
  const loadAudience = (id: string) => {
    setAudienceId(id);
    const a = (savedAudiences.data?.items ?? []).find((x: any) => String(x.id) === id);
    if (!a) return;
    const sp2 = a.spec;
    setCountries(sp2.countries.join(', ')); setAgeMin(String(sp2.ageMin)); setAgeMax(String(sp2.ageMax)); setGenders(sp2.genders); setAdvantage(Boolean(sp2.advantageAudience)); setSpecial(a.specialCategory);
    const adv = sp2.advanced ?? {};
    setLocIn(adv.locations?.include ?? []); setLocOut(adv.locations?.exclude ?? []); setLocTypes(adv.locations?.types ?? ['home', 'recent']);
    setInterests(adv.interests ?? []); setBehaviors(adv.behaviors ?? []); setExInterests(adv.excludedInterests ?? []); setLocales(adv.locales ?? []); setDevices(adv.devicePlatforms ?? ['mobile', 'desktop']); setUserOs(adv.userOs ?? []);
  };
  const loadPlacementSet = (id: string) => {
    setPlacementSetId(id);
    const ps = (savedPlacements.data?.items ?? []).find((x: any) => String(x.id) === id);
    if (ps) setPlacements(ps.placements);
  };
  useEffect(() => { if (audienceId && savedAudiences.data) loadAudience(audienceId); }, [savedAudiences.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (placementSetId && savedPlacements.data) loadPlacementSet(placementSetId); }, [savedPlacements.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveAudience = useMutation({
    mutationFn: () => post('/audiences', { name: audienceName.trim(), specialCategory: special, spec: { countries: countries.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)), ageMin: Number(ageMin) || 18, ageMax: Number(ageMax) || 65, genders, advantageAudience: advantage, advanced: { locations: { include: locIn, exclude: locOut, types: locTypes }, interests, behaviors, excludedInterests: exInterests, locales, devicePlatforms: devices, userOs } } }),
    onSuccess: (r: any) => { setSavingAudience(false); setAudienceName(''); savedAudiences.refetch(); setAudienceId(String(r.id)); },
  });

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
    ...(advanced ? { advanced: {
      bidStrategy, bidAmount: bidAmount === '' ? undefined : Number(bidAmount) || 0,
      locations: { include: locIn, exclude: locOut, types: locTypes },
      interests, behaviors, excludedInterests: exInterests, locales, devicePlatforms: devices, userOs, days,
      description, urlTags, creativeEnhancements: enhancements,
    } } : {}),
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
        title={advanced ? 'Advanced Ads' : 'Easy Ads'}
        description={advanced
          ? 'Everything Easy Ads does, plus every control: bid caps, places, interests, behaviours, languages, devices, days, per-account overrides and each account’s own custom audiences. All lists come from Meta. Everything is still created PAUSED.'
          : 'Send one video ad to the accounts you choose, in your account order. Each account gets its own campaign, ad set and ad, all created PAUSED on Meta. Nothing goes live until you switch it on.'}
        actions={<span className="flex items-center gap-3 text-sm font-medium"><Link to={advanced ? '/easy-ads' : '/advanced-ads'} className="flex items-center gap-1 text-brand hover:underline">{advanced ? <><Sparkles className="size-4" /> Easy Ads</> : <><SlidersHorizontal className="size-4" /> Advanced Ads</>}</Link><Link to="/publishing" className="text-brand hover:underline">Launch history →</Link></span>}
      />
      {setup.error && <ErrorAlert error={setup.error} />}
      {accounts.length === 0 ? (
        <Card><EmptyState icon={<Sparkles className="size-6" />} title="No working accounts" action={<Link to="/settings#working-accounts" className="text-sm font-medium text-brand hover:underline">Choose working accounts</Link>}>{advanced ? 'Advanced Ads' : 'Easy Ads'} launches to your working accounts.</EmptyState></Card>
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
                    {advanced && <th className="px-2 py-2">This account only</th>}
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
                        {advanced && (
                          <td className="px-2 py-2">
                            <Button size="sm" variant="secondary" disabled={!row} onClick={() => setOverrideFor(a.id)}>Overrides{row && (row.caption || row.title || row.link || row.mediaAssetId || row.pageId || row.customAudiences?.include.length || row.customAudiences?.exclude.length) ? ' ·' : ''}</Button>
                          </td>
                        )}
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
              {advanced && (
                <>
                  <Field label="Description" hint="Shown under the headline. Optional."><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} /></Field>
                  {goal === 'website' && <Field label="URL tags" hint="Added to the link for tracking, without the leading ?. For example utm_source=fb&utm_campaign={{campaign.name}}"><Input value={urlTags} onChange={(e) => setUrlTags(e.target.value)} maxLength={500} /></Field>}
                  <label className="flex items-center gap-2 text-sm text-ink lg:col-span-2">
                    <input type="checkbox" className="size-4" checked={enhancements} onChange={(e) => setEnhancements(e.target.checked)} />
                    Allow Advantage+ creative enhancements (Meta may change the video, text or button). Off means the ad runs exactly as written.
                  </label>
                </>
              )}
            </div>
          </Section>

          <Section n={4} title="Audience and placements" description="Fixed placements: the ad shows only where you tick. Advantage+ placements are never used.">
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <Field label="Saved audience" hint={advanced ? 'Fills every field below. You can still change them.' : 'Fills countries, age and gender. Places and interests need Advanced Ads.'}>
                <Select className="w-64" value={audienceId} onChange={(e) => loadAudience(e.target.value)} aria-label="Saved audience"><option value="">None, set it here…</option>{(savedAudiences.data?.items ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
              </Field>
              {advanced && <Button variant="secondary" onClick={() => setSavingAudience(true)}>Save this audience…</Button>}
              <Link to="/audiences" className="pb-2.5 text-sm font-medium text-brand hover:underline">Audience Manager →</Link>
            </div>
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
            {advanced && (
              <div className="mt-5 grid gap-4 border-t border-line pt-5 lg:grid-cols-2">
                <Picker type="location" label="Places inside those countries" hint="Regions, cities or postcodes from Meta’s list. Cities take a radius in miles. Leave empty for whole countries." value={locIn} onChange={setLocIn} radius />
                <Picker type="location" label="Places to exclude" value={locOut} onChange={setLocOut} />
                <Field label="Count people who are">
                  <div className="flex flex-wrap gap-3 pt-1">
                    {[['home', 'Living there'], ['recent', 'Recently there'], ['travel_in', 'Travelling there']].map(([v, l]) => (
                      <label key={v} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" checked={locTypes.includes(v)} onChange={() => setLocTypes(toggleIn(locTypes, v))} /> {l}</label>
                    ))}
                  </div>
                </Field>
                <Picker type="locale" label="Languages" hint="Optional. Empty means every language." value={locales} onChange={setLocales} />
                <Picker type="interest" label="Interests" hint="Detailed targeting. People matching any of these." value={interests} onChange={setInterests} />
                <Picker type="behavior" label="Behaviours" placeholder="Type to filter Meta’s behaviour list…" value={behaviors} onChange={setBehaviors} />
                <Picker type="interest" label="Exclude people interested in" hint={special === 'EMPLOYMENT' ? 'Not allowed for job ads.' : undefined} value={exInterests} onChange={setExInterests} />
                <Field label="Devices">
                  <div className="flex flex-wrap gap-3 pt-1">
                    {[['mobile', 'Mobile'], ['desktop', 'Desktop']].map(([v, l]) => (
                      <label key={v} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" checked={devices.includes(v)} onChange={() => setDevices(toggleIn(devices, v))} /> {l}</label>
                    ))}
                    <span className="mx-1 h-5 w-px bg-line" />
                    {[['Android', 'Android only'], ['iOS', 'iOS only']].map(([v, l]) => (
                      <label key={v} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" checked={userOs.includes(v)} onChange={() => setUserOs(toggleIn(userOs, v))} /> {l}</label>
                    ))}
                  </div>
                </Field>
              </div>
            )}
            <div className="mt-5">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-ink">Placements</span>
                <Select className="h-8 w-56" value={placementSetId} onChange={(e) => loadPlacementSet(e.target.value)} aria-label="Saved placement set"><option value="">Saved set…</option>{(savedPlacements.data?.items ?? []).map((ps: any) => <option key={ps.id} value={ps.id}>{ps.name}</option>)}</Select>
                <Link to="/placements" className="text-xs font-medium text-brand hover:underline">Placements page →</Link>
              </div>
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
                  {advanced && hoursOn && (
                    <Field label="On these days" hint="None ticked means every day.">
                      <div className="flex h-10 items-center gap-2">
                        {DAYS.map((d, i) => <label key={d} className="flex items-center gap-1 text-sm text-ink"><input type="checkbox" className="size-4" checked={days.includes(i)} onChange={() => setDays(toggleIn(days as any, i as any) as any)} /> {d}</label>)}
                      </div>
                    </Field>
                  )}
                </>
              )}
            </div>
            {advanced && (
              <div className="mb-4 flex flex-wrap items-end gap-4">
                <Field label="Bid strategy">
                  <Select className="w-56" value={bidStrategy} onChange={(e) => setBidStrategy(e.target.value as any)}><option value="LOWEST_COST_WITHOUT_CAP">Lowest cost (no cap)</option><option value="LOWEST_COST_WITH_BID_CAP">Bid cap</option><option value="COST_CAP">Cost cap</option></Select>
                </Field>
                {bidStrategy !== 'LOWEST_COST_WITHOUT_CAP' && <Field label={bidStrategy === 'COST_CAP' ? 'Cost cap per result' : 'Maximum bid'} hint="In each account’s currency."><Input className="w-28" inputMode="decimal" value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} /></Field>}
              </div>
            )}
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

          <Modal open={savingAudience} onClose={() => setSavingAudience(false)} title="Save this audience" footer={<><Button variant="ghost" onClick={() => setSavingAudience(false)}>Cancel</Button><Button loading={saveAudience.isPending} disabled={!audienceName.trim()} onClick={() => saveAudience.mutate()}>Save</Button></>}>
            <Field label="Name"><Input value={audienceName} onChange={(e) => setAudienceName(e.target.value)} maxLength={120} placeholder="e.g. Dhaka men 25–45" /></Field>
            <p className="mt-2 text-xs text-ink-3">Saves countries, age, gender, places, interests, behaviours, languages and devices for reuse in any launch. Custom audiences stay per account.</p>
            {saveAudience.error && <div className="mt-3"><ErrorAlert error={saveAudience.error} /></div>}
          </Modal>
          {advanced && overrideFor != null && selected[overrideFor] && (
            <OverrideModal account={accounts.find((a) => a.id === overrideFor)} row={selected[overrideFor]} pages={pages} videos={videos} goal={goal} onClose={() => setOverrideFor(null)} onChange={(p) => patch(overrideFor, p)} />
          )}
          <Modal
            open={confirming}
            onClose={() => setConfirming(false)}
            title="Create these ads on Meta?"
            footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>Back</Button><Button loading={launch.isPending} icon={<Rocket className="size-4" />} onClick={() => launch.mutate()}>Yes, create them paused</Button></>}
          >
            <p className="text-sm text-ink-2">
              The panel will create {p?.rows.length} campaign{p?.rows.length === 1 ? '' : 's'}, each with one ad set and one ad, in your account order. Everything is created <b>PAUSED</b>, so nothing spends until you switch it on in Ads Manager.
            </p>
            <p className="mt-2 text-sm text-ink-2">{kind === 'lifetime' ? 'Total lifetime budget' : 'Total daily budget'} once switched on: <b>{p?.totals.map((t: any) => money(t.total, t.currency)).join(' + ')}</b>{kind === 'lifetime' && p?.days ? ` over ${p.days} days` : ''}. {hoursOn && kind === 'lifetime' ? `Ads show only ${from}–${to} each day.` : ''} {enhancements ? 'Advantage+ creative enhancements are allowed.' : 'No Advantage+ changes to the video, caption or headline.'}</p>
            {launch.error && <div className="mt-3"><ErrorAlert error={launch.error} /></div>}
          </Modal>
          <p className="mb-6 flex items-center gap-1.5 text-xs text-ink-3"><FileSpreadsheet className="size-3.5" /> Sheet columns: account, budget, age_min, age_max, page, video, caption, title, phone_or_website. Accounts can be written as “DE 154”. Leave a cell empty to use this page’s value.</p>
        </>
      )}
    </>
  );
}
