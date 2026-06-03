/**
 * Vybe POST /v4/trading/swap
 */

import type { AxiosInstance } from 'axios';
import type { VybeSwapBuildResponse } from '../types/swap.js';
import { withRetry } from './client.js';

export type SwapProxyRouter = 'titan' | 'jupiter' | 'vybe';

/** Vybe `SwapProxyParams.protocol` — POST /v4/trading/swap */
export const VYBE_SWAP_PROTOCOLS = [
  'PUMPFUN',
  'PUMPSWAP',
  'RAYDIUMAMMV4',
  'RAYDIUMCPMM',
  'RAYDIUMCLMM',
  'RAYDIUMLAUNCHLAB',
  'METEORADBC',
  'METEORADAMM2',
  'METEORADLMM',
  'SANCTUM',
] as const;

export type SwapProxyProtocol = (typeof VYBE_SWAP_PROTOCOLS)[number];

export interface BuildSwapParams {
  accountAddress: string;
  amount: number;
  inputMintAddress: string;
  outputMintAddress: string;
  slippage?: number;
  router?: SwapProxyRouter;
  autoCalculateSlippage?: boolean;
  gasless?: boolean;
  partner?: string;
  poolAddress?: string;
  protocol?: SwapProxyProtocol;
  simulate?: boolean;
  swapFee?: number;
}

export async function buildSwap(http: AxiosInstance, body: BuildSwapParams): Promise<VybeSwapBuildResponse> {
  const payload: Record<string, unknown> = {
    accountAddress: body.accountAddress.trim(),
    amount: body.amount,
    inputMintAddress: body.inputMintAddress.trim(),
    outputMintAddress: body.outputMintAddress.trim(),
  };
  if (body.slippage != null && Number.isFinite(body.slippage)) payload.slippage = body.slippage;
  if (body.router) payload.router = body.router;
  if (body.autoCalculateSlippage != null) payload.autoCalculateSlippage = body.autoCalculateSlippage;
  if (body.gasless != null) payload.gasless = body.gasless;
  if (body.partner?.trim()) payload.partner = body.partner.trim();
  if (body.poolAddress?.trim()) payload.poolAddress = body.poolAddress.trim();
  if (body.protocol) payload.protocol = body.protocol;
  if (body.simulate != null) payload.simulate = body.simulate;
  if (body.swapFee != null) payload.swapFee = body.swapFee;

  return withRetry(async () => {
    const { data } = await http.post<VybeSwapBuildResponse>('/v4/trading/swap', payload);
    return data;
  });
}
