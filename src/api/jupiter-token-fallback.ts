/**
 * Jupiter fallback for RPC-only wallet holdings when Vybe token-details is unavailable.
 * Asset metadata from datapi; price from swap quote (token → USDC only).
 * If USDC quote fails, callers fall through to pump.fun then Vybe.
 */

import { fetchWithHttpProxy } from './http-proxy-fetch.js';
import { NATIVE_SOL_MINT, WSOL_MINT } from './sol-mints.js';

const JUPITER_DATAPI_BASE = 'https://datapi.jup.ag/v1';
const JUPITER_SWAP_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const PUMPFUN_API_BASE = 'https://frontend-api-v3.pump.fun';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

export interface JupiterAssetInfo {
  symbol: string;
  name: string;
  logoUrl: string | null;
  decimals: number | null;
  verified: boolean;
}

export interface JupiterTokenDetails {
  mint: string;
  priceUsd: number;
  decimals: number;
  /** Vybe-shaped token record for disk cache / API responses. */
  token: Record<string, unknown>;
}

export type JupiterQuotePrice = { priceUsd: number };

function jupiterApiMint(mint: string): string {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT ? WSOL_MINT : m;
}

/** URLs used to warm Jupiter + pump.fun connections at startup. */
export function getJupiterWarmupUrls(): {
  datapi: string;
  quote: string;
  pumpfunProbe: string;
} {
  const wsol = jupiterApiMint(NATIVE_SOL_MINT);
  const quoteUrl = new URL(JUPITER_SWAP_QUOTE_URL);
  quoteUrl.searchParams.set('inputMint', wsol);
  quoteUrl.searchParams.set('outputMint', USDC_MINT);
  quoteUrl.searchParams.set('amount', '1000000000');
  quoteUrl.searchParams.set('slippageBps', '50');
  return {
    datapi: `${JUPITER_DATAPI_BASE}/assets/search?query=${encodeURIComponent(wsol)}`,
    quote: quoteUrl.toString(),
    pumpfunProbe: `${PUMPFUN_API_BASE}/coins/${encodeURIComponent(wsol)}`,
  };
}

function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function parsePositiveBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value > 0n ? value : null;
  const digits = String(value ?? '').trim();
  if (!/^\d+$/.test(digits)) return null;
  try {
    const n = BigInt(digits);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

async function fetchJupiterSwapQuote(
  inputMint: string,
  outputMint: string,
  inAmountRaw: bigint,
): Promise<{ inAmount: bigint; outAmount: bigint } | null> {
  const url = new URL(JUPITER_SWAP_QUOTE_URL);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', inAmountRaw.toString());
  url.searchParams.set('slippageBps', '50');

  const res = await fetchWithHttpProxy(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { outAmount?: string; inAmount?: string; error?: string };
  if (data.error) return null;
  const inAmount = parsePositiveBigInt(data.inAmount);
  const outAmount = parsePositiveBigInt(data.outAmount);
  if (inAmount == null || outAmount == null) return null;
  return { inAmount, outAmount };
}

/** Token metadata (decimals, icon, symbol) from Jupiter datapi search. */
export async function fetchJupiterAsset(mint: string): Promise<JupiterAssetInfo | null> {
  const apiMint = jupiterApiMint(mint);
  const url = `${JUPITER_DATAPI_BASE}/assets/search?query=${encodeURIComponent(apiMint)}`;
  const res = await fetchWithHttpProxy(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Jupiter datapi HTTP ${res.status}`);
  }
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((t) => {
    if (!t || typeof t !== 'object') return false;
    const id = String((t as { id?: string }).id ?? '').trim();
    return id === apiMint;
  }) as
    | {
        symbol?: string;
        name?: string;
        icon?: string;
        decimals?: number;
        isVerified?: boolean;
      }
    | undefined;
  if (!row) return null;
  const symbol = row.symbol?.trim() || apiMint.slice(0, 6);
  const name = row.name?.trim() || symbol;
  const logoUrl = row.icon?.trim() || null;
  const decimals = parsePositiveInt(row.decimals);
  return {
    symbol,
    name,
    logoUrl,
    decimals,
    verified: row.isVerified === true,
  };
}

/** Full token details from Jupiter datapi + USDC swap quote. */
export async function fetchJupiterTokenDetails(
  mint: string,
  options: { decimalsHint?: number } = {},
): Promise<JupiterTokenDetails | null> {
  const m = mint.trim();
  if (!m) return null;

  let decimals = options.decimalsHint;
  let asset: JupiterAssetInfo | null = null;
  try {
    asset = await fetchJupiterAsset(m);
    if (asset?.decimals != null && (typeof decimals !== 'number' || !Number.isFinite(decimals))) {
      decimals = asset.decimals;
    }
  } catch {
    if (typeof decimals !== 'number' || !Number.isFinite(decimals)) return null;
  }
  if (typeof decimals !== 'number' || !Number.isFinite(decimals)) return null;

  let quote: JupiterQuotePrice | null;
  try {
    quote = await fetchJupiterQuotePrice(m, decimals);
  } catch {
    return null;
  }
  if (!quote) return null;

  const priceUsd = quote.priceUsd;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const symbol = asset?.symbol?.trim() || m.slice(0, 6);
  const name = asset?.name?.trim() || symbol;
  const token: Record<string, unknown> = {
    mintAddress: m,
    symbol,
    name,
    decimals,
    decimal: decimals,
    logoUrl: asset?.logoUrl?.trim() || undefined,
    price: priceUsd,
    verified: asset?.verified === true,
    isVerified: asset?.verified === true,
  };

  return { mint: m, priceUsd, decimals, token };
}

/** USD price per token from Jupiter swap quote (input → USDC only). */
export async function fetchJupiterQuotePrice(
  mint: string,
  decimals: number,
): Promise<JupiterQuotePrice | null> {
  if (!Number.isFinite(decimals) || decimals < 0) return null;
  const apiMint = jupiterApiMint(mint);
  if (apiMint === USDC_MINT) {
    return { priceUsd: 1 };
  }

  const inAmountRaw = 10n ** BigInt(decimals);
  const quote = await fetchJupiterSwapQuote(apiMint, USDC_MINT, inAmountRaw);
  if (!quote) return null;
  const inUi = Number(quote.inAmount) / 10 ** decimals;
  const outUi = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
  if (!(inUi > 0) || !(outUi > 0)) return null;
  const priceUsd = outUi / inUi;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  return { priceUsd };
}

/** @deprecated Use fetchJupiterQuotePrice */
export async function fetchJupiterQuotePriceUsd(
  mint: string,
  decimals: number,
): Promise<number | null> {
  const quote = await fetchJupiterQuotePrice(mint, decimals);
  return quote?.priceUsd ?? null;
}
