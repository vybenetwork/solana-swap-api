/**
 * Refresh recentBlockhash on a Vybe unsigned v0 swap tx before wallet sign.
 * Moonbags Trade-Sol-Debug CustomSign does the same so Phantom can simulate balance changes.
 */

import {
  Connection,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';

export interface PrepareSwapTxResult {
  tx: string;
  blockhash: string;
  simulationErr: unknown | null;
}

export async function prepareSwapTransactionForSigning(base64Tx: string): Promise<PrepareSwapTxResult> {
  const trimmed = base64Tx.trim();
  if (!trimmed) throw new Error('Transaction is required.');

  let bytes: Buffer;
  try {
    bytes = Buffer.from(trimmed, 'base64');
  } catch {
    throw new Error('Could not decode swap transaction (expected base64 wire bytes).');
  }

  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(bytes);
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not deserialize swap transaction.');
  }

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const lookups = vtx.message.addressTableLookups;
  let prepared: VersionedTransaction;

  if (lookups.length > 0) {
    const altAccounts: AddressLookupTableAccount[] = [];
    for (const lookup of lookups) {
      const res = await connection.getAddressLookupTable(lookup.accountKey);
      if (!res.value) {
        throw new Error(`Failed to load address lookup table ${lookup.accountKey.toBase58()}.`);
      }
      altAccounts.push(res.value);
    }
    const decompiled = TransactionMessage.decompile(vtx.message, {
      addressLookupTableAccounts: altAccounts,
    });
    decompiled.recentBlockhash = blockhash;
    const message = decompiled.compileToV0Message(altAccounts);
    prepared = new VersionedTransaction(message);
  } else {
    vtx.message.recentBlockhash = blockhash;
    prepared = vtx;
  }

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
