/**
 * Warn when a wallet has low SOL and is selling an SPL token (needs SOL for tx fees).
 */

import type { AxiosInstance } from 'axios';
import { SOL_MIN_TX_FEE_BALANCE_UI } from '../config.js';
import { getWalletSolBalanceUi, isSolMint } from './wallet-balance.js';

export interface LowSolTradeWarningResult {
  warn: boolean;
  message?: string;
  solBalanceUi?: number;
}

function formatUiAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  const s = amount.toFixed(9).replace(/\.?0+$/, '');
  return s || '0';
}

export async function evaluateLowSolTradeWarning(
  http: AxiosInstance,
  params: {
    ownerAddress: string;
    inputMint: string;
    outputMint?: string;
    gasless: boolean;
  },
): Promise<LowSolTradeWarningResult> {
  const ownerAddress = params.ownerAddress.trim();
  const inputMint = params.inputMint.trim();

  if (!ownerAddress || !inputMint) {
    return { warn: false };
  }
  if (params.gasless) return { warn: false };
  if (isSolMint(inputMint)) return { warn: false };

  const solBalanceUi = await getWalletSolBalanceUi(http, ownerAddress);
  if (solBalanceUi >= SOL_MIN_TX_FEE_BALANCE_UI) {
    return { warn: false, solBalanceUi };
  }

  return {
    warn: true,
    solBalanceUi,
    message:
      `Low SOL balance (${formatUiAmount(solBalanceUi)} SOL). When selling SPL tokens, enable Gasless ` +
      `in advanced build options or deposit at least ${formatUiAmount(SOL_MIN_TX_FEE_BALANCE_UI)} SOL.`,
  };
}
