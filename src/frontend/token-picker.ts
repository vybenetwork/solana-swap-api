/**
 * Token picker modal — catalog from token-catalog.tsv + local device cache for searches.
 */

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string;
  decimals?: number;
  tags?: string[];
  organicScore?: number;
  isVerified?: boolean;
  source: 'catalog' | 'search';
  savedAt: number;
}

export type TokenPickerSide = 'input' | 'output';

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
let statusEl: HTMLElement | null = null;
let onSelectCb: ((mint: string, side: TokenPickerSide) => void) | null = null;

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

export function getCachedTokenMeta(mint: string): TokenMeta | null {
  const m = mint.trim();
  if (!m) return null;
  const fromCatalog = catalogTokens.find((t) => t.mint === m);
  if (fromCatalog) return fromCatalog;
  return readCache()[m] ?? null;
}

export function getTokenDecimalsFromCache(mint: string): number | undefined {
  return getCachedTokenMeta(mint)?.decimals;
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
      logoUrl: (logoUrl ?? '').trim(),
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
    logoUrl: String(raw.logoUrl ?? raw.icon ?? '').trim(),
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
  if (mint.length <= 12) return mint;
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
    const logoUrl = String(body.logoUrl ?? '').trim();
    const decimals = typeof body.decimals === 'number' ? body.decimals : undefined;
    const tokenProgram = String(body.tokenProgram ?? body.program ?? '').trim();
    const tags: string[] = [];
    if (/2022/i.test(tokenProgram) || body.isToken2022 === true) tags.push('Token2022');
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
  if (token.logoUrl) {
    return `<img class="token-picker-row-logo-img" src="${escapeHtml(token.logoUrl)}" alt="" loading="lazy" decoding="async" />`;
  }
  return `<span class="token-picker-row-logo-fallback" aria-hidden="true">${escapeHtml(token.symbol.slice(0, 1))}</span>`;
}

function renderTokenRow(token: TokenMeta): string {
  const tagHtml =
    token.tags?.includes('Token2022')
      ? '<span class="token-picker-row-tag">Token2022</span>'
      : '';
  const score =
    token.organicScore != null && Number.isFinite(token.organicScore)
      ? `<span class="token-picker-row-score">${Math.round(token.organicScore)}</span>`
      : '';
  const verified = token.isVerified !== false ? '<span class="token-picker-row-verified" aria-hidden="true"></span>' : '';
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

function renderShortcuts(): void {
  if (!shortcutsEl) return;
  const picks = catalogTokens.slice(0, 6);
  shortcutsEl.innerHTML = picks
    .map(
      (t) =>
        `<button type="button" class="token-picker-shortcut" data-mint="${escapeHtml(t.mint)}" title="${escapeHtml(t.symbol)}">
          ${t.logoUrl ? `<img src="${escapeHtml(t.logoUrl)}" alt="" />` : `<span>${escapeHtml(t.symbol.slice(0, 1))}</span>`}
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
  const fromCatalog = catalogTokens.find((t) => t.mint === mint);
  const cached = readCache()[mint];
  const meta = fromCatalog ?? cached;
  if (meta) saveTokenMeta({ ...meta, savedAt: Date.now() });
  onSelectCb?.(mint, activeSide);
  closeTokenPicker();
}

export function openTokenPicker(side: TokenPickerSide): void {
  if (!dialogEl) return;
  activeSide = side;
  activeTab = 'top';
  searchQuery = '';
  pendingMintLookup = null;
  if (searchInputEl) searchInputEl.value = '';
  syncTabs();
  renderShortcuts();
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
}

function debouncedSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void onSearchInput(), 220);
}

export function initTokenPicker(options: {
  onSelect: (mint: string, side: TokenPickerSide) => void;
}): void {
  onSelectCb = options.onSelect;
  dialogEl = document.getElementById('tokenPickerDialog') as HTMLDialogElement | null;
  searchInputEl = document.getElementById('tokenPickerSearch') as HTMLInputElement | null;
  listEl = document.getElementById('tokenPickerList');
  shortcutsEl = document.getElementById('tokenPickerShortcuts');
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
  if (existing) return existing;
  if (BASE58_RE.test(m)) return fetchTokenByMint(m);
  return null;
}

export function renderChipTokenIcon(el: HTMLElement | null, mint: string | undefined, fallbackDotClass: string): void {
  if (!el) return;
  const meta = getCachedTokenMeta(mint?.trim() ?? '');
  if (meta?.logoUrl) {
    el.className = 'swap-token-chip-icon swap-token-chip-icon--logo';
    el.innerHTML = `<img src="${escapeHtml(meta.logoUrl)}" alt="" loading="lazy" decoding="async" />`;
    return;
  }
  el.innerHTML = '';
  el.className = `swap-token-chip-icon routing-token-dot ${fallbackDotClass}`;
}
