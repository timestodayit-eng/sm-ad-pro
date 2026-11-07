import { CalendarDays, Check, ChevronDown, ChevronUp, Columns3, GripVertical } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Input, cx } from '../components/ui';

// ---------- date filter ----------

export type Preset = 'today' | 'yesterday' | 'today_yesterday' | '7d' | '14d' | '30d' | 'this_month' | 'last_month' | 'custom';
export const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'today_yesterday', label: 'Today & yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: '14d', label: 'Last 14 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
];
/** How far back the panel keeps daily results. Must match HISTORY_DAYS on the server. */
export const HISTORY_DAYS = 90;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface PeriodState { preset: Preset; since?: string; until?: string }

/** The selected period lives in the URL (?period=7d or ?period=custom&since=…&until=…) so it survives reloads and links. */
export function usePeriod(fallback: Preset) {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('period') as Preset | null;
  const since = sp.get('since') ?? undefined;
  const until = sp.get('until') ?? undefined;
  let period: PeriodState = { preset: fallback };
  if (raw === 'custom' && since && until && DATE_RE.test(since) && DATE_RE.test(until) && since <= until) period = { preset: 'custom', since, until };
  else if (raw && raw !== 'custom' && PRESETS.some((p) => p.value === raw)) period = { preset: raw };
  const qs = period.preset === 'custom' ? `period=custom&since=${period.since}&until=${period.until}` : `period=${period.preset}`;
  const set = (p: PeriodState) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('period', p.preset);
        if (p.preset === 'custom' && p.since && p.until) {
          next.set('since', p.since);
          next.set('until', p.until);
        } else {
          next.delete('since');
          next.delete('until');
        }
        return next;
      },
      { replace: true },
    );
  return { period, qs, set };
}

export const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const fmtRange = (r?: { since: string; until: string } | null) => (!r ? '' : r.since === r.until ? fmtDay(r.since) : `${fmtDay(r.since)} – ${fmtDay(r.until)}`);
export const periodLabel = (p: PeriodState) => (p.preset === 'custom' ? 'Custom range' : PRESETS.find((x) => x.value === p.preset)!.label);

const chip = (on: boolean) =>
  cx('inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-sm font-medium transition', on ? 'border-brand bg-brand text-white shadow-card' : 'border-line bg-surface text-ink-2 hover:border-ink-3 hover:text-ink');

export function DateFilter({ period, onChange, range }: { period: PeriodState; onChange: (p: PeriodState) => void; range?: { since: string; until: string } | null }) {
  const [open, setOpen] = useState(period.preset === 'custom');
  const today = localDate();
  const min = shift(today, -(HISTORY_DAYS - 1));
  const [from, setFrom] = useState(period.since ?? range?.since ?? shift(today, -6));
  const [to, setTo] = useState(period.until ?? range?.until ?? today);
  useEffect(() => {
    if (period.preset === 'custom') {
      setFrom(period.since!);
      setTo(period.until!);
    }
  }, [period.preset, period.since, period.until]);
  const valid = DATE_RE.test(from) && DATE_RE.test(to) && from <= to;
  const changed = period.preset !== 'custom' || from !== period.since || to !== period.until;
  return (
    <div className="min-w-0">
      <div role="radiogroup" aria-label="Date range" className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.value} role="radio" aria-checked={period.preset === p.value} className={chip(period.preset === p.value)} onClick={() => { setOpen(false); onChange({ preset: p.value }); }}>
            {p.label}
          </button>
        ))}
        <button role="radio" aria-checked={period.preset === 'custom'} aria-expanded={open} className={chip(period.preset === 'custom' || open)} onClick={() => setOpen((o) => !o)}>
          <CalendarDays className="size-3.5" /> Custom
        </button>
      </div>
      {open && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onChange({ preset: 'custom', since: from, until: to });
          }}
        >
          <label className="text-xs font-medium text-ink-3">
            From
            <Input type="date" className="mt-1 h-9 w-[10.5rem]" min={min} max={to || today} value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="text-xs font-medium text-ink-3">
            To
            <Input type="date" className="mt-1 h-9 w-[10.5rem]" min={from || min} max={today} value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <Button type="submit" size="sm" disabled={!valid || !changed}>Apply</Button>
          <span className="pb-2 text-xs text-ink-3">Up to the last {HISTORY_DAYS} days.</span>
        </form>
      )}
    </div>
  );
}

// ---------- table preferences ----------

export const COLUMN_KEYS = ['spend', 'leads', 'calls', 'messages', 'results', 'ctr', 'cpc', 'running', 'budget', 'trend', 'synced'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export type SortKey = 'custom' | 'name' | ColumnKey;
export interface DashboardPrefs {
  columns: { key: ColumnKey; visible: boolean }[];
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
}
export const HIDDEN_BY_DEFAULT: ColumnKey[] = ['cpc'];

/** Saved columns first in their saved order, then any column added in a later release, in its default place. */
export function normaliseColumns(saved: DashboardPrefs['columns']): DashboardPrefs['columns'] {
  const seen = new Set<string>();
  const out = saved.filter((c) => COLUMN_KEYS.includes(c.key) && !seen.has(c.key) && seen.add(c.key));
  for (const k of COLUMN_KEYS) if (!seen.has(k)) out.push({ key: k, visible: !HIDDEN_BY_DEFAULT.includes(k) });
  return out;
}

export function move<T>(xs: T[], from: number, to: number): T[] {
  if (to < 0 || to >= xs.length || from === to) return xs;
  const out = xs.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

// ---------- small popover ----------

export function Popover({ button, children, label }: { button: (p: { open: boolean; toggle: () => void }) => ReactNode; children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div role="dialog" aria-label={label} className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-line bg-surface p-2 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}

export function ColumnsMenu({ columns, labels, onChange }: { columns: DashboardPrefs['columns']; labels: Record<ColumnKey, string>; onChange: (c: DashboardPrefs['columns']) => void }) {
  return (
    <Popover
      label="Columns"
      button={({ open, toggle }) => (
        <Button variant="secondary" size="sm" icon={<Columns3 className="size-3.5" />} aria-expanded={open} onClick={toggle}>
          Columns
        </Button>
      )}
    >
      <div className="px-2 pt-1 pb-2 text-xs text-ink-3">Tick to show. Use the arrows to change the order.</div>
      <ul className="max-h-[60vh] overflow-y-auto">
        {columns.map((c, i) => (
          <li key={c.key} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-2">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-sm text-ink">
              <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={c.visible} onChange={() => onChange(columns.map((x) => (x.key === c.key ? { ...x, visible: !x.visible } : x)))} />
              {labels[c.key]}
            </label>
            <IconBtn label={`Move ${labels[c.key]} up`} disabled={i === 0} onClick={() => onChange(move(columns, i, i - 1))}><ChevronUp className="size-4" /></IconBtn>
            <IconBtn label={`Move ${labels[c.key]} down`} disabled={i === columns.length - 1} onClick={() => onChange(move(columns, i, i + 1))}><ChevronDown className="size-4" /></IconBtn>
          </li>
        ))}
      </ul>
      <div className="mt-1 border-t border-line px-2 pt-2">
        <button className="text-xs font-medium text-brand hover:underline" onClick={() => onChange(normaliseColumns([]))}>Reset columns</button>
      </div>
    </Popover>
  );
}

export function IconBtn({ label, children, onClick, disabled }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-30">
      {children}
    </button>
  );
}

export { Check, GripVertical };
