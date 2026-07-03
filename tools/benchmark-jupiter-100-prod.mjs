#!/usr/bin/env node
/**
 * Jupiter top-100 SOL-buy benchmark via swap-api vybe-quote (prod or local).
 * Does NOT modify token-catalog.json or denylist — writes timing report only.
 *
 * Usage:
 *   npm run benchmark:jupiter-100:prod
 *   SWAP_API=https://solana-swap-api.vybenetwork.com npm run benchmark:jupiter-100:prod
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchJupiterTopTokens } from './lib/jupiter-catalog.mjs';
import { NATIVE_SOL_MINT } from './lib/ix-builder-programs.mjs';
import {
  API,
  WALLET,
  SOL_AMOUNT,
  MAX_HOPS,
  QUOTE_TIMEOUT_MS,
  isSolMint,
  buildAtaHintsFromWalletItems,
  buildFrontendVybeQuoteBody,
  resolvePricesForPair,
  countSwapHops,
  extractBuildTxMetrics,
} from './lib/swap-api-quote-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'data');
const OUT_JSON = path.join(OUT_DIR, process.env.BENCHMARK_OUT_JSON || 'token-catalog-benchmark-prod.json');
const OUT_TSV = path.join(OUT_DIR, process.env.BENCHMARK_OUT_TSV || 'token-catalog-benchmark-prod.tsv');

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
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

async function fetchWalletBalances() {
  const t0 = nowMs();
  const res = await fetch(`${API}/api/wallets/${encodeURIComponent(WALLET)}/token-balances`, {
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `token-balances HTTP ${res.status}`);
  return { items: Array.isArray(body.tokens) ? body.tokens : [], ms: nowMs() - t0 };
}

async function timedQuote(token, walletItems) {
  const totalT0 = nowMs();
  let pricesMs = 0;
  let quoteMs = 0;
  let priceHints = {};
  let priceError = null;

  const pricesT0 = nowMs();
  try {
    priceHints = await resolvePricesForPair(token.mint);
  } catch (err) {
    priceError = err instanceof Error ? err.message : String(err);
  }
  pricesMs = nowMs() - pricesT0;

  if (priceError) {
    return {
      kept: false,
      reason: `resolve-prices failed: ${priceError}`,
      pricesMs,
      quoteMs: 0,
      totalMs: nowMs() - totalT0,
    };
  }

  const ataHints = buildAtaHintsFromWalletItems(
    walletItems,
    NATIVE_SOL_MINT,
    token.mint,
    SOL_AMOUNT,
  );

  const quoteT0 = nowMs();
  let body;
  let httpStatus = 0;
  try {
    const res = await fetch(`${API}/api/trading/vybe-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildFrontendVybeQuoteBody(token.mint, priceHints, token.decimals, ataHints),
      ),
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });
    httpStatus = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: `Invalid JSON (HTTP ${res.status}): ${text.slice(0, 120)}` };
    }
    if (!res.ok && !body?.error) {
      body = { error: body?.message || `HTTP ${res.status}` };
    }
  } catch (err) {
    quoteMs = nowMs() - quoteT0;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kept: false,
      reason: msg,
      pricesMs,
      quoteMs,
      totalMs: nowMs() - totalT0,
      httpStatus,
    };
  }
  quoteMs = nowMs() - quoteT0;

  const verdict = quotePasses(body);
  const tx = extractBuildTxMetrics(body);
  const provider =
    body._build?.provider ??
    body._build?.details?.quote?.provider ??
    body._effectiveRouter ??
    '';

  return {
    kept: verdict.ok,
    reason: verdict.ok ? null : verdict.reason,
    hops: verdict.ok ? verdict.hops : countSwapHops(body),
    outAmount: body.outAmount ?? body._build?.details?.quote?.outAmount ?? null,
    provider: String(provider || ''),
    pricesMs,
    quoteMs,
    totalMs: nowMs() - totalT0,
    httpStatus,
    txSizeDisplay: tx.txSizeDisplay,
    signLabel: tx.signLabel,
    signCount: tx.signCount,
    atomicRoute: tx.atomicRoute,
  };
}

function escTsv(v) {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`Benchmark Jupiter 100 @ ${API}`);
  console.log(`Wallet ${WALLET} | ${SOL_AMOUNT} SOL | timeout ${QUOTE_TIMEOUT_MS / 1000}s`);

  const { items: walletItems, ms: walletMs } = await fetchWalletBalances();
  console.log(`Wallet balances: ${walletItems.length} row(s) in ${walletMs}ms`);

  const tokens = (await fetchJupiterTopTokens()).filter((t) => !isSolMint(t.mint));
  console.log(`Queue ${tokens.length} tokens (SOL/WSOL excluded)\n`);

  const rows = [];
  let kept = 0;
  let failed = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const label = `${token.symbol || '?'} (${token.mint.slice(0, 8)}…)`;
    const r = await timedQuote(token, walletItems);
    const status = r.kept ? 'PASS' : 'FAIL';
    if (r.kept) kept++;
    else failed++;

    const timing = `prices ${r.pricesMs}ms + quote ${r.quoteMs}ms = ${r.totalMs}ms`;
    const txInfo = r.txSizeDisplay && r.signLabel ? ` | ${r.txSizeDisplay}, ${r.signLabel}` : '';
    const hopInfo = r.hops != null ? ` | ${r.hops}hop` : '';
    console.log(
      `[${i + 1}/${tokens.length}] ${status} ${label} — ${timing}${hopInfo}${txInfo}` +
        (r.reason ? ` — ${r.reason}` : ''),
    );

    rows.push({
      index: i + 1,
      symbol: token.symbol,
      mint: token.mint,
      kept: r.kept,
      reason: r.reason,
      hops: r.hops,
      outAmount: r.outAmount,
      provider: r.provider,
      pricesMs: r.pricesMs,
      quoteMs: r.quoteMs,
      totalMs: r.totalMs,
      httpStatus: r.httpStatus ?? null,
      txSizeDisplay: r.txSizeDisplay,
      signCount: r.signCount,
      signLabel: r.signLabel,
      atomicRoute: r.atomicRoute,
    });
  }

  const quoteMsList = rows.map((r) => r.quoteMs).filter((n) => n > 0);
  const totalMsList = rows.map((r) => r.totalMs);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    api: API,
    wallet: WALLET,
    amountSol: SOL_AMOUNT,
    quoteTimeoutMs: QUOTE_TIMEOUT_MS,
    maxHops: MAX_HOPS,
    tested: tokens.length,
    kept,
    failed,
    walletBalancesMs: walletMs,
    timingMs: {
      quoteAvg: avg(quoteMsList),
      quoteMedian: median(quoteMsList),
      quoteMax: quoteMsList.length ? Math.max(...quoteMsList) : 0,
      totalAvg: avg(totalMsList),
      totalMedian: median(totalMsList),
      totalMax: totalMsList.length ? Math.max(...totalMsList) : 0,
    },
    rows,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`);

  const tsvHeader =
    'index\tsymbol\tmint\tkept\treason\thops\toutAmount\tprovider\tpricesMs\tquoteMs\ttotalMs\ttxSize\tsignCount\tsignLabel\n';
  const tsvRows = rows.map((r) =>
    [
      r.index,
      r.symbol,
      r.mint,
      r.kept,
      r.reason ?? '',
      r.hops ?? '',
      r.outAmount ?? '',
      r.provider,
      r.pricesMs,
      r.quoteMs,
      r.totalMs,
      r.txSizeDisplay ?? '',
      r.signCount ?? '',
      r.signLabel ?? '',
    ]
      .map(escTsv)
      .join('\t'),
  );
  fs.writeFileSync(OUT_TSV, tsvHeader + tsvRows.join('\n') + '\n');

  console.log('\n=== Summary ===');
  console.log(`Kept ${kept}/${tokens.length} | Failed ${failed}`);
  console.log(
    `Quote ms — avg ${summary.timingMs.quoteAvg}, median ${summary.timingMs.quoteMedian}, max ${summary.timingMs.quoteMax}`,
  );
  console.log(
    `Total ms — avg ${summary.timingMs.totalAvg}, median ${summary.timingMs.totalMedian}, max ${summary.timingMs.totalMax}`,
  );
  console.log(`Wrote ${OUT_JSON}`);
  console.log(`Wrote ${OUT_TSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
