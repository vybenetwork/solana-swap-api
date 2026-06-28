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

/** Pegged USD stablecoins — resolve price via Vybe token-details before Jupiter/pump.fun. */
export const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'JEFFSQ3s8T3wKsvp4tnRAsUBW7Cqgnf8ukBZC4C8XBm1', // sUSDC-9
  'Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1', // USDTen
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', // UXD
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', // USDH
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', // USDCet
  'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', // USDY
  'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', // USDe
]);

export function isStablecoinMint(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint.trim());
}

/** WSOL/native SOL and stables: Vybe token-details → Jupiter → pump.fun. */
export function isVybeFirstPriceMint(mint: string): boolean {
  const m = mint.trim();
  return isSolMint(m) || isStablecoinMint(m);
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

/** Mirror WSOL price stats onto native SOL (and vice versa) in resolve responses. */
export function aliasSolPriceStats<T extends { price: number }>(
  stats: Record<string, T>,
): Record<string, T> {
  const wsol = stats[WSOL_MINT];
  const native = stats[NATIVE_SOL_MINT];
  const canonical = wsol ?? native;
  if (!canonical) return stats;
  return {
    ...stats,
    [WSOL_MINT]: canonical,
    [NATIVE_SOL_MINT]: canonical,
  };
}

/**
 * Map fetched stats onto requested mints without duplicating the SOL family.
 * Network fetch uses WSOL only; response includes at most one SOL-family key (WSOL).
 */
export function projectStatsToRequestedMints<T extends { price: number }>(
  requestedMints: string[],
  fetched: Record<string, T>,
): Record<string, T> {
  const requested = [...new Set(requestedMints.map((m) => m.trim()).filter(Boolean))];
  const out: Record<string, T> = {};
  const solRequested = requested.some((m) => isSolMint(m));

  for (const m of requested) {
    if (isSolMint(m)) continue;
    const canonical = toVybeSwapMint(m);
    const stat = fetched[canonical] ?? fetched[m];
    if (stat) out[m] = stat;
  }

  if (solRequested) {
    const solStat = fetched[WSOL_MINT] ?? fetched[NATIVE_SOL_MINT];
    if (solStat) out[WSOL_MINT] = solStat;
  }

  return out;
}
