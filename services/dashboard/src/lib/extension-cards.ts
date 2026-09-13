/**
 * The marketplace card: what its price chip says, what its button offers, and
 * how a category or a sync time is written.
 *
 * Extracted verbatim from `routes/extensions/+page.svelte`. Everything that
 * read component state stayed there, except `actionFor`, which is the most
 * consequential decision on that page — it now takes what it needs as an
 * argument and the page passes it in.
 *
 * Note `fmtRelative` here is NOT the same as `display-format.ts`'s
 * `fmtRelTime`: different thresholds and different words ("never" / "just now"
 * vs "—" / "5s ago"). They serve different tables and are kept apart on
 * purpose.
 */

/** The card fields these functions actually read. */
export interface PricedCard {
  slug: string;
  status: CardStatus;
  priceCents: number;
  currency: string;
  priceId?: string | null;
  updateAvailable?: boolean;
  version: string;
}

export type CardStatus =
  | 'installed' | 'active' | 'disabled' | 'error'
  | 'for_sale' | 'owned' | 'available' | string;

/** Is this status one of the four that mean "already on this machine"? */
export const isInstalledStatus = (s: CardStatus): boolean =>
  s === 'installed' || s === 'active' || s === 'disabled' || s === 'error';

/** "web-intel" → "Web intel". Blank input reads as "Uncategorised". */
export function categoryLabel(c: string): string {
  const s = (c || 'uncategorised').replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Localized money, or "Free" at zero. Falls back when the currency is unknown. */
export function fmtMoney(cents: number, currency: string): string {
  if (!cents) return 'Free';
  const amount = cents / 100;
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${whole ? amount.toFixed(0) : amount.toFixed(2)}`;
  }
}

/** Split a formatted price into currency symbol and digits for the big numeral. */
export function priceParts(cents: number, currency: string): { sym: string; num: string } {
  const formatted = fmtMoney(cents, currency);
  const m = /^([^\d]*)(.*)$/.exec(formatted);
  return { sym: (m?.[1] ?? '').trim(), num: m?.[2] ?? formatted };
}

/** The price chip on a card. Paid-but-unpriced must never read as "Free". */
export function priceBadge(vm: Pick<PricedCard, 'status' | 'priceCents' | 'currency'>): string {
  if (vm.status === 'owned') return '✓ Owned';
  if (vm.priceCents > 0) return fmtMoney(vm.priceCents, vm.currency);
  return 'PAID';
}

/** The price line from an installed extension's manifest. */
export function fmtPrice(m: {
  pricing?: { model?: string; amount_cents: number; currency: string } | null;
} | null | undefined): string {
  if (!m?.pricing || m.pricing.model === 'free') return 'FREE';
  const amount = (m.pricing.amount_cents / 100).toFixed(0);
  const suffix = m.pricing.model === 'subscription' ? '/mo' : '';
  return `${m.pricing.currency} ${amount}${suffix}`;
}

/** Last-sync wording for the repos table. "never" when it has not run. */
export function fmtRelative(isoTs: string | null): string {
  if (!isoTs) return 'never';
  const ms = Date.now() - new Date(isoTs).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

/** What the page knows about a card beyond the card itself. */
export interface CardActionContext {
  /** An in-flight purchase for this slug, if any. */
  purchase?: { state: string } | null;
  /** Is an install running for this slug right now? */
  installing?: boolean;
  /** Can the store be reached? A Buy button is dead without it. */
  storeReachable?: boolean;
}

export interface CardAction {
  label: string;
  disabled: boolean;
  kind: 'buy' | 'get' | 'update' | 'manage' | 'pricing';
}

/**
 * What the card's primary button says and does.
 *
 * The `for_sale` branch is the careful one: with no resolvable price — an older
 * store, an unpublished item, or Stripe being down — it sends the user to the
 * pricing page rather than showing a Buy button that cannot charge, or worse,
 * labelling a paid item "Free".
 */
export function actionForCard(vm: PricedCard, ctx: CardActionContext = {}): CardAction {
  const purchase = ctx.purchase;
  if (purchase && (purchase.state === 'pending' || purchase.state === 'paid')) {
    return {
      label: purchase.state === 'paid' ? 'Installing…' : 'Waiting for payment…',
      disabled: true,
      kind: 'buy',
    };
  }
  if (ctx.installing) return { label: 'Installing…', disabled: true, kind: 'get' };
  if (vm.updateAvailable) return { label: `Update to v${vm.version}`, disabled: false, kind: 'update' };
  if (vm.status === 'for_sale') {
    if (!vm.priceId || vm.priceCents <= 0) {
      return { label: 'See pricing', disabled: false, kind: 'pricing' };
    }
    return { label: `${fmtMoney(vm.priceCents, vm.currency)} · Buy`, disabled: !ctx.storeReachable, kind: 'buy' };
  }
  if (vm.status === 'owned') return { label: 'Install', disabled: false, kind: 'get' };
  if (vm.status === 'available') return { label: 'Install', disabled: false, kind: 'get' };
  return { label: 'Manage', disabled: false, kind: 'manage' };
}
