import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import { ApiError } from './lib/api';
import { I18nProvider } from './lib/i18n';
import { SessionProvider, useSession } from './lib/session';
import { ThemeProvider } from './lib/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Do not hammer the API on auth, permission or validation errors; retry real network blips once.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
      refetchOnWindowFocus: false,
    },
  },
});

/** Theme and language defaults come from the panel's branding settings; each user's own choice still wins. */
function Preferences({ children }: { children: ReactNode }) {
  const { branding } = useSession();
  return (
    <ThemeProvider panelDefault={branding?.defaultTheme ?? 'system'}>
      <I18nProvider initial={branding?.defaultLanguage ?? 'bn'}>{children}</I18nProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <Preferences>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </Preferences>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
