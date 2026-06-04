/**
 * Vybe router quote: resolve token prices, build swap, synthesize quote-shaped response.
 */

import type { AxiosInstance } from 'axios';
import { buildSwapWithFallback, type BuildSwapParams } from './swap-build.js';
import { getSwapQuote } from './swap-quote.js';
import {
  resolveTokenPrices,
  type TokenPriceHint,
  type TokenPriceStats,
} from './resolve-token-prices.js';
import type { VybeSwapQuote, VybeSwapBuildResponse, VybeRoutePlanStep } from '../types/swap.js';

/** Wrapped SOL mint — Vybe TokenInformationCH symbol is `wSOL` for this address. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

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

function quoteFromAggregatorResponse(
  raw: Record<string, unknown>,
  inputMint: string,
  outputMint: string,
  tokenStats: Record<string, TokenPriceStats>,
  amount: number,
): VybeSwapQuote {
  const inputMintAddress = String(raw.inputMintAddress ?? raw.inputMint ?? inputMint);
  const outputMintAddress = String(raw.outputMintAddress ?? raw.outputMint ?? outputMint);
  const outAmountUi = Number(raw.outAmountUi ?? raw.outAmountUI ?? 0);
  const otherAmountThresholdUi = Number(
    raw.otherAmountThresholdUi ?? raw.otherAmountThresholdUI ?? 0,
  );
  const inputStats = tokenStats[inputMintAddress] ?? tokenStats[inputMint];
  const swapUsdValue =
    inputStats?.price != null && Number.isFinite(amount)
      ? (amount * inputStats.price).toFixed(2)
      : (raw.swapUsdValue as string | null | undefined) ?? null;

  return {
    inputMintAddress,
    inAmount: String(raw.inAmount ?? ''),
    outputMintAddress,
    outAmount: String(raw.outAmount ?? ''),
    otherAmountThreshold: String(raw.otherAmountThreshold ?? ''),
    swapMode: String(raw.swapMode ?? 'ExactIn'),
    priceImpactPct: String(raw.priceImpactPct ?? '0'),
    routePlan: normalizeRoutePlan(raw.routePlan),
    outAmountUi,
    otherAmountThresholdUi,
    swapRate: Number(raw.swapRate ?? 0),
    swapUsdValue,
    slippageBps:
      raw.slippageBps != null
        ? Number(raw.slippageBps)
        : raw.slippage != null
          ? Math.round(Number(raw.slippage) * 100)
          : null,
    contextSlot: raw.contextSlot != null ? Number(raw.contextSlot) : null,
    _quoteSource: 'vybe-swap-quote-fallback',
    _inputPriceUsd: inputStats?.price,
    _outputPriceUsd: (tokenStats[outputMintAddress] ?? tokenStats[outputMint])?.price,
  };
}

function synthesizeQuoteFromBuild(
  params: VybeQuoteParams,
  build: VybeSwapBuildResponse,
  inputMint: string,
  outputMint: string,
  inputStats: TokenPriceStats,
  outputStats: TokenPriceStats,
): VybeSwapQuote {
  const inAmount = build.details.quote.inAmount;
  const outAmount = build.details.quote.outAmount;
  const slippagePct = build.slippage ?? params.slippage ?? 0.5;

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

  return {
    inputMintAddress: inputMint,
    inAmount,
    outputMintAddress: outputMint,
    outAmount,
    otherAmountThreshold,
    swapMode: 'ExactIn',
    priceImpactPct,
    routePlan: [
      {
        percent: 100,
        bps: null,
        swapInfo: {
          ammKey: poolKey,
          label: providerLabel,
          inputMintAddress: inputMint,
          outputMintAddress: outputMint,
          inAmount,
          outAmount,
          feeAmount: '0',
          feeMintAddress: inputMint,
        },
      },
    ],
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

export async function buildVybeQuoteFromPriceAndSwap(
  http: AxiosInstance,
  params: VybeQuoteParams,
): Promise<VybeQuoteResult> {
  const inputMint = params.inputMintAddress.trim();
  const outputMint = params.outputMintAddress.trim();

  const { stats: tokenStats } = await resolveTokenPrices(http, [inputMint, outputMint], {
    tokenHints: params.tokenHints,
    forceFullDetailsMints: params.forceFullDetailsMints,
  });

  const inputStats = tokenStats[inputMint];
  const outputStats = tokenStats[outputMint];
  if (!inputStats) {
    throw new Error(`Could not resolve price for input mint ${inputMint}`);
  }
  if (!outputStats) {
    throw new Error(`Could not resolve price for output mint ${outputMint}`);
  }

  try {
    const build = await buildSwapWithFallback(http, { ...params, router: params.router ?? 'vybe' });
    const selected = normalizeRouterId(params.router ?? 'vybe');
    const effective = normalizeRouterId(build.provider ?? selected);
    const quote = attachRouterMetadata(
      synthesizeQuoteFromBuild(params, build, inputMint, outputMint, inputStats, outputStats),
      selected,
      effective,
      effective !== selected,
    );
    return {
      quote,
      build,
      builtAt: Date.now(),
      tokenStats,
    };
  } catch {
    const rawQuote = await getSwapQuote(http, {
      amount: params.amount,
      inputMintAddress: inputMint,
      outputMintAddress: outputMint,
      accountAddress: params.accountAddress,
      slippage: params.slippage,
    });
    const selected = normalizeRouterId(params.router ?? 'vybe');
    const quote = attachRouterMetadata(
      quoteFromAggregatorResponse(
        rawQuote as Record<string, unknown>,
        inputMint,
        outputMint,
        tokenStats,
        params.amount,
      ),
      selected,
      'jupiter',
      true,
    );
    return {
      quote,
      build: null,
      builtAt: 0,
      tokenStats,
    };
  }
}
