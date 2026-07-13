/**
 * Vetted quote tokens (SOL/WSOL + stablecoins) from ix-builder-api.
 * @see ix-builder-api-main-nodejs/src/services/scan.js QUOTE_TOKENS
 */

import { toVybeSwapMint } from './sol-mints.js';

/** SOL, WSOL, and ix-builder vetted stablecoins. */
export const IX_BUILDER_QUOTE_TOKEN_MINTS: ReadonlySet<string> = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  '11111111111111111111111111111111', // Native SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'JEFFSQ3s8T3wKsvp4tnRAsUBW7Cqgnf8ukBZC4C8XBm1', // sUSDC-9
  'Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1', // USDTen
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', // UXD
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', // USDH
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', // USDCet
  'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', // USDY
  'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', // USDe
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', // JupUSD
  'yUSDX7W89jXWn4zzDPLnhykDymSjQSmpaJ8e4fjC1fg', // yUSD
]);

/** Human-readable labels for common-quote guard errors. */
export const COMMON_QUOTE_TOKEN_LABELS: ReadonlyArray<{ mint: string; symbol: string }> = [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'WSOL' },
  { mint: '11111111111111111111111111111111', symbol: 'SOL' },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
  { mint: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', symbol: 'USD1' },
  { mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', symbol: 'PYUSD' },
  { mint: 'JEFFSQ3s8T3wKsvp4tnRAsUBW7Cqgnf8ukBZC4C8XBm1', symbol: 'sUSDC-9' },
  { mint: 'Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1', symbol: 'USDTen' },
  { mint: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', symbol: 'UXD' },
  { mint: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', symbol: 'USDH' },
  { mint: 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', symbol: 'USDCet' },
  { mint: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', symbol: 'USDY' },
  { mint: 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', symbol: 'USDe' },
  { mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', symbol: 'USDG' },
  { mint: 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', symbol: 'JupUSD' },
  { mint: 'yUSDX7W89jXWn4zzDPLnhykDymSjQSmpaJ8e4fjC1fg', symbol: 'yUSD' },
];

export function isIxBuilderQuoteToken(mint: string): boolean {
  const m = mint.trim();
  if (IX_BUILDER_QUOTE_TOKEN_MINTS.has(m)) return true;
  return IX_BUILDER_QUOTE_TOKEN_MINTS.has(toVybeSwapMint(m));
}

/** Both mints are vetted quote tokens (SOL/WSOL/stables) — RPC scan is not applicable. */
export function isCommonQuotePair(inputMint: string, outputMint: string): boolean {
  return isIxBuilderQuoteToken(inputMint) && isIxBuilderQuoteToken(outputMint);
}

export function commonQuoteTokenSymbolsList(): string {
  return COMMON_QUOTE_TOKEN_LABELS.map((t) => t.symbol).join(', ');
}

export function rpcScanUnsupportedForCommonQuotesError(): string {
  return (
    `RPC pool scanning is not supported when both sides are common quote tokens. ` +
    `Supported common quotes: ${commonQuoteTokenSymbolsList()}. ` +
    `Use marketFetchMode "full", "trades", or "markets" to route via ClickHouse/Vybe instead.`
  );
}
