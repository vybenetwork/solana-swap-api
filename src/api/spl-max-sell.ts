/**
 * Max SPL sell amount when input-side fees require leaving balance in the wallet.
 * Empirically ~2% below wallet balance when swapFee is 1% (Jupiter/Vybe USDC max sell).
 */

import { normalizeSwapFeePct } from './swap-fee-utils.js';
import { isSolMint } from './wallet-balance.js';

/** Each retry step lowers sell amount by this many percent of wallet balance. */
export const SPL_SELL_SIM_RETRY_STEP_PCT = 2;
/** Max sell-amount attempts per router before switching (100%, 98%, 96%). */
export const SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER = 3;
/** @deprecated Use SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER. */
export const SPL_SELL_SIM_MAX_STEPS = SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER;
/** Stop retrying once sell amount falls below this fraction of wallet balance. */
export const SPL_SELL_SIM_MIN_BALANCE_FRACTION = 0.5;

/** @deprecated Use computeSplSellAmountForRetryStep(balance, 1). */
export const SPL_SELL_SIM_RETRY_FRACTION = 1 - SPL_SELL_SIM_RETRY_STEP_PCT / 100;

export function isNearMaxSplSellAmountUi(amountUi: number, balanceUi: number): boolean {
  if (!Number.isFinite(amountUi) || !Number.isFinite(balanceUi) || balanceUi <= 0) return false;
  return amountUi >= balanceUi * 0.995;
}

/** step 1 → 98% of balance, step 2 → 96%, etc. */
export function computeSplSellAmountForRetryStep(balanceUi: number, step: number): number {
  if (!Number.isFinite(balanceUi) || balanceUi <= 0 || step <= 0) return 0;
  const fraction = Math.max(
    SPL_SELL_SIM_MIN_BALANCE_FRACTION,
    1 - (SPL_SELL_SIM_RETRY_STEP_PCT / 100) * step,
  );
  return balanceUi * fraction;
}

export function computeSplSellRetryAmountUi(
  balanceUi: number,
  swapFee: unknown,
  router?: string,
  maxFraction?: number | null,
): number {
  if (!Number.isFinite(balanceUi) || balanceUi <= 0) return 0;
  const feePct = normalizeSwapFeePct(
    typeof swapFee === 'number' ? swapFee : Number(swapFee),
    router,
  );
  let amount = computeSplSellAmountForRetryStep(balanceUi, 1);
  if (feePct != null && feePct > 0) {
    const feeAdjusted = balanceUi / (1 + feePct / 100) * 0.99;
    amount = Math.min(amount, feeAdjusted);
  }
  if (maxFraction != null && maxFraction > 0 && maxFraction < 1) {
    amount = Math.min(amount, balanceUi * maxFraction);
  }
  return amount;
}

export function shouldContinueSplSellSimRetry(
  inputMint: string,
  amountUi: number,
  balanceUi: number,
  step: number,
): boolean {
  if (isSolMint(inputMint)) return false;
  if (step >= SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER - 1) return false;
  if (!Number.isFinite(balanceUi) || balanceUi <= 0) return false;
  if (amountUi < balanceUi * SPL_SELL_SIM_MIN_BALANCE_FRACTION) return false;
  return true;
}

export function swapSimulationFailed(
  simulatedOutRaw: string | null | undefined,
  buildTx: unknown,
  simulationErr?: unknown,
): boolean {
  if (simulationErr != null) return true;
  if (!buildTx || typeof buildTx !== 'string' || buildTx.length === 0) return false;
  return simulatedOutRaw == null || simulatedOutRaw === '';
}

export function shouldRetrySplMaxSellAfterSimFailure(
  inputMint: string,
  amountUi: number,
  balanceUi: number,
  simulatedOutRaw: string | null | undefined,
  buildTx: unknown,
  simulationErr?: unknown,
): boolean {
  if (isSolMint(inputMint)) return false;
  if (!swapSimulationFailed(simulatedOutRaw, buildTx, simulationErr)) return false;
  return isNearMaxSplSellAmountUi(amountUi, balanceUi);
}
