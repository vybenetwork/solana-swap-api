/**
 * Wallet ATA action hints for Vybe / ix-builder swap builds (DATA-2515).
 * All flags are booleans describing tx instructions — same convention as closeInputAta.
 * Input SPL ATAs are assumed to exist; no existence RPC (fail on-chain if not).
 */

import type { AxiosInstance } from 'axios';
import { getWalletTokenBalance, isSolMint, WSOL_MINT } from './wallet-balance.js';
import type { BuildSwapParams, SwapProxyRouter } from './swap-build.js';

export interface SwapWalletAtaHints {
  /** Close input SPL ATA after a full-balance sell (rent reclaim). */
  closeInputAta?: boolean;
  /** Create output SPL ATA idempotently before the swap (buy when wallet has no ATA). */
  createOutputAta?: boolean;
  /**
   * WSOL unwrap mode: true = ephemeral (sync + close entire WSOL account);
   * false = persistent WSOL ATA exists — ix-builder unwraps only this swap's output amount.
   */
  closeWsolAta?: boolean;
}

function balanceAmountToUi(amount: string, decimals: number): number {
  const trimmed = amount.trim();
  if (!trimmed) return 0;
  if (/[.eE]/.test(trimmed)) {
    const ui = Number(trimmed);
    return Number.isFinite(ui) ? ui : 0;
  }
  const n = BigInt(trimmed);
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

function balanceAmountToRaw(amount: string, decimals: number): bigint {
  return uiAmountToRaw(balanceAmountToUi(amount, decimals), decimals);
}

function walletHasMintRow(
  rows: { mintAddress: string }[],
  mint: string,
): boolean {
  return rows.some((r) => r.mintAddress.trim() === mint);
}

function wsolRowHasNonZeroBalance(
  rows: { mintAddress: string; amount: string; decimals: number }[],
): boolean {
  const row = rows.find((r) => r.mintAddress.trim() === WSOL_MINT);
  if (!row) return false;
  try {
    return balanceAmountToRaw(row.amount, row.decimals) > 0n;
  } catch {
    return balanceAmountToUi(row.amount, row.decimals) > 0;
  }
}

/** true = ephemeral WSOL (no ATA or zero balance); false = persistent WSOL with funds. */
function resolveCloseWsolAtaFromWalletRows(
  rows: { mintAddress: string; amount: string; decimals: number }[],
): boolean {
  return !wsolRowHasNonZeroBalance(rows);
}

export function appendAtaHintsToPayload(
  payload: Record<string, unknown>,
  hints: SwapWalletAtaHints,
): void {
  if (hints.closeInputAta === true) payload.closeInputAta = true;
  if (hints.createOutputAta === true) payload.createOutputAta = true;
  if (hints.closeWsolAta === true) payload.closeWsolAta = true;
  if (hints.createOutputAta === false) payload.createOutputAta = false;
  if (hints.closeWsolAta === false) payload.closeWsolAta = false;
}

function clientAtaHintsAreComplete(body: BuildSwapParams): boolean {
  if (typeof body.closeWsolAta !== 'boolean') return false;
  const outputIsSol = isSolMint(body.outputMintAddress.trim());
  if (!outputIsSol && typeof body.createOutputAta !== 'boolean') return false;
  return true;
}

/** True when wallet ATA flags are set — skip wallet-balance RPC on repeated builds. */
export function buildParamsHaveCompleteAtaHints(body: BuildSwapParams): boolean {
  return clientAtaHintsAreComplete(body);
}

function applyClientProvidedAtaHints(body: BuildSwapParams): BuildSwapParams {
  let amount = body.amount;
  let closeInputAta = body.closeInputAta === true;

  const inputIsSpl = !isSolMint(body.inputMintAddress.trim());
  const exact = body.inputBalanceExact?.trim();
  const decimals = body.inputDecimals;

  if (inputIsSpl && exact && closeInputAta) {
    const dec = Number.isFinite(decimals) && (decimals ?? 0) >= 0 ? Number(decimals) : 6;
    const exactUi = balanceAmountToUi(exact, dec);
    if (exactUi > 0) amount = exactUi;
    closeInputAta = true;
  } else if (inputIsSpl && exact && !closeInputAta) {
    const dec = Number.isFinite(decimals) && (decimals ?? 0) >= 0 ? Number(decimals) : 6;
    const exactRaw = balanceAmountToRaw(exact, dec);
    const amountRaw = uiAmountToRaw(amount, dec);
    if (exactRaw > 0n && amountRaw >= exactRaw) {
      amount = balanceAmountToUi(exact, dec);
      closeInputAta = true;
    }
  } else if (!inputIsSpl) {
    closeInputAta = false;
  }

  return {
    ...body,
    amount,
    closeInputAta: closeInputAta ? true : undefined,
    createOutputAta: body.createOutputAta,
    closeWsolAta: body.closeWsolAta,
  };
}

export async function resolveSwapWalletAtaHints(
  http: AxiosInstance,
  params: {
    accountAddress: string;
    inputMintAddress: string;
    outputMintAddress: string;
    amount: number;
    router?: SwapProxyRouter;
    closeInputAta?: boolean;
  },
): Promise<{ hints: SwapWalletAtaHints; amount: number }> {
  const router = params.router ?? 'vybe';
  if (router !== 'vybe') {
    return { hints: {}, amount: params.amount };
  }

  const inputMint = params.inputMintAddress.trim();
  const outputMint = params.outputMintAddress.trim();
  const outputIsSol = isSolMint(outputMint);
  const inputIsSpl = !isSolMint(inputMint);

  const mintsToFetch = new Set<string>([WSOL_MINT]);
  if (inputIsSpl) mintsToFetch.add(inputMint);
  if (!outputIsSol && outputMint !== WSOL_MINT) mintsToFetch.add(outputMint);

  const mintFilter = [...mintsToFetch];
  const balance = await getWalletTokenBalance(http, {
    ownerAddress: params.accountAddress.trim(),
    mintAddresses: mintFilter.length === 1 ? mintFilter : undefined,
    includeNoPriceBalance: true,
  });

  const rows = balance.data;
  const inputRow = inputIsSpl
    ? rows.find((r) => r.mintAddress.trim() === inputMint)
    : undefined;

  const hints: SwapWalletAtaHints = {
    closeWsolAta: resolveCloseWsolAtaFromWalletRows(rows),
  };
  if (!outputIsSol && outputMint !== WSOL_MINT) {
    hints.createOutputAta = !walletHasMintRow(rows, outputMint);
  }

  let amount = params.amount;
  let closeInputAta = params.closeInputAta === true;

  if (inputIsSpl && inputRow) {
    const decimals = Number(inputRow.decimals);
    const exactUi = balanceAmountToUi(inputRow.amount, decimals);
    const exactRaw = balanceAmountToRaw(inputRow.amount, decimals);
    const amountRaw = uiAmountToRaw(params.amount, decimals);
    const isFullSell =
      closeInputAta || amountRaw === exactRaw || (amountRaw > 0n && amountRaw >= exactRaw);
    if (isFullSell && exactRaw > 0n) {
      amount = exactUi;
      closeInputAta = true;
    }
  } else {
    closeInputAta = false;
  }

  if (closeInputAta) hints.closeInputAta = true;
  return { hints, amount };
}

export async function enrichBuildParamsWithAtaHints(
  http: AxiosInstance,
  body: BuildSwapParams,
): Promise<BuildSwapParams> {
  const router = body.router ?? 'vybe';
  if (router !== 'vybe') return body;

  if (clientAtaHintsAreComplete(body)) {
    return applyClientProvidedAtaHints(body);
  }

  const { hints, amount } = await resolveSwapWalletAtaHints(http, {
    accountAddress: body.accountAddress,
    inputMintAddress: body.inputMintAddress,
    outputMintAddress: body.outputMintAddress,
    amount: body.amount,
    router,
    closeInputAta: body.closeInputAta,
  });

  return {
    ...body,
    amount,
    closeInputAta: hints.closeInputAta ?? body.closeInputAta,
    createOutputAta: body.createOutputAta ?? hints.createOutputAta,
    closeWsolAta: body.closeWsolAta ?? hints.closeWsolAta,
  };
}
