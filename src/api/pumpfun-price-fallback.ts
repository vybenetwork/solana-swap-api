/**
 * Pump.fun price fallback when Vybe and Jupiter cannot resolve a mint.
 * Ported from pumpfun-scraper (single mint, sequential — no parallel batching).
 */

import fs from 'fs';
import {
  getPumpfunAuthToken,
  getPumpfunHeadersPath,
} from '../config.js';
import { fetchWithHttpProxy } from './http-proxy-fetch.js';

const PUMPFUN_API_BASE = 'https://frontend-api-v3.pump.fun';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1_000;

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: 'https://pump.fun',
  Referer: 'https://pump.fun/',
};

export type PumpfunTokenStatus = 'active' | 'banned' | 'hidden' | 'error';

export interface PumpfunCoinRecord {
  mint: string;
  status: PumpfunTokenStatus;
  httpStatus: number;
  data: Record<string, unknown> | null;
  error?: string;
}

function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function parsePositiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parsePositiveBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value > 0n ? value : null;
  const digits = String(value ?? '').trim();
  if (!/^\d+$/.test(digits)) return null;
  try {
    const n = BigInt(digits);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turn a raw HTTP response into a PumpfunCoinRecord (mirrors pumpfun-scraper classify). */
export function classifyPumpfunResponse(
  mint: string,
  statusCode: number,
  bodyText: string,
): PumpfunCoinRecord {
  const body = bodyText ?? '';

  if (statusCode === 200 && !body.trim()) {
    return { mint, status: 'hidden', httpStatus: statusCode, data: null };
  }

  if (statusCode !== 200) {
    return {
      mint,
      status: 'error',
      httpStatus: statusCode,
      data: null,
      error: `HTTP ${statusCode}`,
    };
  }

  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    if (data.is_banned === true) {
      return { mint, status: 'banned', httpStatus: statusCode, data };
    }
    return { mint, status: 'active', httpStatus: statusCode, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      mint,
      status: 'error',
      httpStatus: statusCode,
      data: null,
      error: `invalid JSON: ${msg}`,
    };
  }
}

let cachedHeaders: Record<string, string> | null = null;

/** Merge default headers, optional JSON file, and PUMPFUN_AUTH_TOKEN. */
export function loadPumpfunHeaders(): Record<string, string> {
  if (cachedHeaders) return cachedHeaders;

  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  const headersPath = getPumpfunHeadersPath();
  if (headersPath && fs.existsSync(headersPath)) {
    try {
      const fromFile = JSON.parse(fs.readFileSync(headersPath, 'utf-8')) as Record<string, string>;
      Object.assign(headers, fromFile);
    } catch {
      // ignore malformed headers file
    }
  }

  const token = getPumpfunAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  cachedHeaders = headers;
  return headers;
}

/** Derive USD spot price from pump.fun coin payload (usd_market_cap / total_supply). */
export function priceUsdFromPumpfunData(
  data: Record<string, unknown>,
  decimalsHint?: number,
): number | null {
  const usdMc = parsePositiveNumber(data.usd_market_cap);
  const totalSupply = parsePositiveBigInt(data.total_supply);
  const decimals = parsePositiveInt(data.base_decimals) ?? decimalsHint;
  if (usdMc == null || totalSupply == null || decimals == null) return null;

  const supplyUi = Number(totalSupply) / 10 ** decimals;
  if (!(supplyUi > 0)) return null;

  const price = usdMc / supplyUi;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function decimalsFromPumpfunData(
  data: Record<string, unknown>,
  decimalsHint?: number,
): number | null {
  return parsePositiveInt(data.base_decimals) ?? decimalsHint ?? null;
}

/** Fetch a single mint from pump.fun (retries on network/429). */
export async function fetchPumpfunCoin(mint: string): Promise<PumpfunCoinRecord> {
  const url = `${PUMPFUN_API_BASE}/coins/${encodeURIComponent(mint.trim())}`;
  const headers = loadPumpfunHeaders();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithHttpProxy(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await res.text();

      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }

      return classifyPumpfunResponse(mint, res.status, body);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        mint,
        status: 'error',
        httpStatus: 0,
        data: null,
        error: msg,
      };
    }
  }

  return {
    mint,
    status: 'error',
    httpStatus: 0,
    data: null,
    error: 'exhausted retries',
  };
}

const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface PumpfunTokenDetails {
  mint: string;
  status: PumpfunTokenStatus;
  priceUsd: number;
  decimals: number;
  liquidityUsd?: number;
  /** Vybe-shaped token record for disk cache / API responses. */
  token: Record<string, unknown>;
}

function parseNonNegativeNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function pickString(data: Record<string, unknown>, key: string): string | undefined {
  const v = String(data[key] ?? '').trim();
  return v || undefined;
}

/** Estimate pool-side USD liquidity from pump.fun reserve fields. */
export function liquidityUsdFromPumpfunData(
  data: Record<string, unknown>,
  solPriceUsd?: number,
): number | null {
  const quoteMint = pickString(data, 'quote_mint') ?? WSOL_MINT;
  const quoteDecimals = parsePositiveInt(data.quote_decimals) ?? 6;
  const complete = data.complete === true;

  const realQuote = parseNonNegativeNumber(data.real_quote_reserves);
  const virtualQuote =
    parseNonNegativeNumber(data.virtual_quote_reserves) ??
    parseNonNegativeNumber(data.virtual_sol_reserves);
  const realSol = parseNonNegativeNumber(data.real_sol_reserves);
  const virtualSol = parseNonNegativeNumber(data.virtual_sol_reserves);

  if (quoteMint === USDC_MINT) {
    const raw =
      complete && realQuote != null && realQuote > 0
        ? realQuote
        : virtualQuote != null && virtualQuote > 0
          ? virtualQuote
          : null;
    if (raw != null) return raw / 10 ** quoteDecimals;
  }

  const solRaw =
    complete && realSol != null && realSol > 0
      ? realSol
      : virtualSol != null && virtualSol > 0
        ? virtualSol
        : null;
  if (solRaw != null) {
    const solUi = solRaw / 1e9;
    if (typeof solPriceUsd === 'number' && Number.isFinite(solPriceUsd) && solPriceUsd > 0) {
      return solUi * solPriceUsd;
    }
    return solUi;
  }

  const usdMc = parsePositiveNumber(data.usd_market_cap);
  return usdMc;
}

/** Map a pump.fun coin payload to a Vybe-like token record. */
export function mapPumpfunCoinToTokenRecord(
  mint: string,
  record: PumpfunCoinRecord,
  options: { solPriceUsd?: number; decimalsHint?: number } = {},
): PumpfunTokenDetails | null {
  if (record.status === 'hidden' || record.status === 'error' || !record.data) {
    return null;
  }

  const data = record.data;
  const decimals = decimalsFromPumpfunData(data, options.decimalsHint);
  const priceUsd = priceUsdFromPumpfunData(data, decimals ?? options.decimalsHint);
  if (decimals == null || priceUsd == null) return null;

  const liquidityUsd = liquidityUsdFromPumpfunData(data, options.solPriceUsd) ?? undefined;
  const complete = data.complete === true;
  const poolAddress =
    pickString(data, 'pool_address') ?? pickString(data, 'pump_swap_pool');
  const updateMs =
    parsePositiveInt(data.last_trade_timestamp) ??
    (parsePositiveInt(data.updated_at) != null
      ? parsePositiveInt(data.updated_at)! * 1000
      : undefined);
  const usdMarketCap = parsePositiveNumber(data.usd_market_cap);

  const token: Record<string, unknown> = {
    mintAddress: mint,
    symbol: pickString(data, 'symbol') ?? mint.slice(0, 6),
    name: pickString(data, 'name') ?? pickString(data, 'symbol') ?? mint.slice(0, 6),
    decimals,
    decimal: decimals,
    logoUrl: pickString(data, 'image_uri'),
    price: priceUsd,
    marketCapUsd: usdMarketCap != null ? String(usdMarketCap) : undefined,
    marketCapUsdNum: usdMarketCap ?? undefined,
    currentSupply: pickString(data, 'total_supply_str') ?? String(data.total_supply ?? ''),
    updateTime: updateMs,
    tokenProgram: pickString(data, 'token_program'),
    verified: false,
    liquidityUsd,
    poolAddress,
    bondingCurveAddress: pickString(data, 'bonding_curve'),
    associatedBondingCurveAddress: pickString(data, 'associated_bonding_curve'),
    programAddress: complete ? PUMPSWAP_PROGRAM : PUMPFUN_PROGRAM,
    quoteMintAddress: pickString(data, 'quote_mint'),
    complete,
    description: pickString(data, 'description'),
    twitter: pickString(data, 'twitter'),
    website: pickString(data, 'website'),
    metadataUri: pickString(data, 'metadata_uri'),
    bannerUri: pickString(data, 'banner_uri'),
    thumbnailUri: pickString(data, 'thumbnail'),
    creatorAddress: pickString(data, 'creator'),
    isBanned: data.is_banned === true || record.status === 'banned',
    nsfw: data.nsfw === true,
    pumpfunStatus: record.status,
    athMarketCapUsd: parsePositiveNumber(data.ath_market_cap) ?? undefined,
    protocol: pickString(data, 'protocol') ?? pickString(data, 'program'),
  };

  return {
    mint,
    status: record.status,
    priceUsd,
    decimals,
    liquidityUsd,
    token,
  };
}

/** Fetch full token details from pump.fun (single mint). */
export async function fetchPumpfunTokenDetails(
  mint: string,
  options: { solPriceUsd?: number; decimalsHint?: number } = {},
): Promise<PumpfunTokenDetails | null> {
  const record = await fetchPumpfunCoin(mint);
  return mapPumpfunCoinToTokenRecord(mint, record, options);
}

/** USD spot price for a mint via pump.fun API, or null when unavailable. */
export async function fetchPumpfunPriceUsd(
  mint: string,
  decimalsHint?: number,
): Promise<{ priceUsd: number; decimals: number } | null> {
  const details = await fetchPumpfunTokenDetails(mint, { decimalsHint });
  if (!details) return null;
  return { priceUsd: details.priceUsd, decimals: details.decimals };
}
