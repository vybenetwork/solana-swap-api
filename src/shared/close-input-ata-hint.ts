import { isSolMint } from '../api/sol-mints.js';

export function uiAmountToRaw(amountUi: number, decimals: number): bigint {
  const fixed = Number(amountUi).toFixed(Math.min(decimals, 12));
  const [wholePart, fracPart = ''] = fixed.split('.');
  const whole = BigInt(wholePart || '0');
  const frac = BigInt(fracPart.padEnd(decimals, '0').slice(0, decimals) || '0');
  return whole * 10n ** BigInt(decimals) + frac;
}

/** Never close a native-SOL/WSOL input ATA; close SPL input ATA only on full-balance sells. */
export function resolveCloseInputAtaHint(params: {
  inputMint: string;
  amountUi: number;
  exactBalanceRaw: bigint | null | undefined;
  decimals: number;
  maxSellSelected?: boolean;
}): boolean {
  if (isSolMint(params.inputMint)) return false;
  const exactRaw = params.exactBalanceRaw;
  if (exactRaw == null || exactRaw <= 0n) return false;
  if (params.maxSellSelected) return true;
  const amountRaw = uiAmountToRaw(params.amountUi, params.decimals);
  return amountRaw >= exactRaw;
}
