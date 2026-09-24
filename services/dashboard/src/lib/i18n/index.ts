import { writable, derived } from "svelte/store";
import en, { type I18nKey } from "./en.js";
import es from "./es.js";
import llmEn, { type LlmConnectKey } from "./llm-connect.en.js";
import llmEs from "./llm-connect.es.js";

export type Locale = "en" | "es" | "nl" | "de" | "fr" | "pt" | "ja" | "zh";

/** Every key `t()` has a string for: the dashboard dictionary plus the LLM-connect strings. */
export type TranslationKey = I18nKey | LlmConnectKey;
export type { I18nKey, LlmConnectKey };

/**
 * What `t()` accepts as a key K. A string literal — or a union of them, such
 * as `office.kind.${Kind}` over a literal union — must be a known key: any
 * other literal is a typo and fails to compile. A key only known at runtime
 * (typed `string`, or a template with a `string` hole like `nav.view.${id}`)
 * is let through and resolved at runtime, falling back to the raw key.
 */
type KeyArg<K extends string> = {} extends Record<K, 1> ? K : K extends TranslationKey ? K : TranslationKey;

export type Translate = <K extends string>(key: KeyArg<K>, params?: Record<string, string | number>) => string;

// Feature strings live in their own files so parallel work on en.ts/es.ts
// does not collide; they are merged here once.
const translations: Record<string, Record<string, string>> = { en: { ...en, ...llmEn }, es: { ...es, ...llmEs } };

/** Active locale. Defaults to "en" — same default as the backend
 *  (KernelConfig.language). */
export const locale = writable<Locale>("en");

/** Load a locale dynamically. */
export async function loadLocale(loc: Locale): Promise<void> {
  if (translations[loc]) {
    locale.set(loc);
    return;
  }
  try {
    const mod = await import(`./${loc}.js`);
    translations[loc] = mod.default;
    locale.set(loc);
  } catch {
    console.warn(`Locale "${loc}" not found, falling back to English`);
    locale.set("en");
  }
}

/** Translate. Fallback chain: active locale → en → raw key. */
export const t = derived(locale, ($locale): Translate => {
  return (key: string, params?: Record<string, string | number>): string => {
    let text = translations[$locale]?.[key] ?? translations.en?.[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  };
});

const SUPPORTED: Locale[] = ["en", "es", "nl", "de", "fr", "pt", "ja", "zh"];

function isLocale(v: string): v is Locale {
  return (SUPPORTED as string[]).includes(v);
}

/**
 * Resolve the startup locale:
 *   1. A locale the user picked manually (localStorage) always wins.
 *   2. Otherwise ask /api/config/public for the backend's language.
 *   3. Otherwise fall back to the browser locale.
 *   4. Default: "en".
 */
export async function initLocale(): Promise<void> {
  const saved = localStorage.getItem("kernel_locale");
  if (saved && isLocale(saved)) {
    await loadLocale(saved);
    return;
  }

  try {
    const res = await fetch("/api/config/public");
    if (res.ok) {
      const data = (await res.json()) as { language?: string };
      if (data.language && isLocale(data.language)) {
        await loadLocale(data.language);
        return;
      }
    }
  } catch {
    // Ignore — fall through to the browser locale.
  }

  const browser = navigator.language.split("-")[0];
  if (isLocale(browser)) {
    await loadLocale(browser);
    return;
  }
  await loadLocale("en");
}

/**
 * Switch the locale and persist it in localStorage as the user's preference.
 * Called from the language selector in settings.
 */
export async function setUserLocale(loc: Locale): Promise<void> {
  localStorage.setItem("kernel_locale", loc);
  await loadLocale(loc);
}
