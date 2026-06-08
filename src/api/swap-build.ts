/**
 * Vybe POST /v4/trading/swap
 */

import axios, { type AxiosInstance } from 'axios';
import type { VybeSwapBuildResponse } from '../types/swap.js';
import { withRetry } from './client.js';
import { toVybeSwapMint } from './sol-mints.js';

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
  const payload = buildSwapPayload(body, body.router);
  return withRetry(async () => {
    const { data } = await http.post<VybeSwapBuildResponse>('/v4/trading/swap', payload);
    return data;
  });
}

function buildSwapPayload(body: BuildSwapParams, router?: SwapProxyRouter): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    accountAddress: body.accountAddress.trim(),
    amount: body.amount,
    inputMintAddress: toVybeSwapMint(body.inputMintAddress.trim()),
    outputMintAddress: toVybeSwapMint(body.outputMintAddress.trim()),
  };
  if (body.slippage != null && Number.isFinite(body.slippage)) payload.slippage = body.slippage;
  if (router) payload.router = router;
  if (body.autoCalculateSlippage != null) payload.autoCalculateSlippage = body.autoCalculateSlippage;
  if (body.gasless != null) payload.gasless = body.gasless;
  if (body.partner?.trim()) payload.partner = body.partner.trim();
  if (body.poolAddress?.trim()) payload.poolAddress = body.poolAddress.trim();
  if (body.protocol) payload.protocol = body.protocol;
  if (body.simulate != null) payload.simulate = body.simulate;
  payload.swapFee = body.swapFee != null && Number.isFinite(body.swapFee) ? body.swapFee : 0;
  return payload;
}

function isRetryableBuildError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return true;
  const status = err.response?.status;
  if (status == null) return true;
  return status >= 500 || status === 429;
}

/**
 * Try POST /v4/trading/swap across routers. Vybe direct (`router=vybe`) can fail for some
 * pairs (e.g. SOL input) while aggregator routes succeed.
 */
export async function buildSwapWithFallback(
  http: AxiosInstance,
  body: BuildSwapParams,
): Promise<VybeSwapBuildResponse> {
  const preferred = body.router ?? 'vybe';
  const routers: (SwapProxyRouter | undefined)[] = [
    preferred,
    ...(['vybe', 'jupiter', 'titan'] as const).filter((r) => r !== preferred),
    undefined,
  ];
  let lastErr: unknown;
  for (const router of routers) {
    try {
      const payload = buildSwapPayload(body, router);
      const { data } = await http.post<VybeSwapBuildResponse>('/v4/trading/swap', payload);
      return data;
    } catch (err) {
      lastErr = err;
      if (!isRetryableBuildError(err)) break;
    }
  }
  throw lastErr;
}
