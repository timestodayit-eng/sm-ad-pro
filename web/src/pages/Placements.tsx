import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Skeleton } from '../components/ui';
import { api, get, post, put } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';

const PLATFORM: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', messenger: 'Messenger', audience_network: 'Audience Network' };

function Editor({ initial, placements, onClose }: { initial: any | null; placements: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? '');
  const [picked, setPicked] = useState<string[]>(initial?.placements ?? []);
  const save = useMutation({ mutationFn: () => (initial?.id ? put(`/placement-sets/${initial.id}`, { name: name.trim(), placements: picked }) : post('/placement-sets', { name: name.trim(), placements: picked })), onSuccess: () => { qc.invalidateQueries({ queryKey: ['placement-sets'] }); onClose(); } });
  const platforms = [...new Set(placements.map((p) => p.platform))];
  return (
    <Modal open onClose={onClose} title={initial?.id ? `Edit ${initial.name}` : 'New placement set'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!name.trim() || !picked.length} onClick={() => save.mutate()}>{initial?.id ? 'Save changes' : 'Save set'}</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Reels only" /></Field>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {platforms.map((pf) => (
          <div key={pf}>
            <div className="mb-1.5 text-sm font-medium text-ink">{PLATFORM[pf] ?? pf}</div>
            {placements.filter((p) => p.platform === pf).map((p) => <label key={p.value} className="flex items-center gap-2 py-0.5 text-sm text-ink"><input type="checkbox" className="size-4" checked={picked.includes(p.value)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.value] : picked.filter((x) => x !== p.value))} /> {p.label}</label>)}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-3">Manual placements only: the ad shows where you tick and nowhere else. Advantage+ placements are never sent.</p>
      {save.error && <div className="mt-3"><ErrorAlert error={save.error} /></div>}
    </Modal>
  );
}

export function PlacementsPage() {
  usePageTitle('Placements');
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['placement-sets'], queryFn: () => get('/placement-sets') });
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<any | null>(null);
  const del = useMutation({ mutationFn: (id: number) => api(`/placement-sets/${id}`, { method: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['placement-sets'] }); setConfirm(null); } });
  const items: any[] = q.data?.items ?? [];
  const all: any[] = q.data?.placements ?? [];
  const label = (k: string) => all.find((p) => p.value === k)?.label ?? k;
  const canEdit = can('campaigns.draft');
  return (
    <>
      <PageHeader title="Placements" description="Sets of manual placements (feeds, Reels, Stories, Marketplace, Explore, Messenger) saved once and loaded into any launch. Only combinations Meta accepts are offered." actions={canEdit ? <Button icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>New set</Button> : undefined} />
      {q.error && <ErrorAlert error={q.error} />}
      <div className="mb-4"><Alert tone="info" title="The panel’s default set">{(q.data?.defaultPlacements ?? []).map(label).join(', ') || '…'}. Used by every launch unless you pick another set.</Alert></div>
      <Card>
        <CardHeader title="Saved placement sets" />
        {q.isLoading ? <div className="p-5"><Skeleton className="h-24" /></div> : items.length === 0 ? (
          <EmptyState icon={<Layers className="size-6" />} title="No placement sets yet">{canEdit ? 'Press New set to save a combination you use often.' : 'Sets saved by your team show here.'}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div><div className="font-medium text-ink">{s.name}</div><div className="text-xs text-ink-3">{s.placements.map(label).join(' · ')}</div></div>
                <div className="flex items-center gap-2">
                  <Link to={`/easy-ads?placements=${s.id}`} className="text-sm font-medium text-brand hover:underline">Use in Easy Ads</Link>
                  <Link to={`/advanced-ads?placements=${s.id}`} className="text-sm font-medium text-brand hover:underline">Advanced Ads</Link>
                  {canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(s)}>Edit</Button>}
                  {canEdit && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(s)}>Delete</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing !== undefined && <Editor initial={editing} placements={all} onClose={() => setEditing(undefined)} />}
      <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} title="Delete this placement set?" footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Keep</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate(confirm.id)}>Delete</Button></>}>
        <p className="text-sm text-ink-2">“{confirm?.name}” is removed. Ads already created are not affected.</p>
      </Modal>
    </>
  );
}
