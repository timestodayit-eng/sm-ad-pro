import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  BrainCircuit,
  Building2,
  FileText,
  Film,
  FolderKanban,
  Gauge,
  LayoutDashboard,
  Landmark,
  Layers,
  type LucideIcon,
  Megaphone,
  MessageSquare,
  Radar,
  Rocket,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Target,
  Wallet,
} from 'lucide-react';
import type { Key } from './i18n';

export interface NavItem {
  to: string;
  label: Key;
  icon: LucideIcon;
  /** Present when the module is not built yet: the phase it ships in and what it will do. */
  phase?: number;
  summary?: string;
  perm?: string;
}

export interface NavGroup {
  label: Key;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { label: 'grpOverview', items: [{ to: '/', label: 'dashboard', icon: LayoutDashboard }] },
  {
    label: 'grpCreate',
    items: [
      { to: '/easy-ads', label: 'easyAds', icon: Sparkles },
      { to: '/advanced-ads', label: 'advancedAds', icon: SlidersHorizontal },
      { to: '/publishing', label: 'publishing', icon: Rocket },
    ],
  },
  {
    label: 'grpManage',
    items: [
      { to: '/campaigns', label: 'campaigns', icon: Megaphone, summary: 'All campaigns, ad sets and ads across your accounts with status, rejection reasons, approved budget and schedule changes, and a link to open each in Ads Manager.' },
      { to: '/budgets', label: 'budgets', icon: Wallet },
      { to: '/balance', label: 'balance', icon: Landmark },
      { to: '/accounts', label: 'adAccounts', icon: Building2 },
      { to: '/account-groups', label: 'accountGroups', icon: FolderKanban },
      { to: '/audiences', label: 'audiences', icon: Target },
      { to: '/placements', label: 'placements', icon: Layers },
      { to: '/media', label: 'media', icon: Film, perm: 'media.read' },
    ],
  },
  {
    label: 'grpAI',
    items: [
      { to: '/copilot', label: 'copilot', icon: Bot, perm: 'ai.use' },
      { to: '/ai-analytics', label: 'aiAnalytics', icon: BrainCircuit, perm: 'ai.use' },
      { to: '/documents', label: 'aiDocuments', icon: FileText, perm: 'reports.read' },
    ],
  },
  {
    label: 'grpReports',
    items: [
      { to: '/reports', label: 'reports', icon: BarChart3 },
      { to: '/finance', label: 'finance', icon: Wallet },
      { to: '/monitoring', label: 'monitoring', icon: Radar },
    ],
  },
  {
    label: 'grpSystem',
    items: [
      { to: '/comments', label: 'comments', icon: MessageSquare },
      { to: '/notifications', label: 'notifications', icon: Bell },
      { to: '/health', label: 'health', icon: Activity },
      { to: '/settings', label: 'settings', icon: Settings },
    ],
  },
];

export const ALL_ITEMS = NAV.flatMap((g) => g.items);
export const DashboardIcon = Gauge;
