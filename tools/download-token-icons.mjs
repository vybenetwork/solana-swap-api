#!/usr/bin/env node
/**
 * Download all catalog token icons to public/data/token-icons/ and rewrite catalog paths.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ICON_DIR, localizeCatalogIcons } from './token-icon-download.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');
const JSON_PATH = path.join(DATA_DIR, 'token-catalog.json');
const TSV_PATH = path.join(DATA_DIR, 'token-catalog.tsv');

function escTsv(v) {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function token2022Tag(token) {
  const tags = token.tags ?? [];
  if (Array.isArray(tags) && tags.some((t) => /token-?2022/i.test(String(t)))) return 'Token2022';
  if (typeof tags === 'string' && /token-?2022/i.test(tags)) return 'Token2022';
  return '';
}

async function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error('Missing token-catalog.json — run npm run fetch:catalog first');
    process.exit(1);
  }
  const catalog = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const tokens = Array.isArray(catalog.tokens) ? catalog.tokens : [];
  if (tokens.length === 0) {
    console.error('No tokens in catalog');
    process.exit(1);
  }

  console.log(`Downloading icons for ${tokens.length} tokens → ${ICON_DIR}`);
  const { tokens: updated, downloaded, failed } = await localizeCatalogIcons(tokens, {
    force: process.argv.includes('--force'),
  });

  catalog.tokens = updated;
  catalog.iconsLocalizedAt = new Date().toISOString();
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(catalog, null, 2)}\n`);

  const header = `# Vybe swap demo — token catalog (icons served from /data/token-icons/)\n# Regenerate: npm run fetch:catalog\n`;
  const rows = updated.map((t) =>
    [t.mint, t.symbol, t.name, t.logoUrl, t.decimals, token2022Tag(t)].map(escTsv).join('\t'),
  );
  fs.writeFileSync(
    TSV_PATH,
    `${header}mint\tsymbol\tname\tlogoUrl\tdecimals\ttags\n${rows.join('\n')}\n`,
  );

  console.log(`Done: ${downloaded} local icons, ${failed} failed/missing, wrote catalog files`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
