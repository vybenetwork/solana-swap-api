/**
 * Shared swap-api quote helpers for catalog filter + route comparison tools.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  NATIVE_SOL_MINT,
  WSOL_MINT,
  canonicalPairLabelFromMarket,
  eligibleRankForPool,
  formatRouteEligibleNote,
  rankEligibleMarketsByTvl,
} from './ix-builder-programs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.join(__dirname, '..', '..', 'public', 'data');

export const API = (process.env.SWAP_API || 'http://127.0.0.1:3007').replace(/\/$/, '');
export const WALLET =
  process.env.CATALOG_FILTER_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
export const SOL_AMOUNT = Number(process.env.CATALOG_FILTER_SOL_AMOUNT || 0.01);
export const MAX_HOPS = Math.max(1, Number(process.env.CATALOG_FILTER_MAX_HOPS || 2));
export const QUOTE_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.CATALOG_FILTER_QUOTE_TIMEOUT_MS || 300_000),
);
export const QUOTE_RETRY_ON_TIMEOUT = Math.max(
  0,
  Number(process.env.CATALOG_FILTER_QUOTE_RETRIES || 1),
);
export const SOL_DECIMALS = 9;

export function mintsForPriceResolve(outputMint, inputMint = NATIVE_SOL_MINT) {
  const out = String(outputMint ?? '').trim();
  const inn = String(inputMint ?? NATIVE_SOL_MINT).trim();
  const mints = [];
  const push = (mint) => {
    const m = String(mint ?? '').trim();
    if (!m) return;
    const key = isSolMint(m) ? WSOL_MINT : m;
    if (!mints.includes(key)) mints.push(key);
  };
  push(inn);
  push(out);
  return mints;
}

export function pickPriceStats(stats, mint) {
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

export function isSolMint(mint) {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

/** Drop native SOL / WSOL — not meaningful SOL→token quote targets. */
export function filterQuoteQueueTokens(tokens) {
  return tokens.filter((t) => !isSolMint(t.mint));
}

export function walletHasMint(items, mint) {
  const m = mint.trim();
  return items.some((i) => String(i.mintAddress ?? '').trim() === m);
}

export function buildAtaHintsFromWalletItems(items, inputMint, outputMint, amountUi) {
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

export async function fetchWalletBalancesOnce() {
  const res = await fetch(`${API}/api/wallets/${encodeURIComponent(WALLET)}/token-balances`, {
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `token-balances HTTP ${res.status}`);
  }
  return Array.isArray(body.tokens) ? body.tokens : [];
}

export async function resolvePricesForPair(outputMint, inputMint = NATIVE_SOL_MINT) {
  const mints = mintsForPriceResolve(outputMint, inputMint);
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

export function buildFrontendVybeQuoteBody(
  outputMint,
  priceHints,
  catalogDecimals,
  ataHints,
  inputMint = NATIVE_SOL_MINT,
) {
  const input = String(inputMint ?? NATIVE_SOL_MINT).trim() || NATIVE_SOL_MINT;
  const inputStats = pickPriceStats(priceHints, input);
  const outputStats = pickPriceStats(priceHints, outputMint);
  const slippage = Number(process.env.CATALOG_FILTER_SLIPPAGE || 2);
  const defaultAmount = isSolMint(input) ? SOL_AMOUNT : undefined;
  const hints = ataHints ?? {
    closeWsolAta: true,
    createOutputAta: true,
    closeInputAta: false,
    amount: defaultAmount,
  };
  const amount = hints.amount ?? defaultAmount;
  return {
    accountAddress: WALLET,
    amount,
    inputMintAddress: input,
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
    inputMintDecimals:
      hints.inputDecimals ??
      inputStats?.decimals ??
      (isSolMint(input) ? SOL_DECIMALS : undefined),
    ...(outputStats?.decimals != null
      ? { outputMintDecimals: outputStats.decimals }
      : catalogDecimals != null
        ? { outputMintDecimals: catalogDecimals }
        : {}),
  };
}

export async function waitForSwapApi(maxSec = 90) {
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    try {
      const priceHints = await resolvePricesForPair('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
      const res = await fetch(`${API}/api/trading/vybe-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildFrontendVybeQuoteBody('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', priceHints, 5),
        ),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.outAmount) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`swap-api not ready at ${API}`);
}

export async function fetchSolBuyQuote(token, walletItems) {
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
    signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
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

function isQuoteFetchTimeout(err) {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /timed out|timeout|AbortError|aborted/i.test(msg);
}

export async function fetchSolBuyQuoteWithRetry(token, walletItems) {
  let lastBody;
  for (let attempt = 0; attempt <= QUOTE_RETRY_ON_TIMEOUT; attempt++) {
    try {
      const body = await fetchSolBuyQuote(token, walletItems);
      if (
        body?.error &&
        /timed out|timeout|ETIMEDOUT|aborted/i.test(String(body.error)) &&
        attempt < QUOTE_RETRY_ON_TIMEOUT
      ) {
        console.warn(
          `⏳ Quote timeout for ${token.symbol ?? token.mint.slice(0, 8)} — retry ${attempt + 1}/${QUOTE_RETRY_ON_TIMEOUT} after 3s`,
        );
        await new Promise((r) => setTimeout(r, 3000));
        lastBody = body;
        continue;
      }
      return body;
    } catch (err) {
      if (attempt < QUOTE_RETRY_ON_TIMEOUT && isQuoteFetchTimeout(err)) {
        console.warn(
          `⏳ Quote timeout for ${token.symbol ?? token.mint.slice(0, 8)} — retry ${attempt + 1}/${QUOTE_RETRY_ON_TIMEOUT} after 3s`,
        );
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  return lastBody ?? { error: 'Request timed out' };
}

export function countSwapHops(body) {
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

function txWireBytes(base64) {
  if (!base64 || typeof base64 !== 'string') return null;
  try {
    return Buffer.from(base64.trim(), 'base64').length;
  } catch {
    return null;
  }
}

/** Ordered leg txs: pre → main → post (matches frontend extractSwapBuildTransactions). */
export function extractSwapBuildTransactions(build) {
  if (!build || typeof build !== 'object') return [];
  const details = build.details && typeof build.details === 'object' ? build.details : {};
  const pre =
    typeof build.preSwapTransaction === 'string'
      ? build.preSwapTransaction
      : typeof details.preSwapTransaction === 'string'
        ? details.preSwapTransaction
        : '';
  const mainRaw = build.tx ?? build.transaction;
  const main = typeof mainRaw === 'string' ? mainRaw : '';
  const post =
    typeof build.postSwapTransaction === 'string'
      ? build.postSwapTransaction
      : typeof details.postSwapTransaction === 'string'
        ? details.postSwapTransaction
        : '';
  const txs = [];
  if (pre.trim()) txs.push(pre.trim());
  if (main.trim()) txs.push(main.trim());
  if (post.trim()) txs.push(post.trim());
  return txs;
}

export function computeSwapTxSizesBytes(txStrings) {
  const sizes = [];
  for (const tx of txStrings) {
    const bytes = txWireBytes(tx);
    if (bytes != null && bytes > 0) sizes.push(bytes);
  }
  return sizes;
}

/** Tx size + wallet signing count from vybe-quote `_build`. */
export function extractBuildTxMetrics(body) {
  const build = body?._build;
  if (!build || body?._buildUnavailable) {
    return {
      txSizeBytes: [],
      txSizeDisplay: null,
      signCount: null,
      signLabel: null,
      atomicRoute: null,
    };
  }
  const details = build.details && typeof build.details === 'object' ? build.details : {};
  const txs = extractSwapBuildTransactions(build);
  const txSizeBytes = computeSwapTxSizesBytes(txs);
  const signCount = txs.length > 0 ? txs.length : build.tx || build.transaction ? 1 : null;
  const txSizeDisplay =
    txSizeBytes.length === 0
      ? null
      : txSizeBytes.length === 1
        ? `${txSizeBytes[0]}B`
        : txSizeBytes.map((n) => `${n}B`).join('+');
  const signLabel =
    signCount == null ? null : signCount === 1 ? '1-sign' : `${signCount}-sign`;
  const atomicRoute =
    details.atomicRoute === true ||
    build.atomicRoute === true ||
    (signCount === 1 && Boolean(details.quoteBridge || build.quoteBridge));
  return { txSizeBytes, txSizeDisplay, signCount, signLabel, atomicRoute };
}

export function extractSelectedRoute(body) {
  const hops = [];
  const plan = Array.isArray(body.routePlan) ? body.routePlan : [];
  for (const step of plan) {
    const info = step?.swapInfo ?? {};
    hops.push({
      poolAddress: String(info.ammKey ?? '').trim(),
      label: String(info.label ?? '').trim(),
      inputMint: String(info.inputMintAddress ?? '').trim(),
      outputMint: String(info.outputMintAddress ?? '').trim(),
      inAmount: info.inAmount,
      outAmount: info.outAmount,
    });
  }

  const rvt = body._routeDiscovery;
  const selected = rvt?.selected && typeof rvt.selected === 'object' ? rvt.selected : null;
  const topMarkets = Array.isArray(rvt?.topMarkets) ? rvt.topMarkets : [];
  const routes = Array.isArray(rvt?.routes) ? rvt.routes : [];

  return {
    hopCount: countSwapHops(body),
    hops,
    selected: selected
      ? {
          marketAddress: String(selected.marketAddress ?? '').trim(),
          programAddress: String(selected.programAddress ?? '').trim(),
          programLabel: String(selected.programLabel ?? '').trim(),
          liquidity: selected.liquidity,
          tradeCount: selected.tradeCount,
          discoverySource: selected.discoverySource,
        }
      : null,
    topMarkets: topMarkets.slice(0, 10).map((m) => ({
      rank: m.rank,
      marketAddress: m.marketAddress,
      programAddress: m.programAddress,
      programLabel: m.programLabel,
      tradeCount: m.tradeCount,
      supportedProgram: m.supportedProgram,
      eligible: m.eligible,
      liquidity: m.liquidity,
    })),
    routeDiscoveryOutcome: rvt?.outcome,
    alternateRoutes: routes.length,
    error: body.error ? String(body.error) : null,
  };
}

export function loadFilterFailures() {
  const file = path.join(OUT_DIR, 'token-catalog-filter-failures.tsv');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [mint, symbol, ...rest] = line.split('\t');
    if (!mint || mint === 'mint') continue;
    rows.push({ mint: mint.trim(), symbol: symbol?.trim(), filterReason: rest.join('\t').trim() });
  }
  return rows;
}

export function loadCatalogTokens() {
  const file = path.join(OUT_DIR, 'token-catalog.json');
  if (!fs.existsSync(file)) return [];
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(catalog.tokens) ? catalog.tokens : [];
}

/** Kept catalog (80) + filter failures / excluded (20), deduped by mint. */
export function loadAllCatalogTokens() {
  const byMint = new Map();

  for (const t of loadCatalogTokens()) {
    byMint.set(t.mint, { ...t, catalogStatus: 'kept', filterReason: null });
  }

  for (const t of loadFilterFailures()) {
    if (byMint.has(t.mint)) continue;
    byMint.set(t.mint, {
      mint: t.mint,
      symbol: t.symbol,
      catalogStatus: 'failed',
      filterReason: t.filterReason ?? null,
    });
  }

  return [...byMint.values()];
}

export function compareRouteToSolscan(quoteRoute, solscanData, tokenMint = '', tokenSymbol = '') {
  const poolSet = new Set(
    quoteRoute.hops.map((h) => h.poolAddress).filter(Boolean),
  );
  if (quoteRoute.selected?.marketAddress) poolSet.add(quoteRoute.selected.marketAddress);

  const rankedMarkets = solscanData?.marketsTop ?? solscanData?.marketsTop10 ?? [];
  const eligible = solscanData?.eligible ?? [];
  const solPairEligible = solscanData?.solPairEligible ?? [];
  const eligibleRanked = rankEligibleMarketsByTvl(eligible);
  const solPairEligibleRanked = rankEligibleMarketsByTvl(solPairEligible);

  const matchedRanked = rankedMarkets.filter((m) => poolSet.has(m.marketAddress));
  const matchedEligible = eligible.filter((m) => poolSet.has(m.marketAddress));
  const matchedSolPairEligible = solPairEligible.filter((m) => poolSet.has(m.marketAddress));

  const bestSolscanSolPair = solPairEligible[0] ?? null;
  const selectedPool = quoteRoute.selected?.marketAddress || quoteRoute.hops[0]?.poolAddress || null;
  const selectedEligibleRank = eligibleRankForPool(
    (quoteRoute.hopCount ?? 1) <= 1 ? solPairEligibleRanked : eligibleRanked,
    selectedPool,
  );
  if (selectedEligibleRank?.inEligibleSet && selectedPool) {
    const row = (quoteRoute.hopCount ?? 1) <= 1
      ? solPairEligibleRanked.find((m) => m.marketAddress === selectedPool)
      : eligibleRanked.find((m) => m.marketAddress === selectedPool);
    if (row) {
      selectedEligibleRank.pairLabel = canonicalPairLabelFromMarket(row, tokenMint, tokenSymbol);
    }
  }
  const hopEligibleRanks = quoteRoute.hops
    .map((h) => eligibleRankForPool(eligibleRanked, h.poolAddress))
    .filter(Boolean);

  let assessment = 'unknown';
  if (quoteRoute.error) {
    assessment = solPairEligible.length === 0 ? 'no_sol_pair_on_solscan' : 'quote_failed_but_solscan_has_sol_pair';
  } else if (matchedSolPairEligible.length > 0) {
    assessment = 'selected_solscan_sol_pair';
  } else if (matchedEligible.length > 0) {
    assessment = 'selected_eligible_non_sol_pair';
  } else if (matchedRanked.length > 0) {
    assessment = 'selected_solscan_ranked_unsupported_or_low_tvl';
  } else if (quoteRoute.hopCount === 2 && solPairEligible.length === 0 && eligible.length > 0) {
    assessment = 'two_hop_bridge_no_direct_sol_pair';
  } else if (quoteRoute.hopCount === 1) {
    assessment = 'single_hop_not_in_solscan_top_by_tvl';
  } else {
    assessment = 'route_not_in_solscan_top_by_tvl';
  }

  const assessmentDetail = formatRouteEligibleNote(
    quoteRoute,
    solscanData,
    tokenMint,
    tokenSymbol,
  );

  return {
    selectedPool,
    selectedPools: [...poolSet],
    rankedMarketCount: rankedMarkets.length,
    matchedRankedMarkets: matchedRanked.map((m) => m.marketAddress),
    matchedTop10: matchedRanked.map((m) => m.marketAddress), // legacy alias
    matchedEligible: matchedEligible.map((m) => m.marketAddress),
    matchedSolPairEligible: matchedSolPairEligible.map((m) => m.marketAddress),
    solscanSolPairEligibleCount: solPairEligible.length,
    solscanEligibleCount: eligible.length,
    eligibleRanked: eligibleRanked.map((m) => ({
      rank: m.eligibleRank,
      totalEligible: m.eligibleRankTotal,
      marketAddress: m.marketAddress,
      marketHref: m.marketHref,
      pairLabel: m.pairLabel,
      programLabel: m.programLabel,
      ixBuilderProtocol: m.ixBuilderProtocol,
      tvlUsd: m.tvlUsd,
      hasSolLeg: m.hasSolLeg,
      volume24hUsd: m.volume24hUsd,
    })),
    selectedEligibleRank,
    hopEligibleRanks,
    bestSolscanSolPair: bestSolscanSolPair
      ? {
          marketAddress: bestSolscanSolPair.marketAddress,
          pairLabel: bestSolscanSolPair.pairLabel,
          programLabel: bestSolscanSolPair.programLabel,
          tvlUsd: bestSolscanSolPair.tvlUsd,
          volume24hUsd: bestSolscanSolPair.volume24hUsd,
          eligibleRank: eligibleRankForPool(eligibleRanked, bestSolscanSolPair.marketAddress)?.rank ?? null,
        }
      : null,
    assessment,
    assessmentDetail,
    selectedMatchesBestSolPair:
      Boolean(bestSolscanSolPair) && bestSolscanSolPair.marketAddress === selectedPool,
  };
}
