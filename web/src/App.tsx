import { Compass, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Button, EmptyState, ErrorAlert } from './components/ui';
import { ALL_ITEMS } from './lib/nav';
import { useSession } from './lib/session';
import { AccountsPage } from './pages/Accounts';
import { BalancePage } from './pages/Balance';
import { BudgetsPage } from './pages/Budgets';
import { CampaignsPage } from './pages/Campaigns';
import { AccountGroupsPage } from './pages/Groups';
import { LoginPage, SetupPage } from './pages/Auth';
import { ComingSoonPage } from './pages/ComingSoon';
import { AdvancedAdsPage, EasyAdsPage } from './pages/EasyAds';
import { AudiencesPage } from './pages/Audiences';
import { PlacementsPage } from './pages/Placements';
import { ReportsPage } from './pages/Reports';
import { FinancePage } from './pages/Finance';
import { MonitoringPage } from './pages/Monitoring';
import { CommentsPage } from './pages/Comments';
import { PublishingPage } from './pages/Publishing';
import { CopilotPage } from './pages/Copilot';
import { AiAnalyticsPage } from './pages/AiAnalytics';
import { AiDocumentsPage } from './pages/AiDocuments';
import { DashboardPage } from './pages/Dashboard';
import { HealthPage } from './pages/Health';
import { LiveAccountPage } from './pages/Live';
import { MediaPage } from './pages/Media';
import { SecurityPage } from './pages/Security';
import { NotificationsPage } from './pages/Notifications';
import { SettingsPage } from './pages/Settings';

function FullScreenLoader() {
  return (
    <div className="grid min-h-full place-items-center text-ink-3">
      <Loader2 className="size-6 animate-spin" aria-label="Loading" />
    </div>
  );
}

/** Sends people to /setup on a fresh install and to /login when signed out. */
function Guard({ children }: { children: ReactNode }) {
  const { bootstrap, me, loading } = useSession();
  const loc = useLocation();
  if (!bootstrap) return loading ? <FullScreenLoader /> : <BootError />;
  if (loading) return <FullScreenLoader />;
  if (bootstrap.setupRequired) return <Navigate to="/setup" replace />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  // Admins without two-step login can only set it up; the server enforces the same rule.
  if (me.mfa?.setupRequired && loc.pathname !== '/security') return <Navigate to="/security" replace />;
  return <Layout>{children}</Layout>;
}

function PublicOnly({ children, mode }: { children: ReactNode; mode: 'login' | 'setup' }) {
  const { bootstrap, me, loading } = useSession();
  if (!bootstrap) return loading ? <FullScreenLoader /> : <BootError />;
  if (loading) return <FullScreenLoader />;
  if (mode === 'setup' && !bootstrap.setupRequired) return <Navigate to={me ? '/' : '/login'} replace />;
  if (mode === 'login' && bootstrap.setupRequired) return <Navigate to="/setup" replace />;
  if (mode === 'login' && me) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const BUILT: Record<string, ReactNode> = {
  '/': <DashboardPage />,
  '/accounts': <AccountsPage />,
  '/account-groups': <AccountGroupsPage />,
  '/campaigns': <CampaignsPage />,
  '/easy-ads': <EasyAdsPage />,
  '/advanced-ads': <AdvancedAdsPage />,
  '/audiences': <AudiencesPage />,
  '/placements': <PlacementsPage />,
  '/reports': <ReportsPage />,
  '/finance': <FinancePage />,
  '/monitoring': <MonitoringPage />,
  '/comments': <CommentsPage />,
  '/publishing': <PublishingPage />,
  '/budgets': <BudgetsPage />,
  '/copilot': <CopilotPage />,
  '/ai-analytics': <AiAnalyticsPage />,
  '/documents': <AiDocumentsPage />,
  '/balance': <BalancePage />,
  '/notifications': <NotificationsPage />,
  '/health': <HealthPage />,
  '/media': <MediaPage />,
  '/settings': <SettingsPage />,
};

function NotFound() {
  return (
    <EmptyState
      icon={<Compass className="size-6" />}
      title="This page does not exist"
      action={
        <Link to="/">
          <Button>Back to dashboard</Button>
        </Link>
      }
    >
      The link may be old, or the address has a typo.
    </EmptyState>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly mode="login"><LoginPage /></PublicOnly>} />
      <Route path="/setup" element={<PublicOnly mode="setup"><SetupPage /></PublicOnly>} />
      {ALL_ITEMS.map((item) => (
        <Route key={item.to} path={item.to} element={<Guard>{BUILT[item.to] ?? <ComingSoonPage item={item} />}</Guard>} />
      ))}
      <Route path="/security" element={<Guard><SecurityPage /></Guard>} />
      <Route path="/live/:id" element={<Guard><LiveAccountPage /></Guard>} />
      <Route path="*" element={<Guard><NotFound /></Guard>} />
    </Routes>
  );
}

/** The public bootstrap failed (server down or unreachable): say so instead of spinning forever. */
function BootError() {
  return (
    <div className="mx-auto max-w-md p-8">
      <ErrorAlert error={new Error('The server did not answer. Check that the Node app is running in hPanel, then reload this page.')} />
    </div>
  );
}
