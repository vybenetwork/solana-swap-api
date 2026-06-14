/**
 * Vybe POST /v4/trading/swap
 */

import axios, { type AxiosInstance } from 'axios';
import { DEFAULT_SWAP_SERVICE_FEE_PCT, isLocalVybeApi } from '../config.js';
import type { VybeSwapBuildResponse } from '../types/swap.js';
import { buildSwapViaIxBuilder } from './ix-builder-swap.js';
import { completePinnedSwapParams } from './pinned-swap-params.js';
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
  /** DEX program id from trade data (best-effort; not in OpenAPI but forwarded to Vybe). */
  programAddress?: string;
  simulate?: boolean;
  swapFee?: number;
  /** When true (Vybe router, no manual pool), rank markets from recent trades and try top pools. */
  routeViaTrades?: boolean;
}

export async function buildSwap(http: AxiosInstance, body: BuildSwapParams): Promise<VybeSwapBuildResponse> {
  const router = body.router ?? 'vybe';
  if (isLocalVybeApi() && router === 'vybe') {
    return buildSwapViaIxBuilder(body);
  }
  const payload = buildSwapPayload(body, router);
  return withRetry(async () => {
    const { data } = await http.post<VybeSwapBuildResponse>('/v4/trading/swap', payload);
    return data;
  });
}

function buildSwapPayload(body: BuildSwapParams, router?: SwapProxyRouter): Record<string, unknown> {
  const pinned =
    router === 'vybe' || body.router === 'vybe'
      ? completePinnedSwapParams(body)
      : body;
  const payload: Record<string, unknown> = {
    accountAddress: pinned.accountAddress.trim(),
    amount: pinned.amount,
    inputMintAddress: toVybeSwapMint(pinned.inputMintAddress.trim()),
    outputMintAddress: toVybeSwapMint(pinned.outputMintAddress.trim()),
  };
  if (pinned.slippage != null && Number.isFinite(pinned.slippage)) payload.slippage = pinned.slippage;
  if (router) payload.router = router;
  if (pinned.autoCalculateSlippage != null) payload.autoCalculateSlippage = pinned.autoCalculateSlippage;
  if (pinned.gasless != null) payload.gasless = pinned.gasless;
  if (pinned.partner?.trim()) payload.partner = pinned.partner.trim();
  if (pinned.poolAddress?.trim()) payload.poolAddress = pinned.poolAddress.trim();
  if (pinned.protocol) payload.protocol = pinned.protocol;
  if (pinned.programAddress?.trim()) payload.programAddress = pinned.programAddress.trim();
  if (pinned.simulate != null) payload.simulate = pinned.simulate;
  payload.swapFee = swapFeeParamForRouter(pinned.swapFee, router);
  return payload;
}

/** UI fee is whole percent (1 = 1%). Vybe uses fraction (0.01 = 1%); Jupiter/Titan use whole percent. */
function swapFeeParamForRouter(
  feePctUi: number | undefined | null,
  router?: SwapProxyRouter,
): number {
  const pct =
    feePctUi != null && Number.isFinite(feePctUi) ? feePctUi : DEFAULT_SWAP_SERVICE_FEE_PCT;
  if (pct <= 0) return 0;
  if (router === 'jupiter' || router === 'titan') return pct;
  return pct / 100;
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
  let lastErr: unknown;

  if (isLocalVybeApi() && preferred === 'vybe') {
    try {
      return await buildSwapViaIxBuilder(body);
    } catch (err) {
      lastErr = err;
      if (!isRetryableBuildError(err)) throw err;
    }
  }

  const routers: (SwapProxyRouter | undefined)[] = [
    preferred,
    ...(['vybe', 'jupiter', 'titan'] as const).filter((r) => r !== preferred),
    undefined,
  ].filter((router) => !(isLocalVybeApi() && router === 'vybe'));

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
