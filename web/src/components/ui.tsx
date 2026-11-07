import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ApiError } from '../lib/api';

export const cx = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cx(
          'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 select-none whitespace-nowrap',
          size === 'sm' && 'h-8 px-3 text-sm',
          size === 'md' && 'h-10 px-4 text-sm',
          size === 'lg' && 'h-11 px-5 text-[15px]',
          variant === 'primary' && 'bg-brand text-white shadow-card hover:brightness-110 active:brightness-95',
          variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-surface-2',
          variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          variant === 'danger' && 'bg-bad text-white hover:brightness-110',
          className,
        )}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
        {children}
      </button>
    );
  },
);

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('rounded-2xl border border-line bg-surface shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="brand-soft mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl text-brand">{icon}</div>}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand';

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone === 'good' && 'bg-good-bg text-good',
        tone === 'warn' && 'bg-warn-bg text-warn',
        tone === 'bad' && 'bg-bad-bg text-bad',
        tone === 'info' && 'bg-info-bg text-info',
        tone === 'neutral' && 'bg-surface-3 text-ink-2',
        tone === 'brand' && 'brand-soft text-brand',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      className={cx(
        'inline-block size-2 rounded-full',
        tone === 'good' && 'bg-good',
        tone === 'warn' && 'bg-warn',
        tone === 'bad' && 'bg-bad',
        tone === 'info' && 'bg-info',
        (tone === 'neutral' || tone === 'brand') && 'bg-ink-3',
      )}
      aria-hidden
    />
  );
}

export function Alert({ tone = 'info', title, children, action }: { tone?: 'good' | 'warn' | 'bad' | 'info'; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : tone === 'bad' ? XCircle : Info;
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cx(
        'flex gap-3 rounded-xl border px-4 py-3 text-sm',
        tone === 'good' && 'border-good/25 bg-good-bg',
        tone === 'warn' && 'border-warn/25 bg-warn-bg',
        tone === 'bad' && 'border-bad/25 bg-bad-bg',
        tone === 'info' && 'border-info/25 bg-info-bg',
      )}
    >
      <Icon className={cx('mt-0.5 size-4 shrink-0', { good: 'text-good', warn: 'text-warn', bad: 'text-bad', info: 'text-info' }[tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{title}</div>
        {children && <div className="mt-0.5 text-ink-2">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** Shows a server error the way the spec asks: real cause, hint, and a correlation ID to quote. */
export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error.body : { message: (error as Error)?.message ?? String(error), code: 'ERROR' };
  return (
    <Alert tone="bad" title={title ?? e.message}>
      {title && <div>{e.message}</div>}
      {'hint' in e && e.hint && <div className="mt-1">{e.hint}</div>}
      <div className="mt-1 font-mono text-xs text-ink-3">
        {e.code}
        {'correlationId' in e && e.correlationId ? ` · ref ${e.correlationId}` : ''}
      </div>
    </Alert>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-bad">{error}</p> : hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

const inputCls =
  'h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-3 transition focus:border-brand focus:outline-none focus:brand-ring aria-[invalid=true]:border-bad';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputCls, className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(inputCls, 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-surface-3', className)} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="brand-soft mb-4 grid size-12 place-items-center rounded-2xl text-brand">{icon}</div>}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function StatCard({ label, value, sub, icon, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium text-ink-2">{label}</div>
        {icon && (
          <div
            className={cx(
              'grid size-8 place-items-center rounded-lg',
              tone === 'good' ? 'bg-good-bg text-good' : tone === 'warn' ? 'bg-warn-bg text-warn' : tone === 'bad' ? 'bg-bad-bg text-bad' : 'brand-soft text-brand',
            )}
          >
            {icon}
          </div>
        )}
      </div>
      <div className="mt-3 text-[28px] font-semibold leading-none tracking-tight text-ink tabular-nums">{value}</div>
      {sub && <div className="mt-2 text-xs text-ink-3">{sub}</div>}
    </Card>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; icon?: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition',
            value === o.value ? 'bg-surface text-ink shadow-card' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function formatDateTime(v: string | Date | null | undefined, tz?: string) {
  if (!v) return 'Never';
  const d = new Date(v);
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(d);
}

export function timeAgo(v: string | Date | null | undefined) {
  if (!v) return 'never';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Accessible modal on the native <dialog> element (focus trap, Esc to close, backdrop click closes). */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/50', wide ? 'max-w-3xl' : 'max-w-md')}
    >
      {open && (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
