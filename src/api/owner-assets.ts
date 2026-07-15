/**
 * Debug assets API: GET /api/assets/:wallet
 * (priced holdings with symbol/name/logo — sole holdings source on this branch).
 */

import { ASSETS_API_BASE, VYBE_TIMEOUT_MS } from '../config.js';
import { NATIVE_SOL_MINT } from './sol-mints.js';

/** Mint used by the assets API for native SOL balances. */
export const ASSETS_NATIVE_SOL_MINT = 'NativeSOL1111111111111111111111111111111111';

export function normalizeAssetsMint(mint: string): string {
  const m = mint.trim();
  if (m === ASSETS_NATIVE_SOL_MINT) return NATIVE_SOL_MINT;
  return m;
}

export interface OwnerAssetsHolding {
  mint: string;
  symbol: string;
  name: string;
  logo: string | null;
  label?: string | null;
  decimals: number;
  /** Already UI units (not raw base units). */
  amount: number;
  price: number;
  value_usd: number;
  value_sol: number;
  pct?: number;
}

export interface OwnerAssetsResponse {
  wallet: string;
  total_usd: number;
  total_sol: number;
  sol_price: number;
  token_count: number;
  tokens_with_value: number;
  holdings: OwnerAssetsHolding[];
  limit?: number;
  offset?: number;
  has_more?: boolean;
  query_time_ms?: number;
}

function asNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
}

export function parseOwnerAssetsResponse(data: unknown): OwnerAssetsResponse {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const holdingsRaw = Array.isArray(raw.holdings) ? raw.holdings : [];
  const holdings: OwnerAssetsHolding[] = [];

  for (const row of holdingsRaw) {
    if (!row || typeof row !== 'object') continue;
    const h = row as Record<string, unknown>;
    const mint = asStr(h.mint);
    if (!mint) continue;
    const decimals = Math.max(0, Math.floor(asNum(h.decimals, 0)));
    const amount = asNum(h.amount, 0);
    if (!(amount > 0)) continue;
    const logoRaw = h.logo;
    const logo =
      typeof logoRaw === 'string' && logoRaw.trim()
        ? logoRaw.trim()
        : null;
    holdings.push({
      mint,
      symbol: asStr(h.symbol),
      name: asStr(h.name),
      logo,
      label: typeof h.label === 'string' ? h.label : h.label == null ? null : asStr(h.label),
      decimals,
      amount,
      price: asNum(h.price, 0),
      value_usd: asNum(h.value_usd, 0),
      value_sol: asNum(h.value_sol, 0),
      pct: asNum(h.pct, 0),
    });
  }

  return {
    wallet: asStr(raw.wallet),
    total_usd: asNum(raw.total_usd, 0),
    total_sol: asNum(raw.total_sol, 0),
    sol_price: asNum(raw.sol_price, 0),
    token_count: asNum(raw.token_count, holdings.length),
    tokens_with_value: asNum(raw.tokens_with_value, 0),
    holdings,
    limit: asNum(raw.limit, holdings.length),
    offset: asNum(raw.offset, 0),
    has_more: raw.has_more === true,
    query_time_ms: asNum(raw.query_time_ms, 0),
  };
}

export async function getOwnerAssets(ownerAddress: string): Promise<OwnerAssetsResponse> {
  const owner = ownerAddress.trim();
  if (!owner) throw new Error('Wallet address required');
  if (!ASSETS_API_BASE) {
    throw new Error('ASSETS_API_BASE is required (set it in .env for internal-debug holdings)');
  }

  const url = `${ASSETS_API_BASE}/api/assets/${encodeURIComponent(owner)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VYBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Assets API returned ${res.status} for ${url}: ${text.slice(0, 200)}`);
    }
    return parseOwnerAssetsResponse(JSON.parse(text) as unknown);
  } finally {
    clearTimeout(timer);
  }
}
