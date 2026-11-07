import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Bengali / English UI labels. Bengali is the default for this agency; users can switch any time. */
export type Lang = 'bn' | 'en';

const dict = {
  dashboard: { en: 'Dashboard', bn: 'ড্যাশবোর্ড' },
  easyAds: { en: 'Easy Ads', bn: 'সহজ বিজ্ঞাপন' },
  advancedAds: { en: 'Advanced Ads', bn: 'অ্যাডভান্সড বিজ্ঞাপন' },
  publishing: { en: 'Publishing Center', bn: 'পাবলিশিং সেন্টার' },
  campaigns: { en: 'Campaigns', bn: 'ক্যাম্পেইন' },
  adAccounts: { en: 'Ad Accounts', bn: 'অ্যাড অ্যাকাউন্ট' },
  accountGroups: { en: 'Account Groups', bn: 'অ্যাকাউন্ট গ্রুপ' },
  audiences: { en: 'Audience Manager', bn: 'অডিয়েন্স' },
  placements: { en: 'Placements', bn: 'প্লেসমেন্ট' },
  media: { en: 'Media Library', bn: 'মিডিয়া লাইব্রেরি' },
  copilot: { en: 'AI Ads Copilot', bn: 'AI কোপাইলট' },
  aiAnalytics: { en: 'AI Analytics', bn: 'AI অ্যানালিটিক্স' },
  aiDocuments: { en: 'AI Documents', bn: 'AI ডকুমেন্টস' },
  reports: { en: 'Custom Reports', bn: 'কাস্টম রিপোর্ট' },
  finance: { en: 'Finance', bn: 'ফাইন্যান্স' },
  monitoring: { en: 'Monitoring', bn: 'মনিটরিং' },
  comments: { en: 'Comments', bn: 'কমেন্টস' },
  notifications: { en: 'Notifications', bn: 'নোটিফিকেশন' },
  health: { en: 'System Health', bn: 'সিস্টেম হেলথ' },
  settings: { en: 'Settings', bn: 'সেটিংস' },
  grpOverview: { en: 'Overview', bn: 'ওভারভিউ' },
  grpCreate: { en: 'Create', bn: 'তৈরি করুন' },
  grpManage: { en: 'Manage', bn: 'ম্যানেজ' },
  grpAI: { en: 'AI', bn: 'AI' },
  grpReports: { en: 'Reports', bn: 'রিপোর্ট' },
  grpSystem: { en: 'System', bn: 'সিস্টেম' },
  signIn: { en: 'Sign in', bn: 'সাইন ইন' },
  signOut: { en: 'Sign out', bn: 'সাইন আউট' },
  email: { en: 'Email', bn: 'ইমেইল' },
  password: { en: 'Password', bn: 'পাসওয়ার্ড' },
  welcome: { en: 'Welcome back', bn: 'আবার স্বাগতম' },
  lightMode: { en: 'Light', bn: 'লাইট' },
  darkMode: { en: 'Dark', bn: 'ডার্ক' },
  systemMode: { en: 'System', bn: 'সিস্টেম' },
  comingIn: { en: 'Coming in', bn: 'আসছে' },
  schedulerDown: { en: 'Background jobs are not running', bn: 'ব্যাকগ্রাউন্ড জব চলছে না' },
  viewDetails: { en: 'View details', bn: 'বিস্তারিত দেখুন' },
  save: { en: 'Save changes', bn: 'সেভ করুন' },
  saved: { en: 'Saved', bn: 'সেভ হয়েছে' },
  refresh: { en: 'Refresh', bn: 'রিফ্রেশ' },
  search: { en: 'Search', bn: 'খুঁজুন' },
} as const;

export type Key = keyof typeof dict;

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: Key) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({ children, initial = 'bn' }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const v = localStorage.getItem('acc-lang');
      return v === 'en' || v === 'bn' ? v : initial;
    } catch {
      return initial;
    }
  });
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem('acc-lang', l);
    } catch {
      /* ignore */
    }
  }, []);
  // Panel default arrives after the bootstrap loads; follow it until the user picks a language themselves.
  useEffect(() => {
    try {
      if (!localStorage.getItem('acc-lang')) setLangState(initial);
    } catch {
      setLangState(initial);
    }
  }, [initial]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const t = useCallback((k: Key) => dict[k][lang], [lang]);
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n outside I18nProvider');
  return c;
}
