/**
 * Server-side token icon cache: download remote logos to data/token-icons/
 * and persist token metadata (including price fields) for repeat lookups.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

function findExistingIcon(mint: string): { webPath: string; filePath: string } | null {
  for (const [dir, prefix] of [
    [PUBLIC_ICON_DIR, PUBLIC_ICON_WEB_PREFIX],
    [RUNTIME_ICON_DIR, RUNTIME_ICON_WEB_PREFIX],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const hit = files.find((f) => f === mint || f.startsWith(`${mint}.`));
    if (hit) return { webPath: `${prefix}/${hit}`, filePath: path.join(dir, hit) };
  }
  return null;
}

export function readTokenMetaCache(): Record<string, CachedTokenMeta> {
  return readJsonFile<Record<string, CachedTokenMeta>>(META_CACHE_PATH, {});
}

export function writeTokenMetaCache(data: Record<string, CachedTokenMeta>): void {
  writeJsonFile(META_CACHE_PATH, data);
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

  try {
    const res = await fetch(url, {
      headers: { Accept: 'image/*,*/*;q=0.8', 'User-Agent': 'vybe-swap-demo/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return undefined;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return undefined;
    const ext = extFromContentType(ct) || extFromUrl(url);
    const fileName = `${m}${ext}`;
    const filePath = path.join(RUNTIME_ICON_DIR, fileName);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) return undefined;
    fs.writeFileSync(filePath, buf);
    return `${RUNTIME_ICON_WEB_PREFIX}/${fileName}`;
  } catch {
    return undefined;
  }
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
  };
  cache[m] = updated;
  writeTokenMetaCache(cache);
  return updated;
}

export async function cacheTokenMetaFromVybe(
  mint: string,
  token: Record<string, unknown>,
): Promise<CachedTokenMeta> {
  const m = mint.trim();
  const remoteLogo = typeof token.logoUrl === 'string' ? token.logoUrl.trim() : '';
  const localLogo = (await ensureTokenIconCached(m, remoteLogo)) ?? findExistingIcon(m)?.webPath;
  const fetchedAt = Date.now();
  const meta: CachedTokenMeta = {
    mint: m,
    symbol: String(token.symbol ?? '').trim() || m,
    name: String(token.name ?? '').trim() || String(token.symbol ?? m).trim() || m,
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
