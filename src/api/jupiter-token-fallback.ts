/**
 * Jupiter fallback for RPC-only wallet holdings when Vybe token-details is unavailable.
 * Asset metadata from datapi; price from swap quote (token → SOL, then USDC, then USD1).
 */

import { NATIVE_SOL_MINT, WSOL_MINT } from './sol-mints.js';

const JUPITER_DATAPI_BASE = 'https://datapi.jup.ag/v1';
const JUPITER_SWAP_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

const QUOTE_OUTPUTS = [
  { mint: WSOL_MINT, decimals: 9, denom: 'sol' as const },
  { mint: USDC_MINT, decimals: 6, denom: 'usd' as const },
  { mint: USD1_MINT, decimals: 6, denom: 'usd' as const },
];

export interface JupiterAssetInfo {
  symbol: string;
  name: string;
  logoUrl: string | null;
  decimals: number | null;
  verified: boolean;
}

export type JupiterQuotePrice =
  | { denom: 'usd'; priceUsd: number }
  | { denom: 'sol'; priceSol: number };

function jupiterApiMint(mint: string): string {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT ? WSOL_MINT : m;
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

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

/**
 * USD or SOL price per token from Jupiter swap quote.
 * Tries output mints in order: WSOL → USDC → USD1.
 * SOL-denominated quotes are converted to USD on the client using cached SOL price.
 */
export async function fetchJupiterQuotePrice(
  mint: string,
  decimals: number,
): Promise<JupiterQuotePrice | null> {
  if (!Number.isFinite(decimals) || decimals < 0) return null;
  const apiMint = jupiterApiMint(mint);
  if (apiMint === USDC_MINT || apiMint === USD1_MINT) {
    return { denom: 'usd', priceUsd: 1 };
  }

  const inAmountRaw = 10n ** BigInt(decimals);
  for (const output of QUOTE_OUTPUTS) {
    if (output.mint === apiMint) continue;
    const quote = await fetchJupiterSwapQuote(apiMint, output.mint, inAmountRaw);
    if (!quote) continue;
    const inUi = Number(quote.inAmount) / 10 ** decimals;
    const outUi = Number(quote.outAmount) / 10 ** output.decimals;
    if (!(inUi > 0) || !(outUi > 0)) continue;
    const price = outUi / inUi;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (output.denom === 'sol') return { denom: 'sol', priceSol: price };
    return { denom: 'usd', priceUsd: price };
  }
  return null;
}

/** @deprecated Use fetchJupiterQuotePrice */
export async function fetchJupiterQuotePriceUsd(
  mint: string,
  decimals: number,
): Promise<number | null> {
  const quote = await fetchJupiterQuotePrice(mint, decimals);
  if (!quote) return null;
  return quote.denom === 'usd' ? quote.priceUsd : null;
}
