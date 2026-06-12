/**
 * Vybe GET /v4/trading/swap-quote
 */

import type { AxiosInstance } from 'axios';
import type { VybeSwapQuote } from '../types/swap.js';
import { withRetry } from './client.js';
import { toVybeSwapMint } from './sol-mints.js';

export interface GetSwapQuoteParams {
  /** Amount in UI units (e.g. 0.1 SOL) */
  amount: number;
  inputMintAddress: string;
  outputMintAddress: string;
  accountAddress?: string;
  /** Percentage, default 2 */
  slippage?: number;
}

export async function getSwapQuote(http: AxiosInstance, params: GetSwapQuoteParams): Promise<VybeSwapQuote> {
  const query: Record<string, string | number> = {
    amount: params.amount,
    inputMintAddress: toVybeSwapMint(params.inputMintAddress.trim()),
    outputMintAddress: toVybeSwapMint(params.outputMintAddress.trim()),
  };
  const acc = params.accountAddress?.trim();
  if (acc) query.accountAddress = acc;
  if (params.slippage != null && Number.isFinite(params.slippage)) query.slippage = params.slippage;

  return withRetry(async () => {
    const { data } = await http.get<VybeSwapQuote>('/v4/trading/swap-quote', { params: query });
    return data;
  });
}
