/**
 * Express server: proxies Vybe swap quote & build API and serves the web GUI.
 */

import express, { type Request, type Response } from 'express';
import { loadEnv, getApiKey, PUBLIC_DIR } from './config.js';
import { createClient } from './api/index.js';
import { toHumanReadableError } from './api/client.js';
import { VYBE_SWAP_PROTOCOLS, type SwapProxyProtocol } from './api/swap-build.js';
import { getTokenSymbol } from './api/token-symbol.js';
import { readSymbolCacheFromDisk, writeSymbolCacheToDisk } from './cache.js';

loadEnv();
const apiKey = getApiKey();
console.log('VYBE_API_KEY loaded (length %d)', apiKey.length);

const SWAP_PROTOCOL_SET = new Set<string>(VYBE_SWAP_PROTOCOLS);

const app = express();
const client = createClient(apiKey);

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

function q(req: Request, key: string): string {
  const v = req.query[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const first = v[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

function qNum(req: Request, key: string): number | undefined {
  const raw = q(req, key).trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

app.get('/api/token-symbol/:mint', async (req: Request, res: Response) => {
  try {
    const rawMint = req.params.mint;
    const mint = (Array.isArray(rawMint) ? rawMint[0] : rawMint ?? '').trim();
    if (!mint) return res.status(400).json({ error: 'Mint address required' });
    const cache = readSymbolCacheFromDisk();
    if (cache[mint] != null) return res.json({ symbol: cache[mint] });
    let symbol = await getTokenSymbol(mint);
    if (symbol === mint || symbol.trim() === '') {
      try {
        const token = await client.getToken(mint);
        symbol = (token.symbol ?? '').trim() || mint;
      } catch {
        symbol = mint;
      }
    }
    const out = symbol || mint;
    if (symbol !== '' && symbol !== mint) {
      cache[mint] = out;
      writeSymbolCacheToDisk(cache);
    }
    let decimals: number | undefined;
    if (q(req, 'decimals') === '1') {
      try {
        const token = await client.getToken(mint);
        if (typeof token.decimals === 'number' && Number.isFinite(token.decimals)) {
          decimals = token.decimals;
        }
      } catch {
        /* omit decimals on failure */
      }
    }
    res.json({ symbol: out, ...(decimals !== undefined ? { decimals } : {}) });
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err), symbol: Array.isArray(req.params.mint) ? req.params.mint[0] : req.params.mint });
  }
});

app.post('/api/token-symbols', async (req: Request, res: Response) => {
  try {
    const mints = Array.isArray(req.body?.mints)
      ? (req.body.mints as unknown[]).map((m) => String(m).trim()).filter(Boolean)
      : [];
    const symbols: Record<string, string> = {};
    const cache = readSymbolCacheFromDisk();
    const needFetch = mints.filter((mint) => {
      if (cache[mint] != null) {
        symbols[mint] = (cache[mint] ?? '').replace(/\0/g, '').trim();
        return false;
      }
      return true;
    });
    if (needFetch.length > 0) {
      let cacheUpdated = false;
      const results = await Promise.all(
        needFetch.map(async (mint) => {
          try {
            let symbol = await getTokenSymbol(mint);
            if (symbol === mint || symbol.trim() === '') {
              try {
                const token = await client.getToken(mint);
                symbol = (token.symbol ?? '').trim() || mint;
              } catch {
                symbol = mint;
              }
            }
            const out = symbol || mint;
            if (symbol !== '' && symbol !== mint) {
              cache[mint] = out;
              cacheUpdated = true;
            }
            return { mint, symbol: out };
          } catch {
            return { mint, symbol: mint };
          }
        }),
      );
      for (const { mint, symbol } of results) {
        symbols[mint] = symbol;
      }
      if (cacheUpdated) writeSymbolCacheToDisk(cache);
    }
    res.json({ symbols });
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** GET /api/trading/swap-quote — Vybe GET /v4/trading/swap-quote */
app.get('/api/trading/swap-quote', async (req: Request, res: Response) => {
  try {
    const amount = qNum(req, 'amount');
    const inputMintAddress = q(req, 'inputMintAddress').trim();
    const outputMintAddress = q(req, 'outputMintAddress').trim();
    const accountAddress = q(req, 'accountAddress').trim() || undefined;
    const slippage = qNum(req, 'slippage');
    if (amount == null || amount <= 0) {
      return res.status(400).json({ error: 'Query "amount" must be a positive number (UI units)' });
    }
    if (!inputMintAddress) return res.status(400).json({ error: 'inputMintAddress required' });
    if (!outputMintAddress) return res.status(400).json({ error: 'outputMintAddress required' });
    const data = await client.getSwapQuote({
      amount,
      inputMintAddress,
      outputMintAddress,
      accountAddress,
      slippage,
    });
    res.json(data);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** POST /api/trading/swap — Vybe POST /v4/trading/swap */
app.post('/api/trading/swap', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const accountAddress = typeof body.accountAddress === 'string' ? body.accountAddress.trim() : '';
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    const inputMintAddress = typeof body.inputMintAddress === 'string' ? body.inputMintAddress.trim() : '';
    const outputMintAddress = typeof body.outputMintAddress === 'string' ? body.outputMintAddress.trim() : '';
    if (!accountAddress) return res.status(400).json({ error: 'accountAddress required' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!inputMintAddress) return res.status(400).json({ error: 'inputMintAddress required' });
    if (!outputMintAddress) return res.status(400).json({ error: 'outputMintAddress required' });

    const slippage = body.slippage != null ? Number(body.slippage) : undefined;
    const routerRaw = typeof body.router === 'string' ? body.router.trim().toLowerCase() : '';
    const router =
      routerRaw === 'titan' || routerRaw === 'jupiter' || routerRaw === 'vybe' ? routerRaw : undefined;

    const protocolRaw = typeof body.protocol === 'string' ? body.protocol.trim() : '';
    const protocol: SwapProxyProtocol | undefined =
      protocolRaw && SWAP_PROTOCOL_SET.has(protocolRaw) ? (protocolRaw as SwapProxyProtocol) : undefined;

    const data = await client.buildSwap({
      accountAddress,
      amount,
      inputMintAddress,
      outputMintAddress,
      slippage: Number.isFinite(slippage) ? slippage : undefined,
      router,
      autoCalculateSlippage: typeof body.autoCalculateSlippage === 'boolean' ? body.autoCalculateSlippage : undefined,
      gasless: typeof body.gasless === 'boolean' ? body.gasless : undefined,
      partner: typeof body.partner === 'string' ? body.partner : undefined,
      poolAddress: typeof body.poolAddress === 'string' ? body.poolAddress : undefined,
      protocol,
      simulate: typeof body.simulate === 'boolean' ? body.simulate : undefined,
      swapFee: body.swapFee != null ? Number(body.swapFee) : undefined,
    });
    res.json(data);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Open in browser for swap quote and build.');
});
