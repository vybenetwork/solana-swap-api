/**
 * Resolve full token metadata (price, logo, symbol, …) for /api/token and search.
 * WSOL/stables: Vybe token-details → Jupiter → pump.fun.
 * Other mints: Jupiter → pump.fun → Vybe (Vybe skipped when ?skipVybe=1 for wallet enrichment).
 */

import type { AxiosInstance } from 'axios';
import { getToken } from './tokens.js';
import { fetchJupiterTokenDetails } from './jupiter-token-fallback.js';
import { fetchPumpfunTokenDetails } from './pumpfun-price-fallback.js';
import type { PriceResolveSource } from './token-meta-api.js';
import { isMintLikeLabel } from './token-label.js';
import { NATIVE_SOL_MINT, WSOL_MINT, isVybeFirstPriceMint } from './sol-mints.js';
import type { VybeToken } from '../types/api.js';
import {
  cacheTokenMetaFromVybe,
  clearMintLikeStubFromDisk,
  ensureTokenIconCached,
  getCachedTokenMetaFromDisk,
  hasCachedTokenIcon,
  isUnusableTokenMeta,
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
  if (isMintLikeLabel(meta.symbol ?? '', meta.mint)) return false;
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
  const needsSymbol = !disk.symbol?.trim() || isMintLikeLabel(disk.symbol, mint);
  return needsPrice || needsLogo || needsSymbol;
}

function shouldSkipVybeMeta(disk: CachedTokenMeta | null, mint: string): boolean {
  if (!disk) return false;
  const sym = disk.symbol?.trim() ?? '';
  const name = disk.name?.trim() ?? '';
  return isMintLikeLabel(sym, mint) || isMintLikeLabel(name, mint);
}

function metaSourceOrder(
  mint: string,
  disk: CachedTokenMeta | null,
  skipVybe: boolean,
): MetaSource[] {
  const orderKey = isVybeFirstPriceMint(mint) ? 'vybeFirst' : 'default';
  const order = [...META_SOURCE_ORDER[orderKey]];
  if (skipVybe || shouldSkipVybeMeta(disk, mint)) {
    return order.filter((source) => source !== 'vybe');
  }
  return order;
}

async function applyJupiterMeta(
  mint: string,
  decimalsHint: number | undefined,
): Promise<boolean> {
  try {
    const jupiter = await fetchJupiterTokenDetails(mint, {
      decimalsHint,
    });
    if (!jupiter) return false;
    await cacheTokenMetaFromVybe(mint, {
      ...jupiter.token,
      priceFetchedAt: Date.now(),
      priceSource: 'Jupiter',
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
      priceSource: 'Pumpfun-API',
    });
    return true;
  } catch {
    return false;
  }
}

type MetaSource = 'vybe' | 'jupiter' | 'pumpfun';

const META_SOURCE_ORDER: Record<'vybeFirst' | 'default', MetaSource[]> = {
  vybeFirst: ['vybe', 'jupiter', 'pumpfun'],
  default: ['jupiter', 'pumpfun', 'vybe'],
};

function metaSourceLabel(source: MetaSource): PriceResolveSource {
  if (source === 'vybe') return 'Vybe';
  if (source === 'jupiter') return 'Jupiter';
  return 'Pumpfun-API';
}

async function applyVybeTokenDetails(http: AxiosInstance, mint: string): Promise<boolean> {
  try {
    const token = await getToken(http, mint);
    const sym = String(token.symbol ?? '').trim();
    const name = String(token.name ?? '').trim();
    const price = typeof token.price === 'number' ? token.price : 0;
    if (isMintLikeLabel(sym, mint) && !(price > 0)) return false;
    if (isMintLikeLabel(name, mint) && isMintLikeLabel(sym, mint) && !(price > 0)) return false;
    await cacheTokenMetaFromVybe(mint, {
      ...token,
      decimals: vybeDecimals(token),
      price: token.price,
      price1d: token.price1d,
      price7d: token.price7d,
      priceUpdateTime: token.updateTime,
      priceFetchedAt: Date.now(),
      priceSource: 'Vybe',
    });
    return true;
  } catch {
    return false;
  }
}

async function applyMetaSource(
  http: AxiosInstance,
  mint: string,
  source: MetaSource,
  solPriceUsd: number | undefined,
  decimalsHint: number | undefined,
): Promise<boolean> {
  if (source === 'vybe') return applyVybeTokenDetails(http, mint);
  if (source === 'jupiter') return applyJupiterMeta(mint, decimalsHint);
  return applyPumpfunMeta(mint, solPriceUsd, decimalsHint);
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
    const jupiter = await fetchJupiterTokenDetails(m, {});
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

export interface ResolveTokenMetaOptions {
  /** Skip Vybe token-details when wallet/balance data already shows mint-as-name stub. */
  skipVybe?: boolean;
}

/** Resolve token metadata for API/search with mint-specific source order. */
export async function resolveTokenMeta(
  http: AxiosInstance,
  mint: string,
  options: ResolveTokenMetaOptions = {},
): Promise<ResolveTokenMetaResult | null> {
  const m = mint.trim();
  if (!m) return null;

  clearMintLikeStubFromDisk(m);

  let source: PriceResolveSource | undefined;
  let disk = getCachedTokenMetaFromDisk(m);
  if (metaIsComplete(disk)) return { meta: disk!, source: disk?.priceSource };

  const solPriceUsd = solPriceUsdFromDisk();
  const skipVybe = options.skipVybe === true;

  for (const metaSource of metaSourceOrder(m, disk, skipVybe)) {
    disk = getCachedTokenMetaFromDisk(m);
    if (!metaNeedsEnrichment(m, disk)) break;
    if (await applyMetaSource(http, m, metaSource, solPriceUsd, disk?.decimals)) {
      source = metaSourceLabel(metaSource);
    }
  }

  if (!hasCachedTokenIcon(m)) {
    await repairTokenIcon(m);
  }

  disk = getCachedTokenMetaFromDisk(m);
  if (!disk) return null;
  if (skipVybe && isUnusableTokenMeta(disk, m)) return null;
  return { meta: disk, source: source ?? disk.priceSource };
}
