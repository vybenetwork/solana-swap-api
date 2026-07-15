#!/usr/bin/env node
/**
 * Jupiter top-100 buy quotes via prod (or SWAP_API) for SOL / USDC / USDT / BONK inputs.
 * Serial per input × WSOL ATA scenario. Writes tx sizes + a failures log.
 *
 * WSOL ATA scenarios are applied **on-chain** with PROTOCOL_CHECK_WALLET_SECRET (7Tar):
 *   funded  — create/open WSOL ATA and wrap ~0.01 SOL → closeWsolAta=false
 *   zero    — open WSOL ATA with 0 balance            → closeWsolAta=false
 *   absent  — close WSOL ATA if present               → closeWsolAta=true
 *   current — leave on-chain WSOL as-is               → closeWsolAta from wallet
 *
 * Usage:
 *   npm run benchmark:jupiter-100:prod
 *   BENCHMARK_INPUTS=sol,usdc,usdt,bonk SWAP_API=https://solana-swap-api.vybenetwork.com \
 *     CATALOG_FILTER_SLIPPAGE=10 CATALOG_FILTER_BONK_AMOUNT=100000 \
 *     BENCHMARK_WSOL_SCENARIOS=funded,zero,absent \
 *     node tools/benchmark-jupiter-100-prod.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { fetchJupiterTopTokens } from './lib/jupiter-catalog.mjs';
import { NATIVE_SOL_MINT, WSOL_MINT } from './lib/ix-builder-programs.mjs';
import {
  API,
  MAX_HOPS,
  QUOTE_TIMEOUT_MS,
  SOL_AMOUNT,
  buildAtaHintsFromWalletItems,
  buildFrontendVybeQuoteBody,
  resolvePricesForPair,
  fetchWalletBalancesOnce,
  extractBuildTxMetrics,
  countSwapHops,
  isSolMint,
  walletHasMint,
} from './lib/swap-api-quote-lib.mjs';
import {
  createBenchmarkConnection,
  ensureOnChainWsolScenario,
  loadBenchmarkWalletKeypair,
  mergeWsolStateIntoWalletItems,
} from './lib/wsol-ata-scenario.mjs';

config();

if (!process.env.CATALOG_FILTER_SLIPPAGE) process.env.CATALOG_FILTER_SLIPPAGE = '10';
if (!process.env.CATALOG_FILTER_SOL_AMOUNT) process.env.CATALOG_FILTER_SOL_AMOUNT = '0.02';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'data');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** Stable buy size (wallet-safe default). Override with CATALOG_FILTER_STABLE_AMOUNT. */
const STABLE_AMOUNT = Number(process.env.CATALOG_FILTER_STABLE_AMOUNT || 2);
/** BONK buy size (wallet has ~4e5). Override with CATALOG_FILTER_BONK_AMOUNT. */
const BONK_AMOUNT = Number(process.env.CATALOG_FILTER_BONK_AMOUNT || 10000);
/** On-chain WSOL wrap amount (ui) for the "funded" scenario. */
const WSOL_FUNDED_UI = Number(process.env.BENCHMARK_WSOL_BALANCE_UI || 0.01);

const INPUT_PRESETS = {
  sol: {
    key: 'sol',
    symbol: 'SOL',
    mint: NATIVE_SOL_MINT,
    amount: Number(process.env.CATALOG_FILTER_SOL_AMOUNT || SOL_AMOUNT || 0.02),
    decimals: 9,
  },
  usdc: {
    key: 'usdc',
    symbol: 'USDC',
    mint: USDC,
    amount: STABLE_AMOUNT,
    decimals: 6,
  },
  usdt: {
    key: 'usdt',
    symbol: 'USDT',
    mint: USDT,
    amount: STABLE_AMOUNT,
    decimals: 6,
  },
  bonk: {
    key: 'bonk',
    symbol: 'BONK',
    mint: BONK,
    amount: BONK_AMOUNT,
    decimals: 5,
  },
};

const SLIPPAGE = Number(process.env.CATALOG_FILTER_SLIPPAGE || 10);

const WSOL_SCENARIO_PRESETS = {
  funded: {
    key: 'funded',
    label: `WSOL ATA open @ ${WSOL_FUNDED_UI}`,
    fundedUi: WSOL_FUNDED_UI,
    expectCloseWsolAta: false,
  },
  zero: {
    key: 'zero',
    label: 'WSOL ATA open @ 0',
    expectCloseWsolAta: false,
  },
  absent: {
    key: 'absent',
    label: 'no WSOL ATA',
    expectCloseWsolAta: true,
  },
  current: {
    key: 'current',
    label: 'leave on-chain WSOL as-is',
    expectCloseWsolAta: null, // derive from wallet; do not mutate chain
  },
};

function parseInputs() {
  const raw = (process.env.BENCHMARK_INPUTS || 'sol,usdc,usdt')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = [];
  for (const key of raw) {
    const preset = INPUT_PRESETS[key];
    if (!preset) throw new Error(`Unknown BENCHMARK_INPUTS entry: ${key}`);
    out.push(preset);
  }
  return out;
}

function parseWsolScenarios() {
  const raw = (process.env.BENCHMARK_WSOL_SCENARIOS || 'funded,zero,absent')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = [];
  for (const key of raw) {
    const preset = WSOL_SCENARIO_PRESETS[key];
    if (!preset) throw new Error(`Unknown BENCHMARK_WSOL_SCENARIOS entry: ${key}`);
    out.push(preset);
  }
  return out;
}

function shortAddr(addr, n = 8) {
  const s = String(addr ?? '').trim();
  if (!s) return '-';
  return s.length <= n + 1 ? s : `${s.slice(0, n)}…`;
}

function heliusRpcUrl() {
  const explicit = (process.env.SOLANA_RPC_URL ?? '').trim();
  if (explicit) return explicit;
  const key = (process.env.HELIUS_API_KEY ?? '').trim();
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

async function warmHelius() {
  const url = heliusRpcUrl();
  if (!url) {
    console.warn('HELIUS_API_KEY / SOLANA_RPC_URL unset — skipping RPC warm');
    return null;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

function routePlanFromBody(body) {
  const plan = Array.isArray(body?.routePlan) ? body.routePlan : [];
  return plan.map((step) => {
    const info = step?.swapInfo ?? {};
    return {
      label: String(info.label ?? '').trim(),
      pool: String(info.ammKey ?? '').trim(),
      in: String(info.inputMintAddress ?? '').trim(),
      out: String(info.outputMintAddress ?? '').trim(),
    };
  });
}

function formatRoutePlan(plan) {
  if (!plan?.length) return '-';
  return plan.map((h) => `${h.label || '?'}:${shortAddr(h.pool)}`).join(' → ');
}

function extractFailedMarkets(body) {
  const rd = body?._routeDiscovery;
  const log = Array.isArray(rd?.buildLog) ? rd.buildLog : [];
  const fails = [];
  for (const entry of log) {
    if (entry?.success === true) continue;
    fails.push({
      marketAddress: String(entry.marketAddress ?? '').trim(),
      programLabel: String(entry.programLabel ?? '').trim(),
      attempt: String(entry.attempt ?? '').trim(),
      provider: entry.provider ? String(entry.provider).trim() : undefined,
      tradeCount: entry.tradeCount,
      error: entry.error ? String(entry.error) : 'failed',
    });
  }
  const seen = new Set();
  return fails.filter((f) => {
    const key = `${f.marketAddress}|${f.error}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractTriedMarkets(body) {
  const rd = body?._routeDiscovery;
  const tried = Array.isArray(rd?.tried) ? rd.tried : [];
  return tried.map((c, i) => ({
    queueIndex: c.queueIndex ?? i + 1,
    marketAddress: String(c.marketAddress ?? '').trim(),
    programLabel: String(c.programLabel ?? c.protocol ?? '').trim(),
    protocol: c.protocol ? String(c.protocol).trim() : undefined,
    liquidity: c.liquidity,
    tradeCount: c.tradeCount,
  }));
}

function extractSelectedMarket(body) {
  const selected = body?._routeDiscovery?.selected;
  const details = body?._build?.details && typeof body._build.details === 'object' ? body._build.details : {};
  const bridge = details.quoteBridge || body?._build?.quoteBridge || null;
  if (!selected && !details.poolAddress) {
    return { main: null, bridge: null };
  }
  return {
    main: selected
      ? {
          marketAddress: String(selected.marketAddress ?? '').trim(),
          programLabel: String(selected.programLabel ?? selected.protocol ?? '').trim(),
          protocol: selected.protocol ? String(selected.protocol).trim() : undefined,
          liquidity: selected.liquidity,
          tradeCount: selected.tradeCount,
          discoverySource: selected.discoverySource,
        }
      : details.poolAddress
        ? {
            marketAddress: String(details.poolAddress).trim(),
            programLabel: String(details.protocol || body?._build?.provider || '').trim(),
            protocol: details.protocol,
          }
        : null,
    bridge: bridge
      ? {
          marketAddress: String(bridge.poolAddress || bridge.marketAddress || '').trim(),
          programLabel: String(bridge.protocol || bridge.programLabel || '').trim(),
          mint: String(bridge.bridgeMint || bridge.mint || '').trim() || undefined,
        }
      : null,
  };
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

function summarize(body, token, ms, ataHints, input, wsolScenario) {
  const pass = quotePasses(body);
  const tx = extractBuildTxMetrics(body);
  const markets = extractSelectedMarket(body);
  const failedMarkets = extractFailedMarkets(body);
  const triedMarkets = extractTriedMarkets(body);
  const routePlan = routePlanFromBody(body);
  const bytes =
    tx.txSizeBytes?.[0] ??
    (tx.txSizeBytes?.length ? tx.txSizeBytes.reduce((a, b) => a + b, 0) : null);
  const rd = body?._routeDiscovery;

  return {
    input: input.key,
    inputMint: input.mint,
    inputSymbol: input.symbol,
    amount: input.amount,
    wsolScenario: wsolScenario.key,
    wsolScenarioLabel: wsolScenario.label,
    symbol: token.symbol,
    mint: token.mint,
    ok: pass.ok,
    reason: pass.ok ? undefined : pass.reason,
    error: body?.error || undefined,
    ms,
    bytes,
    txSizeBytes: tx.txSizeBytes,
    txSizeDisplay: tx.txSizeDisplay,
    signLabel: tx.signLabel,
    atomicRoute: tx.atomicRoute,
    hops: pass.hops ?? countSwapHops(body),
    protocol: markets.main?.programLabel || markets.main?.protocol || null,
    provider: body?._build?.provider || body?._build?.details?.provider || null,
    poolAddress: markets.main?.marketAddress || null,
    bridgeProtocol: markets.bridge?.programLabel || null,
    bridgeMint: markets.bridge?.mint || null,
    bridgePool: markets.bridge?.marketAddress || null,
    preSwapNeeded: Boolean(body?._build?.details?.preSwapNeeded ?? markets.bridge),
    routePlan,
    selectedMarket: markets.main,
    bridgeMarket: markets.bridge,
    triedMarkets,
    failedMarkets,
    routeDiscoveryOutcome: rd?.outcome ?? null,
    ataHints: {
      closeWsolAta: ataHints.closeWsolAta === true,
      createOutputAta: ataHints.createOutputAta,
      closeInputAta: ataHints.closeInputAta === true,
    },
  };
}

function formatFailedMarkets(fails) {
  if (!fails?.length) return 'none';
  return fails
    .map((f) => `${f.programLabel || '?'}:${shortAddr(f.marketAddress)} (${f.error})`)
    .join(' | ');
}

function formatMarketsLine(row) {
  const hops = row.hops ?? row.routePlan?.length ?? 0;
  const route = formatRoutePlan(row.routePlan);
  const main = row.selectedMarket
    ? `${row.selectedMarket.programLabel || '?'}:${shortAddr(row.selectedMarket.marketAddress)}`
    : '-';
  const bridge = row.bridgeMarket
    ? `${row.bridgeMarket.programLabel || '?'}:${shortAddr(row.bridgeMarket.marketAddress)}`
    : '-';
  return `hops=${hops} main=${main} bridge=${bridge} route=${route}`;
}

async function quoteOne(token, walletItems, input, wsolScenario) {
  const t0 = Date.now();
  const ataHints = buildAtaHintsFromWalletItems(walletItems, input.mint, token.mint, input.amount);
  const maxAttempts = Math.max(1, Number(process.env.BENCHMARK_QUOTE_RETRIES || 3));
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const priceHints = await resolvePricesForPair(token.mint, input.mint);
      const res = await fetch(`${API}/api/trading/vybe-quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          buildFrontendVybeQuoteBody(token.mint, priceHints, token.decimals, ataHints, input.mint),
        ),
        signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = {
          error: `non-JSON HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`,
        };
      }
      if (!res.ok && !body?.error) body.error = `HTTP ${res.status}`;

      const transient =
        /fetch failed|aborted due to timeout|ECONNRESET|ETIMEDOUT|socket hang up|502|503|504/i.test(
          String(body?.error || ''),
        );
      if (transient && attempt < maxAttempts) {
        console.log(
          `\n  retry ${attempt}/${maxAttempts - 1} ${token.symbol}: ${body.error}`,
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      return summarize(body, token, Date.now() - t0, ataHints, input, wsolScenario);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      const transient =
        /fetch failed|aborted due to timeout|ECONNRESET|ETIMEDOUT|socket hang up/i.test(lastErr);
      if (transient && attempt < maxAttempts) {
        console.log(`\n  retry ${attempt}/${maxAttempts - 1} ${token.symbol}: ${lastErr}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      break;
    }
  }

  return {
    input: input.key,
    inputMint: input.mint,
    inputSymbol: input.symbol,
    amount: input.amount,
    wsolScenario: wsolScenario.key,
    wsolScenarioLabel: wsolScenario.label,
    symbol: token.symbol,
    mint: token.mint,
    ok: false,
    reason: lastErr || 'unknown',
    ms: Date.now() - t0,
    bytes: null,
    txSizeBytes: [],
    txSizeDisplay: null,
    routePlan: [],
    failedMarkets: [],
    triedMarkets: [],
    ataHints: {
      closeWsolAta: ataHints.closeWsolAta === true,
      createOutputAta: ataHints.createOutputAta,
      closeInputAta: ataHints.closeInputAta === true,
    },
  };
}

function writeTsv(file, rows) {
  const header = [
    'ok',
    'input',
    'wsolScenario',
    'closeWsolAta',
    'symbol',
    'mint',
    'bytes',
    'txSizeDisplay',
    'signLabel',
    'hops',
    'protocol',
    'poolAddress',
    'bridgeProtocol',
    'bridgePool',
    'route',
    'failedMarkets',
    'ms',
    'reason',
  ].join('\t');
  const lines = rows.map((r) =>
    [
      r.ok ? '1' : '0',
      r.input ?? '',
      r.wsolScenario ?? '',
      r.ataHints?.closeWsolAta === true ? '1' : '0',
      r.symbol,
      r.mint,
      r.bytes ?? '',
      r.txSizeDisplay ?? '',
      r.signLabel ?? '',
      r.hops ?? '',
      r.protocol ?? '',
      r.poolAddress ?? '',
      r.bridgeProtocol ?? '',
      r.bridgePool ?? '',
      formatRoutePlan(r.routePlan),
      (r.failedMarkets || []).map((f) => `${f.programLabel}:${f.marketAddress}:${f.error}`).join(';'),
      r.ms ?? '',
      (r.reason || r.error || '').replace(/\t|\n/g, ' '),
    ].join('\t'),
  );
  fs.writeFileSync(file, [header, ...lines].join('\n') + '\n');
}

function skipTokenForInput(token, input) {
  if (token.mint === input.mint) return true;
  if (input.key === 'sol' && isSolMint(token.mint)) return true;
  // USDC/USDT are often in top-100 — skip quoting mint→itself / same side
  if (token.mint === USDC && input.mint === USDC) return true;
  if (token.mint === USDT && input.mint === USDT) return true;
  return false;
}

async function runInput(input, top, walletItems, wsolScenario) {
  const wsolHeld = walletHasMint(walletItems, WSOL_MINT);
  const wsolRow = walletItems.find((i) => String(i.mintAddress ?? '').trim() === WSOL_MINT);
  const probes = buildAtaHintsFromWalletItems(
    walletItems,
    input.mint,
    // probe with a dummy non-held output so createOutputAta path is exercised later per-token
    USDC,
    input.amount,
  );
  if (
    wsolScenario.expectCloseWsolAta != null &&
    probes.closeWsolAta !== wsolScenario.expectCloseWsolAta
  ) {
    throw new Error(
      `WSOL scenario ${wsolScenario.key}: expected closeWsolAta=${wsolScenario.expectCloseWsolAta}, got ${probes.closeWsolAta}`,
    );
  }

  const targets = top.filter((t) => !skipTokenForInput(t, input));
  console.log(
    `\n═══ ${input.symbol} → token × ${targets.length} @ ${input.amount} ${input.symbol}, ${SLIPPAGE}% slip ═══`,
  );
  console.log(
    `    WSOL scenario: ${wsolScenario.key} (${wsolScenario.label}) → closeWsolAta=${probes.closeWsolAta}` +
      (wsolHeld ? ` amountExact=${wsolRow?.amountExact ?? '?'}` : ' (no row)'),
  );
  console.log('');

  const rows = [];
  for (let i = 0; i < targets.length; i++) {
    const token = targets[i];
    process.stdout.write(
      `[${input.key}/${wsolScenario.key} ${i + 1}/${targets.length}] ${token.symbol} quoting… `,
    );
    const row = await quoteOne(token, walletItems, input, wsolScenario);
    rows.push(row);
    const tag = row.ok ? `${row.bytes ?? '?'}B` : 'FAIL';
    console.log(`${tag} ${row.ms}ms closeWsol=${row.ataHints?.closeWsolAta ? 1 : 0}`);
    console.log(`  ${formatMarketsLine(row)}`);
    console.log(`  failed: ${formatFailedMarkets(row.failedMarkets)}`);
    if (!row.ok) {
      console.log(`  reason: ${row.reason || row.error || 'unknown'}`);
    }
  }

  const ok = rows.filter((r) => r.ok);
  const fail = rows.filter((r) => !r.ok);
  ok.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const sorted = [...ok, ...fail.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)))];

  const stem = `jupiter-100-${input.key}-wsol-${wsolScenario.key}`;
  const outJson = path.join(OUT_DIR, `${stem}-tx-sizes.json`);
  const outTsv = path.join(OUT_DIR, `${stem}-tx-sizes.tsv`);
  const outFail = path.join(OUT_DIR, `${stem}-failures.json`);

  const payload = {
    scrapedAt: new Date().toISOString(),
    input: input.key,
    inputMint: input.mint,
    inputSymbol: input.symbol,
    amount: input.amount,
    wsolScenario: wsolScenario.key,
    wsolScenarioLabel: wsolScenario.label,
    closeWsolAta: probes.closeWsolAta,
    slippage: SLIPPAGE,
    api: API,
    rpc: heliusRpcUrl() ? 'helius' : 'none',
    concurrency: 1,
    total: rows.length,
    kept: ok.length,
    failed: fail.length,
    rows: sorted,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(payload, null, 2));
  writeTsv(outTsv, sorted);
  fs.writeFileSync(
    outFail,
    JSON.stringify(
      {
        scrapedAt: payload.scrapedAt,
        input: input.key,
        inputMint: input.mint,
        amount: input.amount,
        wsolScenario: wsolScenario.key,
        closeWsolAta: probes.closeWsolAta,
        slippage: SLIPPAGE,
        api: API,
        failed: fail.length,
        total: rows.length,
        rows: fail.map((r) => ({
          symbol: r.symbol,
          mint: r.mint,
          reason: r.reason || r.error || 'unknown',
          ms: r.ms,
          hops: r.hops ?? null,
          poolAddress: r.poolAddress,
          bridgeMint: r.bridgeMint,
          bridgePool: r.bridgePool,
          routePlan: r.routePlan,
          triedMarkets: r.triedMarkets,
          failedMarkets: r.failedMarkets,
          ataHints: r.ataHints,
        })),
      },
      null,
      2,
    ),
  );

  const failLog = path.join(OUT_DIR, `${stem}-failures.log`);
  const failLines = [
    `# ${input.symbol}→token failures @ ${input.amount} ${input.symbol}, ${SLIPPAGE}% slip`,
    `# WSOL scenario=${wsolScenario.key} closeWsolAta=${probes.closeWsolAta}`,
    `# ${payload.scrapedAt}  api=${API}  failed=${fail.length}/${rows.length}`,
    '',
  ];
  for (const r of fail) {
    failLines.push(
      [
        `${r.symbol}\t${r.mint}`,
        `  reason: ${r.reason || r.error || 'unknown'}`,
        `  ms=${r.ms} hops=${r.hops ?? '-'} pool=${r.poolAddress || '-'} bridge=${r.bridgePool || '-'}`,
        `  route: ${formatRoutePlan(r.routePlan)}`,
        `  failedMarkets: ${formatFailedMarkets(r.failedMarkets)}`,
        '',
      ].join('\n'),
    );
  }
  fs.writeFileSync(failLog, failLines.join('\n'));

  console.log(`\n${input.symbol}/${wsolScenario.key}: ${ok.length}/${rows.length} kept`);
  console.log(`  sizes: ${outJson}`);
  console.log(`  sizes: ${outTsv}`);
  console.log(`  fails: ${outFail}`);
  console.log(`  fails: ${failLog}`);

  return payload;
}

async function main() {
  const inputs = parseInputs();
  const wsolScenarios = parseWsolScenarios();
  const slot = await warmHelius();
  console.log(
    `Helius ${slot != null ? `OK (slot ${slot})` : 'skipped'}, API=${API}, slip=${SLIPPAGE}%, inputs=${inputs
      .map((i) => `${i.symbol}@${i.amount}`)
      .join(', ')}`,
  );
  console.log(
    `WSOL scenarios (on-chain): ${wsolScenarios.map((s) => `${s.key}→closeWsolAta=${s.expectCloseWsolAta}`).join(', ')}`,
  );

  const kp = loadBenchmarkWalletKeypair();
  const conn = createBenchmarkConnection();
  console.log(`Signer: ${kp.publicKey.toBase58()} (PROTOCOL_CHECK_WALLET_SECRET)`);

  const top = await fetchJupiterTopTokens(100);

  const summaries = [];
  const allFails = [];
  for (const wsolScenario of wsolScenarios) {
    console.log(`\n── Preparing on-chain WSOL: ${wsolScenario.key} (${wsolScenario.label}) ──`);
    const wsolState = await ensureOnChainWsolScenario(
      conn,
      kp,
      wsolScenario,
      wsolScenario.fundedUi ?? WSOL_FUNDED_UI,
    );
    // Re-fetch holdings after chain mutation; overlay RPC WSOL truth if wallet API lags.
    const fetched = await fetchWalletBalancesOnce();
    const walletItems = mergeWsolStateIntoWalletItems(fetched, wsolState);
    console.log(
      `    wallet rows=${walletItems.length} (API ${fetched.length}); WSOL ${
        wsolState.exists ? `amountExact=${wsolState.amountExact}` : 'absent'
      }`,
    );

    for (const input of inputs) {
      const payload = await runInput(input, top, walletItems, wsolScenario);
      summaries.push({
        input: input.key,
        wsolScenario: wsolScenario.key,
        closeWsolAta: payload.closeWsolAta,
        kept: payload.kept,
        failed: payload.failed,
        total: payload.total,
        amount: payload.amount,
      });
      for (const r of payload.rows.filter((x) => !x.ok)) {
        allFails.push(r);
      }
    }
  }

  // Leave wallet without a lingering funded WSOL if last scenario mutated chain.
  const last = wsolScenarios[wsolScenarios.length - 1];
  if (last && last.key !== 'absent' && last.key !== 'current') {
    console.log('\n── Restoring WSOL absent (cleanup) ──');
    await ensureOnChainWsolScenario(conn, kp, WSOL_SCENARIO_PRESETS.absent);
  }

  const combinedFail = path.join(OUT_DIR, 'jupiter-100-sol-usdc-usdt-failures.json');
  fs.writeFileSync(
    combinedFail,
    JSON.stringify(
      {
        scrapedAt: new Date().toISOString(),
        api: API,
        slippage: SLIPPAGE,
        wsolScenarios: wsolScenarios.map((s) => s.key),
        wsolOnChain: true,
        summaries,
        failed: allFails.length,
        rows: allFails.map((r) => ({
          input: r.input,
          wsolScenario: r.wsolScenario,
          symbol: r.symbol,
          mint: r.mint,
          reason: r.reason || r.error || 'unknown',
          ms: r.ms,
          bytes: r.bytes,
          hops: r.hops ?? null,
          poolAddress: r.poolAddress,
          bridgeMint: r.bridgeMint,
          bridgePool: r.bridgePool,
          routePlan: r.routePlan,
          failedMarkets: r.failedMarkets,
          ataHints: r.ataHints,
        })),
      },
      null,
      2,
    ),
  );

  const combinedLog = path.join(OUT_DIR, 'jupiter-100-sol-usdc-usdt-failures.log');
  const logLines = [
    `# Combined Jupiter-100 failures (inputs × on-chain WSOL scenarios)`,
    `# ${new Date().toISOString()} api=${API}`,
    `# ${summaries.map((s) => `${s.input}/${s.wsolScenario}:${s.kept}/${s.total}`).join(' ')}`,
    '',
  ];
  for (const r of allFails) {
    logLines.push(
      `${r.input}\t${r.wsolScenario}\t${r.symbol}\t${r.mint}\n  reason: ${r.reason || r.error || 'unknown'}\n  bytes=${r.bytes ?? '-'} ms=${r.ms} closeWsolAta=${r.ataHints?.closeWsolAta ? 1 : 0}\n`,
    );
  }
  fs.writeFileSync(combinedLog, logLines.join('\n'));

  console.log('\n═══ SUMMARY ═══');
  for (const s of summaries) {
    console.log(
      `  ${s.input}/${s.wsolScenario}: ${s.kept}/${s.total} kept (@ ${s.amount}, closeWsolAta=${s.closeWsolAta})`,
    );
  }
  console.log(`  combined failures: ${combinedFail}`);
  console.log(`  combined failures: ${combinedLog}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
