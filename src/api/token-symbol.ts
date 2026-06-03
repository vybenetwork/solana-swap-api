/**
 * Resolve token symbol: hardcoded WSOL/USDC, else Metaplex metadata via public mainnet RPC.
 * RPC/account fetches retry on error: 2s delay, up to 3 retries.
 * Caller should fallback to Vybe GET /v4/tokens/{mint} when this returns mint.
 */

import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const RPC_RETRY_DELAY_MS = 2000;
const RPC_MAX_RETRIES = 3;

const HARDCODED_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'WSOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};

/**
 * Get symbol for a mint: hardcoded for WSOL/USDC, otherwise fetches Metaplex metadata.
 * Retries RPC/account fetch on error (2s delay, up to 3 retries).
 * @param mintAddress - Token mint address
 * @returns Symbol string, or mint address if not found
 */
export async function getTokenSymbol(mintAddress: string): Promise<string> {
  const mint = (mintAddress ?? '').trim();
  if (!mint) return '';
  if (HARDCODED_SYMBOLS[mint]) return HARDCODED_SYMBOLS[mint]!;

  const connection = new Connection(RPC_URL);
  for (let attempt = 0; attempt <= RPC_MAX_RETRIES; attempt++) {
    try {
      const mintPubkey = new PublicKey(mint);
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mintPubkey.toBuffer(),
        ],
        METADATA_PROGRAM_ID
      );
      const accountInfo = await connection.getAccountInfo(pda);
      if (!accountInfo?.data?.length) return mint;

      const data = accountInfo.data;
      if (data.length < 69) return mint;
      const nameLen = data.readUInt32LE(65);
      const symbolOffset = 65 + 4 + nameLen;
      if (data.length < symbolOffset + 4) return mint;
      const symbolLen = data.readUInt32LE(symbolOffset);
      if (symbolLen <= 0 || data.length < symbolOffset + 4 + symbolLen) return mint;
      const raw = data.slice(symbolOffset + 4, symbolOffset + 4 + symbolLen).toString('utf8');
      return raw.replace(/\0/g, '').trim() || mint;
    } catch {
      if (attempt < RPC_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RPC_RETRY_DELAY_MS));
        continue;
      }
    }
  }
  return mint;
}
