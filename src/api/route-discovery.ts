/**
 * Route discovery: rank recent trade markets for a mint pair and map program → Vybe protocol.
 * Supported programs mirror ix-builder-api (Vybe swap router direct integrations).
 */

import type { AxiosInstance } from 'axios';
import type { VybeTrade } from '../types/api.js';
import type { SwapProxyProtocol } from './swap-build.js';
import {
  completePinnedSwapParams,
  isSupportedIxBuilderProgram,
  IX_BUILDER_PROGRAM_IDS,
  programAddressToIxBuilderProtocol,
  programAddressToProtocol,
  programLabelForAddress,
  enrichCandidatesWithLiquidity,
  filterRouteQueueByLiquidity,
  isMeteoraDlmmCandidate,
  isDirectSamePairRouteCandidate,
  isMeteoraDlmmInsufficientBinLiquidityError,
} from './pinned-swap-params.js';
export {
  isSupportedIxBuilderProgram,
  IX_BUILDER_PROGRAM_IDS,
  programAddressToIxBuilderProtocol,
  programAddressToProtocol,
  programLabelForAddress,
  enrichCandidatesWithLiquidity,
  filterRouteQueueByLiquidity,
  MIN_TICK_ARRAY_LIQUIDITY_USD,
} from './pinned-swap-params.js';
import { isIxBuilderQuoteToken } from './ix-builder-quote-tokens.js';
import {
  buildIncludesPoolAccount,
  staticAccountKeysFromSwapTx,
  validateTradeBuildStatic,
} from './pool-address-validation.js';
import { isQuoteBridgeBuild, type QuoteBridgeBuildDetails } from './quote-bridge-detect.js';
import { isQuoteBridgeHopComboDisabled, quoteBridgeHopComboKey } from './quote-bridge-hop-combos.js';
import { toVybeSwapMint } from './sol-mints.js';
import { getTrades, isVybeApiNotFoundError, type GetTradesParams } from './trades.js';

export const ROUTE_DISCOVERY_LIMIT = 1000;
export const ROUTE_DISCOVERY_DISPLAY_MARKETS = 15;
/** Keep pools with tradeCount >= this fraction × busiest pool (e.g. 0.05 → ≥5%). */
export const ROUTE_DISCOVERY_MIN_COUNT_FRACTION = 0.05;
/** Max pinned build attempts from the eligible trade-ranked queue. */
export const ROUTE_DISCOVERY_MAX_QUEUE_ATTEMPTS = 6;
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
/** @deprecated Use ROUTE_DISCOVERY_MAX_QUEUE_ATTEMPTS */
export const ROUTE_DISCOVERY_TOP_MARKETS = ROUTE_DISCOVERY_MAX_QUEUE_ATTEMPTS;

export interface TradeMarketCandidate {
  marketAddress: string;
  programAddress: string;
  protocol?: SwapProxyProtocol;
  ixBuilderProtocol?: string;
  /** Total recent trades on this pool for the pair (buyCount + sellCount). */
  tradeCount: number;
  /** Trades where base = output mint and quote = input mint (buy input). */
  buyCount: number;
  /** Trades where base = input mint and quote = output mint (sell input). */
  sellCount: number;
  /** Human-readable DEX name (Raydium AMM v4, Meteora DLMM, …). */
  programLabel?: string;
  /** Liquidity score from PG markets snapshot (markets discovery only). */
  liquidity?: number;
  /** Discovery source tag from ix-builder (`trades` | `markets` | `rpc`). */
  discoverySource?: string;
}

export interface PoolTradeActivity {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
}

export function normalizePoolTradeActivity(
  partial?: Partial<PoolTradeActivity> | null,
): PoolTradeActivity {
  const buyCount = Math.max(0, Number(partial?.buyCount ?? 0)) || 0;
  const sellCount = Math.max(0, Number(partial?.sellCount ?? 0)) || 0;
  const explicitTotal = Number(partial?.tradeCount ?? NaN);
  const tradeCount =
    Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : buyCount + sellCount;
  return { tradeCount, buyCount, sellCount };
}

export function poolTradeActivityFromBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
): PoolTradeActivity {
  const raw = build as Record<string, unknown>;
  return normalizePoolTradeActivity({
    tradeCount: Number(raw.tradeCount),
    buyCount: Number(raw.buyCount),
    sellCount: Number(raw.sellCount),
  });
}

export function poolDiscoverySourceFromBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
): string | undefined {
  const raw = build as Record<string, unknown>;
  const source = raw.source ?? raw.discoverySource;
  return typeof source === 'string' && source.trim() ? source.trim() : undefined;
}

export function hasAnyPoolTradeActivity(
  ...items: Array<Partial<PoolTradeActivity> | null | undefined>
): boolean {
  return items.some((item) => normalizePoolTradeActivity(item).tradeCount > 0);
}

/** Ranked row included in `_routeDiscovery.topMarkets` on quote responses. */
export interface RankedTradeMarket extends TradeMarketCandidate {
  rank: number;
  programLabel: string;
  supportedProgram: boolean;
  eligible: boolean;
}

export interface RouteDiscoveryMarketResolution {
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

/** Trade row matches buy-input ← sell-output (base = output mint, quote = input mint). */
export function tradeMatchesBuyInputDirection(
  t: VybeTrade,
  inputMint: string,
  outputMint: string,
): boolean {
  const base = toVybeSwapMint(t.baseMintAddress ?? '');
  const quote = toVybeSwapMint(t.quoteMintAddress ?? '');
  const input = toVybeSwapMint(inputMint);
  const output = toVybeSwapMint(outputMint);
  return base === output && quote === input;
}

function tradeSideForSwapPair(
  t: VybeTrade,
  inputMint: string,
  outputMint: string,
): 'sell' | 'buy' | null {
  if (tradeMatchesSellInputDirection(t, inputMint, outputMint)) return 'sell';
  if (tradeMatchesBuyInputDirection(t, inputMint, outputMint)) return 'buy';
  return null;
}

function bumpCandidateTradeActivity(candidate: TradeMarketCandidate, side: 'sell' | 'buy'): void {
  if (side === 'sell') candidate.sellCount += 1;
  else candidate.buyCount += 1;
  candidate.tradeCount = candidate.buyCount + candidate.sellCount;
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

/** Rank distinct (marketAddress, programAddress) pairs from direct pair trade rows. */
export function rankAllMarketsFromTrades(
  trades: VybeTrade[],
  inputMint: string,
  outputMint: string,
): TradeMarketCandidate[] {
  const byPair = new Map<string, TradeMarketCandidate>();

  for (const t of trades) {
    const side = tradeSideForSwapPair(t, inputMint, outputMint);
    if (!side) continue;
    const marketAddress = (t.marketAddress ?? '').trim();
    const programAddress = (t.programAddress ?? '').trim();
    if (!marketAddress || !programAddress) continue;

    const key = `${marketAddress}\0${programAddress}`;
    const existing = byPair.get(key);
    if (existing) {
      bumpCandidateTradeActivity(existing, side);
      continue;
    }

    const candidate: TradeMarketCandidate = {
      marketAddress,
      programAddress,
      protocol: programAddressToProtocol(programAddress),
      ixBuilderProtocol: programAddressToIxBuilderProtocol(programAddress),
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      discoverySource: 'trades',
    };
    bumpCandidateTradeActivity(candidate, side);
    byPair.set(key, candidate);
  }

  return [...byPair.values()].sort((a, b) => b.tradeCount - a.tradeCount);
}

/** Apply ix-builder program filter + min trade-count fraction; build display + queue lists. */
export function resolveMarketsForRouteDiscovery(
  ranked: TradeMarketCandidate[],
  options?: { minCountFraction?: number; displayLimit?: number },
): RouteDiscoveryMarketResolution {
  const minFraction = options?.minCountFraction ?? ROUTE_DISCOVERY_MIN_COUNT_FRACTION;
  const displayLimit = options?.displayLimit ?? ROUTE_DISCOVERY_DISPLAY_MARKETS;

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

/** @deprecated Use rankAllMarketsFromTrades + resolveMarketsForRouteDiscovery */
export function rankMarketsFromTrades(
  trades: VybeTrade[],
  inputMint: string,
  outputMint: string,
): TradeMarketCandidate[] {
  const ranked = rankAllMarketsFromTrades(trades, inputMint, outputMint);
  return resolveMarketsForRouteDiscovery(ranked).queueCandidates;
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

export interface RouteQuoteBridge {
  bridgeMint?: string;
  userVettedMint?: string;
  isBuyingToken?: boolean;
}

export interface RouteRpcMeta {
  liquidity?: string;
  preSwapNeeded?: boolean;
  quoteBridge?: RouteQuoteBridge;
}

export interface EnumeratedRouteCandidate extends QueuedMarketEntry {
  source: RouteCandidateSource;
  rpcMeta?: RouteRpcMeta;
}

export interface RouteBuildSuccess {
  candidate: EnumeratedRouteCandidate;
  build: import('../types/swap.js').VybeSwapBuildResponse;
  selected: TradeMarketCandidate;
}

export interface RouteDiscoveryBuildAttemptLog {
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
  return toQueuedMarketEntries(candidates, ROUTE_DISCOVERY_MAX_QUEUE_ATTEMPTS);
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

function swapHasTx(build: import('../types/swap.js').VybeSwapBuildResponse): boolean {
  const tx = build.tx ?? build.transaction;
  return typeof tx === 'string' && tx.trim().length > 0;
}

/** USD pool TVL from ix-builder build details (`poolLiquidity`). */
const MAX_SANE_POOL_LIQUIDITY_USD = 10_000_000_000;

export function poolLiquidityUsdFromBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
): number | undefined {
  const raw = build as Record<string, unknown>;
  const details = raw.details as Record<string, unknown> | undefined;
  const score = details?.poolLiquidity ?? details?.liquidity ?? raw.liquidity;
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SANE_POOL_LIQUIDITY_USD) return undefined;
  return n;
}

function tradeCandidateFromVybeBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
): TradeMarketCandidate {
  const marketAddress = poolAddressFromBuild(build);
  const programAddress = String(build.programAddress ?? '').trim();
  const protocolRaw = build.protocol;
  const protocol =
    typeof protocolRaw === 'string' ? (protocolRaw as import('./swap-build.js').SwapProxyProtocol) : undefined;
  const programLabel = programAddress ? programLabelForAddress(programAddress) : 'unknown';
  const liquidity = poolLiquidityUsdFromBuild(build);
  const activity = poolTradeActivityFromBuild(build);
  const discoverySource = poolDiscoverySourceFromBuild(build);
  return {
    marketAddress,
    programAddress,
    protocol,
    ...activity,
    programLabel,
    ...(liquidity != null ? { liquidity } : {}),
    ...(discoverySource ? { discoverySource } : {}),
  };
}

function discoverySourceFromBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
): RouteCandidateSource {
  const raw = poolDiscoverySourceFromBuild(build);
  if (raw === 'markets') return 'markets';
  if (raw === 'rpc') return 'rpc';
  if (raw === 'trades') return 'trades';
  return 'trades';
}

function routeBuildSuccessFromVybeBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
  index: number,
): RouteBuildSuccess {
  const selected = tradeCandidateFromVybeBuild(build);
  const candidate: EnumeratedRouteCandidate = {
    ...selected,
    programLabel: selected.programLabel ?? programLabelForAddress(selected.programAddress),
    source: discoverySourceFromBuild(build),
    queueIndex: index + 1,
  };
  return { candidate, build, selected };
}

export type VybeEnumeratedSwapParseResult =
  | {
      kind: 'multi';
      routes: RouteBuildSuccess[];
      build: import('../types/swap.js').VybeSwapBuildResponse;
      selected: TradeMarketCandidate;
    }
  | {
      kind: 'direct';
      build: import('../types/swap.js').VybeSwapBuildResponse;
      selected: TradeMarketCandidate;
    }
  | { kind: 'none' };

/** Parse `outcome` + `routes[]` from Vybe POST /v4/trading/swap when enumerateRoutes is enabled. */
export function parseVybeEnumeratedSwapRoutes(
  build: import('../types/swap.js').VybeSwapBuildResponse,
): VybeEnumeratedSwapParseResult {
  const routesRaw = build.routes;
  if (build.outcome === 'multi' && Array.isArray(routesRaw) && routesRaw.length > 0) {
    const routes = routesRaw
      .map((route, i) =>
        routeBuildSuccessFromVybeBuild(route as import('../types/swap.js').VybeSwapBuildResponse, i),
      )
      .filter((entry) => !isQuoteBridgeHopComboDisabled(entry.build));
    if (routes.length === 0) return { kind: 'none' };
    const primary = routes[0]!;
    return { kind: 'multi', routes, build: primary.build, selected: primary.selected };
  }
  if (swapHasTx(build)) {
    if (isQuoteBridgeHopComboDisabled(build)) {
      return { kind: 'none' };
    }
    const selected = tradeCandidateFromVybeBuild(build);
    if (selected.marketAddress && selected.programAddress) {
      return { kind: 'direct', build, selected };
    }
    // Prod Vybe API: native DEX tx without enumerate metadata (no pool/program on response).
    const provider =
      build.provider ??
      (build.details as { quote?: { provider?: string } } | undefined)?.quote?.provider;
    if (isDirectVybeDexProvider(provider)) {
      return { kind: 'direct', build, selected };
    }
  }
  return { kind: 'none' };
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
  // CLMM/DLMM put pool state in ALTs — trust build.poolAddress / enrichment ammKey.
  if (pool && !buildIncludesPoolAccount(build, pool, keys)) {
    return { ok: false, missingPool: true };
  }
  return { ok: true };
}

/**
 * Validate a built route without re-simulating: static pool/program presence + ix-builder's
 * own simulation result (the build was requested with enrich:true). swap-api never simulates.
 *
 * Quote-bridge routes: accept when txs + quoted output are present. Main leg is often not
 * simulatable (wallet lacks bridge mint); pre-swap probe sim may fail during enumeration
 * without meaning the route is unroutable.
 */
function validateTradeBuild(
  build: import('../types/swap.js').VybeSwapBuildResponse,
  candidate: TradeMarketCandidate,
): { ok: boolean; reason: string } {
  const result = validateTradeBuildStatic(build, {
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

  if (isQuoteBridgeHopComboDisabled(build)) {
    const combo = quoteBridgeHopComboKey(build) ?? 'unknown';
    return { ok: false, reason: `Quote-bridge hop combination disabled: ${combo}` };
  }

  if (isQuoteBridgeBuild(build)) {
    const details = build.details as QuoteBridgeBuildDetails;
    const preNeeded =
      details.preSwapNeeded === true || (build as { preSwapNeeded?: boolean }).preSwapNeeded === true;
    const preTx =
      (build as { preSwapTransaction?: string }).preSwapTransaction ??
      details.preSwapTransaction;
    if (preNeeded && (!preTx || !String(preTx).trim())) {
      return { ok: false, reason: 'Quote-bridge build missing preSwapTransaction' };
    }
    if (quoteOutAmountRawFromBuild(build) <= 0n) {
      return { ok: false, reason: 'Swap quote returned zero output' };
    }
    return { ok: true, reason: '' };
  }

  const sim = build.enrichment?.simulated;
  if (sim) {
    if (sim.err != null) {
      return { ok: false, reason: `Swap simulation failed: ${JSON.stringify(sim.err)}` };
    }
    if (sim.outputDeltaRaw === '0') {
      return { ok: false, reason: 'Swap simulation returned zero output' };
    }
  }

  return { ok: true, reason: '' };
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
      console.warn(`[route-discovery] ${TRADES_API_UNAVAILABLE_MESSAGE}`);
      return { trades: [], rawCount: 0, fetchParams, tradesUnavailable: true };
    }
    throw err;
  }
}

function resolveFromTrades(
  trades: VybeTrade[],
  inputMint: string,
  outputMint: string,
): RouteDiscoveryMarketResolution & { pairTradeCount: number } {
  const pairTradeCount = trades.filter((t) =>
    tradeMatchesSellInputDirection(t, inputMint, outputMint),
  ).length;
  const ranked = rankAllMarketsFromTrades(trades, inputMint, outputMint);
  const resolved = resolveMarketsForRouteDiscovery(ranked);
  return { ...resolved, pairTradeCount };
}

export interface RouteDiscoveryQueueMeta {
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
  buildLog: RouteDiscoveryBuildAttemptLog[];
  /** GET /v4/trades returned 404 — queue empty, use Jupiter fallback. */
  tradesUnavailable?: boolean;
  tradesSource?: TradesFetchResult['tradesSource'];
  /** Unix seconds of the oldest trade row in the fetch (coverage floor). */
  tradesOldestBlockTime?: number | null;
  /** ISO-8601 timestamp of the oldest trade row in the fetch. */
  tradesOldestAt?: string | null;
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

export interface RouteDiscoveryBuildResult extends RouteDiscoveryQueueMeta {
  build: import('../types/swap.js').VybeSwapBuildResponse;
  selected: TradeMarketCandidate;
}

export interface RouteDiscoveryExhaustedResult extends RouteDiscoveryQueueMeta {
  kind: 'exhausted';
  lastError: string;
}

export interface RouteDiscoveryMultiResult extends RouteDiscoveryQueueMeta {
  kind: 'multi';
  routes: RouteBuildSuccess[];
  build: import('../types/swap.js').VybeSwapBuildResponse;
  selected: TradeMarketCandidate;
}

export type BuildSwapViaTradeMarketsResult =
  | ({ kind: 'direct' } & RouteDiscoveryBuildResult)
  | RouteDiscoveryMultiResult
  | RouteDiscoveryExhaustedResult;

function candidatePairKey(marketAddress: string, programAddress: string): string {
  return `${marketAddress.trim()}\0${programAddress.trim()}`;
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

/** Pure on-chain RPC scan rows — backfill only when trades/markets cannot fill enumerate slots. */
function isPureRpcRouteCandidate(c: EnumeratedRouteCandidate): boolean {
  return c.source === 'rpc';
}

function candidatesForEnumerationProbe(candidates: EnumeratedRouteCandidate[]): EnumeratedRouteCandidate[] {
  const primary = candidates.filter((c) => !isPureRpcRouteCandidate(c));
  const rpcBackfill = candidates.filter((c) => isPureRpcRouteCandidate(c));
  if (primary.length === 0) return candidates;
  return [...primary, ...rpcBackfill];
}

function finalizeEnumeratedRouteSuccesses(successes: RouteBuildSuccess[]): RouteBuildSuccess[] {
  const ranked = sortRouteBuildSuccessesByQuotedOutput(successes);
  const nonRpc = ranked.filter((s) => !isPureRpcRouteCandidate(s.candidate));
  if (nonRpc.length >= ROUTE_ENUMERATE_MAX_ROUTES) {
    return nonRpc.slice(0, ROUTE_ENUMERATE_MAX_ROUTES);
  }
  return ranked.slice(0, ROUTE_ENUMERATE_MAX_ROUTES);
}

/** A route requires an extra hop when its build is a quote-bridge/pre-swap or the candidate is tagged so. */
function buildRouteIsHopRequired(
  build: import('../types/swap.js').VybeSwapBuildResponse,
  candidate: EnumeratedRouteCandidate,
): boolean {
  return (
    isQuoteBridgeBuild(build) ||
    Boolean(candidate.rpcMeta?.quoteBridge || candidate.rpcMeta?.preSwapNeeded)
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
  buildLog: RouteDiscoveryBuildAttemptLog[];
  lastError: string;
}> {
  const successes: RouteBuildSuccess[] = [];
  const tried: TradeMarketCandidate[] = [];
  const buildLog: RouteDiscoveryBuildAttemptLog[] = [];
  let lastError = 'unknown error';
  let skipRemainingMeteoraDlmm = false;

  if (options.stopOnFirst) {
    for (const queueEntry of candidates) {
      if (
        skipRemainingMeteoraDlmm &&
        isMeteoraDlmmCandidate(queueEntry) &&
        isDirectSamePairRouteCandidate(queueEntry)
      ) {
        console.info(
          `[route-discovery] skip direct DLMM ${queueEntry.marketAddress.slice(0, 8)}… (prior same-pair bin liquidity failure)`,
        );
        continue;
      }
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
      if (
        isMeteoraDlmmCandidate(queueEntry) &&
        isDirectSamePairRouteCandidate(queueEntry) &&
        isMeteoraDlmmInsufficientBinLiquidityError(lastError)
      ) {
        skipRemainingMeteoraDlmm = true;
        console.info(
          '[route-discovery] METEORA_DLMM bin liquidity insufficient — skipping remaining direct same-pair DLMM candidates (quote-bridge hubs still tried)',
        );
      }
    }
    return { successes, tried, buildLog, lastError };
  }

  // Enumerate: build + on-chain validate candidates in queue order, stopping once
  // ROUTE_ENUMERATE_MAX_ROUTES routes pass on-chain sim. The happy path runs exactly
  // ROUTE_ENUMERATE_MAX_ROUTES simulations; deeper candidates are only probed to backfill failures.
  console.info(
    `[route-discovery] enumerate: build+sim in queue order until ${ROUTE_ENUMERATE_MAX_ROUTES} pass ` +
      `(scan deeper only on errors; RPC pools deferred behind trades/markets)`,
  );

  const probeQueue = candidatesForEnumerationProbe(candidates);
  let nextCandidateIndex = probeQueue.length;
  for (let i = 0; i < probeQueue.length; i++) {
    if (successes.length >= ROUTE_ENUMERATE_MAX_ROUTES) {
      nextCandidateIndex = i;
      break;
    }
    const queueEntry = probeQueue[i]!;
    if (
      skipRemainingMeteoraDlmm &&
      isMeteoraDlmmCandidate(queueEntry) &&
      isDirectSamePairRouteCandidate(queueEntry)
    ) {
      console.info(
        `[route-discovery] skip direct DLMM ${queueEntry.marketAddress.slice(0, 8)}… (prior same-pair bin liquidity failure)`,
      );
      continue;
    }
    const validated = await buildAndValidateCandidate(http, body, queueEntry, buildSwap);
    buildLog.push(...validated.buildLog);
    if (validated.tried) tried.push(queueEntry);
    if (validated.ok) {
      successes.push(validated.success);
    } else {
      lastError = validated.lastError;
      if (
        isMeteoraDlmmCandidate(queueEntry) &&
        isDirectSamePairRouteCandidate(queueEntry) &&
        isMeteoraDlmmInsufficientBinLiquidityError(lastError)
      ) {
        skipRemainingMeteoraDlmm = true;
        console.info(
          '[route-discovery] METEORA_DLMM bin liquidity insufficient — skipping remaining direct same-pair DLMM candidates (quote-bridge hubs still tried)',
        );
      }
    }
  }

  await ensureDirectRouteInValidatedTopN(
    http,
    body,
    probeQueue,
    nextCandidateIndex,
    successes,
    tried,
    buildLog,
    buildSwap,
    skipRemainingMeteoraDlmm,
  );

  return {
    successes: finalizeEnumeratedRouteSuccesses(successes),
    tried,
    buildLog,
    lastError,
  };
}

type BuildAndValidateResult =
  | { ok: true; tried: true; success: RouteBuildSuccess; buildLog: RouteDiscoveryBuildAttemptLog[] }
  | { ok: false; tried: boolean; lastError: string; buildLog: RouteDiscoveryBuildAttemptLog[] };

/** Build (quote probe) then full on-chain validate a single candidate. One build + one sim. */
async function buildAndValidateCandidate(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  queueEntry: EnumeratedRouteCandidate,
  buildSwap: typeof import('./swap-build.js').buildSwap,
): Promise<BuildAndValidateResult> {
  const attempt = quickProbeAttemptForQueueEntry(queueEntry);
  if (!attempt) {
    return { ok: false, tried: false, lastError: 'No build attempt for candidate', buildLog: [] };
  }
  const probe = await tryQuoteProbeAttempt(http, body, queueEntry, attempt, buildSwap);
  const buildLog = [...probe.buildLog];
  if (!probe.ok) {
    return { ok: false, tried: true, lastError: probe.lastError, buildLog };
  }
  console.info(
    `[route-validate] ix-builder sim check pool=${queueEntry.marketAddress.slice(0, 8)}…`,
  );
  const validation = validateTradeBuild(probe.build, queueEntry);
  const logBase = {
    queueIndex: queueEntry.queueIndex,
    marketAddress: queueEntry.marketAddress,
    programLabel: queueEntry.programLabel,
    tradeCount: queueEntry.tradeCount,
    attempt: 'quote-probe validate',
  };
  if (!validation.ok) {
    const lastError = describeTradeBuildRejectReasonFromValidation(validation.reason);
    buildLog.push({ ...logBase, success: false, error: lastError });
    return { ok: false, tried: true, lastError, buildLog };
  }
  buildLog.push({ ...logBase, success: true });
  return {
    ok: true,
    tried: true,
    success: {
      candidate: queueEntry,
      build: probe.build,
      selected: probe.selected,
    },
    buildLog,
  };
}

/**
 * Direct-route diversity (final validated routes): when the validated top-N are all hop-required
 * (quote-bridge / pre-swap), scan the remaining queue for the first direct route that passes on-chain
 * sim and swap it into the last slot. ix-builder already reserves a direct slot in the top-N discovery
 * queue, so this rarely needs to build extra candidates — it only fires when that direct slot failed.
 */
async function ensureDirectRouteInValidatedTopN(
  http: AxiosInstance,
  body: import('./swap-build.js').BuildSwapParams,
  candidates: EnumeratedRouteCandidate[],
  startIndex: number,
  successes: RouteBuildSuccess[],
  tried: TradeMarketCandidate[],
  buildLog: RouteDiscoveryBuildAttemptLog[],
  buildSwap: typeof import('./swap-build.js').buildSwap,
  skipRemainingMeteoraDlmm = false,
): Promise<void> {
  if (successes.length < ROUTE_ENUMERATE_MAX_ROUTES) return;
  if (!successes.every((s) => buildRouteIsHopRequired(s.build, s.candidate))) return;

  const haveKeys = new Set(
    successes.map((s) => candidatePairKey(s.candidate.marketAddress, s.candidate.programAddress)),
  );

  for (let i = startIndex; i < candidates.length; i++) {
    const queueEntry = candidates[i]!;
    if (
      skipRemainingMeteoraDlmm &&
      isMeteoraDlmmCandidate(queueEntry) &&
      isDirectSamePairRouteCandidate(queueEntry)
    ) {
      console.info(
        `[route-discovery] skip direct DLMM ${queueEntry.marketAddress.slice(0, 8)}… (prior same-pair bin liquidity failure)`,
      );
      continue;
    }
    if (haveKeys.has(candidatePairKey(queueEntry.marketAddress, queueEntry.programAddress))) continue;
    if (isPureRpcRouteCandidate(queueEntry)) continue;
    // Cheap pre-filter: skip candidates already tagged hop-required to avoid wasted builds.
    if (queueEntry.rpcMeta?.quoteBridge || queueEntry.rpcMeta?.preSwapNeeded) continue;

    const validated = await buildAndValidateCandidate(http, body, queueEntry, buildSwap);
    buildLog.push(...validated.buildLog);
    if (validated.tried) tried.push(queueEntry);
    if (!validated.ok) continue;
    if (buildRouteIsHopRequired(validated.success.build, queueEntry)) continue;

    const ranked = sortRouteBuildSuccessesByQuotedOutput(successes);
    const replaced = ranked[ranked.length - 1]!;
    successes.length = 0;
    successes.push(...ranked.slice(0, ranked.length - 1), validated.success);
    console.info(
      `[route-discovery] direct diversity: top-${ROUTE_ENUMERATE_MAX_ROUTES} all hop-required → ` +
        `swapped ${replaced.candidate.marketAddress.slice(0, 8)}… for direct ` +
        `${queueEntry.marketAddress.slice(0, 8)}… in slot ${ROUTE_ENUMERATE_MAX_ROUTES}`,
    );
    return;
  }
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
  candidate: TradeMarketCandidate,
): import('./swap-build.js').BuildSwapParams {
  const { protocol: _omitProtocol, poolAddress: _omitPool, programAddress: _omitProgram, ...rest } =
    body;
  return completePinnedSwapParams({
    ...rest,
    router: 'vybe',
    // Route enumeration probes pin pool/program and rely on enrich:true for ix-builder's
    // on-chain sim + reported pool (ammKey). simulate:true makes local ix-builder return
    // simulation-only (no tx), which fails assertIxBuilderSwapResponse and rejects every candidate.
    // Always enrich here even when the client sent enrich:false (sign path) — CLMM/DLMM pool
    // accounts live in ALTs, so validation needs enrichment.ammKey / poolAddress.
    simulate: false,
    enrich: true,
    poolAddress: attempt.poolAddress,
    programAddress: attempt.programAddress,
    protocol: attempt.protocol,
    liquidity: candidate.liquidity,
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
      buildLog: RouteDiscoveryBuildAttemptLog[];
      queueEntry: QueuedMarketEntry;
    }
  | {
      ok: false;
      lastError: string;
      buildLog: RouteDiscoveryBuildAttemptLog[];
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
      buildLog: RouteDiscoveryBuildAttemptLog[];
      queueEntry: QueuedMarketEntry;
    }
  | {
      ok: false;
      lastError: string;
      buildLog: RouteDiscoveryBuildAttemptLog[];
      queueEntry: QueuedMarketEntry;
    }
> {
  const candidate = queueEntry;
  const baseLog: Omit<RouteDiscoveryBuildAttemptLog, 'attempt' | 'success' | 'provider' | 'error'> = {
    queueIndex: queueEntry.queueIndex,
    marketAddress: queueEntry.marketAddress,
    programLabel: queueEntry.programLabel,
    tradeCount: queueEntry.tradeCount,
  };
  const attemptLabel = `${describeBuildAttempt(attempt)} (quote probe)`;
  try {
    const build = await buildSwap(http, buildSwapBodyForTradeAttempt(body, attempt, candidate));
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
  const baseLog: Omit<RouteDiscoveryBuildAttemptLog, 'attempt' | 'success' | 'provider' | 'error'> = {
    queueIndex: queueEntry.queueIndex,
    marketAddress: queueEntry.marketAddress,
    programLabel: queueEntry.programLabel,
    tradeCount: queueEntry.tradeCount,
  };
  const attemptLabel = describeBuildAttempt(attempt);
  try {
    const build = await buildSwap(http, buildSwapBodyForTradeAttempt(body, attempt, candidate));
    const provider = String(build.provider ?? build.details?.quote?.provider ?? '').trim();
    const validation = validateTradeBuild(build, candidate);
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
    buyCount?: number;
    sellCount?: number;
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
  const buyCount = candidate.buyCount ?? 0;
  const sellCount = candidate.sellCount ?? 0;
  const totalStart = Date.now();

  const entry: QueuedMarketEntry = {
    marketAddress,
    programAddress,
    protocol: pinned.protocol ?? programAddressToProtocol(programAddress),
    ixBuilderProtocol: programAddressToIxBuilderProtocol(programAddress),
    tradeCount,
    buyCount,
    sellCount,
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
  const buildLog: RouteDiscoveryBuildAttemptLog[] = [];
  const timingsMs: NonNullable<RouteDiscoveryQueueMeta['timingsMs']> = {
    fetchTrades: 0,
    total: 0,
  };

  const queueMeta = {
    topMarkets,
    maxTradeCount: tradeCount,
    minCountThreshold: tradeCount,
    tradesFetched: 0,
    tradesFetchLimit: ROUTE_DISCOVERY_LIMIT,
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
      lastError: 'Route discovery: missing pool or program address.',
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

function formatTradesFetchLookbackSec(oldestBlockTimeSec: number | null | undefined): string {
  const bt = Number(oldestBlockTimeSec);
  if (!Number.isFinite(bt) || bt <= 0) return '';
  const ageHours = Math.max(0, Date.now() / 1000 - bt) / 3600;
  if (ageHours < 24) {
    const hours = ageHours >= 10 ? Math.round(ageHours) : Math.round(ageHours * 10) / 10;
    return `last ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round((ageHours / 24) * 10) / 10;
  return `last ${days} day${days === 1 ? '' : 's'}`;
}

/** Human-readable server log for Route discovery diagnostics. */
export function formatRouteDiscoveryServerLog(
  meta: Pick<
    RouteDiscoveryQueueMeta,
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
    lines.push(`Route discovery: disabled (${meta.disabledReason ?? 'unknown'})`);
    return lines;
  }
  lines.push(
    `Trades fetch: ${meta.tradesFetched} rows (limit ${meta.tradesFetchLimit}) — ${meta.pairTradeCount} matched sell→buy pair for ranking`,
  );
  const tradesOldestAt = (meta as { tradesOldestAt?: string | null }).tradesOldestAt;
  const tradesOldestBlockTime = (meta as { tradesOldestBlockTime?: number | null }).tradesOldestBlockTime;
  if (tradesOldestAt || tradesOldestBlockTime) {
    const lookback = formatTradesFetchLookbackSec(tradesOldestBlockTime);
    lines.push(
      `Trades coverage: ${lookback || 'unknown'}${tradesOldestAt ? ` (oldest ${tradesOldestAt})` : ''}`,
    );
  }
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
  lines.push(
    `Candidate pool: ${meta.queued.length} route(s) ` +
      `(build+sim in order; deeper pools only probed to backfill failures)`,
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
  tradesUnavailable?: boolean;
}> {
  const inputMint = params.inputMintAddress.trim();
  const outputMint = params.outputMintAddress.trim();
  const limit = params.limit ?? ROUTE_DISCOVERY_LIMIT;

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
