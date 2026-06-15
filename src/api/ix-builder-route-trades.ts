/**
 * Route trades fetch via local ix-builder (ClickHouse → Vybe API fallback).
 */

import axios from 'axios';
import { IX_BUILDER_LOCAL_URL, VYBE_TIMEOUT_MS } from '../config.js';
import type { VybeTrade } from '../types/api.js';
import { withRetry } from './client.js';

export interface IxBuilderRouteTradesResponse {
  data: VybeTrade[];
  rawCount: number;
  source: 'clickhouse' | 'vybe_api';
  errors?: Array<{ source: string; error: string }>;
}

export interface IxBuilderRouteMarketRow {
  marketAddress: string;
  programAddress: string;
  totalValueUsd?: number;
  rankScore?: number;
  updatedAt?: string;
}

export interface IxBuilderRouteMarketsResponse {
  data: IxBuilderRouteMarketRow[];
  rawCount: number;
  source?: 'clickhouse_markets' | 'vybe_api';
  errors?: Array<{ source: string; error: string; table?: string }>;
}

export async function fetchRouteTradesViaIxBuilder(
  inputMint: string,
  outputMint: string,
  limit: number,
): Promise<IxBuilderRouteTradesResponse> {
  return withRetry(async () => {
    const { data } = await axios.get<IxBuilderRouteTradesResponse>(
      `${IX_BUILDER_LOCAL_URL}/route-trades`,
      {
        params: {
          inputMint: inputMint.trim(),
          outputMint: outputMint.trim(),
          limit,
        },
        timeout: VYBE_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      },
    );
    return data;
  });
}

export async function fetchRouteMarketsViaIxBuilder(
  inputMint: string,
  outputMint: string,
  limit: number,
): Promise<IxBuilderRouteMarketsResponse> {
  return withRetry(async () => {
    const { data } = await axios.get<IxBuilderRouteMarketsResponse>(
      `${IX_BUILDER_LOCAL_URL}/route-markets`,
      {
        params: {
          inputMint: inputMint.trim(),
          outputMint: outputMint.trim(),
          limit,
        },
        timeout: VYBE_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      },
    );
    return data;
  });
}

export interface ScannedPoolCandidate {
  marketAddress: string;
  programAddress: string;
  protocol?: string;
  liquidity?: string;
  preSwapNeeded?: boolean;
  baseMint?: string;
  quoteMint?: string;
}

export async function fetchScanPoolsViaIxBuilder(
  inputMint: string,
  outputMint: string,
): Promise<ScannedPoolCandidate[]> {
  const { data } = await axios.get<{ pools: ScannedPoolCandidate[] }>(
    `${IX_BUILDER_LOCAL_URL}/scan-pools`,
    {
      params: {
        inputMint: inputMint.trim(),
        outputMint: outputMint.trim(),
      },
      timeout: VYBE_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    },
  );
  return data.pools ?? [];
}
