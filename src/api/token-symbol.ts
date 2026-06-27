/**
 * Token symbol/decimals for route UI labels.
 * Uses token-meta disk cache and resolveTokenMeta (Vybe → pump.fun → Jupiter).
 */

import type { AxiosInstance } from 'axios';
import { resolveTokenMeta } from './resolve-token-meta.js';
import { getCachedTokenMetaFromDisk } from '../token-icon-cache.js';

export const HARDCODED_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'WSOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};

export interface ResolvedTokenSymbol {
  symbol: string;
  decimals?: number;
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
  const hasUsableSymbol = Boolean(symbolFromDisk && symbolFromDisk !== m);
  const hasDecimals = typeof disk?.decimals === 'number' && Number.isFinite(disk.decimals);

  if (hasUsableSymbol && (!options.needDecimals || hasDecimals)) {
    return {
      symbol: symbolFromDisk!,
      ...(options.needDecimals && hasDecimals ? { decimals: disk!.decimals } : {}),
    };
  }

  const meta = await resolveTokenMeta(http, m);
  const sym = meta?.symbol?.trim();
  const symbol = sym && sym !== m ? sym : sym || m;
  return {
    symbol: symbol || m,
    ...(options.needDecimals && typeof meta?.decimals === 'number' ? { decimals: meta.decimals } : {}),
  };
}
