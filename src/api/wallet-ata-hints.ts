/**
 * Wallet ATA action hints for Vybe / ix-builder swap builds (DATA-2515).
 * All flags are booleans describing tx instructions — same convention as closeInputAta.
 * Input SPL ATAs are assumed to exist; no existence RPC (fail on-chain if not).
 */

import type { AxiosInstance } from 'axios';
import { getWalletTokenBalance, isSolMint, WSOL_MINT } from './wallet-balance.js';
import type { BuildSwapParams, SwapProxyRouter } from './swap-build.js';
import { resolveCloseInputAtaHint, uiAmountToRaw } from '../shared/close-input-ata-hint.js';

export interface SwapWalletAtaHints {
  /** Close input SPL ATA after a full-balance sell (rent reclaim). */
  closeInputAta?: boolean;
  /** Create output SPL ATA idempotently before the swap (buy when wallet has no ATA). */
  createOutputAta?: boolean;
  /**
   * WSOL unwrap mode: true = ephemeral (no WSOL ATA — create seed account, sync + close);
   * false = open WSOL ATA exists (even at zero balance) — ix-builder uses persistent ATA path.
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

function balanceAmountToRaw(amount: string, decimals: number): bigint {
  return uiAmountToRaw(balanceAmountToUi(amount, decimals), decimals);
}

function walletHasMintRow(
  rows: { mintAddress: string }[],
  mint: string,
): boolean {
  return rows.some((r) => r.mintAddress.trim() === mint);
}

/** true = ephemeral WSOL (no open ATA); false = persistent WSOL ATA exists (any balance). */
function resolveCloseWsolAtaFromWalletRows(rows: { mintAddress: string }[]): boolean {
  return !walletHasMintRow(rows, WSOL_MINT);
}

export function appendAtaHintsToPayload(
  payload: Record<string, unknown>,
  hints: SwapWalletAtaHints,
): void {
  if (hints.closeInputAta === true) payload.closeInputAta = true;
  if (hints.closeInputAta === false) payload.closeInputAta = false;
  if (hints.createOutputAta === true) payload.createOutputAta = true;
  if (hints.closeWsolAta === true) payload.closeWsolAta = true;
  if (hints.createOutputAta === false) payload.createOutputAta = false;
  if (hints.closeWsolAta === false) payload.closeWsolAta = false;
}

function clientAtaHintsAreComplete(body: BuildSwapParams): boolean {
  if (typeof body.closeWsolAta !== 'boolean') return false;
  if (typeof body.closeInputAta !== 'boolean') return false;
  const outputIsSol = isSolMint(body.outputMintAddress.trim());
  if (!outputIsSol && typeof body.createOutputAta !== 'boolean') return false;
  return true;
}

/** True when wallet ATA flags are set — skip wallet-balance RPC on repeated builds. */
export function buildParamsHaveCompleteAtaHints(body: BuildSwapParams): boolean {
  return clientAtaHintsAreComplete(body);
}

function applyClientProvidedAtaHints(body: BuildSwapParams): BuildSwapParams {
  const inputMint = body.inputMintAddress.trim();
  let amount = body.amount;
  const decimals = body.inputMintDecimals ?? body.inputDecimals;
  const dec = Number.isFinite(decimals) && (decimals ?? 0) >= 0 ? Number(decimals) : 6;
  const exact = body.inputBalanceExact?.trim();

  let closeInputAta: boolean;
  if (typeof body.closeInputAta === 'boolean' && isSolMint(inputMint)) {
    closeInputAta = false;
  } else if (exact && !isSolMint(inputMint)) {
    const exactRaw = /^\d+$/.test(exact) ? BigInt(exact) : balanceAmountToRaw(exact, dec);
    closeInputAta = resolveCloseInputAtaHint({
      inputMint,
      amountUi: amount,
      exactBalanceRaw: exactRaw,
      decimals: dec,
    });
    if (closeInputAta && exactRaw > 0n) {
      amount = balanceAmountToUi(exact, dec);
    }
  } else if (typeof body.closeInputAta === 'boolean') {
    closeInputAta = body.closeInputAta;
  } else {
    closeInputAta = resolveCloseInputAtaHint({
      inputMint,
      amountUi: amount,
      exactBalanceRaw: null,
      decimals: dec,
    });
  }

  return {
    ...body,
    amount,
    closeInputAta,
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
    createOutputAta?: boolean;
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

  const outputIsSpl = !outputIsSol && outputMint !== WSOL_MINT;
  const skipOutputAtaExistenceCheck = typeof params.createOutputAta === 'boolean';

  const mintsToFetch = new Set<string>([WSOL_MINT]);
  if (inputIsSpl) mintsToFetch.add(inputMint);
  if (outputIsSpl && !skipOutputAtaExistenceCheck) mintsToFetch.add(outputMint);

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
  if (outputIsSpl) {
    if (params.createOutputAta === true) {
      hints.createOutputAta = true;
    } else if (params.createOutputAta === false) {
      hints.createOutputAta = false;
    } else {
      hints.createOutputAta = !walletHasMintRow(rows, outputMint);
    }
  }

  let amount = params.amount;
  const closeInputAta = inputIsSpl && inputRow
    ? (() => {
        const decimals = Number(inputRow.decimals);
        const exactRaw = balanceAmountToRaw(inputRow.amount, decimals);
        const resolved = resolveCloseInputAtaHint({
          inputMint,
          amountUi: params.amount,
          exactBalanceRaw: exactRaw,
          decimals,
        });
        if (resolved) {
          amount = balanceAmountToUi(inputRow.amount, decimals);
        }
        return resolved;
      })()
    : resolveCloseInputAtaHint({
        inputMint,
        amountUi: params.amount,
        exactBalanceRaw: null,
        decimals: 9,
      });

  hints.closeInputAta = closeInputAta;
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
    createOutputAta: body.createOutputAta,
  });

  return {
    ...body,
    amount,
    closeInputAta: hints.closeInputAta ?? resolveCloseInputAtaHint({
      inputMint: body.inputMintAddress.trim(),
      amountUi: amount,
      exactBalanceRaw: null,
      decimals: body.inputMintDecimals ?? body.inputDecimals ?? 6,
    }),
    createOutputAta: body.createOutputAta ?? hints.createOutputAta,
    closeWsolAta: body.closeWsolAta ?? hints.closeWsolAta,
  };
}
