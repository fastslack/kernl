/**
 * Format integer cents to decimal string (e.g., 1999 → "19.99").
 */
export function formatCents(cents: number, currency?: string): string {
  const value = (cents / 100).toFixed(2);
  return currency ? `${value} ${currency}` : value;
}
