/**
 * Persistent denylist for token-catalog mints that failed SOL-buy quote checks.
 * Stored at public/data/token-catalog-excluded.json — survives npm run fetch:catalog.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXCLUDED_JSON = path.join(__dirname, '..', 'public', 'data', 'token-catalog-excluded.json');

/** @typedef {{ symbol?: string, reason: string, excludedAt: string, source: string }} ExcludedEntry */

/**
 * @returns {{ version: number, entries: Record<string, ExcludedEntry> }}
 */
export function loadExcludedCatalog() {
  if (!fs.existsSync(EXCLUDED_JSON)) {
    return { version: 1, entries: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(EXCLUDED_JSON, 'utf8'));
    if (raw && typeof raw.entries === 'object' && raw.entries !== null) {
      return { version: 1, entries: raw.entries };
    }
  } catch {
    /* corrupt file — start fresh below */
  }
  return { version: 1, entries: {} };
}

/**
 * @param {Record<string, ExcludedEntry>} entries
 */
export function saveExcludedCatalog(entries) {
  const dir = path.dirname(EXCLUDED_JSON);
  fs.mkdirSync(dir, { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.writeFileSync(
    EXCLUDED_JSON,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        description:
          'Mints excluded from token-catalog after failing 0.01 SOL Vybe buy (1–2 hop). Skipped on fetch:catalog.',
        count: Object.keys(sorted).length,
        entries: sorted,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * @param {Array<{ mint: string, symbol?: string, reason: string }>} failures
 * @param {string} source
 */
export function mergeExcludedCatalog(failures, source = 'filter:catalog') {
  const store = loadExcludedCatalog();
  const now = new Date().toISOString();
  for (const row of failures) {
    const mint = row.mint?.trim();
    if (!mint) continue;
    store.entries[mint] = {
      symbol: row.symbol,
      reason: row.reason,
      excludedAt: now,
      source,
    };
  }
  saveExcludedCatalog(store.entries);
  return store.entries;
}

export function excludedMintSet() {
  return new Set(Object.keys(loadExcludedCatalog().entries));
}

export function isExcludedMint(mint) {
  return excludedMintSet().has(mint.trim());
}
