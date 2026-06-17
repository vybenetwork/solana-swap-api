/**
 * Vybe POST /v4/trading/swap
 */

import axios, { type AxiosInstance } from 'axios';
import { DEFAULT_SWAP_SERVICE_FEE_PCT } from '../config.js';
import type { VybeSwapBuildResponse } from '../types/swap.js';
import { appendAtaHintsToPayload, enrichBuildParamsWithAtaHints, buildParamsHaveCompleteAtaHints } from './wallet-ata-hints.js';
import { assertPinnedPoolParams, completePinnedSwapParams } from './pinned-swap-params.js';
import { withRetry } from './client.js';
import { toVybeSwapMint } from './sol-mints.js';

export type { SwapWalletAtaHints } from './wallet-ata-hints.js';

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

/** How market discovery runs: trades history, markets snapshot, RPC scan, or combinations. */
export type MarketFetchMode = 'full' | 'trades' | 'markets' | 'rpc';

export function normalizeMarketFetchMode(value: unknown): MarketFetchMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'trades' || raw === 'rpc' || raw === 'markets') return raw;
  return 'full';
}

/** True when `marketFetchMode` is set (`full` | `trades` | `markets` | `rpc`). */
export function isMarketDiscoveryEnabled(
  params: Pick<BuildSwapParams, 'marketFetchMode'>,
): boolean {
  const mode = typeof params.marketFetchMode === 'string' ? params.marketFetchMode.trim().toLowerCase() : '';
  return mode === 'full' || mode === 'trades' || mode === 'rpc' || mode === 'markets';
}

export function resolveMarketFetchMode(
  params: Pick<BuildSwapParams, 'marketFetchMode'>,
): MarketFetchMode {
  if (isMarketDiscoveryEnabled(params)) {
    return normalizeMarketFetchMode(params.marketFetchMode);
  }
  return 'full';
}

/** Multi-route enumeration is on unless explicitly disabled. */
export function resolveEnumerateRoutes(
  params: Pick<BuildSwapParams, 'enumerateRoutes'>,
): boolean {
  return params.enumerateRoutes !== false;
}

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
  /**
   * Market discovery mode (Vybe router, no manual pool):
   * - `full` — trades, then markets snapshot, then RPC
   * - `trades` — recent trades only
   * - `markets` — ClickHouse markets snapshot only
   * - `rpc` — RPC pool scan only
   */
  marketFetchMode?: MarketFetchMode;
  /** Build up to 6 routes (top liquidity + trade overlap). Default on; set `false` to disable. */
  enumerateRoutes?: boolean;
  /** Append input SPL ATA close after full-balance sell (Vybe / ix-builder). */
  closeInputAta?: boolean;
  /** Create output SPL ATA idempotently before swap (buy when wallet has no output ATA). */
  createOutputAta?: boolean;
  /** Ephemeral WSOL path on sell: create WSOL ATA, sync, close (when wallet has no WSOL ATA). */
  closeWsolAta?: boolean;
  /** Exact input balance string from wallet token-balance (UI units); used with closeInputAta. */
  inputBalanceExact?: string;
  inputDecimals?: number;
}

export async function buildSwap(http: AxiosInstance, body: BuildSwapParams): Promise<VybeSwapBuildResponse> {
  assertPinnedPoolParams(body);
  const router = body.router ?? 'vybe';
  let enriched = body;
  if (router === 'vybe' && !buildParamsHaveCompleteAtaHints(body)) {
    enriched = await enrichBuildParamsWithAtaHints(http, body);
  }
  const payload = buildSwapPayload(enriched, router);
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
  // Request ix-builder's print-ready enrichment (simulation + fees + USD + %).
  // Aggregator/remote builds that don't support it simply ignore the flag.
  payload.enrich = true;
  payload.swapFee = swapFeeParamForRouter(pinned.swapFee, router);
  appendAtaHintsToPayload(payload, {
    closeInputAta: pinned.closeInputAta,
    createOutputAta: pinned.createOutputAta,
    closeWsolAta: pinned.closeWsolAta,
  });
  if (pinned.inputBalanceExact?.trim()) {
    payload.inputBalanceExact = pinned.inputBalanceExact.trim();
  }
  if (pinned.inputDecimals != null && Number.isFinite(pinned.inputDecimals)) {
    payload.inputDecimals = pinned.inputDecimals;
  }
  if (pinned.marketFetchMode) payload.marketFetchMode = pinned.marketFetchMode;
  const routerIsVybe = router === 'vybe' || (router === undefined && (pinned.router ?? 'vybe') === 'vybe');
  if (routerIsVybe) {
    payload.enumerateRoutes = resolveEnumerateRoutes(pinned);
  } else if (pinned.enumerateRoutes != null) {
    payload.enumerateRoutes = pinned.enumerateRoutes;
  }
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

  const routers: (SwapProxyRouter | undefined)[] = [
    preferred,
    ...(['vybe', 'jupiter', 'titan'] as const).filter((r) => r !== preferred),
    undefined,
  ];

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
