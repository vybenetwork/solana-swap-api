/**
 * Pool discovery via ix-builder GET /discover-pools (local dev only).
 *
 * Prod uses POST /v4/trading/swap with `enumerateRoutes: true` — Vybe API discovers pools
 * internally and returns enumerated routes in the swap response.
 */

import axios, { type AxiosInstance } from 'axios';
import { isLocalVybeApi, IX_BUILDER_LOCAL_URL, VYBE_TIMEOUT_MS } from '../config.js';
import type { MarketFetchMode } from './swap-build.js';

/** Quote-bridge route metadata attached to a discovered pool (e.g. WSOL→USDC→token). */
export interface ScannedPoolCandidate {
  marketAddress: string;
  programAddress: string;
  protocol?: string;
  liquidity?: string;
  preSwapNeeded?: boolean;
  baseMint?: string;
  quoteMint?: string;
  quoteBridge?: {
    bridgeMint: string;
    userVettedMint: string;
    isBuyingToken: boolean;
  } | null;
}

/** One pool from GET /discover-pools (already ranked, deduped, augmented + diversity-applied). */
export interface IxBuilderDiscoverPool {
  marketAddress: string;
  programAddress: string;
  protocol?: string;
  liquidity?: string;
  marketScore?: number | null;
  tradeCount?: number;
  source?: string | null;
  preSwapNeeded?: boolean;
  postSwapNeeded?: boolean;
  isDirectPair?: boolean;
  baseMint?: string | null;
  quoteMint?: string | null;
  quoteBridge?: {
    bridgeMint: string;
    userVettedMint: string;
    isBuyingToken: boolean;
    protocol?: string;
  } | null;
}

export interface IxBuilderDiscoverPoolsMeta {
  mode?: string;
  strategy?: string;
  tradesSource?: string;
  marketsSource?: string;
  tradesRawCount?: number;
  tradesOldestBlockTime?: number | null;
  tradesOldestAt?: string | null;
  tradeEligible?: number;
  marketEligible?: number;
  rpcLaunchpadsScanned?: number;
  rpcPostLaunchLabFallback?: boolean;
  rpcLaunchpads?: boolean;
  rpcScanned?: number;
  mergedCount?: number;
  directReserveCount?: number;
  directPoolCount?: number;
  poolCount?: number;
  marketFetchMode?: string;
  enumerateRoutes?: boolean;
}

export interface IxBuilderDiscoverPoolsResponse {
  pools: IxBuilderDiscoverPool[];
  count: number;
  meta: IxBuilderDiscoverPoolsMeta;
}

const DISCOVER_POOLS_PARAMS = (
  inputMint: string,
  outputMint: string,
  marketFetchMode: MarketFetchMode,
  enumerateRoutes: boolean,
) => ({
  inputMint: inputMint.trim(),
  outputMint: outputMint.trim(),
  marketFetchMode,
  enumerateRoutes: enumerateRoutes ? 'true' : 'false',
  rpcLaunchpads: 'true',
});

/**
 * Discover ranked pools for a mint pair.
 * @param http - Authenticated Vybe client (required when not using local ix-builder).
 */
export async function fetchDiscoverPools(
  http: AxiosInstance,
  inputMint: string,
  outputMint: string,
  marketFetchMode: MarketFetchMode,
  enumerateRoutes = true,
): Promise<IxBuilderDiscoverPoolsResponse> {
  if (!isLocalVybeApi()) {
    throw new Error(
      'fetchDiscoverPools is local-only; use POST /v4/trading/swap with enumerateRoutes on remote Vybe API',
    );
  }
  const params = DISCOVER_POOLS_PARAMS(inputMint, outputMint, marketFetchMode, enumerateRoutes);
  const { data } = await axios.get<IxBuilderDiscoverPoolsResponse>(
    `${IX_BUILDER_LOCAL_URL}/discover-pools`,
    {
      params,
      timeout: VYBE_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    },
  );
  return data;
}
