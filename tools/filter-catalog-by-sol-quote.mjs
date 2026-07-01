#!/usr/bin/env node
/**
 * Filter public/data/token-catalog.{json,tsv} to tokens reachable from native SOL
 * with a simple 0.01 SOL buy (1- or 2-hop Vybe route only).
 *
 * Usage:
 *   npm run filter:catalog
 *   SWAP_API=https://solana-swap-api.vybenetwork.com CATALOG_FILTER_WALLET=... npm run filter:catalog
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  EXCLUDED_JSON,
  excludedMintSet,
  loadExcludedCatalog,
  mergeExcludedCatalog,
} from './token-catalog-excluded.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'data');
const CATALOG_JSON = path.join(OUT_DIR, 'token-catalog.json');
const CATALOG_TSV = path.join(OUT_DIR, 'token-catalog.tsv');

const API = (process.env.SWAP_API || 'https://solana-swap-api.vybenetwork.com').replace(/\/$/, '');
const WALLET =
  process.env.CATALOG_FILTER_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
const SOL_AMOUNT = Number(process.env.CATALOG_FILTER_SOL_AMOUNT || 0.01);
const CONCURRENCY = Math.max(1, Number(process.env.CATALOG_FILTER_CONCURRENCY || 4));
const MAX_HOPS = Math.max(1, Number(process.env.CATALOG_FILTER_MAX_HOPS || 2));

const NATIVE_SOL_MINT = '11111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SKIP_QUOTE_MINTS = new Set([NATIVE_SOL_MINT, WSOL_MINT]);

function escTsv(v) {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function token2022Tag(token) {
  const tp = token.tokenProgram || '';
  const tags = token.tags || [];
  if (tp.includes('TokenzQ') || tags.some((t) => /token-?2022/i.test(t))) return 'Token2022';
  return '';
}

function countSwapHops(body) {
  const plan = Array.isArray(body.routePlan) ? body.routePlan : [];
  if (plan.length > 0) return plan.length;

  const build = body._build;
  if (!build || body._buildUnavailable) return null;

  const details = build.details && typeof build.details === 'object' ? build.details : {};
  const hasPre = Boolean(
    build.preSwapTransaction ||
      details.preSwapTransaction ||
      details.preSwapNeeded === true ||
      build.preSwapNeeded === true,
  );
  const hasPost = Boolean(details.postSwapTransaction || details.postSwapNeeded === true);
  if (hasPre && hasPost) return 3;
  if (hasPre || hasPost) return 2;
  if (build.tx || body.outAmount != null) return 1;
  return null;
}

function quotePasses(body) {
  if (body?.error) return { ok: false, reason: String(body.error) };
  const hops = countSwapHops(body);
  if (hops == null) return { ok: false, reason: 'no build / route' };
  if (hops < 1 || hops > MAX_HOPS) {
    return { ok: false, reason: `${hops} hop(s) — max ${MAX_HOPS}` };
  }
  return { ok: true, hops };
}

async function fetchSolBuyQuote(outputMint) {
  const res = await fetch(`${API}/api/trading/vybe-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountAddress: WALLET,
      amount: SOL_AMOUNT,
      inputMintAddress: NATIVE_SOL_MINT,
      outputMintAddress: outputMint,
      slippage: 2,
      router: 'vybe',
      enumerateRoutes: false,
      marketFetchMode: 'full',
      closeWsolAta: true,
      createOutputAta: true,
    }),
  });
  const body = await res.json();
  if (!res.ok && !body?.error) {
    return { error: `HTTP ${res.status}` };
  }
  return body;
}

async function mapPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => run()));
  return results;
}

function writeCatalog(catalog, meta) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tokens = catalog.tokens;
  const header = `# Vybe swap demo — token catalog (SOL-buy filtered)\n# Source: ${catalog.source ?? 'token-catalog.json'}\n# Filter: ${SOL_AMOUNT} SOL → token via Vybe; keep 1–${MAX_HOPS} hop routes\n# Filtered: ${meta.filteredAt}\n# Denylist: ${path.basename(EXCLUDED_JSON)} (${meta.excludedTotal} mints)\n# Icons: /data/token-icons/\n# Columns: mint\tsymbol\tname\tlogoUrl\tdecimals\ttags\n# Regenerate list: npm run fetch:catalog\n# Re-filter: npm run filter:catalog\n`;
  const rows = tokens.map((t) =>
    [t.mint, t.symbol, t.name, t.logoUrl, t.decimals, token2022Tag(t)].map(escTsv).join('\t'),
  );
  fs.writeFileSync(
    CATALOG_TSV,
    `${header}mint\tsymbol\tname\tlogoUrl\tdecimals\ttags\n${rows.join('\n')}\n`,
  );
  fs.writeFileSync(
    CATALOG_JSON,
    `${JSON.stringify(
      {
        ...catalog,
        count: tokens.length,
        filteredAt: meta.filteredAt,
        filter: {
          inputMint: NATIVE_SOL_MINT,
          amountSol: SOL_AMOUNT,
          maxHops: MAX_HOPS,
          api: API,
          wallet: WALLET,
          removedCount: meta.removed.length,
          removed: meta.removed,
          excludedDenylist: 'public/data/token-catalog-excluded.json',
          excludedTotal: meta.excludedTotal,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  if (!fs.existsSync(CATALOG_JSON)) {
    throw new Error(`Missing ${CATALOG_JSON} — run npm run fetch:catalog first`);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_JSON, 'utf8'));
  const tokens = Array.isArray(catalog.tokens) ? catalog.tokens : [];
  if (tokens.length === 0) throw new Error('Catalog has no tokens');

  const denylisted = excludedMintSet();
  const alreadyExcluded = tokens.filter((t) => denylisted.has(t.mint) && !SKIP_QUOTE_MINTS.has(t.mint));
  if (alreadyExcluded.length > 0) {
    console.log(`Removing ${alreadyExcluded.length} mint(s) already on denylist`);
  }

  const alwaysKeep = tokens.filter((t) => SKIP_QUOTE_MINTS.has(t.mint));
  const toTest = tokens.filter((t) => !SKIP_QUOTE_MINTS.has(t.mint) && !denylisted.has(t.mint));
  const preRemoved = alreadyExcluded.map((t) => {
    const note = loadExcludedCatalog().entries[t.mint];
    return {
      mint: t.mint,
      symbol: t.symbol,
      reason: note?.reason ?? 'on denylist',
    };
  });

  console.log(`API ${API}`);
  console.log(`Wallet ${WALLET}`);
  console.log(`Denylist ${denylisted.size} mint(s) — ${EXCLUDED_JSON}`);
  console.log(`Queue ${toTest.length} SOL→token quotes @ ${SOL_AMOUNT} SOL (${CONCURRENCY} concurrent)`);
  console.log(`Always keep ${alwaysKeep.length} SOL/WSOL entries without quoting`);

  const removed = [...preRemoved];
  const kept = [...alwaysKeep];

  let done = 0;
  const outcomes = await mapPool(toTest, async (token) => {
    const label = `${token.symbol || '?'} (${token.mint.slice(0, 8)}…)`;
    try {
      const body = await fetchSolBuyQuote(token.mint);
      const verdict = quotePasses(body);
      done++;
      if (verdict.ok) {
        console.log(`[${done}/${toTest.length}] keep ${label} — ${verdict.hops} hop(s)`);
        return { token, keep: true };
      }
      console.log(`[${done}/${toTest.length}] drop ${label} — ${verdict.reason}`);
      removed.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: verdict.reason,
      });
      return { token, keep: false };
    } catch (err) {
      done++;
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[${done}/${toTest.length}] drop ${label} — ${reason}`);
      removed.push({ mint: token.mint, symbol: token.symbol, reason });
      return { token, keep: false };
    }
  });

  for (const row of outcomes) {
    if (row?.keep) kept.push(row.token);
  }

  // Preserve original catalog order among kept tokens.
  const keptMints = new Set(kept.map((t) => t.mint));
  const orderedKept = tokens.filter((t) => keptMints.has(t.mint));

  const filteredAt = new Date().toISOString();
  const newlyFailed = removed.filter((r) => !preRemoved.some((p) => p.mint === r.mint));
  if (newlyFailed.length > 0) {
    mergeExcludedCatalog(newlyFailed, 'filter:catalog');
  }
  const excludedTotal = Object.keys(loadExcludedCatalog().entries).length;

  writeCatalog({ ...catalog, tokens: orderedKept }, { filteredAt, removed, excludedTotal });

  console.log('');
  console.log(`Kept ${orderedKept.length}/${tokens.length} tokens`);
  console.log(`Removed ${removed.length} (${newlyFailed.length} new → denylist)`);
  console.log(`Denylist total: ${excludedTotal} mint(s) in ${EXCLUDED_JSON}`);
  console.log(`Wrote ${CATALOG_JSON}`);
  console.log(`Wrote ${CATALOG_TSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
