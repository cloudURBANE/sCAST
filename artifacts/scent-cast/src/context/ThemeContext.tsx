import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// Theme + accent are expressed entirely as CSS custom properties (see index.css):
// this provider only writes `data-theme` / `data-accent` onto <html> and lets the
// cascade do the rest. That keeps switching instant and flash-free, and means the
// default (dark + gold) renders identically with or without JS — the inline script
// in index.html sets the same attributes before first paint.

export type ThemeMode = 'dark' | 'light';
export type AccentName = 'gold' | 'green';

export const THEME_MODES: ThemeMode[] = ['dark', 'light'];
export const ACCENT_NAMES: AccentName[] = ['gold', 'green'];

const DEFAULT_THEME: ThemeMode = 'dark';
const DEFAULT_ACCENT: AccentName = 'gold';

const THEME_KEY = 'scent_theme';
const ACCENT_KEY = 'scent_accent';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light';
}
export function isAccentName(value: unknown): value is AccentName {
  return value === 'gold' || value === 'green';
}

function readStored<T>(key: string, guard: (v: unknown) => v is T, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return guard(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function applyToDocument(theme: ThemeMode, accent: AccentName): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-accent', accent);
  // Drives native form controls, scrollbars, and the UA default text/bg color.
  root.style.colorScheme = theme;
}

interface ThemeContextValue {
  theme: ThemeMode;
  accent: AccentName;
  setTheme: (next: ThemeMode) => void;
  setAccent: (next: AccentName) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => readStored(THEME_KEY, isThemeMode, DEFAULT_THEME));
  const [accent, setAccentState] = useState<AccentName>(() => readStored(ACCENT_KEY, isAccentName, DEFAULT_ACCENT));

  useEffect(() => {
    applyToDocument(theme, accent);
  }, [theme, accent]);

  const setTheme = useCallback((next: ThemeMode) => {
    if (!isThemeMode(next)) return;
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  }, []);

  const setAccent = useCallback((next: AccentName) => {
    if (!isAccentName(next)) return;
    setAccentState(next);
    try {
      window.localStorage.setItem(ACCENT_KEY, next);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, accent, setTheme, setAccent }),
    [theme, accent, setTheme, setAccent],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
