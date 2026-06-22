/** Warning shortfall %: no decimals when ≥10%, else always 2 decimal places. */
export function formatWarnPercent(pct: number): string {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 10) return abs.toFixed(2);
  return String(Math.round(abs));
}
