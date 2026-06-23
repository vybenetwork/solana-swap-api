/**
 * Token picker modal — catalog from token-catalog.tsv + local device cache for searches.
 */

import { WALLET_TOKEN_BALANCE_LIMIT } from '../wallet-balance-limit.js';

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string;
  decimals?: number;
  price?: number;
  price1d?: number;
  price7d?: number;
  priceUpdateTime?: number;
  priceFetchedAt?: number;
  tags?: string[];
  organicScore?: number;
  isVerified?: boolean;
  source: 'catalog' | 'search';
  savedAt: number;
}

export interface TokenPriceStats {
  price: number;
  price1d?: number;
  price7d?: number;
  decimals: number;
  priceFetchedAt: number;
  priceUpdateTime?: number;
}

export type TokenPickerSide = 'input' | 'output';

export interface WalletBalanceListItem {
  mintAddress: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  decimals: number;
  amountUi: number;
  /** Raw base-unit balance (integer string). */
  amountExact?: string;
  valueUsd: number;
  /** Set when Jupiter quoted to WSOL; convert to USD with cached SOL price. */
  valueSol?: number;
  verified: boolean;
  /** True while server-side Vybe/Jupiter enrichment is still running. */
  enrichmentPending?: boolean;
}

const CACHE_KEY = 'vybe-swap-token-cache-v1';
const RECENT_KEY = 'vybe-swap-token-recent-v1';
const MAX_RECENT = 24;
const CATALOG_JSON_URL = '/data/token-catalog.json';
const CATALOG_TSV_URL = '/data/token-catalog.tsv';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let catalogTokens: TokenMeta[] = [];
let catalogLoaded = false;
let activeSide: TokenPickerSide = 'input';
let activeTab: 'top' | 'recent' | 'wallet' = 'top';
let searchQuery = '';
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMintLookup: string | null = null;

let dialogEl: HTMLDialogElement | null = null;
let searchInputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let shortcutsEl: HTMLElement | null = null;
let walletBalancesEl: HTMLElement | null = null;
let walletBalancesListEl: HTMLElement | null = null;
let tabsEl: HTMLElement | null = null;
let listWrapEl: HTMLElement | null = null;
let searchWrapEl: HTMLElement | null = null;
let walletTabEl: HTMLElement | null = null;
let topTabEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let onSelectCb: ((mint: string, side: TokenPickerSide) => void) | null = null;
let getWalletAddressCb: (() => string) | null = null;
let canOpenSellPickerCb: (() => boolean) | null = null;
let canOpenBuyPickerCb: (() => boolean) | null = null;
let onRefetchHoldingsCb: (() => void | Promise<void>) | null = null;
let getWalletHoldingsFetchingCb: (() => boolean) | null = null;

let refetchHoldingsBtn: HTMLButtonElement | null = null;
let refetchHoldingsTimerEl: HTMLElement | null = null;
let refetchHoldingsCooldownEndsAt = 0;
let refetchHoldingsCooldownRaf = 0;
let refetchHoldingsInFlight = false;
const REFETCH_HOLDINGS_COOLDOWN_SEC = 15;

let bodyScrollLockActive = false;
let savedBodyOverflow = '';
let savedHtmlOverflow = '';
let savedBodyPaddingRight = '';

function lockPageScroll(): void {
  if (bodyScrollLockActive) return;
  bodyScrollLockActive = true;
  savedBodyOverflow = document.body.style.overflow;
  savedHtmlOverflow = document.documentElement.style.overflow;
  savedBodyPaddingRight = document.body.style.paddingRight;
  const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
  document.documentElement.classList.add('token-picker-scroll-lock');
  document.body.classList.add('token-picker-scroll-lock');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  if (scrollBarWidth > 0) {
    document.body.style.paddingRight = `${scrollBarWidth}px`;
  }
}

function unlockPageScroll(): void {
  if (!bodyScrollLockActive) return;
  bodyScrollLockActive = false;
  document.documentElement.classList.remove('token-picker-scroll-lock');
  document.body.classList.remove('token-picker-scroll-lock');
  document.documentElement.style.overflow = savedHtmlOverflow;
  document.body.style.overflow = savedBodyOverflow;
  document.body.style.paddingRight = savedBodyPaddingRight;
}

function isInsideTokenPickerShell(target: EventTarget | null): boolean {
  if (!dialogEl || target == null) return false;
  const shell = dialogEl.querySelector('.token-picker-shell');
  return Boolean(shell && target instanceof Node && shell.contains(target));
}

function preventBackgroundScroll(event: Event): void {
  if (!dialogEl?.open) return;
  if (isInsideTokenPickerShell(event.target)) return;
  event.preventDefault();
}

/** Latest wallet balances for this page session (Vybe + RPC only — never persisted to disk). */
let sessionWalletBalances: { wallet: string; fetchedAt: number; items: WalletBalanceListItem[] } | null =
  null;
let walletBalanceStreamAbort: AbortController | null = null;
let walletBalanceStreamListener: (() => void) | null = null;

/** Called after each streamed wallet balance chunk (initial + per-RPC-only update). */
export function setWalletBalanceStreamListener(fn: (() => void) | null): void {
  walletBalanceStreamListener = fn;
}

function notifyWalletBalanceStream(): void {
  walletBalanceStreamListener?.();
}

function mergeWalletBalanceUpdate(token: WalletBalanceListItem): void {
  if (!sessionWalletBalances) return;
  const items = sessionWalletBalances.items.filter((i) => i.mintAddress !== token.mintAddress);
  items.push(token);
  sessionWalletBalances.items = sortWalletBalancesForDisplay(items);
}

function sortWalletBalancesForDisplay(items: WalletBalanceListItem[]): WalletBalanceListItem[] {
  return [...items].sort(
    (a, b) => walletItemValueUsd(b) - walletItemValueUsd(a) || b.amountUi - a.amountUi,
  );
}

async function consumeWalletBalanceStream(
  wallet: string,
  res: Response,
): Promise<WalletBalanceListItem[]> {
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Wallet balances failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let items: WalletBalanceListItem[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = JSON.parse(trimmed) as
        | { event: 'initial'; tokens: WalletBalanceListItem[] }
        | { event: 'update'; token: WalletBalanceListItem }
        | { event: 'done' };
      if (msg.event === 'initial') {
        items = Array.isArray(msg.tokens) ? msg.tokens : [];
        sessionWalletBalances = { wallet, fetchedAt: Date.now(), items };
        notifyWalletBalanceStream();
      } else if (msg.event === 'update') {
        mergeWalletBalanceUpdate(msg.token);
        items = sessionWalletBalances?.items ?? items;
        notifyWalletBalanceStream();
      }
    }
  }

  return sessionWalletBalances?.items ?? items;
}

export function clearSessionWalletBalances(): void {
  walletBalanceStreamAbort?.abort();
  walletBalanceStreamAbort = null;
  sessionWalletBalances = null;
}

async function fetchWalletBalances(wallet: string): Promise<WalletBalanceListItem[]> {
  const w = wallet.trim();
  clearSessionWalletBalances();
  const ac = new AbortController();
  walletBalanceStreamAbort = ac;

  const res = await fetch(
    `/api/wallets/${encodeURIComponent(w)}/token-balances?limit=${WALLET_TOKEN_BALANCE_LIMIT}&stream=1&_=${Date.now()}`,
    { signal: ac.signal, cache: 'no-store' },
  );
  return consumeWalletBalanceStream(w, res);
}

/** @deprecated Renamed to amountExceedsWalletBalance */
export const amountExceedsCachedWalletBalance = amountExceedsWalletBalance;

export function prefetchWalletBalances(wallet: string): Promise<WalletBalanceListItem[]> {
  return fetchWalletBalances(wallet.trim());
}

function readCache(): Record<string, TokenMeta> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, TokenMeta>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, TokenMeta>): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(mints: string[]): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify(mints.slice(0, MAX_RECENT)));
}

function mergeCatalogWithDeviceCache(fromCatalog: TokenMeta, cached: TokenMeta): TokenMeta {
  return {
    ...fromCatalog,
    ...cached,
    symbol: cached.symbol?.trim() || fromCatalog.symbol,
    name: cached.name?.trim() || fromCatalog.name,
    logoUrl: cached.logoUrl?.trim() || fromCatalog.logoUrl,
    tags: cached.tags ?? fromCatalog.tags,
    organicScore: cached.organicScore ?? fromCatalog.organicScore,
    isVerified: cached.isVerified ?? fromCatalog.isVerified,
    source: cached.source ?? fromCatalog.source,
    // Never merge persisted prices — session/API only.
    price: undefined,
    price1d: undefined,
    price7d: undefined,
    priceUpdateTime: undefined,
    priceFetchedAt: undefined,
  };
}

function withoutPersistedPrices(meta: TokenMeta): TokenMeta {
  return {
    ...meta,
    price: undefined,
    price1d: undefined,
    price7d: undefined,
    priceUpdateTime: undefined,
    priceFetchedAt: undefined,
  };
}

const sessionTokenPriceStats = new Map<string, TokenPriceStats>();

export function getSessionTokenPriceStats(mint: string): TokenPriceStats | undefined {
  return sessionTokenPriceStats.get(mint.trim());
}

function setSessionTokenPriceStats(mint: string, stats: TokenPriceStats): void {
  sessionTokenPriceStats.set(mint.trim(), stats);
}

export function getCachedTokenMeta(mint: string): TokenMeta | null {
  const m = mint.trim();
  if (!m) return null;
  const fromCatalog = catalogTokens.find((t) => t.mint === m);
  const cached = readCache()[m];
  if (fromCatalog && cached) return withoutPersistedPrices(mergeCatalogWithDeviceCache(fromCatalog, cached));
  if (fromCatalog) return fromCatalog;
  if (cached) return withoutPersistedPrices(cached);
  if (m === NATIVE_SOL_MINT) {
    const wsolCatalog = catalogTokens.find((t) => t.mint === WSOL_MINT);
    const wsolCached = readCache()[WSOL_MINT];
    const logoUrl = wsolCatalog?.logoUrl ?? wsolCached?.logoUrl ?? '';
    return {
      mint: NATIVE_SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      logoUrl: resolveLogoUrl(logoUrl),
      decimals: 9,
      price: wsolCached?.price ?? wsolCatalog?.price,
      price1d: wsolCached?.price1d ?? wsolCatalog?.price1d,
      price7d: wsolCached?.price7d ?? wsolCatalog?.price7d,
      priceUpdateTime: wsolCached?.priceUpdateTime ?? wsolCatalog?.priceUpdateTime,
      priceFetchedAt: wsolCached?.priceFetchedAt ?? wsolCatalog?.priceFetchedAt,
      isVerified: true,
      source: wsolCached?.source ?? wsolCatalog?.source ?? 'search',
    };
  }
  return null;
}

export function getTokenDecimalsFromCache(mint: string): number | undefined {
  return getCachedTokenMeta(mint)?.decimals;
}

function positiveUsdPrice(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function priceFromCachedMeta(mint: string): number | undefined {
  const session = getSessionTokenPriceStats(mint.trim())?.price;
  return positiveUsdPrice(session);
}

/** SOL/WSOL USD spot from the current session (resolve-prices / Vybe). */
export function getCachedSolPriceUsd(): number | undefined {
  return priceFromCachedMeta(NATIVE_SOL_MINT) ?? priceFromCachedMeta(WSOL_MINT);
}

/** Effective USD holdings value (converts Jupiter SOL quotes using cached SOL price). */
export function walletItemValueUsd(item: WalletBalanceListItem): number {
  if (Number.isFinite(item.valueUsd) && item.valueUsd > 0) return item.valueUsd;
  const valueSol = item.valueSol;
  if (valueSol != null && valueSol > 0) {
    const solPrice = getCachedSolPriceUsd();
    if (solPrice != null && solPrice > 0) return valueSol * solPrice;
  }
  return Number.isFinite(item.valueUsd) ? item.valueUsd : 0;
}

function decimalsFromCachedMeta(mint: string): number | undefined {
  const dec = getCachedTokenMeta(mint.trim())?.decimals;
  return dec != null && Number.isFinite(dec) && dec >= 0 && dec <= 255 ? Math.trunc(dec) : undefined;
}

/** Explicit client swap params for Vybe / ix-builder (prices + decimals from cache). */
export function buildSwapClientParams(inputMint: string, outputMint: string): {
  inputMintPrice?: number;
  outputMintPrice?: number;
  solPrice?: number;
  inputMintDecimals?: number;
  outputMintDecimals?: number;
} {
  const input = inputMint.trim();
  const output = outputMint.trim();
  const payload: {
    inputMintPrice?: number;
    outputMintPrice?: number;
    solPrice?: number;
    inputMintDecimals?: number;
    outputMintDecimals?: number;
  } = {};
  const inputPrice = priceFromCachedMeta(input);
  const outputPrice = priceFromCachedMeta(output);
  const inputDecimals = decimalsFromCachedMeta(input);
  const outputDecimals = decimalsFromCachedMeta(output);
  if (inputPrice != null) payload.inputMintPrice = inputPrice;
  if (outputPrice != null) payload.outputMintPrice = outputPrice;
  if (inputDecimals != null) payload.inputMintDecimals = inputDecimals;
  if (outputDecimals != null) payload.outputMintDecimals = outputDecimals;
  const needsSol = input && output && !isSolMint(input) && !isSolMint(output);
  if (needsSol) {
    const solPrice =
      priceFromCachedMeta(NATIVE_SOL_MINT) ?? priceFromCachedMeta(WSOL_MINT);
    if (solPrice != null) payload.solPrice = solPrice;
  }
  return payload;
}

export function saveTokenPriceStats(mint: string, stats: TokenPriceStats): void {
  const m = mint.trim();
  if (!m) return;
  setSessionTokenPriceStats(m, stats);
  const existing = getCachedTokenMeta(m);
  const meta: TokenMeta = {
    mint: m,
    symbol: existing?.symbol ?? truncateMint(m),
    name: existing?.name ?? truncateMint(m),
    logoUrl: existing?.logoUrl ?? '',
    decimals: stats.decimals ?? existing?.decimals,
    tags: existing?.tags,
    organicScore: existing?.organicScore,
    isVerified: existing?.isVerified,
    source: existing?.source ?? 'search',
    savedAt: Date.now(),
  };
  saveTokenMeta(meta);
  if (isSolMint(m)) refreshWalletBalancesPanel();
}

/** Prefer locally served icon paths; leave remote URLs for server localization. */
export function resolveLogoUrl(logoUrl: string | undefined): string {
  const u = (logoUrl ?? '').trim();
  if (!u) return '';
  if (u.startsWith('/')) return u;
  return u;
}

/** Replace with your own asset at this path (SVG or PNG — update extension here if needed). */
export const TOKEN_ICON_PLACEHOLDER_PATH = '/images/token-icon-placeholder.svg';

const failedTokenIconUrls = new Set<string>();
let tokenIconErrorHandlingWired = false;

/** Session-only in-memory icon blobs — avoids refetch when picker DOM is rebuilt. */
const sessionTokenIconBlobUrls = new Map<string, string>();
const sessionTokenIconWarmPromises = new Map<string, Promise<string>>();

const TOKEN_ICON_IMG_SELECTOR =
  '.token-picker-row-logo-img, .token-picker-shortcut img, .swap-token-chip-icon img, .routing-token-img, .swap-pair-icon-img';

function tokenIconSessionKey(src: string): string {
  const s = src.trim();
  if (!s || s.startsWith('blob:')) return s;
  try {
    return new URL(s, window.location.origin).href;
  } catch {
    return s;
  }
}

function displayTokenIconSrc(canonicalSrc: string): string {
  if (canonicalSrc === TOKEN_ICON_PLACEHOLDER_PATH) return canonicalSrc;
  return sessionTokenIconBlobUrls.get(tokenIconSessionKey(canonicalSrc)) ?? canonicalSrc;
}

function warmSessionTokenIconViaImage(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = img.naturalWidth || 64;
        const h = img.naturalHeight || 64;
        if (!w || !h) {
          resolve(null);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) {
            resolve(null);
            return;
          }
          const blobUrl = URL.createObjectURL(blob);
          sessionTokenIconBlobUrls.set(tokenIconSessionKey(src), blobUrl);
          resolve(blobUrl);
        }, 'image/png');
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      markTokenIconUrlFailed(src);
      resolve(null);
    };
    img.src = src;
  });
}

async function warmSessionTokenIcon(originSrc: string): Promise<string> {
  const key = tokenIconSessionKey(originSrc);
  if (!key || key === TOKEN_ICON_PLACEHOLDER_PATH) return TOKEN_ICON_PLACEHOLDER_PATH;
  if (isTokenIconUrlFailed(key)) return TOKEN_ICON_PLACEHOLDER_PATH;
  const cached = sessionTokenIconBlobUrls.get(key);
  if (cached) return cached;

  const inflight = sessionTokenIconWarmPromises.get(key);
  if (inflight) return inflight;

  const work = (async (): Promise<string> => {
    try {
      const res = await fetch(key);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 0) {
          const blobUrl = URL.createObjectURL(blob);
          sessionTokenIconBlobUrls.set(key, blobUrl);
          return blobUrl;
        }
      }
    } catch {
      markTokenIconUrlFailed(key);
      return TOKEN_ICON_PLACEHOLDER_PATH;
    }

    const viaImage = await warmSessionTokenIconViaImage(key);
    return viaImage ?? originSrc;
  })();

  sessionTokenIconWarmPromises.set(key, work);
  try {
    return await work;
  } finally {
    sessionTokenIconWarmPromises.delete(key);
  }
}

function hydrateTokenIconImgs(root: ParentNode | null | undefined): void {
  if (!root) return;
  root.querySelectorAll<HTMLImageElement>('img[data-token-icon-origin]').forEach((img) => {
    bindTokenIconImg(img);
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const blobUrl of sessionTokenIconBlobUrls.values()) {
      URL.revokeObjectURL(blobUrl);
    }
    sessionTokenIconBlobUrls.clear();
  });
}

export function markTokenIconUrlFailed(url: string): void {
  const u = tokenIconSessionKey(url);
  if (u && u !== TOKEN_ICON_PLACEHOLDER_PATH && !u.endsWith(TOKEN_ICON_PLACEHOLDER_PATH)) {
    failedTokenIconUrls.add(u);
  }
}

function isTokenIconUrlFailed(url: string): boolean {
  return failedTokenIconUrls.has(tokenIconSessionKey(url));
}

/** Icon src for display; uses placeholder when URL is missing or already failed this session. */
export function effectiveTokenIconSrc(logoUrl: string | undefined): string {
  const src = resolveLogoUrl(logoUrl);
  if (!src || isTokenIconUrlFailed(src)) return TOKEN_ICON_PLACEHOLDER_PATH;
  return src;
}

export function renderTokenIconImgHtml(src: string, className: string): string {
  const displaySrc = displayTokenIconSrc(src);
  const placeholderClass = displaySrc === TOKEN_ICON_PLACEHOLDER_PATH ? ' token-icon-img--placeholder' : '';
  const originAttr =
    src !== TOKEN_ICON_PLACEHOLDER_PATH && !src.startsWith('blob:')
      ? ` data-token-icon-origin="${escapeHtml(tokenIconSessionKey(src))}"`
      : '';
  return `<img class="${className}${placeholderClass}" src="${escapeHtml(displaySrc)}"${originAttr} alt="" loading="lazy" decoding="async" />`;
}

export function handleTokenIconImgError(img: HTMLImageElement): void {
  const origin = img.dataset.tokenIconOrigin?.trim() || img.currentSrc || img.src;
  markTokenIconUrlFailed(origin);
  img.onerror = null;
  img.src = TOKEN_ICON_PLACEHOLDER_PATH;
  img.classList.add('token-icon-img--placeholder');
  img.removeAttribute('data-token-icon-origin');
}

export function bindTokenIconImg(img: HTMLImageElement): void {
  if (img.dataset.tokenIconBound === '1') return;
  img.dataset.tokenIconBound = '1';
  img.addEventListener('error', () => handleTokenIconImgError(img), { once: true });

  const origin = img.dataset.tokenIconOrigin?.trim();
  if (!origin || origin === TOKEN_ICON_PLACEHOLDER_PATH) return;
  const key = tokenIconSessionKey(origin);
  if (isTokenIconUrlFailed(origin)) {
    img.src = TOKEN_ICON_PLACEHOLDER_PATH;
    img.classList.add('token-icon-img--placeholder');
    return;
  }

  const applyCached = (): void => {
    const blob = sessionTokenIconBlobUrls.get(key);
    if (blob && img.src !== blob) img.src = blob;
  };

  applyCached();
  if (sessionTokenIconBlobUrls.has(key)) return;

  const cacheFromLoaded = (): void => {
    if (sessionTokenIconBlobUrls.has(key)) {
      applyCached();
      return;
    }
    if (!img.complete || img.naturalWidth <= 0) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob || sessionTokenIconBlobUrls.has(key)) return;
        const blobUrl = URL.createObjectURL(blob);
        sessionTokenIconBlobUrls.set(key, blobUrl);
        if (img.isConnected) img.src = blobUrl;
      }, 'image/png');
    } catch {
      if (isTokenIconUrlFailed(origin)) return;
      void warmSessionTokenIcon(origin).then((resolved) => {
        if (resolved.startsWith('blob:') && img.isConnected) img.src = resolved;
      });
    }
  };

  if (img.complete) cacheFromLoaded();
  else img.addEventListener('load', cacheFromLoaded, { once: true });
}

/** Capture-phase listener: img error events do not bubble. */
export function ensureTokenIconErrorHandling(): void {
  if (tokenIconErrorHandlingWired) return;
  tokenIconErrorHandlingWired = true;
  document.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLImageElement)) return;
      if (!t.matches(TOKEN_ICON_IMG_SELECTOR)) return;
      handleTokenIconImgError(t);
    },
    true,
  );
}

function needsRemoteLogoResolve(meta: TokenMeta | null | undefined): boolean {
  if (!meta) return true;
  // Already fetched from /api/token — do not re-hit on every label/icon refresh.
  if (meta.source === 'search') return false;
  const sym = meta.symbol?.trim();
  if (!sym || sym === truncateMint(meta.mint)) return true;
  if (meta.decimals == null) return true;
  const u = meta.logoUrl.trim();
  if (!u) return true;
  if (u.startsWith('/')) return false;
  // Catalog / wallet rows may keep remote icon URLs; browser loads them directly.
  return false;
}

function saveTokenMeta(meta: TokenMeta): void {
  const cache = readCache();
  cache[meta.mint] = meta;
  writeCache(cache);
  const recent = readRecent().filter((m) => m !== meta.mint);
  recent.unshift(meta.mint);
  writeRecent(recent);
}

function parseCatalogTsv(text: string): TokenMeta[] {
  const now = Date.now();
  const out: TokenMeta[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.toLowerCase().startsWith('mint\t')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 4) continue;
    const [mint, symbol, name, logoUrl, decimalsRaw, tagsRaw] = parts;
    const m = (mint ?? '').trim();
    if (!m) continue;
    const dec = decimalsRaw?.trim() ? Number(decimalsRaw) : undefined;
    const tags =
      tagsRaw?.trim()
        ? tagsRaw
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
    out.push({
      mint: m,
      symbol: (symbol ?? '').trim() || truncateMint(m),
      name: (name ?? '').trim() || (symbol ?? '').trim() || m,
      logoUrl: resolveLogoUrl(logoUrl ?? ''),
      decimals: Number.isFinite(dec) ? dec : undefined,
      tags,
      source: 'catalog',
      savedAt: now,
    });
  }
  return out;
}

function catalogEntryFromJson(raw: Record<string, unknown>): TokenMeta | null {
  const mint = String(raw.mint ?? raw.id ?? '').trim();
  if (!mint) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t))
    : typeof raw.tags === 'string' && raw.tags
      ? [raw.tags]
      : undefined;
  const organicScore = typeof raw.organicScore === 'number' ? raw.organicScore : undefined;
  return {
    mint,
    symbol: String(raw.symbol ?? '').trim() || truncateMint(mint),
    name: String(raw.name ?? '').trim() || String(raw.symbol ?? mint),
    logoUrl: resolveLogoUrl(String(raw.logoUrl ?? raw.icon ?? '')),
    decimals: typeof raw.decimals === 'number' ? raw.decimals : undefined,
    tags,
    organicScore,
    isVerified: raw.isVerified === true,
    source: 'catalog',
    savedAt: Date.now(),
  };
}

async function loadCatalog(): Promise<void> {
  if (catalogLoaded) return;
  try {
    const jsonRes = await fetch(CATALOG_JSON_URL);
    if (jsonRes.ok) {
      const body = (await jsonRes.json()) as { tokens?: unknown[] };
      if (Array.isArray(body.tokens)) {
        catalogTokens = body.tokens
          .map((t) => catalogEntryFromJson(t as Record<string, unknown>))
          .filter((t): t is TokenMeta => Boolean(t));
        catalogLoaded = true;
        return;
      }
    }
  } catch {
    /* fall through to TSV */
  }
  try {
    const res = await fetch(CATALOG_TSV_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalogTokens = parseCatalogTsv(await res.text());
  } catch {
    catalogTokens = [];
  }
  catalogLoaded = true;
}

function truncateMint(mint: string): string {
  if (mint.length <= 13) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tokenMatchesQuery(token: TokenMeta, query: string, exact: boolean): boolean {
  const q = query.toLowerCase();
  const sym = token.symbol.toLowerCase();
  const name = token.name.toLowerCase();
  const mint = token.mint.toLowerCase();
  if (exact) return sym === q || name === q || mint === q;
  return sym.includes(q) || name.includes(q) || mint.includes(q);
}

function getVisibleTokens(): TokenMeta[] {
  const cache = readCache();
  const recentMints = readRecent();
  let base: TokenMeta[] =
    activeTab === 'top'
      ? catalogTokens
      : recentMints
          .map((mint) => cache[mint] ?? catalogTokens.find((t) => t.mint === mint))
          .filter((t): t is TokenMeta => Boolean(t));

  const rawQ = searchQuery.trim();
  if (!rawQ) {
    if (activeSide === 'input' && activeTab === 'recent') {
      return sortTokensForSellPicker(base);
    }
    return base;
  }

  const exact = rawQ.startsWith('"') && rawQ.endsWith('"') && rawQ.length > 2;
  const q = exact ? rawQ.slice(1, -1).trim() : rawQ;

  if (BASE58_RE.test(q)) {
    const hit = catalogTokens.find((t) => t.mint === q) ?? cache[q];
    if (hit) return [hit];
    if (pendingMintLookup === q) return [];
    return [];
  }

  const filtered = base.filter((t) => tokenMatchesQuery(t, q, exact));
  const cacheHits = Object.values(cache).filter(
    (t) => t.source === 'search' && tokenMatchesQuery(t, q, exact) && !filtered.some((f) => f.mint === t.mint),
  );
  const merged = [...filtered, ...cacheHits];
  if (activeSide === 'input' && activeTab === 'recent') {
    return sortTokensForSellPicker(merged);
  }
  return merged;
}

async function fetchTokenByMint(mint: string): Promise<TokenMeta | null> {
  try {
    const res = await fetch(`/api/token/${encodeURIComponent(mint)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (body.error) return null;
    const symbol = String(body.symbol ?? '').trim();
    const name = String(body.name ?? '').trim();
    const logoUrl = resolveLogoUrl(String(body.logoUrl ?? ''));
    const decimals = typeof body.decimals === 'number' ? body.decimals : undefined;
    const price = typeof body.price === 'number' ? body.price : undefined;
    const price1d = typeof body.price1d === 'number' ? body.price1d : undefined;
    const price7d = typeof body.price7d === 'number' ? body.price7d : undefined;
    const priceUpdateTime = typeof body.priceUpdateTime === 'number' ? body.priceUpdateTime : undefined;
    const priceFetchedAt = typeof body.priceFetchedAt === 'number' ? body.priceFetchedAt : undefined;
    const tokenProgram = String(body.tokenProgram ?? body.program ?? '').trim();
    const tags: string[] = [];
    if (/2022/i.test(tokenProgram) || body.isToken2022 === true) tags.push('Token2022');
    if (
      typeof price === 'number' &&
      Number.isFinite(price) &&
      price > 0 &&
      typeof decimals === 'number' &&
      Number.isFinite(decimals)
    ) {
      setSessionTokenPriceStats(mint, {
        price,
        price1d,
        price7d,
        decimals,
        priceFetchedAt: priceFetchedAt ?? Date.now(),
        priceUpdateTime,
      });
    }
    const meta: TokenMeta = {
      mint,
      symbol: symbol || truncateMint(mint),
      name: name || symbol || truncateMint(mint),
      logoUrl,
      decimals,
      tags: tags.length ? tags : undefined,
      isVerified: body.isVerified === true,
      organicScore: typeof body.organicScore === 'number' ? body.organicScore : undefined,
      source: 'search',
      savedAt: Date.now(),
    };
    saveTokenMeta(meta);
    return meta;
  } catch {
    return null;
  }
}

function renderTokenIcon(token: TokenMeta): string {
  return renderTokenIconImgHtml(effectiveTokenIconSrc(token.logoUrl), 'token-picker-row-logo-img');
}

function formatBalanceAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  if (amount >= 1000) return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (amount >= 1) return amount.toFixed(4).replace(/\.?0+$/, '');
  return amount.toFixed(6).replace(/\.?0+$/, '') || '0';
}

/** ≥ $0.01 → two decimals; sub-cent → &lt; $0.01 (below tradable minimum). */
function formatWalletBalanceUsd(valueUsd: number): string {
  if (!Number.isFinite(valueUsd) || valueUsd <= 0) return '< $0.01';
  const abs = Math.abs(valueUsd);

  if (abs >= SPL_MIN_TRADABLE_VALUE_USD) {
    return `~$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  return '< $0.01';
}

function walletItemToTokenMeta(item: WalletBalanceListItem): TokenMeta {
  const catalogHit = catalogTokens.find((t) => t.mint === item.mintAddress);
  const cached = readCache()[item.mintAddress];
  const base = catalogHit ?? cached;
  const symbol =
    item.mintAddress === NATIVE_SOL_MINT
      ? 'SOL'
      : item.mintAddress === WSOL_MINT
        ? 'WSOL'
        : item.symbol || base?.symbol || truncateMint(item.mintAddress);
  const name =
    item.mintAddress === NATIVE_SOL_MINT
      ? 'Solana'
      : item.mintAddress === WSOL_MINT
        ? 'Wrapped SOL'
        : item.name || base?.name || symbol;
  return {
    mint: item.mintAddress,
    symbol,
    name,
    logoUrl: resolveLogoUrl(item.logoUrl ?? base?.logoUrl ?? ''),
    decimals: item.decimals ?? base?.decimals,
    isVerified: item.verified || base?.isVerified,
    tags: base?.tags,
    organicScore: base?.organicScore,
    source: base?.source ?? 'search',
    savedAt: Date.now(),
  };
}

function renderWalletBalanceRow(item: WalletBalanceListItem): string {
  const token = walletItemToTokenMeta(item);
  const isSellPicker = activeSide === 'input';
  const blocked = isSellPicker && isBlockedPickerMint(item.mintAddress);
  const tradable = isSellPicker ? isWalletTokenTradable(item.mintAddress) : true;
  const amountLabel = `${formatBalanceAmount(item.amountUi)} ${token.symbol}`;
  const fiatLabel = formatWalletBalanceUsd(walletItemValueUsd(item));
  const statusTag = blocked
    ? '<span class="token-picker-row-tag token-picker-row-tag--muted">Use SOL</span>'
    : isSellPicker && !tradable
      ? '<span class="token-picker-row-tag token-picker-row-tag--muted">Too small</span>'
      : '';
  const disabledAttr = isSellPicker && (!tradable || blocked) ? ' disabled aria-disabled="true"' : '';
  const pendingClass = item.enrichmentPending ? ' token-picker-row--pending' : '';
  const untradableClass =
    isSellPicker && (!tradable || blocked) ? ' token-picker-row--untradable' : '';
  return `<button type="button" class="token-picker-row token-picker-row--wallet${untradableClass}${pendingClass}" data-mint="${escapeHtml(item.mintAddress)}"${disabledAttr}>
    <span class="token-picker-row-logo">${renderTokenIcon(token)}</span>
    <span class="token-picker-row-main">
      <span class="token-picker-row-title">
        <span class="token-picker-row-symbol">${escapeHtml(token.symbol)}</span>
        ${statusTag}
      </span>
      <span class="token-picker-row-sub">${escapeHtml(token.name)}</span>
    </span>
    <span class="token-picker-row-amount-wrap">
      <span class="token-picker-row-amount">${escapeHtml(amountLabel)}</span>
      <span class="token-picker-row-fiat">${escapeHtml(fiatLabel)}</span>
    </span>
  </button>`;
}

function syncWalletBalancesVisibility(): void {
  if (!walletBalancesEl) return;
  walletBalancesEl.hidden = activeTab !== 'wallet';
}

function syncTopTabDisabledState(): void {
  const isSell = activeSide === 'input';
  document.querySelectorAll('.token-picker-tab[data-tab="top"]').forEach((el) => {
    const btn = el as HTMLButtonElement;
    btn.disabled = isSell;
    btn.classList.toggle('token-picker-tab--disabled', isSell);
    btn.setAttribute('aria-disabled', isSell ? 'true' : 'false');
  });
}

function syncPickerLayout(): void {
  const isSell = activeSide === 'input';
  if (dialogEl) {
    dialogEl.classList.toggle('token-picker-dialog--sell', isSell);
    dialogEl.classList.toggle('token-picker-dialog--buy', !isSell);
    dialogEl.classList.toggle('token-picker-dialog--wallet-tab', activeTab === 'wallet');
    dialogEl.classList.toggle('token-picker-dialog--list-tab', activeTab === 'top' || activeTab === 'recent');
  }
  if (searchWrapEl) searchWrapEl.hidden = false;
  if (tabsEl) tabsEl.hidden = false;
  if (shortcutsEl) shortcutsEl.hidden = false;
  if (listWrapEl) listWrapEl.hidden = activeTab === 'wallet';
  syncTopTabDisabledState();
  syncWalletBalancesVisibility();
  syncTabs();
  syncRefetchHoldingsBtn();
}

/** Vybe reports native SOL under System Program id, not WSOL mint. */
export const NATIVE_SOL_MINT = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Leave this much SOL in wallet when selling (rent + fees). */
export const SOL_WALLET_MIN_RESERVE_UI = 0.006;
/** Max-sell / 100% button leaves this much SOL; manual amounts may use full balance. */
/** Total SOL below this is skipped for auto-pick (prefer USDC/USDT instead). */
export const SOL_MIN_AUTO_PICK_TOTAL_UI = 0.0065;
/** Total SOL below this is not tradable (max sell would be ≤ 0.0001 SOL). */
export const SOL_MIN_TRADABLE_TOTAL_UI = 0.0061;
/** Non-SOL wallet balance below this USD value is not tradable (dust). */
export const SPL_MIN_TRADABLE_VALUE_USD = 0.01;
/** Each retry step lowers sell amount by this many percent of wallet balance. */
export const SPL_SELL_SIM_RETRY_STEP_PCT = 2;
/** Max sell-amount attempts per router before switching (100%, 98%, 96%). */
export const SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER = 3;
/** @deprecated Use SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER. */
export const SPL_SELL_SIM_MAX_STEPS = SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER;
export const SPL_SELL_SIM_MIN_BALANCE_FRACTION = 0.5;
/** @deprecated Use computeSplSellAmountForRetryStep(balance, 1). */
export const SPL_SELL_SIM_RETRY_FRACTION = 1 - SPL_SELL_SIM_RETRY_STEP_PCT / 100;

const splMaxSellFractionByMint = new Map<string, number>();

export function getSplMaxSellFraction(mint: string): number | null {
  const key = mint.trim();
  return splMaxSellFractionByMint.has(key) ? splMaxSellFractionByMint.get(key)! : null;
}

/** Remember a conservative max sell fraction after sim failure retries only (not routine quote normalization). */
export function noteSplMaxSellFraction(mint: string, amountUi: number, balanceUi: number): void {
  const key = mint.trim();
  if (isSolMint(key)) return;
  if (!key || !Number.isFinite(amountUi) || !Number.isFinite(balanceUi) || balanceUi <= 0) return;
  const fraction = amountUi / balanceUi;
  if (fraction <= 0 || fraction > 1) return;
  const prev = splMaxSellFractionByMint.get(key);
  if (prev == null || fraction < prev) {
    splMaxSellFractionByMint.set(key, fraction);
  }
}

export function isNearMaxSellAmountUi(amountUi: number, balanceUi: number): boolean {
  if (!Number.isFinite(amountUi) || !Number.isFinite(balanceUi) || balanceUi <= 0) return false;
  if (amountUi >= balanceUi * 0.995) return true;
  return amountUi >= balanceUi * 0.9;
}

/** Strict max-sell match for 100% button highlight and Vybe exact-balance sells (not the 90% sim-retry heuristic). */
export function isAtMaxSellAmountUi(amountUi: number, maxUi: number, mint?: string): boolean {
  if (!Number.isFinite(amountUi) || !Number.isFinite(maxUi) || maxUi <= 0) return false;
  if (amountUi > maxUi * 1.000001) return false;
  if (mint) {
    const decimals = getTokenDecimalsFromCache(mint) ?? 9;
    const eps = Math.pow(10, -Math.min(Math.max(decimals, 0), 12)) * 1.5;
    return Math.abs(amountUi - maxUi) <= eps;
  }
  return amountUi >= maxUi * 0.9995;
}

function quotedBuildOutAmountRaw(buildPayload?: Record<string, unknown> | null): string | null {
  if (!buildPayload) return null;
  const details = buildPayload.details as Record<string, unknown> | undefined;
  const quote = details?.quote as Record<string, unknown> | undefined;
  const candidates = [quote?.outAmount, buildPayload.outAmount];
  for (const raw of candidates) {
    const digits = String(raw ?? '').trim();
    if (/^\d+$/.test(digits) && digits !== '0') return digits;
  }
  return null;
}

function isQuoteBridgeBuildPayload(buildPayload?: Record<string, unknown> | null): boolean {
  if (!buildPayload) return false;
  const details = buildPayload.details as { preSwapNeeded?: boolean } | undefined;
  return details?.preSwapNeeded === true || buildPayload.preSwapNeeded === true;
}

/** Prefer nested `_build` when the vybe-quote API body is passed whole. */
function resolveSwapSimBuildPayload(
  buildPayload?: Record<string, unknown> | null,
): Record<string, unknown> | null | undefined {
  if (!buildPayload) return buildPayload;
  const nested = buildPayload._build;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return buildPayload;
}

export function swapSimulationFailed(
  simulatedOutRaw: string | null | undefined,
  buildTx: unknown,
  buildPayload?: Record<string, unknown> | null,
): boolean {
  const build = resolveSwapSimBuildPayload(buildPayload);
  const quoteShell = build !== buildPayload ? buildPayload : null;

  /* Quote-bridge: main leg is not simulated without intermediate mint — quoted out is enough. */
  if (isQuoteBridgeBuildPayload(build) && quotedBuildOutAmountRaw(build)) {
    return false;
  }

  const simulationErr =
    build?._simulationErr ??
    build?.simulationErr ??
    (quoteShell && !quoteShell._build ? quoteShell._simulationErr : null) ??
    (quoteShell && !quoteShell._build ? quoteShell.simulationErr : null);
  if (simulationErr != null) return true;
  if (!buildTx || typeof buildTx !== 'string' || buildTx.length === 0) return false;
  if (simulatedOutRaw != null && simulatedOutRaw !== '') return false;
  if (quotedBuildOutAmountRaw(build)) return false;
  const topOut = String(quoteShell?.outAmount ?? buildPayload?.outAmount ?? '').trim();
  if (/^\d+$/.test(topOut) && topOut !== '0') return false;
  return true;
}

/** Do not overwrite the sell input when quote inAmount is only fee/normalization noise at max sell. */
export function shouldApplySellAmountFromQuoteInAmount(
  requestedUi: number,
  quotedInUi: number,
  mint: string,
  options?: WalletSellableOptions,
): boolean {
  if (!Number.isFinite(requestedUi) || requestedUi <= 0) return false;
  if (!Number.isFinite(quotedInUi) || quotedInUi <= 0) return false;
  const relDiff = Math.abs(requestedUi - quotedInUi) / requestedUi;
  if (relDiff < 0.001) return false;

  const sellable = getWalletSellableAmountUi(mint, options);
  if (sellable != null && sellable > 0) {
    const atSellableCeiling =
      isAtMaxSellAmountUi(requestedUi, sellable, mint) ||
      (requestedUi <= sellable * 1.001 && quotedInUi <= sellable * 1.001);
    if (atSellableCeiling && quotedInUi <= sellable * 1.001) return false;
  }

  return quotedInUi < requestedUi * 0.999;
}

/** step 1 → 98% of balance, step 2 → 96%, etc. */
export function computeSplSellAmountForRetryStep(balanceUi: number, step: number): number {
  if (!Number.isFinite(balanceUi) || balanceUi <= 0 || step <= 0) return 0;
  const fraction = Math.max(
    SPL_SELL_SIM_MIN_BALANCE_FRACTION,
    1 - (SPL_SELL_SIM_RETRY_STEP_PCT / 100) * step,
  );
  return balanceUi * fraction;
}

export function shouldContinueSplSellSimRetry(
  inputMint: string,
  amountUi: number,
  balanceUi: number,
  step: number,
): boolean {
  if (isSolMint(inputMint)) return false;
  if (step >= SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER - 1) return false;
  if (!Number.isFinite(balanceUi) || balanceUi <= 0) return false;
  if (amountUi < balanceUi * SPL_SELL_SIM_MIN_BALANCE_FRACTION) return false;
  return true;
}

/** Compute a lower sell amount when max balance simulation fails (input-side fee reserve). */
export function computeSplSellRetryAmountUi(
  balanceUi: number,
  swapFeePct: number | null,
  learnedFraction?: number | null,
): number {
  if (!Number.isFinite(balanceUi) || balanceUi <= 0) return 0;
  let amount = computeSplSellAmountForRetryStep(balanceUi, 1);
  if (swapFeePct != null && swapFeePct > 0) {
    const feeAdjusted = balanceUi / (1 + swapFeePct / 100) * 0.99;
    amount = Math.min(amount, feeAdjusted);
  }
  if (learnedFraction != null && learnedFraction > 0 && learnedFraction < 1) {
    amount = Math.min(amount, balanceUi * learnedFraction);
  }
  return amount;
}

export function isSolMint(mint: string): boolean {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

export function isNativeSolMint(mint: string): boolean {
  return mint.trim() === NATIVE_SOL_MINT;
}

export function isWsolMint(mint: string): boolean {
  return mint.trim() === WSOL_MINT;
}

/** WSOL is shown in balances but not selectable — users trade native SOL instead. */
export function isBlockedPickerMint(mint: string): boolean {
  return isWsolMint(mint);
}

export type TokenMintColorKind = 'sol' | 'stable' | 'alt';

const KNOWN_STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

const KNOWN_STABLE_SYMBOLS = new Set([
  'USDC',
  'USDT',
  'USDT1',
  'PYUSD',
  'USDH',
  'UXD',
  'USDY',
  'USDS',
  'USD1',
  'CASH',
  'EURC',
  'DAI',
  'USDG',
]);

/** Purple = SOL, green = stables, yellow = everything else. */
export function getTokenMintColorKind(mint: string, symbolHint?: string): TokenMintColorKind {
  const symHint = (symbolHint ?? '').toUpperCase();
  if (symHint === 'SOL' || symHint === 'WSOL') return 'sol';
  if (symHint && KNOWN_STABLE_SYMBOLS.has(symHint)) return 'stable';

  const m = preferNativeSolMint(mint.trim());
  if (!m) return 'alt';
  if (isSolMint(m)) return 'sol';
  if (KNOWN_STABLECOIN_MINTS.has(m)) return 'stable';
  const meta = getCachedTokenMeta(m);
  if (meta?.tags?.some((t) => t.toLowerCase() === 'stable')) return 'stable';
  const sym = (meta?.symbol ?? '').toUpperCase();
  if (sym && KNOWN_STABLE_SYMBOLS.has(sym)) return 'stable';
  return 'alt';
}

export function tokenBoxColorClass(mint: string, symbolHint?: string): string {
  return `swap-token-color--${getTokenMintColorKind(mint, symbolHint)}`;
}

export function tokenSymColorClass(mint: string, symbolHint?: string): string {
  return `swap-token-sym-color--${getTokenMintColorKind(mint, symbolHint)}`;
}

export function routingTokenDotClass(mint: string, symbolHint?: string): string {
  return `routing-token-dot routing-token-dot--${getTokenMintColorKind(mint, symbolHint)}`;
}

export function preferNativeSolMint(mint: string): string {
  const m = mint.trim();
  return m === WSOL_MINT ? NATIVE_SOL_MINT : m;
}

/** @deprecated Use preferNativeSolMint — UI keeps native SOL; Vybe uses WSOL server-side. */
export function normalizeSwapSolMint(mint: string): string {
  return preferNativeSolMint(mint);
}

export function isSplValueTradable(valueUsd: number): boolean {
  return Number.isFinite(valueUsd) && valueUsd >= SPL_MIN_TRADABLE_VALUE_USD;
}

/** Wallet balance row for a mint — native SOL and WSOL are separate entries. */
export function getWalletBalanceListItem(mint: string): WalletBalanceListItem | null {
  const m = mint.trim();
  if (!m || !sessionWalletBalances) return null;
  if (m === NATIVE_SOL_MINT) {
    return sessionWalletBalances.items.find((i) => i.mintAddress === NATIVE_SOL_MINT) ?? null;
  }
  if (m === WSOL_MINT) {
    return sessionWalletBalances.items.find((i) => i.mintAddress === WSOL_MINT) ?? null;
  }
  return sessionWalletBalances.items.find((i) => i.mintAddress === m) ?? null;
}

export function getWalletBalanceAmountUi(mint: string): number | null {
  const item = getWalletBalanceListItem(mint);
  return item && item.amountUi > 0 ? item.amountUi : null;
}

/** Format a wallet balance for the sell input without rounding above on-chain amount. */
export function maxSwapInputStringForWalletItem(item: WalletBalanceListItem): string {
  const exact = item.amountExact?.trim().replace(/,/g, '');
  if (exact && /^\d+$/.test(exact)) {
    const decimals = Number.isFinite(item.decimals) ? item.decimals : 0;
    const raw = BigInt(exact);
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = raw % base;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  }
  return formatSwapInputAmountValueFloor(item.amountUi, item.decimals);
}

export function swapInputUiToRawBigInt(ui: string, decimals: number): bigint {
  const cleaned = ui.trim().replace(/,/g, '');
  if (!cleaned) return 0n;
  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole, frac = ''] = unsigned.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  const digits = `${whole || '0'}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return BigInt(`${negative ? '-' : ''}${digits || '0'}`);
}

/** Format sell input without rounding above wallet balance — preserves all mint decimals. */
export function formatSwapInputAmountValueFloor(amount: number, decimals = 9): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  const d = Math.max(0, Math.min(decimals, 12));
  const fixed = amount.toFixed(d);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed || '0';
}

export function balanceExactRawToUiString(exactRaw: string, decimals: number): string {
  const raw = exactRaw.trim().replace(/,/g, '');
  if (!/^\d+$/.test(raw)) return '0';
  const d = Math.max(0, decimals);
  const base = 10n ** BigInt(d);
  const r = BigInt(raw);
  const whole = r / base;
  const frac = r % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(d, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/** True when selling the full on-chain SPL balance (Vybe max / 100% / exact raw match). */
export function isVybeFullSplSellAmount(
  amountUi: number,
  item: WalletBalanceListItem,
  maxSellSelected = false,
): boolean {
  if (isSolMint(item.mintAddress)) return false;
  const exact = item.amountExact?.trim().replace(/,/g, '');
  if (!exact || !/^\d+$/.test(exact)) return false;
  if (maxSellSelected) return true;
  const decimals = Number.isFinite(item.decimals) ? item.decimals : 0;
  const amountRaw = swapInputUiToRawBigInt(String(amountUi), decimals);
  const exactRaw = BigInt(exact);
  if (exactRaw > 0n && amountRaw >= exactRaw) return true;
  const maxUi = Number(balanceExactRawToUiString(exact, decimals));
  if (Number.isFinite(maxUi) && maxUi > 0 && amountUi >= maxUi * 0.999) return true;
  return false;
}

export function amountExceedsWalletBalance(amountUi: number, mint: string): boolean {
  const item = getWalletBalanceListItem(mint);
  if (!item || !(item.amountUi > 0)) return false;
  if (!Number.isFinite(amountUi) || amountUi <= 0) return false;
  const decimals = Number.isFinite(item.decimals) ? item.decimals : 9;
  const inputStr = formatSwapInputAmountValueFloor(amountUi, decimals);
  const requiredRaw = swapInputUiToRawBigInt(inputStr, decimals);
  const availableRaw = item.amountExact?.trim()
    ? BigInt(item.amountExact.trim().replace(/,/g, ''))
    : swapInputUiToRawBigInt(maxSwapInputStringForWalletItem(item), decimals);
  return requiredRaw > availableRaw;
}

function walletHasMintInSession(mint: string): boolean {
  if (!sessionWalletBalances) return false;
  const m = mint.trim();
  return sessionWalletBalances.items.some((i) => i.mintAddress === m);
}

/** Ephemeral WSOL path when no WSOL row or WSOL balance is zero (from latest wallet fetch). */
function resolveCloseWsolAtaFromSession(): boolean {
  if (!sessionWalletBalances) return true;
  const row = sessionWalletBalances.items.find((i) => i.mintAddress === WSOL_MINT);
  if (!row) return true;
  const exact = row.amountExact?.trim().replace(/,/g, '');
  if (exact && /^\d+$/.test(exact)) return BigInt(exact) === 0n;
  return !(Number.isFinite(row.amountUi) && row.amountUi > 0);
}

/**
 * Build Vybe ATA action flags from the latest session wallet balance fetch (no extra API call).
 */
export function buildSwapAtaHintsFromSessionBalances(params: {
  inputMint: string;
  outputMint: string;
  amountUi: number;
  router?: string;
  maxSellSelected?: boolean;
}): {
  closeInputAta?: boolean;
  createOutputAta?: boolean;
  closeWsolAta?: boolean;
  amountUi: number;
  inputBalanceExact?: string;
  inputDecimals?: number;
} | null {
  if (!sessionWalletBalances) return null;
  const router = params.router?.trim().toLowerCase() ?? '';
  if (router !== 'vybe') return null;

  const inputMint = params.inputMint.trim();
  const outputMint = params.outputMint.trim();
  const closeWsolAta = resolveCloseWsolAtaFromSession();

  let amountUi = params.amountUi;
  let closeInputAta: boolean | undefined;
  let inputBalanceExact: string | undefined;
  let inputDecimals: number | undefined;

  if (!isSolMint(inputMint)) {
    const inputRow = sessionWalletBalances.items.find((i) => i.mintAddress === inputMint);
    if (inputRow) {
      inputBalanceExact = inputRow.amountExact?.trim().replace(/,/g, '') || undefined;
      inputDecimals = inputRow.decimals;
      const isFullSell = isVybeFullSplSellAmount(
        params.amountUi,
        inputRow,
        params.maxSellSelected === true,
      );
      if (isFullSell && inputBalanceExact) {
        closeInputAta = true;
        amountUi = Number(maxSwapInputStringForWalletItem(inputRow));
      }
    }
  }

  let createOutputAta: boolean | undefined;
  if (!isSolMint(outputMint) && outputMint !== WSOL_MINT) {
    createOutputAta = !walletHasMintInSession(outputMint);
  }

  return {
    closeWsolAta,
    createOutputAta,
    amountUi,
    closeInputAta,
    inputBalanceExact,
    inputDecimals,
  };
}

/** @deprecated Renamed to buildSwapAtaHintsFromSessionBalances */
export const buildSwapAtaHintsFromWalletCache = buildSwapAtaHintsFromSessionBalances;

/** True when a fresh wallet balance fetch has completed for this wallet in the current session. */
export function hasSessionWalletBalances(wallet: string): boolean {
  const w = wallet.trim();
  return Boolean(w && sessionWalletBalances && sessionWalletBalances.wallet === w);
}

/** @deprecated Renamed to hasSessionWalletBalances */
export const isWalletBalanceCacheReady = hasSessionWalletBalances;

export function getWalletTotalBalanceUsd(): number | null {
  if (!sessionWalletBalances?.items.length) return null;
  let total = 0;
  for (const item of sessionWalletBalances.items) {
    const v = walletItemValueUsd(item);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

export function formatWalletTotalUsd(total: number | null): string {
  if (total == null) return '—';
  if (!Number.isFinite(total) || total <= 0) return '$0.00';
  if (total < SPL_MIN_TRADABLE_VALUE_USD) return '< $0.01';
  return `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type WalletSellableOptions = {
  /** When `vybe`, SPL max sell uses full wallet balance; aggregators leave ~2% fee headroom. */
  router?: string;
};

function usesFullSplBalanceForMaxSell(router?: string): boolean {
  return router?.trim().toLowerCase() === 'vybe';
}

export function computeWalletSellableAmountUi(
  total: number,
  mint: string,
  valueUsd?: number | null,
  options?: WalletSellableOptions,
): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (isWsolMint(mint)) return null;
  if (isNativeSolMint(mint)) {
    if (total < SOL_MIN_TRADABLE_TOTAL_UI) return null;
    const sellable = total - SOL_WALLET_MIN_RESERVE_UI;
    return sellable > 0 ? sellable : null;
  }
  if (valueUsd != null && !isSplValueTradable(valueUsd)) return null;
  if (usesFullSplBalanceForMaxSell(options?.router)) {
    return total;
  }
  const learned = getSplMaxSellFraction(mint);
  if (learned != null && learned > 0 && learned < 1) {
    const sellable = total * learned;
    return sellable > 0 ? sellable : null;
  }
  /* Default max sell leaves ~2% for input-side protocol fees (100% button still reads 100%). */
  const sellable = computeSplSellAmountForRetryStep(total, 1);
  return sellable > 0 ? sellable : null;
}

/** Max sellable UI amount (SOL reserve for native SOL; router-dependent for SPL). */
export function getWalletSellableAmountUi(mint: string, options?: WalletSellableOptions): number | null {
  const item = getWalletBalanceListItem(mint);
  if (item == null || !(item.amountUi > 0)) return null;
  return computeWalletSellableAmountUi(item.amountUi, mint, walletItemValueUsd(item), options);
}

export function isWalletTokenTradable(mint: string): boolean {
  if (isBlockedPickerMint(mint)) return false;
  return getWalletSellableAmountUi(mint) != null;
}

/** Persist wallet row metadata (symbol/name/logo/decimals) — never amounts or USD values. */
export function persistWalletBalanceMetadata(items: WalletBalanceListItem[]): void {
  for (const item of items) {
    saveTokenMeta(walletItemToTokenMeta(item));
  }
}

/** @deprecated Renamed to persistWalletBalanceMetadata */
export const saveWalletBalanceItemsToCache = persistWalletBalanceMetadata;

export function getSessionWalletBalanceItems(): readonly WalletBalanceListItem[] {
  return sessionWalletBalances?.items ?? [];
}

/** @deprecated Renamed to getSessionWalletBalanceItems */
export const getCachedWalletBalanceItems = getSessionWalletBalanceItems;

function renderWalletBalancesLoading(): string {
  return `<div class="token-picker-wallet-loading" aria-live="polite">
    <span class="token-picker-wallet-loading-spinner" aria-hidden="true"></span>
    <span>Loading wallet tokens…</span>
  </div>`;
}

function walletItemMatchesQuery(item: WalletBalanceListItem, query: string): boolean {
  const q = query.toLowerCase();
  const token = walletItemToTokenMeta(item);
  return (
    token.symbol.toLowerCase().includes(q) ||
    token.name.toLowerCase().includes(q) ||
    item.mintAddress.toLowerCase().includes(q)
  );
}

export function refreshWalletBalancesPanel(): void {
  if (!walletBalancesEl || !walletBalancesListEl) return;
  syncWalletBalancesVisibility();
  if (walletBalancesEl.hidden) return;
  const wallet = getWalletAddressCb?.().trim() ?? '';
  if (!wallet) {
    walletBalancesEl.hidden = true;
    return;
  }
  if (activeTab === 'wallet') showWalletBalancesTab();
}

function showWalletBalancesTab(): void {
  if (!walletBalancesEl || !walletBalancesListEl) return;
  syncWalletBalancesVisibility();
  if (walletBalancesEl.hidden) return;

  const wallet = getWalletAddressCb?.().trim() ?? '';
  if (!wallet) {
    walletBalancesEl.hidden = true;
    return;
  }

  if (getWalletHoldingsFetchingCb?.() || refetchHoldingsInFlight) {
    walletBalancesListEl.innerHTML = renderWalletBalancesLoading();
    return;
  }

  if (renderSessionWalletBalances()) return;

  walletBalancesListEl.innerHTML =
    '<div class="token-picker-wallet-empty">No holdings loaded yet.</div>';
}

function renderSessionWalletBalances(): boolean {
  const wallet = getWalletAddressCb?.().trim() ?? '';
  if (!wallet || !sessionWalletBalances || sessionWalletBalances.wallet !== wallet) return false;
  renderWalletListHtml(sessionWalletBalances.items);
  return true;
}

function setRefetchHoldingsTimerVisible(visible: boolean, durationSec?: number): void {
  if (!refetchHoldingsBtn || !refetchHoldingsTimerEl) return;
  refetchHoldingsTimerEl.hidden = !visible;
  refetchHoldingsBtn.classList.toggle('swap-action-btn--cooldown', visible);
  if (!visible) return;
  const progress = refetchHoldingsTimerEl.querySelector(
    '.swap-action-btn__timer-progress',
  ) as SVGCircleElement | null;
  if (progress && typeof durationSec === 'number' && Number.isFinite(durationSec)) {
    progress.style.animation = 'none';
    void progress.getBoundingClientRect();
    progress.style.setProperty('--swap-action-timer-duration', `${durationSec}s`);
    progress.style.animation = '';
  }
}

function clearRefetchHoldingsCooldown(): void {
  cancelAnimationFrame(refetchHoldingsCooldownRaf);
  refetchHoldingsCooldownRaf = 0;
  refetchHoldingsCooldownEndsAt = 0;
  setRefetchHoldingsTimerVisible(false);
}

function isRefetchHoldingsInCooldown(): boolean {
  return refetchHoldingsCooldownEndsAt > performance.now();
}

function tickRefetchHoldingsCooldown(now: number): void {
  if (!refetchHoldingsBtn || refetchHoldingsCooldownEndsAt <= 0) return;
  const remainMs = refetchHoldingsCooldownEndsAt - now;
  if (remainMs <= 0) {
    clearRefetchHoldingsCooldown();
    syncRefetchHoldingsBtn();
    return;
  }
  const label = refetchHoldingsTimerEl?.querySelector('.swap-action-btn__timer-label');
  if (label) label.textContent = String(Math.max(1, Math.ceil(remainMs / 1000)));
  refetchHoldingsCooldownRaf = requestAnimationFrame(() =>
    tickRefetchHoldingsCooldown(performance.now()),
  );
}

function startRefetchHoldingsCooldown(): void {
  if (!refetchHoldingsBtn || !refetchHoldingsTimerEl) return;
  const durationSec = REFETCH_HOLDINGS_COOLDOWN_SEC;
  refetchHoldingsCooldownEndsAt = performance.now() + durationSec * 1000;
  const label = refetchHoldingsTimerEl.querySelector('.swap-action-btn__timer-label');
  if (label) label.textContent = String(durationSec);
  setRefetchHoldingsTimerVisible(true, durationSec);
  refetchHoldingsBtn.disabled = true;
  cancelAnimationFrame(refetchHoldingsCooldownRaf);
  refetchHoldingsCooldownRaf = requestAnimationFrame(() =>
    tickRefetchHoldingsCooldown(performance.now()),
  );
}

export function syncRefetchHoldingsBtn(): void {
  if (!refetchHoldingsBtn) return;
  const wallet = getWalletAddressCb?.().trim() ?? '';
  const inCooldown = isRefetchHoldingsInCooldown();
  const fetching = getWalletHoldingsFetchingCb?.() ?? false;
  refetchHoldingsBtn.disabled =
    !wallet || inCooldown || fetching || refetchHoldingsInFlight;
}

async function onRefetchHoldingsClick(): Promise<void> {
  if (isRefetchHoldingsInCooldown() || refetchHoldingsInFlight) return;
  const wallet = getWalletAddressCb?.().trim() ?? '';
  if (!wallet) return;

  startRefetchHoldingsCooldown();
  refetchHoldingsInFlight = true;
  syncRefetchHoldingsBtn();

  if (activeTab === 'wallet' && walletBalancesListEl) {
    walletBalancesListEl.innerHTML = renderWalletBalancesLoading();
  }

  try {
    await onRefetchHoldingsCb?.();
  } finally {
    refetchHoldingsInFlight = false;
    syncRefetchHoldingsBtn();
    if (activeTab === 'wallet') showWalletBalancesTab();
  }
}

function renderWalletListHtml(items: WalletBalanceListItem[]): void {
  if (!walletBalancesListEl) return;
  const q = searchQuery.trim();
  const visible = q ? items.filter((item) => walletItemMatchesQuery(item, q)) : items;
  const sorted =
    activeSide === 'input' ? sortWalletBalancesForSellPicker(visible) : visible;
  if (sorted.length === 0) {
    walletBalancesListEl.innerHTML = q
      ? '<div class="token-picker-wallet-empty">No wallet tokens match your search.</div>'
      : '<div class="token-picker-wallet-empty">Wallet does not contain any tokens</div>';
    return;
  }
  walletBalancesListEl.innerHTML = sorted.map(renderWalletBalanceRow).join('');
  hydrateTokenIconImgs(walletBalancesListEl);
}

/** Sell picker: token has ≥ $0.01 wallet balance (or SOL reserve rules). Buy picker: always true. */
type SellPickerWalletState = 'tradable' | 'too_small' | 'not_in_wallet' | 'unknown' | 'blocked';

function getSellPickerWalletState(mint: string): SellPickerWalletState {
  if (activeSide !== 'input') return 'tradable';
  const wallet = getWalletAddressCb?.().trim() ?? '';
  if (!wallet || !sessionWalletBalances) return 'unknown';

  const swapMint = mint.trim();
  const item = getWalletBalanceListItem(swapMint);
  if (isBlockedPickerMint(swapMint)) {
    if (!item || !(item.amountUi > 0)) return 'not_in_wallet';
    return 'blocked';
  }
  if (!item || !(item.amountUi > 0)) return 'not_in_wallet';
  if (isWalletTokenTradable(swapMint)) return 'tradable';
  return 'too_small';
}

function isSellPickerMintTradable(mint: string): boolean {
  if (isBlockedPickerMint(mint)) return false;
  const state = getSellPickerWalletState(mint);
  return state === 'tradable' || state === 'unknown';
}

function sellPickerWalletStateTag(state: SellPickerWalletState): string {
  if (state === 'too_small') {
    return '<span class="token-picker-row-tag token-picker-row-tag--muted">Too small</span>';
  }
  if (state === 'not_in_wallet') {
    return '<span class="token-picker-row-tag token-picker-row-tag--muted">Not in wallet</span>';
  }
  return '';
}

function tokenWalletValueUsd(mint: string): number {
  const item = getWalletBalanceListItem(mint);
  return item ? walletItemValueUsd(item) : 0;
}

function sortTokensForSellPicker(tokens: TokenMeta[]): TokenMeta[] {
  const ranked: TokenMeta[] = [];
  const tooSmall: TokenMeta[] = [];
  const notInWallet: TokenMeta[] = [];
  for (const token of tokens) {
    const state = getSellPickerWalletState(token.mint);
    if (state === 'tradable' || state === 'unknown' || state === 'blocked') ranked.push(token);
    else if (state === 'too_small') tooSmall.push(token);
    else notInWallet.push(token);
  }
  ranked.sort((a, b) => tokenWalletValueUsd(b.mint) - tokenWalletValueUsd(a.mint));
  return [...ranked, ...tooSmall, ...notInWallet];
}

function shouldDemoteWalletBalanceInSort(mint: string): boolean {
  if (isBlockedPickerMint(mint)) return false;
  return !isWalletTokenTradable(mint);
}

function sortWalletBalancesForSellPicker(items: WalletBalanceListItem[]): WalletBalanceListItem[] {
  return [...items].sort((a, b) => {
    const aDemote = shouldDemoteWalletBalanceInSort(a.mintAddress);
    const bDemote = shouldDemoteWalletBalanceInSort(b.mintAddress);
    if (aDemote !== bDemote) return aDemote ? 1 : -1;
    return walletItemValueUsd(b) - walletItemValueUsd(a) || b.amountUi - a.amountUi;
  });
}

function renderTokenRow(token: TokenMeta): string {
  const blocked = isBlockedPickerMint(token.mint);
  const walletState = activeSide === 'input' ? getSellPickerWalletState(token.mint) : 'tradable';
  const untradable =
    blocked ||
    (activeSide === 'input' && walletState !== 'tradable' && walletState !== 'unknown');
  const tagHtml =
    token.tags?.includes('Token2022')
      ? '<span class="token-picker-row-tag">Token2022</span>'
      : '';
  const statusTag = blocked
    ? '<span class="token-picker-row-tag token-picker-row-tag--muted">Use SOL</span>'
    : activeSide === 'input'
      ? sellPickerWalletStateTag(walletState)
      : '';
  const score =
    token.organicScore != null && Number.isFinite(token.organicScore)
      ? `<span class="token-picker-row-score"><span class="token-picker-row-score-leaf" aria-hidden="true"></span>${Math.round(token.organicScore)}</span>`
      : '';
  const verified =
    token.isVerified !== false
      ? '<span class="token-picker-row-verified" aria-hidden="true"><span class="token-picker-row-verified-check"></span></span>'
      : '';
  const disabledAttr = untradable ? ' disabled aria-disabled="true"' : '';
  const untradableClass = untradable ? ' token-picker-row--untradable' : '';
  return `<button type="button" class="token-picker-row${untradableClass}" data-mint="${escapeHtml(token.mint)}"${disabledAttr}>
    <span class="token-picker-row-logo">${renderTokenIcon(token)}</span>
    <span class="token-picker-row-main">
      <span class="token-picker-row-title">
        <span class="token-picker-row-symbol">${escapeHtml(token.symbol)}</span>
        ${statusTag}
        ${verified}
        ${score}
      </span>
      <span class="token-picker-row-sub">${escapeHtml(token.name)} · ${escapeHtml(truncateMint(token.mint))}</span>
    </span>
    ${tagHtml}
  </button>`;
}

const SHORTCUT_MINTS = [
  '11111111111111111111111111111111',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4',
  'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
];

function renderShortcuts(): void {
  if (!shortcutsEl) return;
  const picks = SHORTCUT_MINTS.map((mint) => catalogTokens.find((t) => t.mint === mint)).filter(
    (t): t is TokenMeta => Boolean(t),
  );
  const fallback = catalogTokens.slice(0, 6);
  const tokens = picks.length > 0 ? picks : fallback;
  const ordered = activeSide === 'input' ? sortTokensForSellPicker(tokens) : tokens;
  const leadMint =
    activeSide === 'input'
      ? ordered.find((t) => isSellPickerMintTradable(t.mint))?.mint
      : ordered[0]?.mint;
  shortcutsEl.innerHTML = ordered
    .map((t) => {
      const untradable =
        isBlockedPickerMint(t.mint) ||
        (activeSide === 'input' && !isSellPickerMintTradable(t.mint));
      const lead = t.mint === leadMint ? ' token-picker-shortcut--lead' : '';
      const untradableClass = untradable ? ' token-picker-shortcut--untradable' : '';
      const disabled = untradable ? ' disabled aria-disabled="true"' : '';
      const iconSrc = effectiveTokenIconSrc(t.logoUrl);
      const iconHtml = renderTokenIconImgHtml(iconSrc, '');
      return `<button type="button" class="token-picker-shortcut${lead}${untradableClass}" data-mint="${escapeHtml(t.mint)}" title="${escapeHtml(t.symbol)}"${disabled}>
          ${iconHtml}
        </button>`;
    })
    .join('');
  hydrateTokenIconImgs(shortcutsEl);
}

function setStatus(msg: string): void {
  if (statusEl) statusEl.textContent = msg;
}

function renderList(): void {
  if (!listEl) return;
  if (activeTab === 'wallet') {
    listEl.innerHTML = '';
    return;
  }
  const tokens = getVisibleTokens();
  if (tokens.length === 0) {
    const q = searchQuery.trim();
    if (BASE58_RE.test(q) && pendingMintLookup === q) {
      listEl.innerHTML = '<div class="token-picker-empty">Looking up token…</div>';
      return;
    }
    if (BASE58_RE.test(q)) {
      listEl.innerHTML = '<div class="token-picker-empty">No token found for that address.</div>';
      return;
    }
    listEl.innerHTML = `<div class="token-picker-empty">${q ? 'No tokens match your search.' : 'No tokens to show.'}</div>`;
    return;
  }
  listEl.innerHTML = tokens.map(renderTokenRow).join('');
  hydrateTokenIconImgs(listEl);
}

function syncTabs(): void {
  document.querySelectorAll('.token-picker-tab').forEach((el) => {
    const tab = (el as HTMLElement).dataset.tab;
    el.classList.toggle('token-picker-tab--active', tab === activeTab);
  });
}

function selectToken(mint: string): void {
  if (isBlockedPickerMint(mint)) return;
  const walletItem = sessionWalletBalances?.items.find((i) => i.mintAddress === mint);
  if (walletItem) {
    saveTokenMeta(walletItemToTokenMeta(walletItem));
  } else {
    const fromCatalog = catalogTokens.find((t) => t.mint === mint);
    const cached = readCache()[mint];
    const meta = fromCatalog ?? cached;
    if (meta) saveTokenMeta({ ...meta, savedAt: Date.now() });
  }
  onSelectCb?.(mint, activeSide);
  closeTokenPicker();
}

export function openTokenPicker(side: TokenPickerSide): void {
  if (!dialogEl) return;
  if (side === 'input' && canOpenSellPickerCb && !canOpenSellPickerCb()) return;
  if (side === 'output' && canOpenBuyPickerCb && !canOpenBuyPickerCb()) return;
  activeSide = side;
  activeTab = 'wallet';
  searchQuery = '';
  pendingMintLookup = null;
  if (searchInputEl) searchInputEl.value = '';
  syncPickerLayout();
  renderShortcuts();
  if (activeTab === 'wallet') showWalletBalancesTab();
  renderList();
  setStatus('');
  if (typeof dialogEl.showModal === 'function') dialogEl.showModal();
  else dialogEl.setAttribute('open', '');
  lockPageScroll();
  requestAnimationFrame(() => {
    if (!searchWrapEl?.hidden) searchInputEl?.focus();
  });
}

export function closeTokenPicker(): void {
  if (!dialogEl) return;
  pendingMintLookup = null;
  if (typeof dialogEl.close === 'function') dialogEl.close();
  else dialogEl.removeAttribute('open');
  unlockPageScroll();
}

async function onSearchInput(): Promise<void> {
  if (!searchInputEl) return;
  searchQuery = searchInputEl.value;
  const q = searchQuery.trim();

  if (BASE58_RE.test(q)) {
    const cache = readCache();
    const catalogHit = catalogTokens.find((t) => t.mint === q);
    if (!catalogHit && !cache[q] && pendingMintLookup !== q) {
      pendingMintLookup = q;
      renderList();
      const fetched = await fetchTokenByMint(q);
      pendingMintLookup = null;
      if (fetched && searchInputEl.value.trim() === q) {
        renderList();
        return;
      }
    }
  }

  renderList();
  if (activeTab === 'wallet') showWalletBalancesTab();
  syncPickerLayout();
}

function debouncedSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void onSearchInput(), 220);
}

export function initTokenPicker(options: {
  onSelect: (mint: string, side: TokenPickerSide) => void;
  getWalletAddress?: () => string;
  canOpenSellPicker?: () => boolean;
  canOpenBuyPicker?: () => boolean;
  onRefetchHoldings?: () => void | Promise<void>;
  isWalletHoldingsFetching?: () => boolean;
}): void {
  ensureTokenIconErrorHandling();
  onSelectCb = options.onSelect;
  getWalletAddressCb = options.getWalletAddress ?? null;
  canOpenSellPickerCb = options.canOpenSellPicker ?? null;
  canOpenBuyPickerCb = options.canOpenBuyPicker ?? null;
  onRefetchHoldingsCb = options.onRefetchHoldings ?? null;
  getWalletHoldingsFetchingCb = options.isWalletHoldingsFetching ?? null;
  dialogEl = document.getElementById('tokenPickerDialog') as HTMLDialogElement | null;
  searchInputEl = document.getElementById('tokenPickerSearch') as HTMLInputElement | null;
  listEl = document.getElementById('tokenPickerList');
  shortcutsEl = document.getElementById('tokenPickerShortcuts');
  walletBalancesEl = document.getElementById('tokenPickerWalletBalances');
  walletBalancesListEl = document.getElementById('tokenPickerWalletBalancesList');
  tabsEl = document.querySelector('.token-picker-tabs');
  refetchHoldingsBtn = document.getElementById('tokenPickerRefetchHoldings') as HTMLButtonElement | null;
  refetchHoldingsTimerEl = document.getElementById('tokenPickerRefetchHoldingsTimer');
  listWrapEl = document.querySelector('.token-picker-list-wrap');
  searchWrapEl = document.querySelector('.token-picker-search-wrap');
  walletTabEl = document.querySelector('.token-picker-tab[data-tab="wallet"]');
  topTabEl = document.querySelector('.token-picker-tab[data-tab="top"]');
  statusEl = document.getElementById('tokenPickerStatus');

  refetchHoldingsBtn?.addEventListener('click', () => void onRefetchHoldingsClick());
  syncRefetchHoldingsBtn();

  void loadCatalog().then(() => {
    renderShortcuts();
    if (dialogEl?.open) renderList();
  });

  document.getElementById('tokenPickerClose')?.addEventListener('click', () => closeTokenPicker());
  document.getElementById('tokenPickerEsc')?.addEventListener('click', () => closeTokenPicker());

  searchInputEl?.addEventListener('input', debouncedSearch);
  searchInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTokenPicker();
    }
  });

  document.querySelectorAll('.token-picker-tab').forEach((el) => {
    el.addEventListener('click', () => {
      const tab = (el as HTMLElement).dataset.tab;
      if (tab === 'top' && activeSide === 'input') return;
      if (tab === 'top' || tab === 'recent' || tab === 'wallet') {
        activeTab = tab;
        syncPickerLayout();
        if (tab === 'wallet') showWalletBalancesTab();
        else renderList();
      }
    });
  });

  listEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.token-picker-row');
    if (!btn?.dataset.mint || btn.disabled) return;
    selectToken(btn.dataset.mint);
  });

  walletBalancesListEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.token-picker-row--wallet');
    if (!btn?.dataset.mint || btn.disabled) return;
    selectToken(btn.dataset.mint);
  });

  shortcutsEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.token-picker-shortcut');
    if (!btn?.dataset.mint || btn.disabled) return;
    selectToken(btn.dataset.mint);
  });

  dialogEl?.addEventListener('click', (e) => {
    if (e.target === dialogEl) closeTokenPicker();
  });

  dialogEl?.addEventListener('close', () => {
    pendingMintLookup = null;
    unlockPageScroll();
  });

  dialogEl?.addEventListener('wheel', preventBackgroundScroll, { passive: false });
  dialogEl?.addEventListener('touchmove', preventBackgroundScroll, { passive: false });
}

export async function ensureTokenCatalogLoaded(): Promise<void> {
  await loadCatalog();
}

const pendingMetaFetches = new Map<string, Promise<TokenMeta | null>>();

export async function ensureTokenMetaForMint(mint: string): Promise<TokenMeta | null> {
  await loadCatalog();
  const m = mint.trim();
  if (!m) return null;
  const existing = getCachedTokenMeta(m);
  if (existing && !needsRemoteLogoResolve(existing)) return existing;
  const pending = pendingMetaFetches.get(m);
  if (pending) return pending;
  const promise = (async (): Promise<TokenMeta | null> => {
    if (BASE58_RE.test(m)) {
      const fetched = await fetchTokenByMint(m);
      return fetched ?? existing ?? null;
    }
    return existing;
  })().finally(() => {
    pendingMetaFetches.delete(m);
  });
  pendingMetaFetches.set(m, promise);
  return promise;
}

export async function prefetchTokenMetas(mints: string[]): Promise<void> {
  await loadCatalog();
  const uniq = [...new Set(mints.map((mint) => mint.trim()).filter(Boolean))];
  await Promise.all(uniq.map((mint) => ensureTokenMetaForMint(mint)));
}

export function renderChipTokenIcon(el: HTMLElement | null, mint: string | undefined, fallbackDotClass: string): void {
  if (!el) return;
  const meta = getCachedTokenMeta(mint?.trim() ?? '');
  const src = effectiveTokenIconSrc(meta?.logoUrl);
  el.className = 'swap-token-chip-icon swap-token-chip-icon--logo';
  el.innerHTML = renderTokenIconImgHtml(src, '');
  const img = el.querySelector('img');
  if (img) bindTokenIconImg(img);
}
