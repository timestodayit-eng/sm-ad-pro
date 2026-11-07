import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, FilePlus2, FileText, History, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Skeleton, cx, formatDateTime } from '../components/ui';
import { api, get, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';

const PERIODS = [['7d', 'Last 7 days'], ['14d', 'Last 14 days'], ['30d', 'Last 30 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['yesterday', 'Yesterday'], ['today', 'Today']];
const textareaCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none';

function Editor({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [version, setVersion] = useState<number | undefined>(undefined);
  const q = useQuery({ queryKey: ['ai', 'document', id, version], queryFn: () => get(`/ai/documents/${id}${version ? `?version=${version}` : ''}`) });
  const [title, setTitle] = useState('');
  const [sections, setSections] = useState<any[]>([]);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (q.data) { setTitle(q.data.title); setSections(q.data.sections); setDirty(false); } }, [q.data]);
  const save = useMutation({ mutationFn: () => api(`/ai/documents/${id}`, { method: 'PUT', body: { title, sections, note: 'Edited in the panel' } }), onSuccess: () => { setVersion(undefined); qc.invalidateQueries({ queryKey: ['ai', 'document', id] }); qc.invalidateQueries({ queryKey: ['ai', 'documents'] }); } });
  const del = useMutation({ mutationFn: () => api(`/ai/documents/${id}`, { method: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai', 'documents'] }); onDeleted(); } });
  if (q.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const d = q.data;
  const old = version != null && version !== d.currentVersion;
  const exportUrl = (f: string) => `/api/ai/documents/${id}/export.${f}${version ? `?version=${version}` : ''}`;
  return (
    <Card className="mb-4">
      <CardHeader
        title={<Input className="h-9 max-w-xl font-semibold" value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} disabled={!can('reports.manage') || old} aria-label="Document title" />}
        description={<>Version {d.version} of {d.currentVersion}{old ? ' (older version, read-only)' : ''} · period {d.params.period}{d.params.group ? ` · group ${d.params.group}` : ''}</>}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select className="h-9 w-40" value={version ?? d.currentVersion} onChange={(e) => setVersion(Number(e.target.value))} aria-label="Version">{d.versions.map((v: any) => <option key={v.version} value={v.version}>v{v.version} · {v.note ?? ''}</option>)}</Select>
            <a href={exportUrl('pdf')} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-surface-2"><FileDown className="size-4" /> PDF</a>
            <a href={exportUrl('docx')} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-surface-2"><FileDown className="size-4" /> Word</a>
            {can('reports.manage') && !old && <Button size="sm" icon={<Save className="size-4" />} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Save as v{d.currentVersion + 1}</Button>}
            {can('reports.manage') && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>Delete</Button>}
          </div>
        }
      />
      {save.error && <div className="px-5 pt-4"><ErrorAlert error={save.error} /></div>}
      <div className="space-y-6 p-5">
        {sections.map((s, i) => (
          <section key={s.id}>
            <div className="mb-1 flex items-center gap-2">
              <Input className="h-8 max-w-md font-medium" value={s.title} disabled={!can('reports.manage') || old} onChange={(e) => { const n = [...sections]; n[i] = { ...s, title: e.target.value }; setSections(n); setDirty(true); }} aria-label="Section title" />
              {s.ai && <Badge tone="brand">written by the assistant</Badge>}
            </div>
            <textarea className={cx(textareaCls, 'min-h-[80px]')} rows={Math.min(14, Math.max(3, s.body.split('\n').length + 1))} value={s.body} disabled={!can('reports.manage') || old} onChange={(e) => { const n = [...sections]; n[i] = { ...s, body: e.target.value }; setSections(n); setDirty(true); }} aria-label={`${s.title} text`} />
            {s.table && s.table.rows.length > 0 && (
              <div className="mt-2 overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-xs">
                  <thead><tr className="bg-surface-2 text-left text-ink-3">{s.table.columns.map((c: string) => <th key={c} className="px-2 py-1.5 font-semibold">{c}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">{s.table.rows.map((r: any[], ri: number) => <tr key={ri}>{r.map((v, ci) => <td key={ci} className="px-2 py-1 tabular-nums">{v == null ? '—' : String(v)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-ink-3"><History className="size-3.5" /> Every save makes a new version; older versions stay readable and exportable. Tables come from synced data and are not edited here.</div>
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this document?" footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete all versions</Button></>}>
        <p className="text-sm text-ink-2">All {d.versions.length} version{d.versions.length === 1 ? '' : 's'} of “{d.title}” will be deleted. Exported files you downloaded are not affected.</p>
      </Modal>
    </Card>
  );
}

export function AiDocumentsPage() {
  usePageTitle('AI Documents');
  const { can } = useSession();
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('doc')) || null;
  const list = useQuery({ queryKey: ['ai', 'documents'], queryFn: () => get('/ai/documents') });
  const groups = useQuery({ queryKey: ['account-groups'], queryFn: () => get('/account-groups') });
  const [creating, setCreating] = useState(false);
  const [period, setPeriod] = useState('7d');
  const [group, setGroup] = useState('');
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () => post('/ai/documents', { period, group: group ? Number(group) : undefined, title: title || undefined, language: lang }),
    onSuccess: (r: any) => { setCreating(false); setTitle(''); qc.invalidateQueries({ queryKey: ['ai', 'documents'] }); setParams({ doc: String(r.id) }); },
  });
  const items: any[] = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="AI Documents" description="Reports built from your synced data: tables by code, summary and recommendations by the assistant, every number traceable. Edit, keep versions, export as PDF or Word." actions={can('reports.manage') ? <Button icon={<FilePlus2 className="size-4" />} onClick={() => setCreating(true)}>New report</Button> : undefined} />
      {openId && <Editor id={openId} onDeleted={() => setParams({})} />}
      {list.error && <ErrorAlert error={list.error} />}
      <Card>
        <CardHeader title="Documents" />
        {list.isLoading ? <div className="p-5"><Skeleton className="h-32" /></div> : items.length === 0 ? (
          <EmptyState icon={<FileText className="size-6" />} title="No documents yet">{can('reports.manage') ? 'Press New report to build one from the last 7 days.' : 'Reports made by your team show here.'}</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase"><th className="px-5 py-3">Title</th><th className="px-2 py-3">Period</th><th className="px-2 py-3 text-right">Version</th><th className="px-2 py-3">By</th><th className="px-5 py-3">Updated</th></tr></thead>
            <tbody className="divide-y divide-line">
              {items.map((d) => (
                <tr key={d.id} className={cx('hover:bg-surface-2', d.id === openId && 'bg-surface-2')}>
                  <td className="px-5 py-3"><Link to={`/documents?doc=${d.id}`} className="font-medium text-ink hover:text-brand hover:underline">{d.title}</Link></td>
                  <td className="px-2 py-3 text-ink-2">{d.params?.period}</td>
                  <td className="px-2 py-3 text-right tabular-nums">v{d.version}</td>
                  <td className="px-2 py-3 text-ink-2">{d.by ?? '—'}</td>
                  <td className="px-5 py-3 text-ink-3">{formatDateTime(d.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title="New performance report" footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button loading={create.isPending} onClick={() => create.mutate()}>Build report</Button></>}>
        <div className="space-y-4">
          <Field label="Period"><Select value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Accounts"><Select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All working accounts</option>{(groups.data?.items ?? []).map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
          <Field label="Title" hint="Optional. A name is made from the period if you leave it empty."><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={190} /></Field>
          <Alert tone="info" title="What goes in">Overview, accounts table, campaigns, money left and findings from synced data. If the assistant is configured, a summary and recommendations written from those numbers, marked as such.</Alert>
          {create.error && <ErrorAlert error={create.error} />}
        </div>
      </Modal>
    </>
  );
}
