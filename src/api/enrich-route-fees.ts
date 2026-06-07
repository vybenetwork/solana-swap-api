/**
 * Attach per-hop fee breakdown when a swap tx is built/simulated.
 * Vybe returns swapFee as a fraction (0.01 = 1%); Jupiter/Titan often use whole percent (1 = 1%).
 */

import type { VybeRoutePlanStep, VybeSwapBuildResponse } from '../types/swap.js';
import type { TokenAccRentEntry, EmbeddedPoolFeeEntry } from './simulate-swap-output.js';
import { WSOL_MINT, isSolMint } from './sol-mints.js';

export interface HopFeeItem {
  label: string;
  amountRaw: string;
  mint: string;
  /** @deprecated Token acc rent is a sibling item; kept for older enriched quotes. */
  pdaRent?: {
    label: string;
    amountRaw: string;
    mint: string;
  };
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
  walletPayDebitRaw: string | null;
}

/** Estimate total input-side wallet debit when simulation omits native preBalances. */
export function estimateWalletPayDebitRaw(
  routePlan: RoutePlanStepWithFees[],
  inAmountRaw: string,
  inputMint: string,
): string | null {
  if (!inAmountRaw || !/^\d+$/.test(inAmountRaw)) return null;
  let total = 0n;
  try {
    total = BigInt(inAmountRaw);
  } catch {
    return null;
  }

  const inputIsSol = isSolMint(inputMint);
  for (const step of routePlan) {
    for (const item of step._hopFees?.items ?? []) {
      if (item.amountRaw && item.amountRaw !== '0') {
        if (inputIsSol && isSolMint(item.mint)) {
          try {
            total += BigInt(item.amountRaw);
          } catch {
            /* skip */
          }
        } else if (item.mint === inputMint.trim()) {
          try {
            total += BigInt(item.amountRaw);
          } catch {
            /* skip */
          }
        }
      }
      if (item.pdaRent?.amountRaw && inputIsSol && isSolMint(item.pdaRent.mint)) {
        try {
          total += BigInt(item.pdaRent.amountRaw);
        } catch {
          /* skip */
        }
      }
    }
  }

  try {
    return total > BigInt(inAmountRaw) ? total.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeSwapFeePct(
  swapFee: number | undefined | null,
  router?: string,
): number | null {
  if (swapFee == null || !Number.isFinite(swapFee) || swapFee <= 0) return null;
  const id = router?.trim().toLowerCase();
  // Vybe uses fraction (0.01 = 1%); Jupiter/Titan use whole percent (1 = 1%).
  if (id === 'jupiter' || id === 'titan') {
    return swapFee <= 100 ? swapFee : null;
  }
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

function attachAggregatorTokenAccRent(items: HopFeeItem[], rentLamports: bigint): void {
  if (rentLamports <= 0n) return;
  items.push({
    label: 'Acc Rent Fee',
    amountRaw: rentLamports.toString(),
    mint: WSOL_MINT,
  });
}

function mintMatches(a: string | undefined, b: string | undefined): boolean {
  const left = a?.trim() ?? '';
  const right = b?.trim() ?? '';
  if (!left || !right) return false;
  return left === right || (isSolMint(left) && isSolMint(right));
}

function findHopIndexForRentMint(plan: VybeRoutePlanStep[], mint: string): number {
  const target = mint.trim();
  if (isSolMint(target)) {
    for (let i = 0; i < plan.length; i++) {
      if (isSolMint(plan[i]!.swapInfo?.inputMintAddress)) return i;
    }
    return 0;
  }
  for (let i = 0; i < plan.length; i++) {
    if (mintMatches(plan[i]!.swapInfo?.outputMintAddress, target)) return i;
  }
  for (let i = 0; i < plan.length; i++) {
    if (mintMatches(plan[i]!.swapInfo?.inputMintAddress, target)) return i;
  }
  return Math.max(0, plan.length - 1);
}

function feeAmountLooksLikeProtocolFee(
  feeAmount: string,
  outAmount: string,
  swapFeePct: number | null,
): boolean {
  if (!feeAmount || feeAmount === '0' || swapFeePct == null) return false;
  try {
    const fee = BigInt(feeAmount);
    const out = BigInt(outAmount);
    const expected = pctFeeRaw(out, swapFeePct);
    if (expected <= 0n || fee <= 0n) return false;
    const diff = fee > expected ? fee - expected : expected - fee;
    return diff <= expected / 100n + 1n;
  } catch {
    return false;
  }
}

function attachFirstHopInputSideFees(
  items: HopFeeItem[],
  inAmountRaw: string,
  inputMint: string,
  walletPayDebitRaw: string | null | undefined,
  swapFeePct: number | null,
  rentLamports: bigint,
): void {
  if (!walletPayDebitRaw || !inAmountRaw || !inputMint.trim()) return;
  let pay: bigint;
  let swap: bigint;
  try {
    pay = BigInt(walletPayDebitRaw);
    swap = BigInt(inAmountRaw);
  } catch {
    return;
  }
  if (pay <= swap) return;

  let extra = pay - swap;
  if (rentLamports > 0n && extra >= rentLamports) extra -= rentLamports;
  if (extra <= 0n) return;

  const feeMint = isSolMint(inputMint) ? WSOL_MINT : inputMint.trim();
  const protocolOnInput = swapFeePct != null ? pctFeeRaw(swap, swapFeePct) : 0n;
  if (protocolOnInput > 0n && protocolOnInput <= extra) {
    items.push({
      label: 'Protocol fee',
      amountRaw: protocolOnInput.toString(),
      mint: feeMint,
    });
    extra -= protocolOnInput;
  }
  if (extra > 0n) {
    items.push({
      label: 'Route fee',
      amountRaw: extra.toString(),
      mint: feeMint,
    });
  }
}

function buildEmbeddedPoolFeeByHopIndex(
  entries: EmbeddedPoolFeeEntry[] | undefined,
): Map<number, { amountRaw: bigint; mint: string }> {
  const byHop = new Map<number, { amountRaw: bigint; mint: string }>();
  for (const entry of entries ?? []) {
    if (!entry.amountRaw || !/^\d+$/.test(entry.amountRaw)) continue;
    try {
      const amountRaw = BigInt(entry.amountRaw);
      if (amountRaw <= 0n) continue;
      byHop.set(entry.hopIndex, { amountRaw, mint: entry.mint.trim() });
    } catch {
      /* skip */
    }
  }
  return byHop;
}

function inferInterHopFeeRaw(
  step: VybeRoutePlanStep,
  nextStep: VybeRoutePlanStep | undefined,
): { amountRaw: bigint; mint: string } | null {
  if (!nextStep) return null;
  const outMint = step.swapInfo?.outputMintAddress?.trim();
  const inMint = nextStep.swapInfo?.inputMintAddress?.trim();
  if (!outMint || !inMint || !mintMatches(outMint, inMint)) return null;
  try {
    const outRaw = step.swapInfo?.outAmount?.trim();
    const inRaw = nextStep.swapInfo?.inAmount?.trim();
    if (!outRaw || !/^\d+$/.test(outRaw) || !inRaw || !/^\d+$/.test(inRaw)) return null;
    const out = BigInt(outRaw);
    const inn = BigInt(inRaw);
    if (out > inn && inn > 0n) return { amountRaw: out - inn, mint: outMint };
  } catch {
    /* skip */
  }
  return null;
}

function sumFeesInMint(items: HopFeeItem[], mint: string): bigint {
  return items.reduce((sum, item) => {
    if (item.label === 'Acc Rent Fee') return sum;
    if (!mintMatches(item.mint, mint)) return sum;
    try {
      return sum + BigInt(item.amountRaw);
    } catch {
      return sum;
    }
  }, 0n);
}

function buildRentByHopIndex(
  plan: VybeRoutePlanStep[],
  outputMint: string,
  opts?: { pdaRentLamports?: bigint; tokenAccRentByMint?: TokenAccRentEntry[] },
): Map<number, bigint> {
  const byHop = new Map<number, bigint>();
  const entries = opts?.tokenAccRentByMint ?? [];
  if (entries.length > 0) {
    for (const entry of entries) {
      if (entry.lamports <= 0n) continue;
      const hopIdx = findHopIndexForRentMint(plan, entry.mint);
      byHop.set(hopIdx, (byHop.get(hopIdx) ?? 0n) + entry.lamports);
    }
    return byHop;
  }

  const aggregate = opts?.pdaRentLamports ?? 0n;
  if (aggregate > 0n) {
    const hopIdx = findHopIndexForRentMint(plan, outputMint);
    byHop.set(hopIdx, aggregate);
  }
  return byHop;
}

/**
 * Enrich route-plan hops with protocol/route/pool fees using build quote + optional simulation.
 */
export function enrichRoutePlanFees(
  routePlan: VybeRoutePlanStep[],
  build: VybeSwapBuildResponse,
  simulatedOutRaw: string | null,
  outputMint: string,
  opts?: {
    pdaRentLamports?: bigint;
    tokenAccRentByMint?: TokenAccRentEntry[];
    embeddedPoolFeesByHop?: EmbeddedPoolFeeEntry[];
    router?: string;
    walletPayDebitRaw?: string | null;
    inputMint?: string;
  },
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
  const swapFeePct = normalizeSwapFeePct(build.details.swapFee, opts?.router ?? build.provider);
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

  const inAmountRaw = build.details.quote.inAmount?.trim() || '';
  const inputMint = opts?.inputMint?.trim() || build.details.inputMintAddress?.trim() || '';
  const walletPayDebitRaw = opts?.walletPayDebitRaw ?? null;

  const lastIdx = basePlan.length - 1;
  const rentByHopIdx = buildRentByHopIndex(basePlan, outputMint, opts);
  const embeddedPoolByHop = buildEmbeddedPoolFeeByHopIndex(opts?.embeddedPoolFeesByHop);
  const enrichedPlan: RoutePlanStepWithFees[] = [];

  for (let i = 0; i < basePlan.length; i++) {
    const step = basePlan[i]!;
    const si = step.swapInfo;
    const items: HopFeeItem[] = [];
    const isLast = i === lastIdx;
    const nextStep = isLast ? undefined : basePlan[i + 1];
    const hopRent = rentByHopIdx.get(i) ?? 0n;
    const hopQuotedOutForFee = hopQuotedOutRaw(step, isLast ? quotedOut : 0n);
    const hopProtocolFeeEstimate =
      swapFeePct != null && hopQuotedOutForFee > 0n
        ? pctFeeRaw(hopQuotedOutForFee, swapFeePct)
        : 0n;

    if (si.feeAmount && si.feeAmount !== '0') {
      let skipJupiterFeeAmount = false;
      if (isLast && hopRent > 0n && hopProtocolFeeEstimate > 0n) {
        try {
          const jupiterFee = BigInt(si.feeAmount);
          // Jupiter sometimes bundles output-mint protocol fee + SOL acc rent into feeAmount (SOL mint).
          if (jupiterFee === hopProtocolFeeEstimate + hopRent) skipJupiterFeeAmount = true;
        } catch {
          /* keep feeAmount */
        }
      }

      if (!skipJupiterFeeAmount) {
        const hopOut = si.outAmount?.trim() || (isLast ? quotedOutRaw : '');
        const isProtocol =
          isLast && feeAmountLooksLikeProtocolFee(si.feeAmount, hopOut, swapFeePct);
        items.push({
          label: isProtocol ? 'Protocol fee' : 'Pool fee',
          amountRaw: si.feeAmount,
          mint: si.feeMintAddress || si.outputMintAddress || outputMint,
        });
      }
    }

    if (i === 0 && inputMint) {
      attachFirstHopInputSideFees(
        items,
        inAmountRaw,
        inputMint,
        walletPayDebitRaw,
        swapFeePct,
        rentByHopIdx.get(0) ?? 0n,
      );
    }

    if (!isLast && (!si.feeAmount || si.feeAmount === '0')) {
      const embedded = embeddedPoolByHop.get(i);
      if (embedded && embedded.amountRaw > 0n) {
        const hasPoolInMint = items.some(
          (it) => it.label === 'Pool fee' && mintMatches(it.mint, embedded.mint),
        );
        if (!hasPoolInMint) {
          items.push({
            label: 'Pool fee',
            amountRaw: embedded.amountRaw.toString(),
            mint: embedded.mint,
          });
        }
      }
    }

    const inferred = inferInterHopFeeRaw(step, nextStep);
    if (inferred && inferred.amountRaw > 0n) {
      const hasPoolInMint = items.some(
        (it) => it.label === 'Pool fee' && mintMatches(it.mint, inferred.mint),
      );
      if (!hasPoolInMint) {
        items.push({
          label: 'Pool fee',
          amountRaw: inferred.amountRaw.toString(),
          mint: inferred.mint,
        });
      }
    }

    if (isLast) {
      const hopQuotedOut = hopQuotedOutRaw(step, quotedOut);
      const hopProtocolFee = swapFeePct != null ? pctFeeRaw(hopQuotedOut, swapFeePct) : 0n;
      const hasProtocol = items.some((it) => it.label === 'Protocol fee');

      if (hopProtocolFee > 0n && !hasProtocol) {
        items.push({
          label: 'Protocol fee',
          amountRaw: hopProtocolFee.toString(),
          mint: si.outputMintAddress || outputMint,
        });
      }

      if (totalFeeRaw != null) {
        const totalFee = BigInt(totalFeeRaw);
        const accounted = sumFeeItems(items.filter((it) => it.label !== 'Acc Rent Fee'));
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
    }

    if (items.length === 0 && hopRent > 0n) {
      items.push({
        label: 'Route fee',
        amountRaw: '0',
        mint: WSOL_MINT,
      });
    }
    attachAggregatorTokenAccRent(items, hopRent);

    const hopQuotedOut = hopQuotedOutRaw(step, isLast ? quotedOut : 0n);
    const hopQuotedStr =
      hopQuotedOut > 0n ? hopQuotedOut.toString() : si.outAmount?.trim() || undefined;
    const outMint = si.outputMintAddress || outputMint;
    const feeInOutMint = sumFeesInMint(items, outMint);
    let netOutRaw: string | undefined;
    if (isLast) {
      netOutRaw = simulatedOut != null ? simulatedOut.toString() : undefined;
    } else if (hopQuotedOut > feeInOutMint && feeInOutMint > 0n) {
      netOutRaw = (hopQuotedOut - feeInOutMint).toString();
    }

    if (isLast && hopQuotedStr && si.outAmount !== hopQuotedStr) {
      si.outAmount = hopQuotedStr;
    }

    enrichedPlan.push(
      applyHopFees(step, items, {
        quotedOutRaw: hopQuotedStr,
        netOutRaw,
      }),
    );
  }

  return {
    routePlan: enrichedPlan,
    quotedOutRaw,
    simulatedOutRaw,
    totalFeeRaw,
    swapFeePct,
    swapFeeRaw: build.details.swapFee ?? null,
    outputFromSimulation: simulatedOut != null && simulatedOut !== quotedOut,
    walletPayDebitRaw,
  };
}
