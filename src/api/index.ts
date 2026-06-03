/**
 * Vybe API client: single entry point wiring the API modules.
 */

import { createHttpClient } from './client.js';
import { getToken } from './tokens.js';
import { getSwapQuote, type GetSwapQuoteParams } from './swap-quote.js';
import { buildSwap, type BuildSwapParams, type SwapProxyRouter } from './swap-build.js';
import type { VybeToken } from '../types/api.js';
import type { VybeSwapQuote, VybeSwapBuildResponse } from '../types/swap.js';

export type { GetSwapQuoteParams, BuildSwapParams, SwapProxyRouter };

export interface VybeClient {
  getToken(mintAddress: string): Promise<VybeToken>;
  getSwapQuote(params: GetSwapQuoteParams): Promise<VybeSwapQuote>;
  buildSwap(body: BuildSwapParams): Promise<VybeSwapBuildResponse>;
}

export function createClient(apiKey: string): VybeClient {
  const http = createHttpClient(apiKey);
  return {
    getToken: (mintAddress: string) => getToken(http, mintAddress),
    getSwapQuote: (params: GetSwapQuoteParams) => getSwapQuote(http, params),
    buildSwap: (body: BuildSwapParams) => buildSwap(http, body),
  };
}
