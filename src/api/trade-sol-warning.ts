/**
 * Warn when a wallet has low SOL, is selling an SPL token, and may need to create
 * the output token account (unless gasless is enabled).
 */

import type { AxiosInstance } from 'axios';
import { SOL_MIN_TX_FEE_BALANCE_UI } from '../config.js';
import { walletHasTokenAccountForMint } from './solana-token-account.js';
import { getWalletSolBalanceUi, isSolMint } from './wallet-balance.js';

export interface LowSolTradeWarningResult {
  warn: boolean;
  message?: string;
  solBalanceUi?: number;
  outputAccountExists?: boolean;
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
    outputMint: string;
    gasless: boolean;
  },
): Promise<LowSolTradeWarningResult> {
  const ownerAddress = params.ownerAddress.trim();
  const inputMint = params.inputMint.trim();
  const outputMint = params.outputMint.trim();

  if (!ownerAddress || !inputMint || !outputMint) {
    return { warn: false };
  }
  if (params.gasless) return { warn: false };
  if (isSolMint(inputMint)) return { warn: false };

  const solBalanceUi = await getWalletSolBalanceUi(http, ownerAddress);
  if (solBalanceUi >= SOL_MIN_TX_FEE_BALANCE_UI) {
    return { warn: false, solBalanceUi };
  }

  const outputAccountExists = await walletHasTokenAccountForMint(ownerAddress, outputMint);
  if (outputAccountExists) {
    return { warn: false, solBalanceUi, outputAccountExists };
  }

  return {
    warn: true,
    solBalanceUi,
    outputAccountExists,
    message:
      `Low SOL balance (${formatUiAmount(solBalanceUi)} SOL). Enable Gasless in advanced build options ` +
      `or deposit at least ${formatUiAmount(SOL_MIN_TX_FEE_BALANCE_UI)} SOL to pay transaction fees ` +
      `and create a token account for the token you're buying.`,
  };
}
