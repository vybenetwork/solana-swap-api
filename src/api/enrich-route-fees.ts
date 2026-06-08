/**
 * Attach per-hop fee breakdown when a swap tx is built/simulated.
 * Vybe returns swapFee as a fraction (0.01 = 1%); Jupiter/Titan often use whole percent (1 = 1%).
 */

import type { VybeRoutePlanStep, VybeSwapBuildResponse } from '../types/swap.js';
import type { TokenAccRentEntry, EmbeddedPoolFeeEntry, WalletFeeTransferEntry, TokenFeeCreditEntry } from './simulate-swap-output.js';
import { WSOL_MINT, isSolMint } from './sol-mints.js';

function isLikelySolanaPubkey(value: string | undefined): boolean {
  const s = value?.trim() ?? '';
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function pickPubkey(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (isLikelySolanaPubkey(candidate)) return candidate!.trim();
  }
  return undefined;
}

export interface HopFeeItem {
  label: string;
  amountRaw: string;
  mint: string;
  destinationAddress?: string;
  destinationKind?: 'lp_pool' | 'new_token_account' | 'fee_recipient' | 'output_deduction' | 'input_wallet' | 'network_priority';
  destinationNote?: string;
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
      if (!isWalletDebitedFeeItem(item, inputMint.trim())) continue;
      if (!item.amountRaw || item.amountRaw === '0') continue;
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
  }

  try {
    return total > BigInt(inAmountRaw) ? total.toString() : null;
  } catch {
    return null;
  }
}

function isWalletDebitedFeeItem(item: HopFeeItem, inputMint: string): boolean {
  const label = item.label.trim().toLowerCase();
  if (label === 'acc rent fee' || label === 'pda rent' || label === 'token acc rent') {
    return isSolMint(inputMint) && isSolMint(item.mint);
  }
  const kind = item.destinationKind;
  if (kind === 'lp_pool' || kind === 'output_deduction' || kind === 'network_priority') {
    return false;
  }
  if (kind === 'fee_recipient' || kind === 'input_wallet' || kind === 'new_token_account') {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint.trim();
  }
  if (label === 'pool fee') return false;
  if (label === 'protocol fee') {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint.trim();
  }
  return false;
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
  opts: { quotedOutRaw?: string; netOutRaw?: string; outMint?: string },
): RoutePlanStepWithFees {
  const enriched = step as RoutePlanStepWithFees;
  if (items.length === 0) {
    delete enriched._hopFees;
    return enriched;
  }
  const outMint = opts.outMint?.trim() || step.swapInfo?.outputMintAddress?.trim() || '';
  const feeMint = outMint || items[items.length - 1]!.mint;
  const totalInOutMint = outMint ? sumFeesInMint(items, outMint) : sumFeeItems(items);
  enriched._hopFees = {
    items,
    totalAmountRaw: totalInOutMint.toString(),
    mint: feeMint,
    quotedOutRaw: opts.quotedOutRaw,
    netOutRaw: opts.netOutRaw,
  };
  enriched.swapInfo = {
    ...enriched.swapInfo,
    feeAmount: totalInOutMint.toString(),
    feeMintAddress: feeMint,
  };
  return enriched;
}

function attachAggregatorTokenAccRent(items: HopFeeItem[], rentLamports: bigint): void {
  if (rentLamports <= 0n) return;
  items.push({
    label: 'Acc Rent Fee',
    amountRaw: rentLamports.toString(),
    mint: WSOL_MINT,
    destinationKind: 'new_token_account',
    destinationNote: 'New SPL token account (rent-exempt deposit)',
  });
}

function attachHopAccRentEntries(items: HopFeeItem[], entries: TokenAccRentEntry[]): void {
  for (const rent of entries) {
    if (rent.lamports <= 0n) continue;
    items.push({
      label: 'Acc Rent Fee',
      amountRaw: rent.lamports.toString(),
      mint: WSOL_MINT,
      destinationAddress: rent.accountAddress,
      destinationKind: 'new_token_account',
      destinationNote:
        rent.createdNew !== false
          ? 'New SPL token account (rent-exempt deposit)'
          : 'Token account deposit',
    });
  }
}

function takeMatchingSolTransfer(
  amount: bigint,
  transfers: WalletFeeTransferEntry[] | undefined,
  used: Set<number>,
): string | undefined {
  if (!transfers?.length || amount <= 0n) return undefined;
  const slack = amount / 100n + 1n;
  for (let i = 0; i < transfers.length; i++) {
    if (used.has(i)) continue;
    const t = transfers[i]!;
    const diff = t.amountLamports > amount ? t.amountLamports - amount : amount - t.amountLamports;
    if (diff <= slack) {
      used.add(i);
      return t.recipientAddress;
    }
  }
  return undefined;
}

function takeMatchingTokenCredit(
  amount: bigint,
  mint: string,
  credits: TokenFeeCreditEntry[] | undefined,
  used: Set<number>,
  preferOwner?: string,
): TokenFeeCreditEntry | undefined {
  if (!credits?.length || amount <= 0n) return undefined;
  const slack = amount / 100n + 1n;

  const tryMatch = (requireOwner: boolean) => {
    for (let i = 0; i < credits.length; i++) {
      if (used.has(i)) continue;
      const credit = credits[i]!;
      if (!mintMatches(credit.mint, mint)) continue;
      if (requireOwner && preferOwner && credit.ownerAddress !== preferOwner) continue;
      try {
        const credited = BigInt(credit.amountRaw);
        const diff = credited > amount ? credited - amount : amount - credited;
        if (diff <= slack || credited >= amount) {
          used.add(i);
          return credit;
        }
      } catch {
        /* skip */
      }
    }
    return undefined;
  };

  if (preferOwner && isLikelySolanaPubkey(preferOwner)) {
    const owned = tryMatch(true);
    if (owned) return owned;
  }
  return tryMatch(false);
}

function creditDestinationAddress(credit: TokenFeeCreditEntry): string | undefined {
  return pickPubkey(credit.tokenAccountAddress) ?? pickPubkey(credit.ownerAddress);
}

function assignPoolVaultDestination(item: HopFeeItem, vaultAddr: string | undefined): boolean {
  const addr = pickPubkey(vaultAddr);
  if (!addr) return false;
  item.destinationAddress = addr;
  item.destinationKind = 'lp_pool';
  item.destinationNote = 'Retained by LP pool vault';
  return true;
}

function assignFeeRecipientDestination(item: HopFeeItem, recipientAddr: string | undefined): boolean {
  const addr = pickPubkey(recipientAddr);
  if (!addr) return false;
  item.destinationAddress = addr;
  item.destinationKind = 'fee_recipient';
  item.destinationNote = 'Fee recipient account';
  return true;
}

function tryAssignPoolVaultFromCredit(
  item: HopFeeItem,
  amount: bigint,
  mint: string,
  ctx: {
    tokenFeeCredits?: TokenFeeCreditEntry[];
    usedTokenCredits: Set<number>;
    preferOwner?: string;
  },
): boolean {
  const credit = takeMatchingTokenCredit(
    amount,
    mint,
    ctx.tokenFeeCredits,
    ctx.usedTokenCredits,
    ctx.preferOwner,
  );
  if (!credit) return false;
  return assignPoolVaultDestination(item, creditDestinationAddress(credit));
}

function enrichHopFeeItemDestinations(
  items: HopFeeItem[],
  ctx: {
    ammKey?: string;
    hopIndex: number;
    inputMint?: string;
    outputMint?: string;
    walletSolTransfers?: WalletFeeTransferEntry[];
    tokenFeeCredits?: TokenFeeCreditEntry[];
    walletAddress?: string;
    usedSolTransfers: Set<number>;
    usedTokenCredits: Set<number>;
  },
): void {
  const poolKey = pickPubkey(ctx.ammKey);
  const walletAddr = pickPubkey(ctx.walletAddress);
  for (const item of items) {
    if (item.destinationAddress?.trim() && item.destinationKind) continue;

    if (item.label === 'Pool fee') {
      let amount = 0n;
      try {
        amount = BigInt(item.amountRaw);
      } catch {
        amount = 0n;
      }
      if (assignPoolVaultDestination(item, poolKey)) continue;
      if (
        amount > 0n &&
        tryAssignPoolVaultFromCredit(item, amount, item.mint, {
          tokenFeeCredits: ctx.tokenFeeCredits,
          usedTokenCredits: ctx.usedTokenCredits,
          preferOwner: poolKey,
        })
      ) {
        continue;
      }
      continue;
    }

    if (item.label === 'Acc Rent Fee') {
      if (!item.destinationKind) item.destinationKind = 'new_token_account';
      if (!item.destinationNote) {
        item.destinationNote = 'New SPL token account (rent-exempt deposit)';
      }
      continue;
    }

    if (item.label === 'Protocol fee' || item.label === 'Route fee') {
      let amount = 0n;
      try {
        amount = BigInt(item.amountRaw);
      } catch {
        amount = 0n;
      }

      if (isSolMint(item.mint) && amount > 0n) {
        const recipient = takeMatchingSolTransfer(
          amount,
          ctx.walletSolTransfers,
          ctx.usedSolTransfers,
        );
        if (recipient && isLikelySolanaPubkey(recipient)) {
          item.destinationAddress = recipient.trim();
          item.destinationKind = 'fee_recipient';
          item.destinationNote = 'Fee recipient account';
          continue;
        }
        if (amount <= 10_000n && item.label === 'Route fee') {
          item.destinationKind = 'network_priority';
          item.destinationNote = 'Solana priority fee (validators)';
          if (walletAddr) item.destinationAddress = walletAddr;
          continue;
        }
      }

      if (amount > 0n) {
        const credit = takeMatchingTokenCredit(
          amount,
          item.mint,
          ctx.tokenFeeCredits,
          ctx.usedTokenCredits,
          poolKey,
        );
        if (credit) {
          const creditOwner = pickPubkey(credit.ownerAddress);
          const creditAddr = creditDestinationAddress(credit);
          if (poolKey && creditOwner === poolKey) {
            assignPoolVaultDestination(item, poolKey);
          } else if (item.label === 'Route fee' && creditAddr) {
            assignPoolVaultDestination(item, creditAddr);
          } else if (creditAddr) {
            assignFeeRecipientDestination(item, creditAddr);
          }
          if (item.destinationKind) continue;
        }
      }

      if (
        ctx.hopIndex === 0 &&
        ctx.inputMint &&
        mintMatches(item.mint, ctx.inputMint)
      ) {
        item.destinationKind = 'input_wallet';
        item.destinationNote = 'Debited from your wallet with the swap input';
        if (walletAddr) item.destinationAddress = walletAddr;
        continue;
      }

      if (ctx.outputMint && mintMatches(item.mint, ctx.outputMint)) {
        if (poolKey && assignPoolVaultDestination(item, poolKey)) continue;
        if (
          amount > 0n &&
          tryAssignPoolVaultFromCredit(item, amount, item.mint, {
            tokenFeeCredits: ctx.tokenFeeCredits,
            usedTokenCredits: ctx.usedTokenCredits,
            preferOwner: poolKey,
          })
        ) {
          continue;
        }
      }

      item.destinationKind = 'output_deduction';
      item.destinationNote = 'Reduces quoted output; recipient not isolated in simulation';
    }
  }

  applyRouteFeeDisplayLabels(items);
}

function applyRouteFeeDisplayLabels(items: HopFeeItem[]): void {
  for (const item of items) {
    if (item.label !== 'Route fee') continue;
    if (item.destinationKind === 'network_priority') {
      item.label = 'Priority fee';
    } else if (item.destinationKind === 'output_deduction') {
      item.label = 'Slippage/Spread';
    }
  }
}

function buildRentEntriesByHopIndex(
  plan: VybeRoutePlanStep[],
  outputMint: string,
  opts?: { pdaRentLamports?: bigint; tokenAccRentByMint?: TokenAccRentEntry[] },
): Map<number, TokenAccRentEntry[]> {
  const byHop = new Map<number, TokenAccRentEntry[]>();
  const entries = opts?.tokenAccRentByMint ?? [];
  if (entries.length > 0) {
    for (const entry of entries) {
      if (entry.lamports <= 0n) continue;
      const hopIdx = findHopIndexForRentMint(plan, entry.mint);
      const list = byHop.get(hopIdx) ?? [];
      list.push(entry);
      byHop.set(hopIdx, list);
    }
    return byHop;
  }

  const aggregate = opts?.pdaRentLamports ?? 0n;
  if (aggregate > 0n) {
    const hopIdx = findHopIndexForRentMint(plan, outputMint);
    byHop.set(hopIdx, [{ mint: outputMint, lamports: aggregate }]);
  }
  return byHop;
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
): Map<number, { amountRaw: bigint; mint: string; vaultAddress?: string }> {
  const byHop = new Map<number, { amountRaw: bigint; mint: string; vaultAddress?: string }>();
  for (const entry of entries ?? []) {
    if (!entry.amountRaw || !/^\d+$/.test(entry.amountRaw)) continue;
    try {
      const amountRaw = BigInt(entry.amountRaw);
      if (amountRaw <= 0n) continue;
      byHop.set(entry.hopIndex, {
        amountRaw,
        mint: entry.mint.trim(),
        vaultAddress: pickPubkey(entry.vaultAddress),
      });
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

function hasProtocolFeeOnMint(items: HopFeeItem[], mint: string): boolean {
  return items.some(
    (it) => it.label === 'Protocol fee' && mintMatches(it.mint, mint),
  );
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
    walletSolTransfers?: WalletFeeTransferEntry[];
    tokenFeeCredits?: TokenFeeCreditEntry[];
    router?: string;
    walletPayDebitRaw?: string | null;
    walletAddress?: string;
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
  const rentEntriesByHop = buildRentEntriesByHopIndex(basePlan, outputMint, opts);
  const embeddedPoolByHop = buildEmbeddedPoolFeeByHopIndex(opts?.embeddedPoolFeesByHop);
  const usedSolTransfers = new Set<number>();
  const usedTokenCredits = new Set<number>();
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
            ...(embedded.vaultAddress
              ? {
                  destinationAddress: embedded.vaultAddress,
                  destinationKind: 'lp_pool' as const,
                  destinationNote: 'Retained by LP pool vault',
                }
              : {}),
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
      const outMint = si.outputMintAddress || outputMint;
      const inputProtocolMint = isSolMint(inputMint) ? WSOL_MINT : inputMint.trim();
      const protocolAlreadyOnInput =
        inputMint && hasProtocolFeeOnMint(items, inputProtocolMint);

      if (
        hopProtocolFee > 0n &&
        !hasProtocolFeeOnMint(items, outMint) &&
        !protocolAlreadyOnInput
      ) {
        items.push({
          label: 'Protocol fee',
          amountRaw: hopProtocolFee.toString(),
          mint: outMint,
        });
      }

      if (totalFeeRaw != null) {
        const totalFee = BigInt(totalFeeRaw);
        const accounted = sumFeesInMint(
          items.filter((it) => it.label !== 'Acc Rent Fee'),
          outMint,
        );
        const routeExtra = totalFee > accounted ? totalFee - accounted : 0n;
        // Quote-vs-simulation gap (Vybe/Meteora) is already reflected in net vs quoted hop
        // output — not a separate wallet-debited fee. Only emit routing remainder for
        // aggregator quotes without simulation (Jupiter/Titan-style route fees).
        if (routeExtra > 0n && simulatedOut == null) {
          items.push({
            label: 'Route fee',
            amountRaw: routeExtra.toString(),
            mint: outMint,
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

    const hopRentEntries = rentEntriesByHop.get(i) ?? [];
    if (hopRentEntries.length > 0) {
      attachHopAccRentEntries(items, hopRentEntries);
    } else {
      attachAggregatorTokenAccRent(items, hopRent);
    }

    enrichHopFeeItemDestinations(items, {
      ammKey: si.ammKey,
      hopIndex: i,
      inputMint,
      outputMint: si.outputMintAddress || outputMint,
      walletSolTransfers: opts?.walletSolTransfers,
      tokenFeeCredits: opts?.tokenFeeCredits,
      walletAddress: opts?.walletAddress,
      usedSolTransfers,
      usedTokenCredits,
    });

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
        outMint: si.outputMintAddress || outputMint,
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
