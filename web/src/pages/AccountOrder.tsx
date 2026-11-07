import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, ClipboardList, GripVertical } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Button, ErrorAlert, Modal, Skeleton, cx } from '../components/ui';
import { get, put } from '../lib/api';
import { IconBtn, move } from './liveControls';

export interface OrderAccount { id: number; accountId: string; name: string; currency: string; businessName?: string | null }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Match pasted lines (one account per line, extra text such as a budget after a tab is fine) to accounts.
 * Tries the exact name, then the name at the start of the line, then the line at the start of a name,
 * then a short code like "DE 154", then the numeric ad account ID. Each account is used once.
 */
export function matchPasted(text: string, accounts: OrderAccount[]) {
  const used = new Set<number>();
  const matched: OrderAccount[] = [];
  const missed: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.split('\t')[0]).map((l) => l.replace(/^\s*\d+[.)]\s+/, '')).filter((l) => l.trim());
  for (const raw of lines) {
    const line = norm(raw);
    const free = accounts.filter((a) => !used.has(a.id));
    const code = line.match(/^[a-z]+[ -]?\d+/)?.[0];
    const digits = line.replace(/^act_/, '').match(/\d{6,}/)?.[0];
    const tries: ((a: OrderAccount) => boolean)[] = [
      (a) => norm(a.name) === line,
      (a) => line.startsWith(norm(a.name)),
      (a) => norm(a.name).startsWith(line),
      (a) => !!code && new RegExp(`^${code.replace(/[ -]/, '[ -]?')}(\\D|$)`).test(norm(a.name)),
      (a) => !!digits && a.accountId === digits,
    ];
    let hit: OrderAccount | undefined;
    for (const t of tries) {
      const found = free.filter(t);
      if (found.length === 1) { hit = found[0]; break; }
      if (found.length > 1) {
        // Prefer the longest name that fits, so "DE 15" does not take "DE 154".
        const best = found.sort((x, y) => y.name.length - x.name.length)[0];
        if (t === tries[1]) { hit = best; break; }
      }
    }
    if (hit) { used.add(hit.id); matched.push(hit); } else missed.push(raw.trim());
  }
  return { matched, missed, rest: accounts.filter((a) => !used.has(a.id)) };
}

/** Arrange the working accounts. With `subset`, only those accounts move, among the places they already hold. */
export function AccountOrderEditor({ open, onClose, subset, title }: { open: boolean; onClose: () => void; subset?: number[]; title?: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['account-order'], queryFn: () => get<{ items: OrderAccount[] }>('/accounts/order'), enabled: open });
  const [list, setList] = useState<OrderAccount[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [missed, setMissed] = useState<string[]>([]);
  const key = subset?.join(',');
  useEffect(() => {
    if (!open || !q.data) return;
    const keep = subset ? new Set(subset) : null;
    setList(q.data.items.filter((a) => !keep || keep.has(a.id)));
    setPasting(false); setText(''); setMissed([]);
  }, [open, q.data, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => put('/accounts/order', { accountIds: list.map((a) => a.id) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account-order'] });
      qc.invalidateQueries({ queryKey: ['live'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
  });
  const applyPaste = () => {
    const r = matchPasted(text, list);
    setList([...r.matched, ...r.rest]);
    setMissed(r.missed);
    setPasting(false);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={title ?? 'Account order'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={!list.length} onClick={() => save.mutate()}>Save order</Button>
        </>
      }
    >
      {q.isLoading ? <Skeleton className="h-72" /> : (
        <div className="space-y-3">
          {q.error && <ErrorAlert error={q.error} />}
          {save.error && <ErrorAlert error={save.error} />}
          <p className="text-sm text-ink-2">
            This order is used everywhere in the panel: the dashboard, Campaigns, and later publishing and budget changes. It is the same for everyone on your team.
            {subset && ' Only the accounts shown here move; the others keep their places.'}
          </p>
          {pasting ? (
            <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
              <label htmlFor="paste-order" className="text-sm font-medium text-ink">Paste your list, one account per line</label>
              <textarea
                id="paste-order"
                className="h-48 w-full rounded-lg border border-line bg-surface p-3 font-mono text-sm text-ink outline-none focus:border-brand"
                placeholder={'DE 154 DadExpress SM Enterprise\nDE 168 DadExpress SM Enterprise\nDE 179 DadExpress SM Enterprise'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={!text.trim()} onClick={applyPaste}>Put in this order</Button>
                <Button size="sm" variant="secondary" onClick={() => setPasting(false)}>Cancel</Button>
                <span className="text-xs text-ink-3">Names, short codes like “DE 154”, or ad account IDs all work. Anything after a tab is ignored.</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-ink-3">Drag a row, or use the arrows.</span>
              <Button size="sm" variant="secondary" icon={<ClipboardList className="size-3.5" />} onClick={() => setPasting(true)}>Paste a list</Button>
            </div>
          )}
          {missed.length > 0 && (
            <Alert tone="warn" title={`${missed.length} line${missed.length === 1 ? '' : 's'} did not match a working account`}>
              {missed.slice(0, 8).join(' · ')}{missed.length > 8 ? ' …' : ''}. Those accounts may not be added yet; add them in Settings, then paste again.
            </Alert>
          )}
          <ol className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {list.map((a, i) => (
              <li
                key={a.id}
                draggable
                onDragStart={(e) => { setDragging(a.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  if (dragging == null || dragging === a.id) return;
                  e.preventDefault();
                  setList((l) => move(l, l.findIndex((x) => x.id === dragging), i));
                }}
                onDrop={(e) => e.preventDefault()}
                className={cx('flex items-center gap-2 bg-surface px-3 py-2', dragging === a.id && 'opacity-40')}
              >
                <GripVertical className="size-4 shrink-0 cursor-grab text-ink-3" aria-hidden />
                <span className="w-7 shrink-0 text-right text-xs text-ink-3 tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{a.name}</span>
                  <span className="block truncate text-xs text-ink-3">act_{a.accountId} · {a.currency}</span>
                </span>
                <IconBtn label={`Move ${a.name} up`} disabled={i === 0} onClick={() => setList((l) => move(l, i, i - 1))}><ChevronUp className="size-4" /></IconBtn>
                <IconBtn label={`Move ${a.name} down`} disabled={i === list.length - 1} onClick={() => setList((l) => move(l, i, i + 1))}><ChevronDown className="size-4" /></IconBtn>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
