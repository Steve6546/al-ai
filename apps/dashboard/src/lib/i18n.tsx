/**
 * The interface language: Arabic (the product's default) and English.
 *
 * Two rules shape this module:
 *
 * 1. **One dictionary, two directions.** Every string that switches is a key
 *    in `messages`. Arabic and English sit side by side so a missing
 *    translation is a type error, not a sentence that silently stays Arabic.
 *    `dir` is derived from the language, never stored separately, so the text
 *    direction and the layout direction cannot disagree.
 *
 * 2. **Applied before the first paint.** `public/theme-boot.js` reads the same
 *    storage key and sets `<html lang dir>` while the document is parsing.
 *    React then keeps it in sync. A stored choice therefore never flashes the
 *    wrong direction on reload, and the server preference (which wins across
 *    devices) is applied as soon as `/api/me/preferences` answers.
 *
 * The provider has a safe fallback: a component rendered without one (many of
 * the existing unit tests do exactly that) gets Arabic, the default, instead
 * of throwing. That keeps the tests that read Arabic copy meaningful.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { de } from "./i18n.de";
import { en } from "./i18n.en";
import { ar } from "./i18n.ar";
import type { TranslationKey } from "./i18n.en";

export type { TranslationKey } from "./i18n.en";

export type Language = "ar" | "en" | "de";

export const LANGUAGE_STORAGE_KEY = "al-ai.language";
export const DEFAULT_LANGUAGE: Language = "ar";

export const LANGUAGES: { value: Language; label: { ar: string; en: string }; dir: "rtl" | "ltr" }[] = [
  { value: "ar", label: { ar: "العربية", en: "Arabic" }, dir: "rtl" },
  { value: "en", label: { ar: "الإنجليزية", en: "English" }, dir: "ltr" },
  { value: "de", label: { ar: "الألمانية", en: "German" }, dir: "ltr" }
];

/* Dictionaries live in ./i18n.en, ./i18n.ar and ./i18n.de. This module owns
 * language state, interpolation and the React provider only. */

export const messages: Record<Language, Record<TranslationKey, string>> = { ar, en, de };

export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** Replaces `{name}` placeholders without a template engine. */
export function translate(language: Language, key: TranslationKey, values?: Record<string, string | number>): string {
  const template = messages[language][key] ?? messages.ar[key] ?? key;
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}

export function dirFor(language: Language): "rtl" | "ltr" {
  return language === "ar" ? "rtl" : "ltr";
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isLanguage(value: unknown): value is Language {
  // Every language the picker offers must survive a reload. This list and
  // `LANGUAGES` are one fact in two places: when German was added to the
  // picker and to `messages` but not here, choosing it was accepted for the
  // session and silently reverted to Arabic on the next load.
  return value === "ar" || value === "en" || value === "de";
}

/** The last language this device used, or Arabic. */
export function readStoredLanguage(storage: Pick<Storage, "getItem"> | null = safeStorage()): Language {
  if (!storage) return DEFAULT_LANGUAGE;
  try {
    const value = storage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(value) ? value : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function writeStoredLanguage(
  language: Language,
  storage: Pick<Storage, "setItem"> | null = safeStorage()
) {
  if (!storage) return;
  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    /* A blocked store must not stop the switch; it just will not survive a reload. */
  }
}

/** Puts the language and direction on the document. */
export function applyLanguage(language: Language, root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement) {
  if (!root) return;
  root.lang = language;
  root.dir = dirFor(language);
  root.dataset.language = language;
}

export type I18nValue = {
  language: Language;
  dir: "rtl" | "ltr";
  t: Translate;
  setLanguage: (language: Language) => void;
};

const I18nContext = createContext<I18nValue | null>(null);

/**
 * The same value on every render.
 *
 * A fresh `t` per render is harmless until a screen puts `t` in an effect's
 * dependencies — then every render refetches, every fetch sets state, and the
 * screen never settles. The fallback is a constant, not a factory.
 */
const FALLBACK_I18N: I18nValue = {
  language: DEFAULT_LANGUAGE,
  dir: "rtl",
  t: (key, values) => translate(DEFAULT_LANGUAGE, key, values),
  setLanguage: () => undefined
};

export function I18nProvider({
  children,
  initialLanguage
}: {
  children: ReactNode;
  initialLanguage?: Language;
}) {
  const [language, setLanguageState] = useState<Language>(() => initialLanguage ?? readStoredLanguage());

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    writeStoredLanguage(next);
    applyLanguage(next);
  }, []);

  useEffect(() => {
    applyLanguage(language);
  }, [language]);

  const value = useMemo<I18nValue>(
    () => ({
      language,
      dir: dirFor(language),
      t: (key, values) => translate(language, key, values),
      setLanguage
    }),
    [language, setLanguage]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * The fallback is Arabic on purpose: a component used outside the provider
 * (a focused test, or a story) must still render real copy, and Arabic is the
 * product's default language.
 */
export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (context) return context;
  return FALLBACK_I18N;
}

/** Navigation text for a view, resolved in the active language. */
export function navText(t: Translate, view: string): { label: string; hint: string } {
  const labelKey = `nav.${view}.label` as TranslationKey;
  const hintKey = `nav.${view}.hint` as TranslationKey;
  return {
    label: messages.ar[labelKey] ? t(labelKey) : t("nav.dashboard.label"),
    hint: messages.ar[hintKey] ? t(hintKey) : t("nav.dashboard.hint")
  };
}
