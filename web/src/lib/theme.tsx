import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

interface ThemeCtx {
  choice: ThemeChoice;
  resolved: 'light' | 'dark';
  setChoice: (c: ThemeChoice) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const KEY = 'acc-theme';

function readSaved(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Light / dark / follow-system. The user's own choice wins over the panel default from Settings. */
export function ThemeProvider({ children, panelDefault = 'system' }: { children: ReactNode; panelDefault?: ThemeChoice }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readSaved() ?? panelDefault);
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    if (!readSaved()) setChoiceState(panelDefault);
  }, [panelDefault]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSysDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const resolved: 'light' | 'dark' = choice === 'system' ? (sysDark ? 'dark' : 'light') : choice;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* private mode: theme still works for this visit */
    }
  }, []);

  const toggle = useCallback(() => setChoice(resolved === 'dark' ? 'light' : 'dark'), [resolved, setChoice]);

  return <Ctx.Provider value={{ choice, resolved, setChoice, toggle }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTheme outside ThemeProvider');
  return c;
}
