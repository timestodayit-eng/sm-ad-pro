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
      { to: '/advanced-ads', label: 'advancedAds', icon: SlidersHorizontal, phase: 5, summary: 'Every Marketing API control that the pinned API version supports, validated against Employment special-ad-category rules, with per-account overrides.' },
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
      { to: '/audiences', label: 'audiences', icon: Target, phase: 5, summary: 'Broad, Advantage+, saved, custom and lookalike audiences, filtered automatically by the Employment category restrictions.' },
      { to: '/placements', label: 'placements', icon: Layers, phase: 5, summary: 'Automatic or manual placements (Feeds, Stories, Reels, Messenger, Audience Network), showing only combinations Meta accepts.' },
      { to: '/media', label: 'media', icon: Film, perm: 'media.read' },
    ],
  },
  {
    label: 'grpAI',
    items: [
      { to: '/copilot', label: 'copilot', icon: Bot, phase: 7, summary: 'Ask in Bengali, Banglish or English. Answers come from your real synced data through permission-checked tools; every change is previewed and needs your approval.' },
      { to: '/ai-analytics', label: 'aiAnalytics', icon: BrainCircuit, phase: 6, summary: 'Diagnostic findings with evidence, likely causes and confidence, plus budget proposals calculated by code, not guessed by the model.' },
      { to: '/documents', label: 'aiDocuments', icon: FileText, phase: 8, summary: 'Editable, section-based, versioned reports built from your data, exported as PDF and Word.' },
    ],
  },
  {
    label: 'grpReports',
    items: [
      { to: '/reports', label: 'reports', icon: BarChart3, phase: 6, summary: 'Any accounts, dimensions, metrics and date ranges, with saved templates, schedules and CSV/XLSX/PDF export. No 12-account or 250-ad limits.' },
      { to: '/finance', label: 'finance', icon: Wallet, phase: 6, summary: 'Spend by account, currency and period, with BDT conversion at a stated, dated rate.' },
      { to: '/monitoring', label: 'monitoring', icon: Radar, phase: 7, summary: 'Scheduled analyses and alerts: spend spikes, rejected ads, stalled delivery, expiring tokens.' },
    ],
  },
  {
    label: 'grpSystem',
    items: [
      { to: '/comments', label: 'comments', icon: MessageSquare, phase: 9, summary: 'Read, reply to and hide Page comments where Meta permits, with AI reply suggestions that need approval before sending.' },
      { to: '/notifications', label: 'notifications', icon: Bell },
      { to: '/health', label: 'health', icon: Activity },
      { to: '/settings', label: 'settings', icon: Settings },
    ],
  },
];

export const ALL_ITEMS = NAV.flatMap((g) => g.items);
export const DashboardIcon = Gauge;
