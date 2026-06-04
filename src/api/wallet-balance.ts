/**
 * Vybe wallet token balances: GET /v4/wallets/{ownerAddress}/token-balance
 * Used to verify the wallet holds enough of the sell token before Vybe quotes/builds.
 */

import type { AxiosInstance } from 'axios';
import type { VybeWalletTokenBalanceResponse } from '../types/api.js';
import { withRetry } from './client.js';

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

export async function listWalletTokenBalances(
  http: AxiosInstance,
  ownerAddress: string,
  limit = 50,
): Promise<WalletBalanceListItem[]> {
  const balance = await getWalletTokenBalance(http, {
    ownerAddress,
    includeNoPriceBalance: true,
  });

  return balance.data
    .map((row) => {
      const decimals = Number(row.decimals);
      if (!Number.isFinite(decimals) || decimals < 0) return null;
      const amountUi = balanceAmountToUi(row.amount, decimals);
      if (!(amountUi > 0)) return null;
      const mintAddress = row.mintAddress.trim();
      const symbol = row.symbol?.trim() || mintAddress.slice(0, 6);
      const name = row.name?.trim() || symbol;
      const valueUsd = Number(row.valueUsd);
      return {
        mintAddress,
        symbol,
        name,
        logoUrl: row.logoUrl?.trim() || null,
        decimals,
        amountUi,
        valueUsd: Number.isFinite(valueUsd) ? valueUsd : 0,
        verified: row.verified === true,
      } satisfies WalletBalanceListItem;
    })
    .filter((row): row is WalletBalanceListItem => row != null)
    .sort((a, b) => b.valueUsd - a.valueUsd || b.amountUi - a.amountUi)
    .slice(0, limit);
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

  const balance = await getWalletTokenBalance(http, {
    ownerAddress,
    mintAddresses: [mint],
    includeNoPriceBalance: true,
  });

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

  if (availableRaw < requiredRaw) {
    throw new InsufficientBalanceError(
      `Insufficient balance: you have ${formatUiAmount(availableUi)} ${symbol} but tried to sell ${formatUiAmount(amountUi)} ${symbol}.`,
      availableUi,
      amountUi,
      symbol,
    );
  }
}
