/**
 * Resolve token spot prices for swap quotes and pair-card stats.
 * Prices are always fetched from Vybe (never served from disk/TTL cache).
 * Metadata may be cached on disk; `full` fetches all fields, `refresh-price` updates price only.
 */

import type { AxiosInstance } from 'axios';
import { getToken } from './tokens.js';
import { NATIVE_SOL_MINT, toVybeSwapMint } from './sol-mints.js';
import type { VybeToken } from '../types/api.js';
import {
  cacheTokenMetaFromVybe,
  getCachedTokenMetaFromDisk,
  mergePriceFieldsOnly,
  type CachedTokenMeta,
} from '../token-icon-cache.js';

export interface TokenPriceHint {
  price?: number;
  price1d?: number;
  price7d?: number;
  decimals?: number;
  priceFetchedAt?: number;
  priceUpdateTime?: number;
  symbol?: string;
  name?: string;
}

export interface TokenPriceStats {
  price: number;
  price1d?: number;
  price7d?: number;
  decimals: number;
  priceFetchedAt: number;
  priceUpdateTime?: number;
}

export interface ResolveTokenPricesOptions {
  tokenHints?: Record<string, TokenPriceHint>;
  forceFullDetailsMints?: string[];
}

export interface ResolveTokenPricesResult {
  stats: Record<string, TokenPriceStats>;
}

type ResolveMode = 'full' | 'refresh-price';

function vybeDecimals(token: VybeToken): number | undefined {
  if (typeof token.decimals === 'number' && Number.isFinite(token.decimals)) return token.decimals;
  if (typeof token.decimal === 'number' && Number.isFinite(token.decimal)) return token.decimal;
  return undefined;
}

function hasSpotPriceStats(
  entry: { price?: number; price1d?: number; price7d?: number; decimals?: number } | null | undefined,
): entry is { price: number; decimals: number; price1d?: number; price7d?: number } {
  if (!entry) return false;
  const { price, decimals } = entry;
  return (
    typeof price === 'number' &&
    Number.isFinite(price) &&
    price > 0 &&
    typeof decimals === 'number' &&
    Number.isFinite(decimals)
  );
}

function statsFromEntry(
  entry: {
    price: number;
    price1d?: number;
    price7d?: number;
    decimals: number;
    priceFetchedAt?: number;
    priceUpdateTime?: number;
  },
): TokenPriceStats {
  const stats: TokenPriceStats = {
    price: entry.price,
    decimals: entry.decimals,
    priceFetchedAt: entry.priceFetchedAt ?? Date.now(),
    priceUpdateTime: entry.priceUpdateTime,
  };
  if (typeof entry.price1d === 'number' && Number.isFinite(entry.price1d) && entry.price1d > 0) {
    stats.price1d = entry.price1d;
  }
  if (typeof entry.price7d === 'number' && Number.isFinite(entry.price7d) && entry.price7d > 0) {
    stats.price7d = entry.price7d;
  }
  return stats;
}


function hintToStats(hint: TokenPriceHint): TokenPriceStats | null {
  const priceFetchedAt = hint.priceFetchedAt;
  const priceUpdateTime = hint.priceUpdateTime;
  if (!hasSpotPriceStats(hint)) return null;
  return statsFromEntry({
    price: hint.price!,
    price1d: hint.price1d,
    price7d: hint.price7d,
    decimals: hint.decimals!,
    priceFetchedAt,
    priceUpdateTime,
  });
}

function pickResolveMode(disk: CachedTokenMeta | null, forceFull: boolean): ResolveMode {
  if (forceFull) return 'full';
  // Metadata on disk is enough to refresh price fields only; price itself always comes from Vybe.
  return disk ? 'refresh-price' : 'full';
}

const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const STABLECOIN_USD_PRICE = 1;

function stablecoinFallbackStats(
  mint: string,
  hint: TokenPriceHint | undefined,
  disk: CachedTokenMeta | null,
): TokenPriceStats | null {
  if (!STABLECOIN_MINTS.has(mint)) return null;
  const decimals = hint?.decimals ?? disk?.decimals ?? 6;
  if (typeof decimals !== 'number' || !Number.isFinite(decimals)) return null;
  return statsFromEntry({
    price: STABLECOIN_USD_PRICE,
    price1d: hint?.price1d ?? disk?.price1d,
    price7d: hint?.price7d ?? disk?.price7d,
    decimals,
    priceFetchedAt: Date.now(),
    priceUpdateTime: hint?.priceUpdateTime ?? disk?.priceUpdateTime,
  });
}

function vybeToStats(token: VybeToken, fetchedAt: number): TokenPriceStats | null {
  const decimals = vybeDecimals(token);
  const price = typeof token.price === 'number' ? token.price : undefined;
  const price1d = typeof token.price1d === 'number' ? token.price1d : undefined;
  const price7d = typeof token.price7d === 'number' ? token.price7d : undefined;
  if (!hasSpotPriceStats({ price, price1d, price7d, decimals })) return null;
  return statsFromEntry({
    price: price!,
    price1d,
    price7d,
    decimals: decimals!,
    priceFetchedAt: fetchedAt,
    priceUpdateTime: typeof token.updateTime === 'number' ? token.updateTime : undefined,
  });
}

export async function resolveTokenPrices(
  http: AxiosInstance,
  mints: string[],
  options: ResolveTokenPricesOptions = {},
): Promise<ResolveTokenPricesResult> {
  const originalMints = [...new Set(mints.map((m) => m.trim()).filter(Boolean))];
  const vybeMints = [...new Set(originalMints.map((m) => toVybeSwapMint(m)))];
  const forceSet = new Set(
    (options.forceFullDetailsMints ?? []).map((m) => toVybeSwapMint(m.trim())).filter(Boolean),
  );
  const hints = options.tokenHints ?? {};
  const stats: Record<string, TokenPriceStats> = {};

  await Promise.all(
    vybeMints.map(async (mint) => {
      const hint = hints[mint] ?? (mint !== NATIVE_SOL_MINT ? hints[NATIVE_SOL_MINT] : undefined);
      const disk = getCachedTokenMetaFromDisk(mint);
      const mode = pickResolveMode(disk, forceSet.has(mint));

      try {
        const token = await getToken(http, mint);
        const fetchedAt = Date.now();

        if (mode === 'full') {
          const normalized: Record<string, unknown> = {
            ...token,
            decimals: vybeDecimals(token),
            price: token.price,
            price1d: token.price1d,
            price7d: token.price7d,
            priceUpdateTime: token.updateTime,
            priceFetchedAt: fetchedAt,
          };
          await cacheTokenMetaFromVybe(mint, normalized);
        } else {
          const merged = mergePriceFieldsOnly(mint, token as Record<string, unknown>, fetchedAt);
          if (!merged) {
            const normalized: Record<string, unknown> = {
              ...token,
              decimals: vybeDecimals(token),
              price: token.price,
              price1d: token.price1d,
              price7d: token.price7d,
              priceUpdateTime: token.updateTime,
              priceFetchedAt: fetchedAt,
            };
            await cacheTokenMetaFromVybe(mint, normalized);
          }
        }

        const resolved = vybeToStats(token, fetchedAt);
        if (resolved) {
          stats[mint] = resolved;
        } else {
          const fallback =
            hintToStats(hint ?? {}) ?? stablecoinFallbackStats(mint, hint, disk);
          if (fallback) stats[mint] = fallback;
        }
      } catch {
        const fallback =
          hintToStats(hint ?? {}) ?? stablecoinFallbackStats(mint, hint, disk);
        if (fallback) stats[mint] = fallback;
      }
    }),
  );

  for (const originalMint of originalMints) {
    const vybeMint = toVybeSwapMint(originalMint);
    if (stats[vybeMint] && !stats[originalMint]) {
      stats[originalMint] = stats[vybeMint]!;
    }
    if (!stats[originalMint]) {
      const hint = hints[originalMint];
      const disk = getCachedTokenMetaFromDisk(originalMint);
      const fallback = stablecoinFallbackStats(originalMint, hint, disk);
      if (fallback) stats[originalMint] = fallback;
    }
  }

  return { stats };
}
