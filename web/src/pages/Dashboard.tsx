import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';
import { LiveDashboard } from './Live';

export function DashboardPage() {
  const { t, lang } = useI18n();
  const { me } = useSession();
  usePageTitle(t('dashboard'));
  const hour = new Date().getHours();
  const greet = lang === 'bn' ? (hour < 12 ? 'শুভ সকাল' : hour < 18 ? 'শুভ অপরাহ্ন' : 'শুভ সন্ধ্যা') : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return <LiveDashboard greeting={`${greet}, ${me?.user.name.split(' ')[0] ?? ''}`} />;
}
