/**
 * Solana RPC helpers — check whether a wallet already has an SPL token account.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createSolanaConnection } from './solana-connection.js';

export const NATIVE_SOL_MINT = '11111111111111111111111111111111';

let connection: Connection | null = null;

function getConnection(): Connection {
  if (!connection) {
    connection = createSolanaConnection('solana-token-account', 'processed');
  }
  return connection;
}

/** Native SOL does not use an associated token account. */
export function isNativeSolMint(mint: string): boolean {
  return mint.trim() === NATIVE_SOL_MINT;
}

export async function walletHasTokenAccountForMint(
  ownerAddress: string,
  mintAddress: string,
): Promise<boolean> {
  const mint = mintAddress.trim();
  if (!mint || isNativeSolMint(mint)) return true;

  const owner = new PublicKey(ownerAddress.trim());
  const mintPk = new PublicKey(mint);
  const resp = await getConnection().getParsedTokenAccountsByOwner(owner, { mint: mintPk });
  return resp.value.length > 0;
}
