/**
 * Cinema's dictionaries, bundled into the page.
 *
 * Adding a language is two lines here plus the file — nothing in Page.svelte
 * changes. The shell already declares en/es/nl/de/fr/pt/ja/zh as valid locales;
 * a locale the shell offers but cinema has not translated falls back to English
 * (see $shared/i18n), which is why this map can grow one language at a time
 * instead of all at once.
 */
import type { Dict } from "$shared/i18n";
import en from "./en.js";
import es from "./es.js";

export const dicts: Record<string, Dict> = { en, es };

/**
 * Content languages offered in the language filter, as ISO 639-1 codes. The
 * labels are NOT translated by hand: Intl.DisplayNames renders each one in the
 * user's own locale ("German" / "alemán"), so this list stays a list of codes
 * and never drifts out of sync with the dictionaries.
 */
export const CONTENT_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "ru",
] as const;

/**
 * Language name in the active UI locale, falling back to the raw code on
 * runtimes without Intl.DisplayNames (or for a code it does not know).
 */
export function languageName(code: string, locale: string): string {
  try {
    const dn = new Intl.DisplayNames([locale], { type: "language" });
    const name = dn.of(code);
    if (name && name !== code) {
      // Spanish and friends return lowercase ("alemán"); a select option reads
      // better capitalised, and English is already capitalised so this is a
      // no-op there.
      return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
    }
  } catch {
    /* Intl.DisplayNames unavailable — fall through to the code. */
  }
  return code.toUpperCase();
}
