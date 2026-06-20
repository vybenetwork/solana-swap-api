/**
 * Print-ready swap enrichment produced by ix-builder (simulation + fees + USD + %).
 * swap-api and the browser consume this directly — neither re-simulates nor re-derives.
 */

import type { VybeSwapInfo } from './swap.js';

export type FeeDestinationKind =
  | 'lp_pool'
  | 'new_token_account'
  | 'fee_recipient'
  | 'output_deduction'
  | 'input_wallet'
  | 'network_priority';

export interface EnrichmentFeeItem {
  label: string;
  amountRaw: string;
  mint: string;
  /** Mint of the token account that received rent (fee amount is native SOL). */
  accountMint?: string;
  destinationAddress?: string;
  destinationKind?: FeeDestinationKind;
  destinationNote?: string;
  /** UI (human) amount = amountRaw / 10^decimals. */
  ui: number;
  /** USD value of this fee item (ui * priceUsd of `mint`). */
  usd: number;
  decimals: number;
}

export interface EnrichmentHopFees {
  items: EnrichmentFeeItem[];
  totalAmountRaw: string;
  mint: string;
  quotedOutRaw?: string;
  netOutRaw?: string;
}

export interface EnrichmentRouteStep {
  percent: number;
  bps?: number | null;
  swapInfo: VybeSwapInfo;
  hopFees: EnrichmentHopFees | null;
  grossOutRaw: string | null;
  netOutRaw: string | null;
  inUsd: number;
  outUsd: number;
  retentionInPct: number;
  retentionOutPct: number;
  outgoingPct: number;
  hopSimulation?: EnrichmentHopSimulation | null;
}

export interface EnrichmentYouPay {
  swapUsd: number;
  feeUsd: number;
  rentUsd: number;
  totalUsd: number;
  payRaw: string;
  mint: string;
}

export interface EnrichmentYouReceive {
  outUsd: number;
  reclaimUsd: number;
  netUsd: number;
  outRaw: string;
  mint: string;
}

/** Print-ready USD labels for routing diagram + buy box (ix-builder is source of truth). */
export interface EnrichmentSwapUiUsd {
  /** Total wallet debit in USD — routing diagram "USD Input". */
  inputTotalUsd: number;
  /** Swap output valued in USD before output-side fee deductions — routing "USD Output" swap leg. */
  outputSwapUsd: number;
  /** ATA/WSOL rent reclaimed on output side (added to diagram USD Output subline). */
  outputReclaimUsd: number;
  /** Buy box USD under output amount — same as outputSwapUsd, "(without fees)" qualifier is UI-only. */
  buyBoxUsd: number;
}

export type WalletTokenAccountCloseCategory = 'input' | 'output' | 'wsol' | 'other';

export interface EnrichmentWalletClose {
  mint: string;
  category: WalletTokenAccountCloseCategory;
  accountAddress?: string;
  preBalanceRaw?: string;
  reclaimedLamports?: string;
}

export interface EnrichmentTokenMeta {
  decimals: number | null;
  symbol: string | null;
  priceUsd: number;
}

export interface EnrichmentSimulated {
  ok: boolean;
  err: unknown | null;
  outputDeltaRaw: string | null;
  unitsConsumed: number | null;
}

/** Per-hop simulation status (multi-hop routes: only hop 1 is required to pass). */
export interface EnrichmentHopSimulation {
  hopIndex: number;
  hopCount: number;
  role?: string;
  label?: string;
  inputMintAddress?: string | null;
  outputMintAddress?: string | null;
  simulated: EnrichmentSimulated;
  skipped: boolean;
  skipReason: string | null;
  warning: string | null;
}

export interface EnrichmentSimulationOutputWarning {
  warn: true;
  thresholdPct: number;
  shortfallPct: number;
  quotedOutRaw: string;
  simulatedOutRaw: string;
  adjustedSimulatedOutRaw: string;
  excludedRentPaidRaw: string;
  excludedReclaimRaw: string;
  excludedNetRentRaw: string;
}

export interface EnrichmentLowLiquidityWarning {
  warn: true;
  thresholdUsd: number;
  liquidityUsd: number;
}

export interface SwapEnrichment {
  simulated: EnrichmentSimulated;
  quotedOutRaw: string;
  simulatedOutRaw: string | null;
  outputFromSimulation: boolean;
  inputMintAddress: string;
  outputMintAddress: string;
  inAmountRaw: string;
  outAmountRaw: string;
  outAmountUi: number;
  otherAmountThresholdRaw: string;
  otherAmountThresholdUi: number;
  swapRate: number;
  priceImpactPct: string;
  slippageBps: number;
  swapMode: string;
  maxSlippagePct: number;
  inputPriceUsd: number;
  outputPriceUsd: number;
  swapUsdValue: string | null;
  walletPayDebitRaw: string | null;
  walletTokenAccountCloses: EnrichmentWalletClose[];
  swapFeeRaw: number | null;
  swapFeePct: number | null;
  totalFeeRaw: string | null;
  accountsCreated: number;
  ataRentLamportsTotal: string;
  networkFeeLamports: string;
  youPay: EnrichmentYouPay;
  youReceive: EnrichmentYouReceive;
  swapUiUsd?: EnrichmentSwapUiUsd;
  routePlan: EnrichmentRouteStep[];
  hopSimulations?: EnrichmentHopSimulation[];
  hopCount?: number;
  tokens: Record<string, EnrichmentTokenMeta>;
  simulationOutputWarning?: EnrichmentSimulationOutputWarning | null;
  lowLiquidityWarning?: EnrichmentLowLiquidityWarning | null;
}
