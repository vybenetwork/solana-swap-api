export type PriceImpactTier = 'green' | 'yellow' | 'orange' | 'red';

export const PRICE_IMPACT_TIER_CLASSES = [
  'price-impact--green',
  'price-impact--yellow',
  'price-impact--orange',
  'price-impact--red',
] as const;

export function parsePriceImpactPct(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(String(value).trim().replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

/** Tier bands: green ≥ −0.5%, yellow (−2, −0.5), orange (−10, −2], red ≤ −10%. */
export function priceImpactTier(pct: number): PriceImpactTier {
  if (pct >= -0.5) return 'green';
  if (pct > -2) return 'yellow';
  if (pct > -10) return 'orange';
  return 'red';
}

export function priceImpactTierClass(tier: PriceImpactTier): string {
  return `price-impact--${tier}`;
}

export function priceImpactTierClassForValue(value: unknown): string | null {
  const pct = parsePriceImpactPct(value);
  if (pct == null) return null;
  return priceImpactTierClass(priceImpactTier(pct));
}

export function applyPriceImpactTierClass(el: HTMLElement, value: unknown): void {
  el.classList.remove(...PRICE_IMPACT_TIER_CLASSES);
  const cls = priceImpactTierClassForValue(value);
  if (cls) el.classList.add(cls);
}

export function clearPriceImpactTierClass(el: HTMLElement): void {
  el.classList.remove(...PRICE_IMPACT_TIER_CLASSES);
}
