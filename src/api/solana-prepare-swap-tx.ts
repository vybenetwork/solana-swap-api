/**
 * Refresh recentBlockhash on a Vybe unsigned v0 swap tx before wallet sign.
 * Moonbags Trade-Sol-Debug CustomSign does the same so Phantom can simulate balance changes.
 */

import { Connection } from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';
import { prepareVersionedSwapTransaction } from './prepare-versioned-swap-tx.js';

export interface PrepareSwapTxResult {
  tx: string;
  blockhash: string;
  simulationErr: unknown | null;
}

export async function prepareSwapTransactionForSigning(base64Tx: string): Promise<PrepareSwapTxResult> {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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
