import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  Download,
  Film,
  HardDrive,
  ImageIcon,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Input, Modal, PageHeader, Segmented, Skeleton, cx, formatBytes, formatDateTime, formatDuration, timeAgo } from '../components/ui';
import { api, get } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';
import { addFiles, cancel, clearFinished, dismiss, pause, resume, runDiagnostic, uploads, type DiagnosticResult, type UploadItem } from '../lib/uploader';

interface Asset {
  id: number;
  kind: 'video' | 'image';
  name: string;
  contentType: string;
  size: number;
  status: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
  thumbnailUrl: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
}
interface MediaList {
  items: Asset[];
  total: number;
  page: number;
  pageSize: number;
  library: Partial<Record<'video' | 'image', { count: number; bytes: number }>>;
  maxBytes: number;
}

const ACCEPT = '.mp4,.mov,.m4v,.jpg,.jpeg,.png,video/mp4,video/quicktime,image/jpeg,image/png';

/** Closest common ad aspect ratio, so buyers can see at a glance which placements a creative fits. */
function ratioLabel(w: number | null, h: number | null) {
  if (!w || !h) return null;
  const r = w / h;
  const known: [string, number][] = [['9:16', 9 / 16], ['4:5', 4 / 5], ['1:1', 1], ['16:9', 16 / 9]];
  const [label, v] = known.reduce((best, k) => (Math.abs(k[1] - r) < Math.abs(best[1] - r) ? k : best));
  return Math.abs(v - r) < 0.03 ? label : `${w}×${h}`;
}

export function MediaPage() {
  const { t } = useI18n();
  usePageTitle(t('media'));
  const { me, can } = useSession();
  const qc = useQueryClient();
  const r2 = Boolean(me?.features.r2);
  const canUpload = can('media.upload');
  const [kind, setKind] = useState<'all' | 'video' | 'image'>('all');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Asset | null>(null);

  useEffect(() => {
    const h = setTimeout(() => (setDebounced(q.trim()), setPage(1)), 300);
    return () => clearTimeout(h);
  }, [q]);

  const list = useQuery({
    queryKey: ['media', kind, debounced, page],
    queryFn: () => get<MediaList>(`/media?${new URLSearchParams({ ...(kind !== 'all' && { kind }), ...(debounced && { q: debounced }), page: String(page), pageSize: '48' })}`),
    enabled: r2,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    uploads.onFinished(() => qc.invalidateQueries({ queryKey: ['media'] }));
  }, [qc]);

  const del = useMutation({
    mutationFn: (a: Asset) => api(`/media/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['media'] });
    },
  });

  const lib = list.data?.library;
  const totalBytes = (lib?.video?.bytes ?? 0) + (lib?.image?.bytes ?? 0);

  return (
    <>
      <PageHeader
        title={t('media')}
        description="Videos and images for your ads. Files upload straight from your browser to Cloudflare R2, so large videos never slow the panel down."
      />

      {me && !r2 && (
        <Alert tone="warn" title="Cloudflare R2 is not configured on the server">
          Add R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the hosting environment and restart the app. docs/R2_SETUP.md walks through it, including the bucket CORS policy.
        </Alert>
      )}

      {r2 && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <MiniStat icon={<Film className="size-4" />} label="Videos" value={lib?.video?.count ?? 0} sub={formatBytes(lib?.video?.bytes ?? 0)} loading={list.isLoading} />
            <MiniStat icon={<ImageIcon className="size-4" />} label="Images" value={lib?.image?.count ?? 0} sub={formatBytes(lib?.image?.bytes ?? 0)} loading={list.isLoading} />
            <MiniStat icon={<HardDrive className="size-4" />} label="Library size" value={formatBytes(totalBytes)} sub={`Up to ${formatBytes(list.data?.maxBytes ?? 1024 ** 3)} per video`} loading={list.isLoading} />
          </div>

          {canUpload && <Uploader maxBytes={list.data?.maxBytes ?? 1024 ** 3} />}
          {canUpload && <StorageCheck />}

          <Card className="mt-6">
            <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
              <div className="relative min-w-[200px] flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                <Input className="pl-9" placeholder="Search by file name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search media" />
              </div>
              <Segmented
                label="File type"
                value={kind}
                onChange={(v) => (setKind(v), setPage(1))}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'video', label: 'Videos', icon: <Film className="size-3.5" /> },
                  { value: 'image', label: 'Images', icon: <ImageIcon className="size-3.5" /> },
                ]}
              />
            </div>
            {list.error && (
              <div className="p-4">
                <ErrorAlert error={list.error} />
              </div>
            )}
            {list.isLoading ? (
              <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
                ))}
              </div>
            ) : !list.data?.items.length ? (
              <EmptyState icon={<Film className="size-6" />} title={debounced || kind !== 'all' ? 'Nothing matches' : 'No media yet'}>
                {debounced || kind !== 'all' ? 'Try another name or file type.' : canUpload ? 'Drop your first video above. MP4 or MOV, up to 1 GB.' : 'Files uploaded by your team will appear here.'}
              </EmptyState>
            ) : (
              <>
                <ul className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {list.data.items.map((a) => (
                    <AssetCard key={a.id} a={a} onPreview={() => setPreview(a)} onDelete={can('media.delete') ? () => setConfirmDelete(a) : undefined} />
                  ))}
                </ul>
                {list.data.total > list.data.pageSize && (
                  <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-ink-2">
                    <span>
                      {(page - 1) * list.data.pageSize + 1}–{Math.min(page * list.data.pageSize, list.data.total)} of {list.data.total}
                    </span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
                        Previous
                      </Button>
                      <Button size="sm" variant="secondary" disabled={page * list.data.pageSize >= list.data.total} onClick={() => setPage(page + 1)}>
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </>
      )}

      <PreviewModal asset={preview} onClose={() => setPreview(null)} />
      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => (setConfirmDelete(null), del.reset())}
        title="Delete this file?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Keep it
            </Button>
            <Button variant="danger" loading={del.isPending} icon={<Trash2 className="size-4" />} onClick={() => confirmDelete && del.mutate(confirmDelete)}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          <span className="font-medium text-ink">{confirmDelete?.name}</span> will be removed from R2 and the library. Ads already published to Meta keep working; Meta has its own copy.
        </p>
        {del.error && (
          <div className="mt-3">
            <ErrorAlert error={del.error} />
          </div>
        )}
      </Modal>
    </>
  );
}

function MiniStat({ icon, label, value, sub, loading }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub: string; loading?: boolean }) {
  return (
    <Card className="flex items-center gap-4 p-4">
      <div className="brand-soft grid size-10 shrink-0 place-items-center rounded-xl text-brand">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-ink-3">{label}</div>
        {loading ? <Skeleton className="mt-1 h-6 w-16" /> : <div className="text-xl font-semibold tabular-nums text-ink">{value}</div>}
        <div className="truncate text-xs text-ink-3">{sub}</div>
      </div>
    </Card>
  );
}

/* ---------------- uploader ---------------- */

function Uploader({ maxBytes }: { maxBytes: number }) {
  const items = useSyncExternalStore(uploads.subscribe, uploads.snapshot);
  const [drag, setDrag] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  // Warn before closing the tab mid-upload. Picking the same file again later still resumes it.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (uploads.active()) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const take = (files: FileList | null) => {
    if (!files?.length) return;
    const ok: File[] = [];
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      const isImage = ['jpg', 'jpeg', 'png'].includes(ext);
      if (!['mp4', 'mov', 'm4v', 'jpg', 'jpeg', 'png'].includes(ext)) bad.push(`${f.name}: use MP4, MOV, JPG or PNG`);
      else if (f.size > (isImage ? 30 * 1024 ** 2 : maxBytes)) bad.push(`${f.name}: larger than ${formatBytes(isImage ? 30 * 1024 ** 2 : maxBytes)}`);
      else if (f.size === 0) bad.push(`${f.name}: the file is empty`);
      else ok.push(f);
    }
    setRejected(bad);
    if (ok.length) addFiles(ok);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    take(e.dataTransfer.files);
  };

  const finished = items.filter((i) => i.status === 'done' || i.status === 'cancelled').length;

  return (
    <Card>
      <div
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cx('m-4 rounded-xl border-2 border-dashed px-6 py-10 text-center transition', drag ? 'border-brand bg-surface-2' : 'border-line-strong')}
      >
        <div className="brand-soft mx-auto mb-3 grid size-12 place-items-center rounded-2xl text-brand">
          <UploadCloud className="size-6" />
        </div>
        <div className="font-semibold text-ink">Drop videos or images here</div>
        <p className="mt-1 text-sm text-ink-2">MP4 or MOV up to {formatBytes(maxBytes)}, JPG or PNG up to 30 MB. Many files at once is fine.</p>
        <Button className="mt-4" variant="secondary" onClick={() => input.current?.click()}>
          Choose files
        </Button>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => (take(e.target.files), (e.target.value = ''))} data-testid="file-input" />
      </div>

      {rejected.length > 0 && (
        <div className="px-4 pb-4">
          <Alert tone="warn" title={`${rejected.length} file${rejected.length > 1 ? 's were' : ' was'} not added`}>
            <ul className="list-disc pl-5">
              {rejected.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      {items.length > 0 && (
        <div className="border-t border-line">
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-sm font-medium text-ink">Uploads</span>
            {finished > 0 && (
              <Button size="sm" variant="ghost" onClick={clearFinished}>
                Clear finished
              </Button>
            )}
          </div>
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <UploadRow key={i.key} i={i} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

const STATUS_TEXT: Record<UploadItem['status'], string> = {
  preparing: 'Preparing…',
  uploading: 'Uploading',
  paused: 'Paused',
  finishing: 'Checking the file in R2…',
  thumbnail: 'Making thumbnail…',
  done: 'Uploaded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function UploadRow({ i }: { i: UploadItem }) {
  const pct = i.size ? Math.min(100, Math.floor((i.uploadedBytes / i.size) * 100)) : 0;
  const eta = i.speedBps > 0 ? Math.round((i.size - i.uploadedBytes) / i.speedBps) : null;
  const tone = i.status === 'done' ? 'bg-good' : i.status === 'failed' ? 'bg-bad' : i.status === 'paused' ? 'bg-warn' : 'bg-brand';
  return (
    <li className="px-4 py-3" data-testid="upload-row" data-status={i.status}>
      <div className="flex items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
          {i.status === 'done' ? <CheckCircle2 className="size-4 text-good" /> : i.status === 'failed' ? <XCircle className="size-4 text-bad" /> : <Film className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-medium text-ink">{i.name}</span>
            <span className="shrink-0 text-xs text-ink-3 tabular-nums">
              {formatBytes(i.uploadedBytes)} / {formatBytes(i.size)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${i.name} upload progress`}>
            <div className={cx('h-full rounded-full transition-[width] duration-300', tone)} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
            <span>
              {STATUS_TEXT[i.status]}
              {i.status === 'uploading' && ` · ${pct}%`}
            </span>
            {i.status === 'uploading' && i.speedBps > 0 && (
              <span>
                {formatBytes(i.speedBps)}/s{eta != null && eta > 0 && ` · about ${eta > 90 ? `${Math.round(eta / 60)} min` : `${eta} s`} left`}
              </span>
            )}
            {i.resumedBytes > 0 && <span className="text-info">Resumed: {formatBytes(i.resumedBytes)} was already in R2</span>}
          </div>
          {i.error && (
            <div className="mt-1.5 text-xs text-bad">
              {i.error.message}
              {i.error.hint && <span className="text-ink-3"> {i.error.hint}</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {i.status === 'uploading' && <IconBtn label="Pause" onClick={() => pause(i.key)} icon={<Pause className="size-4" />} />}
          {i.status === 'paused' && <IconBtn label="Resume" onClick={() => resume(i.key)} icon={<Play className="size-4" />} />}
          {i.status === 'failed' && <IconBtn label="Retry" onClick={() => resume(i.key)} icon={<RotateCcw className="size-4" />} />}
          {['uploading', 'paused', 'failed', 'preparing'].includes(i.status) && <IconBtn label="Cancel upload" onClick={() => cancel(i.key)} icon={<X className="size-4" />} />}
          {['done', 'cancelled'].includes(i.status) && <IconBtn label="Remove from list" onClick={() => dismiss(i.key)} icon={<X className="size-4" />} />}
        </div>
      </div>
    </li>
  );
}

function IconBtn({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink">
      {icon}
    </button>
  );
}

/* ---------------- storage check ---------------- */

function StorageCheck() {
  const last = useQuery({ queryKey: ['media-diagnostic'], queryFn: () => get<{ last: DiagnosticResult | null }>('/media/diagnostics') });
  const qc = useQueryClient();
  const run = useMutation({ mutationFn: runDiagnostic, onSuccess: () => qc.invalidateQueries({ queryKey: ['media-diagnostic'] }) });
  const d = run.data ?? last.data?.last ?? null;
  const ok = d && d.browserPut && d.browserEtag && d.serverSawObject && !d.error;

  const steps: { label: string; state: boolean | null; detail?: string }[] = d
    ? [
        { label: 'Server can reach the bucket with these keys', state: d.bucketOk },
        {
          label: 'Bucket CORS policy allows this panel',
          state: d.cors ? (d.cors.readable ? d.cors.originAllowed && d.cors.putAllowed : null) : null,
          detail: d.cors?.problem ?? (d.cors?.readable && !d.cors.etagExposed ? 'ETag is not in ExposeHeaders.' : undefined),
        },
        { label: 'This browser uploaded a test file to R2', state: d.browserPut },
        { label: 'The browser could read the ETag header', state: d.browserEtag },
        { label: 'Server found the test file, then deleted it', state: d.serverSawObject },
      ]
    : [];

  return (
    <Card className="mt-6">
      <CardHeader
        icon={<ShieldCheck className="size-4" />}
        title="Storage connection"
        description={d ? `Last checked ${timeAgo(d.at)}` : 'Proves uploads work from this browser before you rely on them.'}
        actions={
          <Button size="sm" variant={ok ? 'secondary' : 'primary'} loading={run.isPending} onClick={() => run.mutate()}>
            Check storage connection
          </Button>
        }
      />
      {(d || run.error) && (
        <div className="space-y-3 p-5">
          {run.error && <ErrorAlert error={run.error} />}
          {d && (
            <ul className="space-y-2 text-sm">
              {steps.map((s) => (
                <li key={s.label} className="flex items-start gap-2.5">
                  {s.state === true ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" /> : s.state === false ? <XCircle className="mt-0.5 size-4 shrink-0 text-bad" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-ink-3" />}
                  <span className={s.state === null ? 'text-ink-3' : 'text-ink'}>
                    {s.label}
                    {s.state === null && ' (not checked)'}
                    {s.detail && <span className="block text-xs text-ink-3">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d?.error && (
            <Alert tone="bad" title={d.error.message}>
              {d.error.hint}
              <div className="mt-1 font-mono text-xs text-ink-3">{d.error.code}</div>
            </Alert>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------------- library ---------------- */

function AssetCard({ a, onPreview, onDelete }: { a: Asset; onPreview: () => void; onDelete?: () => void }) {
  const ratio = ratioLabel(a.width, a.height);
  return (
    <li className="group overflow-hidden rounded-xl border border-line bg-surface" data-testid="asset-card">
      <button onClick={onPreview} className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-2" aria-label={`Preview ${a.name}`}>
        {a.thumbnailUrl ? (
          <img src={a.thumbnailUrl} alt="" className="size-full object-contain transition group-hover:scale-[1.02]" loading="lazy" />
        ) : (
          <span className="grid size-full place-items-center text-ink-3">{a.kind === 'video' ? <Film className="size-8" /> : <ImageIcon className="size-8" />}</span>
        )}
        {a.kind === 'video' && (
          <span className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
            <span className="grid size-11 place-items-center rounded-full bg-black/55 text-white">
              <Play className="size-5 translate-x-px" />
            </span>
          </span>
        )}
        <span className="absolute top-2 left-2 flex gap-1">
          {ratio && <span className="rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">{ratio}</span>}
        </span>
        {a.durationMs != null && <span className="absolute right-2 bottom-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">{formatDuration(a.durationMs)}</span>}
      </button>
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink" title={a.name}>
            {a.name}
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-3">
            {formatBytes(a.size)} · {timeAgo(a.createdAt)}
            {a.createdBy && ` · ${a.createdBy}`}
          </div>
        </div>
        {onDelete && (
          <button onClick={onDelete} className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-bad-bg hover:text-bad" aria-label={`Delete ${a.name}`} title="Delete">
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function PreviewModal({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const url = useQuery({ queryKey: ['media-url', asset?.id], queryFn: () => get<{ url: string }>(`/media/${asset!.id}/url`), enabled: Boolean(asset), staleTime: 30 * 60_000 });
  const download = async () => {
    if (!asset) return;
    const r = await get<{ url: string }>(`/media/${asset.id}/url?download=1`);
    window.location.href = r.url;
  };
  return (
    <Modal
      open={Boolean(asset)}
      onClose={onClose}
      title={asset?.name ?? ''}
      wide
      footer={
        <Button variant="secondary" icon={<Download className="size-4" />} onClick={download}>
          Download original
        </Button>
      }
    >
      {asset && (
        <div className="space-y-4">
          <div className="grid max-h-[60vh] place-items-center overflow-hidden rounded-xl bg-black">
            {url.error ? (
              <div className="p-6">
                <ErrorAlert error={url.error} />
              </div>
            ) : !url.data ? (
              <Skeleton className="aspect-video w-full" />
            ) : asset.kind === 'video' ? (
              <video src={url.data.url} controls playsInline className="max-h-[60vh] w-full" poster={asset.thumbnailUrl ?? undefined} />
            ) : (
              <img src={url.data.url} alt={asset.name} className="max-h-[60vh] object-contain" />
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <Meta label="Type" value={asset.contentType} />
            <Meta label="Size" value={formatBytes(asset.size)} />
            <Meta label="Dimensions" value={asset.width && asset.height ? `${asset.width} × ${asset.height} (${ratioLabel(asset.width, asset.height)})` : 'Unknown'} />
            <Meta label={asset.kind === 'video' ? 'Length' : 'Uploaded'} value={asset.kind === 'video' ? formatDuration(asset.durationMs) || 'Unknown' : formatDateTime(asset.createdAt)} />
          </dl>
          <div className="flex flex-wrap gap-2">
            <Badge tone="good">Stored in R2</Badge>
            <Badge tone="neutral">Not uploaded to Meta yet. That happens when you publish.</Badge>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}

