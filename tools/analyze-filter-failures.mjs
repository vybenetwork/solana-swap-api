#!/usr/bin/env node
/**
 * Analyze catalog filter failures: Solscan eligible markets, bridge hubs, ix-builder routes.
 *
 * Usage:
 *   node tools/analyze-filter-failures.mjs
 *   CATALOG_ANALYSIS_REQUOTE=1 SWAP_API=http://127.0.0.1:3007 node tools/analyze-filter-failures.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  NATIVE_SOL_MINT,
  WSOL_MINT,
  isSolMint,
  partitionMarkets,
  sortEligibleByTvl,
} from './lib/ix-builder-programs.mjs';
import {
  extractSelectedRoute,
  loadCatalogTokens,
  OUT_DIR,
} from './lib/swap-api-quote-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOLSCAN_DIR = path.join(OUT_DIR, 'solscan-markets');
const FILTER_REPORT = path.join(OUT_DIR, 'token-catalog-filter-report.json');
const OUT_TSV = path.join(OUT_DIR, 'token-catalog-failure-analysis.tsv');
const OUT_JSON = path.join(OUT_DIR, 'token-catalog-failure-analysis.json');

function loadFailuresFromTsv() {
  const file = path.join(OUT_DIR, 'token-catalog-filter-failures.tsv');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t');
    const mint = cols[0]?.trim();
    if (!mint || mint === 'mint') continue;
    rows.push({
      mint,
      symbol: cols[1]?.trim() ?? '',
      filterReason: cols[2]?.trim() ?? '',
      solscanEligible: cols[3]?.trim() ?? '',
      solPairEligible: cols[4]?.trim() ?? '',
      assessment: cols[8]?.trim() ?? cols[cols.length - 1]?.trim() ?? '',
    });
  }
  return rows;
}

const TIER1_HUBS = new Map([
  [WSOL_MINT, 'WSOL'],
  [NATIVE_SOL_MINT, 'SOL'],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
]);

const REQUOTE = process.env.CATALOG_ANALYSIS_REQUOTE === '1';
const API = (process.env.SWAP_API || 'http://127.0.0.1:3007').replace(/\/$/, '');

function escTsv(v) {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function loadSolscanCache(mint) {
  const file = path.join(SOLSCAN_DIR, `${mint}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadFilterReportByMint() {
  if (!fs.existsSync(FILTER_REPORT)) return new Map();
  const report = JSON.parse(fs.readFileSync(FILTER_REPORT, 'utf8'));
  const rows = Array.isArray(report.rows) ? report.rows : [];
  return new Map(rows.map((r) => [r.mint, r]));
}

function counterpartyMint(market, tokenMint) {
  const mint = tokenMint.trim();
  const pairMints = Array.isArray(market.pairMints) ? market.pairMints : [];
  const linkMints = Array.isArray(market.pairTokens)
    ? market.pairTokens.map((t) => String(t.mint ?? '').trim()).filter(Boolean)
    : [];
  const all = [...new Set([...pairMints, ...linkMints])].filter((m) => m && m !== mint);
  return all[0] ?? null;
}

function counterpartySymbol(market, tokenMint) {
  const mint = tokenMint.trim();
  const tokens = Array.isArray(market.pairTokens) ? market.pairTokens : [];
  const other = tokens.find((t) => String(t.mint ?? '').trim() !== mint);
  return other?.symbol ?? '?';
}

function formatHubSummary(hubs) {
  return hubs
    .slice(0, 8)
    .map((h) => `${h.symbol}(${h.poolCount}p,$${Math.round(h.maxTvlUsd ?? 0).toLocaleString()})`)
    .join('; ');
}

function formatProtocols(markets) {
  const counts = new Map();
  for (const m of markets) {
    const p = m.ixBuilderProtocol ?? m.programLabel ?? '?';
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}:${n}`)
    .join(', ');
}

function buildSolReachabilityIndex() {
  /** @type {Map<string, { symbol: string, bestPool: object, tvlUsd: number|null, protocol: string, fromSymbol: string, poolLabel: string }>} */
  const index = new Map();

  if (!fs.existsSync(SOLSCAN_DIR)) return index;

  for (const file of fs.readdirSync(SOLSCAN_DIR).filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(SOLSCAN_DIR, file), 'utf8'));
    const mint = String(data.mint ?? '').trim();
    if (!mint || isSolMint(mint)) continue;
    const symbol = data.symbol ?? mint.slice(0, 8);
    const solPairEligible = data.solPairEligible ?? [];
    if (!solPairEligible.length) continue;
    const best = sortEligibleByTvl(solPairEligible)[0];
    index.set(mint, {
      symbol,
      bestPool: best,
      tvlUsd: best.tvlUsd ?? null,
      protocol: best.ixBuilderProtocol ?? best.programLabel ?? '',
      fromSymbol: symbol,
      poolLabel: best.pairLabel ?? '',
    });
  }

  return index;
}

function analyzeHubs(tokenMint, tokenSymbol, eligibleMarkets, solReachability) {
  const nonSolEligible = eligibleMarkets.filter((m) => m.eligible && !m.hasSolLeg);
  const byHub = new Map();

  for (const m of nonSolEligible) {
    const hubMint = counterpartyMint(m, tokenMint);
    if (!hubMint) continue;
    const hubSymbol = counterpartySymbol(m, tokenMint);
    const key = hubMint;
    if (!byHub.has(key)) {
      byHub.set(key, {
        mint: hubMint,
        symbol: hubSymbol,
        pools: [],
        poolCount: 0,
        maxTvlUsd: 0,
        totalTvlUsd: 0,
      });
    }
    const row = byHub.get(key);
    row.pools.push(m);
    row.poolCount++;
    const tvl = m.tvlUsd ?? 0;
    row.maxTvlUsd = Math.max(row.maxTvlUsd, tvl);
    row.totalTvlUsd += tvl;
  }

  const hubs = [...byHub.values()].sort((a, b) => b.maxTvlUsd - a.maxTvlUsd);
  const bridgeable = [];
  const deadEnd = [];

  for (const hub of hubs) {
    const solReach = solReachability.get(hub.mint);
    const tier1 = TIER1_HUBS.has(hub.mint);
    if (solReach || tier1) {
      bridgeable.push({
        ...hub,
        solPoolLabel: solReach?.poolLabel ?? (tier1 ? `SOL-${TIER1_HUBS.get(hub.mint)}` : ''),
        solPoolTvlUsd: solReach?.tvlUsd ?? null,
        solPoolProtocol: solReach?.protocol ?? '',
        path: `SOL→${hub.symbol}→${tokenSymbol}`,
        tokenHubMaxTvlUsd: hub.maxTvlUsd,
      });
    } else {
      deadEnd.push({
        ...hub,
        path: `SOL→?→${tokenSymbol} (${hub.symbol} has no eligible SOL-pair in cache)`,
      });
    }
  }

  bridgeable.sort(
    (a, b) =>
      Math.min(b.solPoolTvlUsd ?? 0, b.tokenHubMaxTvlUsd) -
      Math.min(a.solPoolTvlUsd ?? 0, a.tokenHubMaxTvlUsd),
  );

  return { hubs, bridgeable, deadEnd, nonSolEligible };
}

function topUnsupportedHighTvl(marketsTop, tokenMint, minTvl = 10_000) {
  return sortEligibleByTvl(
    marketsTop.filter(
      (m) =>
        !m.supportedProgram &&
        (m.tvlUsd ?? 0) >= minTvl &&
        m.involvesToken !== false,
    ),
  ).slice(0, 3);
}

function classifyRootCause(failure, solscan, hubAnalysis, routeInfo) {
  const reason = failure.filterReason ?? failure.reason ?? '';
  const solPairCount = solscan?.summary?.solPairEligibleCount ?? solscan?.solPairEligible?.length ?? 0;
  const eligibleCount = solscan?.summary?.eligibleCount ?? solscan?.eligible?.length ?? 0;

  if (/No direct or 2 hop pools/i.test(reason)) {
    if (hubAnalysis.bridgeable.length > 0) return 'bridge_gap_ix_builder';
    if (hubAnalysis.deadEnd.length > 0 && eligibleCount > 0) return 'dead_end_hub_only';
    return 'no_pools_discovered';
  }
  if (/binArrays|tickArray|tick array/i.test(reason)) return 'dlmm_tick_liquidity';
  if (/Insufficient liquidity/i.test(reason)) return 'dlmm_bin_liquidity';
  if (/simulation failed|simulation gate|ProgramFailedToComplete|Custom.*3008/i.test(reason)) {
    if (solPairCount > 0) return 'sol_pair_sim_failed';
    if (hubAnalysis.bridgeable.length > 0) return 'bridge_path_sim_failed';
    return 'simulation_failed';
  }
  if (solPairCount === 0 && hubAnalysis.bridgeable.length > 0) return 'bridge_only_no_sol_pair';
  if (solPairCount > 0 && routeInfo?.selectedPool) return 'route_mismatch_or_sim';
  return 'unknown';
}

async function requoteToken(mint, symbol) {
  try {
    const res = await fetch(`${API}/api/trading/vybe-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountAddress: process.env.CATALOG_FILTER_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza',
        amount: 0.01,
        inputMintAddress: NATIVE_SOL_MINT,
        outputMintAddress: mint,
        slippage: 2,
        router: 'vybe',
        marketFetchMode: 'full',
        enumerateRoutes: true,
        closeWsolAta: true,
        enrich: true,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => ({}));
    const route = extractSelectedRoute(body);
    return {
      ok: res.ok && !body.error,
      error: body.error ?? (res.ok ? null : `HTTP ${res.status}`),
      route,
      hopCount: route.hopCount,
      selectedPool: route.selected?.marketAddress ?? route.hops[0]?.poolAddress ?? null,
      hops: route.hops,
      topMarkets: route.topMarkets,
      discoveryOutcome: route.routeDiscoveryOutcome,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), route: null };
  }
}

function formatRouteSummary(routeInfo) {
  if (!routeInfo) return '';
  if (routeInfo.error && !routeInfo.hops?.length) return String(routeInfo.error).slice(0, 120);
  const pools = (routeInfo.hops ?? [])
    .map((h) => h.poolAddress?.slice(0, 8) ?? '?')
    .filter(Boolean);
  if (pools.length) return `${routeInfo.hopCount ?? pools.length}hop ${pools.join('→')}`;
  if (routeInfo.selectedPool) return `selected ${routeInfo.selectedPool.slice(0, 8)}…`;
  return routeInfo.error ? String(routeInfo.error).slice(0, 80) : '';
}

function bestSolPairEligible(solscan) {
  const pools = solscan?.solPairEligible ?? [];
  return sortEligibleByTvl(pools)[0] ?? null;
}

async function main() {
  const failures = loadFailuresFromTsv();
  if (failures.length === 0) {
    console.error('No failures in token-catalog-filter-failures.tsv');
    process.exit(1);
  }

  const reportByMint = loadFilterReportByMint();
  const solReachability = buildSolReachabilityIndex();
  const keptMints = new Set(loadCatalogTokens().map((t) => t.mint));

  console.log(`Analyzing ${failures.length} failed token(s)`);
  console.log(`SOL-reachable hubs in cache index: ${solReachability.size}`);
  if (REQUOTE) console.log(`Re-quote enabled → ${API}`);

  const results = [];
  const hubFrequency = new Map();

  for (let i = 0; i < failures.length; i++) {
    const f = failures[i];
    const report = reportByMint.get(f.mint) ?? {};
    const solscan = loadSolscanCache(f.mint);
    const marketsTop = solscan?.marketsTop ?? [];
    const eligible = solscan?.eligible ?? partitionMarkets(marketsTop, f.mint).eligible;
    const solPairEligible = solscan?.solPairEligible ?? partitionMarkets(marketsTop, f.mint).solPairEligible;

    const hubAnalysis = analyzeHubs(f.mint, f.symbol, eligible, solReachability);
    for (const d of hubAnalysis.deadEnd) {
      hubFrequency.set(d.symbol, (hubFrequency.get(d.symbol) ?? 0) + 1);
    }

    const bestSol = bestSolPairEligible({ solPairEligible });
    const unsupportedTop = topUnsupportedHighTvl(marketsTop, f.mint);

    let routeInfo = null;
    const assessment = report.comparison?.assessment ?? f.assessment ?? '';
    const shouldRequote =
      REQUOTE &&
      (/simulation|binArray|tick|ProgramFailed|Insufficient liquidity/i.test(f.filterReason ?? '') ||
        assessment === 'quote_failed_but_solscan_has_sol_pair');

    if (shouldRequote) {
      process.stdout.write(`[${i + 1}/${failures.length}] re-quote ${f.symbol}… `);
      routeInfo = await requoteToken(f.mint, f.symbol);
      console.log(routeInfo.ok ? 'ok' : 'fail');
    }

    const rootCause = classifyRootCause(f, { summary: report.solscanSummary, solPairEligible, eligible }, hubAnalysis, routeInfo);

    results.push({
      mint: f.mint,
      symbol: f.symbol,
      failureReason: f.filterReason ?? report.reason ?? '',
      assessment: report.comparison?.assessment ?? '',
      solPairEligibleCount: solPairEligible.length,
      eligibleCount: eligible.length,
      eligibleNonSolCount: hubAnalysis.nonSolEligible.length,
      protocols: formatProtocols(eligible),
      topHubs: formatHubSummary(hubAnalysis.hubs),
      bridgeablePaths: hubAnalysis.bridgeable
        .slice(0, 5)
        .map((b) => `${b.path} (hub $${Math.round(b.tokenHubMaxTvlUsd).toLocaleString()}, SOL-leg $${Math.round(b.solPoolTvlUsd ?? 0).toLocaleString()})`)
        .join(' | '),
      deadEndHubs: hubAnalysis.deadEnd
        .slice(0, 5)
        .map((d) => `${d.symbol}(${d.poolCount}p,$${Math.round(d.maxTvlUsd).toLocaleString()})`)
        .join('; '),
      bestSolPair: bestSol
        ? `${bestSol.pairLabel} ${bestSol.ixBuilderProtocol} $${Math.round(bestSol.tvlUsd ?? 0).toLocaleString()}`
        : '',
      topUnsupported: unsupportedTop
        .map((m) => `${m.pairLabel} ${m.programLabel} $${Math.round(m.tvlUsd ?? 0).toLocaleString()}`)
        .join(' | '),
      ixRoute: formatRouteSummary(routeInfo),
      ixSelectedPool: routeInfo?.selectedPool ?? report.comparison?.selectedPool ?? '',
      likelyRootCause: rootCause,
      inKeptCatalog: keptMints.has(f.mint),
      solscanUrl: solscan?.solscanUrl ?? report.solscanUrl ?? '',
      hubDetail: hubAnalysis,
    });
  }

  const hubFreqSorted = [...hubFrequency.entries()].sort((a, b) => b[1] - a[1]);

  const rootCauseCounts = new Map();
  for (const r of results) {
    rootCauseCounts.set(r.likelyRootCause, (rootCauseCounts.get(r.likelyRootCause) ?? 0) + 1);
  }

  const header =
    '# Catalog filter failure analysis\n' +
    '# Columns: symbol\tmint\troot_cause\tfailure_reason\tsol_pair_eligible\teligible\tnon_sol_eligible\tprotocols\ttop_hubs\tbridgeable_paths\tdead_end_hubs\tbest_sol_pair\ttop_unsupported_orca\tix_route\tassessment\n';

  const tsvRows = results.map((r) =>
    [
      r.symbol,
      r.mint,
      r.likelyRootCause,
      r.failureReason,
      r.solPairEligibleCount,
      r.eligibleCount,
      r.eligibleNonSolCount,
      r.protocols,
      r.topHubs,
      r.bridgeablePaths,
      r.deadEndHubs,
      r.bestSolPair,
      r.topUnsupported,
      r.ixRoute,
      r.assessment,
    ]
      .map(escTsv)
      .join('\t'),
  );

  fs.writeFileSync(OUT_TSV, `${header}${tsvRows.join('\n')}\n`);
  fs.writeFileSync(
    OUT_JSON,
    `${JSON.stringify(
      {
        analyzedAt: new Date().toISOString(),
        failureCount: results.length,
        rootCauseCounts: Object.fromEntries(rootCauseCounts),
        deadEndHubFrequency: Object.fromEntries(hubFreqSorted),
        solReachableHubCount: solReachability.size,
        requoteEnabled: REQUOTE,
        tokens: results,
      },
      null,
      2,
    )}\n`,
  );

  console.log('');
  console.log('Root cause breakdown:');
  for (const [cause, n] of [...rootCauseCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cause}: ${n}`);
  }
  if (hubFreqSorted.length) {
    console.log('');
    console.log('Dead-end hubs (block 2-hop bridge):');
    for (const [sym, n] of hubFreqSorted.slice(0, 10)) {
      console.log(`  ${sym}: ${n} token(s)`);
    }
  }
  console.log('');
  console.log(`Wrote ${OUT_TSV}`);
  console.log(`Wrote ${OUT_JSON}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
