#!/usr/bin/env node
/**
 * Compare POST /v4/trading/swap response shape: local proxy vs Rust API.
 */
import http from 'node:http';

const PROXY = 'http://127.0.0.1:8080';
const RUST = 'http://127.0.0.1:8090';
const WALLET = '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const CASES = [
  { label: 'buy USD (SOL→USDC) vybe', router: 'vybe', input: SOL, output: USDC, amount: 0.01 },
  { label: 'sell USD (USDC→SOL) vybe', router: 'vybe', input: USDC, output: SOL, amount: 0.01778 },
  { label: 'buy USD (SOL→USDC) jupiter', router: 'jupiter', input: SOL, output: USDC, amount: 0.01 },
  { label: 'sell USD (USDC→SOL) jupiter', router: 'jupiter', input: USDC, output: SOL, amount: 0.01778 },
  { label: 'buy USD (SOL→USDC) titan', router: 'titan', input: SOL, output: USDC, amount: 0.01 },
  { label: 'sell USD (USDC→SOL) titan', router: 'titan', input: USDC, output: SOL, amount: 0.01778 },
];

async function swap(base, body, opts) {
  const t0 = Date.now();
  const payload = JSON.stringify(body);
  const u = new URL(`${base}/v4/trading/swap`);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  };
  if (opts?.apiKey) {
    const key = process.env.VYBE_API_KEY;
    if (key) headers['x-api-key'] = key;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { _raw: text?.slice(0, 200) };
          }
          resolve({ status: res.statusCode, json, ms: Date.now() - t0 });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function shapeSummary(json) {
  if (!json || typeof json !== 'object') return { error: 'non-object' };
  const tx = Boolean(json.transaction ?? json.tx);
  const keys = Object.keys(json).filter((k) => !['transaction', 'tx', 'routes'].includes(k)).sort();
  const enrichKeys =
    json.enrichment && typeof json.enrichment === 'object' ? Object.keys(json.enrichment).sort() : [];
  const detailsKeys =
    json.details && typeof json.details === 'object' ? Object.keys(json.details).sort() : [];
  return {
    provider: json.provider ?? null,
    outcome: json.outcome ?? null,
    routeCount: Array.isArray(json.routes) ? json.routes.length : 0,
    hasTx: tx,
    hasEnrichment: Boolean(json.enrichment),
    topKeys: keys,
    enrichKeys,
    detailsKeys,
    quoteProvider: json.details?.quote?.provider ?? null,
    message: json.message ?? json.error ?? null,
  };
}

function shapesMatch(a, b) {
  const fields = ['provider', 'hasTx', 'hasEnrichment', 'outcome', 'routeCount'];
  const diffs = [];
  for (const f of fields) {
    if (a[f] !== b[f]) diffs.push(`${f}: proxy=${a[f]} rust=${b[f]}`);
  }
  if (JSON.stringify(a.topKeys) !== JSON.stringify(b.topKeys)) diffs.push('topKeys differ');
  if (JSON.stringify(a.enrichKeys) !== JSON.stringify(b.enrichKeys)) {
    diffs.push(`enrichKeys: proxy=[${a.enrichKeys}] rust=[${b.enrichKeys}]`);
  }
  if (JSON.stringify(a.detailsKeys) !== JSON.stringify(b.detailsKeys)) {
    diffs.push(`detailsKeys: proxy=[${a.detailsKeys}] rust=[${b.detailsKeys}]`);
  }
  return diffs;
}

function buildBody({ router, input, output, amount }) {
  return {
    accountAddress: WALLET,
    amount,
    inputMintAddress: input,
    outputMintAddress: output,
    router,
    slippage: 2,
    enrich: true,
    enumerateRoutes: false,
    ...(router === 'vybe'
      ? { marketFetchMode: 'full', closeWsolAta: true, createOutputAta: true }
      : {}),
  };
}

async function main() {
  console.log('Comparing local proxy :8080 vs Rust API :8090\n');
  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    const body = buildBody(c);
    console.log(`\n## ${c.label}`);

    const [proxyRes, rustRes] = await Promise.all([
      swap(PROXY, body, { apiKey: true }),
      swap(RUST, body, { apiKey: false }),
    ]);

    const proxyShape = shapeSummary(proxyRes.json);
    const rustShape = shapeSummary(rustRes.json);

    console.log(
      `  proxy HTTP ${proxyRes.status} ${proxyRes.ms}ms | rust HTTP ${rustRes.status} ${rustRes.ms}ms`,
    );
    console.log(`  proxy: ${JSON.stringify(proxyShape)}`);
    console.log(`  rust:  ${JSON.stringify(rustShape)}`);

    if (proxyRes.status !== 200 || rustRes.status !== 200) {
      const sameError =
        proxyRes.status === rustRes.status &&
        JSON.stringify(proxyShape.topKeys) === JSON.stringify(rustShape.topKeys) &&
        proxyShape.message === rustShape.message;
      if (sameError) {
        console.log(`  OK error shape match (HTTP ${proxyRes.status}: ${proxyShape.message})`);
        pass++;
      } else {
        console.log('  FAIL — status/shape mismatch on error');
        fail++;
      }
      continue;
    }

    const diffs = shapesMatch(proxyShape, rustShape);
    if (diffs.length === 0) {
      console.log('  OK shape match');
      pass++;
    } else {
      console.log(`  shape diff: ${diffs.join('; ')}`);
      fail++;
    }
  }

  console.log(`\n---\n${pass} matched, ${fail} mismatched/failed (${CASES.length} total)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
