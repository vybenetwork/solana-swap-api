#!/usr/bin/env node
/**
 * Fetch Jupiter Top token list and write public/data/token-catalog.tsv + .json
 * Source API: https://datapi.jup.ag/v1/assets/search?query=&limit=100
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchJupiterTopTokens, JUPITER_LIMIT, JUPITER_SOURCE } from './lib/jupiter-catalog.mjs';
import { localizeCatalogIcons } from './token-icon-download.mjs';
import { excludedMintSet, loadExcludedCatalog, saveExcludedCatalog } from './token-catalog-excluded.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'data');
const SOURCE = JUPITER_SOURCE;
const LIMIT = JUPITER_LIMIT;

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
  if (process.env.CATALOG_FILTER_RESET_DENYLIST === '1') {
    saveExcludedCatalog({});
    console.log('Reset denylist (CATALOG_FILTER_RESET_DENYLIST=1)');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stripped = await fetchJupiterTopTokens(LIMIT);

  const excluded = excludedMintSet();
  const excludedMeta = loadExcludedCatalog().entries;
  const skipped = stripped.filter((t) => excluded.has(t.mint));
  const eligible = stripped.filter((t) => !excluded.has(t.mint));
  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} mint(s) on denylist (token-catalog-excluded.json):`);
    for (const t of skipped) {
      const note = excludedMeta[t.mint];
      console.log(`  - ${t.symbol || '?'} ${t.mint.slice(0, 8)}… — ${note?.reason ?? 'excluded'}`);
    }
  }

  console.log('Localizing token icons…');
  const { tokens: withIcons, downloaded, failed } = await localizeCatalogIcons(eligible);
  console.log(`Icons: ${downloaded} saved, ${failed} skipped/failed`);

  const header = `# Vybe swap demo — token catalog from Jupiter datapi (Top list)\n# Source: ${SOURCE.replace('100', String(LIMIT))}\n# Denylist: public/data/token-catalog-excluded.json (${excluded.size} mints)\n# Icons: /data/token-icons/ (run npm run download:token-icons to refresh)\n# Columns: mint\tsymbol\tname\tlogoUrl\tdecimals\ttags\n# Regenerate: npm run fetch:catalog\n# Filter routes: npm run filter:catalog\n`;
  const rows = withIcons.map((t) =>
    [t.mint, t.symbol, t.name, t.logoUrl, t.decimals, token2022Tag(t)].map(escTsv).join('\t'),
  );
  fs.writeFileSync(path.join(OUT_DIR, 'token-catalog.tsv'), `${header}mint\tsymbol\tname\tlogoUrl\tdecimals\ttags\n${rows.join('\n')}\n`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'token-catalog.json'),
    `${JSON.stringify(
      {
        source: SOURCE,
        fetchedAt: new Date().toISOString(),
        iconsLocalizedAt: new Date().toISOString(),
        jupiterReturned: stripped.length,
        excludedSkipped: skipped.length,
        excludedDenylist: 'public/data/token-catalog-excluded.json',
        count: withIcons.length,
        tokens: withIcons,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Wrote ${withIcons.length} tokens to public/data/token-catalog.{tsv,json}`);
  if (skipped.length > 0) {
    console.log(`(${skipped.length} Jupiter mint(s) omitted — see token-catalog-excluded.json)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
