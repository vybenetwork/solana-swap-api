/**
 * Route via Trades: rank recent trade markets for a mint pair and map program → Vybe protocol.
 * Supported programs mirror ix-builder-api (Vybe swap router direct integrations).
 */

import type { AxiosInstance } from 'axios';
import { isLocalVybeApi } from '../config.js';
import { createSolanaConnection } from './solana-connection.js';
import {
  fetchRouteTradesViaIxBuilder,
  fetchRouteMarketsViaIxBuilder,
  fetchScanPoolsViaIxBuilder,
  type ScannedPoolCandidate,
  type IxBuilderRouteMarketRow,
} from './ix-builder-route-trades.js';
import { normalizeMarketFetchMode, type MarketFetchMode } from './swap-build.js';
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
import { simulateSwapEffects } from './simulate-swap-output.js';
import { toVybeSwapMint } from './sol-mints.js';
import { getTrades, isVybeApiNotFoundError, type GetTradesParams } from './trades.js';

export const ROUTE_VIA_TRADES_LIMIT = 1000;
export const ROUTE_VIA_TRADES_DISPLAY_MARKETS = 15;
/** Keep pools with tradeCount >= this fraction × busiest pool (e.g. 0.05 → ≥5%). */
export const ROUTE_VIA_TRADES_MIN_COUNT_FRACTION = 0.05;
/** Max pinned build attempts from the eligible trade-ranked queue. */
export const ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS = 6;
export const ROUTE_ENUMERATE_LIQUIDITY_SLOTS = 5;
/** Max sim-valid routes returned to the client after quote ranking. */
export const ROUTE_ENUMERATE_MAX_ROUTES = 3;
/** Discovery + quote-probe pool; sim failures backfill from lower ranks until MAX_ROUTES pass. */
export const ROUTE_ENUMERATE_CANDIDATE_POOL = 10;
/** @deprecated Use ROUTE_ENUMERATE_LIQUIDITY_SLOTS */
export const ROUTE_ENUMERATE_TRADE_SLOTS = 5;
/** @deprecated Merged into liquidity-first candidate pool */
export const ROUTE_ENUMERATE_MARKETS_SLOTS = 5;
/** @deprecated RPC enriches candidates only; no dedicated slots */
export const ROUTE_ENUMERATE_RPC_ONLY_SLOTS = 5;
export const ROUTE_OPTIONS_UI_INITIAL = 3;
/** Skip RPC scan in full mode when trades, markets, or combined unique count reaches this. */
export const ROUTE_DISCOVERY_RPC_SKIP_MIN = 3;

export const TRADES_API_UNAVAILABLE_MESSAGE =
  'Vybe GET /v4/trades unavailable (404). Falling back to Jupiter.';
/** @deprecated Use ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS */
export const ROUTE_VIA_TRADES_TOP_MARKETS = ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS;

export interface TradeMarketCandidate {
  marketAddress: string;
  programAddress: string;
  protocol?: SwapProxyProtocol;
  ixBuilderProtocol?: string;
  tradeCount: number;
  /** Human-readable DEX name (Raydium AMM v4, Meteora DLMM, …). */
  programLabel?: string;
  /** Liquidity score from PG markets snapshot (markets discovery only). */
  marketScore?: number;
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

export type RouteCandidateSource =
  | 'trades'
  | 'markets'
  | 'rpc'
  | 'trades+rpc'
  | 'markets+rpc'
  /** @deprecated Use trades+rpc or markets+rpc */
  | 'both';

export interface RouteRpcMeta {
  liquidity?: string;
  preSwapNeeded?: boolean;
}

export interface EnumeratedRouteCandidate extends QueuedMarketEntry {
  source: RouteCandidateSource;
  rpcMeta?: RouteRpcMeta;
}

export interface RouteBuildSuccess {
  candidate: EnumeratedRouteCandidate;
  build: import('../types/swap.js').VybeSwapBuildResponse;
  selected: TradeMarketCandidate;
  /** Populated during enumerate validate — reused for route card quotes (no second sim). */
  simulation?: import('./simulate-swap-output.js').SwapSimulationResult;
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

/** Trade-ranked queue — capped after eligibility filter (build attempts / legacy queue). */
export function queueFromTradeCandidates(candidates: TradeMarketCandidate[]): QueuedMarketEntry[] {
  return toQueuedMarketEntries(candidates, ROUTE_VIA_TRADES_MAX_QUEUE_ATTEMPTS);
}

/** Discovery merge input — keep enough liquidity + trade rows for top-6 selection. */
export function toQueuedMarketEntries(
  candidates: TradeMarketCandidate[],
  limit = ROUTE_ENUMERATE_CANDIDATE_POOL + 44,
): QueuedMarketEntry[] {
  return candidates.slice(0, limit).map((c, i) => ({
    ...c,
    programLabel: c.programLabel ?? programLabelForAddress(c.programAddress),
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
  swapParams: Pick<
    import('./swap-build.js').BuildSwapParams,
    'accountAddress' | 'inputMintAddress' | 'outputMintAddress'
  >,
): Promise<{ ok: boolean; reason: string; simulation?: import('./simulate-swap-output.js').SwapSimulationResult }> {
  const connection = createSolanaConnection('validateTradeBuild');
  console.info(
    `[solana-rpc] validateTradeBuild pool=${candidate.marketAddress.slice(0, 8)}… ` +
      `program=${candidate.programAddress.slice(0, 8)}…`,
  );
  const result = await validateTradeRoutedBuildOnChain(connection, build, {
    marketAddress: candidate.marketAddress,
    programAddress: candidate.programAddress,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? 'Built tx failed pool/program validation' };
  }

  const tx = build.tx ?? build.transaction;
  if (typeof tx !== 'string' || !tx.trim()) {
    return { ok: false, reason: 'Built tx missing' };
  }

  const sim = await simulateSwapEffects(
    tx,
    swapParams.accountAddress.trim(),
    swapParams.outputMintAddress.trim(),
    swapParams.inputMintAddress.trim(),
    undefined,
    { pinnedPoolAddress: candidate.marketAddress },
  );
  if (sim.simulationErr) {
    return {
      ok: false,
      reason: `Swap simulation failed: ${JSON.stringify(sim.simulationErr)}`,
    };
  }
  if (!sim.outputDeltaRaw || sim.outputDeltaRaw === '0') {
    return { ok: false, reason: 'Swap simulation returned zero output' };
  }

  return { ok: true, reason: '', simulation: sim };
}

export function normalizeBuildErrorMessage(message: string, fallback: string): string {
  const trimmed = message.trim();
  return trimmed || fallback;
}

function describeTradeBuildRejectReasonFromValidation(reason: string): string {
  return normalizeBuildErrorMessage(reason, 'Built tx failed validation');
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


export interface TradesFetchResult {
  trades: VybeTrade[];
  rawCount: number;
  fetchParams: GetTradesParams;
  /** Set when GET /v4/trades returns 404 — caller should fall back to Jupiter. */
  tradesUnavailable?: boolean;
  tradesSource?: 'clickhouse' | 'vybe_api' | 'vybe_remote';
}

/** Single Vybe fetch with ix-builder quote-token mint selection, then filter pair client-side. */
async function fetchTradesForPair(
  http: AxiosInstance,
  inputMint: string,
  outputMint: string,
  limit: number,
): Promise<TradesFetchResult> {
  const fetchParams = buildTradesFetchParams(inputMint, outputMint, limit);

  if (isLocalVybeApi()) {
    try {
      const res = await fetchRouteTradesViaIxBuilder(inputMint, outputMint, limit);
      const raw = res.data ?? [];
      const trades = raw.filter((t) => tradeMatchesSellInputDirection(t, inputMint, outputMint));
      return {
        trades,
        rawCount: res.rawCount,
        fetchParams,
        tradesUnavailable: false,
        tradesSource: res.source,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route-via-trades] ix-builder /route-trades failed, falling back to Vybe API: ${msg}`);
    }
  }

  try {
    const res = await getTrades(http, fetchParams);
    const raw = res.data ?? [];
    const trades = raw.filter((t) => tradeMatchesSellInputDirection(t, inputMint, outputMint));
    return {
      trades,
      rawCount: raw.length,
      fetchParams,
      tradesUnavailable: false,
      tradesSource: 'vybe_remote',
    };
  } catch (err) {
    if (isVybeApiNotFoundError(err)) {
      console.warn(`[route-via-trades] ${TRADES_API_UNAVAILABLE_MESSAGE}`);
      return { trades: [], rawCount: 0, fetchParams, tradesUnavailable: true };
    }
    throw err;
  }
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
  tradesUnavailable?: boolean;
  tradesSource?: TradesFetchResult['tradesSource'];
}> {
  const inputMint = params.inputMintAddress.trim();
  const outputMint = params.outputMintAddress.trim();
  const limit = params.limit ?? ROUTE_VIA_TRADES_LIMIT;

  const { trades, rawCount, tradesUnavailable, tradesSource } = await fetchTradesForPair(
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
    tradesUnavailable: tradesUnavailable === true,
    tradesSource,
  };
}

export async function fetchTopMarketsFromMarketsSnapshot(
  inputMint: string,
  outputMint: string,
  limit = 50,
): Promise<{
  candidates: TradeMarketCandidate[];
  marketsFetched: number;
  marketsSource?: 'clickhouse_markets' | 'vybe_api';
}> {
  if (!isLocalVybeApi()) {
    return { candidates: [], marketsFetched: 0 };
  }
  const res = await fetchRouteMarketsViaIxBuilder(inputMint, outputMint, limit);
  const candidates: TradeMarketCandidate[] = [];
  for (const row of res.data ?? []) {
    const marketAddress = row.marketAddress?.trim();
    const programAddress = row.programAddress?.trim();
    if (!marketAddress || !programAddress) continue;
    if (!isSupportedIxBuilderProgram(programAddress)) continue;
    const score = Number(row.rankScore ?? row.totalValueUsd ?? 0);
    candidates.push({
      marketAddress,
      programAddress,
      protocol: programAddressToProtocol(programAddress),
      ixBuilderProtocol: programAddressToIxBuilderProtocol(programAddress),
      programLabel: programLabelForAddress(programAddress),
      tradeCount: 0,
      marketScore: score,
    });
  }
  candidates.sort((a, b) => (b.marketScore ?? 0) - (a.marketScore ?? 0));
  return {
    candidates,
    marketsFetched: candidates.length,
    marketsSource: res.source,
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
  /** GET /v4/trades returned 404 — queue empty, use Jupiter fallback. */
  tradesUnavailable?: boolean;
  tradesSource?: TradesFetchResult['tradesSource'];
  /** PG snapshot rows from GET /route-markets (0 when skipped or failed). */
  marketsSnapshotFetched?: number;
  marketsSnapshotEligible?: number;
  marketsSnapshotSource?: 'clickhouse_markets' | 'vybe_api';
  rpcPoolsScanned?: number;
  timingsMs?: {
    fetchTrades?: number;
    /** Time spent building + simulating queue candidates one at a time. */
    sequentialProbe?: number;
    /** @deprecated Use sequentialProbe */
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

export interface RouteViaTradesMultiResult extends RouteViaTradesQueueMeta {
  kind: 'multi';
  routes: RouteBuildSuccess[];
  build: import('../types/swap.js').VybeSwapBuildResponse;
  selected: TradeMarketCandidate;
}

export type BuildSwapViaTradeMarketsResult =
  | ({ kind: 'direct' } & RouteViaTradesBuildResult)
  | RouteViaTradesMultiResult
  | RouteViaTradesExhaustedResult;

function candidatePairKey(marketAddress: string, programAddress: string): string {
  return `${marketAddress.trim()}\0${programAddress.trim()}`;
}

export function mergeDiscoveryCandidates(
  tradeQueued: QueuedMarketEntry[],
  marketQueued: QueuedMarketEntry[],
  rpcPools: ScannedPoolCandidate[],
): EnumeratedRouteCandidate[] {
  const tradeByKey = new Map<string, QueuedMarketEntry>();
  for (const entry of tradeQueued) {
    if (!isSupportedIxBuilderProgram(entry.programAddress)) continue;
    tradeByKey.set(candidatePairKey(entry.marketAddress, entry.programAddress), entry);
  }

  const rpcByKey = new Map<string, ScannedPoolCandidate>();
  for (const pool of rpcPools) {
    const market = pool.marketAddress?.trim();
    const program = pool.programAddress?.trim();
    if (!market || !program) continue;
    rpcByKey.set(candidatePairKey(market, program), pool);
  }

  const toCandidate = (
    entry: QueuedMarketEntry,
    baseSource: RouteCandidateSource,
    queueIndex: number,
  ): EnumeratedRouteCandidate => {
    const key = candidatePairKey(entry.marketAddress, entry.programAddress);
    const tradeEntry = tradeByKey.get(key);
    const rpc = rpcByKey.get(key);
    let source: RouteCandidateSource = baseSource;
    if (rpc) {
      source =
        baseSource === 'markets' ? 'markets+rpc' : baseSource === 'trades' ? 'trades+rpc' : baseSource;
    }
    return {
      ...entry,
      tradeCount: tradeEntry?.tradeCount ?? entry.tradeCount ?? 0,
      marketScore: entry.marketScore ?? tradeEntry?.marketScore,
      programLabel: entry.programLabel ?? programLabelForAddress(entry.programAddress),
      queueIndex,
      source,
      rpcMeta: rpc
        ? { liquidity: rpc.liquidity, preSwapNeeded: rpc.preSwapNeeded }
        : undefined,
    };
  };

  const marketSlots = marketQueued.filter((e) => isSupportedIxBuilderProgram(e.programAddress));
  const tradeSlots = tradeQueued.filter((e) => isSupportedIxBuilderProgram(e.programAddress));

  const top5Liq = marketSlots.slice(0, ROUTE_ENUMERATE_LIQUIDITY_SLOTS);
  const topMarketLiqPool = marketSlots.slice(0, ROUTE_ENUMERATE_CANDIDATE_POOL);
  const top5Keys = new Set(
    top5Liq.map((e) => candidatePairKey(e.marketAddress, e.programAddress)),
  );

  const tradeInTop5 = tradeSlots.some((e) =>
    top5Keys.has(candidatePairKey(e.marketAddress, e.programAddress)),
  );

  const ordered: QueuedMarketEntry[] = [];
  const seen = new Set<string>();
  const pushUnique = (entry: QueuedMarketEntry) => {
    const key = candidatePairKey(entry.marketAddress, entry.programAddress);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(entry);
  };

  if (marketSlots.length > 0) {
    if (tradeInTop5) {
      for (const entry of topMarketLiqPool) pushUnique(entry);
    } else {
      for (const entry of top5Liq) pushUnique(entry);
      const topTrade = tradeSlots[0];
      if (topTrade) {
        const tradeKey = candidatePairKey(topTrade.marketAddress, topTrade.programAddress);
        if (!top5Keys.has(tradeKey)) {
          pushUnique(topTrade);
        } else if (topMarketLiqPool[ROUTE_ENUMERATE_LIQUIDITY_SLOTS]) {
          pushUnique(topMarketLiqPool[ROUTE_ENUMERATE_LIQUIDITY_SLOTS]!);
        }
      } else if (topMarketLiqPool[ROUTE_ENUMERATE_LIQUIDITY_SLOTS]) {
        pushUnique(topMarketLiqPool[ROUTE_ENUMERATE_LIQUIDITY_SLOTS]!);
      }
    }
  } else if (tradeSlots.length > 0) {
    for (const entry of tradeSlots.slice(0, ROUTE_ENUMERATE_CANDIDATE_POOL)) pushUnique(entry);
  }

  if (ordered.length === 0) {
    for (const pool of rpcPools) {
      if (ordered.length >= ROUTE_ENUMERATE_CANDIDATE_POOL) break;
      const market = pool.marketAddress?.trim();
      const program = pool.programAddress?.trim();
      if (!market || !program || !isSupportedIxBuilderProgram(program)) continue;
      pushUnique({
        marketAddress: market,
        programAddress: program,
        protocol: programAddressToProtocol(program),
        ixBuilderProtocol: programAddressToIxBuilderProtocol(program),
        tradeCount: 0,
        programLabel: programLabelForAddress(program),
        queueIndex: ordered.length + 1,
      });
    }
  }

  return ordered.slice(0, ROUTE_ENUMERATE_CANDIDATE_POOL).map((entry, i) => {
    const key = candidatePairKey(entry.marketAddress, entry.programAddress);
    const fromMarkets = marketSlots.some(
      (m) => candidatePairKey(m.marketAddress, m.programAddress) === key,
    );
    const baseSource: RouteCandidateSource = fromMarkets ? 'markets' : 'trades';
    return toCandidate(entry, baseSource, i + 1);
  });
}

/** @deprecated Use mergeDiscoveryCandidates */
export function mergeTradeAndRpcCandidates(
  tradeQueued: QueuedMarketEntry[],
  rpcPools: ScannedPoolCandidate[],
): EnumeratedRouteCandidate[] {
  return mergeDiscoveryCandidates(tradeQueued, [], rpcPools);
}

const EMPTY_TRADE_DISCOVERY = {
  candidates: [] as TradeMarketCandidate[],
  topMarkets: [] as RankedTradeMarket[],
  maxTradeCount: 0,
  minCountThreshold: 0,
  tradesFetched: 0,
  tradesFetchedForward: 0,
  tradesFetchedInverse: 0,
  pairTradeCount: 0,
  tradesUnavailable: undefined as boolean | undefined,
  tradesSource: undefined as TradesFetchResult['tradesSource'],
};

function countUniqueDiscoveryPairs(
  tradeCandidates: TradeMarketCandidate[],
  marketCandidates: TradeMarketCandidate[],
): number {
  const seen = new Set<string>();
  for (const c of tradeCandidates) {
    seen.add(candidatePairKey(c.marketAddress, c.programAddress));
  }
  for (const c of marketCandidates) {
    seen.add(candidatePairKey(c.marketAddress, c.programAddress));
  }
  return seen.size;
}

export async function discoverRouteCandidates(
  http: AxiosInstance,
  inputMint: string,
  outputMint: string,
  marketFetchMode: MarketFetchMode,
): Promise<{
  tradeData: Awaited<ReturnType<typeof fetchTopMarketsFromTrades>> | typeof EMPTY_TRADE_DISCOVERY;
  marketCandidates: TradeMarketCandidate[];
  marketsSnapshotFetched: number;
  marketsSnapshotSource?: 'clickhouse_markets' | 'vybe_api';
  rpcPools: ScannedPoolCandidate[];
  candidates: EnumeratedRouteCandidate[];
}> {
  const includeTrades = marketFetchMode === 'full' || marketFetchMode === 'trades';
  const includeMarkets =
    (marketFetchMode === 'full' || marketFetchMode === 'markets') && isLocalVybeApi();
  const includeRpc =
    (marketFetchMode === 'full' || marketFetchMode === 'rpc') && isLocalVybeApi();

  console.info(
    `[route-discovery] start mode=${marketFetchMode} steps=` +
      `[${includeTrades ? 'trades' : ''}${includeTrades && includeMarkets ? '+' : ''}` +
      `${includeMarkets ? 'markets' : ''}${(includeTrades || includeMarkets) && includeRpc ? '→' : ''}` +
      `${includeRpc ? 'rpc' : ''}] local=${isLocalVybeApi()}`,
  );

  let tradeData: Awaited<ReturnType<typeof fetchTopMarketsFromTrades>> | typeof EMPTY_TRADE_DISCOVERY =
    { ...EMPTY_TRADE_DISCOVERY };
  let marketCandidates: TradeMarketCandidate[] = [];
  let marketsSnapshotFetched = 0;
  let marketsSnapshotSource: 'clickhouse_markets' | 'vybe_api' | undefined;
  let rpcPools: ScannedPoolCandidate[] = [];

  const tradesPromise = includeTrades
    ? fetchTopMarketsFromTrades(http, {
        inputMintAddress: inputMint,
        outputMintAddress: outputMint,
      })
    : Promise.resolve({ ...EMPTY_TRADE_DISCOVERY });

  const marketsPromise = includeMarkets
    ? fetchTopMarketsFromMarketsSnapshot(inputMint, outputMint).catch((err) => {
        console.warn(
          `[route-via-trades] route-markets failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (marketFetchMode === 'markets') throw err;
        return null;
      })
    : Promise.resolve(null);

  const [tradesResult, marketsResult] = await Promise.all([tradesPromise, marketsPromise]);

  if (includeTrades) {
    tradeData = tradesResult;
  }

  if (marketsResult) {
    marketCandidates = marketsResult.candidates;
    marketsSnapshotFetched = marketsResult.marketsFetched;
    marketsSnapshotSource = marketsResult.marketsSource;
    console.info(
      `[route-discovery] markets source=${marketsResult.marketsSource ?? 'unknown'} ` +
        `eligible=${marketCandidates.length}`,
    );
  }

  let shouldIncludeRpc = includeRpc;
  if (marketFetchMode === 'full' && includeRpc) {
    const tradeEligible = tradeData.candidates.length;
    const marketEligible = marketCandidates.length;
    const combinedUnique = countUniqueDiscoveryPairs(tradeData.candidates, marketCandidates);
    if (
      tradeEligible >= ROUTE_DISCOVERY_RPC_SKIP_MIN ||
      marketEligible >= ROUTE_DISCOVERY_RPC_SKIP_MIN ||
      combinedUnique >= ROUTE_DISCOVERY_RPC_SKIP_MIN
    ) {
      shouldIncludeRpc = false;
      console.info(
        `[route-discovery] skipping RPC scan (trades=${tradeEligible} markets=${marketEligible} combined=${combinedUnique})`,
      );
    }
  }

  if (shouldIncludeRpc) {
    rpcPools = await fetchScanPoolsViaIxBuilder(inputMint, outputMint).catch((err) => {
      console.warn(
        `[route-via-trades] scan-pools failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as ScannedPoolCandidate[];
    });
  }

  const tradeQueued = includeTrades
    ? toQueuedMarketEntries(tradeData.candidates)
    : [];
  const marketQueued = includeMarkets ? toQueuedMarketEntries(marketCandidates) : [];
  const candidates = mergeDiscoveryCandidates(tradeQueued, marketQueued, rpcPools);

  const tradeInTop5 =
    marketQueued.length > 0 &&
    tradeQueued.some((t) => {
      const top5 = marketQueued
        .slice(0, ROUTE_ENUMERATE_LIQUIDITY_SLOTS)
        .map((m) => candidatePairKey(m.marketAddress, m.programAddress));
      return top5.includes(candidatePairKey(t.marketAddress, t.programAddress));
    });
  console.info(
    `[route-discovery] merged=${candidates.length} strategy=` +
      `${marketQueued.length === 0 ? 'trades-only' : tradeInTop5 ? 'top6-liquidity' : 'top5-liquidity+top-trade'}`,
  );

  console.info(
    `[route-discovery] mode=${marketFetchMode} ` +
      `${inputMint.slice(0, 8)}…→${outputMint.slice(0, 8)}… ` +
      `trades=${tradeData.candidates.length} markets=${marketCandidates.length} ` +
      `rpc=${rpcPools.length} merged=${candidates.length}` +
      (tradeData.tradesSource ? ` tradesSource=${tradeData.tradesSource}` : ''),
  );

  return { tradeData, marketCandidates, marketsSnapshotFetched, marketsSnapshotSource, rpcPools, candidates };
}

function quoteOutAmountRawFromBuild(build: import('../types/swap.js').VybeSwapBuildResponse): bigint {
  const raw = String(build.details?.quote?.outAmount ?? '').trim();
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

function sortRouteBuildSuccessesByQuotedOutput(successes: RouteBuildSuccess[]): RouteBuildSuccess[] {
  return [...successes].sort(
    (a, b) =>
      Number(quoteOutAmountRawFromBuild(b.build) - quoteOutAmountRawFromBuild(a.build)),
  );
}

async function buildRoutesForCandidates(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  candidates: EnumeratedRouteCandidate[],
  buildSwap: typeof import('./swap-build.js').buildSwap,
  options: { stopOnFirst: boolean },
): Promise<{
  successes: RouteBuildSuccess[];
  tried: TradeMarketCandidate[];
  buildLog: RouteViaTradesBuildAttemptLog[];
  lastError: string;
}> {
  const successes: RouteBuildSuccess[] = [];
  const tried: TradeMarketCandidate[] = [];
  const buildLog: RouteViaTradesBuildAttemptLog[] = [];
  let lastError = 'unknown error';

  if (options.stopOnFirst) {
    for (const queueEntry of candidates) {
      const attempt = quickProbeAttemptForQueueEntry(queueEntry);
      if (!attempt) continue;
      const result = await trySingleBuildAttempt(http, body, queueEntry, attempt, buildSwap);
      buildLog.push(...result.buildLog);
      tried.push(result.queueEntry);
      if (result.ok) {
        successes.push({
          candidate: queueEntry,
          build: result.build,
          selected: result.selected,
        });
        break;
      }
      lastError = result.lastError;
    }
    return { successes, tried, buildLog, lastError };
  }

  type QuoteProbe = {
    queueEntry: EnumeratedRouteCandidate;
    build: import('../types/swap.js').VybeSwapBuildResponse;
    selected: TradeMarketCandidate;
    outAmount: bigint;
    buildLog: RouteViaTradesBuildAttemptLog[];
  };

  const quoteProbes: QuoteProbe[] = [];

  for (const queueEntry of candidates) {
    const attempt = quickProbeAttemptForQueueEntry(queueEntry);
    if (!attempt) continue;
    const probe = await tryQuoteProbeAttempt(http, body, queueEntry, attempt, buildSwap);
    buildLog.push(...probe.buildLog);
    tried.push(probe.queueEntry);
    if (probe.ok) {
      quoteProbes.push({
        queueEntry,
        build: probe.build,
        selected: probe.selected,
        outAmount: probe.outAmount,
        buildLog: probe.buildLog,
      });
    } else {
      lastError = probe.lastError;
    }
  }

  quoteProbes.sort((a, b) => Number(b.outAmount - a.outAmount));

  console.info(
    `[route-discovery] quote-probe ranked=${quoteProbes.length} ` +
      `sim-validating until ${ROUTE_ENUMERATE_MAX_ROUTES} pass (full on-chain sim each)`,
  );

  for (let i = 0; i < quoteProbes.length; i++) {
    if (successes.length >= ROUTE_ENUMERATE_MAX_ROUTES) break;
    const probe = quoteProbes[i]!;
    console.info(
      `[solana-rpc] quote-probe full validate rank=${i + 1} ` +
        `pool=${probe.queueEntry.marketAddress.slice(0, 8)}…`,
    );
    const validation = await validateTradeBuild(probe.build, probe.queueEntry, body);

    if (!validation.ok) {
      lastError = describeTradeBuildRejectReasonFromValidation(validation.reason);
      buildLog.push({
        queueIndex: probe.queueEntry.queueIndex,
        marketAddress: probe.queueEntry.marketAddress,
        programLabel: probe.queueEntry.programLabel,
        tradeCount: probe.queueEntry.tradeCount,
        attempt: 'quote-probe validate',
        success: false,
        error: lastError,
      });
      continue;
    }
    successes.push({
      candidate: probe.queueEntry,
      build: probe.build,
      selected: probe.selected,
      simulation: validation.simulation,
    });
    buildLog.push({
      queueIndex: probe.queueEntry.queueIndex,
      marketAddress: probe.queueEntry.marketAddress,
      programLabel: probe.queueEntry.programLabel,
      tradeCount: probe.queueEntry.tradeCount,
      attempt: 'quote-probe validate',
      success: true,
    });
  }

  return {
    successes: sortRouteBuildSuccessesByQuotedOutput(successes),
    tried,
    buildLog,
    lastError,
  };
}

function pickPrimaryRouteSuccess(successes: RouteBuildSuccess[]): RouteBuildSuccess | undefined {
  if (successes.length === 0) return undefined;
  return sortRouteBuildSuccessesByQuotedOutput(successes)[0];
}

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

async function tryQuoteProbeAttempt(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  queueEntry: QueuedMarketEntry,
  attempt: BuildAttempt,
  buildSwap: typeof import('./swap-build.js').buildSwap,
): Promise<
  | {
      ok: true;
      build: import('../types/swap.js').VybeSwapBuildResponse;
      selected: TradeMarketCandidate;
      outAmount: bigint;
      buildLog: RouteViaTradesBuildAttemptLog[];
      queueEntry: QueuedMarketEntry;
    }
  | {
      ok: false;
      lastError: string;
      buildLog: RouteViaTradesBuildAttemptLog[];
      queueEntry: QueuedMarketEntry;
    }
> {
  const candidate = queueEntry;
  const baseLog: Omit<RouteViaTradesBuildAttemptLog, 'attempt' | 'success' | 'provider' | 'error'> = {
    queueIndex: queueEntry.queueIndex,
    marketAddress: queueEntry.marketAddress,
    programLabel: queueEntry.programLabel,
    tradeCount: queueEntry.tradeCount,
  };
  const attemptLabel = `${describeBuildAttempt(attempt)} (quote probe)`;
  try {
    const build = await buildSwap(http, buildSwapBodyForTradeAttempt(body, attempt));
    const provider = String(build.provider ?? build.details?.quote?.provider ?? '').trim();
    if (!acceptTradeRoutedBuild(build, candidate, attempt)) {
      const lastError = 'Built tx missing expected pool/program accounts';
      return {
        ok: false,
        lastError,
        queueEntry,
        buildLog: [{ ...baseLog, attempt: attemptLabel, provider: provider || undefined, success: false, error: lastError }],
      };
    }
    const outAmount = quoteOutAmountRawFromBuild(build);
    if (outAmount <= 0n) {
      const lastError = 'Swap quote returned zero output';
      return {
        ok: false,
        lastError,
        queueEntry,
        buildLog: [{ ...baseLog, attempt: attemptLabel, provider: provider || undefined, success: false, error: lastError }],
      };
    }
    return {
      ok: true,
      build,
      selected: resolveCandidateFromBuild(candidate, build),
      outAmount,
      queueEntry,
      buildLog: [{ ...baseLog, attempt: attemptLabel, provider: provider || undefined, success: true }],
    };
  } catch (err) {
    const lastError = normalizeBuildErrorMessage(
      err instanceof Error ? err.message : err != null ? String(err) : 'unknown error',
      'Swap build failed',
    );
    return {
      ok: false,
      lastError,
      queueEntry,
      buildLog: [{ ...baseLog, attempt: attemptLabel, success: false, error: lastError }],
    };
  }
}

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
    const validation = await validateTradeBuild(build, candidate, body);
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
    const lastError = normalizeBuildErrorMessage(
      err instanceof Error ? err.message : err != null ? String(err) : 'unknown error',
      'Swap build failed',
    );
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

/** Build as if (marketAddress, programAddress) were the #1 row from trades — pool+program only, no trades fetch. */
export async function buildSwapForTradeCandidate(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  candidate: {
    marketAddress: string;
    programAddress?: string;
    protocol?: import('./swap-build.js').BuildSwapParams['protocol'];
    tradeCount?: number;
  },
): Promise<BuildSwapViaTradeMarketsResult> {
  const { buildSwap } = await import('./swap-build.js');
  const marketAddress = candidate.marketAddress.trim();
  const pinned = completePinnedSwapParams({
    poolAddress: marketAddress,
    programAddress: candidate.programAddress?.trim(),
    protocol: candidate.protocol,
  });
  const programAddress = pinned.programAddress?.trim() ?? '';
  const tradeCount = candidate.tradeCount ?? 1;
  const totalStart = Date.now();

  const entry: QueuedMarketEntry = {
    marketAddress,
    programAddress,
    protocol: pinned.protocol ?? programAddressToProtocol(programAddress),
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
  timingsMs.sequentialProbe = Date.now() - probeStart;
  timingsMs.parallelProbe = timingsMs.sequentialProbe;
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

export async function buildSwapViaRpcPools(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
): Promise<BuildSwapViaTradeMarketsResult> {
  const { buildSwap } = await import('./swap-build.js');
  const inputMint = body.inputMintAddress.trim();
  const outputMint = body.outputMintAddress.trim();
  const totalStart = Date.now();
  const timingsMs: NonNullable<RouteViaTradesQueueMeta['timingsMs']> = {};
  const enumerateRoutes = body.enumerateRoutes === true;

  const rpcStart = Date.now();
  const { candidates, rpcPools } = await discoverRouteCandidates(http, inputMint, outputMint, 'rpc');
  timingsMs.fetchTrades = 0;
  timingsMs.sequentialProbe = Date.now() - rpcStart;

  const queued: QueuedMarketEntry[] = candidates.map((c) => ({
    marketAddress: c.marketAddress,
    programAddress: c.programAddress,
    protocol: c.protocol,
    ixBuilderProtocol: c.ixBuilderProtocol,
    tradeCount: c.tradeCount,
    marketScore: c.marketScore,
    programLabel: c.programLabel,
    queueIndex: c.queueIndex,
  }));

  const queueMeta = {
    topMarkets: [] as RankedTradeMarket[],
    maxTradeCount: 0,
    minCountThreshold: 0,
    tried: [] as TradeMarketCandidate[],
    tradesFetched: 0,
    tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
    tradesFetchOk: false,
    tradesFetchedForward: 0,
    tradesFetchedInverse: 0,
    pairTradeCount: 0,
    tradeMarketsEligible: rpcPools.length,
    queued,
    buildLog: [] as RouteViaTradesBuildAttemptLog[],
    timingsMs,
    tradesUnavailable: false,
    tradesSource: undefined,
  };

  if (candidates.length === 0) {
    timingsMs.total = Date.now() - totalStart;
    return {
      kind: 'exhausted',
      ...queueMeta,
      lastError: 'RPC scan found no eligible pools for this pair.',
    };
  }

  const probeStart = Date.now();
  const probe = await buildRoutesForCandidates(http, body, candidates, buildSwap, {
    stopOnFirst: !enumerateRoutes,
  });
  timingsMs.sequentialProbe = Date.now() - probeStart;
  timingsMs.parallelProbe = timingsMs.sequentialProbe;
  timingsMs.total = Date.now() - totalStart;

  const queueMetaWithLog = { ...queueMeta, buildLog: probe.buildLog, tried: probe.tried };

  if (probe.successes.length === 0) {
    return {
      kind: 'exhausted',
      ...queueMetaWithLog,
      lastError: probe.lastError,
    };
  }

  const primary = pickPrimaryRouteSuccess(probe.successes)!;

  if (enumerateRoutes && probe.successes.length > 0) {
    return {
      kind: 'multi',
      routes: probe.successes,
      build: primary.build,
      selected: primary.selected,
      ...queueMetaWithLog,
    };
  }

  return {
    kind: 'direct',
    build: primary.build,
    selected: primary.selected,
    ...queueMetaWithLog,
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
  const enumerateRoutes = body.enumerateRoutes === true;
  const marketFetchMode = normalizeMarketFetchMode(body.marketFetchMode);

  const discoverStart = Date.now();
  const discovered = await discoverRouteCandidates(http, inputMint, outputMint, marketFetchMode);
  const tradeData = discovered.tradeData;
  const candidates = discovered.candidates;
  timingsMs.fetchTrades = Date.now() - discoverStart;

  const queued: QueuedMarketEntry[] = candidates.map((c) => ({
    marketAddress: c.marketAddress,
    programAddress: c.programAddress,
    protocol: c.protocol,
    ixBuilderProtocol: c.ixBuilderProtocol,
    tradeCount: c.tradeCount,
    marketScore: c.marketScore,
    programLabel: c.programLabel,
    queueIndex: c.queueIndex,
  }));

  const tradesUnavailable = tradeData.tradesUnavailable === true;

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
    marketsSnapshotFetched: discovered.marketsSnapshotFetched,
    marketsSnapshotEligible: discovered.marketCandidates.length,
    marketsSnapshotSource: discovered.marketsSnapshotSource,
    rpcPoolsScanned: discovered.rpcPools.length,
    queued,
    buildLog: [] as RouteViaTradesBuildAttemptLog[],
    timingsMs,
    tradesUnavailable,
    tradesSource: tradeData.tradesSource,
  };

  if (candidates.length === 0) {
    timingsMs.total = Date.now() - totalStart;
    const noTradesOnly =
      marketFetchMode === 'trades' ||
      marketFetchMode === 'markets' ||
      (!enumerateRoutes && marketFetchMode !== 'rpc' && marketFetchMode !== 'full');
    return {
      kind: 'exhausted',
      ...queueMeta,
      tried: [],
      lastError: tradesUnavailable
        ? TRADES_API_UNAVAILABLE_MESSAGE
        : marketFetchMode === 'markets'
          ? 'Markets snapshot: no eligible pools for this pair.'
          : noTradesOnly
            ? 'Route via Trades: no eligible markets (ix-builder supported program + ≥5% of top pool trade count).'
            : 'No eligible route candidates from discovery.',
    };
  }

  const probeStart = Date.now();
  const probe = await buildRoutesForCandidates(http, body, candidates, buildSwap, {
    stopOnFirst: !enumerateRoutes,
  });
  timingsMs.sequentialProbe = Date.now() - probeStart;
  timingsMs.parallelProbe = timingsMs.sequentialProbe;
  timingsMs.total = Date.now() - totalStart;

  const queueMetaWithLog = { ...queueMeta, buildLog: probe.buildLog, tried: probe.tried };

  if (probe.successes.length === 0) {
    return {
      kind: 'exhausted',
      ...queueMetaWithLog,
      lastError: probe.lastError,
    };
  }

  const primary = pickPrimaryRouteSuccess(probe.successes)!;

  if (enumerateRoutes) {
    return {
      kind: 'multi',
      routes: probe.successes,
      build: primary.build,
      selected: primary.selected,
      ...queueMetaWithLog,
    };
  }

  return {
    kind: 'direct',
    build: primary.build,
    selected: primary.selected,
    ...queueMetaWithLog,
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
  const tradesSource = (meta as { tradesSource?: string }).tradesSource;
  if (tradesSource) {
    lines.push(`Trades source: ${tradesSource}`);
  }
  lines.push(
    `Trade-ranked pools: max ${meta.maxTradeCount} trades — queue ≥${Math.round(meta.minCountThreshold)} (${meta.tradeMarketsEligible} eligible)`,
  );
  const marketsFetched = (meta as { marketsSnapshotFetched?: number }).marketsSnapshotFetched;
  const marketsEligible = (meta as { marketsSnapshotEligible?: number }).marketsSnapshotEligible;
  const marketsSource = (meta as { marketsSnapshotSource?: string }).marketsSnapshotSource;
  if (marketsFetched != null) {
    lines.push(
      `PG markets snapshot: raw=${marketsFetched} eligible=${marketsEligible ?? 0}` +
        (marketsSource ? ` source=${marketsSource}` : ''),
    );
  }
  const rpcScanned = (meta as { rpcPoolsScanned?: number }).rpcPoolsScanned;
  if (rpcScanned != null && rpcScanned > 0) {
    lines.push(`RPC scan: ${rpcScanned} pool(s) merged into route list`);
  }
  lines.push(`Merged queue: ${meta.queued.length} route(s)`);
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
  tradesUnavailable?: boolean;
}> {
  const inputMint = params.inputMintAddress.trim();
  const outputMint = params.outputMintAddress.trim();
  const limit = params.limit ?? ROUTE_VIA_TRADES_LIMIT;

  const { trades, rawCount, tradesUnavailable } = await fetchTradesForPair(
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
    tradesUnavailable: tradesUnavailable === true,
  };
}
