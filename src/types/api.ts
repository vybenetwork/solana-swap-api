/**
 * TypeScript interfaces matching Vybe API response shapes used in this demo.
 * @see https://docs.vybenetwork.com/reference/get_trade_data_program_v4
 */

/** Token details from GET /v4/tokens/{mintAddress} */
export interface VybeToken {
  mintAddress: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoUrl?: string;
  priceUsd?: string;
  marketCapUsd?: string;
  volume24hUsd?: string;
  holders?: number;
  currentSupply?: string;
  [key: string]: unknown;
}

/** Single trade from GET /v4/trades (trade history). */
export interface VybeTrade {
  /** The public key of the signer who authorized the trade. */
  authorityAddress: string;
  /** The mint address of the base token involved in the trade. */
  baseMintAddress: string;
  /** The quantity of the base token involved in the trade. */
  baseSize: string;
  /** The Unix timestamp at which the trade occurred on the blockchain. */
  blockTime: number;
  /** The amount of fees paid for the trade. */
  fee: string;
  /** The public key of the account responsible for paying the transaction fees. */
  feePayerAddress: string;
  /** Inner ix ordinal (255 if not applicable). */
  iixOrdinal: number;
  /** Inter ix ordinal (255 if not applicable). */
  interIxOrdinal: number;
  /** Ix ordinal inside tx. */
  ixOrdinal: number;
  /** Market / pool address where the trade took place. */
  marketAddress: string;
  /** Price of one unit of base token in quote token terms. */
  price: string;
  /** DEX / AMM program id that facilitated the trade. */
  programAddress: string;
  /** Quote token mint address. */
  quoteMintAddress: string;
  /** Amount of quote token exchanged. */
  quoteSize: string;
  /** Transaction signature. */
  signature: string;
  /** Slot of the trade. */
  slot: number;
  /** Transaction index of the trade. */
  txIndex: number;

  /** Allow forward-compatible fields. */
  [key: string]: unknown;
}

/** Trades response wrapper. */
export interface VybeTradesResponse {
  data: VybeTrade[];
  [key: string]: unknown;
}

/** Single program from GET /v4/programs/labeled-program-accounts */
export interface VybeLabeledProgram {
  programAddress: string;
  name?: string;
  labels?: string[];
  label?: string;
  symbol?: string;
  [key: string]: unknown;
}

/** Response from GET /v4/programs/labeled-program-accounts (uses programs, not data) */
export interface VybeProgramsResponse {
  programs?: VybeLabeledProgram[];
  data?: VybeLabeledProgram[];
  [key: string]: unknown;
}

/** Token OHLC candles response wrapper (fields can vary by resolution). */
export interface VybeCandlesResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any[];
  [key: string]: unknown;
}
