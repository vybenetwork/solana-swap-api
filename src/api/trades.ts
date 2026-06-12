/**
 * Vybe trade history: GET /v4/trades with full query param support.
 * @see https://docs.vybenetwork.com/reference/get_trade_data_program_v4
 */

import type { AxiosInstance } from 'axios';
import type { VybeTradesResponse } from '../types/api.js';
import { isVybeApiNotFoundError, withRetry } from './client.js';

export { isVybeApiNotFoundError };

export type TradesSortField = 'price' | 'blockTime';

export interface GetTradesParams {
  programAddress?: string;
  baseMintAddress?: string;
  quoteMintAddress?: string;
  /** Either base or quote token (per docs). */
  mintAddress?: string;
  /**
   * Market id (pool) to filter with.
   * If provided, the baseMintAddress and quoteMintAddress fields are ignored by the API.
   */
  marketAddress?: string;
  authorityAddress?: string;
  feePayerAddress?: string;
  resolution?: string;
  timeStart?: number;
  timeEnd?: number;
  page?: number;
  limit?: number;
  sortByAsc?: TradesSortField;
  sortByDesc?: TradesSortField;
}

/** Fetch trade history with filtering + pagination. */
export async function getTrades(http: AxiosInstance, params: GetTradesParams): Promise<VybeTradesResponse> {
  const filtered: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    filtered[k] = v as string | number;
  }

  return withRetry(async () => {
    const { data } = await http.get<VybeTradesResponse>('/v4/trades', { params: filtered });
    return data;
  });
}
