/**
 * Shared token metadata shape for GET /api/token/:mint and resolve-prices stats.
 */

import {
  getCachedTokenMetaFromDisk,
  type CachedTokenMeta,
} from '../token-icon-cache.js';

export type PriceResolveSource = 'Vybe' | 'Jupiter' | 'Pumpfun-API';

/** Cached token meta exposed over HTTP (no internal fetchedAt; price fields required when resolved). */
export type ResolvedTokenMeta = Omit<CachedTokenMeta, 'fetchedAt' | 'price' | 'decimals' | 'priceFetchedAt'> & {
  price: number;
  decimals: number;
  priceFetchedAt: number;
  source?: PriceResolveSource;
};

export function cachedMetaToApiResponse(
  meta: CachedTokenMeta | null | undefined,
  source?: PriceResolveSource,
): Record<string, unknown> {
  if (!meta) return {};
  const { fetchedAt: _fetchedAt, ...out } = meta;
  if (source) return { ...out, source };
  return out;
}

/** Merge disk cache (Vybe / pump.fun / Jupiter) with resolved price fields for API stats. */
export function mergeResolvedTokenMeta(
  mint: string,
  partial: Partial<ResolvedTokenMeta> & Pick<ResolvedTokenMeta, 'price' | 'decimals' | 'priceFetchedAt'>,
): ResolvedTokenMeta {
  const disk = getCachedTokenMetaFromDisk(mint);
  if (disk) {
    const { fetchedAt: _fetchedAt, ...diskFields } = disk;
    return {
      ...diskFields,
      mint,
      price: partial.price,
      decimals: partial.decimals,
      priceFetchedAt: partial.priceFetchedAt,
      price1d: partial.price1d ?? diskFields.price1d,
      price7d: partial.price7d ?? diskFields.price7d,
      priceUpdateTime: partial.priceUpdateTime ?? diskFields.priceUpdateTime,
      source: partial.source ?? diskFields.priceSource,
      symbol: diskFields.symbol?.trim() || partial.symbol?.trim() || mint,
      name:
        diskFields.name?.trim() ||
        partial.name?.trim() ||
        diskFields.symbol?.trim() ||
        partial.symbol?.trim() ||
        mint,
      logoUrl: diskFields.logoUrl ?? partial.logoUrl,
    };
  }
  return {
    mint,
    symbol: partial.symbol?.trim() || mint,
    name: partial.name?.trim() || partial.symbol?.trim() || mint,
    price: partial.price,
    decimals: partial.decimals,
    priceFetchedAt: partial.priceFetchedAt,
    price1d: partial.price1d,
    price7d: partial.price7d,
    priceUpdateTime: partial.priceUpdateTime,
    source: partial.source,
    logoUrl: partial.logoUrl,
  };
}

export function symbolFromMetaCache(mint: string): string | undefined {
  const sym = getCachedTokenMetaFromDisk(mint)?.symbol?.replace(/\0/g, '').trim();
  return sym || undefined;
}

export function decimalsFromMetaCache(mint: string): number | undefined {
  const d = getCachedTokenMetaFromDisk(mint)?.decimals;
  return typeof d === 'number' && Number.isFinite(d) ? d : undefined;
}
