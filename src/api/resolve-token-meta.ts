/**
 * Resolve full token metadata (price, logo, symbol, …) for /api/token and search.
 * Network order: Jupiter → pump.fun → Vybe token-details.
 */

import type { AxiosInstance } from 'axios';
import { getToken } from './tokens.js';
import { fetchJupiterTokenDetails } from './jupiter-token-fallback.js';
import { fetchPumpfunTokenDetails } from './pumpfun-price-fallback.js';
import type { PriceResolveSource } from './token-meta-api.js';
import { NATIVE_SOL_MINT, WSOL_MINT } from './sol-mints.js';
import type { VybeToken } from '../types/api.js';
import {
  cacheTokenMetaFromVybe,
  ensureTokenIconCached,
  getCachedTokenMetaFromDisk,
  hasCachedTokenIcon,
  readTokenMetaCache,
  writeTokenMetaCache,
  type CachedTokenMeta,
} from '../token-icon-cache.js';

function vybeDecimals(token: VybeToken): number | undefined {
  if (typeof token.decimals === 'number' && Number.isFinite(token.decimals)) return token.decimals;
  if (typeof token.decimal === 'number' && Number.isFinite(token.decimal)) return token.decimal;
  return undefined;
}

function solPriceUsdFromDisk(): number | undefined {
  for (const mint of [WSOL_MINT, NATIVE_SOL_MINT]) {
    const price = getCachedTokenMetaFromDisk(mint)?.price;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price;
  }
  return undefined;
}

function metaIsComplete(meta: CachedTokenMeta | null): boolean {
  if (!meta) return false;
  return Boolean(
    meta.symbol?.trim() &&
      typeof meta.price === 'number' &&
      Number.isFinite(meta.price) &&
      meta.price > 0 &&
      hasCachedTokenIcon(meta.mint),
  );
}

function metaNeedsEnrichment(mint: string, disk: CachedTokenMeta | null): boolean {
  if (!disk) return true;
  const needsPrice = !(typeof disk.price === 'number' && disk.price > 0);
  const needsLogo = !hasCachedTokenIcon(mint);
  const needsSymbol = !disk.symbol?.trim();
  return needsPrice || needsLogo || needsSymbol;
}

async function applyJupiterMeta(
  mint: string,
  solPriceUsd: number | undefined,
  decimalsHint: number | undefined,
): Promise<boolean> {
  try {
    const jupiter = await fetchJupiterTokenDetails(mint, {
      solPriceUsd,
      decimalsHint,
    });
    if (!jupiter) return false;
    await cacheTokenMetaFromVybe(mint, {
      ...jupiter.token,
      priceFetchedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

async function applyPumpfunMeta(
  mint: string,
  solPriceUsd: number | undefined,
  decimalsHint: number | undefined,
): Promise<boolean> {
  try {
    const pumpfun = await fetchPumpfunTokenDetails(mint, {
      solPriceUsd,
      decimalsHint,
    });
    if (!pumpfun) return false;
    await cacheTokenMetaFromVybe(mint, {
      ...pumpfun.token,
      priceFetchedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

async function applyVybeTokenDetails(http: AxiosInstance, mint: string): Promise<boolean> {
  try {
    const token = await getToken(http, mint);
    await cacheTokenMetaFromVybe(mint, {
      ...token,
      decimals: vybeDecimals(token),
      price: token.price,
      price1d: token.price1d,
      price7d: token.price7d,
      priceUpdateTime: token.updateTime,
      priceFetchedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Re-download icon when JSON cache points at a missing local file. */
export async function repairTokenIcon(mint: string): Promise<string | undefined> {
  const m = mint.trim();
  if (!m || hasCachedTokenIcon(m)) {
    const hit = getCachedTokenMetaFromDisk(m);
    return hit?.logoUrl;
  }

  const solPriceUsd = solPriceUsdFromDisk();
  let remoteUrl: string | undefined;

  try {
    const jupiter = await fetchJupiterTokenDetails(m, { solPriceUsd });
    remoteUrl = typeof jupiter?.token.logoUrl === 'string' ? jupiter.token.logoUrl : undefined;
  } catch {
    /* try pump.fun next */
  }

  if (!remoteUrl) {
    try {
      const pumpfun = await fetchPumpfunTokenDetails(m, { solPriceUsd });
      remoteUrl = typeof pumpfun?.token.logoUrl === 'string' ? pumpfun.token.logoUrl : undefined;
    } catch {
      return undefined;
    }
  }

  if (!remoteUrl) return undefined;

  const local = await ensureTokenIconCached(m, remoteUrl);
  if (!local) return undefined;

  const cache = readTokenMetaCache();
  const entry = cache[m];
  if (entry) {
    entry.logoUrl = local;
    writeTokenMetaCache(cache);
  }
  return local;
}

export interface ResolveTokenMetaResult {
  meta: CachedTokenMeta;
  source?: PriceResolveSource;
}

/** Resolve token metadata for API/search. Jupiter → pump.fun → Vybe token-details. */
export async function resolveTokenMeta(
  http: AxiosInstance,
  mint: string,
): Promise<ResolveTokenMetaResult | null> {
  const m = mint.trim();
  if (!m) return null;

  let source: PriceResolveSource | undefined;
  let disk = getCachedTokenMetaFromDisk(m);
  if (metaIsComplete(disk)) return { meta: disk!, source };

  const solPriceUsd = solPriceUsdFromDisk();

  if (metaNeedsEnrichment(m, disk)) {
    if (await applyJupiterMeta(m, solPriceUsd, disk?.decimals)) {
      source = 'Jupiter';
    }
  }

  disk = getCachedTokenMetaFromDisk(m);
  if (metaNeedsEnrichment(m, disk)) {
    if (await applyPumpfunMeta(m, solPriceUsd, disk?.decimals)) {
      source = 'Pumpfun-API';
    }
  }

  disk = getCachedTokenMetaFromDisk(m);
  if (metaNeedsEnrichment(m, disk)) {
    if (await applyVybeTokenDetails(http, m)) {
      source = 'Vybe';
    }
  }

  if (!hasCachedTokenIcon(m)) {
    await repairTokenIcon(m);
  }

  disk = getCachedTokenMetaFromDisk(m);
  if (!disk) return null;
  return { meta: disk, source };
}
