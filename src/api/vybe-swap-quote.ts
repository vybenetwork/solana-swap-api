/**
 * Vybe router quote: resolve token prices, build swap, synthesize quote-shaped response.
 */

import type { AxiosInstance } from 'axios';
import {
  assertPinnedPoolParams,
  completePinnedSwapParams,
  programLabelForAddress,
} from './pinned-swap-params.js';
import { enrichBuildParamsWithAtaHints } from './wallet-ata-hints.js';
import { buildSwap, type BuildSwapParams, type MarketFetchMode, type SwapProxyRouter, isMarketDiscoveryEnabled, normalizeMarketFetchMode, resolveEnumerateRoutes, resolveMarketFetchMode } from './swap-build.js';
import {
  buildSwapForTradeCandidate,
  formatRouteViaTradesServerLog,
  normalizeBuildErrorMessage,
  parseVybeEnumeratedSwapRoutes,
  ROUTE_VIA_TRADES_LIMIT,
  type BuildSwapViaTradeMarketsResult,
  type EnumeratedRouteCandidate,
  type QueuedMarketEntry,
  type RankedTradeMarket,
  type RouteBuildSuccess,
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

function routerDisplayLabel(routerId: string): string {
  const id = normalizeRouterId(routerId);
  if (id === 'jupiter') return 'Jupiter';
  if (id === 'titan') return 'Titan';
  if (id === 'vybe') return 'Vybe';
  return id.charAt(0).toUpperCase() + id.slice(1);
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

function baseRouteViaTradesMetaFromRouted(
  routed: BuildSwapViaTradeMarketsResult,
  marketFetchMode: MarketFetchMode,
  enumerateRoutes: boolean,
): Omit<RouteViaTradesMeta, 'outcome' | 'selected' | 'enabled'> {
  return {
    topMarkets: routed.topMarkets,
    maxTradeCount: routed.maxTradeCount,
    minCountThreshold: routed.minCountThreshold,
    tried: routed.tried,
    tradesFetched: routed.tradesFetched,
    tradesFetchLimit: routed.tradesFetchLimit,
    tradesFetchOk: routed.tradesFetchOk,
    tradesFetchedForward: routed.tradesFetchedForward,
    tradesFetchedInverse: routed.tradesFetchedInverse,
    pairTradeCount: routed.pairTradeCount,
    tradeMarketsEligible: routed.tradeMarketsEligible,
    queued: routed.queued,
    buildLog: routed.buildLog,
    timingsMs: routed.timingsMs,
    tradesSource: routed.tradesSource,
    tradesOldestBlockTime: routed.tradesOldestBlockTime,
    tradesOldestAt: routed.tradesOldestAt,
    marketsSnapshotFetched: routed.marketsSnapshotFetched,
    marketsSnapshotEligible: routed.marketsSnapshotEligible,
    marketsSnapshotSource: routed.marketsSnapshotSource,
    rpcPoolsScanned: routed.rpcPoolsScanned,
    marketFetchMode,
    enumerateRoutes,
    tradesUnavailable: routed.tradesUnavailable === true,
  };
}

async function runVybeSwapEnumeration(
  http: AxiosInstance,
  vybeParams: VybeQuoteParams,
  opts: {
    marketFetchMode: MarketFetchMode;
    enumerateRoutes: boolean;
    uiInputMint: string;
    uiOutputMint: string;
    selected: SwapProxyRouter;
    bothCommonQuotes: boolean;
    userMessage?: string;
    exhaustedMessage?: string;
  },
): Promise<{
  build: VybeSwapBuildResponse;
  routeViaTrades?: RouteViaTradesMeta;
  precomputedPrimaryQuote?: VybeSwapQuote;
}> {
  const build = await buildSwap(http, {
    ...vybeParams,
    router: 'vybe',
    marketFetchMode: opts.marketFetchMode,
    enumerateRoutes: opts.enumerateRoutes,
    simulate: false,
  });
  const parsed = parseVybeEnumeratedSwapRoutes(build);
  const userMessage = opts.userMessage ?? 'Routed via Vybe swap enumeration.';
  const exhaustedMessage = opts.exhaustedMessage ?? 'Vybe swap enumeration returned no routes';

  if (parsed.kind === 'multi') {
    const enumRoutes = await buildEnumeratedRouteQuotes(
      parsed.routes,
      opts.uiInputMint,
      opts.uiOutputMint,
      opts.selected,
    );
    const precomputedPrimaryQuote = enumRoutes[0]?.quote;
    Object.assign(
      vybeParams,
      completePinnedSwapParams({
        poolAddress: parsed.selected.marketAddress,
        programAddress: parsed.selected.programAddress,
        protocol: parsed.selected.protocol,
      }),
    );
    const routeViaTrades: RouteViaTradesMeta = {
      enabled: true,
      outcome: 'multi',
      selected: parsed.selected,
      selectedRouteIndex: 0,
      routes: enumRoutes,
      marketFetchMode: opts.marketFetchMode,
      enumerateRoutes: opts.enumerateRoutes,
      topMarkets: [],
      maxTradeCount: 0,
      minCountThreshold: 0,
      tried: parsed.routes.map((r) => r.selected),
      tradesFetched: 0,
      tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
      tradesFetchOk: false,
      tradesFetchedForward: 0,
      tradesFetchedInverse: 0,
      pairTradeCount: 0,
      tradeMarketsEligible: parsed.routes.length,
      queued: parsed.routes.map((r, i) => ({
        marketAddress: r.selected.marketAddress,
        programAddress: r.selected.programAddress,
        protocol: r.selected.protocol,
        programLabel:
          r.selected.programLabel ?? programLabelForAddress(r.selected.programAddress),
        queueIndex: i + 1,
        tradeCount: 0,
      })),
      buildLog: [],
      userMessage,
    };
    logRouteViaTradesMeta(routeViaTrades);
    return { build, routeViaTrades, precomputedPrimaryQuote };
  }

  if (parsed.kind === 'direct') {
    Object.assign(
      vybeParams,
      completePinnedSwapParams({
        poolAddress: parsed.selected.marketAddress,
        programAddress: parsed.selected.programAddress,
        protocol: parsed.selected.protocol,
      }),
    );
    const routeViaTrades: RouteViaTradesMeta = {
      enabled: true,
      outcome: 'direct',
      selected: parsed.selected,
      marketFetchMode: opts.marketFetchMode,
      enumerateRoutes: opts.enumerateRoutes,
      topMarkets: [],
      maxTradeCount: 0,
      minCountThreshold: 0,
      tried: [parsed.selected],
      tradesFetched: 0,
      tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
      tradesFetchOk: false,
      tradesFetchedForward: 0,
      tradesFetchedInverse: 0,
      pairTradeCount: 0,
      tradeMarketsEligible: 1,
      queued: [],
      buildLog: [],
      userMessage,
    };
    logRouteViaTradesMeta(routeViaTrades);
    return { build, routeViaTrades };
  }

  // Single-route mode: trust Vybe API response (incl. aggregator fallback in provider).
  if (!opts.enumerateRoutes) {
    const tx = build.tx ?? build.transaction;
    if (typeof tx === 'string' && tx.length > 0) {
      const routeViaTrades: RouteViaTradesMeta = {
        enabled: true,
        outcome: 'direct',
        marketFetchMode: opts.marketFetchMode,
        enumerateRoutes: false,
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
        userMessage: 'Routed via Vybe swap.',
      };
      logRouteViaTradesMeta(routeViaTrades);
      return { build, routeViaTrades };
    }
  }

  throw new Error(exhaustedMessage);
}

function quoteOutputRawFromEntry(entry: RouteViaTradesRouteEntry): bigint {
  const sim = entry.simulatedOutRaw?.trim();
  if (sim) {
    try {
      return BigInt(sim);
    } catch {
      /* fall through */
    }
  }
  const fromQuote = String(entry.quote?.outAmount ?? entry.quote?._quotedOutAmount ?? '').trim();
  if (fromQuote) {
    try {
      return BigInt(fromQuote);
    } catch {
      /* fall through */
    }
  }
  return 0n;
}

function sortRouteEntriesByOutput(routes: RouteViaTradesRouteEntry[]): RouteViaTradesRouteEntry[] {
  const sorted = [...routes].sort((a, b) => Number(quoteOutputRawFromEntry(b) - quoteOutputRawFromEntry(a)));
  return sorted.map((route, i) => ({ ...route, index: i }));
}

async function buildEnumeratedRouteQuotes(
  routeBuilds: RouteBuildSuccess[],
  uiInputMint: string,
  uiOutputMint: string,
  selectedRouter: SwapProxyRouter,
): Promise<RouteViaTradesRouteEntry[]> {
  const routes: RouteViaTradesRouteEntry[] = [];
  for (let i = 0; i < routeBuilds.length; i++) {
    const entry = routeBuilds[i]!;
    // Each enumerated build was produced with enrich:true, so it already carries its
    // own ix-builder simulation + fees + USD + %. Just project it onto the quote shape.
    let quote = attachRouterMetadata(
      quoteFromBuild(entry.build, { uiInputMint, uiOutputMint }),
      selectedRouter,
      'vybe',
      false,
    );
    if (uiInputMint === NATIVE_SOL_MINT) quote = { ...quote, inputMintAddress: NATIVE_SOL_MINT };
    if (uiOutputMint === NATIVE_SOL_MINT) quote = { ...quote, outputMintAddress: NATIVE_SOL_MINT };
    const candidate = entry.candidate as EnumeratedRouteCandidate;
    const simulatedOutRaw = entry.build.enrichment?.simulatedOutRaw ?? undefined;
    routes.push({
      index: i,
      source: candidate.source ?? 'trades',
      candidate: {
        ...entry.selected,
        marketScore: candidate.marketScore ?? entry.selected.marketScore,
        programLabel: candidate.programLabel ?? programLabelForAddress(entry.selected.programAddress),
      },
      rpcMeta: candidate.rpcMeta,
      build: entry.build,
      quote,
      simulatedOutRaw: simulatedOutRaw ?? undefined,
    });
  }
  return sortRouteEntriesByOutput(routes);
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
  dataHttp: AxiosInstance = http,
): Promise<VybeQuoteResult> {
  const uiInputMint = params.inputMintAddress.trim();
  const uiOutputMint = params.outputMintAddress.trim();
  const selected = normalizeRouterId(params.router ?? 'vybe') as SwapProxyRouter;

  const enriched = await enrichBuildParamsWithAtaHints(dataHttp, {
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
    dataHttp,
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

  const { stats: rawStats } = await resolveTokenPrices(dataHttp, [priceMint, uiOutputMint], {
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
  const useDiscoveryFetch =
    useMarketDiscovery && !manualPool && marketFetchMode !== 'rpc';

  let build: VybeSwapBuildResponse;
  let routeViaTrades: RouteViaTradesMeta | undefined;
  let precomputedPrimaryQuote: VybeSwapQuote | undefined;

  if (useMarketDiscovery && marketFetchMode === 'rpc') {
    if (bothCommonQuotes) {
      throw new Error(rpcScanUnsupportedForCommonQuotesError());
    }
    if (enumerateRoutes) {
      const enumerated = await runVybeSwapEnumeration(http, vybeParams, {
        marketFetchMode: 'rpc',
        enumerateRoutes: true,
        uiInputMint,
        uiOutputMint,
        selected,
        bothCommonQuotes,
        userMessage: 'Routed via Vybe RPC pool scan.',
        exhaustedMessage: 'Vybe RPC pool scan returned no routes',
      });
      build = enumerated.build;
      routeViaTrades = enumerated.routeViaTrades;
      precomputedPrimaryQuote = enumerated.precomputedPrimaryQuote;
    } else {
      build = await buildSwap(http, {
        ...vybeParams,
        router: 'vybe',
        marketFetchMode: undefined,
        enumerateRoutes: false,
      });
      routeViaTrades = {
        enabled: true,
        outcome: 'rpc_only',
        marketFetchMode,
        enumerateRoutes: false,
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
        userMessage: 'Routed via Vybe RPC pool scan.',
      };
      logRouteViaTradesMeta(routeViaTrades);
    }
  } else if (useTradeCandidatePin) {
    const routed = await buildSwapForTradeCandidate(http, { ...vybeParams, router: 'vybe' }, {
      marketAddress: manualPool!,
      ...(manualProgram ? { programAddress: manualProgram } : {}),
      ...(manualProtocol ? { protocol: manualProtocol } : {}),
    });
    if (routed.kind === 'direct' || routed.kind === 'multi') {
      build = routed.build;
      Object.assign(
        vybeParams,
        completePinnedSwapParams({
          poolAddress: routed.selected.marketAddress,
          programAddress: routed.selected.programAddress,
          protocol: routed.selected.protocol,
        }),
      );
      if (routed.kind === 'multi') {
        const enumRoutes = await buildEnumeratedRouteQuotes(
          routed.routes,
          uiInputMint,
          uiOutputMint,
          selected,
        );
        precomputedPrimaryQuote = enumRoutes[0]?.quote;
        routeViaTrades = {
          enabled: true,
          outcome: 'multi',
          selected: routed.selected,
          selectedRouteIndex: 0,
          routes: enumRoutes,
          ...baseRouteViaTradesMetaFromRouted(routed, marketFetchMode, true),
        };
      } else {
        routeViaTrades = {
          enabled: true,
          outcome: 'direct',
          marketFetchMode,
          enumerateRoutes,
          topMarkets: routed.topMarkets,
          maxTradeCount: routed.maxTradeCount,
          minCountThreshold: routed.minCountThreshold,
          selected: routed.selected,
          tried: routed.tried,
          tradesFetched: routed.tradesFetched,
          tradesFetchLimit: routed.tradesFetchLimit,
          tradesFetchOk: routed.tradesFetchOk,
          tradesFetchedForward: routed.tradesFetchedForward,
          tradesFetchedInverse: routed.tradesFetchedInverse,
          pairTradeCount: routed.pairTradeCount,
          tradeMarketsEligible: routed.tradeMarketsEligible,
          queued: routed.queued,
          buildLog: routed.buildLog,
          timingsMs: routed.timingsMs,
          tradesSource: routed.tradesSource,
        };
      }
      logRouteViaTradesMeta(routeViaTrades);
    } else {
      throw new Error(
        normalizeBuildErrorMessage(routed.lastError, 'Vybe swap build failed for pinned pool'),
      );
    }
  } else if (useDiscoveryFetch) {
    if (enumerateRoutes) {
      const enumerated = await runVybeSwapEnumeration(http, vybeParams, {
        marketFetchMode,
        enumerateRoutes: true,
        uiInputMint,
        uiOutputMint,
        selected,
        bothCommonQuotes,
      });
      build = enumerated.build;
      routeViaTrades = enumerated.routeViaTrades;
      precomputedPrimaryQuote = enumerated.precomputedPrimaryQuote;
    } else {
      build = await buildSwap(http, {
        ...vybeParams,
        router: 'vybe',
        marketFetchMode,
        enumerateRoutes: false,
        simulate: false,
      });
      const parsed = parseVybeEnumeratedSwapRoutes(build);
      if (parsed.kind === 'direct') {
        routeViaTrades = {
          enabled: true,
          outcome: 'direct',
          selected: parsed.selected,
          marketFetchMode,
          enumerateRoutes: false,
          topMarkets: [],
          maxTradeCount: 0,
          minCountThreshold: 0,
          tried: [parsed.selected],
          tradesFetched: 0,
          tradesFetchLimit: ROUTE_VIA_TRADES_LIMIT,
          tradesFetchOk: false,
          tradesFetchedForward: 0,
          tradesFetchedInverse: 0,
          pairTradeCount: 0,
          tradeMarketsEligible: 1,
          queued: [],
          buildLog: [],
          userMessage: 'Routed via Vybe swap.',
        };
      } else {
        routeViaTrades = {
          enabled: true,
          outcome: 'direct',
          marketFetchMode,
          enumerateRoutes: false,
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
          userMessage: 'Routed via Vybe swap.',
        };
      }
      logRouteViaTradesMeta(routeViaTrades);
    }
  } else {
    build = await buildSwap(http, { ...vybeParams, router: selected });
    if (selected === 'vybe') {
      routeViaTrades = buildSkippedRouteViaTradesMeta(vybeParams, selected);
      logRouteViaTradesMeta(routeViaTrades);
    }
  }
  // Vybe API owns routing, enumeration, and any provider fallback in the build response.
  const effective = normalizeRouterId(build.provider ?? selected);
  const quote = precomputedPrimaryQuote
    ? precomputedPrimaryQuote
    : attachRouterMetadata(
        quoteFromBuild(build, { uiInputMint, uiOutputMint }),
        selected,
        effective,
        effective !== selected,
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
