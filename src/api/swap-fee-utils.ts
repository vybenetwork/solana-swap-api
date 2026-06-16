/**
 * Pure swap-fee helpers shared across swap-api (no simulation/RPC).
 */

/**
 * Normalize a router-reported swap fee into a percentage.
 * Vybe uses fraction (0.01 = 1%); Jupiter/Titan use whole percent (1 = 1%).
 */
export function normalizeSwapFeePct(
  swapFee: number | undefined | null,
  router?: string,
): number | null {
  if (swapFee == null || !Number.isFinite(swapFee) || swapFee <= 0) return null;
  const id = router?.trim().toLowerCase();
  if (id === 'jupiter' || id === 'titan') {
    return swapFee <= 100 ? swapFee : null;
  }
  if (swapFee <= 1) return swapFee * 100;
  if (swapFee <= 100) return swapFee;
  return null;
}
