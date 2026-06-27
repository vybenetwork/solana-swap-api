/**
 * Resolve token spot prices for swap quotes and pair-card stats.
 * Primary source: Vybe. Fallback chain: hints/stablecoins → pump.fun → Jupiter.
 * Metadata may be cached on disk; `full` fetches all fields, `refresh-price` updates price only.
 */

import type { AxiosInstance } from 'axios';
import { getToken } from './tokens.js';
import { fetchJupiterTokenDetails } from './jupiter-token-fallback.js';
import { fetchPumpfunTokenDetails } from './pumpfun-price-fallback.js';
import { repairTokenIcon } from './resolve-token-meta.js';
import {
  NATIVE_SOL_MINT,
  WSOL_MINT,
  aliasSolPriceStats,
  dedupeMintsForPriceResolve,
  toVybeSwapMint,
} from './sol-mints.js';
import type { VybeToken } from '../types/api.js';
import {
  cacheTokenMetaFromVybe,
  getCachedTokenMetaFromDisk,
  hasCachedTokenIcon,
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

export type PriceResolveSource = 'Vybe' | 'Jupiter' | 'Pumpfun-API';

export interface TokenPriceStats {
  price: number;
  price1d?: number;
  price7d?: number;
  decimals: number;
  priceFetchedAt: number;
  priceUpdateTime?: number;
  source?: PriceResolveSource;
  logoUrl?: string;
  symbol?: string;
  name?: string;
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
    source?: PriceResolveSource;
    logoUrl?: string;
    symbol?: string;
    name?: string;
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
  if (entry.source) stats.source = entry.source;
  if (entry.logoUrl?.trim()) stats.logoUrl = entry.logoUrl.trim();
  if (entry.symbol?.trim()) stats.symbol = entry.symbol.trim();
  if (entry.name?.trim()) stats.name = entry.name.trim();
  return stats;
}

function metaFieldsFromDisk(mint: string): Pick<TokenPriceStats, 'logoUrl' | 'symbol' | 'name'> {
  const disk = getCachedTokenMetaFromDisk(mint);
  if (!disk) return {};
  return {
    logoUrl: disk.logoUrl,
    symbol: disk.symbol,
    name: disk.name,
  };
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

function solPriceUsdFromContext(
  hints: Record<string, TokenPriceHint>,
  stats: Record<string, TokenPriceStats>,
): number | undefined {
  for (const mint of [WSOL_MINT, NATIVE_SOL_MINT]) {
    const fromStats = stats[mint]?.price;
    if (typeof fromStats === 'number' && Number.isFinite(fromStats) && fromStats > 0) {
      return fromStats;
    }
    const hint = hints[mint];
    if (
      hint &&
      typeof hint.price === 'number' &&
      Number.isFinite(hint.price) &&
      hint.price > 0
    ) {
      return hint.price;
    }
  }
  return undefined;
}

async function jupiterFallbackStats(
  mint: string,
  hint: TokenPriceHint | undefined,
  disk: CachedTokenMeta | null,
  solPriceUsd: number | undefined,
): Promise<TokenPriceStats | null> {
  const decimalsHint = hint?.decimals ?? disk?.decimals;
  let details;
  try {
    details = await fetchJupiterTokenDetails(mint, {
      solPriceUsd,
      decimalsHint: typeof decimalsHint === 'number' ? decimalsHint : undefined,
    });
  } catch {
    return null;
  }
  if (!details) return null;

  const fetchedAt = Date.now();
  await cacheTokenMetaFromVybe(mint, {
    ...details.token,
    priceFetchedAt: fetchedAt,
  });
  if (!hasCachedTokenIcon(mint)) {
    await repairTokenIcon(mint);
  }

  return statsFromEntry({
    price: details.priceUsd,
    price1d: hint?.price1d ?? disk?.price1d,
    price7d: hint?.price7d ?? disk?.price7d,
    decimals: details.decimals,
    priceFetchedAt: fetchedAt,
    priceUpdateTime: hint?.priceUpdateTime ?? disk?.priceUpdateTime,
    source: 'Jupiter',
    ...metaFieldsFromDisk(mint),
  });
}

async function pumpfunFallbackStats(
  mint: string,
  hint: TokenPriceHint | undefined,
  disk: CachedTokenMeta | null,
  solPriceUsd: number | undefined,
): Promise<TokenPriceStats | null> {
  const decimalsHint = hint?.decimals ?? disk?.decimals;
  let details;
  try {
    details = await fetchPumpfunTokenDetails(mint, {
      solPriceUsd,
      decimalsHint: typeof decimalsHint === 'number' ? decimalsHint : undefined,
    });
  } catch {
    return null;
  }
  if (!details) return null;

  const fetchedAt = Date.now();
  await cacheTokenMetaFromVybe(mint, {
    ...details.token,
    priceFetchedAt: fetchedAt,
  });
  if (!hasCachedTokenIcon(mint)) {
    await repairTokenIcon(mint);
  }

  return statsFromEntry({
    price: details.priceUsd,
    price1d: hint?.price1d ?? disk?.price1d,
    price7d: hint?.price7d ?? disk?.price7d,
    decimals: details.decimals,
    priceFetchedAt: fetchedAt,
    priceUpdateTime:
      typeof details.token.updateTime === 'number' ? details.token.updateTime : hint?.priceUpdateTime ?? disk?.priceUpdateTime,
    source: 'Pumpfun-API',
    ...metaFieldsFromDisk(mint),
  });
}

async function resolveExternalPriceFallback(
  mint: string,
  hint: TokenPriceHint | undefined,
  disk: CachedTokenMeta | null,
  solPriceUsd: number | undefined,
): Promise<TokenPriceStats | null> {
  const pumpfun = await pumpfunFallbackStats(mint, hint, disk, solPriceUsd);
  if (pumpfun) return pumpfun;
  return jupiterFallbackStats(mint, hint, disk, solPriceUsd);
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
  const requestedMints = [...new Set(mints.map((m) => m.trim()).filter(Boolean))];
  const fetchMints = dedupeMintsForPriceResolve(requestedMints);
  const vybeMints = [...new Set(fetchMints.map((m) => toVybeSwapMint(m)))];
  const forceSet = new Set(
    dedupeMintsForPriceResolve(
      (options.forceFullDetailsMints ?? []).map((m) => m.trim()).filter(Boolean),
    ).map((m) => toVybeSwapMint(m)),
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
          stats[mint] = statsFromEntry({
            ...resolved,
            source: 'Vybe',
            ...metaFieldsFromDisk(mint),
          });
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

  let solPriceUsd = solPriceUsdFromContext(hints, stats);
  for (const mint of vybeMints) {
    if (stats[mint]) continue;
    const hint = hints[mint] ?? (mint !== NATIVE_SOL_MINT ? hints[NATIVE_SOL_MINT] : undefined);
    const disk = getCachedTokenMetaFromDisk(mint);
    if (!solPriceUsd) solPriceUsd = solPriceUsdFromContext(hints, stats);
    const external = await resolveExternalPriceFallback(mint, hint, disk, solPriceUsd);
    if (external) stats[mint] = external;
  }

  for (const originalMint of requestedMints) {
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

  return { stats: aliasSolPriceStats(stats) };
}
