import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Target, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Skeleton, cx } from '../components/ui';
import { api, get, post, put } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { Picker, type Named } from './EasyAds';

type Spec = { countries: string[]; ageMin: number; ageMax: number; genders: 'all' | 'male' | 'female'; advantageAudience: boolean; advanced: { locations: { include: Named[]; exclude: Named[]; types: string[] }; interests: Named[]; behaviors: Named[]; excludedInterests: Named[]; locales: Named[]; devicePlatforms: string[]; userOs: string[] } };
const EMPTY: Spec = { countries: ['BD'], ageMin: 18, ageMax: 65, genders: 'all', advantageAudience: false, advanced: { locations: { include: [], exclude: [], types: ['home', 'recent'] }, interests: [], behaviors: [], excludedInterests: [], locales: [], devicePlatforms: ['mobile', 'desktop'], userOs: [] } };
const toggle = (xs: string[], v: string) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]);

export function describeSpec(s: Spec, special: string) {
  const a = s.advanced ?? EMPTY.advanced;
  const bits = [s.countries.join(', '), special === 'EMPLOYMENT' ? '18–65, everyone (job ad)' : `${s.ageMin}–${s.ageMax}, ${s.genders === 'all' ? 'everyone' : s.genders === 'male' ? 'men' : 'women'}`];
  if (a.locations?.include?.length) bits.push(a.locations.include.map((x) => x.name).join(', '));
  if (a.interests?.length) bits.push(`interests: ${a.interests.map((x) => x.name).join(', ')}`);
  if (a.behaviors?.length) bits.push(`behaviours: ${a.behaviors.map((x) => x.name).join(', ')}`);
  if (a.excludedInterests?.length) bits.push(`not: ${a.excludedInterests.map((x) => x.name).join(', ')}`);
  if (a.locales?.length) bits.push(a.locales.map((x) => x.name).join(', '));
  if (a.devicePlatforms?.length === 1) bits.push(a.devicePlatforms[0]);
  if (a.userOs?.length) bits.push(a.userOs.join('/'));
  if (s.advantageAudience) bits.push('Advantage+ audience');
  return bits.join(' · ');
}

function Editor({ initial, onClose }: { initial: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [special, setSpecial] = useState<'NONE' | 'EMPLOYMENT'>(initial?.specialCategory ?? 'NONE');
  const [spec, setSpec] = useState<Spec>(initial?.spec ? { ...EMPTY, ...initial.spec, advanced: { ...EMPTY.advanced, ...(initial.spec.advanced ?? {}) } } : EMPTY);
  const [countries, setCountries] = useState(spec.countries.join(', '));
  const [estimateFor, setEstimateFor] = useState<number[]>([]);
  const setA = (p: Partial<Spec['advanced']>) => setSpec((s) => ({ ...s, advanced: { ...s.advanced, ...p } }));
  const body = () => ({ name: name.trim(), description, specialCategory: special, spec: { ...spec, countries: countries.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)) } });
  const setup = useQuery({ queryKey: ['launch', 'setup'], queryFn: () => get('/launch/setup') });
  const check = useQuery({ queryKey: ['audiences', 'check', body()], queryFn: () => post('/audiences/check', body()), enabled: name.trim().length > 0 });
  const save = useMutation({ mutationFn: () => (initial?.id ? put(`/audiences/${initial.id}`, body()) : post('/audiences', body())), onSuccess: () => { qc.invalidateQueries({ queryKey: ['audiences'] }); onClose(); } });
  const estimate = useMutation({ mutationFn: () => post('/audiences/estimate', { spec: body().spec, specialCategory: special, accountRowIds: estimateFor }) });
  const problems: string[] = check.data?.problems ?? [];
  const accounts: any[] = setup.data?.accounts ?? [];
  return (
    <Modal open onClose={onClose} wide title={initial?.id ? `Edit ${initial.name}` : 'New audience'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!name.trim() || problems.length > 0} onClick={() => save.mutate()}>{initial?.id ? 'Save changes' : 'Save audience'}</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Dhaka men 25–45" /></Field>
        <Field label="Description" hint="Optional."><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
        <Field label="Countries" hint="Two-letter codes, separated by commas."><Input value={countries} onChange={(e) => setCountries(e.target.value)} /></Field>
        <Field label="Special ad category" hint={special === 'EMPLOYMENT' ? 'Job ads: ages 18–65, all genders, no exclusions, 15-mile radius minimum.' : undefined}><Select value={special} onChange={(e) => setSpecial(e.target.value as any)}><option value="NONE">None</option><option value="EMPLOYMENT">Employment (job ads)</option></Select></Field>
        <Field label="Age">
          <div className="flex items-center gap-2">
            <Input className="w-20" inputMode="numeric" value={spec.ageMin} disabled={special === 'EMPLOYMENT'} onChange={(e) => setSpec({ ...spec, ageMin: Number(e.target.value) || 18 })} aria-label="Minimum age" />
            <span className="text-ink-3">to</span>
            <Input className="w-20" inputMode="numeric" value={spec.ageMax} disabled={special === 'EMPLOYMENT'} onChange={(e) => setSpec({ ...spec, ageMax: Number(e.target.value) || 65 })} aria-label="Maximum age" />
          </div>
        </Field>
        <Field label="Gender"><Select value={spec.genders} disabled={special === 'EMPLOYMENT'} onChange={(e) => setSpec({ ...spec, genders: e.target.value as any })}><option value="all">Everyone</option><option value="male">Men</option><option value="female">Women</option></Select></Field>
        <Picker type="location" label="Places inside those countries" hint="Cities take a radius in miles." value={spec.advanced.locations.include} onChange={(v) => setA({ locations: { ...spec.advanced.locations, include: v } })} radius />
        <Picker type="location" label="Places to exclude" value={spec.advanced.locations.exclude} onChange={(v) => setA({ locations: { ...spec.advanced.locations, exclude: v } })} />
        <Field label="Count people who are">
          <div className="flex flex-wrap gap-3 pt-1">{[['home', 'Living there'], ['recent', 'Recently there'], ['travel_in', 'Travelling there']].map(([v, l]) => <label key={v} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" checked={spec.advanced.locations.types.includes(v)} onChange={() => setA({ locations: { ...spec.advanced.locations, types: toggle(spec.advanced.locations.types, v) } })} /> {l}</label>)}</div>
        </Field>
        <Picker type="locale" label="Languages" hint="Optional." value={spec.advanced.locales} onChange={(v) => setA({ locales: v })} />
        <Picker type="interest" label="Interests" value={spec.advanced.interests} onChange={(v) => setA({ interests: v })} />
        <Picker type="behavior" label="Behaviours" placeholder="Type to filter Meta’s behaviour list…" value={spec.advanced.behaviors} onChange={(v) => setA({ behaviors: v })} />
        <Picker type="interest" label="Exclude people interested in" value={spec.advanced.excludedInterests} onChange={(v) => setA({ excludedInterests: v })} />
        <Field label="Devices">
          <div className="flex flex-wrap gap-3 pt-1">
            {[['mobile', 'Mobile'], ['desktop', 'Desktop']].map(([v, l]) => <label key={v} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" checked={spec.advanced.devicePlatforms.includes(v)} onChange={() => setA({ devicePlatforms: toggle(spec.advanced.devicePlatforms, v) })} /> {l}</label>)}
            <span className="mx-1 h-5 w-px bg-line" />
            {[['Android', 'Android only'], ['iOS', 'iOS only']].map(([v, l]) => <label key={v} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" checked={spec.advanced.userOs.includes(v)} onChange={() => setA({ userOs: toggle(spec.advanced.userOs, v) })} /> {l}</label>)}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink md:col-span-2"><input type="checkbox" className="size-4" checked={spec.advantageAudience} onChange={(e) => setSpec({ ...spec, advantageAudience: e.target.checked })} /> Let Meta reach beyond these ages (Advantage+ audience)</label>
      </div>
      {problems.length > 0 && <div className="mt-4"><Alert tone="warn" title="Meta would refuse this audience"><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert></div>}
      <div className="mt-4 rounded-xl border border-line p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-ink">How many people can Meta reach? <span className="font-normal text-ink-3">Asked live from Meta for the accounts you tick.</span></div>
          <Button size="sm" variant="secondary" icon={<Users className="size-4" />} loading={estimate.isPending} disabled={!estimateFor.length || problems.length > 0} onClick={() => estimate.mutate()}>Ask Meta</Button>
        </div>
        <div className="flex flex-wrap gap-3">{accounts.map((a) => <label key={a.id} className="flex items-center gap-1.5 text-xs text-ink"><input type="checkbox" className="size-3.5" checked={estimateFor.includes(a.id)} onChange={() => setEstimateFor((xs) => (xs.includes(a.id) ? xs.filter((x) => x !== a.id) : [...xs, a.id]))} /> {a.name}</label>)}</div>
        {estimate.error && <div className="mt-2"><ErrorAlert error={estimate.error} /></div>}
        {estimate.data?.items && (
          <ul className="mt-3 divide-y divide-line text-sm">
            {estimate.data.items.map((e: any) => <li key={e.accountRowId} className="flex items-center justify-between py-1.5"><span className="text-ink">{e.accountName ?? accounts.find((a) => a.id === e.accountRowId)?.name}</span>{e.error ? <span className="text-xs text-warn">{e.error}</span> : <span className="font-medium tabular-nums">{e.low == null ? 'Meta gave no estimate' : `${Number(e.low).toLocaleString('en')}${e.high ? ` – ${Number(e.high).toLocaleString('en')}` : ''} people a month`}</span>}</li>)}
          </ul>
        )}
      </div>
      {save.error && <div className="mt-3"><ErrorAlert error={save.error} /></div>}
    </Modal>
  );
}

export function AudiencesPage() {
  usePageTitle('Audience Manager');
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['audiences'], queryFn: () => get('/audiences') });
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<any | null>(null);
  const del = useMutation({ mutationFn: (id: number) => api(`/audiences/${id}`, { method: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['audiences'] }); setConfirm(null); } });
  const items: any[] = q.data?.items ?? [];
  const canEdit = can('campaigns.draft');
  return (
    <>
      <PageHeader title="Audience Manager" description="Audiences you save once and load into Easy Ads or Advanced Ads: countries, ages, gender, places, interests, behaviours, languages and devices, with Meta’s own reach estimate. Job-ad (Employment) rules are checked before saving. Each account’s custom audiences are picked per account inside Advanced Ads." actions={canEdit ? <Button icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>New audience</Button> : undefined} />
      {q.error && <ErrorAlert error={q.error} />}
      <Card>
        <CardHeader title="Saved audiences" description={items.length ? `${items.length} saved` : undefined} />
        {q.isLoading ? <div className="p-5"><Skeleton className="h-32" /></div> : items.length === 0 ? (
          <EmptyState icon={<Target className="size-6" />} title="No saved audiences yet">{canEdit ? 'Press New audience. Every list (places, interests, languages) comes from Meta’s own search.' : 'Audiences saved by your team show here.'}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><span className="font-medium text-ink">{a.name}</span>{a.specialCategory === 'EMPLOYMENT' && <Badge tone="info">Job ad</Badge>}</div>
                  {a.description && <p className="text-sm text-ink-2">{a.description}</p>}
                  <p className={cx('mt-1 text-xs text-ink-3')}>{describeSpec(a.spec, a.specialCategory)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Link to={`/advanced-ads?audience=${a.id}`} className="text-sm font-medium text-brand hover:underline">Use in Advanced Ads</Link>
                  <Link to={`/easy-ads?audience=${a.id}`} className="text-sm font-medium text-brand hover:underline">Easy Ads</Link>
                  {canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(a)}>Edit</Button>}
                  {canEdit && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(a)}>Delete</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing !== undefined && <Editor initial={editing} onClose={() => setEditing(undefined)} />}
      <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} title="Delete this audience?" footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Keep</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate(confirm.id)}>Delete</Button></>}>
        <p className="text-sm text-ink-2">“{confirm?.name}” is removed from the panel. Ads already created with it are not affected.</p>
      </Modal>
    </>
  );
}
