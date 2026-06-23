/**
 * Jupiter fallback for RPC-only wallet holdings when Vybe token-details is unavailable.
 * Asset metadata from datapi; USD price from swap quote (token → USDC).
 */

import { NATIVE_SOL_MINT, WSOL_MINT } from './sol-mints.js';

const JUPITER_DATAPI_BASE = 'https://datapi.jup.ag/v1';
const JUPITER_SWAP_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface JupiterAssetInfo {
  symbol: string;
  name: string;
  logoUrl: string | null;
  decimals: number | null;
  verified: boolean;
}

function jupiterApiMint(mint: string): string {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT ? WSOL_MINT : m;
}

function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function parsePositiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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

/** USD price per token from Jupiter swap quote (sell 1 UI unit → USDC). */
export async function fetchJupiterQuotePriceUsd(
  mint: string,
  decimals: number,
): Promise<number | null> {
  if (!Number.isFinite(decimals) || decimals < 0) return null;
  const apiMint = jupiterApiMint(mint);
  if (apiMint === USDC_MINT) return 1;
  const inAmount = 10n ** BigInt(decimals);
  const url = new URL(JUPITER_SWAP_QUOTE_URL);
  url.searchParams.set('inputMint', apiMint);
  url.searchParams.set('outputMint', USDC_MINT);
  url.searchParams.set('amount', inAmount.toString());
  url.searchParams.set('slippageBps', '50');

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { outAmount?: string; inAmount?: string; error?: string };
  if (data.error) return null;
  const outRaw = parsePositiveNumber(data.outAmount);
  const inRaw = parsePositiveNumber(data.inAmount);
  if (outRaw == null || inRaw == null || inRaw <= 0) return null;
  const outUi = outRaw / 1e6;
  const inUi = inRaw / 10 ** decimals;
  if (!(inUi > 0)) return null;
  const priceUsd = outUi / inUi;
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}
