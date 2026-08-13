/**
 * i18n for extension page bundles.
 *
 * The dashboard shell owns the real locale (services/dashboard/src/lib/i18n),
 * but extension pages are self-contained ES modules: they cannot import the
 * host's store, and ExtPageContext only hands them `locale` as a string
 * snapshot taken at mount time. Two consequences this module fixes:
 *
 *   1. Every extension page that wants translated copy would otherwise invent
 *      its own lookup. This is that lookup, once.
 *   2. A page mounted before the user switches language never hears about it —
 *      the host does not remount ext views on locale change. `createI18n`
 *      subscribes to the `locale` event the shell broadcasts on the kernl:
 *      event bus, so a running page re-renders in the new language.
 *
 * Dictionaries stay inside the extension that owns them: the shell's catalogue
 * knows nothing about, say, cinema's copy, and shipping cinema's strings in the
 * shell bundle would make every other page pay for them.
 *
 * Usage:
 *
 *   const { t, locale, destroy } = createI18n({
 *     initial: ctx.locale,
 *     events: ctx.events,
 *     dicts: { en, es },
 *   });
 *   onDestroy(destroy);
 *   // in markup: {$t('some.key')} / {$t('n.results', { n: 12 })}
 *
 * Adding a language is dropping one more dictionary into `dicts`. Nothing in
 * the markup changes.
 */
import { writable, derived, get, type Readable } from "svelte/store";

/** A flat key → copy map. Flat on purpose: one lookup, no path walking. */
export type Dict = Record<string, string>;

export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface ExtI18n {
  /** Active locale code, e.g. "es". */
  locale: Readable<string>;
  /** Translate store — use as `$t('key')` in markup. */
  t: Readable<Translate>;
  /** Switch locale from inside the page (rarely needed; the shell drives it). */
  setLocale(loc: string): void;
  /** Detach the host locale listener. Call from onDestroy. */
  destroy(): void;
}

export interface CreateI18nOptions {
  /** Locale to start in — normally `ctx.locale`. */
  initial?: string;
  /** Available dictionaries, keyed by locale code. */
  dicts: Record<string, Dict>;
  /**
   * Locale used when the active one has no entry for a key. Defaults to "en",
   * matching the shell's own fallback chain.
   */
  fallback?: string;
  /** `ctx.events` — subscribed to so shell locale switches reach this page. */
  events?: { on(evt: string, cb: (detail: any) => void): () => void };
}

/**
 * Substitute `{name}` placeholders. Kept deliberately dumber than an ICU
 * formatter: these dictionaries are UI chrome, and a plural-rules engine would
 * cost more bundle than every string it formats.
 */
function interpolate(
  text: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export function createI18n(opts: CreateI18nOptions): ExtI18n {
  const { dicts, events } = opts;
  const fallback = opts.fallback ?? "en";

  /**
   * An unknown locale resolves to the fallback rather than rendering raw keys.
   * The shell supports eight locales but an extension may only ship two, and a
   * page reading "header.count" at the user is worse than one reading English.
   */
  function resolve(loc: string | undefined): string {
    if (loc && dicts[loc]) return loc;
    if (loc) {
      // "pt-BR" → "pt". The shell already splits this, but ctx.locale is a
      // plain string and nothing guarantees who wrote it.
      const base = loc.split("-")[0];
      if (dicts[base]) return base;
    }
    return dicts[fallback] ? fallback : Object.keys(dicts)[0] ?? fallback;
  }

  const locale = writable<string>(resolve(opts.initial));

  const t = derived(locale, ($locale): Translate => {
    const primary = dicts[$locale];
    const secondary = dicts[fallback];
    return (key, params) =>
      interpolate(primary?.[key] ?? secondary?.[key] ?? key, params);
  });

  // The shell broadcasts `kernl:locale` with { locale } whenever the user
  // switches language. Without this a mounted page keeps its mount-time copy
  // until the user navigates away and back.
  let off: (() => void) | null = null;
  if (events) {
    off = events.on("locale", (detail: { locale?: string } | string) => {
      const next = typeof detail === "string" ? detail : detail?.locale;
      if (!next) return;
      const resolved = resolve(next);
      if (resolved !== get(locale)) locale.set(resolved);
    });
  }

  return {
    locale,
    t,
    setLocale(loc: string) {
      locale.set(resolve(loc));
    },
    destroy() {
      off?.();
      off = null;
    },
  };
}
