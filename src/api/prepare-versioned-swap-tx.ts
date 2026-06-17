/**
 * Resolve v0 address lookup tables and refresh blockhash before simulate/sign.
 */

import {
  Connection,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';

const BLOCKHASH_CACHE_MS = 10_000;
const ALT_CACHE_MS = 60_000;

let cachedBlockhash: { hash: string; cachedAt: number } | null = null;
const altAccountCache = new Map<string, { account: AddressLookupTableAccount; cachedAt: number }>();

export function decodeVersionedSwapTx(base64Tx: string): VersionedTransaction {
  const trimmed = base64Tx.trim();
  if (!trimmed) throw new Error('Transaction is required.');
  try {
    return VersionedTransaction.deserialize(Buffer.from(trimmed, 'base64'));
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not deserialize swap transaction.');
  }
}

async function getCachedLatestBlockhash(connection: Connection): Promise<string> {
  const now = Date.now();
  if (cachedBlockhash && now - cachedBlockhash.cachedAt < BLOCKHASH_CACHE_MS) {
    return cachedBlockhash.hash;
  }
  const { blockhash } = await connection.getLatestBlockhash('processed');
  cachedBlockhash = { hash: blockhash, cachedAt: now };
  return blockhash;
}

async function loadAltAccountCached(
  connection: Connection,
  pubkey: import('@solana/web3.js').PublicKey,
): Promise<AddressLookupTableAccount | null> {
  const key = pubkey.toBase58();
  const now = Date.now();
  const hit = altAccountCache.get(key);
  if (hit && now - hit.cachedAt < ALT_CACHE_MS) {
    return hit.account;
  }
  const res = await connection.getAddressLookupTable(pubkey);
  if (!res.value) return null;
  altAccountCache.set(key, { account: res.value, cachedAt: now });
  return res.value;
}

export interface PreparedVersionedSwapTx {
  prepared: VersionedTransaction;
  altAccounts: AddressLookupTableAccount[];
}

export async function prepareVersionedSwapTransaction(
  connection: Connection,
  base64Tx: string,
): Promise<VersionedTransaction> {
  const { prepared } = await prepareVersionedSwapTransactionWithAlts(connection, base64Tx);
  return prepared;
}

export async function prepareVersionedSwapTransactionWithAlts(
  connection: Connection,
  base64Tx: string,
): Promise<PreparedVersionedSwapTx> {
  const vtx = decodeVersionedSwapTx(base64Tx);
  const blockhash = await getCachedLatestBlockhash(connection);
  const lookups = vtx.message.addressTableLookups;
  const altAccounts: AddressLookupTableAccount[] = [];

  if (lookups.length > 0) {
    for (const lookup of lookups) {
      const account = await loadAltAccountCached(connection, lookup.accountKey);
      if (!account) {
        throw new Error(`Failed to load address lookup table ${lookup.accountKey.toBase58()}.`);
      }
      altAccounts.push(account);
    }
    const decompiled = TransactionMessage.decompile(vtx.message, {
      addressLookupTableAccounts: altAccounts,
    });
    decompiled.recentBlockhash = blockhash;
    return {
      prepared: new VersionedTransaction(decompiled.compileToV0Message(altAccounts)),
      altAccounts,
    };
  }

  vtx.message.recentBlockhash = blockhash;
  return { prepared: vtx, altAccounts };
}
