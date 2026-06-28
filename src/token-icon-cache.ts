/**
 * Server-side token icon cache: download remote logos to data/token-icons/
 * and persist token metadata (including price fields) for repeat lookups.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isMintLikeLabel, truncateMintDisplay } from './api/token-label.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLIC_ICON_DIR = path.join(ROOT_DIR, 'public', 'data', 'token-icons');
const RUNTIME_ICON_DIR = path.join(DATA_DIR, 'token-icons');
const META_CACHE_PATH = path.join(DATA_DIR, 'token-meta-cache.json');

export const PUBLIC_ICON_WEB_PREFIX = '/data/token-icons';
export const RUNTIME_ICON_WEB_PREFIX = '/cached/token-icons';

export interface CachedTokenMeta {
  mint: string;
  symbol: string;
  name: string;
  decimals?: number;
  logoUrl?: string;
  isVerified?: boolean;
  organicScore?: number;
  tokenProgram?: string;
  price?: number;
  price1d?: number;
  price7d?: number;
  priceUpdateTime?: number;
  /** Epoch ms when price fields were last fetched for quote TTL */
  priceFetchedAt?: number;
  /** Which resolver last fetched the spot price (for TTL cache hits). */
  priceSource?: 'Vybe' | 'Jupiter' | 'Pumpfun-API';
  marketCapUsd?: number;
  liquidityUsd?: number;
  poolAddress?: string;
  bondingCurveAddress?: string;
  programAddress?: string;
  quoteMintAddress?: string;
  complete?: boolean;
  description?: string;
  twitter?: string;
  website?: string;
  isBanned?: boolean;
  pumpfunStatus?: string;
  creatorAddress?: string;
  fetchedAt: string;
}

function readJsonFile<T>(filePath: string, defaultVal: T): T {
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as T;
    return parsed != null && typeof parsed === 'object' ? parsed : defaultVal;
  } catch {
    return defaultVal;
  }
}

function writeJsonFile(filePath: string, data: object): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
}

function extFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(png|jpe?g|svg|webp|gif)$/i);
    if (m) {
      const ext = m[1].toLowerCase();
      return ext === 'jpeg' ? '.jpg' : `.${ext}`;
    }
  } catch {
    /* ignore */
  }
  return '.png';
}

function extFromContentType(ct: string): string {
  const t = ct.toLowerCase();
  if (t.includes('svg')) return '.svg';
  if (t.includes('webp')) return '.webp';
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  if (t.includes('gif')) return '.gif';
  return '.png';
}

function isLocalIconUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith(PUBLIC_ICON_WEB_PREFIX) || url.startsWith(RUNTIME_ICON_WEB_PREFIX);
}

function isImageBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return true;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return true;
  }
  const start = buf.slice(0, Math.min(buf.length, 256)).toString('utf8').trimStart();
  return start.startsWith('<svg') || start.startsWith('<?xml');
}

function imageUrlFromMetadataJson(buf: Buffer): string | null {
  try {
    const text = buf.toString('utf8').trim();
    if (!text.startsWith('{')) return null;
    const data = JSON.parse(text) as { image?: unknown };
    const image = String(data.image ?? '').trim();
    return image || null;
  } catch {
    return null;
  }
}

function isValidIconFile(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    return isImageBuffer(buf);
  } catch {
    return false;
  }
}

function removeInvalidIconFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath) && !isValidIconFile(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    /* ignore */
  }
}

function findExistingIcon(mint: string): { webPath: string; filePath: string } | null {
  for (const [dir, prefix] of [
    [PUBLIC_ICON_DIR, PUBLIC_ICON_WEB_PREFIX],
    [RUNTIME_ICON_DIR, RUNTIME_ICON_WEB_PREFIX],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const hit = files.find((f) => f === mint || f.startsWith(`${mint}.`));
    if (!hit) continue;
    const filePath = path.join(dir, hit);
    if (!isValidIconFile(filePath)) {
      removeInvalidIconFile(filePath);
      continue;
    }
    return { webPath: `${prefix}/${hit}`, filePath };
  }
  return null;
}

export function readTokenMetaCache(): Record<string, CachedTokenMeta> {
  return readJsonFile<Record<string, CachedTokenMeta>>(META_CACHE_PATH, {});
}

export function writeTokenMetaCache(data: Record<string, CachedTokenMeta>): void {
  writeJsonFile(META_CACHE_PATH, data);
}

export function hasCachedTokenIcon(mint: string): boolean {
  return findExistingIcon(mint.trim()) != null;
}

export function clearMintLikeStubFromDisk(mint: string): void {
  const m = mint.trim();
  if (!m) return;
  const cache = readTokenMetaCache();
  const entry = cache[m];
  if (!entry) return;
  if (!isMintLikeLabel(entry.symbol ?? '', m) && !isMintLikeLabel(entry.name ?? '', m)) return;
  delete cache[m];
  writeTokenMetaCache(cache);
}

export function isUnusableTokenMeta(meta: CachedTokenMeta | null, mint: string): boolean {
  if (!meta) return true;
  return isMintLikeLabel(meta.symbol ?? '', mint);
}

export function getCachedTokenMetaFromDisk(mint: string): CachedTokenMeta | null {
  const m = mint.trim();
  if (!m) return null;
  const hit = readTokenMetaCache()[m];
  if (!hit) return null;
  if (hit.logoUrl && isLocalIconUrl(hit.logoUrl)) {
    const existing = findExistingIcon(m);
    if (!existing) return { ...hit, logoUrl: undefined };
  }
  return hit;
}

function iconFetchUrls(remoteUrl: string): string[] {
  const url = remoteUrl.trim();
  if (!url) return [];
  const urls = [url];
  const cidMatch = url.match(/\/ipfs\/([^/?#]+)/i);
  if (cidMatch?.[1]) {
    const cid = cidMatch[1];
    for (const gateway of [
      `https://cloudflare-ipfs.com/ipfs/${cid}`,
      `https://gateway.pinata.cloud/ipfs/${cid}`,
      `https://dweb.link/ipfs/${cid}`,
    ]) {
      if (!urls.includes(gateway)) urls.push(gateway);
    }
  }
  return urls;
}

async function fetchIconBytes(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'image/*,application/json,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) return null;
    return { buf, contentType };
  } catch {
    return null;
  }
}

function iconExtension(buf: Buffer, contentType: string, url: string): string {
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return '.webp';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
  const start = buf.slice(0, Math.min(buf.length, 256)).toString('utf8').trimStart();
  if (start.startsWith('<svg') || start.startsWith('<?xml')) return '.svg';
  return extFromContentType(contentType) || extFromUrl(url) || '.png';
}

async function downloadAndCacheIcon(
  mint: string,
  remoteUrl: string,
  depth = 0,
): Promise<string | undefined> {
  if (depth > 2) return undefined;

  for (const tryUrl of iconFetchUrls(remoteUrl)) {
    const fetched = await fetchIconBytes(tryUrl);
    if (!fetched) continue;
    const { buf, contentType } = fetched;

    if (isImageBuffer(buf)) {
      const ext = iconExtension(buf, contentType, tryUrl);
      const fileName = `${mint}${ext}`;
      const filePath = path.join(RUNTIME_ICON_DIR, fileName);
      fs.writeFileSync(filePath, buf);
      return `${RUNTIME_ICON_WEB_PREFIX}/${fileName}`;
    }

    const nestedImageUrl = imageUrlFromMetadataJson(buf);
    if (nestedImageUrl) {
      const nested = await downloadAndCacheIcon(mint, nestedImageUrl, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

export async function ensureTokenIconCached(
  mint: string,
  remoteUrl: string | undefined,
): Promise<string | undefined> {
  const m = mint.trim();
  if (!m) return undefined;

  const existing = findExistingIcon(m);
  if (existing) return existing.webPath;

  const url = (remoteUrl ?? '').trim();
  if (!url) return undefined;
  if (isLocalIconUrl(url)) return url;

  fs.mkdirSync(RUNTIME_ICON_DIR, { recursive: true });
  return downloadAndCacheIcon(m, url);
}

function vybeDecimals(token: Record<string, unknown>): number | undefined {
  if (typeof token.decimals === 'number' && Number.isFinite(token.decimals)) return token.decimals;
  if (typeof token.decimal === 'number' && Number.isFinite(token.decimal)) return token.decimal;
  return undefined;
}

export function mergePriceFieldsOnly(
  mint: string,
  token: Record<string, unknown>,
  fetchedAt: number = Date.now(),
): CachedTokenMeta | null {
  const m = mint.trim();
  if (!m) return null;
  const cache = readTokenMetaCache();
  const existing = cache[m];
  if (!existing) return null;

  const price = typeof token.price === 'number' ? token.price : existing.price;
  const price1d = typeof token.price1d === 'number' ? token.price1d : existing.price1d;
  const price7d = typeof token.price7d === 'number' ? token.price7d : existing.price7d;
  const priceUpdateTime =
    typeof token.updateTime === 'number' ? token.updateTime : existing.priceUpdateTime;
  const decimals = vybeDecimals(token) ?? existing.decimals;

  const updated: CachedTokenMeta = {
    ...existing,
    price,
    price1d,
    price7d,
    priceUpdateTime,
    priceFetchedAt: fetchedAt,
    decimals,
    priceSource:
      token.priceSource === 'Vybe' ||
      token.priceSource === 'Jupiter' ||
      token.priceSource === 'Pumpfun-API'
        ? token.priceSource
        : existing.priceSource,
  };
  cache[m] = updated;
  writeTokenMetaCache(cache);
  return updated;
}

function pickOptionalString(token: Record<string, unknown>, key: string): string | undefined {
  const v = String(token[key] ?? '').trim();
  return v || undefined;
}

function pickOptionalNumber(token: Record<string, unknown>, key: string): number | undefined {
  const n = typeof token[key] === 'number' ? token[key] : Number(token[key]);
  return Number.isFinite(n) ? n : undefined;
}

function pickOptionalBool(token: Record<string, unknown>, key: string): boolean | undefined {
  const v = token[key];
  return typeof v === 'boolean' ? v : undefined;
}

export async function cacheTokenMetaFromVybe(
  mint: string,
  token: Record<string, unknown>,
): Promise<CachedTokenMeta> {
  const m = mint.trim();
  const remoteLogo = typeof token.logoUrl === 'string' ? token.logoUrl.trim() : '';
  const localLogo = (await ensureTokenIconCached(m, remoteLogo)) ?? findExistingIcon(m)?.webPath;
  const fetchedAt = Date.now();
  const rawSymbol = String(token.symbol ?? '').trim();
  const rawName = String(token.name ?? '').trim();
  const meta: CachedTokenMeta = {
    mint: m,
    symbol:
      rawSymbol && !isMintLikeLabel(rawSymbol, m) ? rawSymbol : truncateMintDisplay(m),
    name:
      rawName && !isMintLikeLabel(rawName, m)
        ? rawName
        : rawSymbol && !isMintLikeLabel(rawSymbol, m)
          ? rawSymbol
          : truncateMintDisplay(m),
    decimals: vybeDecimals(token),
    logoUrl: localLogo || undefined,
    isVerified: token.isVerified === true || token.verified === true,
    organicScore: typeof token.organicScore === 'number' ? token.organicScore : undefined,
    tokenProgram: typeof token.tokenProgram === 'string' ? token.tokenProgram : undefined,
    price: typeof token.price === 'number' ? token.price : undefined,
    price1d: typeof token.price1d === 'number' ? token.price1d : undefined,
    price7d: typeof token.price7d === 'number' ? token.price7d : undefined,
    priceUpdateTime:
      typeof token.priceUpdateTime === 'number'
        ? token.priceUpdateTime
        : typeof token.updateTime === 'number'
          ? token.updateTime
          : undefined,
    priceFetchedAt:
      typeof token.priceFetchedAt === 'number' ? token.priceFetchedAt : fetchedAt,
    priceSource:
      token.priceSource === 'Vybe' ||
      token.priceSource === 'Jupiter' ||
      token.priceSource === 'Pumpfun-API'
        ? token.priceSource
        : undefined,
    marketCapUsd:
      pickOptionalNumber(token, 'marketCapUsdNum') ??
      (typeof token.marketCapUsd === 'string' ? pickOptionalNumber({ marketCapUsdNum: token.marketCapUsd }, 'marketCapUsdNum') : undefined),
    liquidityUsd: pickOptionalNumber(token, 'liquidityUsd'),
    poolAddress: pickOptionalString(token, 'poolAddress'),
    bondingCurveAddress: pickOptionalString(token, 'bondingCurveAddress'),
    programAddress: pickOptionalString(token, 'programAddress'),
    quoteMintAddress: pickOptionalString(token, 'quoteMintAddress'),
    complete: pickOptionalBool(token, 'complete'),
    description: pickOptionalString(token, 'description'),
    twitter: pickOptionalString(token, 'twitter'),
    website: pickOptionalString(token, 'website'),
    isBanned: pickOptionalBool(token, 'isBanned'),
    pumpfunStatus: pickOptionalString(token, 'pumpfunStatus'),
    creatorAddress: pickOptionalString(token, 'creatorAddress'),
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
  const cache = readTokenMetaCache();
  cache[m] = meta;
  writeTokenMetaCache(cache);
  return meta;
}

export function getRuntimeIconDir(): string {
  return RUNTIME_ICON_DIR;
}
