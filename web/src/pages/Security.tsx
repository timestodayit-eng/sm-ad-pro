import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, KeyRound, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, ErrorAlert, Field, Input, PageHeader, Skeleton, formatDateTime } from '../components/ui';
import { get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';

interface Status {
  enabled: boolean;
  enabledAt: string | null;
  required: boolean;
  recoveryCodesLeft: number;
}

export function SecurityPage() {
  usePageTitle('Security');
  const { me } = useSession();
  const status = useQuery({ queryKey: ['2fa'], queryFn: () => get<Status>('/auth/2fa') });
  const [codes, setCodes] = useState<string[] | null>(null);
  const forced = Boolean(me?.mfa?.setupRequired);

  return (
    <>
      <PageHeader title="Security" description="Two-step login protects the panel even if someone learns your password." />
      {forced && !codes && (
        <div className="mb-6">
          <Alert tone="warn" title="Set up two-step login to continue">
            Admins and Super Admins must use two-step login, because they can connect ad accounts and publish. It takes about a minute.
          </Alert>
        </div>
      )}
      {status.error && <ErrorAlert error={status.error} />}
      {status.isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : status.data?.enabled ? (
        <EnabledCard s={status.data} onNewCodes={setCodes} />
      ) : (
        <SetupCard onEnabled={setCodes} />
      )}
    </>
  );
}

function SetupCard({ onEnabled }: { onEnabled: (codes: string[]) => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const setup = useMutation({ mutationFn: () => post<{ secret: string; otpauthUrl: string; qrSvg: string }>('/auth/2fa/setup') });
  const enable = useMutation({
    mutationFn: () => post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code }),
    onSuccess: (r) => {
      onEnabled(r.recoveryCodes);
      qc.invalidateQueries({ queryKey: ['2fa'] });
    },
  });

  return (
    <Card>
      <CardHeader icon={<Smartphone className="size-4" />} title="Turn on two-step login" description="Use Google Authenticator, Microsoft Authenticator, Authy or any app that shows 6-digit codes." />
      <div className="p-5">
        {!setup.data ? (
          <div className="space-y-4">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
              <li>Install an authenticator app on your phone if you don't have one.</li>
              <li>Press the button below and scan the QR code with the app.</li>
              <li>Type the 6-digit code the app shows.</li>
            </ol>
            {setup.error && <ErrorAlert error={setup.error} />}
            <Button onClick={() => setup.mutate()} loading={setup.isPending} icon={<ShieldCheck className="size-4" />}>
              Show QR code
            </Button>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-[220px_1fr]">
            <div>
              {/* The SVG comes from our own server (qrcode library), not from user input. */}
              <div className="rounded-xl bg-white p-3" aria-label="QR code for your authenticator app" role="img" dangerouslySetInnerHTML={{ __html: setup.data.qrSvg }} />
              <div className="mt-3 text-xs text-ink-3">Can't scan? Enter this key in the app:</div>
              <code className="mt-1 block rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-xs break-all text-ink" data-testid="totp-secret">
                {setup.data.secret}
              </code>
            </div>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                enable.mutate();
              }}
            >
              <Field label="6-digit code from the app" htmlFor="totp" hint="The code changes every 30 seconds. If it is rejected, check the phone's time is set automatically.">
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
                  className="max-w-[180px] text-center font-mono text-lg tracking-[0.3em]"
                  autoFocus
                />
              </Field>
              {enable.error && <ErrorAlert error={enable.error} />}
              <Button type="submit" loading={enable.isPending} disabled={code.replace(/\s/g, '').length !== 6} icon={<Check className="size-4" />}>
                Turn on
              </Button>
            </form>
          </div>
        )}
      </div>
    </Card>
  );
}

function EnabledCard({ s, onNewCodes }: { s: Status; onNewCodes: (codes: string[]) => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'none' | 'codes' | 'off'>('none');
  const regen = useMutation({ mutationFn: () => post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { code }), onSuccess: (r) => onNewCodes(r.recoveryCodes) });
  const off = useMutation({ mutationFn: () => post('/auth/2fa/disable', { password, code }), onSuccess: () => qc.invalidateQueries({ queryKey: ['2fa'] }) });

  return (
    <Card>
      <CardHeader
        icon={<ShieldCheck className="size-4" />}
        title={
          <span className="flex items-center gap-2">
            Two-step login <Badge tone="good">On</Badge>
          </span>
        }
        description={s.enabledAt ? `Turned on ${formatDateTime(s.enabledAt)}` : undefined}
      />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <KeyRound className="size-4 text-ink-3" />
          <span className="text-ink">
            {s.recoveryCodesLeft} of 10 recovery codes left
          </span>
          {s.recoveryCodesLeft <= 3 && <Badge tone="warn">Get new codes soon</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode(mode === 'codes' ? 'none' : 'codes')}>
            Get new recovery codes
          </Button>
          {!s.required && (
            <Button variant="ghost" onClick={() => setMode(mode === 'off' ? 'none' : 'off')}>
              Turn off
            </Button>
          )}
        </div>
        {s.required && <p className="text-xs text-ink-3">Your role must keep two-step login on. Lost your phone? Sign in with a recovery code, or ask another Super Admin to reset it from Settings → Users.</p>}
        {mode !== 'none' && (
          <form
            className="max-w-sm space-y-3 rounded-xl border border-line p-4"
            onSubmit={(e) => {
              e.preventDefault();
              mode === 'codes' ? regen.mutate() : off.mutate();
            }}
          >
            {mode === 'off' && (
              <Field label="Password" htmlFor="pw-off">
                <Input id="pw-off" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            )}
            <Field label="Current 6-digit code" htmlFor="code-confirm">
              <Input id="code-confirm" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" />
            </Field>
            {(regen.error || off.error) && <ErrorAlert error={regen.error ?? off.error} />}
            <Button type="submit" variant={mode === 'off' ? 'danger' : 'primary'} loading={regen.isPending || off.isPending}>
              {mode === 'codes' ? 'Replace my recovery codes' : 'Turn off two-step login'}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { refresh } = useSession();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const text = `Recovery codes for ${location.host}\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
    setSaved(true);
  };
  return (
    <Card>
      <CardHeader icon={<ShieldAlert className="size-4" />} title="Save your recovery codes" description="If you lose your phone, each of these codes lets you sign in once. This is the only time they are shown." />
      <div className="space-y-4 p-5">
        <ul className="grid max-w-md grid-cols-2 gap-2 rounded-xl bg-surface-2 p-4 font-mono text-sm text-ink" data-testid="recovery-codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Download className="size-4" />} onClick={download}>
            Download
          </Button>
          <Button
            variant="secondary"
            icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            onClick={async () => {
              await navigator.clipboard.writeText(text).catch(() => undefined);
              setCopied(true);
              setSaved(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-4 accent-[var(--brand)]" />
          I have saved these codes somewhere safe
        </label>
        <Button
          disabled={!saved}
          onClick={async () => {
            await refresh();
            onDone();
          }}
        >
          Done
        </Button>
      </div>
    </Card>
  );
}
