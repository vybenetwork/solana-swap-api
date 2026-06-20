/**
 * Pure quote-bridge build detection (no simulation/RPC).
 * Quote-bridge builds split into pre/main (or main/post) legs through a bridge mint.
 */

import type { VybeSwapBuildResponse } from '../types/swap.js';

export type QuoteBridgeHopQuote = VybeSwapBuildResponse['details']['quote'];

export type QuoteBridgeBuildDetails = VybeSwapBuildResponse['details'] & {
  preSwapNeeded?: boolean;
  postSwapNeeded?: boolean;
  preSwapTransaction?: string;
  quoteBridge?: {
    bridgeMint: string;
    userVettedMint: string;
    isBuyingToken: boolean;
    protocol?: string;
  };
  bridgePool?: { type?: string; address?: string };
  preSwapQuote?: QuoteBridgeHopQuote;
  postSwapQuote?: QuoteBridgeHopQuote;
};

export interface QuoteBridgeSimContext {
  /** Main-leg tx debits this mint when preSwapNeeded (buy path). */
  intermediateMint: string;
  /** Raw amount the main leg expects as input. */
  requiredIntermediateRaw: bigint;
}

export function quoteBridgeSimContextFromBuild(
  build: VybeSwapBuildResponse,
): QuoteBridgeSimContext | null {
  const ext = build.details as QuoteBridgeBuildDetails;
  const preSwapNeeded =
    ext.preSwapNeeded === true || (build as { preSwapNeeded?: boolean }).preSwapNeeded === true;
  if (!preSwapNeeded) return null;

  const bridgeMint = ext.quoteBridge?.bridgeMint?.trim();
  const requiredRaw = String(ext.quote?.inAmount ?? '').trim();
  if (!bridgeMint || !/^\d+$/.test(requiredRaw)) return null;

  try {
    return {
      intermediateMint: bridgeMint,
      requiredIntermediateRaw: BigInt(requiredRaw),
    };
  } catch {
    return null;
  }
}

export function isQuoteBridgeBuild(build: VybeSwapBuildResponse): boolean {
  return (
    quoteBridgeSimContextFromBuild(build) != null ||
    Boolean(
      (build.details as QuoteBridgeBuildDetails).quoteBridge ||
        (build.details as QuoteBridgeBuildDetails).postSwapNeeded ||
        (build as { preSwapNeeded?: boolean }).preSwapNeeded,
    )
  );
}
