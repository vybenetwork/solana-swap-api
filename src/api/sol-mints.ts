/**
 * Native SOL vs WSOL — Vybe swap APIs use WSOL; wallets hold native SOL.
 */

export const NATIVE_SOL_MINT = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export function isSolMint(mint: string): boolean {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

export function isNativeSolMint(mint: string): boolean {
  return mint.trim() === NATIVE_SOL_MINT;
}

export function isWsolMint(mint: string): boolean {
  return mint.trim() === WSOL_MINT;
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

/** Canonical mint for price resolve / Vybe token fetch (always WSOL). */
export function canonicalPriceResolveMint(mint: string): string {
  return toVybeSwapMint(mint);
}

/** Collapse native SOL + WSOL to a single WSOL entry before price API fetches. */
export function dedupeMintsForPriceResolve(mints: string[]): string[] {
  const out: string[] = [];
  let solSeen = false;
  for (const raw of mints) {
    const m = raw.trim();
    if (!m) continue;
    if (isSolMint(m)) {
      if (solSeen) continue;
      solSeen = true;
      out.push(WSOL_MINT);
      continue;
    }
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** Keep a single WSOL entry for SOL price stats in resolve responses. */
export function canonicalizeSolPriceStats<T extends { price: number }>(
  stats: Record<string, T>,
): Record<string, T> {
  const wsol = stats[WSOL_MINT];
  const native = stats[NATIVE_SOL_MINT];
  const canonical = wsol ?? native;
  if (!canonical) {
    const { [NATIVE_SOL_MINT]: _drop, ...rest } = stats;
    return rest;
  }
  const { [NATIVE_SOL_MINT]: _drop, ...rest } = stats;
  return { ...rest, [WSOL_MINT]: canonical };
}
