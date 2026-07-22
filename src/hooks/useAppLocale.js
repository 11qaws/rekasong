import { useCallback, useEffect, useState } from 'react';

export const APP_LOCALE_STORAGE_KEY = 'rekasong.locale';
export const APP_LOCALES = Object.freeze(['ko', 'en']);

export function normalizeAppLocale(value) {
  const locale = String(value || '').trim().toLowerCase().split('-')[0];
  return APP_LOCALES.includes(locale) ? locale : 'ko';
}

function initialLocale() {
  if (typeof window === 'undefined') return 'ko';
  try {
    const stored = window.localStorage.getItem(APP_LOCALE_STORAGE_KEY);
    if (stored) return normalizeAppLocale(stored);
  } catch {
    // Storage may be unavailable in privacy-restricted browser sources.
  }
  return normalizeAppLocale(window.navigator?.language);
}

function applyLocale(locale) {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, locale);
  } catch {
    // The in-memory selection still works for this page lifetime.
  }
}

export function useAppLocale() {
  const [locale, setLocaleState] = useState(initialLocale);

  useEffect(() => {
    applyLocale(locale);
  }, [locale]);

  const setLocale = useCallback((value) => {
    const next = normalizeAppLocale(value);
    applyLocale(next);
    setLocaleState(next);
  }, []);

  return { locale, setLocale };
}
