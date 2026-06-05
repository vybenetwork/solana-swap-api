/**
 * Native SOL vs WSOL — Vybe swap APIs use WSOL; wallets hold native SOL.
 */

export const NATIVE_SOL_MINT = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export function isSolMint(mint: string): boolean {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

/** Map UI / wallet native SOL to the mint Vybe swap endpoints expect. */
export function toVybeSwapMint(mint: string): string {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT ? WSOL_MINT : m;
}

/** Prefer native SOL in the UI when either SOL mint is selected. */
export function preferNativeSolMint(mint: string): string {
  const m = mint.trim();
  return m === WSOL_MINT ? NATIVE_SOL_MINT : m;
}
