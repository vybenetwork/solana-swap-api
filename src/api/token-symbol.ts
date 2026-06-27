/**
 * Token symbol/decimals for route UI labels.
 * resolveTokenMeta (Vybe → pump.fun → Jupiter) → Metaplex on-chain → truncated mint.
 */

import { PublicKey } from '@solana/web3.js';
import type { AxiosInstance } from 'axios';
import { resolveTokenMeta } from './resolve-token-meta.js';
import { createSolanaConnection } from './solana-connection.js';
import { getCachedTokenMetaFromDisk } from '../token-icon-cache.js';

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const RPC_RETRY_DELAY_MS = 2000;
const RPC_MAX_RETRIES = 3;

export const HARDCODED_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'WSOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};

export interface ResolvedTokenSymbol {
  symbol: string;
  decimals?: number;
}

export function isStubTokenSymbol(mint: string, symbol: string | undefined): boolean {
  const m = mint.trim();
  const sym = symbol?.trim() ?? '';
  if (!sym || sym === m) return true;
  if (sym === m.slice(0, 6)) return true;
  if (sym.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(sym)) return true;
  return false;
}

export function truncateMintForDisplay(mint: string): string {
  const m = mint.trim();
  if (m.length <= 13) return m;
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

/** Metaplex metadata symbol (fast on-chain fallback). */
export async function getTokenSymbolFromMetaplex(mintAddress: string): Promise<string> {
  const mint = (mintAddress ?? '').trim();
  if (!mint) return '';
  if (HARDCODED_SYMBOLS[mint]) return HARDCODED_SYMBOLS[mint]!;

  const connection = createSolanaConnection('token-symbol');
  for (let attempt = 0; attempt <= RPC_MAX_RETRIES; attempt++) {
    try {
      const mintPubkey = new PublicKey(mint);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
        METADATA_PROGRAM_ID,
      );
      const accountInfo = await connection.getAccountInfo(pda);
      if (!accountInfo?.data?.length) return '';

      const data = accountInfo.data;
      if (data.length < 69) return '';
      const nameLen = data.readUInt32LE(65);
      const symbolOffset = 65 + 4 + nameLen;
      if (data.length < symbolOffset + 4) return '';
      const symbolLen = data.readUInt32LE(symbolOffset);
      if (symbolLen <= 0 || data.length < symbolOffset + 4 + symbolLen) return '';
      const raw = data.slice(symbolOffset + 4, symbolOffset + 4 + symbolLen).toString('utf8');
      const sym = raw.replace(/\0/g, '').trim();
      return isStubTokenSymbol(mint, sym) ? '' : sym;
    } catch {
      if (attempt < RPC_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RPC_RETRY_DELAY_MS));
        continue;
      }
    }
  }
  return '';
}

export async function resolveTokenSymbol(
  http: AxiosInstance,
  mint: string,
  options: { needDecimals?: boolean } = {},
): Promise<ResolvedTokenSymbol> {
  const m = mint.trim();
  if (!m) return { symbol: '' };

  if (HARDCODED_SYMBOLS[m]) {
    const disk = getCachedTokenMetaFromDisk(m);
    return {
      symbol: HARDCODED_SYMBOLS[m]!,
      ...(options.needDecimals
        ? { decimals: disk?.decimals ?? (m.startsWith('So111') ? 9 : 6) }
        : {}),
    };
  }

  const disk = getCachedTokenMetaFromDisk(m);
  const symbolFromDisk = disk?.symbol?.trim();
  const hasUsableSymbol = Boolean(symbolFromDisk && !isStubTokenSymbol(m, symbolFromDisk));
  const hasDecimals = typeof disk?.decimals === 'number' && Number.isFinite(disk.decimals);

  if (hasUsableSymbol && (!options.needDecimals || hasDecimals)) {
    return {
      symbol: symbolFromDisk!,
      ...(options.needDecimals && hasDecimals ? { decimals: disk!.decimals } : {}),
    };
  }

  let decimals = disk?.decimals;
  let symbol = '';

  try {
    const meta = await resolveTokenMeta(http, m);
    if (typeof meta?.decimals === 'number' && Number.isFinite(meta.decimals)) {
      decimals = meta.decimals;
    }
    const sym = meta?.symbol?.trim();
    if (sym && !isStubTokenSymbol(m, sym)) symbol = sym;
  } catch {
    /* try Metaplex */
  }

  if (!symbol) {
    const metaplex = await getTokenSymbolFromMetaplex(m);
    if (metaplex) symbol = metaplex;
  }

  if (!symbol) {
    symbol = truncateMintForDisplay(m);
  }

  return {
    symbol,
    ...(options.needDecimals && typeof decimals === 'number' ? { decimals } : {}),
  };
}
