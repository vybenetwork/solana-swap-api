/**
 * Project ix-builder's print-ready `enrichment` onto the VybeSwapQuote shape the
 * rest of swap-api and the browser already read. No simulation or fee/% math here —
 * ix-builder is the single source of truth; this is a pure field mapping.
 */

import type { VybeSwapBuildResponse, VybeSwapQuote, VybeRoutePlanStep } from '../types/swap.js';
import type { SwapEnrichment } from '../types/enrichment.js';
import { preferNativeSolMint } from './sol-mints.js';

export function buildHasEnrichment(
  build: VybeSwapBuildResponse | undefined | null,
): build is VybeSwapBuildResponse & { enrichment: SwapEnrichment } {
  return Boolean(build && typeof build === 'object' && build.enrichment && typeof build.enrichment === 'object');
}

interface MapEnrichmentOpts {
  uiInputMint?: string;
  uiOutputMint?: string;
}

function rawToUi(raw: string | null | undefined, decimals: number): number {
  if (!raw) return 0;
  try {
    const r = BigInt(String(raw).trim());
    const d = Math.max(0, decimals || 0);
    if (d === 0) return Number(r);
    const base = 10n ** BigInt(d);
    return Number(r / base) + Number(r % base) / Number(base);
  } catch {
    return 0;
  }
}

/** Build a VybeSwapQuote from ix-builder enrichment (the happy path). */
export function mapEnrichmentToQuote(
  build: VybeSwapBuildResponse & { enrichment: SwapEnrichment },
  opts?: MapEnrichmentOpts,
): VybeSwapQuote {
  const e = build.enrichment;
  const routePlan: VybeRoutePlanStep[] = (e.routePlan ?? []).map((step) => {
    const s: Record<string, unknown> = {
      percent: step.percent ?? 100,
      bps: step.bps ?? null,
      swapInfo: step.swapInfo,
      _retentionInPct: step.retentionInPct,
      _retentionOutPct: step.retentionOutPct,
      _outgoingPct: step.outgoingPct,
      _inUsd: step.inUsd,
      _outUsd: step.outUsd,
      _netOutRaw: step.netOutRaw,
      _grossOutRaw: step.grossOutRaw,
    };
    if (step.hopFees) s._hopFees = step.hopFees;
    return s as unknown as VybeRoutePlanStep;
  });

  const quote: VybeSwapQuote = {
    inputMintAddress: opts?.uiInputMint ?? e.inputMintAddress,
    inAmount: String(e.inAmountRaw ?? ''),
    outputMintAddress: opts?.uiOutputMint ?? e.outputMintAddress,
    outAmount: String(e.outAmountRaw ?? ''),
    otherAmountThreshold: String(e.otherAmountThresholdRaw ?? ''),
    swapMode: e.swapMode ?? 'ExactIn',
    priceImpactPct: String(e.priceImpactPct ?? '0'),
    routePlan,
    outAmountUi: Number(e.outAmountUi ?? 0),
    otherAmountThresholdUi: Number(e.otherAmountThresholdUi ?? 0),
    swapRate: Number(e.swapRate ?? 0),
    slippageBps: e.slippageBps ?? null,
    swapUsdValue: e.swapUsdValue ?? null,
    _quoteSource: 'ix-builder-enrichment',
    _inputPriceUsd: e.inputPriceUsd,
    _outputPriceUsd: e.outputPriceUsd,
    _buildRouter: build.provider,
    _quotedOutAmount: e.quotedOutRaw,
    _outputFromSimulation: e.outputFromSimulation,
    _swapFee: e.swapFeeRaw,
    _swapFeePct: e.swapFeePct,
    _totalFeeRaw: e.totalFeeRaw,
    _simulatedOutAmount: e.simulatedOutRaw,
    _walletPayDebitRaw: e.walletPayDebitRaw,
    _walletTokenAccountCloses: e.walletTokenAccountCloses ?? [],
    _youPay: e.youPay,
    _youReceive: e.youReceive,
    _maxSlippagePct: e.maxSlippagePct,
    _tokens: e.tokens,
    _accountsCreated: e.accountsCreated,
    _ataRentLamportsTotal: e.ataRentLamportsTotal,
    _networkFeeLamports: e.networkFeeLamports,
    _simulated: e.simulated,
    _simulationOutputWarning: e.simulationOutputWarning ?? null,
  };
  if (e.simulated?.err != null) quote._simulationErr = e.simulated.err;
  return quote;
}

/** Degraded quote when enrichment is absent (e.g. pre-deploy remote Vybe). No fees/sim/USD. */
export function basicQuoteFromBuild(
  build: VybeSwapBuildResponse,
  opts?: MapEnrichmentOpts,
): VybeSwapQuote {
  const d = build.details;
  const inAmount = String(d.quote.inAmount ?? '');
  const outAmount = String(d.quote.outAmount ?? '');
  const outDec = Number(d.outputDecimals ?? 9);
  const inputMint = opts?.uiInputMint ?? preferNativeSolMint(d.inputMintAddress);
  const outputMint = opts?.uiOutputMint ?? preferNativeSolMint(d.outputMintAddress);
  return {
    inputMintAddress: inputMint,
    inAmount,
    outputMintAddress: outputMint,
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: 'ExactIn',
    priceImpactPct: '0',
    routePlan: [
      {
        percent: 100,
        bps: null,
        swapInfo: {
          ammKey: build.provider ?? 'vybe',
          label: d.quote.provider ?? build.provider ?? 'Vybe',
          inputMintAddress: inputMint,
          outputMintAddress: outputMint,
          inAmount,
          outAmount,
          feeAmount: '0',
          feeMintAddress: inputMint,
        },
      },
    ],
    outAmountUi: rawToUi(outAmount, outDec),
    otherAmountThresholdUi: rawToUi(outAmount, outDec),
    swapRate: 0,
    slippageBps: Math.round((build.slippage ?? 5) * 100),
    swapUsdValue: null,
    _quoteSource: 'ix-builder-build-basic',
    _buildRouter: build.provider,
    _quotedOutAmount: outAmount,
  };
}

/** Single entry point: enrichment when present, else a degraded build-only quote. */
export function quoteFromBuild(build: VybeSwapBuildResponse, opts?: MapEnrichmentOpts): VybeSwapQuote {
  return buildHasEnrichment(build) ? mapEnrichmentToQuote(build, opts) : basicQuoteFromBuild(build, opts);
}
