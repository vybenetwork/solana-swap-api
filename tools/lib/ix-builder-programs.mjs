/**
 * ix-builder supported program ids — mirrors src/api/pinned-swap-params.ts
 */

export const NATIVE_SOL_MINT = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export const IX_BUILDER_SUPPORTED_PROGRAMS = {
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: {
    ixBuilderProtocol: 'METEORA_DBC',
    label: 'Meteora DBC',
  },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: {
    ixBuilderProtocol: 'METEORA_DAMM2',
    label: 'Meteora DAMM v2',
  },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: {
    ixBuilderProtocol: 'METEORA_DLMM',
    label: 'Meteora DLMM',
  },
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: {
    ixBuilderProtocol: 'RAYDIUM_LAUNCHLAB',
    label: 'Raydium LaunchLab',
  },
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': {
    ixBuilderProtocol: 'RAYDIUM_AMM_V4',
    label: 'Raydium AMM v4',
  },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: {
    ixBuilderProtocol: 'RAYDIUM_CPMM',
    label: 'Raydium CPMM',
  },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: {
    ixBuilderProtocol: 'RAYDIUM_CLMM',
    label: 'Raydium CLMM',
  },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': {
    ixBuilderProtocol: 'PUMPFUN',
    label: 'Pump.fun',
  },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: {
    ixBuilderProtocol: 'PUMPSWAP',
    label: 'PumpSwap',
  },
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx': {
    ixBuilderProtocol: 'SANCTUM',
    label: 'Sanctum',
  },
};

export const MIN_SOLSCAN_TVL_USD = Number(process.env.SOLSCAN_MIN_TVL_USD || 100);

export function isSupportedIxBuilderProgram(programAddress) {
  return programAddress.trim() in IX_BUILDER_SUPPORTED_PROGRAMS;
}

export function programLabelForAddress(programAddress) {
  const addr = programAddress.trim();
  return IX_BUILDER_SUPPORTED_PROGRAMS[addr]?.label ?? addr;
}

export function ixBuilderProtocolForAddress(programAddress) {
  const addr = programAddress.trim();
  return IX_BUILDER_SUPPORTED_PROGRAMS[addr]?.ixBuilderProtocol;
}

export function isSolMint(mint) {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

export function parseUsd(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw || raw === '__' || raw === '—' || raw === '-') return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseCount(value) {
  if (value == null) return null;
  const raw = String(value).trim().replace(/,/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Classify scraped / API market rows for ix-builder eligibility. */
export function classifySolscanMarket(row, tokenMint) {
  const programAddress = String(row.programAddress ?? '').trim();
  const marketAddress = String(row.marketAddress ?? row.pool_id ?? '').trim();
  const tvlUsd = row.tvlUsd ?? parseUsd(row.tvl);
  const supportedProgram = isSupportedIxBuilderProgram(programAddress);
  const pairMints = Array.isArray(row.pairMints) ? row.pairMints : [];
  const linkMints = Array.isArray(row.pairTokens)
    ? row.pairTokens.map((t) => String(t.mint ?? '').trim()).filter(Boolean)
    : [];
  const allMints = [...new Set([...pairMints, ...linkMints])];
  const hasSolLeg = allMints.some(isSolMint);
  const involvesToken =
    allMints.includes(tokenMint.trim()) || pairMints.includes(tokenMint.trim()) || pairMints.length === 0;

  let tvlBucket = 'unknown';
  if (tvlUsd != null) {
    tvlBucket = tvlUsd >= MIN_SOLSCAN_TVL_USD ? 'eligible' : 'low';
  }

  const eligible =
    supportedProgram && involvesToken && (tvlBucket === 'eligible' || tvlBucket === 'unknown');

  return {
    ...row,
    marketAddress,
    programAddress,
    programLabel: row.programLabel ?? programLabelForAddress(programAddress),
    ixBuilderProtocol: ixBuilderProtocolForAddress(programAddress),
    supportedProgram,
    tvlUsd,
    tvlBucket,
    hasSolLeg,
    involvesToken,
    eligible,
  };
}

export function partitionMarkets(markets, tokenMint) {
  const classified = markets.map((m) => classifySolscanMarket(m, tokenMint));
  return {
    all: classified,
    eligible: classified.filter((m) => m.eligible),
    unsupported: classified.filter((m) => !m.supportedProgram),
    lowTvl: classified.filter((m) => m.supportedProgram && m.tvlBucket === 'low'),
    solPair: classified.filter((m) => m.hasSolLeg && m.involvesToken),
    solPairEligible: classified.filter((m) => m.hasSolLeg && m.involvesToken && m.eligible),
  };
}

/** Eligible ix-builder markets sorted by TVL descending (null TVL last). */
export function sortEligibleByTvl(eligible) {
  return [...eligible].sort((a, b) => {
    const ta = a.tvlUsd;
    const tb = b.tvlUsd;
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return tb - ta;
  });
}

/** Assign 1-based rank among eligible markets by TVL. */
export function rankEligibleMarketsByTvl(eligible) {
  const sorted = sortEligibleByTvl(eligible);
  const total = sorted.length;
  return sorted.map((m, i) => ({
    ...m,
    eligibleRank: i + 1,
    eligibleRankTotal: total,
  }));
}

export function eligibleRankForPool(eligibleRanked, poolAddress) {
  const pool = String(poolAddress ?? '').trim();
  if (!pool) return null;
  const row = eligibleRanked.find((m) => m.marketAddress === pool);
  const totalEligible = eligibleRanked.length;
  if (!row) {
    return {
      marketAddress: pool,
      inEligibleSet: false,
      rank: null,
      totalEligible,
      tvlUsd: null,
    };
  }
  return {
    marketAddress: row.marketAddress,
    marketHref: row.marketHref,
    pairLabel: row.pairLabel,
    programAddress: row.programAddress,
    programLabel: row.programLabel,
    ixBuilderProtocol: row.ixBuilderProtocol,
    hasSolLeg: row.hasSolLeg,
    inEligibleSet: true,
    rank: row.eligibleRank,
    totalEligible: row.eligibleRankTotal,
    tvlUsd: row.tvlUsd,
  };
}

export function displayTokenSymbol(mint, symbol) {
  if (isSolMint(mint)) return 'SOL';
  const s = String(symbol ?? '').trim();
  if (/^wsol$/i.test(s)) return 'SOL';
  return s || String(mint ?? '').slice(0, 6);
}

/** Canonical A-B pair label; SOL/WSOL first, order otherwise alphabetical. */
export function canonicalPairLabelFromMarket(row, targetMint, targetSymbol) {
  if (Array.isArray(row?.pairTokens) && row.pairTokens.length >= 2) {
    const parts = row.pairTokens.map((t) => ({
      sym: displayTokenSymbol(t.mint, t.symbol),
      isSol: isSolMint(t.mint),
    }));
    parts.sort((a, b) => {
      if (a.isSol && !b.isSol) return -1;
      if (!a.isSol && b.isSol) return 1;
      return a.sym.localeCompare(b.sym);
    });
    return parts.map((p) => p.sym).join('-');
  }
  if (row?.pairLabel) {
    const parts = String(row.pairLabel)
      .split(/[-/]/)
      .map((s) => {
        const t = s.trim();
        return /^wsol$/i.test(t) ? 'SOL' : t;
      })
      .filter(Boolean);
    parts.sort((a, b) => {
      if (a === 'SOL' && b !== 'SOL') return -1;
      if (a !== 'SOL' && b === 'SOL') return 1;
      return a.localeCompare(b);
    });
    return parts.join('-');
  }
  return `SOL-${targetSymbol || '?'}`;
}

/** Multi-hop route path e.g. SOL-USDC-BONK (SOL/WSOL interchangeable). */
export function buildRoutePathLabel(quoteRoute, tokenMint, tokenSymbol) {
  const hops = quoteRoute?.hops ?? [];
  if (hops.length === 0) return displayTokenSymbol(tokenMint, tokenSymbol);
  const segments = ['SOL'];
  for (const h of hops) {
    const out = String(h.outputMint ?? '').trim();
    if (!out || isSolMint(out)) continue;
    const sym =
      out === String(tokenMint ?? '').trim()
        ? displayTokenSymbol(out, tokenSymbol)
        : displayTokenSymbol(out, h.label?.split(/\s+/)[0] ?? '');
    if (segments[segments.length - 1] !== sym) segments.push(sym);
  }
  if (segments.length === 1 && tokenSymbol) segments.push(tokenSymbol);
  return segments.join('-');
}

function formatTvlUsd(tvlUsd) {
  if (tvlUsd == null) return 'TVL n/a';
  return `$${tvlUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} TVL`;
}

/**
 * Direct: #rank (SOL-PAIR) $TVL — rank among SOL-pair eligible by TVL.
 * Multi-hop: #HOPCOUNT (SOL-A-B-…) #r1+#r2 — per-hop rank among eligible pools.
 */
export function formatRouteEligibleNote(quoteRoute, solscanData, tokenMint, tokenSymbol) {
  const hopCount = quoteRoute.hopCount ?? quoteRoute.hops?.length ?? 1;
  const eligible = solscanData?.eligible ?? [];
  const solPairEligible = solscanData?.solPairEligible ?? [];
  const eligibleRanked = rankEligibleMarketsByTvl(eligible);
  const solPairRanked = rankEligibleMarketsByTvl(solPairEligible);

  if (hopCount <= 1) {
    const pool = quoteRoute.selected?.marketAddress || quoteRoute.hops[0]?.poolAddress || '';
    const row = solPairRanked.find((m) => m.marketAddress === pool);
    const rankInfo = eligibleRankForPool(solPairRanked, pool);
    const pair = row
      ? canonicalPairLabelFromMarket(row, tokenMint, tokenSymbol)
      : `SOL-${tokenSymbol || '?'}`;
    if (!rankInfo?.inEligibleSet) {
      const allRank = eligibleRankForPool(eligibleRanked, pool);
      if (allRank?.inEligibleSet) {
        const allRow = eligibleRanked.find((m) => m.marketAddress === pool);
        const allPair = allRow
          ? canonicalPairLabelFromMarket(allRow, tokenMint, tokenSymbol)
          : pair;
        return ` — #${allRank.rank} (${allPair}) ${formatTvlUsd(allRank.tvlUsd)} [non-SOL-pair eligible]`;
      }
      return ` — not in ${solPairRanked.length} SOL-pair eligible`;
    }
    return ` — #${rankInfo.rank} (${pair}) ${formatTvlUsd(rankInfo.tvlUsd)}`;
  }

  const path = buildRoutePathLabel(quoteRoute, tokenMint, tokenSymbol);
  const hopRankParts = quoteRoute.hops.map((h) => {
    const pool = h.poolAddress;
    const row = eligibleRanked.find((m) => m.marketAddress === pool);
    const ranked = row?.hasSolLeg ? solPairRanked : eligibleRanked;
    const info = eligibleRankForPool(ranked, pool);
    return info?.inEligibleSet ? `#${info.rank}` : '#?';
  });
  return ` — #${hopCount} (${path}) ${hopRankParts.join('+')}`;
}

export function formatEligibleRankNote(rankInfo) {
  if (!rankInfo) return '';
  if (!rankInfo.inEligibleSet) {
    return ` — not among ${rankInfo.totalEligible} eligible ix-builder markets by TVL`;
  }
  const pair = rankInfo.pairLabel ?? '?';
  return ` — #${rankInfo.rank} (${pair}) ${formatTvlUsd(rankInfo.tvlUsd)}`;
}
