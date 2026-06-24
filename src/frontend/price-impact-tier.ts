export type PriceImpactTier = 'green' | 'yellow-green' | 'yellow' | 'orange' | 'red';

export const PRICE_IMPACT_TIER_CLASSES = [
  'price-impact--green',
  'price-impact--yellow-green',
  'price-impact--yellow',
  'price-impact--orange',
  'price-impact--red',
] as const;

export function parsePriceImpactPct(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(String(value).trim().replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

const MICRO_IMPACT_DISPLAY_PCT = 0.01;

/** Snap sub-cent impacts to ±0.01% so −0.0006 shows as −0.01%, not −0.00%. */
export function displayPriceImpactPct(pct: number): number {
  if (pct > 0 && pct < MICRO_IMPACT_DISPLAY_PCT) return MICRO_IMPACT_DISPLAY_PCT;
  if (pct < 0 && pct > -MICRO_IMPACT_DISPLAY_PCT) return -MICRO_IMPACT_DISPLAY_PCT;
  return pct;
}

export function formatPriceImpactPctTwoDecimals(
  pct: number,
  options?: { leadingPlus?: boolean },
): string {
  const displayed = displayPriceImpactPct(pct);
  if (displayed === 0) return '0%';
  const sign = options?.leadingPlus && displayed > 0 ? '+' : '';
  return `${sign}${displayed.toFixed(2)}%`;
}

/** Route/market cards: 2 decimals below ±10%; whole percent at ±10% and beyond. */
export function formatPriceImpactPctRouteCard(
  pct: number,
  options?: { leadingPlus?: boolean },
): string {
  const displayed = displayPriceImpactPct(pct);
  if (displayed === 0) return '0%';
  const sign = options?.leadingPlus && displayed > 0 ? '+' : '';
  if (displayed >= 10 || displayed <= -10) {
    return `${sign}${Math.round(displayed)}%`;
  }
  return `${sign}${displayed.toFixed(2)}%`;
}

/** Tier bands: green ≥ 0, yellow-green [−0.5, 0), yellow (−2, −0.5), orange (−10, −2], red ≤ −10%. */
export function priceImpactTier(pct: number): PriceImpactTier {
  if (pct >= 0) return 'green';
  if (pct >= -0.5) return 'yellow-green';
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

/** Direction suffix: up when impact is positive, down when negative, none at zero. */
export function priceImpactArrowSuffix(pct: number): string {
  if (pct > 0) return ' ↑';
  if (pct < 0) return ' ↓';
  return '';
}

export function formatPriceImpactPctWithArrow(pct: number, formattedPct: string): string {
  return `${formattedPct}${priceImpactArrowSuffix(pct)}`;
}
