/**
 * Vybe router quote: resolve token prices, build swap, synthesize quote-shaped response.
 */

import type { AxiosInstance } from 'axios';
import { completePinnedSwapParams, programLabelForAddress } from './pinned-swap-params.js';
import { enrichBuildParamsWithAtaHints } from './wallet-ata-hints.js';
import { buildSwap, buildSwapWithFallback, type BuildSwapParams, type MarketFetchMode, type SwapProxyRouter, isMarketDiscoveryEnabled, normalizeMarketFetchMode, resolveMarketFetchMode } from './swap-build.js';
import {
  buildSwapForTradeCandidate,
  buildSwapViaRpcPools,
  buildSwapViaTradeMarkets,
  formatRouteViaTradesServerLog,
  isAggregatorSwapProvider,
  normalizeBuildErrorMessage,
  ROUTE_VIA_TRADES_LIMIT,
  TRADES_API_UNAVAILABLE_MESSAGE,
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
import {
  simulateSwapEffects,
  type TokenAccRentEntry,
  type EmbeddedPoolFeeEntry,
  type WalletFeeTransferEntry,
  type TokenFeeCreditEntry,
  type InferredHopPoolEntry,
  type WalletTokenAccountCloseEntry,
  mergeBuildAtaCloseHints,
} from './simulate-swap-output.js';
import { enrichRoutePlanFees, sumProtocolFeeAmountRaw } from './enrich-route-fees.js';
import { DEFAULT_SWAP_SLIPPAGE_PCT } from '../config.js';
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

function acceptUnpinnedVybeBuild(build: VybeSwapBuildResponse): boolean {
  const provider = build.provider ?? build.details?.quote?.provider;
  if (isAggregatorSwapProvider(provider)) return false;
  const tx = build.tx ?? build.transaction;
  return typeof tx === 'string' && tx.length > 0;
}

async function recoverAfterTradeQueueExhausted(
  http: AxiosInstance,
  vybeParams: VybeQuoteParams,
  routed: import('./route-via-trades.js').RouteViaTradesExhaustedResult,
  options?: { allowRpcFallback?: boolean },
): Promise<{ build: VybeSwapBuildResponse; routeViaTrades: RouteViaTradesMeta }> {
  const allowRpcFallback = options?.allowRpcFallback !== false;
  const recoveryLog: RouteViaTradesRecoveryLogEntry[] = [];
  const routeViaTrades: RouteViaTradesMeta = {
    enabled: true,
    outcome: 'failed',
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
    directRouteFailed: true,
    lastError: routed.lastError,
    tradesUnavailable: routed.tradesUnavailable === true,
    tradesSource: routed.tradesSource,
    marketFetchMode: vybeParams.marketFetchMode,
    userMessage: routed.tradesUnavailable ? TRADES_API_UNAVAILABLE_MESSAGE : undefined,
  };

  const unpinnedParams: VybeQuoteParams = {
    ...vybeParams,
    router: 'vybe',
    poolAddress: undefined,
    programAddress: undefined,
    protocol: undefined,
    marketFetchMode: undefined,
    enumerateRoutes: undefined,
  };

  if (allowRpcFallback) {
    try {
      const unpinned = await buildSwap(http, unpinnedParams);
      const provider = String(unpinned.provider ?? unpinned.details?.quote?.provider ?? '').trim();
      if (acceptUnpinnedVybeBuild(unpinned)) {
        recoveryLog.push({ step: 'unpinned_vybe', success: true, provider: provider || undefined });
        const meta: RouteViaTradesMeta = {
          ...routeViaTrades,
          outcome: 'unpinned_vybe',
          unpinnedVybeRetry: true,
          directRouteFailed: false,
          recoveryLog,
          userMessage: routed.tradesUnavailable
            ? 'Routed via Vybe auto-route — trades API unavailable.'
            : 'Pinned trade routes failed — using Vybe RPC pool scan.',
        };
        logRouteViaTradesMeta(meta);
        return { build: unpinned, routeViaTrades: meta };
      }
      recoveryLog.push({
        step: 'unpinned_vybe',
        success: false,
        provider: provider || undefined,
        error: provider ? `Vybe returned aggregator/provider ${provider}` : 'no direct tx',
      });
    } catch (err) {
      recoveryLog.push({
        step: 'unpinned_vybe',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const aggregatorParams: VybeQuoteParams = {
    ...vybeParams,
    poolAddress: undefined,
    programAddress: undefined,
    protocol: undefined,
    marketFetchMode: undefined,
    enumerateRoutes: undefined,
  };

  const aggregatorRouters: Array<'jupiter' | 'titan'> = routed.tradesUnavailable
    ? ['jupiter', 'titan']
    : ['titan', 'jupiter'];

  for (const router of aggregatorRouters) {
    try {
      const build = await buildSwap(http, { ...aggregatorParams, router });
      const provider = String(build.provider ?? build.details?.quote?.provider ?? router).trim();
      recoveryLog.push({
        step: router,
        success: true,
        provider: provider || router,
      });
      const outcome = router === 'titan' ? 'titan_fallback' : 'jupiter_fallback';
      const jupiterOk = router === 'jupiter' && routed.tradesUnavailable;
      const meta: RouteViaTradesMeta = {
        ...routeViaTrades,
        outcome,
        fallbackRouter: router,
        recoveryLog,
        userMessage: jupiterOk
          ? 'Routed via Jupiter — Vybe trades API unavailable.'
          : routed.tradesUnavailable && router === 'titan'
            ? 'Routed via Titan — Vybe trades API unavailable.'
            : routeViaTrades.userMessage,
      };
      logRouteViaTradesMeta(meta);
      return { build, routeViaTrades: meta };
    } catch (err) {
      recoveryLog.push({
        step: router,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new Error(
    normalizeBuildErrorMessage(
      routeViaTrades.lastError ?? '',
      'Route via Trades recovery failed',
    ),
  );
}

export interface VybeQuoteResult {
  quote: VybeSwapQuote;
  build: VybeSwapBuildResponse | null;
  builtAt: number;
  tokenStats: Record<string, TokenPriceStats>;
  routeViaTrades?: RouteViaTradesMeta;
}

function rawToUi(raw: string, decimals: number): number {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = n % base;
  if (frac === 0n) return Number(whole);
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return Number(`${whole}.${fracStr}`);
}

function applySlippageThreshold(outRaw: string, slippagePct: number): string {
  const out = BigInt(outRaw);
  const bps = BigInt(Math.max(0, Math.round(slippagePct * 100)));
  const threshold = out - (out * bps) / 10000n;
  return threshold < 0n ? '0' : threshold.toString();
}

function formatImpactPct(spotRate: number, execRate: number): string {
  if (!Number.isFinite(spotRate) || spotRate <= 0 || !Number.isFinite(execRate)) return '0';
  const impact = ((execRate - spotRate) / spotRate) * 100;
  if (!Number.isFinite(impact)) return '0';
  return impact.toFixed(4);
}

/** Vybe-native pool build (Meteora, etc.) — not Jupiter/Titan aggregator responses. */
function isVybeNativePoolBuild(build: VybeSwapBuildResponse, selectedRouter?: string): boolean {
  const selected = normalizeRouterId(selectedRouter ?? 'vybe');
  if (selected !== 'vybe') return false;
  const provider = normalizeRouterId(String(build.provider ?? build.details.quote.provider ?? ''));
  return provider !== 'jupiter' && provider !== 'titan';
}

function normalizeRoutePlan(raw: unknown): VybeRoutePlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((step) => {
    const s = step as Record<string, unknown>;
    const si = s.swapInfo as Record<string, unknown> | undefined;
    if (!si) return step as unknown as VybeRoutePlanStep;
    return {
      ...s,
      swapInfo: {
        ...si,
        inputMintAddress: String(si.inputMintAddress ?? si.inputMint ?? ''),
        outputMintAddress: String(si.outputMintAddress ?? si.outputMint ?? ''),
      },
    } as unknown as VybeRoutePlanStep;
  });
}

function synthesizeQuoteFromBuild(
  params: VybeQuoteParams,
  build: VybeSwapBuildResponse,
  inputMint: string,
  outputMint: string,
  inputStats: TokenPriceStats,
  outputStats: TokenPriceStats,
  effectiveOutAmount?: string,
  feeOpts?: {
    pdaRentLamports?: bigint;
    tokenAccRentByMint?: TokenAccRentEntry[];
    embeddedPoolFeesByHop?: EmbeddedPoolFeeEntry[];
    walletSolTransfers?: WalletFeeTransferEntry[];
    tokenFeeCredits?: TokenFeeCreditEntry[];
    router?: string;
    walletPayDebitRaw?: string | null;
    networkFeeLamports?: bigint;
    inferredPoolAddressesByHop?: InferredHopPoolEntry[];
    walletTokenAccountCloses?: WalletTokenAccountCloseEntry[];
  },
): VybeSwapQuote {
  const inAmount = build.details.quote.inAmount;
  const quotedOutAmount = build.details.quote.outAmount;
  const outAmount = effectiveOutAmount ?? quotedOutAmount;
  const slippagePct = build.slippage ?? params.slippage ?? DEFAULT_SWAP_SLIPPAGE_PCT;
  const outputFromSimulation =
    effectiveOutAmount != null && effectiveOutAmount !== quotedOutAmount;

  const outAmountUi = rawToUi(outAmount, outputStats.decimals);
  const quotedOutUi = rawToUi(quotedOutAmount, outputStats.decimals);
  const inAmountUi = rawToUi(inAmount, inputStats.decimals);
  const otherAmountThreshold = applySlippageThreshold(outAmount, slippagePct);
  const otherAmountThresholdUi = rawToUi(otherAmountThreshold, outputStats.decimals);
  const swapRate = params.amount > 0 ? outAmountUi / params.amount : 0;
  const quotedSwapRate = inAmountUi > 0 ? quotedOutUi / inAmountUi : swapRate;
  const executedSwapRate = inAmountUi > 0 ? outAmountUi / inAmountUi : swapRate;

  const spotCrossRate =
    inputStats.price > 0 && outputStats.price > 0 ? inputStats.price / outputStats.price : 0;
  /* Vybe direct-pool builds can report simulated out well below build quote without true
   * market impact — compare pool quote rate to spot (Jupiter-style), not sim vs spot. */
  const impactExecRate =
    outputFromSimulation && isVybeNativePoolBuild(build, feeOpts?.router)
      ? quotedSwapRate
      : executedSwapRate;
  const priceImpactPct = formatImpactPct(spotCrossRate, impactExecRate);

  const swapUsdValue =
    inputStats.price > 0 && Number.isFinite(params.amount)
      ? (params.amount * inputStats.price).toFixed(2)
      : null;

  const providerLabel = build.provider ?? build.details.quote.provider ?? 'Vybe';
  const inferredPool = feeOpts?.inferredPoolAddressesByHop?.[0]?.poolAddress?.trim();
  const poolKey = params.poolAddress?.trim() || inferredPool || 'vybe';
  const protocolFeeAmount = sumProtocolFeeAmountRaw(build.details.quote);
  const protocolFeeMint =
    build.details.quote.protocolFees?.[0]?.mint ??
    build.details.quote.feeMint ??
    build.details.quote.platformFee?.feeMint ??
    inputMint;

  const baseRoutePlan: VybeRoutePlanStep[] = [
    {
      percent: 100,
      bps: null,
      swapInfo: {
        ammKey: poolKey,
        label: providerLabel,
        inputMintAddress: inputMint,
        outputMintAddress: outputMint,
        inAmount,
        outAmount: quotedOutAmount,
        feeAmount: protocolFeeAmount,
        feeMintAddress: protocolFeeMint,
      },
    },
  ];
  const feeEnrichment = enrichRoutePlanFees(
    baseRoutePlan,
    build,
    outputFromSimulation ? outAmount : null,
    outputMint,
    {
      pdaRentLamports: feeOpts?.pdaRentLamports ?? 0n,
      tokenAccRentByMint: feeOpts?.tokenAccRentByMint,
      embeddedPoolFeesByHop: feeOpts?.embeddedPoolFeesByHop,
      walletSolTransfers: feeOpts?.walletSolTransfers,
      tokenFeeCredits: feeOpts?.tokenFeeCredits,
      router: feeOpts?.router ?? build.provider ?? params.router,
      walletPayDebitRaw: feeOpts?.walletPayDebitRaw ?? null,
      walletAddress: params.accountAddress,
      inputMint,
      networkFeeLamports: feeOpts?.networkFeeLamports ?? 0n,
      inferredPoolAddressesByHop: feeOpts?.inferredPoolAddressesByHop,
    },
  );

  return {
    inputMintAddress: inputMint,
    inAmount,
    outputMintAddress: outputMint,
    outAmount,
    otherAmountThreshold,
    swapMode: 'ExactIn',
    priceImpactPct,
    routePlan: feeEnrichment.routePlan,
    outAmountUi,
    otherAmountThresholdUi,
    swapRate,
    swapUsdValue,
    slippageBps: Math.round(slippagePct * 100),
    _quoteSource: 'vybe-price-build',
    _inputPriceUsd: inputStats.price,
    _outputPriceUsd: outputStats.price,
    _priceUpdateTime: inputStats.priceUpdateTime,
    _buildRouter: build.provider,
    _quotedOutAmount: quotedOutAmount,
    _outputFromSimulation: outputFromSimulation,
    _swapFee: build.details.swapFee,
    _swapFeePct: feeEnrichment.swapFeePct,
    _totalFeeRaw: feeEnrichment.totalFeeRaw,
    _simulatedOutAmount: feeEnrichment.simulatedOutRaw,
    _walletPayDebitRaw: feeOpts?.walletPayDebitRaw ?? null,
    _walletTokenAccountCloses: feeOpts?.walletTokenAccountCloses ?? [],
  };
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

interface RouteSimulationBundle {
  simulatedOutRaw: string | null;
  simulationErr: unknown;
  walletPayDebitRaw: string | null;
  pdaRentLamports: bigint;
  tokenAccRentByMint: TokenAccRentEntry[];
  embeddedPoolFeesByHop: EmbeddedPoolFeeEntry[];
  walletSolTransfers: WalletFeeTransferEntry[];
  tokenFeeCredits: TokenFeeCreditEntry[];
  networkFeeLamports: bigint;
  inferredPoolAddressesByHop: InferredHopPoolEntry[];
  walletTokenAccountCloses: WalletTokenAccountCloseEntry[];
}

const EMPTY_ROUTE_SIMULATION: RouteSimulationBundle = {
  simulatedOutRaw: null,
  simulationErr: null,
  walletPayDebitRaw: null,
  pdaRentLamports: 0n,
  tokenAccRentByMint: [],
  embeddedPoolFeesByHop: [],
  walletSolTransfers: [],
  tokenFeeCredits: [],
  networkFeeLamports: 0n,
  inferredPoolAddressesByHop: [],
  walletTokenAccountCloses: [],
};

async function simulateRouteBuild(
  build: VybeSwapBuildResponse,
  params: VybeQuoteParams,
  vybeInputMint: string,
  vybeOutputMint: string,
  uiInputMint: string,
  poolAddress?: string,
): Promise<RouteSimulationBundle> {
  const empty: RouteSimulationBundle = { ...EMPTY_ROUTE_SIMULATION };
  const buildTx = build.tx ?? build.transaction;
  if (typeof buildTx !== 'string' || buildTx.length === 0) return empty;

  const preSimRoutePlan: VybeRoutePlanStep[] = [
    {
      percent: 100,
      bps: null,
      swapInfo: {
        ammKey: poolAddress?.trim() || '',
        label: build.provider ?? build.details.quote.provider ?? 'Vybe',
        inputMintAddress: vybeInputMint,
        outputMintAddress: vybeOutputMint,
        inAmount: build.details.quote.inAmount,
        outAmount: build.details.quote.outAmount,
        feeAmount: sumProtocolFeeAmountRaw(build.details.quote),
        feeMintAddress:
          build.details.quote.protocolFees?.[0]?.mint ??
          build.details.quote.feeMint ??
          vybeInputMint,
      },
    },
  ];
  const sim = await simulateSwapEffects(
    buildTx,
    params.accountAddress,
    vybeOutputMint,
    uiInputMint,
    preSimRoutePlan,
    { pinnedPoolAddress: poolAddress },
  );
  let walletTokenAccountCloses = mergeBuildAtaCloseHints(
    sim.walletTokenAccountCloses,
    build.details as unknown as Record<string, unknown>,
    uiInputMint,
  );
  return {
    simulatedOutRaw: sim.outputDeltaRaw,
    simulationErr: sim.simulationErr,
    walletPayDebitRaw: sim.walletPayDebitRaw,
    pdaRentLamports: sim.pdaRentLamports,
    tokenAccRentByMint: sim.tokenAccRentByMint,
    embeddedPoolFeesByHop: sim.embeddedPoolFeesByHop,
    walletSolTransfers: sim.walletSolTransfers,
    tokenFeeCredits: sim.tokenFeeCredits,
    networkFeeLamports: sim.networkFeeLamports,
    inferredPoolAddressesByHop: sim.inferredPoolAddressesByHop,
    walletTokenAccountCloses,
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
    marketsSnapshotFetched: routed.marketsSnapshotFetched,
    marketsSnapshotEligible: routed.marketsSnapshotEligible,
    marketsSnapshotSource: routed.marketsSnapshotSource,
    rpcPoolsScanned: routed.rpcPoolsScanned,
    marketFetchMode,
    enumerateRoutes,
    tradesUnavailable: routed.tradesUnavailable === true,
  };
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
  params: VybeQuoteParams,
  vybeParams: VybeQuoteParams,
  inputStats: TokenPriceStats,
  outputStats: TokenPriceStats,
  vybeInputMint: string,
  vybeOutputMint: string,
  uiInputMint: string,
  uiOutputMint: string,
  selectedRouter: SwapProxyRouter,
): Promise<RouteViaTradesRouteEntry[]> {
  const routes: RouteViaTradesRouteEntry[] = [];
  for (let i = 0; i < routeBuilds.length; i++) {
    const entry = routeBuilds[i]!;
    const simBundle = entry.simulation
      ? {
          simulatedOutRaw: entry.simulation.outputDeltaRaw,
          simulationErr: entry.simulation.simulationErr,
          walletPayDebitRaw: entry.simulation.walletPayDebitRaw,
          pdaRentLamports: entry.simulation.pdaRentLamports,
          tokenAccRentByMint: entry.simulation.tokenAccRentByMint,
          embeddedPoolFeesByHop: entry.simulation.embeddedPoolFeesByHop,
          walletSolTransfers: entry.simulation.walletSolTransfers,
          tokenFeeCredits: entry.simulation.tokenFeeCredits,
          networkFeeLamports: entry.simulation.networkFeeLamports,
          inferredPoolAddressesByHop: entry.simulation.inferredPoolAddressesByHop,
          walletTokenAccountCloses: entry.simulation.walletTokenAccountCloses,
        }
      : i === 0
        ? await simulateRouteBuild(
            entry.build,
            params,
            vybeInputMint,
            vybeOutputMint,
            uiInputMint,
            entry.selected.marketAddress,
          )
        : EMPTY_ROUTE_SIMULATION;
    const sim = simBundle;
    let quote = attachRouterMetadata(
      synthesizeQuoteFromBuild(
        vybeParams,
        entry.build,
        vybeInputMint,
        vybeOutputMint,
        inputStats,
        outputStats,
        sim.simulatedOutRaw ?? undefined,
        {
          pdaRentLamports: sim.pdaRentLamports,
          tokenAccRentByMint: sim.tokenAccRentByMint,
          embeddedPoolFeesByHop: sim.embeddedPoolFeesByHop,
          walletSolTransfers: sim.walletSolTransfers,
          tokenFeeCredits: sim.tokenFeeCredits,
          router: 'vybe',
          walletPayDebitRaw: sim.walletPayDebitRaw,
          networkFeeLamports: sim.networkFeeLamports,
          inferredPoolAddressesByHop: sim.inferredPoolAddressesByHop,
          walletTokenAccountCloses: sim.walletTokenAccountCloses,
        },
      ),
      selectedRouter,
      'vybe',
      false,
    );
    if (uiInputMint === NATIVE_SOL_MINT) quote = { ...quote, inputMintAddress: NATIVE_SOL_MINT };
    if (uiOutputMint === NATIVE_SOL_MINT) quote = { ...quote, outputMintAddress: NATIVE_SOL_MINT };
    if (sim.simulationErr != null) quote = { ...quote, _simulationErr: sim.simulationErr };
    const candidate = entry.candidate as EnumeratedRouteCandidate;
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
      simulatedOutRaw: sim.simulatedOutRaw ?? undefined,
    });
  }
  return sortRouteEntriesByOutput(routes);
}

export interface EnrichVybeRouteQuoteParams {
  accountAddress: string;
  amount: number;
  inputMintAddress: string;
  outputMintAddress: string;
  poolAddress: string;
  build: VybeSwapBuildResponse;
  tokenHints?: Record<string, TokenPriceHint>;
  router?: SwapProxyRouter;
}

/** Full simulate + fee enrichment for one enumerated route (background route #2…#6). */
export async function enrichVybeEnumeratedRouteQuote(
  http: AxiosInstance,
  params: EnrichVybeRouteQuoteParams,
): Promise<VybeSwapQuote> {
  const uiInputMint = params.inputMintAddress.trim();
  const uiOutputMint = params.outputMintAddress.trim();
  const vybeInputMint = toVybeSwapMint(uiInputMint);
  const vybeOutputMint = toVybeSwapMint(uiOutputMint);
  const selected = normalizeRouterId(params.router ?? 'vybe') as SwapProxyRouter;

  const hints = { ...params.tokenHints };
  if (uiInputMint === NATIVE_SOL_MINT && hints[vybeInputMint] && !hints[uiInputMint]) {
    hints[uiInputMint] = hints[vybeInputMint];
  }
  if (uiOutputMint === NATIVE_SOL_MINT && hints[vybeOutputMint] && !hints[uiOutputMint]) {
    hints[uiOutputMint] = hints[vybeOutputMint];
  }

  const { stats: rawStats } = await resolveTokenPrices(http, [vybeInputMint, uiOutputMint], {
    tokenHints: hints,
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
    accountAddress: params.accountAddress,
    amount: params.amount,
    inputMintAddress: vybeInputMint,
    outputMintAddress: vybeOutputMint,
    router: 'vybe',
    poolAddress: params.poolAddress.trim(),
  };

  const sim = await simulateRouteBuild(
    params.build,
    vybeParams,
    vybeInputMint,
    vybeOutputMint,
    uiInputMint,
    params.poolAddress,
  );

  let quote = attachRouterMetadata(
    synthesizeQuoteFromBuild(
      vybeParams,
      params.build,
      vybeInputMint,
      vybeOutputMint,
      inputStats,
      outputStats,
      sim.simulatedOutRaw ?? undefined,
      {
        pdaRentLamports: sim.pdaRentLamports,
        tokenAccRentByMint: sim.tokenAccRentByMint,
        embeddedPoolFeesByHop: sim.embeddedPoolFeesByHop,
        walletSolTransfers: sim.walletSolTransfers,
        tokenFeeCredits: sim.tokenFeeCredits,
        router: 'vybe',
        walletPayDebitRaw: sim.walletPayDebitRaw,
        networkFeeLamports: sim.networkFeeLamports,
        inferredPoolAddressesByHop: sim.inferredPoolAddressesByHop,
        walletTokenAccountCloses: sim.walletTokenAccountCloses,
      },
    ),
    selected,
    'vybe',
    false,
  );
  if (uiInputMint === NATIVE_SOL_MINT) quote = { ...quote, inputMintAddress: NATIVE_SOL_MINT };
  if (uiOutputMint === NATIVE_SOL_MINT) quote = { ...quote, outputMintAddress: NATIVE_SOL_MINT };
  if (sim.simulationErr != null) quote = { ...quote, _simulationErr: sim.simulationErr };
  return quote;
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
  const manualPool = params.poolAddress?.trim();
  const manualProgram = params.programAddress?.trim();
  const useMarketDiscovery =
    isMarketDiscoveryEnabled(params) &&
    selected === 'vybe' &&
    params.protocol == null &&
    !params.poolAddress?.trim() &&
    !params.programAddress?.trim();
  const marketFetchMode = resolveMarketFetchMode(params);
  const enumerateRoutes = params.enumerateRoutes === true;
  const bothCommonQuotes = isCommonQuotePair(uiInputMint, uiOutputMint);
  const useTradeCandidatePin = useMarketDiscovery && Boolean(manualPool && manualProgram);
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
      const routed = await buildSwapViaRpcPools(http, { ...vybeParams, router: 'vybe' });
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
            params,
            vybeParams,
            inputStats,
            outputStats,
            vybeInputMint,
            vybeOutputMint,
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
            selected: routed.selected,
            ...baseRouteViaTradesMetaFromRouted(routed, marketFetchMode, false),
          };
        }
        logRouteViaTradesMeta(routeViaTrades);
      } else {
        const recovery = await recoverAfterTradeQueueExhausted(http, vybeParams, routed, {
          allowRpcFallback: false,
        });
        build = recovery.build;
        routeViaTrades = recovery.routeViaTrades;
      }
    } else {
      build = await buildSwap(http, {
        ...vybeParams,
        router: 'vybe',
        marketFetchMode: undefined,
        enumerateRoutes: undefined,
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
  } else if (useTradeCandidatePin || useDiscoveryFetch) {
    const routed = useTradeCandidatePin
      ? await buildSwapForTradeCandidate(http, { ...vybeParams, router: 'vybe' }, {
          marketAddress: manualPool!,
          programAddress: manualProgram!,
        })
      : await buildSwapViaTradeMarkets(http, { ...vybeParams, router: 'vybe' });
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
          params,
          vybeParams,
          inputStats,
          outputStats,
          vybeInputMint,
          vybeOutputMint,
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
      const recovery = await recoverAfterTradeQueueExhausted(http, vybeParams, routed, {
        allowRpcFallback: marketFetchMode === 'full' && !bothCommonQuotes && !enumerateRoutes,
      });
      build = recovery.build;
      routeViaTrades = recovery.routeViaTrades;
    }
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
  const buildTx = build.tx ?? build.transaction;
  let simulatedOutRaw: string | null = null;
  let simulationErr: unknown = null;
  let walletPayDebitRaw: string | null = null;
  let pdaRentLamports = 0n;
  let tokenAccRentByMint: TokenAccRentEntry[] = [];
  let embeddedPoolFeesByHop: EmbeddedPoolFeeEntry[] = [];
  let walletSolTransfers: WalletFeeTransferEntry[] = [];
  let tokenFeeCredits: TokenFeeCreditEntry[] = [];
  let networkFeeLamports = 0n;
  let inferredPoolAddressesByHop: InferredHopPoolEntry[] = [];
  let walletTokenAccountCloses: WalletTokenAccountCloseEntry[] = [];
  const preSimRoutePlan: VybeRoutePlanStep[] = [
    {
      percent: 100,
      bps: null,
      swapInfo: {
        ammKey:
          (routeViaTrades?.outcome === 'direct' || routeViaTrades?.outcome === 'multi') &&
          routeViaTrades?.selected?.marketAddress
            ? routeViaTrades.selected.marketAddress
            : '',
        label: build.provider ?? build.details.quote.provider ?? 'Vybe',
        inputMintAddress: vybeInputMint,
        outputMintAddress: vybeOutputMint,
        inAmount: build.details.quote.inAmount,
        outAmount: build.details.quote.outAmount,
        feeAmount: sumProtocolFeeAmountRaw(build.details.quote),
        feeMintAddress:
          build.details.quote.protocolFees?.[0]?.mint ??
          build.details.quote.feeMint ??
          vybeInputMint,
      },
    },
  ];
  if (!precomputedPrimaryQuote && typeof buildTx === 'string' && buildTx.length > 0) {
    const sim = await simulateSwapEffects(
      buildTx,
      params.accountAddress,
      vybeOutputMint,
      uiInputMint,
      preSimRoutePlan,
    );
    simulatedOutRaw = sim.outputDeltaRaw;
    simulationErr = sim.simulationErr;
    walletPayDebitRaw = sim.walletPayDebitRaw;
    pdaRentLamports = sim.pdaRentLamports;
    tokenAccRentByMint = sim.tokenAccRentByMint;
    embeddedPoolFeesByHop = sim.embeddedPoolFeesByHop;
    walletSolTransfers = sim.walletSolTransfers;
    tokenFeeCredits = sim.tokenFeeCredits;
    networkFeeLamports = sim.networkFeeLamports;
    inferredPoolAddressesByHop = sim.inferredPoolAddressesByHop;
    walletTokenAccountCloses = sim.walletTokenAccountCloses;
  }
  walletTokenAccountCloses = mergeBuildAtaCloseHints(
    walletTokenAccountCloses,
    build.details as unknown as Record<string, unknown>,
    uiInputMint,
  );

  const tradeRouteFallback = routeViaTrades?.fallbackRouter;
  const effective = tradeRouteFallback
    ? tradeRouteFallback
    : routeViaTrades
      ? 'vybe'
      : normalizeRouterId(build.provider ?? selected);
  const quote = precomputedPrimaryQuote
    ? precomputedPrimaryQuote
    : attachRouterMetadata(
        synthesizeQuoteFromBuild(
          vybeParams,
          build,
          vybeInputMint,
          vybeOutputMint,
          inputStats,
          outputStats,
          simulatedOutRaw ?? undefined,
          {
            pdaRentLamports,
            tokenAccRentByMint,
            embeddedPoolFeesByHop,
            walletSolTransfers,
            tokenFeeCredits,
            router: tradeRouteFallback ?? (routeViaTrades ? 'vybe' : selected),
            walletPayDebitRaw,
            networkFeeLamports,
            inferredPoolAddressesByHop,
            walletTokenAccountCloses,
          },
        ),
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
  if (!precomputedPrimaryQuote && simulationErr != null) {
    finalQuote = { ...finalQuote, _simulationErr: simulationErr };
  }
  return {
    quote: finalQuote,
    build,
    builtAt: Date.now(),
    tokenStats,
    routeViaTrades,
  };
}
