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
]);

export function isIxBuilderQuoteToken(mint: string): boolean {
  const m = mint.trim();
  if (IX_BUILDER_QUOTE_TOKEN_MINTS.has(m)) return true;
  return IX_BUILDER_QUOTE_TOKEN_MINTS.has(toVybeSwapMint(m));
}
