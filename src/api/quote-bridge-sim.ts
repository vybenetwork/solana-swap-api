/**
 * Quote-bridge builds split into pre/main (or main/post) legs. The main tx alone
 * debits an intermediate mint (e.g. USDC) that the wallet may not hold until
 * the pre-swap runs — skip on-chain simulation unless that balance exists.
 */

import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import type { VybeRoutePlanStep, VybeSwapBuildResponse } from '../types/swap.js';
import { sumProtocolFeeAmountRaw } from './enrich-route-fees.js';
import { simulateSwapEffects, type SwapSimulationResult } from './simulate-swap-output.js';
import { isSolMint } from './wallet-balance.js';

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
  return quoteBridgeSimContextFromBuild(build) != null || Boolean(
    (build.details as QuoteBridgeBuildDetails).quoteBridge ||
      (build.details as QuoteBridgeBuildDetails).postSwapNeeded ||
      (build as { preSwapNeeded?: boolean }).preSwapNeeded,
  );
}

async function walletMintBalanceRaw(
  connection: Connection,
  ownerAddress: string,
  mint: string,
): Promise<bigint> {
  const owner = new PublicKey(ownerAddress.trim());
  const m = mint.trim();

  if (isSolMint(m)) {
    return BigInt(await connection.getBalance(owner, 'processed'));
  }

  const { value } = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(m) });
  let total = 0n;
  for (const row of value) {
    const amount = row.account.data.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === 'string' && /^\d+$/.test(amount)) {
      total += BigInt(amount);
    }
  }
  return total;
}

export interface QuoteBridgeSimEligibility {
  canSimulate: boolean;
  skipped: boolean;
  reason: string;
  intermediateMint?: string;
  requiredIntermediateRaw?: string;
  availableIntermediateRaw?: string;
}

/**
 * Returns whether the main swap tx can be simulated on-chain for a quote-bridge build.
 * When preSwap is required, the wallet must already hold enough of the bridge mint.
 */
export async function evaluateQuoteBridgeSimEligibility(
  connection: Connection,
  ownerAddress: string,
  build: VybeSwapBuildResponse,
): Promise<QuoteBridgeSimEligibility> {
  const ctx = quoteBridgeSimContextFromBuild(build);
  if (!ctx) {
    return { canSimulate: true, skipped: false, reason: 'not a pre-swap quote-bridge build' };
  }

  const available = await walletMintBalanceRaw(connection, ownerAddress, ctx.intermediateMint);
  if (available >= ctx.requiredIntermediateRaw) {
    return {
      canSimulate: true,
      skipped: false,
      reason: 'intermediate balance sufficient for main-leg simulation',
      intermediateMint: ctx.intermediateMint,
      requiredIntermediateRaw: ctx.requiredIntermediateRaw.toString(),
      availableIntermediateRaw: available.toString(),
    };
  }

  return {
    canSimulate: false,
    skipped: true,
    reason:
      available <= 0n
        ? `Skipping simulation: quote-bridge main leg needs ${ctx.intermediateMint.slice(0, 8)}… but wallet has none (pre-swap not applied in sim)`
        : `Skipping simulation: quote-bridge main leg needs ${ctx.requiredIntermediateRaw} of ${ctx.intermediateMint.slice(0, 8)}… but wallet has ${available}`,
    intermediateMint: ctx.intermediateMint,
    requiredIntermediateRaw: ctx.requiredIntermediateRaw.toString(),
    availableIntermediateRaw: available.toString(),
  };
}

function preSwapTransactionFromBuild(build: VybeSwapBuildResponse): string | null {
  const ext = build.details as QuoteBridgeBuildDetails;
  const fromDetails = ext.preSwapTransaction?.trim();
  if (fromDetails) return fromDetails;
  const topLevel = (build as { preSwapTransaction?: string }).preSwapTransaction?.trim();
  return topLevel || null;
}

/** Single-hop route plan for the bridge (pre-swap) leg — used for fee attribution in simulation. */
export function quoteBridgePreSwapRoutePlan(
  build: VybeSwapBuildResponse,
  inputMint: string,
): VybeRoutePlanStep[] | null {
  const ext = build.details as QuoteBridgeBuildDetails;
  const preSwapNeeded =
    ext.preSwapNeeded === true || (build as { preSwapNeeded?: boolean }).preSwapNeeded === true;
  if (!preSwapNeeded || !ext.preSwapQuote) return null;

  const bridgeMint = ext.quoteBridge?.bridgeMint?.trim();
  if (!bridgeMint) return null;

  const bridgePool = ext.bridgePool?.address?.trim();
  const preSwapQuote = ext.preSwapQuote;
  const preSwapFeeAmount = sumProtocolFeeAmountRaw(preSwapQuote);
  const preSwapFeeMint =
    preSwapQuote.protocolFees?.[0]?.mint ??
    preSwapQuote.feeMint ??
    preSwapQuote.platformFee?.feeMint ??
    inputMint;

  return [
    {
      percent: 100,
      bps: null,
      swapInfo: {
        ammKey: bridgePool || 'bridge',
        label:
          preSwapQuote.provider ??
          (ext.bridgePool?.type ? ext.bridgePool.type.replace(/_/g, ' ') : 'Raydium'),
        inputMintAddress: inputMint,
        outputMintAddress: bridgeMint,
        inAmount: preSwapQuote.inAmount,
        outAmount: preSwapQuote.outAmount,
        feeAmount: preSwapFeeAmount,
        feeMintAddress: preSwapFeeMint,
      },
    },
  ];
}

/**
 * When the main quote-bridge leg cannot be simulated (wallet lacks intermediate mint),
 * simulate only the pre-swap tx so hop-1 fees, rent, and wallet debits are still known.
 */
export async function simulateQuoteBridgePreSwapLeg(
  build: VybeSwapBuildResponse,
  ownerAddress: string,
  inputMint: string,
): Promise<SwapSimulationResult | null> {
  const preSwapTx = preSwapTransactionFromBuild(build);
  const routePlan = quoteBridgePreSwapRoutePlan(build, inputMint);
  if (!preSwapTx || !routePlan?.[0]) return null;

  const hop = routePlan[0].swapInfo;
  const bridgeMint = hop.outputMintAddress?.trim();
  if (!bridgeMint) return null;

  const bridgePool = (build.details as QuoteBridgeBuildDetails).bridgePool?.address?.trim();
  return simulateSwapEffects(
    preSwapTx,
    ownerAddress,
    bridgeMint,
    inputMint,
    routePlan,
    bridgePool ? { pinnedPoolAddress: bridgePool } : undefined,
  );
}
