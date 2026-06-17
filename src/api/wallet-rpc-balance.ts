/**
 * Live wallet balances from public Solana RPC (source of truth for amounts).
 * Vybe wallet API can lag; metadata (symbol, logo) still comes from Vybe.
 */

import { PublicKey } from '@solana/web3.js';
import { createSolanaConnection } from './solana-connection.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export const RPC_NATIVE_SOL_MINT = '11111111111111111111111111111111';

export interface RpcMintBalance {
  mintAddress: string;
  amountRaw: bigint;
  decimals: number;
}

function mergeParsedTokenAccounts(
  map: Map<string, RpcMintBalance>,
  accounts: Awaited<ReturnType<ReturnType<typeof createSolanaConnection>['getParsedTokenAccountsByOwner']>>,
): void {
  for (const { account } of accounts.value) {
    const parsed = account.data.parsed as
      | {
          type?: string;
          info?: {
            mint?: string;
            tokenAmount?: { amount?: string; decimals?: number };
          };
        }
      | undefined;
    if (!parsed || parsed.type !== 'account' || !parsed.info) continue;
    const mint = String(parsed.info.mint ?? '').trim();
    const amountStr = String(parsed.info.tokenAmount?.amount ?? '').trim();
    if (!mint || !amountStr) continue;
    let amountRaw: bigint;
    try {
      amountRaw = BigInt(amountStr);
    } catch {
      continue;
    }
    if (amountRaw <= 0n) continue;
    const decimals = Number(parsed.info.tokenAmount?.decimals);
    if (!Number.isFinite(decimals) || decimals < 0) continue;
    const existing = map.get(mint);
    if (existing) {
      map.set(mint, {
        mintAddress: mint,
        amountRaw: existing.amountRaw + amountRaw,
        decimals: existing.decimals,
      });
    } else {
      map.set(mint, { mintAddress: mint, amountRaw, decimals });
    }
  }
}

/** Fetch all positive SPL + native SOL balances for a wallet from chain RPC. */
export async function fetchRpcWalletBalances(ownerAddress: string): Promise<Map<string, RpcMintBalance>> {
  const owner = new PublicKey(ownerAddress.trim());
  const connection = createSolanaConnection('wallet-balance-rpc', 'processed');

  const [lamports, splAccounts, token2022Accounts] = await Promise.all([
    connection.getBalance(owner, 'processed'),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const map = new Map<string, RpcMintBalance>();
  if (lamports > 0) {
    map.set(RPC_NATIVE_SOL_MINT, {
      mintAddress: RPC_NATIVE_SOL_MINT,
      amountRaw: BigInt(lamports),
      decimals: 9,
    });
  }
  mergeParsedTokenAccounts(map, splAccounts);
  mergeParsedTokenAccounts(map, token2022Accounts);
  return map;
}
