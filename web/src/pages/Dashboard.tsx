import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, BarChart3, Building2, CheckCircle2, Clock, Link2, Rocket, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, PageHeader, Skeleton, StatCard, timeAgo } from '../components/ui';
import { get } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';

export function DashboardPage() {
  const { t, lang } = useI18n();
  const { me, branding } = useSession();
  usePageTitle(t('dashboard'));
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get('/dashboard/summary'), refetchInterval: 60_000 });
  const d = q.data;
  const hour = new Date().getHours();
  const greet = lang === 'bn' ? (hour < 12 ? 'শুভ সকাল' : hour < 18 ? 'শুভ অপরাহ্ন' : 'শুভ সন্ধ্যা') : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const noAccounts = d && d.accounts.total === 0;

  return (
    <>
      <PageHeader
        title={`${greet}, ${me?.user.name.split(' ')[0] ?? ''}`}
        description={lang === 'bn' ? 'আপনার সব Meta অ্যাড অ্যাকাউন্টের এক নজরে অবস্থা।' : 'Where all your Meta ad accounts stand, at a glance.'}
      />

      {q.error && <ErrorAlert error={q.error} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {q.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-2xl" />)
        ) : (
          <>
            <StatCard label="Connected ad accounts" value={d?.accounts.total ?? 0} icon={<Building2 className="size-4" />} sub={d?.accounts.lastSync ? `Last Meta sync ${timeAgo(d.accounts.lastSync)}` : 'Not synced yet'} />
            <StatCard label="Active accounts" value={d?.accounts.active ?? 0} tone="good" icon={<CheckCircle2 className="size-4" />} sub={d?.accounts.inactive ? `${d.accounts.inactive} disabled or restricted` : 'Account status from Meta'} />
            <StatCard
              label="Background jobs"
              value={d?.scheduler.state === 'running' ? 'Running' : d?.scheduler.state === 'stale' ? 'Stopped' : 'Not started'}
              tone={d?.scheduler.state === 'running' ? 'good' : 'bad'}
              icon={<Activity className="size-4" />}
              sub={d?.scheduler.lastSuccessAt ? `Last run ${timeAgo(d.scheduler.lastSuccessAt)}` : 'Cron job not detected yet'}
            />
            <StatCard label="Currencies" value={d?.accounts.currencies ?? 0} icon={<Clock className="size-4" />} sub="Spend is never added across currencies" />
          </>
        )}
      </div>

      {noAccounts && (
        <Card className="mt-6">
          <EmptyState
            icon={<Link2 className="size-6" />}
            title="Connect your Meta Business account"
            action={
              <Link to="/accounts">
                <Button icon={<ArrowRight className="size-4" />}>Go to Ad Accounts</Button>
              </Link>
            }
          >
            Sign in with Facebook Login for Business once, and every ad account you can access is imported automatically. There is no limit on the number of accounts.
          </EmptyState>
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Performance" description="Spend, results, CTR and CPC across your accounts" icon={<BarChart3 className="size-4" />} actions={<Badge tone="neutral">Phase 6</Badge>} />
          <div className="p-5">
            <Alert tone="info" title="No performance numbers yet, on purpose">
              {d?.performance?.reason ?? 'Insights sync is not built yet.'} Nothing here will ever show estimated or sample figures.
            </Alert>
          </div>
        </Card>

        <Card>
          <CardHeader title="Build progress" description="What works today and what comes next" icon={<Rocket className="size-4" />} />
          <ul className="divide-y divide-line">
            {[
              { label: 'Sign-in, roles, audit log', state: 'done' },
              { label: 'Branding, light and dark mode', state: 'done' },
              { label: 'Background scheduler', state: 'done' },
              { label: 'Meta connection and account import', state: 'pending', note: 'needs your Meta app' },
              { label: 'Media library (R2 uploads)', state: 'pending', note: 'needs your R2 keys' },
              { label: 'Two-step login for admins', state: 'done' },
              { label: 'Real paused publishing', state: 'next' },
            ].map((s) => (
              <li key={s.label} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="text-ink">{s.label}</span>
                {s.state === 'done' && <Badge tone="good">Built</Badge>}
                {s.state === 'pending' && <Badge tone="warn">{s.note}</Badge>}
                {s.state === 'next' && <Badge tone="brand">Next</Badge>}
                {s.state === 'later' && <Badge tone="neutral">{s.note}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
          <div className="brand-soft grid size-12 shrink-0 place-items-center rounded-2xl text-brand">
            <Sparkles className="size-6" />
          </div>
          <div className="flex-1">
            <div className="font-semibold text-ink">“আজকে আমার সব অ্যাকাউন্টের রেজাল্ট কী?”</div>
            <p className="mt-1 text-sm text-ink-2">
              Soon you will be able to ask {branding?.aiAssistantName ?? 'AI Ads Copilot'} this, and get an answer built from your real synced Meta data, with the sync time stated.
            </p>
          </div>
          <Badge tone="neutral">Phase 7</Badge>
        </div>
      </Card>
    </>
  );
}
