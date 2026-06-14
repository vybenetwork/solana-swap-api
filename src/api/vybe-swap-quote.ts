/**
 * Vybe router quote: resolve token prices, build swap, synthesize quote-shaped response.
 */

import type { AxiosInstance } from 'axios';
import { completePinnedSwapParams } from './pinned-swap-params.js';
import { enrichBuildParamsWithAtaHints } from './wallet-ata-hints.js';
import { buildSwap, buildSwapWithFallback, type BuildSwapParams, type SwapProxyRouter } from './swap-build.js';
import {
  buildSwapForTradeCandidate,
  buildSwapViaTradeMarkets,
  formatRouteViaTradesServerLog,
  isAggregatorSwapProvider,
  normalizeBuildErrorMessage,
  ROUTE_VIA_TRADES_LIMIT,
  TRADES_API_UNAVAILABLE_MESSAGE,
  type QueuedMarketEntry,
  type RankedTradeMarket,
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
import { enrichRoutePlanFees } from './enrich-route-fees.js';
import { DEFAULT_SWAP_SLIPPAGE_PCT } from '../config.js';
import { NATIVE_SOL_MINT, toVybeSwapMint } from './sol-mints.js';

/** Wrapped SOL mint — Vybe TokenInformationCH symbol is `wSOL` for this address. */
export { WSOL_MINT } from './sol-mints.js';

export interface VybeQuoteParams extends BuildSwapParams {
  tokenHints?: Record<string, TokenPriceHint>;
  forceFullDetailsMints?: string[];
}

export type RouteViaTradesOutcome =
  | 'direct'
  | 'unpinned_vybe'
  | 'titan_fallback'
  | 'jupiter_fallback'
  | 'skipped'
  | 'failed';

export type RouteViaTradesDisabledReason =
  | 'toggle_off'
  | 'manual_pool'
  | 'manual_protocol'
  | 'router_not_vybe';

export interface RouteViaTradesRecoveryLogEntry {
  step: 'unpinned_vybe' | 'titan' | 'jupiter';
  success: boolean;
  provider?: string;
  error?: string;
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
  if (params.routeViaTrades !== true) disabledReason = 'toggle_off';
  else if (selected !== 'vybe') disabledReason = 'router_not_vybe';
  else if (params.poolAddress?.trim() || params.programAddress?.trim()) disabledReason = 'manual_pool';
  else if (params.protocol != null) disabledReason = 'manual_protocol';
  else disabledReason = 'toggle_off';

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
): Promise<{ build: VybeSwapBuildResponse; routeViaTrades: RouteViaTradesMeta }> {
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
    userMessage: routed.tradesUnavailable ? TRADES_API_UNAVAILABLE_MESSAGE : undefined,
  };

  const unpinnedParams: VybeQuoteParams = {
    ...vybeParams,
    router: 'vybe',
    poolAddress: undefined,
    programAddress: undefined,
    protocol: undefined,
    routeViaTrades: false,
  };

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
          : 'Pinned trade routes failed — using Vybe auto-route.',
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

  const aggregatorParams: VybeQuoteParams = {
    ...vybeParams,
    poolAddress: undefined,
    programAddress: undefined,
    protocol: undefined,
    routeViaTrades: false,
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
        feeAmount: '0',
        feeMintAddress: inputMint,
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
  const useRouteViaTrades =
    params.routeViaTrades === true &&
    selected === 'vybe' &&
    params.protocol == null &&
    !params.poolAddress?.trim() &&
    !params.programAddress?.trim();
  const useTradeCandidatePin = useRouteViaTrades && Boolean(manualPool && manualProgram);
  const useTradeFetch = useRouteViaTrades && !manualPool;

  let build: VybeSwapBuildResponse;
  let routeViaTrades: RouteViaTradesMeta | undefined;
  if (useTradeCandidatePin || useTradeFetch) {
    const routed = useTradeCandidatePin
      ? await buildSwapForTradeCandidate(http, { ...vybeParams, router: 'vybe' }, {
          marketAddress: manualPool!,
          programAddress: manualProgram!,
        })
      : await buildSwapViaTradeMarkets(http, { ...vybeParams, router: 'vybe' });
    if (routed.kind === 'direct') {
      build = routed.build;
      Object.assign(
        vybeParams,
        completePinnedSwapParams({
          poolAddress: routed.selected.marketAddress,
          programAddress: routed.selected.programAddress,
          protocol: routed.selected.protocol,
        }),
      );
      routeViaTrades = {
        enabled: true,
        outcome: 'direct',
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
      };
      logRouteViaTradesMeta(routeViaTrades);
    } else {
      const recovery = await recoverAfterTradeQueueExhausted(http, vybeParams, routed);
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
          routeViaTrades?.outcome === 'direct' && routeViaTrades?.selected?.marketAddress
            ? routeViaTrades.selected.marketAddress
            : '',
        label: build.provider ?? build.details.quote.provider ?? 'Vybe',
        inputMintAddress: vybeInputMint,
        outputMintAddress: vybeOutputMint,
        inAmount: build.details.quote.inAmount,
        outAmount: build.details.quote.outAmount,
        feeAmount: '0',
        feeMintAddress: vybeInputMint,
      },
    },
  ];
  if (typeof buildTx === 'string' && buildTx.length > 0) {
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
  const quote = attachRouterMetadata(
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
  if (uiInputMint === NATIVE_SOL_MINT) {
    quote.inputMintAddress = NATIVE_SOL_MINT;
  }
  if (uiOutputMint === NATIVE_SOL_MINT) {
    quote.outputMintAddress = NATIVE_SOL_MINT;
  }
  if (simulationErr != null) {
    quote._simulationErr = simulationErr;
  }
  return {
    quote,
    build,
    builtAt: Date.now(),
    tokenStats,
    routeViaTrades,
  };
}
