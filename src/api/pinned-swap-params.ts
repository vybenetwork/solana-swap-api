/**
 * Vybe pinned swap: program id ↔ OpenAPI protocol name.
 * Pinned swaps accept poolAddress + programAddress and/or protocol; missing fields are derived.
 */

import type { SwapProxyProtocol } from './swap-build.js';

export const IX_BUILDER_SUPPORTED_PROGRAMS: Record<
  string,
  { protocol: SwapProxyProtocol; ixBuilderProtocol: string; label: string }
> = {
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': {
    protocol: 'METEORADBC',
    ixBuilderProtocol: 'METEORA_DBC',
    label: 'Meteora DBC',
  },
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': {
    protocol: 'METEORADAMM2',
    ixBuilderProtocol: 'METEORA_DAMM2',
    label: 'Meteora DAMM v2',
  },
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': {
    protocol: 'METEORADLMM',
    ixBuilderProtocol: 'METEORA_DLMM',
    label: 'Meteora DLMM',
  },
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': {
    protocol: 'RAYDIUMLAUNCHLAB',
    ixBuilderProtocol: 'RAYDIUM_LAUNCHLAB',
    label: 'Raydium LaunchLab',
  },
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': {
    protocol: 'RAYDIUMAMMV4',
    ixBuilderProtocol: 'RAYDIUM_AMM_V4',
    label: 'Raydium AMM v4',
  },
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': {
    protocol: 'RAYDIUMCPMM',
    ixBuilderProtocol: 'RAYDIUM_CPMM',
    label: 'Raydium CPMM',
  },
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': {
    protocol: 'RAYDIUMCLMM',
    ixBuilderProtocol: 'RAYDIUM_CLMM',
    label: 'Raydium CLMM',
  },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': {
    protocol: 'PUMPFUN',
    ixBuilderProtocol: 'PUMPFUN',
    label: 'Pump.fun',
  },
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': {
    protocol: 'PUMPSWAP',
    ixBuilderProtocol: 'PUMPSWAP',
    label: 'PumpSwap',
  },
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx': {
    protocol: 'SANCTUM',
    ixBuilderProtocol: 'SANCTUM',
    label: 'Sanctum',
  },
};

const PROTOCOL_TO_PROGRAM = Object.fromEntries(
  Object.entries(IX_BUILDER_SUPPORTED_PROGRAMS).map(([programId, meta]) => [meta.protocol, programId]),
) as Record<SwapProxyProtocol, string>;

export const IX_BUILDER_PROGRAM_IDS = Object.keys(IX_BUILDER_SUPPORTED_PROGRAMS);

export function programAddressToProtocol(programAddress: string): SwapProxyProtocol | undefined {
  return IX_BUILDER_SUPPORTED_PROGRAMS[programAddress.trim()]?.protocol;
}

export function programAddressToIxBuilderProtocol(programAddress: string): string | undefined {
  return IX_BUILDER_SUPPORTED_PROGRAMS[programAddress.trim()]?.ixBuilderProtocol;
}

export function protocolToProgramAddress(protocol: SwapProxyProtocol): string | undefined {
  return PROTOCOL_TO_PROGRAM[protocol];
}

export function programLabelForAddress(programAddress: string): string {
  const addr = programAddress.trim();
  if (!addr) return '';
  return IX_BUILDER_SUPPORTED_PROGRAMS[addr]?.label ?? addr;
}

export function isSupportedIxBuilderProgram(programAddress: string): boolean {
  return programAddress.trim() in IX_BUILDER_SUPPORTED_PROGRAMS;
}

/** CLMM/DLMM (tick/bin arrays) — used for logging labels only. */
export const TICK_ARRAY_IX_BUILDER_PROTOCOLS = new Set(['METEORA_DLMM', 'RAYDIUM_CLMM']);
/** Exclude route candidates below this USD liquidity when a market score is known. */
export const MIN_ROUTE_POOL_LIQUIDITY_USD = 1000;
/** When pre-filter candidate count is at or below this, keep sub-floor pools for simulation. */
export const SPARSE_ROUTE_CANDIDATE_BYPASS_MAX = 3;
/** @deprecated Use MIN_ROUTE_POOL_LIQUIDITY_USD */
export const MIN_TICK_ARRAY_LIQUIDITY_USD = MIN_ROUTE_POOL_LIQUIDITY_USD;

export interface LowLiquidityWarning {
  warn: true;
  thresholdUsd: number;
  liquidityUsd: number;
}

export function computeLowLiquidityWarning(
  marketScoreUsd: number | undefined | null,
): LowLiquidityWarning | null {
  const score = Number(marketScoreUsd);
  if (!Number.isFinite(score) || score <= 0) return null;
  if (score >= MIN_ROUTE_POOL_LIQUIDITY_USD) return null;
  return {
    warn: true,
    thresholdUsd: MIN_ROUTE_POOL_LIQUIDITY_USD,
    liquidityUsd: Math.round(score * 100) / 100,
  };
}

export function isTickArrayProgram(programAddress: string): boolean {
  const proto = programAddressToIxBuilderProtocol(programAddress);
  return proto != null && TICK_ARRAY_IX_BUILDER_PROTOCOLS.has(proto);
}

export function poolLiquidityUsd(entry: {
  marketScore?: number;
  totalValueUsd?: number;
}): number {
  return Number(entry.marketScore ?? entry.totalValueUsd ?? 0);
}

function hasKnownPoolLiquidityUsd(entry: {
  marketScore?: number;
  totalValueUsd?: number;
}): boolean {
  return entry.marketScore != null || entry.totalValueUsd != null;
}

export function passesRouteLiquidityFloor(entry: {
  programAddress: string;
  marketScore?: number;
  totalValueUsd?: number;
}): boolean {
  if (!hasKnownPoolLiquidityUsd(entry)) return true;
  return poolLiquidityUsd(entry) >= MIN_ROUTE_POOL_LIQUIDITY_USD;
}

/** @deprecated Use passesRouteLiquidityFloor */
export function passesTickArrayLiquidityFloor(entry: {
  programAddress: string;
  marketScore?: number;
  totalValueUsd?: number;
}): boolean {
  return passesRouteLiquidityFloor(entry);
}

export function enrichCandidatesWithMarketScores<
  T extends { marketAddress: string; programAddress: string; marketScore?: number },
>(tradeCandidates: T[], marketCandidates: T[]): T[] {
  const marketByKey = new Map<string, number>();
  for (const m of marketCandidates) {
    if (m.marketScore != null) {
      marketByKey.set(`${m.marketAddress.trim()}\0${m.programAddress.trim()}`, m.marketScore);
    }
  }
  return tradeCandidates.map((c) => {
    const key = `${c.marketAddress.trim()}\0${c.programAddress.trim()}`;
    const marketScore = c.marketScore ?? marketByKey.get(key);
    return marketScore != null ? { ...c, marketScore } : c;
  });
}

/** True when a route candidate is a Meteora DLMM pool (not CLMM or other Meteora variants). */
export function isMeteoraDlmmCandidate(entry: {
  ixBuilderProtocol?: string;
  protocol?: string;
  programAddress?: string;
}): boolean {
  const proto =
    entry.ixBuilderProtocol ??
    (entry.programAddress ? programAddressToIxBuilderProtocol(entry.programAddress) : undefined);
  return proto === 'METEORA_DLMM';
}

/** DLMM swapQuote fails when active bins lack depth; lower-ranked DLMM pools will fail too. */
export function isMeteoraDlmmInsufficientBinLiquidityError(message: string): boolean {
  return /insufficient liquidity in binarrays/i.test(message);
}

export function filterRouteQueueByLiquidity<
  T extends { marketAddress?: string; programAddress: string; marketScore?: number; totalValueUsd?: number },
>(entries: T[], label = 'queue', options: { bypassLiquidityFloor?: boolean } = {}): T[] {
  const bypassLiquidityFloor =
    options.bypassLiquidityFloor === true ||
    (entries.length > 0 && entries.length <= SPARSE_ROUTE_CANDIDATE_BYPASS_MAX);
  const kept: T[] = [];
  let dropped = 0;
  let bypassedBelowFloor = 0;
  for (const entry of entries) {
    const passes = bypassLiquidityFloor || passesRouteLiquidityFloor(entry);
    if (passes) {
      if (bypassLiquidityFloor && hasKnownPoolLiquidityUsd(entry) && !passesRouteLiquidityFloor(entry)) {
        bypassedBelowFloor += 1;
      }
      kept.push(entry);
    } else {
      dropped += 1;
      const addr = (entry.marketAddress ?? '').slice(0, 8);
      const proto = programAddressToIxBuilderProtocol(entry.programAddress) ?? '?';
      console.info(
        `[route-discovery] skip ${label} ${proto} ${addr}… ` +
          `($${poolLiquidityUsd(entry).toFixed(2)} < $${MIN_ROUTE_POOL_LIQUIDITY_USD} liquidity floor)`,
      );
    }
  }
  if (bypassedBelowFloor > 0) {
    console.info(
      `[route-discovery] liquidity floor bypassed for ${label} (${entries.length} ≤ ${SPARSE_ROUTE_CANDIDATE_BYPASS_MAX} — kept ${bypassedBelowFloor} sub-$${MIN_ROUTE_POOL_LIQUIDITY_USD})`,
    );
  } else if (dropped > 0) {
    console.info(
      `[route-discovery] liquidity floor: excluded ${dropped} below $${MIN_ROUTE_POOL_LIQUIDITY_USD}`,
    );
  }
  return kept;
}

export const PINNED_POOL_REQUIRES_PROTOCOL_OR_PROGRAM =
  'Protocol or program must be selected when a pool address is provided';

/** poolAddress alone is invalid — require protocol and/or programAddress. */
export function validatePinnedPoolParams(params: {
  poolAddress?: string;
  protocol?: SwapProxyProtocol | string | null;
  programAddress?: string;
}): string | undefined {
  const poolAddress = params.poolAddress?.trim();
  if (!poolAddress) return undefined;
  const hasProgram = Boolean(params.programAddress?.trim());
  const hasProtocol =
    params.protocol != null && String(params.protocol).trim() !== '';
  if (!hasProgram && !hasProtocol) return PINNED_POOL_REQUIRES_PROTOCOL_OR_PROGRAM;
  return undefined;
}

export function assertPinnedPoolParams(params: {
  poolAddress?: string;
  protocol?: SwapProxyProtocol | string | null;
  programAddress?: string;
}): void {
  const err = validatePinnedPoolParams(params);
  if (err) throw new Error(err);
}

/** Fill missing protocol or programAddress when a pool pin is partially specified. */
export function completePinnedSwapParams<T extends {
  poolAddress?: string;
  protocol?: SwapProxyProtocol;
  programAddress?: string;
}>(params: T): T {
  assertPinnedPoolParams(params);
  const poolAddress = params.poolAddress?.trim();
  if (!poolAddress) return params;

  let protocol = params.protocol;
  let programAddress = params.programAddress?.trim();

  if (programAddress && !protocol) {
    protocol = programAddressToProtocol(programAddress);
  }
  if (protocol && !programAddress) {
    programAddress = protocolToProgramAddress(protocol);
  }

  if (!protocol && !programAddress) return params;

  return {
    ...params,
    poolAddress,
    ...(protocol ? { protocol } : {}),
    ...(programAddress ? { programAddress } : {}),
  };
}
