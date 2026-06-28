/** Detect placeholder labels where Vybe (or similar) echoes the mint instead of a real name/symbol. */

const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function truncateMintDisplay(mint: string): string {
  if (mint.length <= 13) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function isMintLikeLabel(label: string, mint: string): boolean {
  const s = label.trim();
  if (!s) return true;
  if (s === mint || s === truncateMintDisplay(mint)) return true;
  return BASE58_MINT_RE.test(s) && s.length >= 32;
}
