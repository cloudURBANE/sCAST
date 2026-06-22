import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { de } from './locales/de';

// Dependency-free i18n. We deliberately avoid pulling in i18next/react-i18next:
// this app ships in a network-gated build environment where adding a dependency
// (and waiting out the workspace `minimumReleaseAge`) is a needless risk for what
// is a small, well-understood pattern — a locale dictionary + a dotted-key lookup
// with `{var}` interpolation, behind a context. Adding a language is a drop-in:
// author a new locale file shaped like `en`, register it in LOCALES below, and
// add its code to the picker — no other code changes.

export const LOCALES = { en, es, fr, de } as const;

export type Locale = keyof typeof LOCALES;

/** Recursively replaces string leaves with `string`, so a translated locale can
 *  hold different text while being forced to match English's key structure. */
type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

/** The canonical shape every locale must satisfy — derived from English. */
export type TranslationTree = DeepStringify<typeof en>;

export const SUPPORTED_LOCALES: Locale[] = ['en', 'es', 'fr', 'de'];

export const DEFAULT_LOCALE: Locale = 'en';

// Native endonyms for the picker, so each language reads in its own script.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
};

const STORAGE_KEY = 'scent_locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as Locale);
}

/** Resolve the best supported locale from a BCP-47 tag like `es-419` → `es`. */
function normalizeTag(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.toLowerCase().split('-')[0];
  return isLocale(base) ? base : null;
}

function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* storage unavailable — fall through to navigator detection */
  }
  const navLocales = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  for (const tag of navLocales) {
    const match = normalizeTag(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/** Walk a dotted path (`"settings.title"`) through a nested object. */
function lookup(tree: unknown, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((node, key) => {
    if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
      return (node as Record<string, unknown>)[key];
    }
    return undefined;
  }, tree);
  return typeof value === 'string' ? value : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  // Keep <html lang> in sync for accessibility / SEO and so the browser applies
  // language-aware behaviours (hyphenation, quotes, speech). The no-flash inline
  // script in index.html sets the initial value; this keeps it correct on change.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return;
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  }, []);

  const t = useCallback<TranslateFn>(
    (key, vars) => {
      // Active locale → English fallback → the key itself (so a missing string is
      // visible and debuggable, never a blank).
      const hit = lookup(LOCALES[locale], key) ?? lookup(LOCALES[DEFAULT_LOCALE], key);
      return interpolate(hit ?? key, vars);
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useTranslation must be used within an I18nProvider');
  return ctx;
}
