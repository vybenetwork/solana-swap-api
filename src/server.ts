/**
 * Express server: proxies Vybe swap quote & build API and serves the web GUI.
 */

import express, { type Request, type Response } from 'express';
import { loadEnv, getApiKey, PUBLIC_DIR } from './config.js';
import { createClient } from './api/index.js';
import { toHumanReadableError } from './api/client.js';
import { InsufficientBalanceError } from './api/wallet-balance.js';
import { VYBE_SWAP_PROTOCOLS, type SwapProxyProtocol } from './api/swap-build.js';
import { type TokenPriceHint } from './api/resolve-token-prices.js';
import { getTokenSymbol } from './api/token-symbol.js';
import { readSymbolCacheFromDisk, writeSymbolCacheToDisk } from './cache.js';
import {
  cacheTokenMetaFromVybe,
  getCachedTokenMetaFromDisk,
  getRuntimeIconDir,
} from './token-icon-cache.js';

loadEnv();
const apiKey = getApiKey();
console.log('VYBE_API_KEY loaded (length %d)', apiKey.length);

const SWAP_PROTOCOL_SET = new Set<string>(VYBE_SWAP_PROTOCOLS);

const app = express();
const client = createClient(apiKey);

app.use(express.json());
app.use('/cached/token-icons', express.static(getRuntimeIconDir()));
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

function tokenMetaToApiResponse(meta: ReturnType<typeof getCachedTokenMetaFromDisk>): Record<string, unknown> {
  if (!meta) return {};
  const { fetchedAt: _fetchedAt, ...out } = meta;
  return out;
}

app.get('/api/token/:mint', async (req: Request, res: Response) => {
  try {
    const rawMint = req.params.mint;
    const mint = (Array.isArray(rawMint) ? rawMint[0] : rawMint ?? '').trim();
    if (!mint) return res.status(400).json({ error: 'Mint address required' });

    const cached = getCachedTokenMetaFromDisk(mint);
    if (cached) {
      return res.json(tokenMetaToApiResponse(cached));
    }

    const token = await client.getToken(mint);
    const { priceUsd: _priceUsd, marketCapUsd: _mc, volume24hUsd: _vol, ...rest } = token;
    const meta = await cacheTokenMetaFromVybe(mint, rest as Record<string, unknown>);
    res.json(tokenMetaToApiResponse(meta));
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** POST /api/tokens/resolve-prices — cache-first token price resolution for pair cards and Vybe quotes */
app.post('/api/tokens/resolve-prices', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const mints = Array.isArray(body.mints)
      ? (body.mints as unknown[]).map((m) => String(m).trim()).filter(Boolean)
      : [];
    if (mints.length === 0) return res.status(400).json({ error: 'mints array required' });

    const tokenHints =
      body.tokenHints && typeof body.tokenHints === 'object'
        ? (body.tokenHints as Record<string, TokenPriceHint>)
        : undefined;
    const forceFullDetailsMints = Array.isArray(body.forceFullDetailsMints)
      ? (body.forceFullDetailsMints as unknown[]).map((m) => String(m).trim()).filter(Boolean)
      : undefined;

    const { stats } = await client.resolveTokenPrices(mints, {
      tokenHints,
      forceFullDetailsMints,
    });
    res.json({ stats });
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

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

function balanceCheckStatus(err: unknown): number {
  return err instanceof InsufficientBalanceError ? 400 : 500;
}

/** GET /api/wallets/:ownerAddress/sell-balance-check — verify wallet holds enough sell token (Vybe) */
app.get('/api/wallets/:ownerAddress/sell-balance-check', async (req: Request, res: Response) => {
  try {
    const rawOwner = req.params.ownerAddress;
    const ownerAddress = (Array.isArray(rawOwner) ? rawOwner[0] : rawOwner ?? '').trim();
    const mint = q(req, 'mint').trim();
    const amount = qNum(req, 'amount');
    const symbol = q(req, 'symbol').trim() || undefined;

    if (!ownerAddress) return res.status(400).json({ error: 'Wallet address required' });
    if (!mint) return res.status(400).json({ error: 'mint query parameter required' });
    if (amount == null || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number (UI units)' });
    }

    await client.assertWalletHasSellAmount(ownerAddress, mint, amount, symbol);
    res.json({ ok: true });
  } catch (err) {
    res.status(balanceCheckStatus(err)).json({ error: toHumanReadableError(err) });
  }
});

/** GET /api/wallets/:ownerAddress/low-sol-trade-warning — low SOL warning for SPL sells */
app.get('/api/wallets/:ownerAddress/low-sol-trade-warning', async (req: Request, res: Response) => {
  try {
    const rawOwner = req.params.ownerAddress;
    const ownerAddress = (Array.isArray(rawOwner) ? rawOwner[0] : rawOwner ?? '').trim();
    const inputMint = q(req, 'inputMint').trim();
    const outputMint = q(req, 'outputMint').trim() || undefined;
    const gasless = q(req, 'gasless') === '1' || q(req, 'gasless').toLowerCase() === 'true';

    if (!ownerAddress) return res.status(400).json({ error: 'Wallet address required' });
    if (!inputMint) return res.status(400).json({ error: 'inputMint query parameter required' });

    const result = await client.evaluateLowSolTradeWarning({
      ownerAddress,
      inputMint,
      outputMint,
      gasless,
    });
    res.json(result);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** GET /api/wallets/:ownerAddress/token-balances — wallet holdings for sell token picker */
app.get('/api/wallets/:ownerAddress/token-balances', async (req: Request, res: Response) => {
  try {
    const rawOwner = req.params.ownerAddress;
    const ownerAddress = (Array.isArray(rawOwner) ? rawOwner[0] : rawOwner ?? '').trim();
    if (!ownerAddress) return res.status(400).json({ error: 'Wallet address required' });

    const limitRaw = qNum(req, 'limit');
    const limit = limitRaw != null && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;
    const tokens = await client.listWalletTokenBalances(ownerAddress, limit);
    res.json({ tokens });
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

function parseSwapBuildBody(body: Record<string, unknown>): {
  accountAddress: string;
  amount: number;
  inputMintAddress: string;
  outputMintAddress: string;
  slippage?: number;
  router?: 'titan' | 'jupiter' | 'vybe';
  autoCalculateSlippage?: boolean;
  gasless?: boolean;
  partner?: string;
  poolAddress?: string;
  protocol?: SwapProxyProtocol;
  simulate?: boolean;
  swapFee?: number;
} | { error: string } {
  const accountAddress = typeof body.accountAddress === 'string' ? body.accountAddress.trim() : '';
  const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
  const inputMintAddress = typeof body.inputMintAddress === 'string' ? body.inputMintAddress.trim() : '';
  const outputMintAddress = typeof body.outputMintAddress === 'string' ? body.outputMintAddress.trim() : '';
  if (!accountAddress) return { error: 'accountAddress required' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount must be a positive number' };
  if (!inputMintAddress) return { error: 'inputMintAddress required' };
  if (!outputMintAddress) return { error: 'outputMintAddress required' };

  const slippage = body.slippage != null ? Number(body.slippage) : undefined;
  const routerRaw = typeof body.router === 'string' ? body.router.trim().toLowerCase() : '';
  const router =
    routerRaw === 'titan' || routerRaw === 'jupiter' || routerRaw === 'vybe' ? routerRaw : undefined;

  const protocolRaw = typeof body.protocol === 'string' ? body.protocol.trim() : '';
  const protocol: SwapProxyProtocol | undefined =
    protocolRaw && SWAP_PROTOCOL_SET.has(protocolRaw) ? (protocolRaw as SwapProxyProtocol) : undefined;

  return {
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
  };
}

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

/** POST /api/trading/vybe-quote — spot price + build swap (no swap-quote aggregator) */
app.post('/api/trading/vybe-quote', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const parsed = parseSwapBuildBody(body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    const tokenHints =
      body.tokenHints && typeof body.tokenHints === 'object'
        ? (body.tokenHints as Record<string, TokenPriceHint>)
        : undefined;
    const forceFullDetailsMints = Array.isArray(body.forceFullDetailsMints)
      ? (body.forceFullDetailsMints as unknown[]).map((m) => String(m).trim()).filter(Boolean)
      : undefined;

    const result = await client.buildVybeQuote({
      ...parsed,
      router: 'vybe',
      tokenHints,
      forceFullDetailsMints,
    });

    res.json({
      ...result.quote,
      ...(result.build
        ? { _build: result.build, _builtAt: result.builtAt }
        : { _buildUnavailable: true }),
      _tokenStats: result.tokenStats,
      _quoteSource: result.quote._quoteSource ?? 'vybe-price-build',
    });
  } catch (err) {
    const status =
      err instanceof InsufficientBalanceError
        ? 400
        : ((err as { response?: { status?: number } })?.response?.status ?? 500);
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** POST /api/trading/swap — Vybe POST /v4/trading/swap */
app.post('/api/trading/swap', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const parsed = parseSwapBuildBody(body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    const data =
      parsed.router === 'vybe'
        ? await client.buildSwapWithFallback(parsed)
        : await client.buildSwap(parsed);
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
