/**
 * Refresh recentBlockhash on a Vybe unsigned v0 swap tx before wallet sign.
 * Moonbags Trade-Sol-Debug CustomSign does the same so Phantom can simulate balance changes.
 */

import { createSolanaConnection } from './solana-connection.js';
import { prepareVersionedSwapTransaction } from './prepare-versioned-swap-tx.js';

export interface PrepareSwapTxResult {
  tx: string;
  blockhash: string;
  simulationErr: unknown | null;
}

export async function prepareSwapTransactionForSigning(base64Tx: string): Promise<PrepareSwapTxResult> {
  const connection = createSolanaConnection('prepareSwapTx', 'processed');
  const prepared = await prepareVersionedSwapTransaction(connection, base64Tx);
  const blockhash = prepared.message.recentBlockhash;

  const simulation = await connection.simulateTransaction(prepared, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });

  return {
    tx: Buffer.from(prepared.serialize()).toString('base64'),
    blockhash,
    simulationErr: simulation.value.err ?? null,
  };
}
