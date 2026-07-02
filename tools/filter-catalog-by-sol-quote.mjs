#!/usr/bin/env node
/**
 * Filter public/data/token-catalog.{json,tsv} to tokens reachable from native SOL
 * with a simple 0.01 SOL buy (1- or 2-hop Vybe route only).
 *
 * Quotes go through swap-api POST /api/trading/vybe-quote — same path as the UI
 * (native SOL inputMintAddress; server maps SOL→WSOL + ATA hints + enrich).
 *
 * Usage:
 *   npm run filter:catalog
 *   SWAP_API=http://127.0.0.1:3007 npm run filter:catalog
 *   CATALOG_FILTER_RESET_DENYLIST=1 npm run filter:catalog   # re-test all mints
 *   CATALOG_FILTER_SOLSCAN=0 npm run filter:catalog          # skip Solscan scrape
 *   CATALOG_FILTER_JUPITER=0 npm run filter:catalog          # only tokens already in catalog
 *   CATALOG_FILTER_SKIP_DENYLIST=1 npm run filter:catalog     # skip re-testing denylisted mints
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  EXCLUDED_JSON,
  excludedMintSet,
  loadExcludedCatalog,
  mergeExcludedCatalog,
  saveExcludedCatalog,
} from './token-catalog-excluded.mjs';
import { fetchSolscanMarketsForToken } from './lib/fetch-solscan-markets.mjs';
import { fetchJupiterTopTokens, JUPITER_LIMIT, mergeCatalogWithJupiter } from './lib/jupiter-catalog.mjs';
import {
  compareRouteToSolscan,
  extractSelectedRoute,
} from './lib/swap-api-quote-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'data');
const CATALOG_JSON = path.join(OUT_DIR, 'token-catalog.json');
const CATALOG_TSV = path.join(OUT_DIR, 'token-catalog.tsv');
const DEBUG_FAILURES_TSV = path.join(OUT_DIR, 'token-catalog-filter-failures.tsv');
const FILTER_REPORT_JSON = path.join(OUT_DIR, 'token-catalog-filter-report.json');

const API = (process.env.SWAP_API || 'http://127.0.0.1:3007').replace(/\/$/, '');
const WALLET =
  process.env.CATALOG_FILTER_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
const SOL_AMOUNT = Number(process.env.CATALOG_FILTER_SOL_AMOUNT || 0.01);
const SOLSCAN_ENABLED = process.env.CATALOG_FILTER_SOLSCAN !== '0';
const CONCURRENCY = SOLSCAN_ENABLED
  ? 1
  : Math.max(1, Number(process.env.CATALOG_FILTER_CONCURRENCY || 1));
const MAX_HOPS = Math.max(1, Number(process.env.CATALOG_FILTER_MAX_HOPS || 2));
const INCLUDE_JUPITER = process.env.CATALOG_FILTER_JUPITER !== '0';
const RETEST_DENYLISTED = process.env.CATALOG_FILTER_SKIP_DENYLIST !== '1';

const NATIVE_SOL_MINT = '11111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;
const SKIP_QUOTE_MINTS = new Set([NATIVE_SOL_MINT, WSOL_MINT]);

function mintsForPriceResolve(outputMint) {
  const m = outputMint.trim();
  const mints = [WSOL_MINT];
  if (m && m !== WSOL_MINT && m !== NATIVE_SOL_MINT && !mints.includes(m)) mints.push(m);
  return mints;
}

function pickPriceStats(stats, mint) {
  if (!stats || typeof stats !== 'object') return null;
  const row =
    stats[mint] ??
    (mint === NATIVE_SOL_MINT ? stats[WSOL_MINT] : mint === WSOL_MINT ? stats[NATIVE_SOL_MINT] : undefined);
  if (!row || typeof row !== 'object') return null;
  const price = typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 ? row.price : undefined;
  const decimals =
    typeof row.decimals === 'number' && Number.isFinite(row.decimals) ? row.decimals : undefined;
  return { price, decimals };
}

function isSolMint(mint) {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

function walletHasMint(items, mint) {
  const m = mint.trim();
  return items.some((i) => String(i.mintAddress ?? '').trim() === m);
}

/** Mirror frontend buildSwapAtaHintsFromSessionBalances for Vybe SOL buys. */
function buildAtaHintsFromWalletItems(items, inputMint, outputMint, amountUi) {
  const input = inputMint.trim();
  const output = outputMint.trim();
  const closeWsolAta = !walletHasMint(items, WSOL_MINT);

  let amount = amountUi;
  let closeInputAta = false;
  let inputBalanceExact;
  let inputDecimals;

  if (!isSolMint(input)) {
    const inputRow = items.find((i) => String(i.mintAddress ?? '').trim() === input);
    if (inputRow) {
      inputBalanceExact = String(inputRow.amountExact ?? '')
        .trim()
        .replace(/,/g, '') || undefined;
      inputDecimals =
        typeof inputRow.decimals === 'number' && Number.isFinite(inputRow.decimals)
          ? inputRow.decimals
          : undefined;
    }
  }

  let createOutputAta;
  if (!isSolMint(output) && output !== WSOL_MINT) {
    createOutputAta = !walletHasMint(items, output);
  }

  return {
    closeWsolAta,
    createOutputAta,
    closeInputAta,
    amount,
    inputBalanceExact,
    inputDecimals,
  };
}

async function fetchWalletBalancesOnce() {
  const res = await fetch(`${API}/api/wallets/${encodeURIComponent(WALLET)}/token-balances`, {
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `token-balances HTTP ${res.status}`);
  }
  return Array.isArray(body.tokens) ? body.tokens : [];
}

async function resolvePricesForPair(outputMint) {
  const mints = mintsForPriceResolve(outputMint);
  const res = await fetch(`${API}/api/tokens/resolve-prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mints }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `resolve-prices HTTP ${res.status}`);
  }
  return body.stats && typeof body.stats === 'object' ? body.stats : {};
}

/** Match frontend vybe-quote after resolve-prices + wallet ATA hints + buildSwapClientParams. */
function buildFrontendVybeQuoteBody(outputMint, priceHints, catalogDecimals, ataHints) {
  const inputStats = pickPriceStats(priceHints, NATIVE_SOL_MINT);
  const outputStats = pickPriceStats(priceHints, outputMint);
  const slippage = Number(process.env.CATALOG_FILTER_SLIPPAGE || 2);
  const hints = ataHints ?? {
    closeWsolAta: true,
    createOutputAta: true,
    closeInputAta: false,
    amount: SOL_AMOUNT,
  };
  return {
    accountAddress: WALLET,
    amount: hints.amount ?? SOL_AMOUNT,
    inputMintAddress: NATIVE_SOL_MINT,
    outputMintAddress: outputMint,
    slippage: Number.isFinite(slippage) ? slippage : 2,
    router: 'vybe',
    gasless: false,
    autoCalculateSlippage: false,
    marketFetchMode: 'full',
    enumerateRoutes: true,
    swapFee: 0,
    ...(hints.closeWsolAta === true ? { closeWsolAta: true } : { closeWsolAta: false }),
    ...(typeof hints.createOutputAta === 'boolean' ? { createOutputAta: hints.createOutputAta } : {}),
    closeInputAta: hints.closeInputAta === true,
    enrich: true,
    ...(inputStats?.price != null ? { inputMintPrice: inputStats.price } : {}),
    ...(outputStats?.price != null ? { outputMintPrice: outputStats.price } : {}),
    ...(hints.inputBalanceExact ? { inputBalanceExact: hints.inputBalanceExact } : {}),
    inputMintDecimals: hints.inputDecimals ?? inputStats?.decimals ?? SOL_DECIMALS,
    ...(outputStats?.decimals != null
      ? { outputMintDecimals: outputStats.decimals }
      : catalogDecimals != null
        ? { outputMintDecimals: catalogDecimals }
        : {}),
  };
}

async function waitForSwapApi(maxSec = 90) {
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    try {
      const root = await fetch(`${API}/`, { signal: AbortSignal.timeout(5_000) });
      if (!root.ok) throw new Error(`HTTP ${root.status}`);
      const priceHints = await resolvePricesForPair('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
      const res = await fetch(`${API}/api/trading/vybe-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildFrontendVybeQuoteBody('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', priceHints, 5),
        ),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.json().catch(() => ({}));
      const outAmount =
        body?.outAmount ??
        body?._build?.details?.quote?.outAmount ??
        body?._build?.enrichment?.quotedOutRaw;
      if (res.ok && outAmount) return;
      if (!res.ok) {
        console.warn(`swap-api probe: HTTP ${res.status} — ${body?.error ?? 'no error body'}`);
      }
    } catch (err) {
      console.warn(`swap-api probe: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `swap-api not ready at ${API} — need swap-api :3007, Rust Vybe :8090, ix-builder :8000. ` +
      `Set VYBE_API_BASE=http://127.0.0.1:8090 and your 48-char staging VYBE_API_KEY in .env.`,
  );
}

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

async function fetchSolBuyQuote(token, walletItems) {
  let priceHints = {};
  try {
    priceHints = await resolvePricesForPair(token.mint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `resolve-prices failed: ${msg}` };
  }
  const ataHints = buildAtaHintsFromWalletItems(
    walletItems,
    NATIVE_SOL_MINT,
    token.mint,
    SOL_AMOUNT,
  );
  const res = await fetch(`${API}/api/trading/vybe-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      buildFrontendVybeQuoteBody(token.mint, priceHints, token.decimals, ataHints),
    ),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: `Invalid JSON (HTTP ${res.status}): ${text.slice(0, 120)}` };
  }
  if (!res.ok && !body?.error) {
    return { error: body?.message || `HTTP ${res.status}` };
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

function writeDebugFailuresList(removed, filteredAt) {
  const header =
    `# SOL-buy filter failures — debug list\n` +
    `# Filtered: ${filteredAt}\n` +
    `# Quote: token-balances + resolve-prices → vybe-quote` +
    (SOLSCAN_ENABLED ? ' + Solscan #markets (TVL top 100)' : '') +
    `\n# Columns: mint\tsymbol\treason\tsolscanEligible\tsolPairEligible\teligibleRank\teligibleTotal\tselectedTvlUsd\tassessment\n`;
  const rows = removed.map((r) =>
    [
      r.mint,
      r.symbol ?? '',
      r.reason,
      r.solscanEligible ?? '',
      r.solPairEligible ?? '',
      r.eligibleRank ?? '',
      r.eligibleTotal ?? '',
      r.selectedTvlUsd ?? '',
      r.routeAssessment ?? '',
    ]
      .map(escTsv)
      .join('\t'),
  );
  fs.writeFileSync(DEBUG_FAILURES_TSV, `${header}${rows.join('\n')}\n`);
}

function writeFilterReport(report) {
  fs.writeFileSync(FILTER_REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
}

async function attachSolscanContext(token, quoteBody, verdict) {
  if (!SOLSCAN_ENABLED) return { solscan: null, comparison: null };
  const solscan = await fetchSolscanMarketsForToken({
    mint: token.mint,
    symbol: token.symbol,
    catalogStatus: verdict.ok ? 'kept' : 'failed',
    filterReason: verdict.ok ? null : verdict.reason,
  });
  const comparison = compareRouteToSolscan(extractSelectedRoute(quoteBody), solscan, token.mint, token.symbol);
  return { solscan, comparison };
}

function solscanLogSuffix(comparison) {
  if (!comparison?.assessmentDetail) return '';
  return comparison.assessmentDetail;
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
          marketFetchMode: 'full',
          enumerateRoutes: true,
          api: API,
          wallet: WALLET,
          removedCount: meta.removed.length,
          removed: meta.removed,
          excludedDenylist: 'public/data/token-catalog-excluded.json',
          debugFailuresList: 'public/data/token-catalog-filter-failures.tsv',
          excludedTotal: meta.excludedTotal,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  if (process.env.CATALOG_FILTER_RESET_DENYLIST === '1') {
    saveExcludedCatalog({});
    console.log(`Reset denylist → ${EXCLUDED_JSON}`);
  }

  console.log(`Waiting for swap-api at ${API}…`);
  await waitForSwapApi();

  console.log(`Fetching wallet balances for ${WALLET}…`);
  const walletItems = await fetchWalletBalancesOnce();
  const wsolHeld = walletHasMint(walletItems, WSOL_MINT);
  console.log(
    `Wallet ${walletItems.length} token row(s) — WSOL ATA ${wsolHeld ? 'open (closeWsolAta=false)' : 'absent (closeWsolAta=true)'}`,
  );

  if (!fs.existsSync(CATALOG_JSON)) {
    throw new Error(`Missing ${CATALOG_JSON} — run npm run fetch:catalog first`);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_JSON, 'utf8'));
  let tokens = Array.isArray(catalog.tokens) ? catalog.tokens : [];
  if (tokens.length === 0) throw new Error('Catalog has no tokens');

  const catalogCount = tokens.length;
  if (INCLUDE_JUPITER) {
    console.log(`Fetching Jupiter top ${JUPITER_LIMIT}…`);
    const jupiter = await fetchJupiterTopTokens();
    tokens = mergeCatalogWithJupiter(tokens, jupiter);
    const added = tokens.length - catalogCount;
    console.log(
      `Merged Jupiter ${jupiter.length} + catalog ${catalogCount} → ${tokens.length} token(s)` +
        (added > 0 ? ` (+${added} not in catalog — includes previously filtered)` : ''),
    );
  }

  const denylisted = excludedMintSet();
  const alreadyExcluded = RETEST_DENYLISTED
    ? []
    : tokens.filter((t) => denylisted.has(t.mint) && !SKIP_QUOTE_MINTS.has(t.mint));
  if (alreadyExcluded.length > 0) {
    console.log(`Removing ${alreadyExcluded.length} mint(s) already on denylist`);
  }

  const alwaysKeep = tokens.filter((t) => SKIP_QUOTE_MINTS.has(t.mint));
  const toTest = tokens.filter((t) => {
    if (SKIP_QUOTE_MINTS.has(t.mint)) return false;
    if (!RETEST_DENYLISTED && denylisted.has(t.mint)) return false;
    return true;
  });
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
  if (RETEST_DENYLISTED && denylisted.size > 0) {
    const retest = toTest.filter((t) => denylisted.has(t.mint)).length;
    if (retest > 0) console.log(`Re-testing ${retest} previously denylisted mint(s)`);
  }
  console.log(`Queue ${toTest.length} SOL→token quotes @ ${SOL_AMOUNT} SOL (${CONCURRENCY} concurrent)`);
  if (SOLSCAN_ENABLED) {
    console.log(`Solscan: scrape #markets per token (serial — top 100 by TVL)`);
  }
  console.log(`Always keep ${alwaysKeep.length} SOL/WSOL entries without quoting`);

  const removed = [...preRemoved];
  const kept = [...alwaysKeep];
  const filterRows = [];

  let done = 0;
  const outcomes = await mapPool(toTest, async (token) => {
    const label = `${token.symbol || '?'} (${token.mint.slice(0, 8)}…)`;
    try {
      const body = await fetchSolBuyQuote(token, walletItems);
      const verdict = quotePasses(body);
      let solscan = null;
      let comparison = null;
      if (SOLSCAN_ENABLED) {
        try {
          ({ solscan, comparison } = await attachSolscanContext(token, body, verdict));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          solscan = { error: msg };
        }
      }
      done++;
      const solSuffix = solscanLogSuffix(comparison);
      if (verdict.ok) {
        const routeNote = comparison?.assessmentDetail ?? '';
        console.log(`[${done}/${toTest.length}] keep ${label} — ${verdict.hops} hop(s)${routeNote}`);
        filterRows.push({
          mint: token.mint,
          symbol: token.symbol,
          kept: true,
          hops: verdict.hops,
          reason: null,
          solscanSummary: solscan?.summary ?? null,
          comparison: comparison ?? null,
        });
        return { token, keep: true };
      }
      console.log(`[${done}/${toTest.length}] drop ${label} — ${verdict.reason}${solSuffix}`);
      const rank = comparison?.selectedEligibleRank;
      removed.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: verdict.reason,
        solscanEligible: comparison?.solscanEligibleCount ?? solscan?.summary?.eligibleCount ?? '',
        solPairEligible: comparison?.solscanSolPairEligibleCount ?? solscan?.summary?.solPairEligibleCount ?? '',
        eligibleRank: rank?.rank ?? '',
        eligibleTotal: rank?.totalEligible ?? '',
        selectedTvlUsd: rank?.tvlUsd ?? '',
        routeAssessment: comparison?.assessment ?? '',
      });
      filterRows.push({
        mint: token.mint,
        symbol: token.symbol,
        kept: false,
        hops: countSwapHops(body),
        reason: verdict.reason,
        solscanSummary: solscan?.summary ?? null,
        solscanUrl: solscan?.solscanUrl ?? null,
        eligibleRanked: comparison?.eligibleRanked ?? null,
        comparison: comparison ?? null,
        solscanError: solscan?.error ?? null,
      });
      return { token, keep: false };
    } catch (err) {
      done++;
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[${done}/${toTest.length}] drop ${label} — ${reason}`);
      removed.push({ mint: token.mint, symbol: token.symbol, reason });
      filterRows.push({ mint: token.mint, symbol: token.symbol, kept: false, reason, error: reason });
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
  writeDebugFailuresList(removed, filteredAt);
  writeFilterReport({
    filteredAt,
    api: API,
    solscanEnabled: SOLSCAN_ENABLED,
    jupiterMerged: INCLUDE_JUPITER,
    catalogCount,
    mergedCount: tokens.length,
    tokenCount: tokens.length,
    testedCount: toTest.length,
    keptCount: orderedKept.length,
    removedCount: removed.length,
    newlyFailedCount: newlyFailed.length,
    rows: filterRows,
  });

  console.log('');
  console.log(`Kept ${orderedKept.length}/${tokens.length} tokens`);
  console.log(`Removed ${removed.length} (${newlyFailed.length} new → denylist)`);
  console.log(`Denylist total: ${excludedTotal} mint(s) in ${EXCLUDED_JSON}`);
  console.log(`Wrote ${DEBUG_FAILURES_TSV}`);
  if (SOLSCAN_ENABLED) console.log(`Wrote ${FILTER_REPORT_JSON}`);
  console.log(`Wrote ${CATALOG_JSON}`);
  console.log(`Wrote ${CATALOG_TSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
