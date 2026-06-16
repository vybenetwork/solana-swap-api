/**
 * Pool discovery via local ix-builder.
 *
 * Discovery (trades + markets + RPC ranking, quote-bridge augmentation, and direct-route
 * diversity) is owned by ix-builder's GET /discover-pools. swap-api only consumes that single
 * contract — it no longer fetches/merges /route-trades, /route-markets or /scan-pools itself.
 */

import axios from 'axios';
import { IX_BUILDER_LOCAL_URL, VYBE_TIMEOUT_MS } from '../config.js';
import { withRetry } from './client.js';
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
  tradeEligible?: number;
  marketEligible?: number;
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

/** Single discovery call: output-centric trades/markets ranking + quote-bridge + direct diversity. */
export async function fetchDiscoverPoolsViaIxBuilder(
  inputMint: string,
  outputMint: string,
  marketFetchMode: MarketFetchMode,
  enumerateRoutes = false,
): Promise<IxBuilderDiscoverPoolsResponse> {
  return withRetry(async () => {
    const { data } = await axios.get<IxBuilderDiscoverPoolsResponse>(
      `${IX_BUILDER_LOCAL_URL}/discover-pools`,
      {
        params: {
          inputMint: inputMint.trim(),
          outputMint: outputMint.trim(),
          marketFetchMode,
          enumerateRoutes: enumerateRoutes ? 'true' : 'false',
        },
        timeout: VYBE_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      },
    );
    return data;
  });
}
