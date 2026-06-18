#!/usr/bin/env node
/**
 * Lightweight local stand-in for Vybe API swap routes (prod-like testing).
 *
 * - POST /v4/trading/swap  → ix-builder /swap (+ enumerateRoutes via /discover-pools)
 * - GET  /v4/trading/swap-quote → ix-builder /swapQuote
 * - All other /v4/* paths → upstream Vybe API (tokens, balances, trades, …)
 *
 * Usage:
 *   IX_BUILDER_BASE_URL=http://127.0.0.1:8000 node tools/local-vybe-proxy.mjs
 *
 * swap-api .env:
 *   vybe_api_location=remote
 *   VYBE_API_BASE=http://127.0.0.1:8080
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const IX_BUILDER = (process.env.IX_BUILDER_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const UPSTREAM = (process.env.VYBE_UPSTREAM_URL ?? 'https://api.vybenetwork.xyz').replace(/\/$/, '');
const PORT = Number(process.env.LOCAL_VYBE_PROXY_PORT ?? 8080);
const MAX_ENUMERATE_ROUTES = 3;

function log(...args) {
  console.log('[local-vybe-proxy]', ...args);
}

function pickForwardHeaders(inHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(inHeaders)) {
    const k = key.toLowerCase();
    if (k === 'host' || k === 'connection' || k === 'content-length') continue;
    if (k.startsWith('x-api-key') || k === 'accept' || k === 'content-type' || k === 'user-agent') {
      out[key] = value;
    }
  }
  return out;
}

function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { message: text };
          }
          resolve({ status: res.statusCode ?? 500, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ixGet(path, query, headers) {
  const url = `${IX_BUILDER}/${path}${query ? `?${query}` : ''}`;
  return requestJson(url, { method: 'GET', headers });
}

async function ixPost(path, body, headers) {
  const url = `${IX_BUILDER}/${path}`;
  return requestJson(url, { method: 'POST', headers, body });
}

function vybeSwapFeeIxBuilder(body) {
  const swapFee = body.swapFee ?? 0;
  const router = body.router ?? 'vybe';
  return router === 'vybe' ? swapFee * 100 : swapFee;
}

function discoverQueryString(body) {
  const mode = (body.marketFetchMode ?? 'full').trim();
  const enumerate = body.enumerateRoutes !== false;
  return `inputMint=${encodeURIComponent(body.inputMintAddress)}&outputMint=${encodeURIComponent(body.outputMintAddress)}&marketFetchMode=${encodeURIComponent(mode)}&enumerateRoutes=${enumerate}&rpcLaunchpads=true`;
}

function quoteOutAmountRaw(swap) {
  const sim = swap?.enrichment?.simulatedOutRaw;
  if (typeof sim === 'string' && sim) {
    try {
      return BigInt(sim);
    } catch {
      /* ignore */
    }
  }
  const out = swap?.details?.quote?.outAmount;
  if (typeof out === 'string' && out) {
    try {
      return BigInt(out);
    } catch {
      /* ignore */
    }
  }
  return 0n;
}

function swapHasTransaction(swap) {
  const tx = swap?.transaction ?? swap?.tx;
  return typeof tx === 'string' && tx.length > 0;
}

function isPureRpcPool(pool) {
  return String(pool?.source ?? '').toLowerCase() === 'rpc';
}

function poolsForEnumerationProbe(pools) {
  const primary = pools.filter((p) => !isPureRpcPool(p));
  const ordered = primary.length ? [...primary] : [...pools];
  if (primary.length) {
    for (const p of pools) {
      if (isPureRpcPool(p)) ordered.push(p);
    }
  }
  return ordered;
}

function shouldEnumerateVybeRoutes(body) {
  const router = body.router ?? 'vybe';
  return (
    router === 'vybe' &&
    body.enumerateRoutes !== false &&
    typeof body.marketFetchMode === 'string' &&
    body.marketFetchMode.trim().length > 0 &&
    !body.poolAddress
  );
}

function pinnedSwapBody(params, pool) {
  const body = {
    wallet: params.accountAddress,
    amount: params.amount,
    inputMint: params.inputMintAddress,
    outputMint: params.outputMintAddress,
    router: 'vybe',
    slippage: params.slippage ?? 5,
    fee: vybeSwapFeeIxBuilder(params),
    simulate: false,
    enrich: true,
    gasless: params.gasless ?? false,
    autoCalculateSlippage: params.autoCalculateSlippage ?? false,
    partner: params.partner ?? 'vybe',
    pool: pool.marketAddress,
    programAddress: pool.programAddress,
  };
  if (pool.protocol) body.protocol = pool.protocol;
  if (params.closeInputAta === true) body.closeInputAta = true;
  if (params.createOutputAta === true) body.createOutputAta = true;
  if (params.closeWsolAta === true) body.closeWsolAta = true;
  if (params.inputBalanceExact) body.inputBalanceExact = params.inputBalanceExact;
  if (params.inputDecimals != null) body.inputDecimals = params.inputDecimals;
  if (params.tokenHints && typeof params.tokenHints === 'object') body.tokenHints = params.tokenHints;
  return body;
}

function mapSwapToIxBuilder(body) {
  const swapFee = body.swapFee ?? 0;
  const router = body.router ?? 'vybe';
  const ixFee = router === 'vybe' ? swapFee * 100 : swapFee;
  const mapped = {
    wallet: body.accountAddress,
    amount: body.amount,
    inputMint: body.inputMintAddress,
    outputMint: body.outputMintAddress,
    router,
    slippage: body.slippage ?? 5,
    fee: ixFee,
    simulate: body.simulate ?? false,
    enrich: body.enrich ?? true,
    gasless: body.gasless ?? false,
    autoCalculateSlippage: body.autoCalculateSlippage ?? false,
    partner: body.partner ?? 'vybe',
    enumerateRoutes: body.enumerateRoutes !== false,
  };
  if (body.protocol) mapped.protocol = body.protocol;
  if (body.poolAddress) mapped.pool = body.poolAddress;
  if (body.programAddress) mapped.programAddress = body.programAddress;
  if (body.marketFetchMode) mapped.marketFetchMode = body.marketFetchMode;
  if (body.closeInputAta === true) mapped.closeInputAta = true;
  if (body.createOutputAta === true) mapped.createOutputAta = true;
  if (body.closeWsolAta === true) mapped.closeWsolAta = true;
  if (body.inputBalanceExact) mapped.inputBalanceExact = body.inputBalanceExact;
  if (body.inputDecimals != null) mapped.inputDecimals = body.inputDecimals;
  if (body.tokenHints && typeof body.tokenHints === 'object') mapped.tokenHints = body.tokenHints;
  return mapped;
}

async function enumerateVybeSwapRoutes(body, headers) {
  const discover = await ixGet('discover-pools', discoverQueryString(body), headers);
  if (discover.status >= 400) {
    return { status: discover.status, json: discover.json };
  }
  const pools = Array.isArray(discover.json?.pools) ? discover.json.pools : [];
  if (!pools.length) {
    return { status: 404, json: { message: 'No eligible pools found for this pair' } };
  }

  const probeOrder = poolsForEnumerationProbe(pools);
  const successes = [];
  for (const pool of probeOrder) {
    if (successes.length >= MAX_ENUMERATE_ROUTES) break;
    const swapRes = await ixPost('swap', pinnedSwapBody(body, pool), headers);
    if (swapRes.status < 400 && swapHasTransaction(swapRes.json) && quoteOutAmountRaw(swapRes.json) > 0n) {
      const route = { ...swapRes.json };
      route.poolAddress = pool.marketAddress;
      route.programAddress = pool.programAddress;
      if (pool.protocol) route.protocol = pool.protocol;
      successes.push({ route, isRpc: isPureRpcPool(pool) });
    }
  }

  if (!successes.length) {
    return { status: 404, json: { message: 'No enumerated Vybe routes could be built for this pair' } };
  }

  const nonRpcLen = successes.filter((s) => !s.isRpc).length;
  let final = successes;
  if (nonRpcLen >= MAX_ENUMERATE_ROUTES) {
    final = successes.filter((s) => !s.isRpc).slice(0, MAX_ENUMERATE_ROUTES);
  }
  final.sort((a, b) => {
    const da = quoteOutAmountRaw(a.route);
    const db = quoteOutAmountRaw(b.route);
    return db > da ? 1 : db < da ? -1 : 0;
  });
  final.forEach((s, i) => {
    s.route.index = i;
  });

  if (final.length === 1) {
    return { status: 200, json: final[0].route };
  }
  const primary = { ...final[0].route };
  primary.outcome = 'multi';
  primary.routes = final.map((s) => s.route);
  return { status: 200, json: primary };
}

async function handleSwap(body, headers) {
  if (body.poolAddress && !body.protocol && !body.programAddress) {
    return {
      status: 400,
      json: { message: 'When poolAddress is provided, protocol or programAddress must also be set' },
    };
  }
  if (shouldEnumerateVybeRoutes(body)) {
    log('POST /v4/trading/swap enumerate → ix-builder discover-pools + swap');
    return enumerateVybeSwapRoutes(body, headers);
  }
  log('POST /v4/trading/swap → ix-builder /swap');
  const res = await ixPost('swap', mapSwapToIxBuilder(body), headers);
  return { status: res.status, json: res.json };
}

async function handleSwapQuote(query, headers) {
  const body = {
    amount: Number(query.amount),
    inputMint: query.inputMintAddress,
    outputMint: query.outputMintAddress,
    slippage: query.slippage != null ? Number(query.slippage) : 5,
  };
  if (query.accountAddress) body.wallet = query.accountAddress;
  log('GET /v4/trading/swap-quote → ix-builder /swapQuote');
  const res = await ixPost('swapQuote', body, headers);
  return { status: res.status, json: res.json };
}

async function passthroughUpstream(req, bodyText) {
  const url = new URL(req.url ?? '/', UPSTREAM);
  const headers = pickForwardHeaders(req.headers);
  const method = req.method ?? 'GET';
  let body;
  if (bodyText && method !== 'GET' && method !== 'HEAD') {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  const res = await requestJson(url.toString(), { method, headers, body });
  return { status: res.status, json: res.json };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const path = req.url?.split('?')[0] ?? '/';
    const query = req.url?.includes('?') ? req.url.split('?')[1] : '';
    const headers = pickForwardHeaders(req.headers);
    const bodyText = await readBody(req);

    let result;
    if (req.method === 'POST' && path === '/v4/trading/swap') {
      const body = bodyText ? JSON.parse(bodyText) : {};
      result = await handleSwap(body, headers);
    } else if (req.method === 'GET' && path === '/v4/trading/swap-quote') {
      const params = Object.fromEntries(new URLSearchParams(query));
      result = await handleSwapQuote(params, headers);
    } else if (path.startsWith('/v4/')) {
      log(`${req.method} ${path} → upstream ${UPSTREAM}`);
      result = await passthroughUpstream(req, bodyText);
    } else {
      result = { status: 404, json: { message: 'Not found' } };
    }

    const payload = JSON.stringify(result.json ?? {});
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(payload);
  } catch (err) {
    console.error('[local-vybe-proxy] error:', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`ix-builder → ${IX_BUILDER}`);
  log(`upstream passthrough → ${UPSTREAM}`);
  log('swap-api .env: vybe_api_location=remote  VYBE_API_BASE=http://127.0.0.1:' + PORT);
});
