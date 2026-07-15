/**
 * Debug branch: wallet holdings from GET /api/assets/:wallet only.
 * Logos are downloaded server-side into /cached/token-icons and served locally.
 * No Vybe token-balance and no Solana RPC amount fallbacks on this path.
 */

import type { AxiosInstance } from 'axios';
import type { VybeWalletTokenBalanceResponse } from '../types/api.js';
import { WALLET_TOKEN_BALANCE_LIMIT } from '../wallet-balance-limit.js';
import { getOwnerAssets, normalizeAssetsMint, type OwnerAssetsHolding } from './owner-assets.js';
import { materializeItemLogosLocal } from './materialize-token-logo.js';
import { NATIVE_SOL_MINT, WSOL_MINT, isSolMint } from './sol-mints.js';

export { WALLET_TOKEN_BALANCE_LIMIT };
export { isSolMint, NATIVE_SOL_MINT, WSOL_MINT };

/** Total SOL below this is not tradable. */
const SOL_MIN_TRADABLE_TOTAL_UI = 0.0061;

export class InsufficientBalanceError extends Error {
  readonly availableUi: number;
  readonly requiredUi: number;
  readonly symbol: string;

  constructor(message: string, availableUi: number, requiredUi: number, symbol: string) {
    super(message);
    this.name = 'InsufficientBalanceError';
    this.availableUi = availableUi;
    this.requiredUi = requiredUi;
    this.symbol = symbol;
  }
}

export interface GetWalletTokenBalanceParams {
  ownerAddress: string;
  mintAddresses?: string[];
  includeNoPriceBalance?: boolean;
}

export interface WalletBalanceListItem {
  mintAddress: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  decimals: number;
  amountUi: number;
  /** On-chain balance in base units (integer string). Derived from assets UI amount. */
  amountExact: string;
  valueUsd: number;
  /** Holdings value in SOL when provided by assets API. */
  valueSol?: number;
  verified: boolean;
  enrichmentPending?: boolean;
  priceUsd?: number;
}

export type WalletBalanceStreamEvent =
  | { event: 'initial'; tokens: WalletBalanceListItem[] }
  | { event: 'update'; token: WalletBalanceListItem }
  | { event: 'done' };

export interface MergedWalletBalances {
  items: WalletBalanceListItem[];
}

function formatUiAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  const s = amount.toFixed(9).replace(/\.?0+$/, '');
  return s || '0';
}

function uiAmountToRaw(amountUi: number, decimals: number): bigint {
  if (!(amountUi > 0) || !Number.isFinite(amountUi)) return 0n;
  const d = Math.max(0, Math.floor(decimals));
  const fixed = amountUi.toFixed(Math.min(d, 12));
  const [wholePart, fracPart = ''] = fixed.split('.');
  const whole = BigInt(wholePart || '0');
  const frac = BigInt(fracPart.padEnd(d, '0').slice(0, d) || '0');
  return whole * 10n ** BigInt(d) + frac;
}

function uiAmountToRawExact(amountUi: number, decimals: number): string {
  return uiAmountToRaw(amountUi, decimals).toString();
}

function remoteLogoHint(logo: string | null | undefined): string | null {
  const u = String(logo ?? '').trim();
  if (!u) return null;
  if (u.startsWith('https://') || u.startsWith('http://')) return u;
  return null;
}

function holdingDecimals(row: OwnerAssetsHolding, mintAddress: string): number {
  if (Number.isFinite(row.decimals) && row.decimals >= 0) return Math.floor(row.decimals);
  if (mintAddress === NATIVE_SOL_MINT || mintAddress === WSOL_MINT) return 9;
  return 0;
}

function mapHoldingToListItem(row: OwnerAssetsHolding): WalletBalanceListItem | null {
  const mintAddress = normalizeAssetsMint(row.mint);
  if (!mintAddress) return null;
  const amountUi = Number(row.amount);
  if (!(amountUi > 0) || !Number.isFinite(amountUi)) return null;

  const decimals = holdingDecimals(row, mintAddress);
  const isNativeSol = mintAddress === NATIVE_SOL_MINT;
  const symbol =
    row.symbol?.trim() ||
    (typeof row.label === 'string' && row.label.trim() ? row.label.trim() : '') ||
    (isNativeSol ? 'SOL' : mintAddress.slice(0, 6));
  const name = row.name?.trim() || (isNativeSol ? 'Native SOL' : symbol);
  const priceUsd = Number(row.price);
  const valueUsd = Number(row.value_usd);
  const valueSol = Number(row.value_sol);

  return {
    mintAddress,
    symbol,
    name,
    // Keep remote hint for server download — not for the browser.
    logoUrl: remoteLogoHint(row.logo),
    decimals,
    amountUi,
    amountExact: uiAmountToRawExact(amountUi, decimals),
    valueUsd: Number.isFinite(valueUsd) && valueUsd > 0 ? valueUsd : 0,
    valueSol: Number.isFinite(valueSol) && valueSol > 0 ? valueSol : undefined,
    verified: isNativeSol,
    enrichmentPending: false,
    priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : undefined,
  };
}

function sortWalletBalanceItems(items: WalletBalanceListItem[]): WalletBalanceListItem[] {
  return [...items].sort(
    (a, b) =>
      b.valueUsd - a.valueUsd ||
      b.amountUi - a.amountUi ||
      a.mintAddress.localeCompare(b.mintAddress),
  );
}

function findHolding(
  holdings: OwnerAssetsHolding[],
  mint: string,
): OwnerAssetsHolding | undefined {
  const want = mint.trim();
  return holdings.find((h) => {
    const normalized = normalizeAssetsMint(h.mint);
    return normalized === want || h.mint.trim() === want;
  });
}

/** Map assets API holdings → UI rows, with logos cached on this server. */
export async function fetchWalletBalancesFromAssets(
  ownerAddress: string,
  limit = WALLET_TOKEN_BALANCE_LIMIT,
): Promise<MergedWalletBalances> {
  const label = ownerAddress.trim().slice(0, 8);
  const started = Date.now();

  const assets = await getOwnerAssets(ownerAddress);
  console.info(
    `[wallet-balance] ${label} assets=${Date.now() - started}ms ` +
      `holdings=${assets.holdings.length} token_count=${assets.token_count} ` +
      `with_value=${assets.tokens_with_value} total_usd=${assets.total_usd} ` +
      `query_ms=${assets.query_time_ms ?? '?'} has_more=${assets.has_more === true}`,
  );

  const items: WalletBalanceListItem[] = [];
  for (const row of assets.holdings) {
    const item = mapHoldingToListItem(row);
    if (item) items.push(item);
  }

  const sliced = sortWalletBalanceItems(items).slice(0, limit);

  const logoStarted = Date.now();
  const withLocalLogos = await materializeItemLogosLocal(sliced, {
    limit: sliced.length,
    concurrency: 12,
  });
  const localCount = withLocalLogos.filter((t) =>
    Boolean(t.logoUrl?.startsWith('/cached/') || t.logoUrl?.startsWith('/data/')),
  ).length;
  console.info(
    `[wallet-balance] ${label} logos materialized ${localCount}/${withLocalLogos.length} ` +
      `in ${Date.now() - logoStarted}ms (served from /cached/token-icons)`,
  );
  console.info(
    `[wallet-balance] ${label} mapped ${withLocalLogos.length}/${items.length} item(s) in ${Date.now() - started}ms`,
  );
  return { items: withLocalLogos };
}

/**
 * Compat shim: assets holdings as the old Vybe wallet token-balance shape.
 * Used by ATA hints / client helpers — does not call Vybe or RPC.
 */
export async function getWalletTokenBalance(
  _http: AxiosInstance | undefined,
  params: GetWalletTokenBalanceParams,
): Promise<VybeWalletTokenBalanceResponse> {
  const ownerAddress = params.ownerAddress.trim();
  if (!ownerAddress) throw new Error('Wallet address required');

  const assets = await getOwnerAssets(ownerAddress);
  const mintFilter = params.mintAddresses?.map((m) => m.trim()).filter(Boolean);
  const mintSet = mintFilter?.length ? new Set(mintFilter) : null;

  const data = assets.holdings
    .map((row) => {
      const mintAddress = normalizeAssetsMint(row.mint);
      if (!mintAddress) return null;
      if (mintSet && !mintSet.has(mintAddress) && !mintSet.has(row.mint.trim())) return null;
      const amountUi = Number(row.amount);
      if (!(amountUi > 0) || !Number.isFinite(amountUi)) return null;
      const decimals = holdingDecimals(row, mintAddress);
      const priceUsd = Number(row.price);
      const valueUsd = Number(row.value_usd);
      return {
        mintAddress,
        amount: String(amountUi),
        decimals,
        symbol: row.symbol || null,
        name: row.name || null,
        logoUrl: remoteLogoHint(row.logo),
        priceUsd:
          Number.isFinite(priceUsd) && priceUsd > 0 ? String(priceUsd) : undefined,
        valueUsd:
          Number.isFinite(valueUsd) && valueUsd > 0 ? String(valueUsd) : undefined,
        verified: mintAddress === NATIVE_SOL_MINT,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  return {
    ownerAddress,
    date: Date.now(),
    data,
    totalTokenCount: assets.token_count,
    totalTokenValueUsd: String(assets.total_usd ?? 0),
  };
}

export async function streamWalletTokenBalances(
  _http: AxiosInstance | undefined,
  ownerAddress: string,
  limit: number,
  emit: (event: WalletBalanceStreamEvent) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  const { items } = await fetchWalletBalancesFromAssets(ownerAddress, limit);
  if (isCancelled?.()) return;
  emit({ event: 'initial', tokens: items });
  if (!isCancelled?.()) emit({ event: 'done' });
}

export async function listWalletTokenBalances(
  _http: AxiosInstance | undefined,
  ownerAddress: string,
  limit = WALLET_TOKEN_BALANCE_LIMIT,
): Promise<WalletBalanceListItem[]> {
  const { items } = await fetchWalletBalancesFromAssets(ownerAddress, limit);
  return items;
}

export async function getWalletSolBalanceUi(
  _http: AxiosInstance | undefined,
  ownerAddress: string,
): Promise<number> {
  const assets = await getOwnerAssets(ownerAddress);
  const native = assets.holdings.find(
    (h) =>
      normalizeAssetsMint(h.mint) === NATIVE_SOL_MINT ||
      h.label === 'Native SOL' ||
      h.symbol?.trim().toUpperCase() === 'SOL',
  );
  if (native && Number.isFinite(native.amount)) return native.amount;
  return Number.isFinite(assets.total_sol) ? assets.total_sol : 0;
}

export async function getWalletSplTokenBalanceUi(
  _http: AxiosInstance | undefined,
  ownerAddress: string,
  mint: string,
): Promise<{ amountUi: number; decimals: number } | null> {
  const m = mint.trim();
  if (!m || isSolMint(m)) return null;
  const assets = await getOwnerAssets(ownerAddress);
  const row = findHolding(assets.holdings, m);
  if (!row) return null;
  const amountUi = Number(row.amount);
  if (!(amountUi > 0) || !Number.isFinite(amountUi)) return null;
  return { amountUi, decimals: holdingDecimals(row, normalizeAssetsMint(row.mint)) };
}

/**
 * Throws InsufficientBalanceError when the wallet does not hold enough of inputMint (UI amount).
 * Amounts come only from the assets API (no RPC / Vybe).
 */
export async function assertWalletHasSellAmount(
  _http: AxiosInstance | undefined,
  ownerAddress: string,
  inputMint: string,
  amountUi: number,
  symbolHint?: string,
): Promise<void> {
  const mint = inputMint.trim();
  if (!mint) throw new Error('inputMintAddress required');
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    throw new Error('amount must be a positive number');
  }

  const assets = await getOwnerAssets(ownerAddress);

  if (mint === NATIVE_SOL_MINT) {
    const symbol = 'SOL';
    const row = findHolding(assets.holdings, NATIVE_SOL_MINT);
    const availableUi =
      row && Number.isFinite(row.amount)
        ? row.amount
        : Number.isFinite(assets.total_sol)
          ? assets.total_sol
          : 0;
    if (!(availableUi > 0)) {
      throw new InsufficientBalanceError(
        `Insufficient balance: no ${symbol} in this wallet.`,
        0,
        amountUi,
        symbol,
      );
    }
    if (availableUi < SOL_MIN_TRADABLE_TOTAL_UI) {
      throw new InsufficientBalanceError(
        `Insufficient balance: SOL amount too small to trade (minimum ${formatUiAmount(SOL_MIN_TRADABLE_TOTAL_UI)} SOL).`,
        availableUi,
        amountUi,
        symbol,
      );
    }
    if (uiAmountToRaw(amountUi, 9) > uiAmountToRaw(availableUi, 9)) {
      throw new InsufficientBalanceError(
        `Insufficient balance: you have ${formatUiAmount(availableUi)} SOL but tried to sell ${formatUiAmount(amountUi)} SOL.`,
        availableUi,
        amountUi,
        symbol,
      );
    }
    return;
  }

  if (mint === WSOL_MINT) {
    const symbol = 'WSOL';
    const row = findHolding(assets.holdings, WSOL_MINT);
    const availableUi = row && Number.isFinite(row.amount) ? row.amount : 0;
    if (!(availableUi > 0)) {
      throw new InsufficientBalanceError(
        `Insufficient balance: no ${symbol} in this wallet.`,
        0,
        amountUi,
        symbol,
      );
    }
    if (uiAmountToRaw(amountUi, 9) > uiAmountToRaw(availableUi, 9)) {
      throw new InsufficientBalanceError(
        `Insufficient balance: you have ${formatUiAmount(availableUi)} ${symbol} but tried to sell ${formatUiAmount(amountUi)} ${symbol}.`,
        availableUi,
        amountUi,
        symbol,
      );
    }
    return;
  }

  const row = findHolding(assets.holdings, mint);
  const symbol = row?.symbol?.trim() || symbolHint?.trim() || mint.slice(0, 6);
  if (!row) {
    throw new InsufficientBalanceError(
      `Insufficient balance: no ${symbol} in this wallet.`,
      0,
      amountUi,
      symbol,
    );
  }
  const decimals = holdingDecimals(row, normalizeAssetsMint(row.mint));
  const availableUi = Number(row.amount);
  if (!(availableUi > 0) || !Number.isFinite(availableUi)) {
    throw new InsufficientBalanceError(
      `Insufficient balance: no ${symbol} in this wallet.`,
      0,
      amountUi,
      symbol,
    );
  }
  if (uiAmountToRaw(amountUi, decimals) > uiAmountToRaw(availableUi, decimals)) {
    throw new InsufficientBalanceError(
      `Insufficient balance: you have ${formatUiAmount(availableUi)} ${symbol} but tried to sell ${formatUiAmount(amountUi)} ${symbol}.`,
      availableUi,
      amountUi,
      symbol,
    );
  }
}
