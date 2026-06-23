/**
 * On-chain mint decimals via Solana RPC (Helius when HELIUS_API_KEY is set, else public).
 */

import { PublicKey } from '@solana/web3.js';
import { createSolanaConnection } from './solana-connection.js';

function parseMintDecimals(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const info = (parsed as { info?: { decimals?: unknown } }).info;
  const n = typeof info?.decimals === 'number' ? info.decimals : Number(info?.decimals);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/** Fetch token decimals from the mint account on chain. */
export async function fetchMintDecimalsFromRpc(mintAddress: string): Promise<number | null> {
  const mint = mintAddress.trim();
  if (!mint) return null;
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(mint);
  } catch {
    return null;
  }
  const connection = createSolanaConnection('mint-decimals-rpc', 'processed');
  const account = await connection.getParsedAccountInfo(pubkey, 'processed');
  const data = account.value?.data;
  if (!data || typeof data !== 'object' || !('parsed' in data)) return null;
  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const type = String((parsed as { type?: string }).type ?? '');
  if (type !== 'mint') return null;
  return parseMintDecimals(parsed);
}
