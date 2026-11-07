import { ArrowRight, Construction } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card } from '../components/ui';
import { useI18n } from '../lib/i18n';
import type { NavItem } from '../lib/nav';
import { usePageTitle } from '../lib/session';

/**
 * Honest placeholder for a module that is not built yet. It says which phase it ships in and what it
 * will do, and offers only links that work today (spec: no nonfunctional buttons, no sample data).
 */
export function ComingSoonPage({ item }: { item: NavItem }) {
  const { t } = useI18n();
  usePageTitle(t(item.label));
  const Icon = item.icon;
  return (
    <div className="mx-auto max-w-2xl py-6">
      <Card className="overflow-hidden">
        <div className="brand-soft flex items-center gap-4 px-6 py-6">
          <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-surface text-brand shadow-card">
            <Icon className="size-7" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-ink">{t(item.label)}</h1>
              {item.phase && <Badge tone="neutral">Phase {item.phase}</Badge>}
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-2">
              <Construction className="size-4" /> Not built yet
            </p>
          </div>
        </div>
        <div className="space-y-5 px-6 py-6">
          <div>
            <h2 className="text-sm font-semibold text-ink">What this page will do</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{item.summary}</p>
          </div>
          <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">
            This page is empty on purpose. It will never show sample campaigns, made-up spend or placeholder buttons. It switches on when the
            feature is built and tested against real Meta data.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to="/accounts">
              <Button variant="secondary" icon={<ArrowRight className="size-4" />}>
                {t('adAccounts')}
              </Button>
            </Link>
            <Link to="/health">
              <Button variant="ghost">{t('health')}</Button>
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
