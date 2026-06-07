/**
 * Resolve v0 address lookup tables and refresh blockhash before simulate/sign.
 */

import {
  Connection,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';

export function decodeVersionedSwapTx(base64Tx: string): VersionedTransaction {
  const trimmed = base64Tx.trim();
  if (!trimmed) throw new Error('Transaction is required.');
  try {
    return VersionedTransaction.deserialize(Buffer.from(trimmed, 'base64'));
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not deserialize swap transaction.');
  }
}

export async function prepareVersionedSwapTransaction(
  connection: Connection,
  base64Tx: string,
): Promise<VersionedTransaction> {
  const vtx = decodeVersionedSwapTx(base64Tx);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const lookups = vtx.message.addressTableLookups;

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
    return new VersionedTransaction(decompiled.compileToV0Message(altAccounts));
  }

  vtx.message.recentBlockhash = blockhash;
  return vtx;
}
