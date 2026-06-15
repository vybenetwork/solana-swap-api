/**
 * Vybe trading: GET /v4/trading/swap-quote, POST /v4/trading/swap
 * @see Vybe OpenAPI (Trading tag)
 */

export interface VybeSwapInfo {
  ammKey: string;
  label: string;
  inputMintAddress: string;
  outputMintAddress: string;
  inAmount: string;
  outAmount: string;
  feeAmount: string;
  feeMintAddress: string;
}

export interface VybeRoutePlanStep {
  percent: number;
  bps?: number | null;
  swapInfo: VybeSwapInfo;
}

/** Response body from GET /v4/trading/swap-quote */
export interface VybeSwapQuote {
  inputMintAddress: string;
  inAmount: string;
  outputMintAddress: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  priceImpactPct: string;
  routePlan: VybeRoutePlanStep[];
  outAmountUi: number;
  otherAmountThresholdUi: number;
  swapRate: number;
  contextSlot?: number | null;
  slippageBps?: number | null;
  otherRoutePlans?: unknown;
  mostReliableAmmsQuoteReport?: { info?: Record<string, string> };
  swapUsdValue?: string | null;
  timeTaken?: number | null;
  [key: string]: unknown;
}

export interface VybeSwapDetails {
  inputAmount: number;
  inputMintAddress: string;
  outputMintAddress: string;
  inputDecimals: number;
  outputDecimals: number;
  swapFee: number;
  closeAccountIx: boolean;
  quote: {
    inAmount: string;
    outAmount: string;
    minOutAmount?: string;
    minimumOutAmount?: string;
    provider: string;
    protocolFees?: Array<{
      label: string;
      amountRaw: string;
      mint: string;
      feeBps?: number;
      destinationKind?:
        | 'lp_pool'
        | 'new_token_account'
        | 'fee_recipient'
        | 'output_deduction'
        | 'input_wallet'
        | 'network_priority';
      destinationAddress?: string;
      destinationNote?: string;
    }>;
    feeAmount?: string;
    feeMint?: string;
    platformFee?: {
      amount?: string;
      feeBps?: number;
      feeMint?: string;
    };
  };
}

/** Response body from POST /v4/trading/swap */
export interface VybeSwapBuildResponse {
  /** Base64 serialized transaction — pass through exactly as Vybe returns it. */
  tx?: string;
  /** Legacy alias some responses may include; prefer `tx`. */
  transaction?: string;
  provider: string;
  details: VybeSwapDetails;
  slippage: number;
  slippageSource: string;
  [key: string]: unknown;
}
