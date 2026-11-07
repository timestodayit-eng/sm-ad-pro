import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorAlert, PageHeader, Skeleton, cx, formatDateTime, timeAgo, type Tone } from '../components/ui';
import { get, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle } from '../lib/session';

interface Notification {
  id: number;
  severity: string;
  category: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

const TONE: Record<string, Tone> = { info: 'info', success: 'good', warning: 'warn', warn: 'warn', error: 'bad', critical: 'bad' };

export function NotificationsPage() {
  const { t } = useI18n();
  usePageTitle(t('notifications'));
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ items: Notification[] }>('/notifications') });
  const readAll = useMutation({
    mutationFn: () => post('/notifications/read-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const items = q.data?.items ?? [];
  const unread = items.filter((n) => !n.read_at).length;

  return (
    <>
      <PageHeader
        title={t('notifications')}
        description="Sync problems, expiring Meta tokens, failed jobs and finished work. Newest first."
        actions={
          unread > 0 ? (
            <Button variant="secondary" icon={<CheckCheck className="size-4" />} loading={readAll.isPending} onClick={() => readAll.mutate()}>
              Mark all {unread} as read
            </Button>
          ) : undefined
        }
      />
      {q.error && <ErrorAlert error={q.error} />}
      {readAll.error && <ErrorAlert error={readAll.error} />}
      <Card>
        {q.isLoading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Bell className="size-6" />} title="You are all caught up">
            When something needs your attention, such as an expiring Meta token or a failed sync, it appears here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((n) => (
              <li key={n.id} className={cx('flex gap-4 px-5 py-4', !n.read_at && 'bg-surface-2/60')}>
                <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-brand')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{n.title}</span>
                    <Badge tone={TONE[n.severity] ?? 'neutral'}>{n.category}</Badge>
                  </div>
                  {n.body && <p className="mt-1 text-sm text-ink-2">{n.body}</p>}
                  <div className="mt-1.5 flex items-center gap-3 text-xs text-ink-3">
                    <time dateTime={n.created_at} title={formatDateTime(n.created_at)}>
                      {timeAgo(n.created_at)}
                    </time>
                    {n.link && (
                      <Link to={n.link} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                        Open <ExternalLink className="size-3" />
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
