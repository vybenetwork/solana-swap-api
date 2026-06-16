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
  routePlan: EnrichmentRouteStep[];
  tokens: Record<string, EnrichmentTokenMeta>;
}
