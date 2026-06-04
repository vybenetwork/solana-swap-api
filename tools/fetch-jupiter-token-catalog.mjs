#!/usr/bin/env node
/**
 * Fetch Jupiter Top token list and write public/data/token-catalog.tsv + .json
 * Source API: https://datapi.jup.ag/v1/assets/search?query=&limit=100
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'data');
const SOURCE = 'https://datapi.jup.ag/v1/assets/search?query=&limit=100';
const LIMIT = Number(process.env.JUP_CATALOG_LIMIT || 100);

function stripPriceFields(token) {
  return {
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    logoUrl: token.icon,
    decimals: token.decimals,
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

function token2022Tag(token) {
  const tp = token.tokenProgram || '';
  const tags = token.tags || [];
  if (tp.includes('TokenzQ') || tags.some((t) => /token-?2022/i.test(t))) return 'Token2022';
  return '';
}

function escTsv(v) {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

async function main() {
  const res = await fetch(`${SOURCE.replace('limit=100', `limit=${LIMIT}`)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tokens = await res.json();
  if (!Array.isArray(tokens)) throw new Error('Unexpected response');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stripped = tokens.map(stripPriceFields);

  const header = `# Vybe swap demo — token catalog from Jupiter datapi (Top list)\n# Source: ${SOURCE.replace('100', String(LIMIT))}\n# Columns: mint\tsymbol\tname\tlogoUrl\tdecimals\ttags\n# Regenerate: npm run fetch:catalog\n`;
  const rows = tokens.map((t) =>
    [t.id, t.symbol, t.name, t.icon, t.decimals, token2022Tag(t)].map(escTsv).join('\t'),
  );
  fs.writeFileSync(path.join(OUT_DIR, 'token-catalog.tsv'), `${header}mint\tsymbol\tname\tlogoUrl\tdecimals\ttags\n${rows.join('\n')}\n`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'token-catalog.json'),
    `${JSON.stringify({ source: SOURCE, fetchedAt: new Date().toISOString(), count: stripped.length, tokens: stripped }, null, 2)}\n`,
  );

  console.log(`Wrote ${tokens.length} tokens to public/data/token-catalog.{tsv,json}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
