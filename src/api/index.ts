/**
 * Vybe API client: single entry point wiring the API modules.
 */

import { createHttpClient } from './client.js';
import { getToken } from './tokens.js';
import { getSwapQuote, type GetSwapQuoteParams } from './swap-quote.js';
import { buildSwap, buildSwapWithFallback, type BuildSwapParams, type SwapProxyRouter } from './swap-build.js';
import { resolveTokenPrices, type ResolveTokenPricesOptions } from './resolve-token-prices.js';
import { buildVybeQuoteFromPriceAndSwap, type VybeQuoteParams, type VybeQuoteResult } from './vybe-swap-quote.js';
import {
  assertWalletHasSellAmount,
  getWalletTokenBalance,
  listWalletTokenBalances,
  type GetWalletTokenBalanceParams,
  type WalletBalanceListItem,
} from './wallet-balance.js';
import {
  evaluateLowSolTradeWarning,
  type LowSolTradeWarningResult,
} from './trade-sol-warning.js';
import type { VybeToken } from '../types/api.js';
import type { VybeSwapQuote, VybeSwapBuildResponse } from '../types/swap.js';
import type { ResolveTokenPricesResult } from './resolve-token-prices.js';

export type {
  GetSwapQuoteParams,
  BuildSwapParams,
  SwapProxyRouter,
  VybeQuoteParams,
  VybeQuoteResult,
  GetWalletTokenBalanceParams,
  WalletBalanceListItem,
  LowSolTradeWarningResult,
};

export interface VybeClient {
  getToken(mintAddress: string): Promise<VybeToken>;
  getSwapQuote(params: GetSwapQuoteParams): Promise<VybeSwapQuote>;
  buildSwap(body: BuildSwapParams): Promise<VybeSwapBuildResponse>;
  buildSwapWithFallback(body: BuildSwapParams): Promise<VybeSwapBuildResponse>;
  resolveTokenPrices(mints: string[], options?: ResolveTokenPricesOptions): Promise<ResolveTokenPricesResult>;
  buildVybeQuote(params: VybeQuoteParams): Promise<VybeQuoteResult>;
  getWalletTokenBalance(params: GetWalletTokenBalanceParams): Promise<
    import('../types/api.js').VybeWalletTokenBalanceResponse
  >;
  assertWalletHasSellAmount(
    ownerAddress: string,
    inputMint: string,
    amountUi: number,
    symbolHint?: string,
  ): Promise<void>;
  listWalletTokenBalances(ownerAddress: string, limit?: number): Promise<WalletBalanceListItem[]>;
  evaluateLowSolTradeWarning(params: {
    ownerAddress: string;
    inputMint: string;
    outputMint: string;
    gasless: boolean;
  }): Promise<LowSolTradeWarningResult>;
}

export function createClient(apiKey: string): VybeClient {
  const http = createHttpClient(apiKey);
  return {
    getToken: (mintAddress: string) => getToken(http, mintAddress),
    getSwapQuote: (params: GetSwapQuoteParams) => getSwapQuote(http, params),
    buildSwap: (body: BuildSwapParams) => buildSwap(http, body),
    buildSwapWithFallback: (body: BuildSwapParams) => buildSwapWithFallback(http, body),
    resolveTokenPrices: (mints, options) => resolveTokenPrices(http, mints, options),
    buildVybeQuote: (params) => buildVybeQuoteFromPriceAndSwap(http, params),
    getWalletTokenBalance: (params) => getWalletTokenBalance(http, params),
    assertWalletHasSellAmount: (ownerAddress, inputMint, amountUi, symbolHint) =>
      assertWalletHasSellAmount(http, ownerAddress, inputMint, amountUi, symbolHint),
    listWalletTokenBalances: (ownerAddress, limit) =>
      listWalletTokenBalances(http, ownerAddress, limit),
    evaluateLowSolTradeWarning: (params) => evaluateLowSolTradeWarning(http, params),
  };
}
