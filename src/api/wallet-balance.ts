/**
 * Vybe wallet token balances: GET /v4/wallets/{ownerAddress}/token-balance
 * Used to verify the wallet holds enough of the sell token before Vybe quotes/builds.
 */

import type { AxiosInstance } from 'axios';
import type { VybeToken, VybeWalletTokenBalanceResponse } from '../types/api.js';
import { withRetry } from './client.js';
import { toVybeSwapMint } from './sol-mints.js';
import { fetchJupiterAsset, fetchJupiterQuotePrice } from './jupiter-token-fallback.js';
import { fetchMintDecimalsFromRpc } from './mint-decimals-rpc.js';
import { getToken } from './tokens.js';
import { fetchRpcWalletBalances, RPC_NATIVE_SOL_MINT } from './wallet-rpc-balance.js';
import type { RpcMintBalance } from './wallet-rpc-balance.js';

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
  /** Holdings value in SOL when Jupiter quoted to WSOL (USD = valueSol × cached SOL price on client). */
  valueSol?: number;
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

function tokenDecimalsFromDetails(token: VybeToken, fallback: number): number {
  if (typeof token.decimals === 'number' && Number.isFinite(token.decimals)) return token.decimals;
  if (typeof token.decimal === 'number' && Number.isFinite(token.decimal)) return token.decimal;
  return fallback;
}

function tokenPriceUsdFromDetails(token: VybeToken): number {
  if (typeof token.price === 'number' && Number.isFinite(token.price) && token.price > 0) {
    return token.price;
  }
  const raw = token.priceUsd;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return 0;
}

function holdingValueUsd(priceUsd: number, amountUi: number): number {
  if (!(priceUsd > 0) || !(amountUi > 0)) return 0;
  const value = priceUsd * amountUi;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function holdingValueSol(priceSol: number, amountUi: number): number {
  if (!(priceSol > 0) || !(amountUi > 0)) return 0;
  const value = priceSol * amountUi;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function walletBalanceSortValue(item: WalletBalanceListItem): number {
  if (item.valueUsd > 0) return item.valueUsd;
  if (item.valueSol != null && item.valueSol > 0) return item.valueSol;
  return 0;
}

async function enrichRpcOnlyFromJupiter(
  displayMint: string,
  rpc: RpcMintBalance,
  state: {
    decimals: number;
    symbol: string;
    name: string;
    logoUrl: string | null;
    verified: boolean;
    valueUsd: number;
    valueSol?: number;
  },
): Promise<void> {
  const apiMint = toVybeSwapMint(displayMint);
  let jupiterDecimals: number | null = null;

  try {
    const asset = await fetchJupiterAsset(apiMint);
    if (asset) {
      if (asset.symbol) state.symbol = asset.symbol;
      if (asset.name) state.name = asset.name;
      if (asset.logoUrl) state.logoUrl = asset.logoUrl;
      if (asset.verified) state.verified = asset.verified;
      if (asset.decimals != null) {
        jupiterDecimals = asset.decimals;
        state.decimals = asset.decimals;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wallet-balance] Jupiter asset failed for ${apiMint.slice(0, 8)}…: ${msg}`);
  }

  if (jupiterDecimals == null) {
    try {
      const chainDecimals = await fetchMintDecimalsFromRpc(apiMint);
      if (chainDecimals != null) state.decimals = chainDecimals;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[wallet-balance] RPC mint decimals failed for ${apiMint.slice(0, 8)}…: ${msg}`);
    }
  }

  try {
    const quote = await fetchJupiterQuotePrice(apiMint, state.decimals);
    if (quote) {
      const amountUi = rawToUiAmount(rpc.amountRaw.toString(), state.decimals);
      if (quote.denom === 'usd') {
        state.valueUsd = holdingValueUsd(quote.priceUsd, amountUi);
        state.valueSol = undefined;
      } else {
        state.valueSol = holdingValueSol(quote.priceSol, amountUi);
        state.valueUsd = 0;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wallet-balance] Jupiter quote failed for ${apiMint.slice(0, 8)}…: ${msg}`);
  }
}

async function walletItemFromRpcBalance(
  http: AxiosInstance,
  rpc: RpcMintBalance,
  options?: { displayMint?: string; defaultSymbol?: string; defaultName?: string },
): Promise<WalletBalanceListItem | null> {
  if (rpc.amountRaw <= 0n) return null;
  const displayMint = (options?.displayMint ?? rpc.mintAddress).trim();
  const amountExact = rpc.amountRaw.toString();
  let decimals = rpc.decimals;
  let symbol = options?.defaultSymbol?.trim() || displayMint.slice(0, 6);
  let name = options?.defaultName?.trim() || symbol;
  let logoUrl: string | null = null;
  let verified = false;
  let valueUsd = 0;
  let valueSol: number | undefined;
  let tokenDetailsOk = false;

  try {
    const token = await getToken(http, toVybeSwapMint(displayMint));
    decimals = tokenDecimalsFromDetails(token, rpc.decimals);
    symbol = token.symbol?.trim() || symbol;
    name = token.name?.trim() || symbol;
    logoUrl = token.logoUrl?.trim() || null;
    verified = token.verified === true;
    const amountUi = rawToUiAmount(amountExact, decimals);
    valueUsd = holdingValueUsd(tokenPriceUsdFromDetails(token), amountUi);
    tokenDetailsOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[wallet-balance] token-details failed for ${displayMint.slice(0, 8)}…: ${msg}`,
    );
  }

  if (!tokenDetailsOk) {
    const fallback = { decimals, symbol, name, logoUrl, verified, valueUsd, valueSol };
    await enrichRpcOnlyFromJupiter(displayMint, rpc, fallback);
    decimals = fallback.decimals;
    symbol = fallback.symbol;
    name = fallback.name;
    logoUrl = fallback.logoUrl;
    verified = fallback.verified;
    valueUsd = fallback.valueUsd;
    valueSol = fallback.valueSol;
  }

  const amountUi = rawToUiAmount(amountExact, decimals);
  if (!(amountUi > 0)) return null;
  return {
    mintAddress: displayMint,
    symbol,
    name,
    logoUrl,
    decimals,
    amountUi,
    amountExact,
    valueUsd,
    ...(valueSol != null && valueSol > 0 ? { valueSol } : {}),
    verified,
  };
}

async function fetchRpcWalletBalancesSafe(
  ownerAddress: string,
): Promise<{
  rpcByMint: Map<string, import('./wallet-rpc-balance.js').RpcMintBalance>;
  rpcOk: boolean;
}> {
  try {
    const rpcByMint = await fetchRpcWalletBalances(ownerAddress);
    return { rpcByMint, rpcOk: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wallet-balance] RPC balance fetch failed, using Vybe amounts only: ${msg}`);
    return { rpcByMint: new Map(), rpcOk: false };
  }
}

function resolveAmountFromRpc(
  mintAddress: string,
  vybeDecimals: number,
  vybeAmount: string,
  rpcByMint: Map<string, import('./wallet-rpc-balance.js').RpcMintBalance>,
  rpcOk: boolean,
): { amountUi: number; amountExact: string; decimals: number } | null {
  const rpc =
    rpcByMint.get(mintAddress) ??
    (mintAddress === NATIVE_SOL_MINT ? rpcByMint.get(RPC_NATIVE_SOL_MINT) : undefined);

  if (rpcOk) {
    const decimals =
      rpc != null
        ? vybeDecimals >= 0
          ? vybeDecimals
          : rpc.decimals
        : vybeDecimals;
    if (!Number.isFinite(decimals) || decimals < 0) return null;
    const amountRaw = rpc?.amountRaw ?? 0n;
    const amountExact = amountRaw.toString();
    const amountUi = rawToUiAmount(amountExact, decimals);
    if (!(amountUi > 0)) return null;
    return { amountExact, amountUi, decimals };
  }

  if (rpc && rpc.amountRaw > 0n) {
    const decimals = vybeDecimals >= 0 ? vybeDecimals : rpc.decimals;
    const amountExact = rpc.amountRaw.toString();
    return {
      amountExact,
      amountUi: rawToUiAmount(amountExact, decimals),
      decimals,
    };
  }
  const vybeDec = vybeDecimals;
  if (!Number.isFinite(vybeDec) || vybeDec < 0) return null;
  const amountUi = balanceAmountToUi(vybeAmount, vybeDec);
  if (!(amountUi > 0)) return null;
  return {
    amountUi,
    amountExact: balanceAmountToRaw(vybeAmount, vybeDec).toString(),
    decimals: vybeDec,
  };
}

export async function listWalletTokenBalances(
  http: AxiosInstance,
  ownerAddress: string,
  limit = 50,
): Promise<WalletBalanceListItem[]> {
  const [balanceResult, { rpcByMint, rpcOk }] = await Promise.all([
    getWalletTokenBalance(http, {
      ownerAddress,
      includeNoPriceBalance: true,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[wallet-balance] Vybe token list failed, using RPC-only: ${msg}`);
      return null;
    }),
    fetchRpcWalletBalancesSafe(ownerAddress),
  ]);

  if (rpcOk) {
    console.info(`[wallet-balance] RPC scan ok — ${rpcByMint.size} mint(s) with on-chain balance`);
  }

  const balance = balanceResult ?? { data: [] };

  const items = balance.data
    .map((row) => {
      const vybeDecimals = Number(row.decimals);
      const mintAddress = row.mintAddress.trim();
      const amounts = resolveAmountFromRpc(
        mintAddress,
        vybeDecimals,
        row.amount,
        rpcByMint,
        rpcOk,
      );
      if (!amounts) return null;
      const symbol = row.symbol?.trim() || mintAddress.slice(0, 6);
      const name = row.name?.trim() || symbol;
      let valueUsd = Number(row.valueUsd);
      if (rpcOk) {
        const priceUsd = Number(row.priceUsd);
        if (Number.isFinite(priceUsd) && priceUsd > 0) {
          valueUsd = holdingValueUsd(priceUsd, amounts.amountUi);
        } else if (!Number.isFinite(valueUsd)) {
          valueUsd = 0;
        }
      } else if (!Number.isFinite(valueUsd)) {
        valueUsd = 0;
      }
      return {
        mintAddress,
        symbol,
        name,
        logoUrl: row.logoUrl?.trim() || null,
        decimals: amounts.decimals,
        amountUi: amounts.amountUi,
        amountExact: amounts.amountExact,
        valueUsd,
        verified: row.verified === true,
      } satisfies WalletBalanceListItem;
    })
    .filter((row): row is WalletBalanceListItem => row != null);

  const seen = new Set(items.map((i) => i.mintAddress));
  const nativeRpc = rpcByMint.get(RPC_NATIVE_SOL_MINT);
  if (nativeRpc && nativeRpc.amountRaw > 0n && !seen.has(NATIVE_SOL_MINT)) {
    const nativeItem = await walletItemFromRpcBalance(http, nativeRpc, {
      displayMint: NATIVE_SOL_MINT,
      defaultSymbol: 'SOL',
      defaultName: 'Solana',
    });
    if (nativeItem) {
      items.push(nativeItem);
      seen.add(NATIVE_SOL_MINT);
    }
  }

  const rpcOnly: RpcMintBalance[] = [];
  for (const rpc of rpcByMint.values()) {
    if (seen.has(rpc.mintAddress) || rpc.mintAddress === RPC_NATIVE_SOL_MINT) continue;
    if (rpc.amountRaw <= 0n) continue;
    rpcOnly.push(rpc);
  }
  if (rpcOnly.length > 0) {
    const enriched = await Promise.all(
      rpcOnly.map((rpc) => walletItemFromRpcBalance(http, rpc)),
    );
    for (const item of enriched) {
      if (!item || seen.has(item.mintAddress)) continue;
      items.push(item);
      seen.add(item.mintAddress);
    }
  }

  return items
    .sort((a, b) => walletBalanceSortValue(b) - walletBalanceSortValue(a) || b.amountUi - a.amountUi)
    .slice(0, limit);
}

export async function getWalletSolBalanceUi(
  http: AxiosInstance,
  ownerAddress: string,
): Promise<number> {
  const [{ rpcByMint, rpcOk }, balance] = await Promise.all([
    fetchRpcWalletBalancesSafe(ownerAddress),
    getWalletTokenBalance(http, {
      ownerAddress,
      includeNoPriceBalance: true,
    }),
  ]);
  let totalRaw = 0n;
  if (rpcOk) {
    const native = rpcByMint.get(RPC_NATIVE_SOL_MINT);
    const wsol = rpcByMint.get(WSOL_MINT);
    if (native) totalRaw += native.amountRaw;
    if (wsol) totalRaw += wsol.amountRaw;
    return rawToUiAmount(totalRaw.toString(), 9);
  }
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
  const [{ rpcByMint, rpcOk }, balance] = await Promise.all([
    fetchRpcWalletBalancesSafe(ownerAddress),
    getWalletTokenBalance(http, {
      ownerAddress,
      mintAddresses: [m],
      includeNoPriceBalance: true,
    }),
  ]);
  if (rpcOk) {
    const rpc = rpcByMint.get(m);
    if (rpc && rpc.amountRaw > 0n) {
      return {
        amountUi: rawToUiAmount(rpc.amountRaw.toString(), rpc.decimals),
        decimals: rpc.decimals,
      };
    }
    return null;
  }
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

  const [{ rpcByMint, rpcOk }, balance] = await Promise.all([
    fetchRpcWalletBalancesSafe(ownerAddress),
    getWalletTokenBalance(http, {
      ownerAddress,
      // Vybe rejects native SOL / WSOL in mintAddresses; fetch all rows and filter locally.
      mintAddresses: isSolMint(mint) ? undefined : [mint],
      includeNoPriceBalance: true,
    }),
  ]);

  if (mint === NATIVE_SOL_MINT) {
    const symbol = 'SOL';
    let availableRaw = 0n;
    if (rpcOk) {
      availableRaw = rpcByMint.get(RPC_NATIVE_SOL_MINT)?.amountRaw ?? 0n;
    } else {
      availableRaw = rpcByMint.get(RPC_NATIVE_SOL_MINT)?.amountRaw ?? 0n;
      if (availableRaw <= 0n) {
        availableRaw = sumSolBalanceRaw(
          balance.data.filter((t) => t.mintAddress.trim() === NATIVE_SOL_MINT),
        );
      }
    }
    if (availableRaw <= 0n) {
      throw new InsufficientBalanceError(
        `Insufficient balance: no ${symbol} in this wallet.`,
        0,
        amountUi,
        symbol,
      );
    }
    const availableUi = rawToUiAmount(availableRaw.toString(), 9);

    if (availableUi < SOL_MIN_TRADABLE_TOTAL_UI) {
      throw new InsufficientBalanceError(
        `Insufficient balance: SOL amount too small to trade (minimum ${formatUiAmount(SOL_MIN_TRADABLE_TOTAL_UI)} SOL).`,
        availableUi,
        amountUi,
        symbol,
      );
    }

    const requiredRaw = uiAmountToRaw(amountUi, 9);

    if (requiredRaw > availableRaw) {
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
    let availableRaw = 0n;
    if (rpcOk) {
      availableRaw = rpcByMint.get(WSOL_MINT)?.amountRaw ?? 0n;
    } else {
      availableRaw = rpcByMint.get(WSOL_MINT)?.amountRaw ?? 0n;
      if (availableRaw <= 0n) {
        const row = balance.data.find((t) => t.mintAddress.trim() === WSOL_MINT);
        if (row) {
          availableRaw = balanceAmountToRaw(row.amount, Number(row.decimals));
        }
      }
    }
    if (availableRaw <= 0n) {
      throw new InsufficientBalanceError(
        `Insufficient balance: no ${symbol} in this wallet.`,
        0,
        amountUi,
        symbol,
      );
    }
    const availableUi = rawToUiAmount(availableRaw.toString(), 9);
    const requiredRaw = uiAmountToRaw(amountUi, 9);
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

  if (rpcOk) {
    const rpc = rpcByMint.get(mint);
    const row = balance.data.find((t) => t.mintAddress === mint);
    const symbol = row?.symbol?.trim() || symbolHint?.trim() || mint.slice(0, 6);
    const decimals = rpc?.decimals ?? Number(row?.decimals);
    if (!Number.isFinite(decimals) || decimals < 0) {
      throw new Error(`Could not read decimals for ${symbol}`);
    }
    const availableRaw = rpc?.amountRaw ?? 0n;
    if (availableRaw <= 0n) {
      throw new InsufficientBalanceError(
        `Insufficient balance: no ${symbol} in this wallet.`,
        0,
        amountUi,
        symbol,
      );
    }
    const availableUi = rawToUiAmount(availableRaw.toString(), decimals);
    const requiredRaw = uiAmountToRaw(amountUi, decimals);
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
