/**
 * Attach per-hop fee breakdown when a swap tx is built/simulated.
 * Vybe returns swapFee as a fraction (0.01 = 1%); Jupiter/Titan often use whole percent (1 = 1%).
 */

import type { VybeRoutePlanStep, VybeSwapBuildResponse } from '../types/swap.js';

export interface HopFeeItem {
  label: string;
  amountRaw: string;
  mint: string;
}

export interface HopFeeBreakdown {
  items: HopFeeItem[];
  totalAmountRaw: string;
  mint: string;
  quotedOutRaw?: string;
  netOutRaw?: string;
}

export type RoutePlanStepWithFees = VybeRoutePlanStep & { _hopFees?: HopFeeBreakdown };

export interface RouteFeeEnrichment {
  routePlan: RoutePlanStepWithFees[];
  quotedOutRaw: string;
  simulatedOutRaw: string | null;
  totalFeeRaw: string | null;
  swapFeePct: number | null;
  swapFeeRaw: number | null;
  outputFromSimulation: boolean;
}

export function normalizeSwapFeePct(swapFee: number | undefined | null): number | null {
  if (swapFee == null || !Number.isFinite(swapFee) || swapFee <= 0) return null;
  if (swapFee <= 1) return swapFee * 100;
  if (swapFee <= 100) return swapFee;
  return null;
}

function pctFeeRaw(amount: bigint, pct: number): bigint {
  if (pct <= 0 || amount <= 0n) return 0n;
  return (amount * BigInt(Math.round(pct * 100))) / 10000n;
}

function cloneRoutePlan(routePlan: VybeRoutePlanStep[]): VybeRoutePlanStep[] {
  return routePlan.map((step) => ({
    ...step,
    swapInfo: { ...step.swapInfo },
  }));
}

function hopQuotedOutRaw(step: VybeRoutePlanStep, fallback: bigint): bigint {
  const raw = step.swapInfo?.outAmount?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  try {
    return BigInt(raw);
  } catch {
    return fallback;
  }
}

function sumFeeItems(items: HopFeeItem[]): bigint {
  return items.reduce((sum, item) => {
    try {
      return sum + BigInt(item.amountRaw);
    } catch {
      return sum;
    }
  }, 0n);
}

function applyHopFees(
  step: VybeRoutePlanStep,
  items: HopFeeItem[],
  opts: { quotedOutRaw?: string; netOutRaw?: string },
): RoutePlanStepWithFees {
  const enriched = step as RoutePlanStepWithFees;
  if (items.length === 0) {
    delete enriched._hopFees;
    return enriched;
  }
  const total = sumFeeItems(items);
  const mint = items[items.length - 1]!.mint;
  enriched._hopFees = {
    items,
    totalAmountRaw: total.toString(),
    mint,
    quotedOutRaw: opts.quotedOutRaw,
    netOutRaw: opts.netOutRaw,
  };
  enriched.swapInfo = {
    ...enriched.swapInfo,
    feeAmount: total.toString(),
    feeMintAddress: mint,
  };
  return enriched;
}

/**
 * Enrich route-plan hops with protocol/route/pool fees using build quote + optional simulation.
 */
export function enrichRoutePlanFees(
  routePlan: VybeRoutePlanStep[],
  build: VybeSwapBuildResponse,
  simulatedOutRaw: string | null,
  outputMint: string,
): RouteFeeEnrichment {
  const quotedOutRaw = build.details.quote.outAmount?.trim() || '0';
  let quotedOut = 0n;
  try {
    quotedOut = BigInt(quotedOutRaw);
  } catch {
    quotedOut = 0n;
  }

  let simulatedOut: bigint | null = null;
  if (simulatedOutRaw) {
    try {
      simulatedOut = BigInt(simulatedOutRaw);
    } catch {
      simulatedOut = null;
    }
  }

  const totalFeeRaw =
    simulatedOut != null && quotedOut > simulatedOut ? (quotedOut - simulatedOut).toString() : null;
  const swapFeePct = normalizeSwapFeePct(build.details.swapFee);
  const protocolFeeOnQuote = swapFeePct != null ? pctFeeRaw(quotedOut, swapFeePct) : 0n;

  const basePlan = routePlan.length > 0 ? cloneRoutePlan(routePlan) : cloneRoutePlan([]);
  if (basePlan.length === 0) {
    const inMint = build.details.inputMintAddress;
    const outMint = build.details.outputMintAddress || outputMint;
    basePlan.push({
      percent: 100,
      bps: null,
      swapInfo: {
        ammKey: build.provider ?? 'swap',
        label: build.details.quote.provider ?? build.provider ?? 'Swap',
        inputMintAddress: inMint,
        outputMintAddress: outMint,
        inAmount: build.details.quote.inAmount,
        outAmount: quotedOutRaw,
        feeAmount: '0',
        feeMintAddress: inMint,
      },
    });
  }

  const lastIdx = basePlan.length - 1;
  const enrichedPlan: RoutePlanStepWithFees[] = [];

  for (let i = 0; i < basePlan.length; i++) {
    const step = basePlan[i]!;
    const si = step.swapInfo;
    const items: HopFeeItem[] = [];
    const isLast = i === lastIdx;

    if (si.feeAmount && si.feeAmount !== '0') {
      items.push({
        label: 'Pool fee',
        amountRaw: si.feeAmount,
        mint: si.feeMintAddress || si.outputMintAddress || outputMint,
      });
    }

    if (isLast) {
      const hopQuotedOut = hopQuotedOutRaw(step, quotedOut);
      const hopProtocolFee = swapFeePct != null ? pctFeeRaw(hopQuotedOut, swapFeePct) : 0n;

      if (hopProtocolFee > 0n) {
        const hasProtocol = items.some((it) => it.label === 'Protocol fee');
        if (!hasProtocol) {
          items.push({
            label: 'Protocol fee',
            amountRaw: hopProtocolFee.toString(),
            mint: si.outputMintAddress || outputMint,
          });
        }
      }

      if (totalFeeRaw != null) {
        const totalFee = BigInt(totalFeeRaw);
        const accounted = sumFeeItems(items);
        const routeExtra = totalFee > accounted ? totalFee - accounted : 0n;
        if (routeExtra > 0n) {
          items.push({
            label: 'Route fee',
            amountRaw: routeExtra.toString(),
            mint: si.outputMintAddress || outputMint,
          });
        }
      } else if (items.length === 0 && protocolFeeOnQuote > 0n) {
        items.push({
          label: 'Protocol fee',
          amountRaw: protocolFeeOnQuote.toString(),
          mint: si.outputMintAddress || outputMint,
        });
      }

      const hopQuotedStr = hopQuotedOut.toString();
      const netStr = simulatedOut != null ? simulatedOut.toString() : undefined;
      if (isLast && si.outAmount !== hopQuotedStr) {
        si.outAmount = hopQuotedStr;
      }
      enrichedPlan.push(
        applyHopFees(step, items, {
          quotedOutRaw: hopQuotedStr,
          netOutRaw: netStr,
        }),
      );
      continue;
    }

    enrichedPlan.push(applyHopFees(step, items, {}));
  }

  return {
    routePlan: enrichedPlan,
    quotedOutRaw,
    simulatedOutRaw,
    totalFeeRaw,
    swapFeePct,
    swapFeeRaw: build.details.swapFee ?? null,
    outputFromSimulation: simulatedOut != null && simulatedOut !== quotedOut,
  };
}
