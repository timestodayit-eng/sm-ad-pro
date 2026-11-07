import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, FolderPlus, LayoutDashboard, Megaphone, Pencil, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Skeleton } from '../components/ui';
import { api, get, post, put } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';

interface Group { id: number; name: string; description: string | null; members: number; managed: number }

function GroupEditor({ group, onClose }: { group: Group | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = group === 'new';
  const id = group && group !== 'new' ? group.id : null;
  const detail = useQuery({ queryKey: ['account-group', id], queryFn: () => get(`/account-groups/${id}`), enabled: !!id });
  const accounts = useQuery({ queryKey: ['accounts', 'all-for-groups'], queryFn: () => post('/accounts/search', { pageSize: 500 }), enabled: !!group });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);

  useEffect(() => {
    if (isNew) {
      setName(''); setDescription(''); setPicked(new Set());
    } else if (detail.data) {
      setName(detail.data.name); setDescription(detail.data.description ?? ''); setPicked(new Set(detail.data.members.map((m: any) => m.id)));
    }
    setFilter(''); setOnlyPicked(false);
  }, [isNew, detail.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim() || null, accountIds: [...picked] };
      return isNew ? post('/account-groups', { ...body, description: body.description ?? undefined }) : put(`/account-groups/${id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account-groups'] });
      qc.invalidateQueries({ queryKey: ['account-group'] });
      qc.invalidateQueries({ queryKey: ['live'] });
      onClose();
    },
  });

  const all: any[] = accounts.data?.items ?? [];
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return all.filter((a) => (!onlyPicked || picked.has(a.id)) && (!f || a.name.toLowerCase().includes(f) || String(a.account_id).includes(f) || (a.business_name ?? '').toLowerCase().includes(f)));
  }, [all, filter, onlyPicked, picked]);
  const toggle = (aid: number) => setPicked((s) => { const n = new Set(s); n.has(aid) ? n.delete(aid) : n.add(aid); return n; });
  const loading = accounts.isLoading || (!!id && detail.isLoading);

  return (
    <Modal
      open={!!group}
      onClose={onClose}
      wide
      title={group && group !== 'new' ? `Edit “${group.name}”` : 'New account group'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={name.trim().length < 2 || loading} onClick={() => save.mutate()}>{isNew ? 'Create group' : 'Save changes'}</Button>
        </>
      }
    >
      {loading ? <Skeleton className="h-64" /> : (
        <div className="space-y-4">
          {save.error && <ErrorAlert error={save.error} />}
          {accounts.error && <ErrorAlert error={accounts.error} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="g-name"><Input id="g-name" value={name} maxLength={190} onChange={(e) => setName(e.target.value)} placeholder="For example SM ENTERPRISE" /></Field>
            <Field label="Note (optional)" htmlFor="g-desc"><Input id="g-desc" value={description} maxLength={512} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-ink">Accounts in this group <span className="text-ink-3">({picked.size} chosen)</span></div>
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" className="size-4" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} /> Show only chosen</label>
            </div>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
              <Input className="pl-9" placeholder="Search by name, ID or business" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search accounts" />
            </div>
            <ul className="max-h-[45vh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {shown.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-3">No accounts match.</li>}
              {shown.map((a) => (
                <li key={a.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <input type="checkbox" className="size-4" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{a.name}</span>
                      <span className="block truncate text-xs text-ink-3">act_{a.account_id} · {a.currency}{a.business_name ? ` · ${a.business_name}` : ''}</span>
                    </span>
                    {a.is_managed ? <Badge tone="good">On dashboard</Badge> : <Badge>Not on dashboard</Badge>}
                  </label>
                </li>
              ))}
            </ul>
            {(accounts.data?.total ?? 0) > all.length && <p className="mt-2 text-xs text-ink-3">Showing the first {all.length} of {accounts.data.total} accounts. Search to narrow the list.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function AccountGroupsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  usePageTitle(t('accountGroups'));
  const q = useQuery({ queryKey: ['account-groups'], queryFn: () => get('/account-groups') });
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const del = useMutation({
    mutationFn: (g: Group) => api(`/account-groups/${g.id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['account-groups'] }); setDeleting(null); },
  });
  const groups: Group[] = q.data?.items ?? [];
  const manage = can('accounts.manage');

  return (
    <>
      <PageHeader
        title={t('accountGroups')}
        description="Saved sets of ad accounts, for example one group per brand or client. Open a group to see only its accounts on the dashboard and the Campaigns page."
        actions={manage ? <Button icon={<FolderPlus className="size-4" />} onClick={() => setEditing('new')}>New group</Button> : undefined}
      />
      {q.error && <ErrorAlert error={q.error} />}
      <Card>
        {q.isLoading ? (
          <div className="space-y-2 p-4"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        ) : !groups.length ? (
          <EmptyState icon={<FolderPlus className="size-6" />} title="No groups yet" action={manage ? <Button onClick={() => setEditing('new')}>New group</Button> : undefined}>
            Make a group for each brand or client, then open it to see just those accounts.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {groups.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-bg text-brand"><FolderOpen className="size-5" /></div>
                <div className="min-w-0 flex-1">
                  <Link to={`/?group=${g.id}`} className="font-medium text-ink hover:text-brand hover:underline">{g.name}</Link>
                  <div className="text-sm text-ink-3">
                    {g.members} account{g.members === 1 ? '' : 's'} · {g.managed} working
                    {g.description && <> · {g.description}</>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/?group=${g.id}`}><Button size="sm" icon={<LayoutDashboard className="size-3.5" />}>Open dashboard</Button></Link>
                  <Link to={`/campaigns?group=${g.id}`}><Button size="sm" variant="secondary" icon={<Megaphone className="size-3.5" />}>Campaigns</Button></Link>
                  {manage && <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(g)}>Edit</Button>}
                  {manage && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g)} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {groups.some((g) => g.managed < g.members) && (
        <p className="mt-3 text-xs text-ink-3">Only working accounts show live numbers. Add more in Settings → Working accounts.</p>
      )}
      <GroupEditor group={editing} onClose={() => setEditing(null)} />
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this group?"
        footer={<><Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" loading={del.isPending} onClick={() => deleting && del.mutate(deleting)}>Delete group</Button></>}
      >
        {del.error && <div className="mb-3"><ErrorAlert error={del.error} /></div>}
        <Alert tone="info" title={`“${deleting?.name}” will be removed`}>The ad accounts stay connected and on the dashboard. Only the group goes away.</Alert>
      </Modal>
    </>
  );
}
