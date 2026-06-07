/**
 * Token picker modal — catalog from token-catalog.tsv + local device cache for searches.
 */

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

export interface TokenPriceHint {
  price?: number;
  price1d?: number;
  price7d?: number;
  decimals?: number;
  priceFetchedAt?: number;
  priceUpdateTime?: number;
  symbol?: string;
  name?: string;
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
  valueUsd: number;
  verified: boolean;
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
let activeTab: 'top' | 'recent' = 'top';
let searchQuery = '';
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMintLookup: string | null = null;

let dialogEl: HTMLDialogElement | null = null;
let searchInputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let shortcutsEl: HTMLElement | null = null;
let walletBalancesEl: HTMLElement | null = null;
let walletBalancesListEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let onSelectCb: ((mint: string, side: TokenPickerSide) => void) | null = null;
let getWalletAddressCb: (() => string) | null = null;
let canOpenSellPickerCb: (() => boolean) | null = null;

let walletBalanceCache: { wallet: string; at: number; items: WalletBalanceListItem[] } | null = null;
const WALLET_BALANCE_TTL_MS = 15000;

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
  };
}

export function getCachedTokenMeta(mint: string): TokenMeta | null {
  const m = mint.trim();
  if (!m) return null;
  const fromCatalog = catalogTokens.find((t) => t.mint === m);
  const cached = readCache()[m];
  if (fromCatalog && cached) return mergeCatalogWithDeviceCache(fromCatalog, cached);
  if (fromCatalog) return fromCatalog;
  if (cached) return cached;
  if (m === NATIVE_SOL_MINT) {
    const wsolCatalog = catalogTokens.find((t) => t.mint === WSOL_MINT);
    const wsolCached = readCache()[WSOL_MINT];
    if (wsolCatalog && wsolCached) return mergeCatalogWithDeviceCache(wsolCatalog, wsolCached);
    return wsolCached ?? wsolCatalog ?? null;
  }
  return null;
}

export function getTokenDecimalsFromCache(mint: string): number | undefined {
  return getCachedTokenMeta(mint)?.decimals;
}

export function buildTokenHintsForMints(mints: string[]): Record<string, TokenPriceHint> {
  const hints: Record<string, TokenPriceHint> = {};
  for (const mint of mints) {
    const m = mint.trim();
    if (!m) continue;
    const meta = getCachedTokenMeta(m);
    if (!meta) continue;
    const hint: TokenPriceHint = {
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      price: meta.price,
      price1d: meta.price1d,
      price7d: meta.price7d,
      priceFetchedAt: meta.priceFetchedAt,
      priceUpdateTime: meta.priceUpdateTime,
    };
    if (hint.decimals != null || hint.price != null) hints[m] = hint;
  }
  if (!hints[NATIVE_SOL_MINT] && hints[WSOL_MINT]) {
    hints[NATIVE_SOL_MINT] = { ...hints[WSOL_MINT], symbol: 'SOL', name: 'Solana' };
  }
  return hints;
}

export function saveTokenPriceStats(mint: string, stats: TokenPriceStats): void {
  const m = mint.trim();
  if (!m) return;
  const existing = getCachedTokenMeta(m);
  const meta: TokenMeta = {
    mint: m,
    symbol: existing?.symbol ?? truncateMint(m),
    name: existing?.name ?? truncateMint(m),
    logoUrl: existing?.logoUrl ?? '',
    decimals: stats.decimals,
    price: stats.price,
    price1d: stats.price1d,
    price7d: stats.price7d,
    priceUpdateTime: stats.priceUpdateTime,
    priceFetchedAt: stats.priceFetchedAt,
    tags: existing?.tags,
    organicScore: existing?.organicScore,
    isVerified: existing?.isVerified,
    source: existing?.source ?? 'search',
    savedAt: Date.now(),
  };
  saveTokenMeta(meta);
}

/** Prefer locally served icon paths; leave remote URLs for server localization. */
export function resolveLogoUrl(logoUrl: string | undefined): string {
  const u = (logoUrl ?? '').trim();
  if (!u) return '';
  if (u.startsWith('/')) return u;
  return u;
}

function needsRemoteLogoResolve(meta: TokenMeta | null | undefined): boolean {
  if (!meta) return true;
  const u = meta.logoUrl.trim();
  return !u || u.startsWith('http://') || u.startsWith('https://');
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
  if (!rawQ) return base;

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
  return [...filtered, ...cacheHits];
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
    const meta: TokenMeta = {
      mint,
      symbol: symbol || truncateMint(mint),
      name: name || symbol || truncateMint(mint),
      logoUrl,
      decimals,
      price,
      price1d,
      price7d,
      priceUpdateTime,
      priceFetchedAt,
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
  const src = resolveLogoUrl(token.logoUrl);
  if (src) {
    return `<img class="token-picker-row-logo-img" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`;
  }
  return `<span class="token-picker-row-logo-fallback" aria-hidden="true">${escapeHtml(token.symbol.slice(0, 1))}</span>`;
}

function formatBalanceAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  if (amount >= 1000) return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (amount >= 1) return amount.toFixed(4).replace(/\.?0+$/, '');
  return amount.toFixed(6).replace(/\.?0+$/, '') || '0';
}

function formatWalletBalanceUsd(valueUsd: number): string {
  if (!Number.isFinite(valueUsd) || valueUsd <= 0) return '~$0.00';
  const abs = Math.abs(valueUsd);
  const maxFrac = abs >= 9.99 ? 0 : abs >= 1 ? 2 : 4;
  return `~$${valueUsd.toLocaleString(undefined, { maximumFractionDigits: maxFrac, minimumFractionDigits: 2 })}`;
}

function walletItemToTokenMeta(item: WalletBalanceListItem): TokenMeta {
  const catalogHit = catalogTokens.find((t) => t.mint === item.mintAddress);
  const cached = readCache()[item.mintAddress];
  const base = catalogHit ?? cached;
  return {
    mint: item.mintAddress,
    symbol: item.symbol || base?.symbol || truncateMint(item.mintAddress),
    name: item.name || base?.name || item.symbol,
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
  const swapMint = preferNativeSolMint(item.mintAddress);
  const tradable = isWalletTokenTradable(swapMint);
  const amountLabel = `${formatBalanceAmount(item.amountUi)} ${token.symbol}`;
  const fiatLabel = formatWalletBalanceUsd(item.valueUsd);
  const tooSmall =
    !tradable && isSolMint(item.mintAddress)
      ? '<span class="token-picker-row-tag token-picker-row-tag--muted">Too small</span>'
      : '';
  const disabledAttr = tradable ? '' : ' disabled aria-disabled="true"';
  return `<button type="button" class="token-picker-row token-picker-row--wallet${tradable ? '' : ' token-picker-row--untradable'}" data-mint="${escapeHtml(item.mintAddress)}"${disabledAttr}>
    <span class="token-picker-row-logo">${renderTokenIcon(token)}</span>
    <span class="token-picker-row-main">
      <span class="token-picker-row-title">
        <span class="token-picker-row-symbol">${escapeHtml(token.symbol)}</span>
        ${tooSmall}
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
  walletBalancesEl.hidden = activeSide !== 'input' || Boolean(searchQuery.trim());
}

async function fetchWalletBalances(wallet: string, force = false): Promise<WalletBalanceListItem[]> {
  const now = Date.now();
  if (
    !force &&
    walletBalanceCache &&
    walletBalanceCache.wallet === wallet &&
    now - walletBalanceCache.at < WALLET_BALANCE_TTL_MS
  ) {
    return walletBalanceCache.items;
  }

  const res = await fetch(`/api/wallets/${encodeURIComponent(wallet)}/token-balances?limit=50`);
  const body = (await res.json().catch(() => ({}))) as {
    tokens?: WalletBalanceListItem[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || `Wallet balances failed (${res.status})`);
  }
  const items = Array.isArray(body.tokens) ? body.tokens : [];
  walletBalanceCache = { wallet, at: now, items };
  return items;
}

export async function prefetchWalletBalances(
  wallet: string,
  force = false,
): Promise<WalletBalanceListItem[]> {
  return fetchWalletBalances(wallet.trim(), force);
}

/** Vybe reports native SOL under System Program id, not WSOL mint. */
export const NATIVE_SOL_MINT = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Leave this much SOL in wallet when selling (rent + fees). */
export const SOL_WALLET_MIN_RESERVE_UI = 0.006;
/** Total SOL below this is skipped for auto-pick (prefer USDC/USDT instead). */
export const SOL_MIN_AUTO_PICK_TOTAL_UI = 0.0065;
/** Total SOL below this is not tradable (max sell would be ≤ 0.0001 SOL). */
export const SOL_MIN_TRADABLE_TOTAL_UI = 0.0061;

export function isSolMint(mint: string): boolean {
  const m = mint.trim();
  return m === NATIVE_SOL_MINT || m === WSOL_MINT;
}

export function preferNativeSolMint(mint: string): string {
  const m = mint.trim();
  return m === WSOL_MINT ? NATIVE_SOL_MINT : m;
}

/** @deprecated Use preferNativeSolMint — UI keeps native SOL; Vybe uses WSOL server-side. */
export function normalizeSwapSolMint(mint: string): string {
  return preferNativeSolMint(mint);
}

export function getWalletBalanceAmountUi(mint: string): number | null {
  const m = mint.trim();
  if (!m || !walletBalanceCache) return null;
  if (isSolMint(m)) {
    const native = walletBalanceCache.items.find((i) => i.mintAddress === NATIVE_SOL_MINT);
    const wrapped = walletBalanceCache.items.find((i) => i.mintAddress === WSOL_MINT);
    const total = (native?.amountUi ?? 0) + (wrapped?.amountUi ?? 0);
    return total > 0 ? total : null;
  }
  const item = walletBalanceCache.items.find((i) => i.mintAddress === m);
  return item && item.amountUi > 0 ? item.amountUi : null;
}

export function computeWalletSellableAmountUi(total: number, mint: string): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (isSolMint(mint)) {
    if (total < SOL_MIN_TRADABLE_TOTAL_UI) return null;
    const sellable = total - SOL_WALLET_MIN_RESERVE_UI;
    return sellable > 0 ? sellable : null;
  }
  return total;
}

/** Max sellable UI amount (SOL reserve for native SOL; full balance for other tokens). */
export function getWalletSellableAmountUi(mint: string): number | null {
  const total = getWalletBalanceAmountUi(mint);
  if (total == null) return null;
  return computeWalletSellableAmountUi(total, mint);
}

export function isWalletTokenTradable(mint: string): boolean {
  return getWalletSellableAmountUi(mint) != null;
}

export function saveWalletBalanceItemsToCache(items: WalletBalanceListItem[]): void {
  for (const item of items) {
    saveTokenMeta(walletItemToTokenMeta(item));
  }
}

export function refreshWalletBalancesPanel(): void {
  void renderWalletBalances();
}

function renderWalletBalancesLoading(): string {
  return `<div class="token-picker-wallet-loading" aria-live="polite">
    <span class="token-picker-wallet-loading-spinner" aria-hidden="true"></span>
    <span>Loading wallet tokens…</span>
  </div>`;
}

async function renderWalletBalances(): Promise<void> {
  if (!walletBalancesEl || !walletBalancesListEl) return;
  syncWalletBalancesVisibility();
  if (walletBalancesEl.hidden) return;

  const wallet = getWalletAddressCb?.().trim() ?? '';
  if (!wallet) {
    walletBalancesEl.hidden = true;
    return;
  }

  walletBalancesListEl.innerHTML = renderWalletBalancesLoading();

  try {
    const items = await fetchWalletBalances(wallet);
    if (activeSide !== 'input' || searchQuery.trim()) return;
    if (items.length === 0) {
      walletBalancesListEl.innerHTML =
        '<div class="token-picker-wallet-empty">Wallet does not contain any tokens</div>';
      return;
    }
    walletBalancesListEl.innerHTML = items.map(renderWalletBalanceRow).join('');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    walletBalancesListEl.innerHTML = `<div class="token-picker-wallet-empty">${escapeHtml(message)}</div>`;
  }
}

function renderTokenRow(token: TokenMeta): string {
  const tagHtml =
    token.tags?.includes('Token2022')
      ? '<span class="token-picker-row-tag">Token2022</span>'
      : '';
  const score =
    token.organicScore != null && Number.isFinite(token.organicScore)
      ? `<span class="token-picker-row-score"><span class="token-picker-row-score-leaf" aria-hidden="true"></span>${Math.round(token.organicScore)}</span>`
      : '';
  const verified =
    token.isVerified !== false
      ? '<span class="token-picker-row-verified" aria-hidden="true"><span class="token-picker-row-verified-check"></span></span>'
      : '';
  return `<button type="button" class="token-picker-row" data-mint="${escapeHtml(token.mint)}">
    <span class="token-picker-row-logo">${renderTokenIcon(token)}</span>
    <span class="token-picker-row-main">
      <span class="token-picker-row-title">
        <span class="token-picker-row-symbol">${escapeHtml(token.symbol)}</span>
        ${verified}
        ${score}
      </span>
      <span class="token-picker-row-sub">${escapeHtml(token.name)} · ${escapeHtml(truncateMint(token.mint))}</span>
    </span>
    ${tagHtml}
  </button>`;
}

const SHORTCUT_MINTS = [
  'So11111111111111111111111111111111111111112',
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
  shortcutsEl.innerHTML = tokens
    .map(
      (t, i) =>
        `<button type="button" class="token-picker-shortcut${i === 0 ? ' token-picker-shortcut--lead' : ''}" data-mint="${escapeHtml(t.mint)}" title="${escapeHtml(t.symbol)}">
          ${resolveLogoUrl(t.logoUrl) ? `<img src="${escapeHtml(resolveLogoUrl(t.logoUrl))}" alt="" loading="lazy" decoding="async" />` : `<span>${escapeHtml(t.symbol.slice(0, 1))}</span>`}
        </button>`,
    )
    .join('');
}

function setStatus(msg: string): void {
  if (statusEl) statusEl.textContent = msg;
}

function renderList(): void {
  if (!listEl) return;
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
}

function syncTabs(): void {
  document.querySelectorAll('.token-picker-tab').forEach((el) => {
    const tab = (el as HTMLElement).dataset.tab;
    el.classList.toggle('token-picker-tab--active', tab === activeTab);
  });
}

function selectToken(mint: string): void {
  const walletItem = walletBalanceCache?.items.find((i) => i.mintAddress === mint);
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
  activeSide = side;
  activeTab = 'top';
  searchQuery = '';
  pendingMintLookup = null;
  if (searchInputEl) searchInputEl.value = '';
  syncTabs();
  renderShortcuts();
  syncWalletBalancesVisibility();
  void renderWalletBalances();
  renderList();
  setStatus('');
  if (typeof dialogEl.showModal === 'function') dialogEl.showModal();
  else dialogEl.setAttribute('open', '');
  requestAnimationFrame(() => searchInputEl?.focus());
}

export function closeTokenPicker(): void {
  if (!dialogEl) return;
  pendingMintLookup = null;
  if (typeof dialogEl.close === 'function') dialogEl.close();
  else dialogEl.removeAttribute('open');
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
  syncWalletBalancesVisibility();
}

function debouncedSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void onSearchInput(), 220);
}

export function initTokenPicker(options: {
  onSelect: (mint: string, side: TokenPickerSide) => void;
  getWalletAddress?: () => string;
  canOpenSellPicker?: () => boolean;
}): void {
  onSelectCb = options.onSelect;
  getWalletAddressCb = options.getWalletAddress ?? null;
  canOpenSellPickerCb = options.canOpenSellPicker ?? null;
  dialogEl = document.getElementById('tokenPickerDialog') as HTMLDialogElement | null;
  searchInputEl = document.getElementById('tokenPickerSearch') as HTMLInputElement | null;
  listEl = document.getElementById('tokenPickerList');
  shortcutsEl = document.getElementById('tokenPickerShortcuts');
  walletBalancesEl = document.getElementById('tokenPickerWalletBalances');
  walletBalancesListEl = document.getElementById('tokenPickerWalletBalancesList');
  statusEl = document.getElementById('tokenPickerStatus');

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
      if (tab === 'top' || tab === 'recent') {
        activeTab = tab;
        syncTabs();
        renderList();
      }
    });
  });

  listEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.token-picker-row');
    if (!btn?.dataset.mint) return;
    selectToken(btn.dataset.mint);
  });

  walletBalancesListEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.token-picker-row--wallet');
    if (!btn?.dataset.mint || btn.disabled) return;
    selectToken(btn.dataset.mint);
  });

  shortcutsEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.token-picker-shortcut');
    if (!btn?.dataset.mint) return;
    selectToken(btn.dataset.mint);
  });

  dialogEl?.addEventListener('click', (e) => {
    if (e.target === dialogEl) closeTokenPicker();
  });

  dialogEl?.addEventListener('close', () => {
    pendingMintLookup = null;
  });
}

export async function ensureTokenCatalogLoaded(): Promise<void> {
  await loadCatalog();
}

export async function ensureTokenMetaForMint(mint: string): Promise<TokenMeta | null> {
  await loadCatalog();
  const m = mint.trim();
  if (!m) return null;
  const existing = getCachedTokenMeta(m);
  if (existing && !needsRemoteLogoResolve(existing)) return existing;
  if (BASE58_RE.test(m)) {
    const fetched = await fetchTokenByMint(m);
    return fetched ?? existing ?? null;
  }
  return existing;
}

export async function prefetchTokenMetas(mints: string[]): Promise<void> {
  await loadCatalog();
  const uniq = [...new Set(mints.map((mint) => mint.trim()).filter(Boolean))];
  await Promise.all(uniq.map((mint) => ensureTokenMetaForMint(mint)));
}

export function renderChipTokenIcon(el: HTMLElement | null, mint: string | undefined, fallbackDotClass: string): void {
  if (!el) return;
  const meta = getCachedTokenMeta(mint?.trim() ?? '');
  const src = resolveLogoUrl(meta?.logoUrl);
  if (src) {
    el.className = 'swap-token-chip-icon swap-token-chip-icon--logo';
    el.innerHTML = `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`;
    return;
  }
  el.innerHTML = '';
  el.className = `swap-token-chip-icon routing-token-dot ${fallbackDotClass}`;
}
