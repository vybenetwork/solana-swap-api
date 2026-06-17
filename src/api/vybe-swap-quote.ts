/**
 * Vybe router quote: resolve token prices, build swap, synthesize quote-shaped response.
 */

import type { AxiosInstance } from 'axios';
import {
  assertPinnedPoolParams,
  completePinnedSwapParams,
} from './pinned-swap-params.js';
import { enrichBuildParamsWithAtaHints } from './wallet-ata-hints.js';
import { buildSwap, buildSwapWithFallback, type BuildSwapParams, type MarketFetchMode, type SwapProxyRouter, isMarketDiscoveryEnabled, normalizeMarketFetchMode, resolveEnumerateRoutes, resolveMarketFetchMode } from './swap-build.js';
import {
  formatRouteViaTradesServerLog,
  ROUTE_VIA_TRADES_LIMIT,
  type QueuedMarketEntry,
  type RankedTradeMarket,
  type RouteCandidateSource,
  type RouteRpcMeta,
  type RouteViaTradesBuildAttemptLog,
  type RouteViaTradesQueueMeta,
  type TradeMarketCandidate,
} from './route-via-trades.js';
import {
  resolveTokenPrices,
  type TokenPriceHint,
  type TokenPriceStats,
} from './resolve-token-prices.js';
import type { VybeSwapQuote, VybeSwapBuildResponse, VybeRoutePlanStep } from '../types/swap.js';
import { assertWalletHasSellAmount } from './wallet-balance.js';
import { quoteFromBuild } from './map-enrichment.js';
import { NATIVE_SOL_MINT, toVybeSwapMint } from './sol-mints.js';
import {
  isCommonQuotePair,
  rpcScanUnsupportedForCommonQuotesError,
} from './ix-builder-quote-tokens.js';

/** Wrapped SOL mint — Vybe TokenInformationCH symbol is `wSOL` for this address. */
export { WSOL_MINT } from './sol-mints.js';

export interface VybeQuoteParams extends BuildSwapParams {
  tokenHints?: Record<string, TokenPriceHint>;
  forceFullDetailsMints?: string[];
}

export type RouteViaTradesOutcome =
  | 'direct'
  | 'multi'
  | 'unpinned_vybe'
  | 'rpc_only'
  | 'titan_fallback'
  | 'jupiter_fallback'
  | 'skipped'
  | 'failed';

export type RouteViaTradesDisabledReason =
  | 'discovery_off'
  | 'manual_pool'
  | 'manual_protocol'
  | 'router_not_vybe';

export interface RouteViaTradesRecoveryLogEntry {
  step: 'unpinned_vybe' | 'titan' | 'jupiter';
  success: boolean;
  provider?: string;
  error?: string;
}

export interface RouteViaTradesRouteEntry {
  index: number;
  source: RouteCandidateSource;
  candidate: TradeMarketCandidate;
  rpcMeta?: RouteRpcMeta;
  build: VybeSwapBuildResponse;
  quote: VybeSwapQuote;
  simulatedOutRaw?: string;
}

export interface RouteViaTradesMeta {
  enabled: boolean;
  disabledReason?: RouteViaTradesDisabledReason;
  outcome: RouteViaTradesOutcome;
  topMarkets: RankedTradeMarket[];
  maxTradeCount: number;
  minCountThreshold: number;
  selected?: TradeMarketCandidate;
  tried: TradeMarketCandidate[];
  tradesFetched: number;
  tradesFetchLimit: number;
  tradesFetchOk: boolean;
  tradesFetchedForward: number;
  tradesFetchedInverse: number;
  pairTradeCount: number;
  tradeMarketsEligible: number;
  queued: QueuedMarketEntry[];
  buildLog: RouteViaTradesBuildAttemptLog[];
  recoveryLog?: RouteViaTradesRecoveryLogEntry[];
  timingsMs?: RouteViaTradesQueueMeta['timingsMs'];
  /** Set when queue + unpinned Vybe retry failed and we used an aggregator instead. */
  fallbackRouter?: SwapProxyRouter;
  directRouteFailed?: boolean;
  /** Plain Vybe build (no pool pin) succeeded after the trade queue was exhausted. */
  unpinnedVybeRetry?: boolean;
  lastError?: string;
  /** When GET /v4/trades returns 404. */
  tradesUnavailable?: boolean;
  tradesSource?: 'clickhouse' | 'vybe_api' | 'vybe_remote';
  tradesOldestBlockTime?: number | null;
  tradesOldestAt?: string | null;
  marketsSnapshotFetched?: number;
  marketsSnapshotEligible?: number;
  marketsSnapshotSource?: 'clickhouse_markets' | 'vybe_api';
  rpcPoolsScanned?: number;
  marketFetchMode?: MarketFetchMode;
  enumerateRoutes?: boolean;
  selectedRouteIndex?: number;
  routes?: RouteViaTradesRouteEntry[];
  /** User-facing banner text (warning or success after Jupiter fallback). */
  userMessage?: string;
}

function logRouteViaTradesMeta(meta: RouteViaTradesMeta): void {
  const lines = formatRouteViaTradesServerLog(meta);
  if (lines.length === 0) return;
  console.info('[route-via-trades]\n' + lines.join('\n'));
}

function buildSkippedRouteViaTradesMeta(
  params: VybeQuoteParams,
  selected: SwapProxyRouter,
): RouteViaTradesMeta {
  let disabledReason: RouteViaTradesDisabledReason;
  if (!isMarketDiscoveryEnabled(params)) disabledReason = 'discovery_off';
  else if (selected !== 'vybe') disabledReason = 'router_not_vybe';
  else if (params.poolAddress?.trim() || params.programAddress?.trim()) disabledReason = 'manual_pool';
  else if (params.protocol != null) disabledReason = 'manual_protocol';
  else disabledReason = 'discovery_off';

  return {
    enabled: false,
    disabledReason,
    outcome: 'skipped',
    topMarkets: [],
    maxTradeCount: 0,
    minCountThreshold: 0,
    tried: [],
    tradesFetched: 0,
    tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
    tradesFetchOk: false,
    tradesFetchedForward: 0,
    tradesFetchedInverse: 0,
    pairTradeCount: 0,
    tradeMarketsEligible: 0,
    queued: [],
    buildLog: [],
  };
}

function marketDiscoveryRouteMeta(
  marketFetchMode: MarketFetchMode,
  enumerateRoutes: boolean,
): RouteViaTradesMeta {
  return {
    enabled: true,
    outcome: 'direct',
    marketFetchMode,
    enumerateRoutes,
    topMarkets: [],
    maxTradeCount: 0,
    minCountThreshold: 0,
    tried: [],
    tradesFetched: 0,
    tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
    tradesFetchOk: false,
    tradesFetchedForward: 0,
    tradesFetchedInverse: 0,
    pairTradeCount: 0,
    tradeMarketsEligible: 0,
    queued: [],
    buildLog: [],
    userMessage: `Vybe router (marketFetchMode=${marketFetchMode}).`,
  };
}

export interface VybeQuoteResult {
  quote: VybeSwapQuote;
  build: VybeSwapBuildResponse | null;
  builtAt: number;
  tokenStats: Record<string, TokenPriceStats>;
  routeViaTrades?: RouteViaTradesMeta;
}

function normalizeRouterId(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'jupiter' || raw === 'titan' || raw === 'vybe') return raw;
  return raw || 'vybe';
}

function attachRouterMetadata(
  quote: VybeSwapQuote,
  selectedRouter: unknown,
  effectiveRouter: unknown,
  fallbackUsed: boolean,
): VybeSwapQuote {
  const selected = normalizeRouterId(selectedRouter);
  const effective = normalizeRouterId(effectiveRouter);
  return {
    ...quote,
    _selectedRouter: selected,
    _effectiveRouter: effective,
    _routerFallbackUsed: fallbackUsed,
  };
}

function aliasNativeSolPriceStats(
  stats: Record<string, TokenPriceStats>,
  uiMint: string,
): Record<string, TokenPriceStats> {
  const vybeMint = toVybeSwapMint(uiMint);
  if (uiMint === NATIVE_SOL_MINT && stats[vybeMint] && !stats[uiMint]) {
    return { ...stats, [uiMint]: stats[vybeMint]! };
  }
  return stats;
}

export async function buildVybeQuoteFromPriceAndSwap(
  http: AxiosInstance,
  params: VybeQuoteParams,
): Promise<VybeQuoteResult> {
  const uiInputMint = params.inputMintAddress.trim();
  const uiOutputMint = params.outputMintAddress.trim();
  const selected = normalizeRouterId(params.router ?? 'vybe') as SwapProxyRouter;

  const enriched = await enrichBuildParamsWithAtaHints(http, {
    ...params,
    router: selected,
    inputMintAddress: uiInputMint,
    outputMintAddress: uiOutputMint,
  });

  const vybeInputMint = toVybeSwapMint(uiInputMint);
  const vybeOutputMint = toVybeSwapMint(uiOutputMint);

  const inputSymbolHint =
    params.tokenHints?.[uiInputMint]?.symbol ?? params.tokenHints?.[vybeInputMint]?.symbol;
  await assertWalletHasSellAmount(
    http,
    enriched.accountAddress,
    uiInputMint,
    enriched.amount,
    inputSymbolHint,
  );

  const priceMint = vybeInputMint;
  const forceFull = (params.forceFullDetailsMints ?? []).map((m) => toVybeSwapMint(m.trim()));
  const hints = { ...params.tokenHints };
  if (uiInputMint === NATIVE_SOL_MINT && hints[vybeInputMint] && !hints[uiInputMint]) {
    hints[uiInputMint] = hints[vybeInputMint];
  }
  if (uiOutputMint === NATIVE_SOL_MINT && hints[vybeOutputMint] && !hints[uiOutputMint]) {
    hints[uiOutputMint] = hints[vybeOutputMint];
  }

  const { stats: rawStats } = await resolveTokenPrices(http, [priceMint, uiOutputMint], {
    tokenHints: hints,
    forceFullDetailsMints: forceFull,
  });
  let tokenStats = aliasNativeSolPriceStats(rawStats, uiInputMint);
  tokenStats = aliasNativeSolPriceStats(tokenStats, uiOutputMint);

  const inputStats = tokenStats[uiInputMint] ?? tokenStats[vybeInputMint];
  const outputStats = tokenStats[uiOutputMint] ?? tokenStats[vybeOutputMint];
  if (!inputStats) {
    throw new Error(`Could not resolve price for input mint ${uiInputMint}`);
  }
  if (!outputStats) {
    throw new Error(`Could not resolve price for output mint ${uiOutputMint}`);
  }

  const vybeParams: VybeQuoteParams = {
    ...params,
    ...enriched,
    inputMintAddress: vybeInputMint,
    outputMintAddress: vybeOutputMint,
  };
  assertPinnedPoolParams(params);
  const manualPool = params.poolAddress?.trim();
  const manualProgram = params.programAddress?.trim();
  const manualProtocol = params.protocol;
  const useMarketDiscovery =
    isMarketDiscoveryEnabled(params) &&
    selected === 'vybe' &&
    params.protocol == null &&
    !params.poolAddress?.trim() &&
    !params.programAddress?.trim();
  const marketFetchMode = useMarketDiscovery
    ? normalizeMarketFetchMode(params.marketFetchMode ?? 'full')
    : resolveMarketFetchMode(params);
  const enumerateRoutes = resolveEnumerateRoutes(params);
  const bothCommonQuotes = isCommonQuotePair(uiInputMint, uiOutputMint);
  const useTradeCandidatePin = Boolean(
    manualPool && (manualProgram || manualProtocol) && !useMarketDiscovery,
  );

  let build: VybeSwapBuildResponse;
  let routeViaTrades: RouteViaTradesMeta | undefined;

  if (useTradeCandidatePin) {
    build = await buildSwap(
      http,
      completePinnedSwapParams({
        ...vybeParams,
        router: 'vybe',
        poolAddress: manualPool,
        ...(manualProgram ? { programAddress: manualProgram } : {}),
        ...(manualProtocol ? { protocol: manualProtocol } : {}),
      }),
    );
    routeViaTrades = buildSkippedRouteViaTradesMeta(vybeParams, 'vybe');
    logRouteViaTradesMeta(routeViaTrades);
  } else if (useMarketDiscovery) {
    if (marketFetchMode === 'rpc' && bothCommonQuotes) {
      throw new Error(rpcScanUnsupportedForCommonQuotesError());
    }
    build = await buildSwap(http, {
      ...vybeParams,
      router: 'vybe',
      marketFetchMode,
      enumerateRoutes,
    });
    routeViaTrades = marketDiscoveryRouteMeta(marketFetchMode, enumerateRoutes);
    logRouteViaTradesMeta(routeViaTrades);
  } else {
    build =
      selected === 'vybe'
        ? await buildSwapWithFallback(http, { ...vybeParams, router: selected })
        : await buildSwap(http, { ...vybeParams, router: selected });
    if (selected === 'vybe') {
      routeViaTrades = buildSkippedRouteViaTradesMeta(vybeParams, selected);
      logRouteViaTradesMeta(routeViaTrades);
    }
  }
  // ix-builder owns simulation + fees + USD + %; project its enrichment onto the quote.
  const tradeRouteFallback = routeViaTrades?.fallbackRouter;
  const effective = tradeRouteFallback
    ? tradeRouteFallback
    : routeViaTrades
      ? 'vybe'
      : normalizeRouterId(build.provider ?? selected);
  const quote = attachRouterMetadata(
    quoteFromBuild(build, { uiInputMint, uiOutputMint }),
    selected,
    effective,
    tradeRouteFallback != null || (routeViaTrades ? false : effective !== selected),
  );
  let finalQuote = quote;
  if (uiInputMint === NATIVE_SOL_MINT) {
    finalQuote = { ...finalQuote, inputMintAddress: NATIVE_SOL_MINT };
  }
  if (uiOutputMint === NATIVE_SOL_MINT) {
    finalQuote = { ...finalQuote, outputMintAddress: NATIVE_SOL_MINT };
  }
  return {
    quote: finalQuote,
    build,
    builtAt: Date.now(),
    tokenStats,
    routeViaTrades,
  };
}
