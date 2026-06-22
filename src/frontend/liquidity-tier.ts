export type PoolLiquidityTier = 'red' | 'yellow' | 'green';

export const POOL_LIQUIDITY_TIER_CLASSES = [
  'pool-liquidity--red',
  'pool-liquidity--yellow',
  'pool-liquidity--green',
] as const;

/** Tier bands: red < $1K, yellow $1K–$5K, green > $5K. */
export function poolLiquidityTier(usd: number): PoolLiquidityTier {
  if (usd < 1000) return 'red';
  if (usd <= 5000) return 'yellow';
  return 'green';
}

export function poolLiquidityTierClassForValue(usd: number | undefined): string | null {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return null;
  return `pool-liquidity--${poolLiquidityTier(usd)}`;
}
