/**
 * Vybe wallet token balances: GET /v4/wallets/{ownerAddress}/token-balance
 * Used to verify the wallet holds enough of the sell token before Vybe quotes/builds.
 */

import type { AxiosInstance } from 'axios';
import type { VybeWalletTokenBalanceResponse } from '../types/api.js';
import { withRetry } from './client.js';
import { fetchRpcWalletBalances, RPC_NATIVE_SOL_MINT } from './wallet-rpc-balance.js';

/** Vybe reports native SOL under System Program id, not WSOL mint. */
const NATIVE_SOL_MINT = '11111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Total SOL below this is not tradable. */
const SOL_MIN_TRADABLE_TOTAL_UI = 0.0061;

function isSolMint(mint: string): boolean {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

export { isSolMint, NATIVE_SOL_MINT, WSOL_MINT };

function sumSolBalanceRaw(rows: VybeWalletTokenBalanceResponse['data']): bigint {
  let total = 0n;
  for (const row of rows) {
    const mint = row.mintAddress.trim();
    if (mint !== NATIVE_SOL_MINT && mint !== WSOL_MINT) continue;
    const decimals = Number(row.decimals);
    if (!Number.isFinite(decimals) || decimals < 0) continue;
    total += balanceAmountToRaw(row.amount, decimals);
  }
  return total;
}

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
  /** On-chain balance in base units (integer string). Prefer RPC over Vybe. */
  amountExact: string;
  valueUsd: number;
  verified: boolean;
}

export async function getWalletTokenBalance(
  http: AxiosInstance,
  params: GetWalletTokenBalanceParams,
): Promise<VybeWalletTokenBalanceResponse> {
  const ownerAddress = params.ownerAddress.trim();
  if (!ownerAddress) throw new Error('Wallet address required');

  return withRetry(async () => {
    const { data } = await http.get<VybeWalletTokenBalanceResponse>(
      `/v4/wallets/${encodeURIComponent(ownerAddress)}/token-balance`,
      {
        params: {
          mintAddresses: params.mintAddresses,
          includeNoPriceBalance: params.includeNoPriceBalance ?? true,
          vybeTokenFilter: false,
        },
        paramsSerializer: {
          indexes: null,
        },
      },
    );
    return data;
  });
}

function formatUiAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  const s = amount.toFixed(9).replace(/\.?0+$/, '');
  return s || '0';
}

function rawToUiAmount(raw: string, decimals: number): number {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = n % base;
  if (frac === 0n) return Number(whole);
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return Number(`${whole}.${fracStr}`);
}

function uiAmountToRaw(amountUi: number, decimals: number): bigint {
  const fixed = amountUi.toFixed(Math.min(decimals, 12));
  const [wholePart, fracPart = ''] = fixed.split('.');
  const whole = BigInt(wholePart || '0');
  const frac = BigInt(fracPart.padEnd(decimals, '0').slice(0, decimals) || '0');
  return whole * 10n ** BigInt(decimals) + frac;
}

function balanceAmountToUi(amount: string, decimals: number): number {
  const trimmed = amount.trim();
  if (!trimmed) return 0;
  // Vybe wallet balance returns human-readable amounts (e.g. "1.269714"), not raw base units.
  if (/[.eE]/.test(trimmed)) {
    const ui = Number(trimmed);
    return Number.isFinite(ui) ? ui : 0;
  }
  return rawToUiAmount(trimmed, decimals);
}

function balanceAmountToRaw(amount: string, decimals: number): bigint {
  return uiAmountToRaw(balanceAmountToUi(amount, decimals), decimals);
}

function resolveAmountFromRpc(
  mintAddress: string,
  vybeDecimals: number,
  vybeAmount: string,
  rpcByMint: Map<string, import('./wallet-rpc-balance.js').RpcMintBalance>,
): { amountUi: number; amountExact: string; decimals: number } | null {
  const rpc =
    rpcByMint.get(mintAddress) ??
    (mintAddress === NATIVE_SOL_MINT ? rpcByMint.get(RPC_NATIVE_SOL_MINT) : undefined);
  if (rpc && rpc.amountRaw > 0n) {
    const decimals = vybeDecimals >= 0 ? vybeDecimals : rpc.decimals;
    const amountExact = rpc.amountRaw.toString();
    return {
      amountExact,
      amountUi: rawToUiAmount(amountExact, decimals),
      decimals,
    };
  }
  const decimals = vybeDecimals;
  if (!Number.isFinite(decimals) || decimals < 0) return null;
  const amountUi = balanceAmountToUi(vybeAmount, decimals);
  if (!(amountUi > 0)) return null;
  return {
    amountUi,
    amountExact: balanceAmountToRaw(vybeAmount, decimals).toString(),
    decimals,
  };
}

async function fetchRpcWalletBalancesSafe(
  ownerAddress: string,
): Promise<Map<string, import('./wallet-rpc-balance.js').RpcMintBalance>> {
  try {
    return await fetchRpcWalletBalances(ownerAddress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wallet-balance] RPC balance fetch failed, using Vybe amounts only: ${msg}`);
    return new Map();
  }
}

export async function listWalletTokenBalances(
  http: AxiosInstance,
  ownerAddress: string,
  limit = 50,
): Promise<WalletBalanceListItem[]> {
  const [balance, rpcByMint] = await Promise.all([
    getWalletTokenBalance(http, {
      ownerAddress,
      includeNoPriceBalance: true,
    }),
    fetchRpcWalletBalancesSafe(ownerAddress),
  ]);

  const items = balance.data
    .map((row) => {
      const vybeDecimals = Number(row.decimals);
      const mintAddress = row.mintAddress.trim();
      const amounts = resolveAmountFromRpc(mintAddress, vybeDecimals, row.amount, rpcByMint);
      if (!amounts) return null;
      const symbol = row.symbol?.trim() || mintAddress.slice(0, 6);
      const name = row.name?.trim() || symbol;
      const valueUsd = Number(row.valueUsd);
      return {
        mintAddress,
        symbol,
        name,
        logoUrl: row.logoUrl?.trim() || null,
        decimals: amounts.decimals,
        amountUi: amounts.amountUi,
        amountExact: amounts.amountExact,
        valueUsd: Number.isFinite(valueUsd) ? valueUsd : 0,
        verified: row.verified === true,
      } satisfies WalletBalanceListItem;
    })
    .filter((row): row is WalletBalanceListItem => row != null);

  const seen = new Set(items.map((i) => i.mintAddress));
  for (const rpc of rpcByMint.values()) {
    if (seen.has(rpc.mintAddress) || rpc.mintAddress === RPC_NATIVE_SOL_MINT) continue;
    if (rpc.amountRaw <= 0n) continue;
    const amountExact = rpc.amountRaw.toString();
    const amountUi = rawToUiAmount(amountExact, rpc.decimals);
    if (!(amountUi > 0)) continue;
    items.push({
      mintAddress: rpc.mintAddress,
      symbol: rpc.mintAddress.slice(0, 6),
      name: rpc.mintAddress.slice(0, 6),
      logoUrl: null,
      decimals: rpc.decimals,
      amountUi,
      amountExact,
      valueUsd: 0,
      verified: false,
    });
  }

  return items
    .sort((a, b) => b.valueUsd - a.valueUsd || b.amountUi - a.amountUi)
    .slice(0, limit);
}

export async function getWalletSolBalanceUi(
  http: AxiosInstance,
  ownerAddress: string,
): Promise<number> {
  const [rpcByMint, balance] = await Promise.all([
    fetchRpcWalletBalancesSafe(ownerAddress),
    getWalletTokenBalance(http, {
      ownerAddress,
      includeNoPriceBalance: true,
    }),
  ]);
  let totalRaw = 0n;
  const native = rpcByMint.get(RPC_NATIVE_SOL_MINT);
  const wsol = rpcByMint.get(WSOL_MINT);
  if (native) totalRaw += native.amountRaw;
  if (wsol) totalRaw += wsol.amountRaw;
  if (totalRaw <= 0n) {
    totalRaw = sumSolBalanceRaw(balance.data);
  }
  return rawToUiAmount(totalRaw.toString(), 9);
}

export async function getWalletSplTokenBalanceUi(
  http: AxiosInstance,
  ownerAddress: string,
  mint: string,
): Promise<{ amountUi: number; decimals: number } | null> {
  const m = mint.trim();
  if (!m || isSolMint(m)) return null;
  const [rpcByMint, balance] = await Promise.all([
    fetchRpcWalletBalancesSafe(ownerAddress),
    getWalletTokenBalance(http, {
      ownerAddress,
      mintAddresses: [m],
      includeNoPriceBalance: true,
    }),
  ]);
  const rpc = rpcByMint.get(m);
  if (rpc && rpc.amountRaw > 0n) {
    return {
      amountUi: rawToUiAmount(rpc.amountRaw.toString(), rpc.decimals),
      decimals: rpc.decimals,
    };
  }
  const row = balance.data.find((t) => t.mintAddress === m);
  if (!row) return null;
  const decimals = Number(row.decimals);
  if (!Number.isFinite(decimals) || decimals < 0) return null;
  const amountUi = balanceAmountToUi(row.amount, decimals);
  if (!(amountUi > 0)) return null;
  return { amountUi, decimals };
}

/**
 * Throws InsufficientBalanceError when the wallet does not hold enough of inputMint (UI amount).
 */
export async function assertWalletHasSellAmount(
  http: AxiosInstance,
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

  const [rpcByMint, balance] = await Promise.all([
    fetchRpcWalletBalancesSafe(ownerAddress),
    getWalletTokenBalance(http, {
      ownerAddress,
      // Vybe rejects native SOL / WSOL in mintAddresses; fetch all rows and filter locally.
      mintAddresses: isSolMint(mint) ? undefined : [mint],
      includeNoPriceBalance: true,
    }),
  ]);

  if (isSolMint(mint)) {
    const symbol = 'SOL';
    let totalRaw = 0n;
    const native = rpcByMint.get(RPC_NATIVE_SOL_MINT);
    const wsol = rpcByMint.get(WSOL_MINT);
    if (native) totalRaw += native.amountRaw;
    if (wsol) totalRaw += wsol.amountRaw;
    if (totalRaw <= 0n) {
      totalRaw = sumSolBalanceRaw(balance.data);
    }
    if (totalRaw <= 0n) {
      throw new InsufficientBalanceError(
        `Insufficient balance: no ${symbol} in this wallet.`,
        0,
        amountUi,
        symbol,
      );
    }
    const totalUi = rawToUiAmount(totalRaw.toString(), 9);

    if (totalUi < SOL_MIN_TRADABLE_TOTAL_UI) {
      throw new InsufficientBalanceError(
        `Insufficient balance: SOL amount too small to trade (minimum ${formatUiAmount(SOL_MIN_TRADABLE_TOTAL_UI)} SOL).`,
        totalUi,
        amountUi,
        symbol,
      );
    }

    const requiredRaw = uiAmountToRaw(amountUi, 9);

    if (requiredRaw > totalRaw) {
      throw new InsufficientBalanceError(
        `Insufficient balance: you have ${formatUiAmount(totalUi)} SOL but tried to sell ${formatUiAmount(amountUi)} SOL.`,
        totalUi,
        amountUi,
        symbol,
      );
    }
    return;
  }

  const rpc = rpcByMint.get(mint);
  if (rpc) {
    const symbol =
      balance.data.find((t) => t.mintAddress === mint)?.symbol?.trim() ||
      symbolHint?.trim() ||
      mint.slice(0, 6);
    const availableRaw = rpc.amountRaw;
    const availableUi = rawToUiAmount(availableRaw.toString(), rpc.decimals);
    const requiredRaw = uiAmountToRaw(amountUi, rpc.decimals);
    if (requiredRaw > availableRaw) {
      throw new InsufficientBalanceError(
        `Insufficient balance: you have ${formatUiAmount(availableUi)} ${symbol} but tried to sell ${formatUiAmount(amountUi)} ${symbol}.`,
        availableUi,
        amountUi,
        symbol,
      );
    }
    return;
  }

  const row = balance.data.find((t) => t.mintAddress === mint);
  const symbol = row?.symbol?.trim() || symbolHint?.trim() || mint.slice(0, 6);

  if (!row) {
    throw new InsufficientBalanceError(
      `Insufficient balance: no ${symbol} in this wallet.`,
      0,
      amountUi,
      symbol,
    );
  }

  const decimals = Number(row.decimals);
  if (!Number.isFinite(decimals) || decimals < 0) {
    throw new Error(`Could not read decimals for ${symbol}`);
  }

  const availableUi = balanceAmountToUi(row.amount, decimals);
  const availableRaw = balanceAmountToRaw(row.amount, decimals);
  const requiredRaw = uiAmountToRaw(amountUi, decimals);

  if (requiredRaw > availableRaw) {
    throw new InsufficientBalanceError(
      `Insufficient balance: you have ${formatUiAmount(availableUi)} ${symbol} but tried to sell ${formatUiAmount(amountUi)} ${symbol}.`,
      availableUi,
      amountUi,
      symbol,
    );
  }
}
