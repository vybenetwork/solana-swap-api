/**
 * Route via Trades: rank recent trade markets for a mint pair and map program → Vybe protocol.
 * Supported programs mirror ix-builder-api (Vybe swap router direct integrations).
 */

import type { AxiosInstance } from 'axios';
import { Connection } from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';
import type { VybeTrade } from '../types/api.js';
import type { SwapProxyProtocol } from './swap-build.js';
import {
  completePinnedSwapParams,
  isSupportedIxBuilderProgram,
  IX_BUILDER_PROGRAM_IDS,
  programAddressToIxBuilderProtocol,
  programAddressToProtocol,
  programLabelForAddress,
} from './pinned-swap-params.js';
export {
  isSupportedIxBuilderProgram,
  IX_BUILDER_PROGRAM_IDS,
  programAddressToIxBuilderProtocol,
  programAddressToProtocol,
  programLabelForAddress,
} from './pinned-swap-params.js';
import { isIxBuilderQuoteToken } from './ix-builder-quote-tokens.js';
import { staticAccountKeysFromSwapTx, validateTradeRoutedBuildOnChain } from './pool-address-validation.js';
import { toVybeSwapMint } from './sol-mints.js';
import { getTrades, type GetTradesParams } from './trades.js';

export const ROUTE_VIA_TRADES_LIMIT = 1000;
export const ROUTE_VIA_TRADES_DISPLAY_MARKETS = 15;
/** Keep pools with tradeCount >= this fraction × busiest pool (e.g. 0.05 → ≥5%). */
export const ROUTE_VIA_TRADES_MIN_COUNT_FRACTION = 0.05;
/** Max pinned build attempts from the eligible trade-ranked queue. */
export const ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS = 5;
/** @deprecated Use ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS */
export const ROUTE_VIA_TRADES_TOP_MARKETS = ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS;

export interface TradeMarketCandidate {
  marketAddress: string;
  programAddress: string;
  protocol?: SwapProxyProtocol;
  ixBuilderProtocol?: string;
  tradeCount: number;
}

/** Ranked row included in `_routeViaTrades.topMarkets` on quote responses. */
export interface RankedTradeMarket extends TradeMarketCandidate {
  rank: number;
  programLabel: string;
  supportedProgram: boolean;
  eligible: boolean;
}

export interface RouteViaTradesMarketResolution {
  topMarkets: RankedTradeMarket[];
  queueCandidates: TradeMarketCandidate[];
  maxTradeCount: number;
  minCountThreshold: number;
}

export function tradeInvolvesMintPair(t: VybeTrade, mintA: string, mintB: string): boolean {
  const base = (t.baseMintAddress ?? '').trim();
  const quote = (t.quoteMintAddress ?? '').trim();
  const set = new Set([base, quote]);
  return set.has(mintA) && set.has(mintB);
}

export function tradeInvolvesMint(t: VybeTrade, mint: string): boolean {
  const base = (t.baseMintAddress ?? '').trim();
  const quote = (t.quoteMintAddress ?? '').trim();
  return base === mint || quote === mint;
}

/** Trade row matches sell-input → buy-output (base = input mint, quote = output mint). */
export function tradeMatchesSellInputDirection(
  t: VybeTrade,
  inputMint: string,
  outputMint: string,
): boolean {
  const base = toVybeSwapMint(t.baseMintAddress ?? '');
  const quote = toVybeSwapMint(t.quoteMintAddress ?? '');
  const input = toVybeSwapMint(inputMint);
  const output = toVybeSwapMint(outputMint);
  return base === input && quote === output;
}

/** Vybe /v4/trades query: output mint when input is SOL/stable; base+quote when both are. */
export function buildTradesFetchParams(
  inputMint: string,
  outputMint: string,
  limit: number,
): GetTradesParams {
  const input = toVybeSwapMint(inputMint);
  const output = toVybeSwapMint(outputMint);
  const params: GetTradesParams = { limit, sortByDesc: 'blockTime' };
  const inputIsQuote = isIxBuilderQuoteToken(input);
  const outputIsQuote = isIxBuilderQuoteToken(output);

  if (inputIsQuote && outputIsQuote) {
    params.mintAddress = input;
    params.quoteMintAddress = output;
  } else if (inputIsQuote) {
    params.mintAddress = output;
  } else {
    params.mintAddress = input;
  }

  return params;
}

/** Rank distinct (marketAddress, programAddress) pairs from sell-direction trade rows only. */
export function rankAllMarketsFromTrades(
  trades: VybeTrade[],
  inputMint: string,
  outputMint: string,
): TradeMarketCandidate[] {
  const source = trades.filter((t) => tradeMatchesSellInputDirection(t, inputMint, outputMint));

  const byPair = new Map<string, TradeMarketCandidate & { tradeCount: number }>();

  for (const t of source) {
    const marketAddress = (t.marketAddress ?? '').trim();
    const programAddress = (t.programAddress ?? '').trim();
    if (!marketAddress || !programAddress) continue;

    const key = `${marketAddress}\0${programAddress}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.tradeCount++;
      continue;
    }

    byPair.set(key, {
      marketAddress,
      programAddress,
      protocol: programAddressToProtocol(programAddress),
      ixBuilderProtocol: programAddressToIxBuilderProtocol(programAddress),
      tradeCount: 1,
    });
  }

  return [...byPair.values()].sort((a, b) => b.tradeCount - a.tradeCount);
}

/** Apply ix-builder program filter + min trade-count fraction; build display + queue lists. */
export function resolveMarketsForRouteViaTrades(
  ranked: TradeMarketCandidate[],
  options?: { minCountFraction?: number; displayLimit?: number },
): RouteViaTradesMarketResolution {
  const minFraction = options?.minCountFraction ?? ROUTE_VIA_TRADES_MIN_COUNT_FRACTION;
  const displayLimit = options?.displayLimit ?? ROUTE_VIA_TRADES_DISPLAY_MARKETS;

  const maxTradeCount = ranked[0]?.tradeCount ?? 0;
  const minCountThreshold = maxTradeCount > 0 ? maxTradeCount * minFraction : 0;

  const topMarkets: RankedTradeMarket[] = ranked.slice(0, displayLimit).map((c, i) => {
    const supportedProgram = isSupportedIxBuilderProgram(c.programAddress);
    const meetsCount = c.tradeCount >= minCountThreshold;
    return {
      ...c,
      rank: i + 1,
      programLabel: programLabelForAddress(c.programAddress),
      supportedProgram,
      eligible: supportedProgram && meetsCount,
    };
  });

  const queueCandidates = ranked.filter(
    (c) => isSupportedIxBuilderProgram(c.programAddress) && c.tradeCount >= minCountThreshold,
  );

  return { topMarkets, queueCandidates, maxTradeCount, minCountThreshold };
}

/** @deprecated Use rankAllMarketsFromTrades + resolveMarketsForRouteViaTrades */
export function rankMarketsFromTrades(
  trades: VybeTrade[],
  inputMint: string,
  outputMint: string,
): TradeMarketCandidate[] {
  const ranked = rankAllMarketsFromTrades(trades, inputMint, outputMint);
  return resolveMarketsForRouteViaTrades(ranked).queueCandidates;
}

function normalizeProviderId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function isAggregatorSwapProvider(value: unknown): boolean {
  const id = normalizeProviderId(value);
  return id === 'jupiter' || id === 'titan';
}

/** Vybe direct DEX build (meteora-damm2, raydium-*, etc.) — not an aggregator fallback. */
export function isDirectVybeDexProvider(value: unknown): boolean {
  if (isAggregatorSwapProvider(value)) return false;
  const id = normalizeProviderId(value);
  if (!id || id === 'vybe') return true;
  return (
    id.includes('meteora') ||
    id.includes('raydium') ||
    id.includes('pump') ||
    id.includes('sanctum')
  );
}

function hasBuildTx(build: import('../types/swap.js').VybeSwapBuildResponse): boolean {
  const tx = build.tx ?? build.transaction;
  return typeof tx === 'string' && tx.length > 0;
}

export interface QueuedMarketEntry extends TradeMarketCandidate {
  programLabel: string;
  queueIndex: number;
}

export interface RouteViaTradesBuildAttemptLog {
  queueIndex: number;
  marketAddress: string;
  programLabel: string;
  tradeCount: number;
  attempt: string;
  provider?: string;
  success: boolean;
  error?: string;
}

/** Trade-ranked queue — capped at ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS after eligibility filter. */
export function queueFromTradeCandidates(candidates: TradeMarketCandidate[]): QueuedMarketEntry[] {
  return candidates.slice(0, ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS).map((c, i) => ({
    ...c,
    programLabel: programLabelForAddress(c.programAddress),
    queueIndex: i + 1,
  }));
}

function poolAddressFromBuild(build: import('../types/swap.js').VybeSwapBuildResponse): string {
  const top = String(build.poolAddress ?? '').trim();
  if (top) return top;
  const details = build.details as unknown as Record<string, unknown> | undefined;
  const fromDetails = String(details?.poolAddress ?? '').trim();
  if (fromDetails) return fromDetails;
  const quote = details?.quote as Record<string, unknown> | undefined;
  return String(quote?.poolAddress ?? quote?.pool ?? '').trim();
}

type BuildAttempt = Pick<
  import('./swap-build.js').BuildSwapParams,
  'poolAddress' | 'programAddress' | 'protocol'
>;

export { staticAccountKeysFromSwapTx } from './pool-address-validation.js';

export function buildTxIncludesAddresses(
  build: import('../types/swap.js').VybeSwapBuildResponse,
  addresses: { poolAddress?: string; programAddress?: string },
): { ok: boolean; missingPool?: boolean; missingProgram?: boolean } {
  const tx = build.tx ?? build.transaction;
  if (typeof tx !== 'string' || !tx.trim()) return { ok: false };
  const keys = staticAccountKeysFromSwapTx(tx);
  const pool = addresses.poolAddress?.trim();
  const program = addresses.programAddress?.trim();
  if (program && !keys.has(program)) return { ok: false, missingProgram: true };
  if (pool && !keys.has(pool)) return { ok: false, missingPool: true };
  return { ok: true };
}

async function validateTradeBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
  candidate: TradeMarketCandidate,
): Promise<{ ok: boolean; reason: string }> {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const result = await validateTradeRoutedBuildOnChain(connection, build, {
    marketAddress: candidate.marketAddress,
    programAddress: candidate.programAddress,
  });
  return { ok: result.ok, reason: result.reason ?? 'Built tx failed pool/program validation' };
}

function describeTradeBuildRejectReasonFromValidation(reason: string): string {
  return reason;
}

export function acceptTradeRoutedBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
  candidate: TradeMarketCandidate,
  attempt?: BuildAttempt,
): boolean {
  if (!hasBuildTx(build)) return false;

  const programOnly = Boolean(attempt?.programAddress?.trim() && !attempt?.poolAddress?.trim());
  const poolPinned = Boolean(attempt?.poolAddress?.trim());
  const fromTrades = candidate.tradeCount > 0;

  const poolAddress = (attempt?.poolAddress ?? (fromTrades || poolPinned ? candidate.marketAddress : '')).trim();
  const programAddress = (
    attempt?.programAddress ?? (fromTrades || poolPinned || programOnly ? candidate.programAddress : '')
  ).trim();

  if (!poolAddress && !programAddress) return true;

  return buildTxIncludesAddresses(build, {
    poolAddress: poolAddress || undefined,
    programAddress: programAddress || undefined,
  }).ok;
}

function resolveCandidateFromBuild(
  candidate: TradeMarketCandidate,
  build: import('../types/swap.js').VybeSwapBuildResponse,
): TradeMarketCandidate {
  const builtPool = poolAddressFromBuild(build);
  if (builtPool && builtPool !== candidate.marketAddress) {
    return { ...candidate, marketAddress: builtPool };
  }
  return candidate;
}

export interface FetchTopMarketsParams {
  inputMintAddress: string;
  outputMintAddress: string;
  limit?: number;
  topN?: number;
}


/** Single Vybe fetch with ix-builder quote-token mint selection, then filter pair client-side. */
async function fetchTradesForPair(
  http: AxiosInstance,
  inputMint: string,
  outputMint: string,
  limit: number,
): Promise<{ trades: VybeTrade[]; rawCount: number; fetchParams: GetTradesParams }> {
  const fetchParams = buildTradesFetchParams(inputMint, outputMint, limit);
  const res = await getTrades(http, fetchParams);
  const raw = res.data ?? [];
  const trades = raw.filter((t) => tradeMatchesSellInputDirection(t, inputMint, outputMint));
  return { trades, rawCount: raw.length, fetchParams };
}

function resolveFromTrades(
  trades: VybeTrade[],
  inputMint: string,
  outputMint: string,
): RouteViaTradesMarketResolution & { pairTradeCount: number } {
  const pairTradeCount = trades.filter((t) =>
    tradeMatchesSellInputDirection(t, inputMint, outputMint),
  ).length;
  const ranked = rankAllMarketsFromTrades(trades, inputMint, outputMint);
  const resolved = resolveMarketsForRouteViaTrades(ranked);
  return { ...resolved, pairTradeCount };
}

export async function fetchTopMarketsFromTrades(
  http: AxiosInstance,
  params: FetchTopMarketsParams,
): Promise<{
  candidates: TradeMarketCandidate[];
  topMarkets: RankedTradeMarket[];
  maxTradeCount: number;
  minCountThreshold: number;
  tradesFetched: number;
  tradesFetchedForward: number;
  tradesFetchedInverse: number;
  pairTradeCount: number;
}> {
  const inputMint = params.inputMintAddress.trim();
  const outputMint = params.outputMintAddress.trim();
  const limit = params.limit ?? ROUTE_VIA_TRADES_LIMIT;

  const { trades, rawCount } = await fetchTradesForPair(
    http,
    inputMint,
    outputMint,
    limit,
  );
  const resolved = resolveFromTrades(trades, inputMint, outputMint);

  return {
    candidates: resolved.queueCandidates,
    topMarkets: resolved.topMarkets,
    maxTradeCount: resolved.maxTradeCount,
    minCountThreshold: resolved.minCountThreshold,
    tradesFetched: rawCount,
    tradesFetchedForward: rawCount,
    tradesFetchedInverse: 0,
    pairTradeCount: resolved.pairTradeCount,
  };
}

export interface RouteViaTradesQueueMeta {
  topMarkets: RankedTradeMarket[];
  maxTradeCount: number;
  minCountThreshold: number;
  tried: TradeMarketCandidate[];
  tradesFetched: number;
  tradesFetchLimit: number;
  tradesFetchOk: boolean;
  /** Raw rows returned by Vybe for mintAddress=sell mint (before pair filter). */
  tradesFetchedForward: number;
  /** Unused — kept for response compatibility. */
  tradesFetchedInverse: number;
  pairTradeCount: number;
  tradeMarketsEligible: number;
  queued: QueuedMarketEntry[];
  buildLog: RouteViaTradesBuildAttemptLog[];
  timingsMs?: {
    fetchTrades?: number;
    parallelProbe?: number;
    sequentialBuild?: number;
    total?: number;
  };
}

export interface RouteViaTradesBuildResult extends RouteViaTradesQueueMeta {
  build: import('../types/swap.js').VybeSwapBuildResponse;
  selected: TradeMarketCandidate;
}

export interface RouteViaTradesExhaustedResult extends RouteViaTradesQueueMeta {
  kind: 'exhausted';
  lastError: string;
}

export type BuildSwapViaTradeMarketsResult =
  | ({ kind: 'direct' } & RouteViaTradesBuildResult)
  | RouteViaTradesExhaustedResult;

function describeBuildAttempt(attempt: BuildAttempt): string {
  const pool = Boolean(attempt.poolAddress?.trim());
  const program = Boolean(attempt.programAddress?.trim());
  if (pool && program) return 'pool+program';
  if (program) return 'program only';
  if (pool) return 'pool only';
  return 'default';
}

function buildAttemptsForCandidate(candidate: TradeMarketCandidate): BuildAttempt[] {
  const poolAddress = candidate.marketAddress;
  const programAddress = candidate.programAddress?.trim();
  if (poolAddress && programAddress) {
    return [
      {
        poolAddress,
        programAddress,
        protocol: candidate.protocol ?? programAddressToProtocol(programAddress),
      },
    ];
  }
  return [];
}

function buildSwapBodyForTradeAttempt(
  body: import('./swap-build.js').BuildSwapParams,
  attempt: BuildAttempt,
): import('./swap-build.js').BuildSwapParams {
  const { protocol: _omitProtocol, poolAddress: _omitPool, programAddress: _omitProgram, ...rest } =
    body;
  return completePinnedSwapParams({
    ...rest,
    router: 'vybe',
    poolAddress: attempt.poolAddress,
    programAddress: attempt.programAddress,
    protocol: attempt.protocol,
  });
}

function quickProbeAttemptForQueueEntry(queueEntry: QueuedMarketEntry): BuildAttempt | null {
  const attempts = buildAttemptsForCandidate(queueEntry);
  return attempts[0] ?? null;
}

type BuildProbeResult =
  | {
      ok: true;
      build: import('../types/swap.js').VybeSwapBuildResponse;
      selected: TradeMarketCandidate;
      buildLog: RouteViaTradesBuildAttemptLog[];
      queueEntry: QueuedMarketEntry;
    }
  | {
      ok: false;
      lastError: string;
      buildLog: RouteViaTradesBuildAttemptLog[];
      queueEntry: QueuedMarketEntry;
    };

async function trySingleBuildAttempt(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  queueEntry: QueuedMarketEntry,
  attempt: BuildAttempt,
  buildSwap: typeof import('./swap-build.js').buildSwap,
): Promise<BuildProbeResult> {
  const candidate = queueEntry;
  const baseLog: Omit<RouteViaTradesBuildAttemptLog, 'attempt' | 'success' | 'provider' | 'error'> = {
    queueIndex: queueEntry.queueIndex,
    marketAddress: queueEntry.marketAddress,
    programLabel: queueEntry.programLabel,
    tradeCount: queueEntry.tradeCount,
  };
  const attemptLabel = describeBuildAttempt(attempt);
  try {
    const build = await buildSwap(http, buildSwapBodyForTradeAttempt(body, attempt));
    const provider = String(build.provider ?? build.details?.quote?.provider ?? '').trim();
    const validation = await validateTradeBuild(build, candidate);
    if (!validation.ok) {
      const lastError = describeTradeBuildRejectReasonFromValidation(validation.reason);
      return {
        ok: false,
        lastError,
        queueEntry,
        buildLog: [
          {
            ...baseLog,
            attempt: attemptLabel,
            provider: provider || undefined,
            success: false,
            error: lastError,
          },
        ],
      };
    }
    return {
      ok: true,
      build,
      selected: resolveCandidateFromBuild(candidate, build),
      queueEntry,
      buildLog: [
        {
          ...baseLog,
          attempt: attemptLabel,
          provider: provider || undefined,
          success: true,
        },
      ],
    };
  } catch (err) {
    const lastError =
      err instanceof Error ? err.message : err != null ? String(err) : 'unknown error';
    return {
      ok: false,
      lastError,
      queueEntry,
      buildLog: [
        {
          ...baseLog,
          attempt: attemptLabel,
          success: false,
          error: lastError,
        },
      ],
    };
  }
}

function pickBestParallelProbe(results: BuildProbeResult[]): Extract<BuildProbeResult, { ok: true }> | undefined {
  const winners = results.filter((r): r is Extract<BuildProbeResult, { ok: true }> => r.ok);
  if (winners.length === 0) return undefined;
  return winners.sort((a, b) => b.queueEntry.tradeCount - a.queueEntry.tradeCount)[0];
}

async function tryDirectBuildForCandidate(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  queueEntry: QueuedMarketEntry,
  buildSwap: typeof import('./swap-build.js').buildSwap,
  options?: { skipFirstAttempt?: boolean },
): Promise<
  | {
      ok: true;
      build: import('../types/swap.js').VybeSwapBuildResponse;
      selected: TradeMarketCandidate;
      buildLog: RouteViaTradesBuildAttemptLog[];
    }
  | { ok: false; lastError: string; buildLog: RouteViaTradesBuildAttemptLog[] }
> {
  const candidate = queueEntry;
  const buildLog: RouteViaTradesBuildAttemptLog[] = [];
  let lastError = 'unknown error';
  let attempts = buildAttemptsForCandidate(candidate);
  if (options?.skipFirstAttempt && attempts.length > 0) {
    attempts = attempts.slice(1);
  }
  for (const attempt of attempts) {
    const baseLog: Omit<RouteViaTradesBuildAttemptLog, 'attempt' | 'success' | 'provider' | 'error'> = {
      queueIndex: queueEntry.queueIndex,
      marketAddress: queueEntry.marketAddress,
      programLabel: queueEntry.programLabel,
      tradeCount: queueEntry.tradeCount,
    };
    const attemptLabel = describeBuildAttempt(attempt);
    try {
      const build = await buildSwap(http, buildSwapBodyForTradeAttempt(body, attempt));
      const provider = String(build.provider ?? build.details?.quote?.provider ?? '').trim();
      const validation = await validateTradeBuild(build, candidate);
      if (!validation.ok) {
        lastError = describeTradeBuildRejectReasonFromValidation(validation.reason);
        buildLog.push({
          ...baseLog,
          attempt: attemptLabel,
          provider: provider || undefined,
          success: false,
          error: lastError,
        });
        continue;
      }
      buildLog.push({
        ...baseLog,
        attempt: attemptLabel,
        provider: provider || undefined,
        success: true,
      });
      return { ok: true, build, selected: resolveCandidateFromBuild(candidate, build), buildLog };
    } catch (err) {
      lastError =
        err instanceof Error ? err.message : err != null ? String(err) : 'unknown error';
      buildLog.push({
        ...baseLog,
        attempt: attemptLabel,
        success: false,
        error: lastError,
      });
    }
  }
  return { ok: false, lastError, buildLog };
}

/** Build as if (marketAddress, programAddress) were the #1 row from trades — pool+program only, no trades fetch. */
export async function buildSwapForTradeCandidate(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  candidate: { marketAddress: string; programAddress: string; tradeCount?: number },
): Promise<BuildSwapViaTradeMarketsResult> {
  const { buildSwap } = await import('./swap-build.js');
  const marketAddress = candidate.marketAddress.trim();
  const programAddress = candidate.programAddress.trim();
  const tradeCount = candidate.tradeCount ?? 1;
  const totalStart = Date.now();

  const entry: QueuedMarketEntry = {
    marketAddress,
    programAddress,
    protocol: programAddressToProtocol(programAddress),
    ixBuilderProtocol: programAddressToIxBuilderProtocol(programAddress),
    tradeCount,
    programLabel: programLabelForAddress(programAddress),
    queueIndex: 1,
  };
  const topMarkets: RankedTradeMarket[] = [
    {
      ...entry,
      rank: 1,
      supportedProgram: isSupportedIxBuilderProgram(programAddress),
      eligible: true,
    },
  ];
  const buildLog: RouteViaTradesBuildAttemptLog[] = [];
  const timingsMs: NonNullable<RouteViaTradesQueueMeta['timingsMs']> = {
    fetchTrades: 0,
    total: 0,
  };

  const queueMeta = {
    topMarkets,
    maxTradeCount: tradeCount,
    minCountThreshold: tradeCount,
    tradesFetched: 0,
    tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
    tradesFetchOk: false,
    tradesFetchedForward: 0,
    tradesFetchedInverse: 0,
    pairTradeCount: 0,
    tradeMarketsEligible: 1,
    queued: [entry],
    buildLog,
    timingsMs,
  };

  const attempt = buildAttemptsForCandidate(entry)[0];
  if (!attempt) {
    timingsMs.total = Date.now() - totalStart;
    return {
      kind: 'exhausted',
      ...queueMeta,
      tried: [entry],
      lastError: 'Route via Trades: missing pool or program address.',
    };
  }

  const probeStart = Date.now();
  const result = await trySingleBuildAttempt(http, body, entry, attempt, buildSwap);
  timingsMs.parallelProbe = Date.now() - probeStart;
  buildLog.push(...result.buildLog);
  timingsMs.total = Date.now() - totalStart;

  if (result.ok) {
    return {
      kind: 'direct',
      build: result.build,
      selected: result.selected,
      tried: [entry],
      ...queueMeta,
      buildLog,
    };
  }

  return {
    kind: 'exhausted',
    tried: [entry],
    lastError: result.lastError,
    ...queueMeta,
    buildLog,
  };
}

export async function buildSwapViaTradeMarkets(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
): Promise<BuildSwapViaTradeMarketsResult> {
  const { buildSwap } = await import('./swap-build.js');
  const inputMint = body.inputMintAddress.trim();
  const outputMint = body.outputMintAddress.trim();
  const totalStart = Date.now();
  const timingsMs: NonNullable<RouteViaTradesQueueMeta['timingsMs']> = {};

  const tradesStart = Date.now();
  const tradeData = await fetchTopMarketsFromTrades(http, {
    inputMintAddress: inputMint,
    outputMintAddress: outputMint,
  });
  timingsMs.fetchTrades = Date.now() - tradesStart;

  const queued = queueFromTradeCandidates(tradeData.candidates);
  const tried: TradeMarketCandidate[] = [];
  const buildLog: RouteViaTradesBuildAttemptLog[] = [];
  let lastError = 'unknown error';

  const queueMeta = {
    topMarkets: tradeData.topMarkets,
    maxTradeCount: tradeData.maxTradeCount,
    minCountThreshold: tradeData.minCountThreshold,
    tradesFetched: tradeData.tradesFetched,
    tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
    tradesFetchOk: tradeData.tradesFetched > 0,
    tradesFetchedForward: tradeData.tradesFetchedForward,
    tradesFetchedInverse: tradeData.tradesFetchedInverse,
    pairTradeCount: tradeData.pairTradeCount,
    tradeMarketsEligible: tradeData.candidates.length,
    queued,
    buildLog,
    timingsMs,
  };

  if (queued.length === 0) {
    timingsMs.total = Date.now() - totalStart;
    return {
      kind: 'exhausted',
      ...queueMeta,
      tried: [],
      lastError:
        'Route via Trades: no eligible markets (ix-builder supported program + ≥5% of top pool trade count).',
    };
  }

  const probeStart = Date.now();
  const probeResults = await Promise.all(
    queued
      .map((queueEntry) => {
        const attempt = quickProbeAttemptForQueueEntry(queueEntry);
        return attempt ? trySingleBuildAttempt(http, body, queueEntry, attempt, buildSwap) : null;
      })
      .filter((job): job is Promise<BuildProbeResult> => job != null),
  );
  timingsMs.parallelProbe = Date.now() - probeStart;

  for (const result of probeResults) {
    buildLog.push(...result.buildLog);
    tried.push(result.queueEntry);
    if (!result.ok) lastError = result.lastError;
  }

  const probeWinner = pickBestParallelProbe(probeResults);
  if (probeWinner) {
    timingsMs.total = Date.now() - totalStart;
    return {
      kind: 'direct',
      build: probeWinner.build,
      selected: probeWinner.selected,
      tried,
      ...queueMeta,
      buildLog,
    };
  }

  const sequentialStart = Date.now();
  for (const queueEntry of queued) {
    const result = await tryDirectBuildForCandidate(http, body, queueEntry, buildSwap, {
      skipFirstAttempt: true,
    });
    buildLog.push(...result.buildLog);
    if (result.ok) {
      timingsMs.sequentialBuild = Date.now() - sequentialStart;
      timingsMs.total = Date.now() - totalStart;
      return {
        kind: 'direct',
        build: result.build,
        selected: result.selected,
        tried,
        ...queueMeta,
        buildLog,
      };
    }
    lastError = result.lastError;
  }
  timingsMs.sequentialBuild = Date.now() - sequentialStart;
  timingsMs.total = Date.now() - totalStart;

  return {
    kind: 'exhausted',
    tried,
    lastError,
    ...queueMeta,
    buildLog,
  };
}

/** Human-readable server log for Route via Trades diagnostics. */
export function formatRouteViaTradesServerLog(
  meta: Pick<
    RouteViaTradesQueueMeta,
    | 'tradesFetched'
    | 'tradesFetchLimit'
    | 'tradesFetchOk'
    | 'tradesFetchedForward'
    | 'tradesFetchedInverse'
    | 'pairTradeCount'
    | 'queued'
    | 'buildLog'
    | 'maxTradeCount'
    | 'minCountThreshold'
    | 'tradeMarketsEligible'
  > & {
    enabled?: boolean;
    disabledReason?: string;
    outcome?: string;
    selected?: TradeMarketCandidate;
    recoveryLog?: Array<{ step: string; success: boolean; provider?: string; error?: string }>;
    fallbackRouter?: string;
  },
): string[] {
  const lines: string[] = [];
  if (meta.enabled === false) {
    lines.push(`Route via Trades: disabled (${meta.disabledReason ?? 'unknown'})`);
    return lines;
  }
  lines.push(
    `Trades fetch: ${meta.tradesFetched} rows (limit ${meta.tradesFetchLimit}) — ${meta.pairTradeCount} matched sell→buy pair for ranking`,
  );
  lines.push(
    `Markets: max ${meta.maxTradeCount} trades — queue ≥${Math.round(meta.minCountThreshold)} (${meta.tradeMarketsEligible} eligible, ${meta.queued.length} queued)`,
  );
  for (const q of meta.queued) {
    lines.push(`  #${q.queueIndex} ${q.programLabel} ${q.marketAddress} (${q.tradeCount} trades)`);
  }
  for (const entry of meta.buildLog) {
    const status = entry.success ? 'OK' : 'FAIL';
    const provider = entry.provider ? ` provider=${entry.provider}` : '';
    const err = entry.error ? ` — ${entry.error}` : '';
    lines.push(
      `  build #${entry.queueIndex} ${entry.attempt}${provider} [${status}]${err}`,
    );
  }
  if (meta.selected) {
    lines.push(
      `Selected: ${meta.selected.marketAddress} (${programLabelForAddress(meta.selected.programAddress)})`,
    );
  }
  for (const step of meta.recoveryLog ?? []) {
    const provider = step.provider ? ` provider=${step.provider}` : '';
    const err = step.error ? ` — ${step.error}` : '';
    lines.push(`  recovery ${step.step} [${step.success ? 'OK' : 'FAIL'}]${provider}${err}`);
  }
  if (meta.fallbackRouter) {
    lines.push(`Outcome: fallback router ${meta.fallbackRouter}`);
  } else if (meta.outcome) {
    lines.push(`Outcome: ${meta.outcome}`);
  }
  return lines;
}

export async function fetchRankedTopMarketsFromTrades(
  http: AxiosInstance,
  params: FetchTopMarketsParams,
): Promise<{
  topMarkets: RankedTradeMarket[];
  queueCandidates: TradeMarketCandidate[];
  maxTradeCount: number;
  minCountThreshold: number;
  tradesFetched: number;
  tradesFetchedForward: number;
  tradesFetchedInverse: number;
  pairTradeCount: number;
}> {
  const inputMint = params.inputMintAddress.trim();
  const outputMint = params.outputMintAddress.trim();
  const limit = params.limit ?? ROUTE_VIA_TRADES_LIMIT;

  const { trades, rawCount } = await fetchTradesForPair(
    http,
    inputMint,
    outputMint,
    limit,
  );
  const resolved = resolveFromTrades(trades, inputMint, outputMint);

  return {
    topMarkets: resolved.topMarkets,
    queueCandidates: resolved.queueCandidates,
    maxTradeCount: resolved.maxTradeCount,
    minCountThreshold: resolved.minCountThreshold,
    tradesFetched: rawCount,
    tradesFetchedForward: rawCount,
    tradesFetchedInverse: 0,
    pairTradeCount: resolved.pairTradeCount,
  };
}
