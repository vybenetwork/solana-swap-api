/**
 * Resolve token spot prices for swap quotes and pair-card stats.
 * WSOL/stables: Vybe token-details → Jupiter → pump.fun.
 * Other mints: Jupiter → pump.fun → Vybe token-details.
 * Metadata may be cached on disk; `full` fetches all fields, `refresh-price` updates price only.
 */

import type { AxiosInstance } from 'axios';
import { getToken } from './tokens.js';
import { fetchJupiterTokenDetails } from './jupiter-token-fallback.js';
import { fetchPumpfunTokenDetails } from './pumpfun-price-fallback.js';
import { repairTokenIcon } from './resolve-token-meta.js';
import {
  mergeResolvedTokenMeta,
  type PriceResolveSource,
  type ResolvedTokenMeta,
} from './token-meta-api.js';
import {
  NATIVE_SOL_MINT,
  WSOL_MINT,
  dedupeMintsForPriceResolve,
  isSolMint,
  isStablecoinMint,
  isVybeFirstPriceMint,
  projectStatsToRequestedMints,
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

export type { PriceResolveSource } from './token-meta-api.js';
export type TokenPriceStats = ResolvedTokenMeta;

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
  mint: string,
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
  return mergeResolvedTokenMeta(mint, {
    price: entry.price,
    decimals: entry.decimals,
    priceFetchedAt: entry.priceFetchedAt ?? Date.now(),
    priceUpdateTime: entry.priceUpdateTime,
    price1d: entry.price1d,
    price7d: entry.price7d,
    source: entry.source,
    logoUrl: entry.logoUrl?.trim() || undefined,
    symbol: entry.symbol?.trim() || undefined,
    name: entry.name?.trim() || undefined,
  });
}

function metaFieldsFromDisk(
  mint: string,
): Partial<Pick<TokenPriceStats, 'logoUrl' | 'symbol' | 'name'>> {
  const disk = getCachedTokenMetaFromDisk(mint);
  if (!disk) return {};
  return {
    logoUrl: disk.logoUrl,
    symbol: disk.symbol,
    name: disk.name,
  };
}

function hintToStats(mint: string, hint: TokenPriceHint): TokenPriceStats | null {
  const { symbol, name, priceFetchedAt, priceUpdateTime } = hint;
  if (!hasSpotPriceStats(hint)) return null;
  return statsFromEntry(mint, {
    price: hint.price!,
    price1d: hint.price1d,
    price7d: hint.price7d,
    decimals: hint.decimals!,
    priceFetchedAt,
    priceUpdateTime,
    symbol,
    name,
  });
}

function pickResolveMode(disk: CachedTokenMeta | null, forceFull: boolean): ResolveMode {
  if (forceFull) return 'full';
  return disk ? 'refresh-price' : 'full';
}

/** Skip Vybe/network refresh when disk prices were resolved within this window (ms). */
export const RESOLVE_PRICE_TTL_MS = 2000;

function tryStatsFromFreshDisk(mint: string): TokenPriceStats | null {
  const disk = getCachedTokenMetaFromDisk(mint);
  if (!disk) return null;
  if (!(typeof disk.price === 'number' && disk.price > 0)) return null;
  if (!(typeof disk.decimals === 'number' && Number.isFinite(disk.decimals))) return null;
  const fetchedAt = disk.priceFetchedAt ?? 0;
  if (!fetchedAt || Date.now() - fetchedAt > RESOLVE_PRICE_TTL_MS) return null;
  return mergeResolvedTokenMeta(mint, {
    price: disk.price,
    decimals: disk.decimals,
    priceFetchedAt: fetchedAt,
    price1d: disk.price1d,
    price7d: disk.price7d,
    priceUpdateTime: disk.priceUpdateTime,
    source: disk.priceSource,
  });
}

const STABLECOIN_USD_PRICE = 1;

function stablecoinFallbackStats(
  mint: string,
  hint: TokenPriceHint | undefined,
  disk: CachedTokenMeta | null,
): TokenPriceStats | null {
  if (!isStablecoinMint(mint)) return null;
  const decimals = hint?.decimals ?? disk?.decimals ?? 6;
  if (typeof decimals !== 'number' || !Number.isFinite(decimals)) return null;
  return statsFromEntry(mint, {
    price: STABLECOIN_USD_PRICE,
    price1d: hint?.price1d ?? disk?.price1d,
    price7d: hint?.price7d ?? disk?.price7d,
    decimals,
    priceFetchedAt: Date.now(),
    priceUpdateTime: hint?.priceUpdateTime ?? disk?.priceUpdateTime,
    symbol: disk?.symbol,
    name: disk?.name,
    logoUrl: disk?.logoUrl,
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
): Promise<TokenPriceStats | null> {
  const decimalsHint = hint?.decimals ?? disk?.decimals;
  let details;
  try {
    details = await fetchJupiterTokenDetails(mint, {
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
    priceSource: 'Jupiter',
  });
  if (!hasCachedTokenIcon(mint)) {
    await repairTokenIcon(mint);
  }

  return statsFromEntry(mint, {
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
    priceSource: 'Pumpfun-API',
  });
  if (!hasCachedTokenIcon(mint)) {
    await repairTokenIcon(mint);
  }

  return statsFromEntry(mint, {
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

async function vybeTokenDetailsStats(
  http: AxiosInstance,
  mint: string,
  hint: TokenPriceHint | undefined,
  disk: CachedTokenMeta | null,
  mode: ResolveMode,
): Promise<TokenPriceStats | null> {
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
        priceSource: 'Vybe',
      };
      await cacheTokenMetaFromVybe(mint, normalized);
    } else {
      const merged = mergePriceFieldsOnly(
        mint,
        { ...(token as Record<string, unknown>), priceSource: 'Vybe' },
        fetchedAt,
      );
      if (!merged) {
        const normalized: Record<string, unknown> = {
          ...token,
          decimals: vybeDecimals(token),
          price: token.price,
          price1d: token.price1d,
          price7d: token.price7d,
          priceUpdateTime: token.updateTime,
          priceFetchedAt: fetchedAt,
          priceSource: 'Vybe',
        };
        await cacheTokenMetaFromVybe(mint, normalized);
      }
    }

    const resolved = vybeToStats(mint, token, fetchedAt);
    if (!resolved) return null;
    return statsFromEntry(mint, {
      ...resolved,
      source: 'Vybe',
      ...metaFieldsFromDisk(mint),
    });
  } catch {
    return null;
  }
}

async function resolveMintPriceStats(
  http: AxiosInstance,
  mint: string,
  hint: TokenPriceHint | undefined,
  options: { forceFull: boolean; solPriceUsd: number | undefined },
): Promise<TokenPriceStats | null> {
  const disk = getCachedTokenMetaFromDisk(mint);
  const mode = pickResolveMode(disk, options.forceFull);
  const vybeFirst = isVybeFirstPriceMint(mint);

  if (!options.forceFull) {
    const freshDisk = tryStatsFromFreshDisk(mint);
    if (freshDisk) return freshDisk;
  }

  const fromHint = hintToStats(mint, hint ?? {});
  if (fromHint) return fromHint;

  if (vybeFirst) {
    const vybe = await vybeTokenDetailsStats(http, mint, hint, disk, mode);
    if (vybe) return vybe;
    const jupiter = await jupiterFallbackStats(mint, hint, disk);
    if (jupiter) return jupiter;
    const pumpfun = await pumpfunFallbackStats(mint, hint, disk, options.solPriceUsd);
    if (pumpfun) return pumpfun;
    return stablecoinFallbackStats(mint, hint, disk);
  }

  const jupiter = await jupiterFallbackStats(mint, hint, disk);
  if (jupiter) return jupiter;
  const pumpfun = await pumpfunFallbackStats(mint, hint, disk, options.solPriceUsd);
  if (pumpfun) return pumpfun;
  const vybe = await vybeTokenDetailsStats(http, mint, hint, disk, mode);
  if (vybe) return vybe;
  return stablecoinFallbackStats(mint, hint, disk);
}

function sortMintsSolFirst(mints: string[]): string[] {
  return [...mints].sort((a, b) => {
    const aSol = isSolMint(a) ? 0 : 1;
    const bSol = isSolMint(b) ? 0 : 1;
    return aSol - bSol || a.localeCompare(b);
  });
}

function vybeToStats(
  mint: string,
  token: VybeToken,
  fetchedAt: number,
): Omit<Parameters<typeof statsFromEntry>[1], 'source'> | null {
  const decimals = vybeDecimals(token);
  const price = typeof token.price === 'number' ? token.price : undefined;
  const price1d = typeof token.price1d === 'number' ? token.price1d : undefined;
  const price7d = typeof token.price7d === 'number' ? token.price7d : undefined;
  if (!hasSpotPriceStats({ price, price1d, price7d, decimals })) return null;
  return {
    price: price!,
    price1d,
    price7d,
    decimals: decimals!,
    priceFetchedAt: fetchedAt,
    priceUpdateTime: typeof token.updateTime === 'number' ? token.updateTime : undefined,
  };
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

  let solPriceUsd = solPriceUsdFromContext(hints, stats);
  for (const mint of sortMintsSolFirst(vybeMints)) {
    const hint = hints[mint] ?? (mint !== NATIVE_SOL_MINT ? hints[NATIVE_SOL_MINT] : undefined);
    if (!solPriceUsd) solPriceUsd = solPriceUsdFromContext(hints, stats);
    const resolved = await resolveMintPriceStats(http, mint, hint, {
      forceFull: forceSet.has(mint),
      solPriceUsd,
    });
    if (resolved) stats[mint] = resolved;
  }

  for (const originalMint of requestedMints) {
    if (isSolMint(originalMint)) continue;
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

  return { stats: projectStatsToRequestedMints(requestedMints, stats) };
}
