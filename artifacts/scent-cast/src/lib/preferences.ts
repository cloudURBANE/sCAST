import { isLocale, type Locale } from '@/i18n';
import { isAccentName, isThemeMode, type AccentName, type ThemeMode } from '@/context/ThemeContext';

// Thin client for the cross-device UI-preference endpoint (routes/me.ts).
// localStorage stays the instant, offline source of truth for switching; this
// just reconciles the choice across a signed-in user's devices.

export interface RemotePreferences {
  theme: ThemeMode | null;
  accent: AccentName | null;
  locale: Locale | null;
}

interface PreferencesUpdate {
  theme?: ThemeMode;
  accent?: AccentName;
  locale?: Locale;
}

/** GET the caller's saved preferences. Returns nulls (never throws) on any
 *  failure — offline, pre-migration 503, or abort — so callers keep local state. */
export async function fetchPreferences(
  authToken: string,
  signal?: AbortSignal,
): Promise<RemotePreferences> {
  const empty: RemotePreferences = { theme: null, accent: null, locale: null };
  try {
    const res = await fetch('/api/me/preferences', {
      headers: { Authorization: `Bearer ${authToken}` },
      signal,
    });
    if (!res.ok) return empty;
    const data = (await res.json()) as { preferences?: Record<string, unknown> } | null;
    const prefs = data?.preferences ?? {};
    return {
      theme: isThemeMode(prefs.theme) ? prefs.theme : null,
      accent: isAccentName(prefs.accent) ? prefs.accent : null,
      locale: isLocale(prefs.locale) ? prefs.locale : null,
    };
  } catch {
    return empty;
  }
}

/** Best-effort PUT of a partial preference change. Fire-and-forget: a failure
 *  never blocks the UI, which has already applied the change locally. */
export async function savePreferences(authToken: string, update: PreferencesUpdate): Promise<void> {
  try {
    await fetch('/api/me/preferences', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(update),
    });
  } catch {
    /* offline / pre-migration — local choice persists regardless */
  }
}
