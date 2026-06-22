import { useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useTranslation } from '@/i18n';
import { fetchPreferences } from '@/lib/preferences';

// Headless reconciler: when a user signs in, adopt their cross-device saved
// theme / accent / language (if any). localStorage already drove the first
// paint; this only corrects it to the account's stored choice. Tolerant of
// failure — an offline or pre-migration response leaves the local state intact.
export const PreferenceSync: React.FC = () => {
  const { authToken } = useAuth();
  const { setTheme, setAccent } = useTheme();
  const { setLocale } = useTranslation();

  useEffect(() => {
    if (!authToken) return;
    const controller = new AbortController();
    void fetchPreferences(authToken, controller.signal).then((prefs) => {
      if (controller.signal.aborted) return;
      if (prefs.theme) setTheme(prefs.theme);
      if (prefs.accent) setAccent(prefs.accent);
      if (prefs.locale) setLocale(prefs.locale);
    });
    return () => controller.abort();
  }, [authToken, setTheme, setAccent, setLocale]);

  return null;
};
