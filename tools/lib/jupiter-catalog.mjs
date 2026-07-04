/**
 * Jupiter datapi top-token list — shared by fetch:catalog and filter:catalog.
 */
export const JUPITER_SOURCE = 'https://datapi.jup.ag/v1/assets/search?query=&limit=100';
export const JUPITER_LIMIT = Number(process.env.JUP_CATALOG_LIMIT || 100);

const NATIVE_SOL_MINT = '11111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Jupiter lists SOL as the WSOL mint. Catalog/TOP UI uses native SOL so it is selectable
 * (WSOL mint is blocked in the picker with "Use SOL"). Quote queues still skip SOL→SOL.
 */
export function catalogMintForJupiterToken(mint) {
  const m = String(mint ?? '').trim();
  return m === WSOL_MINT ? NATIVE_SOL_MINT : m;
}

export function stripJupiterToken(token) {
  const mint = catalogMintForJupiterToken(token.id);
  const isNativeSol = mint === NATIVE_SOL_MINT;
  return {
    mint,
    symbol: isNativeSol ? 'SOL' : token.symbol,
    name: isNativeSol ? 'Solana' : token.name,
    logoUrl: token.icon,
    decimals: isNativeSol ? 9 : token.decimals,
    tokenProgram: token.tokenProgram,
    isVerified: token.isVerified,
    organicScore: token.organicScore,
    organicScoreLabel: token.organicScoreLabel,
    tags: token.tags,
    holderCount: token.holderCount,
    issuer: token.issuer,
    twitter: token.twitter,
    website: token.website,
  };
}

export async function fetchJupiterTopTokens(limit = JUPITER_LIMIT) {
  const url = JUPITER_SOURCE.replace('limit=100', `limit=${limit}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter datapi HTTP ${res.status}`);
  const tokens = await res.json();
  if (!Array.isArray(tokens)) throw new Error('Jupiter datapi returned unexpected payload');
  return tokens.map(stripJupiterToken);
}

/** Jupiter order first; keep catalog-only mints at the end; prefer catalog row when both exist. */
export function mergeCatalogWithJupiter(catalogTokens, jupiterTokens) {
  const byMint = new Map(catalogTokens.map((t) => [t.mint, t]));
  const merged = [];
  const seen = new Set();

  for (const j of jupiterTokens) {
    merged.push(byMint.get(j.mint) ?? j);
    seen.add(j.mint);
  }
  for (const t of catalogTokens) {
    if (!seen.has(t.mint)) merged.push(t);
  }
  return merged;
}
