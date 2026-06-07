/**
 * Simulate a Vybe unsigned swap tx and read the wallet's net output-token credit.
 * Phantom uses the same simulation for "Estimated balance changes" — often lower than
 * build.details.quote.outAmount when fees are taken on-chain.
 */

import { Connection, VersionedTransaction } from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';

type TokenBalanceEntry = {
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string };
};

function extractWalletOutputDeltaRaw(
  pre: TokenBalanceEntry[] | null | undefined,
  post: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  outputMint: string,
): string | null {
  const postEntry = post?.find((b) => b.owner === ownerAddress && b.mint === outputMint);
  if (!postEntry?.uiTokenAmount?.amount) return null;

  const postAmt = BigInt(postEntry.uiTokenAmount.amount);
  const preEntry = pre?.find((b) => b.owner === ownerAddress && b.mint === outputMint);
  const preAmt = preEntry?.uiTokenAmount?.amount ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
  const delta = postAmt - preAmt;
  if (delta <= 0n) return null;
  return delta.toString();
}

/** Returns raw integer output amount the owner receives, or null if simulation fails. */
export async function simulateSwapOutputRaw(
  base64Tx: string,
  ownerAddress: string,
  outputMint: string,
): Promise<string | null> {
  const trimmed = base64Tx.trim();
  if (!trimmed || !ownerAddress.trim() || !outputMint.trim()) return null;

  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(Buffer.from(trimmed, 'base64'));
  } catch {
    return null;
  }

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const sim = await connection.simulateTransaction(vtx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  const value = sim.value as {
    err: unknown;
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  };
  if (value.err) return null;

  return extractWalletOutputDeltaRaw(
    value.preTokenBalances,
    value.postTokenBalances,
    ownerAddress.trim(),
    outputMint.trim(),
  );
}
