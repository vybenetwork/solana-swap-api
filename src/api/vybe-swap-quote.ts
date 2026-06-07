/**
 * Vybe router quote: resolve token prices, build swap, synthesize quote-shaped response.
 */

import type { AxiosInstance } from 'axios';
import { buildSwap, buildSwapWithFallback, type BuildSwapParams, type SwapProxyRouter } from './swap-build.js';
import {
  resolveTokenPrices,
  type TokenPriceHint,
  type TokenPriceStats,
} from './resolve-token-prices.js';
import type { VybeSwapQuote, VybeSwapBuildResponse, VybeRoutePlanStep } from '../types/swap.js';
import { assertWalletHasSellAmount } from './wallet-balance.js';
import { simulateSwapEffects } from './simulate-swap-output.js';
import { enrichRoutePlanFees } from './enrich-route-fees.js';
import { NATIVE_SOL_MINT, toVybeSwapMint } from './sol-mints.js';

/** Wrapped SOL mint — Vybe TokenInformationCH symbol is `wSOL` for this address. */
export { WSOL_MINT } from './sol-mints.js';

export interface VybeQuoteParams extends BuildSwapParams {
  tokenHints?: Record<string, TokenPriceHint>;
  forceFullDetailsMints?: string[];
}

export interface VybeQuoteResult {
  quote: VybeSwapQuote;
  build: VybeSwapBuildResponse | null;
  builtAt: number;
  tokenStats: Record<string, TokenPriceStats>;
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
  feeOpts?: { pdaRentLamports?: bigint; router?: string; walletPayDebitRaw?: string | null },
): VybeSwapQuote {
  const inAmount = build.details.quote.inAmount;
  const quotedOutAmount = build.details.quote.outAmount;
  const outAmount = effectiveOutAmount ?? quotedOutAmount;
  const slippagePct = build.slippage ?? params.slippage ?? 0.5;
  const outputFromSimulation =
    effectiveOutAmount != null && effectiveOutAmount !== quotedOutAmount;

  const outAmountUi = rawToUi(outAmount, outputStats.decimals);
  const otherAmountThreshold = applySlippageThreshold(outAmount, slippagePct);
  const otherAmountThresholdUi = rawToUi(otherAmountThreshold, outputStats.decimals);
  const swapRate = params.amount > 0 ? outAmountUi / params.amount : 0;

  const spotCrossRate =
    inputStats.price > 0 && outputStats.price > 0 ? inputStats.price / outputStats.price : 0;
  const priceImpactPct = formatImpactPct(spotCrossRate, swapRate);

  const swapUsdValue =
    inputStats.price > 0 && Number.isFinite(params.amount)
      ? (params.amount * inputStats.price).toFixed(2)
      : null;

  const providerLabel = build.provider ?? build.details.quote.provider ?? 'Vybe';
  const poolKey = params.poolAddress?.trim() || 'vybe';

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
      router: feeOpts?.router ?? build.provider ?? params.router,
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
  const vybeInputMint = toVybeSwapMint(uiInputMint);
  const vybeOutputMint = toVybeSwapMint(uiOutputMint);

  const inputSymbolHint = params.tokenHints?.[uiInputMint]?.symbol ?? params.tokenHints?.[vybeInputMint]?.symbol;
  await assertWalletHasSellAmount(
    http,
    params.accountAddress,
    uiInputMint,
    params.amount,
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
    inputMintAddress: vybeInputMint,
    outputMintAddress: vybeOutputMint,
  };
  const selected = normalizeRouterId(params.router ?? 'vybe') as SwapProxyRouter;
  const build =
    selected === 'vybe'
      ? await buildSwapWithFallback(http, { ...vybeParams, router: selected })
      : await buildSwap(http, { ...vybeParams, router: selected });
  const buildTx = build.tx ?? build.transaction;
  let simulatedOutRaw: string | null = null;
  let walletPayDebitRaw: string | null = null;
  let pdaRentLamports = 0n;
  if (typeof buildTx === 'string' && buildTx.length > 0) {
    const sim = await simulateSwapEffects(
      buildTx,
      params.accountAddress,
      vybeOutputMint,
      uiInputMint,
    );
    simulatedOutRaw = sim.outputDeltaRaw;
    walletPayDebitRaw = sim.walletPayDebitRaw;
    pdaRentLamports = sim.pdaRentLamports;
  }
  const effective = normalizeRouterId(build.provider ?? selected);
  const quote = attachRouterMetadata(
    synthesizeQuoteFromBuild(
      vybeParams,
      build,
      vybeInputMint,
      vybeOutputMint,
      inputStats,
      outputStats,
      simulatedOutRaw ?? undefined,
      { pdaRentLamports, router: selected, walletPayDebitRaw },
    ),
    selected,
    effective,
    effective !== selected,
  );
  if (uiInputMint === NATIVE_SOL_MINT) {
    quote.inputMintAddress = NATIVE_SOL_MINT;
  }
  if (uiOutputMint === NATIVE_SOL_MINT) {
    quote.outputMintAddress = NATIVE_SOL_MINT;
  }
  return {
    quote,
    build,
    builtAt: Date.now(),
    tokenStats,
  };
}
