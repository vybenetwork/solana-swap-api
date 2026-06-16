/**
 * Express server: proxies Vybe swap quote & build API and serves the web GUI.
 */

import express, { type Request, type Response } from 'express';
import {
  loadEnv,
  getApiKey,
  PUBLIC_DIR,
  SOLANA_RPC_URL,
  DEFAULT_SWAP_SERVICE_FEE_PCT,
  getVybeApiLocation,
  IX_BUILDER_LOCAL_URL,
} from './config.js';
import { getSolanaRpcHost, logBrowserRpc429 } from './api/solana-connection.js';
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
import { prepareSwapTransactionForSigning } from './api/solana-prepare-swap-tx.js';
import { quoteFromBuild } from './api/map-enrichment.js';
import { createHttpClient } from './api/client.js';
import { getTrades, isVybeApiNotFoundError, type GetTradesParams, type TradesSortField } from './api/trades.js';
import { fetchRankedTopMarketsFromTrades } from './api/route-via-trades.js';

loadEnv();
const apiKey = getApiKey();
console.log('VYBE_API_KEY loaded (length %d)', apiKey.length);
if (getVybeApiLocation() === 'local') {
  console.log('Vybe swap builds → local ix-builder at %s', IX_BUILDER_LOCAL_URL);
} else {
  console.log('Vybe swap builds → Vybe API at https://api.vybenetwork.xyz');
}

const SWAP_PROTOCOL_SET = new Set<string>(VYBE_SWAP_PROTOCOLS);

const app = express();
const client = createClient(apiKey);

app.use(express.json());
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[api] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});
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
  programAddress?: string;
  protocol?: SwapProxyProtocol;
  simulate?: boolean;
  swapFee?: number;
  marketFetchMode?: 'full' | 'trades' | 'markets' | 'rpc';
  enumerateRoutes?: boolean;
  closeInputAta?: boolean;
  createOutputAta?: boolean;
  closeWsolAta?: boolean;
  inputBalanceExact?: string;
  inputDecimals?: number;
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
    programAddress: typeof body.programAddress === 'string' ? body.programAddress.trim() : undefined,
    protocol,
    simulate: typeof body.simulate === 'boolean' ? body.simulate : undefined,
    swapFee:
      body.swapFee != null && Number.isFinite(Number(body.swapFee))
        ? Number(body.swapFee)
        : DEFAULT_SWAP_SERVICE_FEE_PCT,
    marketFetchMode:
      typeof body.marketFetchMode === 'string' &&
      ['full', 'trades', 'markets', 'rpc'].includes(body.marketFetchMode.trim().toLowerCase())
        ? (body.marketFetchMode.trim().toLowerCase() as 'full' | 'trades' | 'markets' | 'rpc')
        : undefined,
    enumerateRoutes: typeof body.enumerateRoutes === 'boolean' ? body.enumerateRoutes : undefined,
    closeInputAta: typeof body.closeInputAta === 'boolean' ? body.closeInputAta : undefined,
    createOutputAta: typeof body.createOutputAta === 'boolean' ? body.createOutputAta : undefined,
    closeWsolAta: typeof body.closeWsolAta === 'boolean' ? body.closeWsolAta : undefined,
    inputBalanceExact:
      typeof body.inputBalanceExact === 'string' ? body.inputBalanceExact.trim() || undefined : undefined,
    inputDecimals:
      body.inputDecimals != null && Number.isFinite(Number(body.inputDecimals))
        ? Number(body.inputDecimals)
        : undefined,
  };
}

/** GET /api/trades — proxy Vybe GET /v4/trades (same params as historical-trade-data repo). */
app.get('/api/trades', async (req: Request, res: Response) => {
  try {
    const sortByAsc = q(req, 'sortByAsc').trim() as TradesSortField | '';
    const sortByDesc = q(req, 'sortByDesc').trim() as TradesSortField | '';
    if (sortByAsc && sortByDesc) {
      return res.status(400).json({ error: 'Only one of sortByAsc or sortByDesc can be set.' });
    }

    const limitRaw = qNum(req, 'limit');
    const limit = limitRaw != null ? Math.min(Math.max(0, limitRaw), 1000) : 250;
    const pageRaw = qNum(req, 'page');
    const page = pageRaw != null ? Math.max(0, Math.trunc(pageRaw)) : undefined;
    const marketAddress = q(req, 'marketAddress').trim();

    const params: GetTradesParams = {
      programAddress: q(req, 'programAddress').trim() || undefined,
      baseMintAddress: q(req, 'baseMintAddress').trim() || undefined,
      quoteMintAddress: q(req, 'quoteMintAddress').trim() || undefined,
      mintAddress: q(req, 'mintAddress').trim() || undefined,
      marketAddress: marketAddress || undefined,
      authorityAddress: q(req, 'authorityAddress').trim() || undefined,
      feePayerAddress: q(req, 'feePayerAddress').trim() || undefined,
      resolution: q(req, 'resolution').trim() || undefined,
      timeStart: qNum(req, 'timeStart'),
      timeEnd: qNum(req, 'timeEnd'),
      page,
      limit,
      sortByAsc: sortByAsc || undefined,
      sortByDesc: sortByDesc || undefined,
    };

    if (params.marketAddress) {
      delete params.baseMintAddress;
      delete params.quoteMintAddress;
    }

    const http = createHttpClient(apiKey);
    const data = await getTrades(http, params);
    res.json(data);
  } catch (err) {
    if (isVybeApiNotFoundError(err)) {
      console.warn('[api/trades] GET /v4/trades returned 404 — returning empty list with warning');
      return res.json({
        data: [],
        warning: 'Vybe GET /v4/trades unavailable (404). Use Jupiter routing instead.',
      });
    }
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** GET /api/route-via-trades/top-markets — rank top trade markets for a mint pair. */
app.get('/api/route-via-trades/top-markets', async (req: Request, res: Response) => {
  try {
    const inputMintAddress = q(req, 'inputMintAddress').trim();
    const outputMintAddress = q(req, 'outputMintAddress').trim();
    if (!inputMintAddress || !outputMintAddress) {
      return res.status(400).json({ error: 'inputMintAddress and outputMintAddress required' });
    }
    const limitRaw = qNum(req, 'limit');
    const topNRaw = qNum(req, 'topN');
    const http = createHttpClient(apiKey);
    const result = await fetchRankedTopMarketsFromTrades(http, {
      inputMintAddress,
      outputMintAddress,
      limit: limitRaw ?? undefined,
      topN: topNRaw ?? undefined,
    });
    res.json(result);
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

/** POST /api/trading/vybe-quote — spot price + build swap (Vybe router; no swap-quote aggregator) */
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
      router: parsed.router ?? 'vybe',
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
      ...(result.routeViaTrades ? { _routeViaTrades: result.routeViaTrades } : {}),
    });
  } catch (err) {
    const status =
      err instanceof InsufficientBalanceError
        ? 400
        : ((err as { response?: { status?: number } })?.response?.status ?? 500);
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** POST /api/trading/vybe-quote-route-enrich — simulate + fee breakdown for one enumerated route */
app.post('/api/trading/vybe-quote-route-enrich', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const accountAddress = typeof body.accountAddress === 'string' ? body.accountAddress.trim() : '';
    const inputMintAddress = typeof body.inputMintAddress === 'string' ? body.inputMintAddress.trim() : '';
    const outputMintAddress = typeof body.outputMintAddress === 'string' ? body.outputMintAddress.trim() : '';
    const poolAddress = typeof body.poolAddress === 'string' ? body.poolAddress.trim() : '';
    const amount = Number(body.amount);
    const build = body.build as import('./types/swap.js').VybeSwapBuildResponse | undefined;
    if (!accountAddress || !inputMintAddress || !outputMintAddress || !poolAddress) {
      return res.status(400).json({ error: 'accountAddress, inputMintAddress, outputMintAddress, and poolAddress are required' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (!build || typeof build !== 'object') {
      return res.status(400).json({ error: 'build is required' });
    }
    const tokenHints =
      body.tokenHints && typeof body.tokenHints === 'object'
        ? (body.tokenHints as Record<string, TokenPriceHint>)
        : undefined;
    const router = typeof body.router === 'string' ? body.router.trim() : 'vybe';

    const quote = await client.enrichVybeRouteQuote({
      accountAddress,
      amount,
      inputMintAddress,
      outputMintAddress,
      poolAddress,
      build,
      tokenHints,
      router: router as import('./api/swap-build.js').SwapProxyRouter,
    });

    res.json(quote);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
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

    // ix-builder is the single source of simulation + fees + USD; swap-api never simulates.
    // Project its enrichment into the legacy `_feeEnrichment` shape the browser already reads.
    const enrichment = data.enrichment;
    const projected = quoteFromBuild(data, {
      uiInputMint: parsed.inputMintAddress,
      uiOutputMint: parsed.outputMintAddress,
    });
    const feeEnrichment = enrichment
      ? {
          routePlan: projected.routePlan,
          quotedOutRaw: enrichment.quotedOutRaw,
          simulatedOutRaw: enrichment.simulatedOutRaw,
          totalFeeRaw: enrichment.totalFeeRaw,
          swapFeePct: enrichment.swapFeePct,
          swapFeeRaw: enrichment.swapFeeRaw,
          outputFromSimulation: enrichment.outputFromSimulation,
          walletPayDebitRaw: enrichment.walletPayDebitRaw,
        }
      : undefined;

    res.json({
      ...data,
      ...(feeEnrichment ? { _feeEnrichment: feeEnrichment } : {}),
      _simulatedOutAmount: enrichment?.simulatedOutRaw ?? null,
      _quotedOutAmount: enrichment?.quotedOutRaw ?? data.details?.quote?.outAmount,
      _walletPayDebitRaw: enrichment?.walletPayDebitRaw ?? null,
      _walletTokenAccountCloses: enrichment?.walletTokenAccountCloses ?? [],
      // Print-ready display fields (so the You pay/receive hero + slippage stay correct
      // even when the final build re-simulates at a reduced SPL sell amount).
      ...(enrichment
        ? {
            _youPay: enrichment.youPay,
            _youReceive: enrichment.youReceive,
            _maxSlippagePct: enrichment.maxSlippagePct,
            _tokens: enrichment.tokens,
            _inputPriceUsd: enrichment.inputPriceUsd,
            _outputPriceUsd: enrichment.outputPriceUsd,
            _otherAmountThresholdRaw: enrichment.otherAmountThresholdRaw,
            _otherAmountThresholdUi: enrichment.otherAmountThresholdUi,
          }
        : {}),
    });
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 500;
    res.status(status).json({ error: toHumanReadableError(err) });
  }
});

/** POST /api/solana/rpc — browser Connection proxy (Moonbags uses in-page Connection for blockhash + send) */
app.post('/api/solana/rpc', async (req: Request, res: Response) => {
  try {
    const rpcMethod = typeof req.body?.method === 'string' ? req.body.method : 'unknown';
    const upstream = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    if (upstream.status === 429) {
      logBrowserRpc429(rpcMethod);
    }
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (err) {
    res.status(500).json({ error: toHumanReadableError(err) });
  }
});

/** GET /api/solana/latest-blockhash — fresh blockhash for wallet simulation before sign (Moonbags CustomSign) */
app.get('/api/solana/latest-blockhash', async (_req: Request, res: Response) => {
  try {
    const { createSolanaConnection } = await import('./api/solana-connection.js');
    const connection = createSolanaConnection('latest-blockhash');
    const latest = await connection.getLatestBlockhash('confirmed');
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: toHumanReadableError(err) });
  }
});

/** POST /api/solana/prepare-swap-tx — refresh blockhash (+ ALTs) so Phantom can simulate swaps */
app.post('/api/solana/prepare-swap-tx', async (req: Request, res: Response) => {
  try {
    const tx = typeof req.body?.tx === 'string' ? req.body.tx : '';
    const prepared = await prepareSwapTransactionForSigning(tx);
    res.json(prepared);
  } catch (err) {
    res.status(400).json({ error: toHumanReadableError(err) });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Solana RPC for sim/validate: ${getSolanaRpcHost()}`);
  console.log('Open in browser for swap quote and build.');
});
