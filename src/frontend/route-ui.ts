/**
 * Route diagram, route plan steps, hop % badges, and fee/rent accounting.
 *
 * ## Hop outgoing % (badge on each hop)
 * Per-hop step factors (computeHopStepRetentionFactor) chain into cumulative in/out
 * badges shared by the route diagram and route plan step headers:
 * 1. hopLocalOutRetentionFactor — output-side pool/protocol cuts on the hop mint.
 * 2. Wallet fees on this hop (same items as diagram fee branch + acc rent above).
 * 3. Chain: inPct = running retention entering hop; outPct = inPct × step factor.
 *
 * ## Fee classification
 * - isWalletCostFeeItem: debited from wallet (acc rent, protocol/route on sell mint, priority, etc.)
 * - isOutputSideFeeDisplayItem: pool fee, slippage/spread, lp_pool, output_deduction
 * - isAccRentWalletFeeItem: token account rent (SOL), always wallet cost
 * - isHopFeeTableWalletColumnItem: rows summed in plan table "sell mint" column
 *
 * ## Wallet pay raw
 * resolveWalletPayDebitRaw: simulation _walletPayDebitRaw, else estimate from inAmount + input-side fees
 */

import {
  getCachedTokenMeta,
  effectiveTokenIconSrc,
  renderTokenIconImgHtml,
  TOKEN_ICON_PLACEHOLDER_PATH,
  routingTokenDotClass,
  isSolMint,
  NATIVE_SOL_MINT,
  WSOL_MINT,
  tokenSymColorClass,
  tokenBoxColorClass,
  type TokenPriceStats,
} from './token-picker.js';

export interface RouteUiDeps {
  getFormInputMint: () => string;
  getFormOutputMint: () => string;
  getFormSwapAmount: () => string;
  getSwapInSym: () => string;
  getSwapOutSym: () => string;
  getSwapRouter: () => string;
  getLastQuote: () => Record<string, unknown> | null;
  getQuoteWalletPayLabel: () => string;
  getQuotePayUsdEstimateLabel: () => string | null;
  getWalletAddress: () => string;
  getWalletSnapshot: () => string;
  getPairTokenStats: () => Record<string, TokenPriceStats>;
  getMintDecimals: (mint: string) => number;
  rawAmountToUiNumber: (raw: string, decimals: number) => number;
  formatRawTokenAmount: (raw: string | undefined, mint: string) => { display: string; full: string };
  formatSwapAmountValue: (n: number) => string;
  formatSwapAmount: (value: unknown) => { display: string; full: string };
  formatFeeStackAmount: (n: number) => string;
  formatFeeEquivSmallAmount: (n: number) => string;
  formatFeeEquivUsdFiatDisplay: (n: number) => string;
  formatHopFeeTableUsdAmount: (n: number) => string;
  formatSwapPayUsdAmount: (n: number) => string;
  formatSwapReceiveUsdLabel: (v: unknown) => string | null;
  getQuoteSwapUsdValue: (quote: Record<string, unknown>) => number | null;
  getQuoteReceiveUsd: (quote: Record<string, unknown>) => number | null;
  quoteOutputUiAmount: (quote: Record<string, unknown>) => number | null;
  quoteWalletPayUsd: (quote: Record<string, unknown>) => number | null;
  quoteOutputPriceSourceTitle: (quote: Record<string, unknown>) => string;
  escapeHtml: (s: string) => string;
  truncate: (s: string | undefined, front?: number, back?: number) => string;
  displaySymbol: (sym: string) => string;
  renderLoadingSpinner: (size?: 'sm' | 'md' | 'lg') => string;
  syncRoutePlanStepsUi: () => void;
  getEnumeratedRoutesState: () => EnumeratedRoutesUiState | null;
  setEnumeratedRoutesExpanded: (expanded: boolean) => void;
  selectEnumeratedRoute: (index: number) => void;
  vybeMarketDiscoveryActive: () => boolean;
  swapRouteOptionsPanelActive: () => boolean;
  isSwapQuoteFetching: () => boolean;
  dom: {
    swapRouteOptionsEl: HTMLElement | null;
    swapQuoteDetailsRoutingEl: HTMLElement | null;
    swapQuoteDetailsRouteStepsEl: HTMLElement | null;
    routingDialogBodyEl: HTMLElement | null;
    routingDialogTitleEl: HTMLElement | null;
    swapQuoteRouteSubtitleEl: HTMLElement | null;
  };
}

let deps: RouteUiDeps;

export function initRouteUi(d: RouteUiDeps): void {
  deps = d;
}

export interface EnumeratedRouteUiEntry {
  index: number;
  source?: string;
  candidate?: {
    marketAddress?: string;
    programAddress?: string;
    protocol?: string;
    programLabel?: string;
    tradeCount?: number;
    marketScore?: number;
  };
  quote?: Record<string, unknown>;
}

export interface EnumeratedRoutesUiState {
  routes: EnumeratedRouteUiEntry[];
  selectedIndex: number;
  expanded: boolean;
}

const ROUTE_OPTIONS_UI_INITIAL = 3;

function shortPoolId(address: string | undefined): string {
  const a = (address ?? '').trim();
  if (!a) return '—';
  if (a.length <= 14) return a;
  return `${a.slice(0, 7)}...${a.slice(-7)}`;
}

/** Route-card liquidity USD: integers ≥$1; $0.01–$0.99 with 2 decimals; <$0.01 → 0.01; $0 → 0. */
export function formatLiquidityUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 0.01) return '0.01';
  if (n < 1) {
    const rounded = Math.round(n * 100) / 100;
    if (rounded >= 1) {
      return Math.round(rounded).toLocaleString(undefined, {
        maximumFractionDigits: 0,
        useGrouping: true,
      });
    }
    return rounded.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
    });
  }
  return Math.round(n).toLocaleString(undefined, {
    maximumFractionDigits: 0,
    useGrouping: true,
  });
}

/** Route-card liquidity USD: compact $9.89M / $28K for large values. */
export function formatLiquidityUsdCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    const digits = m >= 10 ? 1 : 2;
    return `$${m.toFixed(digits).replace(/\.0+$/, '')}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    if (k >= 100) return `$${Math.round(k)}K`;
    return `$${k.toFixed(k >= 10 ? 0 : 1)}K`;
  }
  if (n < 0.01) return '$0.01';
  if (n < 1) return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
  return `$${Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatRoutePriceImpact(quote: Record<string, unknown>): string | null {
  const v = quote.priceImpactPct;
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/%$/, '').trim());
  if (!Number.isFinite(n)) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function renderRoutePoolLink(marketAddress: string | undefined): string {
  const raw = (marketAddress ?? '').trim();
  if (!raw) {
    return '<span class="swap-route-option__pool-link swap-route-option__pool-link--empty">—</span>';
  }
  const short = shortPoolId(raw);
  if (!isLikelySolanaPubkey(raw)) {
    return `<span class="swap-route-option__pool-link swap-route-option__pool-link--empty" title="${deps.escapeHtml(raw)}">${deps.escapeHtml(short)}</span>`;
  }
  const url = deps.escapeHtml(solscanAccountUrl(raw));
  return `<a class="swap-route-option__pool-link" href="${url}" target="_blank" rel="noopener noreferrer" data-route-pool-link title="View pool on Solscan — ${deps.escapeHtml(raw)}"><span class="swap-route-option__pool-link-label">${deps.escapeHtml(short)}</span><span class="swap-route-option__pool-link-icon" aria-hidden="true">↗</span></a>`;
}

function renderRouteOptionMetrics(
  quote: Record<string, unknown>,
  outLabel: string,
  marketScore: number | undefined,
): string {
  const liq =
    marketScore != null && marketScore > 0 ? formatLiquidityUsdCompact(marketScore) : '—';
  const impact = formatRoutePriceImpact(quote);
  const receiveUsd = deps.getQuoteReceiveUsd(quote);
  const receiveUsdLabel =
    receiveUsd != null && Number.isFinite(receiveUsd)
      ? `$${receiveUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';
  return `<dl class="swap-route-option__metrics">
      <div class="swap-route-option__metric">
        <dt>Liquidity</dt>
        <dd>${deps.escapeHtml(liq)}</dd>
      </div>
      <div class="swap-route-option__metric swap-route-option__metric--output">
        <dt>Output</dt>
        <dd><span class="swap-route-option__metric-out">${deps.escapeHtml(outLabel)}</span></dd>
      </div>
      <div class="swap-route-option__metric">
        <dt>Impact</dt>
        <dd>${impact != null ? deps.escapeHtml(impact) : '—'}</dd>
      </div>
      <div class="swap-route-option__metric swap-route-option__metric--usd">
        <dt>≈ USD</dt>
        <dd>${deps.escapeHtml(receiveUsdLabel)}</dd>
      </div>
    </dl>`;
}

function sourceBadgeLabel(source: string | undefined): string {
  if (source === 'jupiter') return 'jupiter';
  if (source === 'titan') return 'titan';
  if (source === 'both' || source === 'trades+rpc' || source === 'trades') return 'trades';
  if (source === 'markets+rpc' || source === 'markets') return 'markets';
  if (source === 'rpc') return 'rpc';
  return 'trades';
}

function renderRouteOptionPlaceholderCard(rank: number, active: boolean, loading: boolean): string {
  const spinner = deps.renderLoadingSpinner('sm');
  const programName = loading
    ? `<span class="swap-route-option__loading">${spinner}<span class="swap-route-option__loading-label">Finding pool…</span></span>`
    : '—';
  const outCell = loading ? spinner : '—';
  return `<div class="swap-route-option swap-route-option--loading swap-route-option--disabled${active ? ' swap-route-option--active' : ''}" aria-disabled="true" aria-pressed="${active ? 'true' : 'false'}">
      <div class="swap-route-option__head">
        <span class="swap-route-option__rank">#${rank}</span>
        <span class="swap-route-option__badge swap-route-option__badge--trades">trades</span>
      </div>
      <div class="swap-route-option__title">${programName}</div>
      <span class="swap-route-option__pool-link swap-route-option__pool-link--empty">—</span>
      <dl class="swap-route-option__metrics">
        <div class="swap-route-option__metric"><dt>Liquidity</dt><dd>—</dd></div>
        <div class="swap-route-option__metric swap-route-option__metric--output"><dt>Output</dt><dd>${outCell}</dd></div>
        <div class="swap-route-option__metric"><dt>Impact</dt><dd>—</dd></div>
        <div class="swap-route-option__metric swap-route-option__metric--usd"><dt>≈ USD</dt><dd>—</dd></div>
      </dl>
    </div>`;
}

function renderRouteOptionsPlaceholder(loading = false): string {
  const cards = Array.from({ length: ROUTE_OPTIONS_UI_INITIAL }, (_, i) =>
    renderRouteOptionPlaceholderCard(i + 1, i === 0, loading),
  );
  return `<div class="swap-route-options__grid">${cards.join('')}</div>`;
}

function renderRouteOptionCard(route: EnumeratedRouteUiEntry, selectedIndex: number): string {
  const idx = route.index;
  const active = idx === selectedIndex;
  const quote = route.quote ?? {};
  const outUi = deps.quoteOutputUiAmount(quote);
  const outLabel = outUi != null ? deps.formatSwapAmountValue(outUi) : '—';
  const programLabel =
    route.candidate?.programLabel?.trim() ||
    route.candidate?.protocol?.replace(/_/g, ' ') ||
    '—';
  const marketScore = route.candidate?.marketScore;
  const source = sourceBadgeLabel(route.source);
  const warnLevel = swapRouteWarningLevel(quote, marketScore);
  const warnClass =
    warnLevel === 'red'
      ? ' swap-route-option--warn-severe'
      : warnLevel === 'orange'
        ? ' swap-route-option--warn-caution'
        : '';
  const warnTitle = warnLevel !== 'none' ? combinedRouteWarningTitle(quote, marketScore) : '';
  const warnBadge =
    warnLevel !== 'none'
      ? `<span class="swap-route-option__warn" title="${deps.escapeHtml(warnTitle)}" aria-label="${deps.escapeHtml(warnTitle)}">⚠</span>`
      : '';
  return `<div class="swap-route-option${active ? ' swap-route-option--active' : ''}${warnClass}" data-route-index="${idx}" role="button" tabindex="0" aria-pressed="${active ? 'true' : 'false'}">
      <div class="swap-route-option__head">
        <span class="swap-route-option__rank">#${idx + 1}</span>
        <span class="swap-route-option__head-badges">
          <span class="swap-route-option__badge swap-route-option__badge--${deps.escapeHtml(source.replace(/\+/g, '-'))}">${deps.escapeHtml(source)}</span>
          ${warnBadge}
        </span>
      </div>
      <div class="swap-route-option__title">${deps.escapeHtml(programLabel)}</div>
      ${renderRoutePoolLink(route.candidate?.marketAddress)}
      ${renderRouteOptionMetrics(quote, outLabel, marketScore)}
    </div>`;
}

export function renderRouteOptionsPanel(): void {
  const el = deps.dom.swapRouteOptionsEl;
  if (!el) return;
  const state = deps.getEnumeratedRoutesState();
  if (!state || state.routes.length === 0) {
    if (deps.swapRouteOptionsPanelActive()) {
      el.hidden = false;
      el.innerHTML = renderRouteOptionsPlaceholder(deps.isSwapQuoteFetching());
      return;
    }
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const loading = deps.isSwapQuoteFetching();
  const visibleCount = state.expanded
    ? state.routes.length
    : Math.min(ROUTE_OPTIONS_UI_INITIAL, state.routes.length);
  const hiddenCount = state.routes.length - visibleCount;
  const cards = state.routes.slice(0, visibleCount).map((route) =>
    renderRouteOptionCard(route, state.selectedIndex),
  );
  if (!state.expanded && state.routes.length < ROUTE_OPTIONS_UI_INITIAL) {
    for (let rank = state.routes.length + 1; rank <= ROUTE_OPTIONS_UI_INITIAL; rank++) {
      cards.push(renderRouteOptionPlaceholderCard(rank, false, loading));
    }
  }
  const moreBtn =
    !state.expanded && hiddenCount > 0
      ? `<button type="button" class="swap-route-options__more" data-route-expand="1">Show ${hiddenCount} more route${hiddenCount === 1 ? '' : 's'}</button>`
      : state.expanded && state.routes.length > ROUTE_OPTIONS_UI_INITIAL
        ? `<button type="button" class="swap-route-options__more" data-route-expand="0">Show fewer</button>`
        : '';
  el.innerHTML = `<div class="swap-route-options__grid">${cards.join('')}</div>${moreBtn}`;
  el.querySelectorAll<HTMLElement>('[data-route-index]').forEach((card) => {
    const selectRoute = () => {
      const index = Number(card.dataset.routeIndex);
      if (Number.isFinite(index)) deps.selectEnumeratedRoute(index);
    };
    card.addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-route-pool-link]')) return;
      selectRoute();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectRoute();
      }
    });
  });
  el.querySelectorAll<HTMLAnchorElement>('[data-route-pool-link]').forEach((link) => {
    link.addEventListener('click', (e) => e.stopPropagation());
  });
  const expandBtn = el.querySelector<HTMLButtonElement>('[data-route-expand]');
  expandBtn?.addEventListener('click', () => {
    deps.setEnumeratedRoutesExpanded(expandBtn.dataset.routeExpand === '1');
    renderRouteOptionsPanel();
  });
}

export function clearRouteMintCaches(): void {
  for (const k of Object.keys(routeMintSymbolCache)) delete routeMintSymbolCache[k];
  for (const k of Object.keys(routeMintDecimalsCache)) delete routeMintDecimalsCache[k];
}

export interface VybeSwapInfoLite {
  ammKey?: string;
  label?: string;
  inputMintAddress?: string;
  outputMintAddress?: string;
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  feeAmount?: string;
  feeMintAddress?: string;
}

export interface HopFeeItemLite {
  label: string;
  amountRaw: string;
  mint: string;
  /** Mint of the token account that received rent; fee amount is native SOL. */
  accountMint?: string;
  destinationAddress?: string;
  destinationKind?: 'lp_pool' | 'new_token_account' | 'closed_token_account' | 'fee_recipient' | 'output_deduction' | 'input_wallet' | 'network_priority';
  destinationNote?: string;
  /** USD value of this fee item — provided by ix-builder enrichment (printed, not recomputed). */
  usd?: number;
  /** UI (human) amount = amountRaw / 10^decimals — provided by ix-builder enrichment. */
  ui?: number;
  decimals?: number;
  pdaRent?: {
    label: string;
    amountRaw: string;
    mint: string;
  };
}

export interface HopFeeBreakdownLite {
  items: HopFeeItemLite[];
  totalAmountRaw: string;
  mint: string;
  quotedOutRaw?: string;
  netOutRaw?: string;
}

export interface VybeRoutePlanStepLite {
  percent?: number;
  bps?: number | null;
  swapInfo?: VybeSwapInfoLite;
  _hopFees?: HopFeeBreakdownLite;
  /** Raw ix-builder enrichment field (mapped to `_hopFees` in quote projection). */
  hopFees?: HopFeeBreakdownLite;
  /** Retention/% + USD provided by ix-builder enrichment (printed, not recomputed). */
  _retentionInPct?: number;
  _retentionOutPct?: number;
  _outgoingPct?: number;
  _inUsd?: number;
  _outUsd?: number;
  _netOutRaw?: string | null;
  _grossOutRaw?: string | null;
}
export const ACC_RENT_FEE_LABEL = 'Acc Rent Fee';

/** Token mint for the account that received rent (WSOL, BONK, …). */
function accRentAccountMint(item: Pick<HopFeeItemLite, 'mint' | 'accountMint' | 'destinationKind'>): string {
  const account = item.accountMint?.trim();
  if (account) return isSolMint(account) ? WSOL_MINT : account;
  const legacy = item.mint.trim();
  if (item.destinationKind === 'new_token_account' && isSolMint(legacy)) return WSOL_MINT;
  return legacy;
}

/** Fee table labels: symbols longer than 5 chars show as ABCDE… */
function truncateFeeTableTokenSymbol(sym: string): string {
  const s = sym.trim();
  if (s.length <= 5) return s;
  return `${s.slice(0, 5)}...`;
}

function accRentFeeDisplayLabel(item: Pick<HopFeeItemLite, 'mint' | 'accountMint' | 'destinationKind' | 'label'>): string {
  const accountMint = accRentAccountMint(item);
  const sym = isSolMint(accountMint)
    ? 'WSOL'
    : truncateFeeTableTokenSymbol(mintSymbolSync(accountMint));
  if (item.destinationKind === 'closed_token_account') {
    return `${sym} Rent Reclaim`;
  }
  return `${sym} Rent Fee`;
}

function accRentDestBracketLabel(item: Pick<HopFeeItemLite, 'mint' | 'accountMint' | 'destinationKind'>): string {
  const sym = mintSymbolSync(accRentAccountMint(item));
  return `${sym} Account`;
}
const HARDCODED_MINT_SYMBOLS: Record<string, string> = {
  [NATIVE_SOL_MINT]: 'SOL',
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
};

const HARDCODED_MINT_NAMES: Record<string, string> = {
  [NATIVE_SOL_MINT]: 'Solana',
  So11111111111111111111111111111111111111112: 'Solana',
};

const HARDCODED_MINT_DECIMALS: Record<string, number> = {
  [NATIVE_SOL_MINT]: 9,
  So11111111111111111111111111111111111111112: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,
};

/** Pegged stables — use $1 when Vybe/cache has no spot price (common for USDT). */
const STABLECOIN_USD_FALLBACK_MINTS: ReadonlySet<string> = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
  'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', // USDe
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
]);
const STABLECOIN_USD_FALLBACK_PRICE = 1;
export const routeMintSymbolCache: Record<string, string> = {};
export const routeMintDecimalsCache: Record<string, number> = {};

export interface RouteHopLeg {
  inMint: string;
  outMint: string;
  inSym: string;
  outSym: string;
  inAmt: string;
  outAmt: string;
}

export interface RouteHopMeta {
  step: VybeRoutePlanStepLite;
  planIndex: number;
  label: string;
}

export type RouteNode =
  | { kind: 'empty' }
  | { kind: 'seq'; nodes: RouteNode[] }
  | { kind: 'hop'; meta: RouteHopMeta }
  | { kind: 'fork'; branches: RouteNode[]; depth: number };
export function getQuoteOutputMint(quote: Record<string, unknown>): string {
  return quoteOutputMint(quote);
}

export function swapInfoInputMint(si: VybeSwapInfoLite | undefined): string {
  return String(si?.inputMintAddress ?? si?.inputMint ?? '').trim();
}

export function swapInfoOutputMint(si: VybeSwapInfoLite | undefined): string {
  return String(si?.outputMintAddress ?? si?.outputMint ?? '').trim();
}

export function parseRawAmountDigits(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/,/g, '');
  return /^\d+$/.test(s) ? s : null;
}

export function quoteInAmountRaw(quote: Record<string, unknown>): string | null {
  return parseRawAmountDigits(quote.inAmount);
}

export function quoteInAmountUi(quote: Record<string, unknown>, mint?: string): number | null {
  const raw = quoteInAmountRaw(quote);
  if (!raw) return null;
  const m = mint ?? quoteInputMint(quote);
  if (!m) return null;
  const n = deps.rawAmountToUiNumber(raw, deps.getMintDecimals(m));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function quoteInputMint(quote: Record<string, unknown>): string {
  const fromQuote = String(quote.inputMintAddress ?? quote.inputMint ?? '').trim();
  return fromQuote || deps.getFormInputMint().trim();
}

export function quoteOutputMint(quote: Record<string, unknown>): string {
  const fromQuote = String(quote.outputMintAddress ?? quote.outputMint ?? '').trim();
  return fromQuote || deps.getFormOutputMint().trim();
}

type WalletTokenAccountCloseCategory = 'input' | 'output' | 'wsol' | 'other';

interface WalletTokenAccountCloseEntry {
  mint: string;
  category: WalletTokenAccountCloseCategory;
  accountAddress?: string;
  preBalanceRaw?: string;
  reclaimedLamports?: string;
}

const DEFAULT_TOKEN_ACCOUNT_RENT_LAMPORTS = '2039280';

const WALLET_ATA_CLOSE_CATEGORIES = new Set<WalletTokenAccountCloseCategory>([
  'input',
  'output',
  'wsol',
  'other',
]);

function getQuoteWalletTokenAccountCloses(
  quote: Record<string, unknown>,
): WalletTokenAccountCloseEntry[] {
  const raw = quote._walletTokenAccountCloses;
  if (!Array.isArray(raw)) return [];
  const out: WalletTokenAccountCloseEntry[] = [];
  for (const entry of raw) {
    const row = entry as Record<string, unknown>;
    const mint = String(row.mint ?? '').trim();
    if (!mint) continue;
    const categoryRaw = String(row.category ?? 'other').trim() as WalletTokenAccountCloseCategory;
    const category = WALLET_ATA_CLOSE_CATEGORIES.has(categoryRaw) ? categoryRaw : 'other';
    out.push({
      mint,
      category,
      accountAddress:
        typeof row.accountAddress === 'string' ? row.accountAddress.trim() : undefined,
      preBalanceRaw: typeof row.preBalanceRaw === 'string' ? row.preBalanceRaw : undefined,
      reclaimedLamports:
        typeof row.reclaimedLamports === 'string' && row.reclaimedLamports.trim()
          ? row.reclaimedLamports.trim()
          : DEFAULT_TOKEN_ACCOUNT_RENT_LAMPORTS,
    });
  }
  return out;
}

function closeEntryToReclaimFeeItem(entry: WalletTokenAccountCloseEntry): HopFeeItemLite {
  return {
    label: ACC_RENT_FEE_LABEL,
    amountRaw: entry.reclaimedLamports ?? DEFAULT_TOKEN_ACCOUNT_RENT_LAMPORTS,
    mint: WSOL_MINT,
    accountMint: entry.mint,
    destinationKind: 'closed_token_account',
    destinationNote: 'Rent returned to wallet',
  };
}

function getHopAtaRentReclaimItems(
  quote: Record<string, unknown>,
  planIndex: number,
  isLastHop: boolean,
): HopFeeItemLite[] {
  return getQuoteWalletTokenAccountCloses(quote)
    .filter((c) => (c.category === 'input' ? planIndex === 0 : isLastHop))
    .map(closeEntryToReclaimFeeItem);
}

function hasInputMintRentReclaim(quote: Record<string, unknown>, mint: string): boolean {
  return getQuoteWalletTokenAccountCloses(quote).some(
    (c) => c.category === 'input' && routeLegMintMatches(c.mint, mint),
  );
}

/** Dedupe synthetic ATA-close rows when ix-builder already lists them in hopFees.items. */
function dedupeSyntheticReclaimItems(
  hopFeeItems: HopFeeItemLite[],
  syntheticReclaimItems: HopFeeItemLite[],
): HopFeeItemLite[] {
  if (syntheticReclaimItems.length === 0) return syntheticReclaimItems;
  const coveredAccountMints = new Set(
    hopFeeItems.filter(isAccRentReclaimItem).map((item) => accRentAccountMint(item)),
  );
  if (coveredAccountMints.size === 0) return syntheticReclaimItems;
  return syntheticReclaimItems.filter(
    (item) => !coveredAccountMints.has(accRentAccountMint(item)),
  );
}

/** USD value of input ATA rent returned to wallet (WSOL) on full-balance sells. */
function sumInputQuoteRentReclaimUsd(quote: Record<string, unknown>): number {
  const fromCloses = sumRentReclaimUsd(
    getQuoteWalletTokenAccountCloses(quote)
      .filter((c) => c.category === 'input')
      .map(closeEntryToReclaimFeeItem),
    quote,
  );
  if (fromCloses > 0) return fromCloses;

  const enriched = quote._youReceive as { reclaimUsd?: number } | undefined;
  const reclaimUsd = enriched?.reclaimUsd;
  if (typeof reclaimUsd === 'number' && Number.isFinite(reclaimUsd) && reclaimUsd > 0) {
    return reclaimUsd;
  }
  return 0;
}

function quoteHasAtaRentReclaim(quote: Record<string, unknown>): boolean {
  return getQuoteWalletTokenAccountCloses(quote).length > 0;
}

export function quoteUiAmount(quote: Record<string, unknown>, field: 'out' | 'min'): unknown {
  if (field === 'out') return quote.outAmountUi ?? quote.outAmountUI;
  return quote.otherAmountThresholdUi ?? quote.otherAmountThresholdUI;
}

/** Format quote out/min amounts — prefer raw on-chain integer + mint decimals (matches route hops). */
export function formatQuoteTokenAmount(
  quote: Record<string, unknown>,
  field: 'out' | 'min',
): { display: string; full: string } {
  const mint = getQuoteOutputMint(quote);
  const rawKey = field === 'out' ? 'outAmount' : 'otherAmountThreshold';
  let raw = quote[rawKey];
  if (field === 'out') {
    const sim = quote._simulatedOutAmount;
    if (sim != null && sim !== '') raw = sim;
  }
  if (raw != null && raw !== '') {
    const digits = String(raw).replace(/,/g, '');
    if (/^\d+$/.test(digits)) return deps.formatRawTokenAmount(digits, mint);
  }
  const ui = quoteUiAmount(quote, field);
  if (typeof ui === 'number' && Number.isFinite(ui)) return deps.formatSwapAmount(ui);
  if (ui != null && ui !== '') return deps.formatSwapAmount(ui);
  return { display: '—', full: '' };
}
/** Fees that belong in the hop table SOL/wallet column total (excludes output-side deductions). */
function isHopFeeTableWalletColumnItem(
  item: HopFeeItemLite,
  inputMint: string,
  quote?: Record<string, unknown>,
): boolean {
  if (isAccRentWalletFeeItem(item)) {
    return isSolMint(item.mint);
  }
  if (quote && isWalletCostFeeItem(item, quote) && isForeignFeeMint(item.mint, quote)) {
    return true;
  }
  const kind = item.destinationKind;
  if (kind === 'lp_pool' || kind === 'output_deduction') return false;
  if (
    kind === 'fee_recipient' ||
    kind === 'input_wallet' ||
    kind === 'new_token_account' ||
    kind === 'network_priority'
  ) {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint;
  }
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  if (label === 'pool fee') return false;
  if (
    label === 'protocol fee' ||
    label === 'route fee' ||
    label === 'priority fee' ||
    label === 'creator fee'
  ) {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint;
  }
  return false;
}

function isWalletDebitedFeeItem(item: HopFeeItemLite, inputMint: string): boolean {
  return isWalletCostFeeItem(item, { inputMintAddress: inputMint } as Record<string, unknown>);
}

/** Hop fees actually debited from the wallet (matches Phantom), not output-side pool/route cuts. */
function walletCostFeeToSellMintUi(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
): number | null {
  const sellMint = quoteInputMint(quote);
  if (!sellMint) return null;
  const feeUi = feeAmountToUi(item.amountRaw, item.mint);
  if (feeUi == null || feeUi <= 0) return null;
  if (routeLegMintMatches(item.mint, sellMint)) return feeUi;
  if (isForeignFeeMint(item.mint, quote)) {
    const usd = computeFeeUsdNumeric(item, quote);
    const sellPrice = lookupMintPriceUsd(sellMint, quote);
    if (usd != null && Number.isFinite(sellPrice) && sellPrice > 0) {
      return usd / sellPrice;
    }
    return null;
  }
  return convertFeeUiToSellLeg(feeUi, item.mint, quote);
}

function countInputSideWalletFeeItems(quote: Record<string, unknown>): number {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  let count = 0;
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      if (isAccRentWalletFeeItem(item)) continue;
      const sellUi = walletCostFeeToSellMintUi(item, quote);
      if (sellUi != null && sellUi > 0) count += 1;
    }
  }
  return count;
}

export function sumInputSideWalletFeesInSellMintUi(quote: Record<string, unknown>): number | null {
  const sellMint = quoteInputMint(quote);
  if (!sellMint) return null;
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  let total = 0;
  let found = false;
  for (const step of plan) {
    const fees = getHopFeeBreakdown(step);
    for (const item of fees?.items ?? []) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      /* Acc rent is shown in its own rent row(s) — never fold into sell-mint fee. */
      if (isAccRentWalletFeeItem(item)) continue;
      const sellUi = walletCostFeeToSellMintUi(item, quote);
      if (sellUi != null && sellUi > 0) {
        total += sellUi;
        found = true;
      }
    }
  }
  return found && total > 0 ? total : null;
}

export function estimateInputSideWalletPayDebitFromQuote(quote: Record<string, unknown>): string | null {
  const inRaw = quoteInAmountRaw(quote);
  if (!inRaw) return null;
  const inputMint = quoteInputMint(quote);
  if (!inputMint) return null;
  let total: bigint;
  try {
    total = BigInt(inRaw);
  } catch {
    return null;
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    for (const item of step._hopFees?.items ?? []) {
      if (!isWalletDebitedFeeItem(item, inputMint)) continue;
      if (!item.amountRaw || item.amountRaw === '0') continue;
      try {
        if (isAccRentWalletFeeItem(item) && isSolMint(item.mint) && !isSolMint(inputMint)) {
          /* SPL sell: SOL acc rent tracked in USD for badges, not added to sell raw debit. */
        } else if (isSolMint(inputMint) && isSolMint(item.mint)) total += BigInt(item.amountRaw);
        else if (item.mint === inputMint) total += BigInt(item.amountRaw);
      } catch {
        /* skip */
      }
    }
  }

  try {
    return total > BigInt(inRaw) ? total.toString() : null;
  } catch {
    return null;
  }
}

export function quoteWalletPayRaw(quote: Record<string, unknown>): string | null {
  return resolveWalletPayDebitRaw(quote);
}

export function quoteWalletPayUi(quote: Record<string, unknown>, mint?: string): number | null {
  const raw = quoteWalletPayRaw(quote);
  if (!raw) return null;
  const m = mint ?? quoteInputMint(quote);
  if (!m) return null;
  const n = deps.rawAmountToUiNumber(raw, deps.getMintDecimals(m));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatQuoteRawAmountLabel(
  raw: string | null | undefined,
  mint: string | null | undefined,
): string | null {
  if (!raw || !mint) return null;
  const fmt = deps.formatRawTokenAmount(raw, mint);
  return fmt.display !== '—' ? fmt.display : null;
}

export function getQuoteSwapLegLabelFromQuote(quote: Record<string, unknown>): string {
  const mint = quoteInputMint(quote);
  const fromRaw = formatQuoteRawAmountLabel(quoteInAmountRaw(quote), mint);
  if (fromRaw) return fromRaw;
  return getQuoteWalletPayLabelFromQuote(quote);
}

export function getQuoteWalletPayLabelFromQuote(quote: Record<string, unknown>): string {
  const mint = quoteInputMint(quote);
  const fromWalletPay = formatQuoteRawAmountLabel(quoteWalletPayRaw(quote), mint);
  if (fromWalletPay) return fromWalletPay;
  const fromSwapLeg = formatQuoteRawAmountLabel(quoteInAmountRaw(quote), mint);
  if (fromSwapLeg) return fromSwapLeg;
  return '—';
}
function routeOutputMintSymbol(mint: string | undefined): string {
  return mintSymbolSync(mint);
}

export function mintSymbolSync(mint: string | undefined): string {
  const m = (mint ?? '').trim();
  if (!m) return '—';
  const hard = HARDCODED_MINT_SYMBOLS[m];
  if (hard) return hard;
  const cached = routeMintSymbolCache[m];
  if (cached) return cached;
  return deps.truncate(m, 4, 4);
}

function resolveRouteHopLegs(plan: VybeRoutePlanStepLite[], quote: Record<string, unknown>): RouteHopLeg[] {
  const quoteInMint = quoteInputMint(quote);
  const quoteOutMint = quoteOutputMint(quote);

  return plan.map((step, idx) => {
    const si = step.swapInfo;
    let inMint = swapInfoInputMint(si);
    if (!inMint) {
      inMint =
        idx === 0 ? quoteInMint : swapInfoOutputMint(plan[idx - 1]?.swapInfo) || quoteInMint;
    }

    let outMint = swapInfoOutputMint(si);
    if (!outMint) {
      if (idx === plan.length - 1) outMint = quoteOutMint;
      else outMint = swapInfoInputMint(plan[idx + 1]?.swapInfo) || quoteOutMint;
    }

    const inAmt = si?.inAmount ? deps.formatRawTokenAmount(si.inAmount, inMint).display : '—';
    let outAmt = si?.outAmount ? deps.formatRawTokenAmount(si.outAmount, outMint).display : '—';
    if (idx === plan.length - 1) {
      outAmt = formatQuoteTokenAmount(quote, 'out').display;
    }

    return {
      inMint,
      outMint,
      inSym: mintSymbolSync(inMint),
      outSym: mintSymbolSync(outMint),
      inAmt,
      outAmt,
    };
  });
}

function formatHopPctLabel(pct: number): string {
  if (!Number.isFinite(pct)) return '—';
  const rounded = Math.round(pct * 100) / 100;
  if (Number.isInteger(rounded)) {
    return `${rounded}%`;
  }
  return `${rounded.toFixed(2)}%`;
}

function hopPercentLabel(step: VybeRoutePlanStepLite): string {
  if (step.percent == null || !Number.isFinite(step.percent)) return '—';
  return formatHopPctLabel(step.percent);
}

export function parsePositiveBigInt(raw: string | undefined | null): bigint | null {
  if (raw == null || raw === '') return null;
  const digits = String(raw).replace(/,/g, '').trim();
  if (!/^\d+$/.test(digits)) return null;
  try {
    const v = BigInt(digits);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Sum output-side hop fees expressed in the hop output mint's raw units. */
function sumHopFeeDeductionInOutputRaw(
  hopFees: HopFeeBreakdownLite,
  outMint: string,
  inRaw: bigint | null,
  quotedOutRaw: bigint,
  inputMint: string,
  quote: Record<string, unknown>,
): bigint {
  let total = 0n;
  for (const item of flattenHopFeeItems(hopFees.items)) {
    if (isAccRentFeeLabel(item.label)) continue;
    if (isWalletCostFeeItem(item, quote)) continue;
    if (isInputSideWalletFeeItem(item, inputMint)) continue;
    if (!isOutputSideFeeDisplayItem(item) && !isDeductedFromPoolFeeItem(item, quote, outMint)) {
      continue;
    }

    const amt = parsePositiveBigInt(item.amountRaw);
    if (!amt) continue;

    if (routeLegMintMatches(item.mint, outMint)) {
      total += amt;
      continue;
    }

    const feeUi = feeAmountToUi(item.amountRaw, item.mint);
    const feePrice = lookupMintPriceUsd(item.mint, quote);
    const outPrice = lookupMintPriceUsd(outMint, quote);
    if (
      feeUi != null &&
      Number.isFinite(feePrice) &&
      feePrice > 0 &&
      Number.isFinite(outPrice) &&
      outPrice > 0
    ) {
      const outUi = (feeUi * feePrice) / outPrice;
      const outRawNum = Math.round(outUi * 10 ** deps.getMintDecimals(outMint));
      if (Number.isFinite(outRawNum) && outRawNum > 0) {
        try {
          total += BigInt(outRawNum);
        } catch {
          /* skip overflow */
        }
      }
      continue;
    }

    if (inRaw && inRaw > 0n && quotedOutRaw > 0n && routeLegMintMatches(item.mint, inputMint)) {
      total += (amt * quotedOutRaw) / inRaw;
    }
  }
  return total;
}

/** Scale quoted output to total wallet pay (swap leg → full debit). */
function scaleQuotedRawToWalletPay(quotedRaw: bigint, quote: Record<string, unknown>): bigint {
  const payRaw = quoteWalletPayRaw(quote);
  const swapRaw = quoteInAmountRaw(quote);
  if (!payRaw || !swapRaw) return quotedRaw;
  try {
    const pay = BigInt(payRaw);
    const swap = BigInt(swapRaw);
    if (pay > swap && swap > 0n) return (quotedRaw * pay) / swap;
  } catch {
    /* keep quotedRaw */
  }
  return quotedRaw;
}

/** USD value of hop net output; recurses through downstream hops when intermediate mint has no price. */
function hopNetOutputUsdEstimate(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  netRaw: bigint,
  outMint: string,
  planIndex: number,
  isLastHop: boolean,
): number | null {
  if (isLastHop) return deps.getQuoteReceiveUsd(quote);

  const netUi = deps.rawAmountToUiNumber(String(netRaw), deps.getMintDecimals(outMint));
  if (!(netUi > 0)) return null;

  const price = lookupMintPriceUsd(outMint, quote);
  if (Number.isFinite(price) && price > 0) return netUi * price;

  if (STABLECOIN_USD_FALLBACK_MINTS.has(outMint.trim())) {
    return netUi * STABLECOIN_USD_FALLBACK_PRICE;
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const nextStep = plan[planIndex + 1];
  const nextSi = nextStep?.swapInfo;
  if (!nextStep || !nextSi) return null;

  const nextInRaw = parsePositiveBigInt(nextSi.inAmount);
  const nextOutRaw = parsePositiveBigInt(nextSi.outAmount);
  const nextOutMint = (nextSi.outputMintAddress ?? '').trim();
  if (!nextInRaw || !nextOutRaw || !nextOutMint || nextInRaw === 0n) return null;

  const share = Number(netRaw) / Number(nextInRaw);
  if (!(share > 0) || !Number.isFinite(share)) return null;

  const nextIsLast = planIndex + 1 === plan.length - 1;
  const nextAmounts = resolveHopOutAmounts(nextStep, quote, nextIsLast);
  const nextNetRaw = nextAmounts?.netRaw ?? nextOutRaw;
  const nextHopOutUsd = hopNetOutputUsdEstimate(
    nextStep,
    quote,
    nextNetRaw,
    nextOutMint,
    planIndex + 1,
    nextIsLast,
  );
  if (nextHopOutUsd == null || !(nextHopOutUsd > 0)) return null;

  return nextHopOutUsd * share;
}

/** Sum wallet-debited fee USD on hops 0..throughPlanIndex (protocol, route, acc rent). */
function sumWalletDebitedFeesUsdThroughHop(
  quote: Record<string, unknown>,
  throughPlanIndex: number,
): number {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];

  let total = 0;
  for (let i = 0; i <= throughPlanIndex && i < plan.length; i++) {
    for (const item of getHopFeeDisplayItems(plan[i]!)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      const usd = computeFeeUsdNumeric(item, quote);
      if (usd != null && usd > 0) total += usd;
    }
  }
  return total;
}

/** Wallet-cost fee USD on one hop — same items as the diagram fee branch + acc rent above. */
function sumWalletCostFeesUsdOnStep(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
): number {
  let total = 0;
  for (const item of getHopFeeDisplayItems(step)) {
    if (!isWalletCostFeeItem(item, quote) && !isAccRentWalletFeeItem(item)) continue;
    const usd = computeFeeUsdNumeric(item, quote);
    if (usd != null && usd > 0) total += usd;
  }
  return total;
}

/** Per-hop retention multiplier (output-side + wallet fees shown on this hop). */
function computeHopStepRetentionFactor(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  planIndex: number,
  isLastHop: boolean,
): number {
  let factor = hopLocalOutRetentionFactor(step, quote, isLastHop) ?? 1;

  const hopWalletUsd = sumWalletCostFeesUsdOnStep(step, quote);
  if (hopWalletUsd > 0) {
    const payAfter = getQuoteTotalWalletPayUsd(quote, planIndex);
    const payBefore =
      planIndex > 0
        ? getQuoteTotalWalletPayUsd(quote, planIndex - 1)
        : deps.getQuoteSwapUsdValue(quote);

    if (payAfter != null && payBefore != null && payAfter > payBefore + 1e-9) {
      factor *= payBefore / payAfter;
    } else {
      const payBasis = payAfter ?? payBefore ?? deps.getQuoteSwapUsdValue(quote);
      if (payBasis != null && payBasis > 0) {
        factor *= Math.max(0, 1 - hopWalletUsd / payBasis);
      }
    }
  }

  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(factor, 1);
}

/** Cumulative wallet % retained through planIndex using per-hop step factors. */
function computeRunningRetentionPctThroughHop(
  quote: Record<string, unknown>,
  throughPlanIndex: number,
): number {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  if (throughPlanIndex < 0 || throughPlanIndex >= plan.length) return 100;

  // ix-builder enrichment carries the authoritative retention % — print it, don't recompute.
  const enrichedOut = plan[throughPlanIndex]?._retentionOutPct;
  if (typeof enrichedOut === 'number' && Number.isFinite(enrichedOut)) return enrichedOut;

  let running = 100;
  for (let i = 0; i <= throughPlanIndex; i++) {
    running *= computeHopStepRetentionFactor(plan[i]!, quote, i, i === plan.length - 1);
  }
  return running;
}

function resolveHopRetentionPctTitle(
  quote: Record<string, unknown>,
  planIndex: number,
  step: VybeRoutePlanStepLite,
  isLastHop: boolean,
): string | null {
  if (isLastHop) return computeFinalReceivePctBreakdown(quote)?.title ?? null;
  return computeIntermediateHopReceivePctBreakdown(quote, planIndex, step)?.title ?? null;
}

/** Shared in/out % for route diagram links and hop plan step headers. */
function resolveHopRetentionPctsAtHop(
  quote: Record<string, unknown>,
  planIndex: number,
  step: VybeRoutePlanStepLite,
  isLastHop: boolean,
): { inPct: number; outPct: number; outTitle: string | null } {
  const outTitle = resolveHopRetentionPctTitle(quote, planIndex, step, isLastHop);

  // ix-builder enrichment provides the in/out retention % directly — print, don't recompute.
  const enrichedIn = step._retentionInPct;
  const enrichedOut = step._retentionOutPct;
  if (
    typeof enrichedIn === 'number' &&
    Number.isFinite(enrichedIn) &&
    typeof enrichedOut === 'number' &&
    Number.isFinite(enrichedOut)
  ) {
    return {
      inPct: enrichedIn,
      outPct: enrichedOut,
      outTitle,
    };
  }

  const inPct =
    planIndex > 0 ? computeRunningRetentionPctThroughHop(quote, planIndex - 1) : 100;
  const stepFactor = computeHopStepRetentionFactor(step, quote, planIndex, isLastHop);
  let outPct = inPct * stepFactor;
  if (outPct > inPct + 0.001) outPct = inPct;
  return { inPct, outPct, outTitle };
}

/** Swap leg USD plus wallet-debited fees charged through the given hop index. */
function quoteCumulativeWalletPayUsd(
  quote: Record<string, unknown>,
  throughPlanIndex: number,
): number | null {
  const swapUsd = deps.getQuoteSwapUsdValue(quote);
  if (swapUsd == null) return null;
  return swapUsd + sumWalletDebitedFeesUsdThroughHop(quote, throughPlanIndex);
}

/**
 * Total wallet pay USD — Phantom-style sum across all debited mints:
 * input-mint wallet debit (swap + same-mint fees via `_walletPayDebitRaw`) plus
 * every foreign-mint wallet cost (SOL acc rent, SOL priority, etc.) in USD.
 * Matches Jupiter/Titan badge math; `swapUsd + hop fees` alone misses input-mint
 * debits already captured in wallet pay raw and can double-count on aggregators.
 */
function getQuoteTotalWalletPayUsd(
  quote: Record<string, unknown>,
  throughPlanIndex?: number,
): number | null {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastIdx = Math.max(0, plan.length - 1);
  const throughIdx = throughPlanIndex ?? lastIdx;
  const throughFinalScope = throughIdx >= lastIdx;

  if (throughFinalScope) {
    const inputPayUsd = deps.quoteWalletPayUsd(quote);
    const foreignFeesUsd = sumWalletFeesUsdMissingFromRawDebit(quote);
    const fromAllDebitedMints =
      inputPayUsd != null ? inputPayUsd + foreignFeesUsd : null;
    const fromSwapPlusHopFees = quoteCumulativeWalletPayUsd(quote, throughIdx);
    if (fromAllDebitedMints != null && fromSwapPlusHopFees != null) {
      return Math.max(fromAllDebitedMints, fromSwapPlusHopFees);
    }
    return fromAllDebitedMints ?? fromSwapPlusHopFees;
  }

  return quoteCumulativeWalletPayUsd(quote, throughIdx);
}

/** USD of wallet-cost fees the estimated raw debit cannot capture (foreign-mint fees, SPL-sell SOL rent). */
function sumWalletFeesUsdMissingFromRawDebit(quote: Record<string, unknown>): number {
  const inputMint = quoteInputMint(quote);
  if (!inputMint) return 0;
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  let total = 0;
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      if (routeLegMintMatches(item.mint, inputMint)) continue; /* already in raw debit */
      const usd = computeFeeUsdNumeric(item, quote);
      if (usd != null && usd > 0) total += usd;
    }
  }
  return total;
}

/**
 * Wallet pay USD for badge math — swap leg USD plus every wallet-cost hop fee
 * (protocol, route, priority, acc rent, etc.) priced from the same hop items
 * as the route diagram. Prefer this over raw-debit scaling alone: Vybe and
 * aggregator quotes often omit foreign-mint debits (e.g. SOL rent on a USDC
 * sell) from `_walletPayDebitRaw`.
 */
function quoteWalletPayUsdForBadges(quote: Record<string, unknown>): number | null {
  return getQuoteTotalWalletPayUsd(quote);
}

export interface QuoteWalletCostBucketsUsd {
  /** Wallet-paid fees excluding rent (protocol / route / pool / priority). */
  feeUsd: number | null;
  /** Token account rent deposits paid from the wallet. */
  rentUsd: number | null;
}

/** Phantom-style wallet cost buckets, from the same per-hop items as the fee breakdown. */
export function getQuoteWalletCostBucketsUsd(
  quote: Record<string, unknown>,
): QuoteWalletCostBucketsUsd {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  let feeUsd = 0;
  let rentUsd = 0;
  let foundFee = false;
  let foundRent = false;
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      const usd = computeFeeUsdNumeric(item, quote);
      if (usd == null || usd <= 0) continue;
      if (isAccRentWalletFeeItem(item)) {
        const sellMint = quoteInputMint(quote);
        if (sellMint && routeLegMintMatches(item.mint, sellMint) && hasInputMintRentReclaim(quote, sellMint)) {
          continue;
        }
        rentUsd += usd;
        foundRent = true;
      } else {
        feeUsd += usd;
        foundFee = true;
      }
    }
  }
  return {
    feeUsd: foundFee ? feeUsd : null,
    rentUsd: foundRent ? rentUsd : null,
  };
}

export interface QuoteYouPayUsdBreakdown {
  swapUsd: number;
  feeUsd: number | null;
  rentUsd: number | null;
  totalUsd: number;
}

function resolveQuoteYouPayFeeUsd(
  quote: Record<string, unknown>,
  buckets: QuoteWalletCostBucketsUsd,
): number | null {
  if (buckets.feeUsd != null && buckets.feeUsd > 0) return buckets.feeUsd;

  const mint = quoteInputMint(quote);
  if (mint && hasInputMintRentReclaim(quote, mint)) return null;

  const payRaw = quoteWalletPayRaw(quote);
  const swapRaw = quoteInAmountRaw(quote);
  if (payRaw && swapRaw && mint) {
    try {
      const pay = BigInt(payRaw);
      const swap = BigInt(swapRaw);
      if (pay > swap) {
        const feeUi = deps.rawAmountToUiNumber((pay - swap).toString(), deps.getMintDecimals(mint));
        const price = lookupMintPriceUsd(mint, quote);
        if (Number.isFinite(feeUi) && feeUi > 0 && Number.isFinite(price) && price > 0) {
          return feeUi * price;
        }
      }
    } catch {
      /* fall through */
    }
  }

  const routeFeeUi = sumInputSideWalletFeesInSellMintUi(quote);
  if (routeFeeUi != null && mint) {
    const price = lookupMintPriceUsd(mint, quote);
    if (Number.isFinite(price) && price > 0) return routeFeeUi * price;
  }
  return null;
}

/** Phantom-style total pay: swap leg USD + wallet fee USD + acc rent USD (matches You pay sub-label). */
export function resolveQuoteYouPayUsd(quote: Record<string, unknown>): QuoteYouPayUsdBreakdown | null {
  // ix-builder enrichment is authoritative — print it instead of recomputing client-side.
  const enriched = quote._youPay as
    | { swapUsd?: number; feeUsd?: number; rentUsd?: number; totalUsd?: number }
    | undefined;
  if (enriched && typeof enriched === 'object' && Number(enriched.totalUsd) > 0) {
    const buckets = getQuoteWalletCostBucketsUsd(quote);
    let feeUsd = Number(enriched.feeUsd ?? 0);
    const rentUsd = Number(enriched.rentUsd ?? 0);
    const reconciledFeeUsd = resolveQuoteYouPayFeeUsd(quote, buckets);
    // ix-builder residual feeUsd can underflow to ~0 while hop items / pay debit show real fees.
    if (
      reconciledFeeUsd != null &&
      (feeUsd < 1e-6 || reconciledFeeUsd > feeUsd + 1e-6)
    ) {
      feeUsd = reconciledFeeUsd;
    }
    return {
      swapUsd: Number(enriched.swapUsd ?? 0),
      feeUsd: feeUsd > 0 ? feeUsd : reconciledFeeUsd,
      rentUsd: rentUsd > 0 ? rentUsd : null,
      totalUsd: Number(enriched.totalUsd),
    };
  }

  const swapUsd = deps.getQuoteSwapUsdValue(quote);
  if (swapUsd == null || swapUsd <= 0) return null;

  const stack = getQuotePayHeroCostStack(quote, deps.getSwapInSym());
  let feeUsd = 0;
  let rentUsd = 0;
  let hasFee = false;
  let hasRent = false;
  for (const row of stack) {
    const price = lookupMintPriceUsd(row.mint, quote);
    if (!Number.isFinite(price) || price <= 0) continue;
    const usd = row.ui * price;
    if (row.kind === 'fee') {
      feeUsd += usd;
      hasFee = true;
    } else {
      rentUsd += usd;
      hasRent = true;
    }
  }
  const totalUsd = swapUsd + (hasFee ? feeUsd : 0) + (hasRent ? rentUsd : 0);
  return {
    swapUsd,
    feeUsd: hasFee ? feeUsd : null,
    rentUsd: hasRent ? rentUsd : null,
    totalUsd,
  };
}

/** Plain-text You pay hero sub-label, e.g. `≈ $1.24 (includes 2 fees paid)`. */
export function getQuoteYouPaySubLabel(quote: Record<string, unknown>): string | null {
  return formatQuoteYouPayUsdSubLabel(quote);
}

export interface FinalReceivePctBreakdown {
  pct: number;
  pctLabel: string;
  title: string;
}

/**
 * Final output badge: USD received ÷ total USD paid (swap + fee + rent — the
 * same debits Phantom lists), with a hover tooltip showing the division.
 */
export function computeFinalReceivePctBreakdown(
  quote: Record<string, unknown>,
): FinalReceivePctBreakdown | null {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastStep = plan.length > 0 ? plan[plan.length - 1] : undefined;
  const enrichedFinalOut = lastStep?._retentionOutPct;
  if (typeof enrichedFinalOut === 'number' && Number.isFinite(enrichedFinalOut) && enrichedFinalOut > 0) {
    const pct = Math.min(enrichedFinalOut, 100);
    const pctLabel = formatHopPctLabel(pct);
    const youPay = resolveQuoteYouPayUsd(quote);
    const payParts =
      youPay != null
        ? [
            `$${deps.formatSwapPayUsdAmount(youPay.swapUsd)} swap`,
            ...(youPay.feeUsd != null && youPay.feeUsd > 0
              ? [`$${deps.formatSwapPayUsdAmount(youPay.feeUsd)} fee`]
              : []),
            ...(youPay.rentUsd != null && youPay.rentUsd > 0
              ? [`$${deps.formatSwapPayUsdAmount(youPay.rentUsd)} rent`]
              : []),
          ]
        : [];
    const breakdown = payParts.length > 1 ? ` (${payParts.join(' + ')})` : '';
    const title =
      `Cumulative value retained through route${breakdown} = ${pctLabel}`;
    return { pct, pctLabel, title };
  }

  // Fallback when enrichment retention is absent (degraded quote).
  const enrichedReceive = quote._youReceive as { netUsd?: number } | undefined;
  const outUsd =
    enrichedReceive && Number(enrichedReceive.netUsd) > 0
      ? Number(enrichedReceive.netUsd)
      : deps.getQuoteReceiveUsd(quote);
  if (outUsd == null || outUsd <= 0) return null;

  const youPay = resolveQuoteYouPayUsd(quote);
  if (youPay == null || youPay.totalUsd <= 0) return null;

  const payUsd = youPay.totalUsd;
  const payParts = [`$${deps.formatSwapPayUsdAmount(youPay.swapUsd)} swap`];
  if (youPay.feeUsd != null && youPay.feeUsd > 0) {
    payParts.push(`$${deps.formatSwapPayUsdAmount(youPay.feeUsd)} fee`);
  }
  if (youPay.rentUsd != null && youPay.rentUsd > 0) {
    payParts.push(`$${deps.formatSwapPayUsdAmount(youPay.rentUsd)} rent`);
  }

  const pctRaw = (outUsd / payUsd) * 100;
  if (!Number.isFinite(pctRaw) || pctRaw <= 0) return null;
  const pct = Math.min(pctRaw, 100);

  const pctLabel = formatHopPctLabel(pct);
  const breakdown =
    payParts.length > 1 ? ` (${payParts.join(' + ')})` : '';
  const title =
    `You receive ≈ $${deps.formatSwapPayUsdAmount(outUsd)} ÷ ` +
    `you pay ≈ $${deps.formatSwapPayUsdAmount(payUsd)}${breakdown} = ${pctLabel}`;

  return { pct, pctLabel, title };
}

/** Wallet-cost fee/rent USD debited on hops 0..throughPlanIndex only. */
function getQuoteWalletCostBucketsUsdThroughHop(
  quote: Record<string, unknown>,
  throughPlanIndex: number,
): QuoteWalletCostBucketsUsd {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  let feeUsd = 0;
  let rentUsd = 0;
  let foundFee = false;
  let foundRent = false;
  for (let i = 0; i <= throughPlanIndex && i < plan.length; i++) {
    for (const item of getHopFeeDisplayItems(plan[i]!)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      const usd = computeFeeUsdNumeric(item, quote);
      if (usd == null || usd <= 0) continue;
      if (isAccRentWalletFeeItem(item)) {
        rentUsd += usd;
        foundRent = true;
      } else {
        feeUsd += usd;
        foundFee = true;
      }
    }
  }
  return {
    feeUsd: foundFee ? feeUsd : null,
    rentUsd: foundRent ? rentUsd : null,
  };
}

/** USD value of this hop's net output mint — not downstream final receive. */
function hopImmediateNetOutputUsd(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  isLastHop: boolean,
): number | null {
  const amounts = resolveHopOutAmounts(step, quote, isLastHop);
  if (!amounts) return null;
  const { netRaw, outMint } = amounts;
  const netUi = deps.rawAmountToUiNumber(String(netRaw), deps.getMintDecimals(outMint));
  if (!(netUi > 0)) return null;

  const price = lookupMintPriceUsd(outMint, quote);
  if (Number.isFinite(price) && price > 0) return netUi * price;
  if (STABLECOIN_USD_FALLBACK_MINTS.has(outMint.trim())) {
    return netUi * STABLECOIN_USD_FALLBACK_PRICE;
  }
  return null;
}

/**
 * Intermediate hop badge: this hop's net output USD ÷ wallet pay USD through
 * this hop only (swap + fees/rent charged so far — not later-hop rent).
 */
function computeIntermediateHopReceivePctBreakdown(
  quote: Record<string, unknown>,
  planIndex: number,
  step: VybeRoutePlanStepLite,
): FinalReceivePctBreakdown | null {
  const outUsd = hopImmediateNetOutputUsd(step, quote, false);
  if (outUsd == null || outUsd <= 0) return null;

  const swapUsd = deps.getQuoteSwapUsdValue(quote);
  if (swapUsd == null || swapUsd <= 0) return null;

  const buckets = getQuoteWalletCostBucketsUsdThroughHop(quote, planIndex);
  const payUsd = getQuoteTotalWalletPayUsd(quote, planIndex);
  if (payUsd == null || payUsd <= 0 || outUsd >= payUsd) return null;

  const pct = (outUsd / payUsd) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;

  const pctLabel = formatHopPctLabel(pct);
  const payParts = [`$${deps.formatSwapPayUsdAmount(swapUsd)} swap`];
  if (buckets.feeUsd != null) payParts.push(`$${deps.formatSwapPayUsdAmount(buckets.feeUsd)} fee`);
  if (buckets.rentUsd != null) payParts.push(`$${deps.formatSwapPayUsdAmount(buckets.rentUsd)} rent`);
  const breakdown = payParts.length > 1 ? ` (${payParts.join(' + ')})` : '';
  const title =
    `After hop ${planIndex + 1}: ≈ $${deps.formatSwapPayUsdAmount(outUsd)} ÷ ` +
    `you pay ≈ $${deps.formatSwapPayUsdAmount(payUsd)}${breakdown} = ${pctLabel}`;

  return { pct, pctLabel, title };
}

interface HopOutAmounts {
  netRaw: bigint;
  quotedRaw: bigint;
  grossRaw: bigint;
  outMint: string;
}

/** Resolve hop gross/net output raw amounts (shared by badge % and USD estimates). */
function resolveHopOutAmounts(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  isLastHop: boolean,
): HopOutAmounts | null {
  const si = step.swapInfo;
  const hopFees = getHopFeeBreakdown(step);
  const outMint = si?.outputMintAddress ?? quoteOutputMint(quote);
  const inputMint = si?.inputMintAddress ?? quoteInputMint(quote);

  const quotedRaw =
    parsePositiveBigInt(hopFees?.quotedOutRaw) ??
    parsePositiveBigInt(si?.outAmount) ??
    (isLastHop ? parsePositiveBigInt(String(quote._quotedOutAmount ?? '')) : null);
  if (!quotedRaw || !outMint) return null;

  const inRaw =
    parsePositiveBigInt(si?.inAmount) ??
    (isLastHop ? parsePositiveBigInt(String(quote.inAmount ?? '')) : null);

  const feeDeductionOut =
    hopFees?.items.length && outMint
      ? sumHopFeeDeductionInOutputRaw(hopFees, outMint, inRaw, quotedRaw, inputMint ?? '', quote)
      : 0n;

  const derivedNetFromFees =
    feeDeductionOut > 0n && quotedRaw > feeDeductionOut ? quotedRaw - feeDeductionOut : null;

  let netRaw = parsePositiveBigInt(hopFees?.netOutRaw);
  if (!netRaw && isLastHop) {
    netRaw = parsePositiveBigInt(String(quote._simulatedOutAmount ?? ''));
  }
  if ((!netRaw || netRaw >= quotedRaw) && derivedNetFromFees != null) {
    netRaw = derivedNetFromFees;
  } else if (!netRaw && isLastHop) {
    const fromOut = parsePositiveBigInt(String(quote.outAmount ?? ''));
    if (fromOut && fromOut < quotedRaw) netRaw = fromOut;
  } else if (!netRaw && feeDeductionOut > 0n && quotedRaw > feeDeductionOut) {
    netRaw = quotedRaw - feeDeductionOut;
  } else if (!netRaw) {
    netRaw = quotedRaw;
  }
  if (!netRaw) return null;

  // Pre-fees hop output = execution net + output-mint fee rows only (never build quote optimism).
  const grossRaw = feeDeductionOut > 0n ? netRaw + feeDeductionOut : netRaw;

  return { netRaw, quotedRaw, grossRaw, outMint };
}

/** Non-wallet output-side fees on one hop, expressed in that hop's output mint UI. */
function sumHopOutputSideFeesInHopOutMintUi(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
): number {
  const hopOutMint = swapInfoOutputMint(step.swapInfo);
  if (!hopOutMint) return 0;

  const sellMint = quoteInputMint(quote) ?? '';
  let total = 0;
  for (const item of flattenHopFeeItems(getHopFeeBreakdown(step)?.items ?? [])) {
    if (isAccRentFeeLabel(item.label)) continue;
    if (isWalletCostFeeItem(item, quote)) continue;
    if (isInputSideWalletFeeItem(item, sellMint)) continue;

    const feeUi = feeAmountToUi(item.amountRaw, item.mint);
    if (feeUi == null || feeUi <= 0) continue;

    let inHopOutUi = feeUi;
    if (!routeLegMintMatches(item.mint, hopOutMint)) {
      const feePrice = lookupMintPriceUsd(item.mint, quote);
      const hopOutPrice = lookupMintPriceUsd(hopOutMint, quote);
      if (
        !(Number.isFinite(feePrice) && feePrice > 0 && Number.isFinite(hopOutPrice) && hopOutPrice > 0)
      ) {
        continue;
      }
      inHopOutUi = (feeUi * feePrice) / hopOutPrice;
    }
    total += inHopOutUi;
  }
  return total;
}

function isVybePriceBuildQuote(quote: Record<string, unknown>): boolean {
  return quote._quoteSource === 'vybe-price-build';
}

/** True when enumerated hop fees deduct from the hop output mint (not input-side wallet fees). */
function hopHasAttributedOutputMintFeeDeduction(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  outMint: string,
): boolean {
  const hopFees = getHopFeeBreakdown(step);
  if (!hopFees?.items.length) return false;
  const inRaw =
    parsePositiveBigInt(step.swapInfo?.inAmount) ??
    parsePositiveBigInt(String(quote.inAmount ?? ''));
  const quotedRaw =
    parsePositiveBigInt(hopFees.quotedOutRaw) ??
    parsePositiveBigInt(step.swapInfo?.outAmount);
  if (!quotedRaw) return false;
  const inputMint = step.swapInfo?.inputMintAddress ?? quoteInputMint(quote);
  return (
    sumHopFeeDeductionInOutputRaw(hopFees, outMint, inRaw, quotedRaw, inputMint, quote) > 0n
  );
}

/**
 * Vybe price+build quotes use build.details.quote.outAmount (pre-execution). Simulation
 * wallet receive is often lower (e.g. Meteora DAMM2) without matching output-mint fee rows.
 * Input-side protocol fee is already in swapUsd/payUsd — skip the extra sim÷quoted haircut.
 */
function vybeBuildSkipsSimQuotedRetentionHaircut(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  outMint: string,
): boolean {
  return isVybePriceBuildQuote(quote) && !hopHasAttributedOutputMintFeeDeduction(step, quote, outMint);
}

/** Per-hop retention (net ÷ gross) after that hop's output-side fees. */
function hopLocalOutRetentionFactor(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  isLastHop: boolean,
): number | null {
  const amounts = resolveHopOutAmounts(step, quote, isLastHop);
  if (!amounts) return null;
  const { netRaw, grossRaw, outMint } = amounts;

  if (grossRaw > 0n && netRaw < grossRaw) {
    const f = Number(netRaw) / Number(grossRaw);
    if (Number.isFinite(f) && f > 0 && f <= 1) return f;
  }

  const netUi = deps.rawAmountToUiNumber(String(netRaw), deps.getMintDecimals(outMint));
  const hopFeeUi = sumHopOutputSideFeesInHopOutMintUi(step, quote);
  if (netUi > 0 && hopFeeUi > 0) {
    const f = netUi / (netUi + hopFeeUi);
    if (Number.isFinite(f) && f > 0 && f <= 1) return f;
  }

  if (vybeBuildSkipsSimQuotedRetentionHaircut(step, quote, outMint)) {
    return 1;
  }

  return 1;
}

/**
 * Cumulative % retained through hop index: input wallet-fee factor × each hop's local retention.
 * Intermediate hops no longer inherit final receive USD (which hid per-hop output fees).
 */
function computeCumulativeHopOutgoingPct(
  quote: Record<string, unknown>,
  throughPlanIndex: number,
): number | null {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  if (throughPlanIndex < 0 || throughPlanIndex >= plan.length) return null;

  const payUsd = getQuoteTotalWalletPayUsd(quote, throughPlanIndex);
  const swapUsd = deps.getQuoteSwapUsdValue(quote);
  if (payUsd == null || swapUsd == null || payUsd <= 0 || swapUsd <= 0) return null;

  let retention = swapUsd / payUsd;
  for (let i = 0; i <= throughPlanIndex; i++) {
    const isLast = i === plan.length - 1;
    const local = hopLocalOutRetentionFactor(plan[i]!, quote, isLast);
    if (local == null || local <= 0) return null;
    retention *= local;
  }

  const pct = retention * 100;
  return Number.isFinite(pct) && pct > 0 ? pct : null;
}

interface HopOutgoingPercentBreakdown {
  pctLabel: string;
  netDisplay: string;
  quotedDisplay: string;
  denomDisplay: string;
  outSym: string;
  inputScaled: boolean;
  payDisplay: string | null;
  swapDisplay: string | null;
  inSym: string;
}

function computeHopOutgoingPercentBreakdown(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  isLastHop: boolean,
  planIndex = 0,
): HopOutgoingPercentBreakdown | null {
  const amounts = resolveHopOutAmounts(step, quote, isLastHop);
  if (!amounts) return null;
  const { netRaw, quotedRaw, grossRaw, outMint } = amounts;

  const payRaw = quoteWalletPayRaw(quote);
  const swapRaw = quoteInAmountRaw(quote);
  let inputScaled = false;
  if (isLastHop && payRaw && swapRaw) {
    try {
      inputScaled = BigInt(payRaw) > BigInt(swapRaw);
    } catch {
      inputScaled = false;
    }
  }

  const buildBreakdown = (pct: number): HopOutgoingPercentBreakdown => {
    const outUi = isLastHop ? deps.quoteOutputUiAmount(quote) : null;
    return {
      pctLabel: formatHopPctLabel(pct),
      netDisplay:
        outUi != null
          ? deps.formatSwapAmountValue(outUi).replace(/,/g, '')
          : deps.formatRawTokenAmount(String(netRaw), outMint).display,
      quotedDisplay: deps.formatRawTokenAmount(String(quotedRaw), outMint).display,
      denomDisplay: isLastHop
        ? getQuoteWalletPayLabelFromQuote(quote)
        : deps.formatRawTokenAmount(String(grossRaw), outMint).display,
      outSym: mintSymbolSync(outMint),
      inputScaled,
      payDisplay: formatQuoteRawAmountLabel(payRaw, quoteInputMint(quote)),
      swapDisplay: formatQuoteRawAmountLabel(swapRaw, quoteInputMint(quote)),
      inSym: deps.getSwapInSym(),
    };
  };

  const cumulativePct = computeCumulativeHopOutgoingPct(quote, planIndex);
  if (cumulativePct != null && cumulativePct > 0 && cumulativePct < 100) {
    return buildBreakdown(cumulativePct);
  }

  const hopOutUsd = hopNetOutputUsdEstimate(step, quote, netRaw, outMint, planIndex, isLastHop);
  const cumulativePayUsd = getQuoteTotalWalletPayUsd(quote, planIndex);
  if (
    cumulativePayUsd != null &&
    cumulativePayUsd > 0 &&
    hopOutUsd != null &&
    hopOutUsd > 0 &&
    hopOutUsd < cumulativePayUsd
  ) {
    const pct = (hopOutUsd / cumulativePayUsd) * 100;
    if (Number.isFinite(pct) && pct > 0) {
      return buildBreakdown(pct);
    }
  }

  const denom = isLastHop ? scaleQuotedRawToWalletPay(quotedRaw, quote) : grossRaw;
  if (netRaw >= denom) return null;

  const pct = Number((netRaw * 10000n) / denom) / 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;

  return buildBreakdown(pct);
}

/** % of hop quoted output that continues after fees (e.g. 99% net to wallet). */
function hopOutgoingPercentLabel(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  isLastHop: boolean,
  planIndex = 0,
): string | null {
  return computeHopOutgoingPercentBreakdown(step, quote, isLastHop, planIndex)?.pctLabel ?? null;
}

/** Best total wallet debit: simulation first, then input-side fee estimate. */
export function resolveWalletPayDebitRaw(quote: Record<string, unknown>): string | null {
  const swapRaw = quoteInAmountRaw(quote);
  if (!swapRaw) return null;
  try {
    const swap = BigInt(swapRaw);
    const simulated = parseRawAmountDigits(quote._walletPayDebitRaw);
    if (simulated) {
      const sim = BigInt(simulated);
      if (sim > swap) return simulated;
    }
    const estimated = estimateInputSideWalletPayDebitFromQuote(quote);
    if (estimated) {
      const est = BigInt(estimated);
      if (est > swap) return estimated;
    }
  } catch {
    return null;
  }
  return null;
}

/** Stacked wallet-cost rows for the You pay hero (fee, same-mint rent, foreign SOL rent). */
export interface QuotePayHeroCostStackItem {
  ui: number;
  sym: string;
  mint: string;
  kind: 'fee' | 'rent';
  /** Distinct wallet-fee line items rolled into this row (fee kind only). */
  count?: number;
  /** Tooltip label, e.g. `Protocol fee` or `BONK Rent Fee (Reclaimable)`. */
  detailLabel?: string;
}

export function getQuotePayHeroCostStack(
  quote: Record<string, unknown>,
  sellSym: string,
): QuotePayHeroCostStackItem[] {
  const mint = quoteInputMint(quote);
  if (!mint) return [];

  let feeUi = 0;
  let feeItemCount = 0;
  const feeDetailLabels: string[] = [];
  let sameMintRentUi = 0;
  let sameMintRentAccountSym = '';
  let foreignRentUi = 0;
  let foreignRentAccountSym = '';
  let foundFee = false;
  let foundSameMintRent = false;
  let foundForeignRent = false;

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      const ui = feeAmountToUi(item.amountRaw, item.mint);
      if (ui == null || ui <= 0) continue;

      const sameMint = routeLegMintMatches(item.mint, mint);
      if (isAccRentWalletFeeItem(item)) {
        if (sameMint && hasInputMintRentReclaim(quote, mint)) continue;
        const accountSym = mintSymbolSync(accRentAccountMint(item));
        if (sameMint) {
          sameMintRentUi += ui;
          sameMintRentAccountSym = accountSym;
          foundSameMintRent = true;
        } else if (isSolMint(item.mint)) {
          foreignRentUi += ui;
          foreignRentAccountSym = accountSym;
          foundForeignRent = true;
        }
        continue;
      }

      const sellLegUi = walletCostFeeToSellMintUi(item, quote);
      if (sellLegUi != null && sellLegUi > 0) {
        feeUi += sellLegUi;
        feeItemCount += 1;
        feeDetailLabels.push(displayFeeItemLabel(item));
        foundFee = true;
      }
    }
  }

  if (!foundFee) {
    const payRaw = quoteWalletPayRaw(quote);
    const swapRaw = quoteInAmountRaw(quote);
    if (payRaw && swapRaw && !hasInputMintRentReclaim(quote, mint)) {
      try {
        const pay = BigInt(String(payRaw).replace(/,/g, ''));
        const swap = BigInt(String(swapRaw).replace(/,/g, ''));
        if (pay > swap) {
          const deltaUi = deps.rawAmountToUiNumber(
            (pay - swap).toString(),
            deps.getMintDecimals(mint),
          );
          if (Number.isFinite(deltaUi) && deltaUi > 0) {
            const sameMintRentOnly = foundSameMintRent ? sameMintRentUi : 0;
            const impliedFee = deltaUi - sameMintRentOnly;
            if (impliedFee > 0) {
              feeUi = impliedFee;
              foundFee = true;
              if (feeItemCount === 0) {
                feeItemCount = Math.max(countInputSideWalletFeeItems(quote), 1);
              }
            } else if (!foundSameMintRent) {
              feeUi = deltaUi;
              foundFee = true;
              if (feeItemCount === 0) {
                feeItemCount = Math.max(countInputSideWalletFeeItems(quote), 1);
              }
            }
          }
        }
      } catch {
        /* fall through */
      }
    }
  }

  if (!foundFee) {
    const inputFeeUi = sumInputSideWalletFeesInSellMintUi(quote);
    if (inputFeeUi != null && inputFeeUi > 0) {
      feeUi = inputFeeUi;
      foundFee = true;
      if (feeItemCount === 0) {
        feeItemCount = Math.max(countInputSideWalletFeeItems(quote), 1);
      }
    }
  }

  const stack: QuotePayHeroCostStackItem[] = [];
  if (foundFee && feeUi > 0) {
    stack.push({
      ui: feeUi,
      sym: sellSym,
      mint,
      kind: 'fee',
      count: Math.max(feeItemCount, 1),
      detailLabel: summarizePayHeroFeeDetailLabels(feeDetailLabels),
    });
  }
  if (foundSameMintRent && sameMintRentUi > 0) {
    stack.push({
      ui: sameMintRentUi,
      sym: sellSym,
      mint,
      kind: 'rent',
      detailLabel: formatPayHeroRentDetailLabel(sameMintRentAccountSym, sellSym),
    });
  }
  if (foundForeignRent && foreignRentUi > 0) {
    stack.push({
      ui: foreignRentUi,
      sym: mintSymbolSync(NATIVE_SOL_MINT),
      mint: NATIVE_SOL_MINT,
      kind: 'rent',
      detailLabel: formatPayHeroRentDetailLabel(foreignRentAccountSym, sellSym),
    });
  }
  return stack;
}

/** Individual wallet-fee rows for pay-hero tooltips (one line per protocol/creator/etc.). */
function getQuotePayHeroWalletFeeLineItems(
  quote: Record<string, unknown>,
  sellSym: string,
): QuotePayHeroCostStackItem[] {
  const mint = quoteInputMint(quote);
  if (!mint) return [];

  const out: QuotePayHeroCostStackItem[] = [];
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      if (isAccRentWalletFeeItem(item)) continue;
      const sellLegUi = walletCostFeeToSellMintUi(item, quote);
      if (sellLegUi == null || sellLegUi <= 0) continue;
      out.push({
        ui: sellLegUi,
        sym: sellSym,
        mint,
        kind: 'fee',
        count: 1,
        detailLabel: displayFeeItemLabel(item),
      });
    }
  }
  return out;
}

function getQuotePayHeroWalletFeeUsdLineItems(
  quote: Record<string, unknown>,
): QuotePayHeroUsdStackItem[] {
  const mint = quoteInputMint(quote);
  if (!mint) return [];

  const out: QuotePayHeroUsdStackItem[] = [];
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      if (isAccRentWalletFeeItem(item)) continue;
      const sellLegUi = walletCostFeeToSellMintUi(item, quote);
      if (sellLegUi == null || sellLegUi <= 0) continue;
      let usd = computeFeeUsdNumeric(item, quote);
      if (usd == null || usd <= 0) {
        const sellPrice = lookupMintPriceUsd(mint, quote);
        if (Number.isFinite(sellPrice) && sellPrice > 0) usd = sellLegUi * sellPrice;
      }
      if (usd == null || usd <= 0) continue;
      out.push({
        usd,
        kind: 'fee',
        count: 1,
        detailLabel: displayFeeItemLabel(item),
      });
    }
  }
  return out;
}

/** Expanded stack for pay-hero hover tips — per-fee lines plus rent rows. */
function getQuotePayHeroTooltipStack(
  quote: Record<string, unknown>,
  sellSym: string,
): QuotePayHeroCostStackItem[] {
  const stack = getQuotePayHeroCostStack(quote, sellSym);
  const feeLines = getQuotePayHeroWalletFeeLineItems(quote, sellSym);
  const rentRows = stack.filter((row) => row.kind === 'rent');
  if (feeLines.length > 0) return [...feeLines, ...rentRows];
  return stack;
}

/** Acc-rent rows debited from wallet and not reclaimed via an input close in the same tx. */
function countDeductedRentFeeItems(quote: Record<string, unknown>): number {
  const mint = quoteInputMint(quote);
  if (!mint) return 0;
  let count = 0;
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      if (!isAccRentWalletFeeItem(item)) continue;
      const ui = feeAmountToUi(item.amountRaw, item.mint);
      if (ui == null || ui <= 0) continue;
      const sameMint = routeLegMintMatches(item.mint, mint);
      if (sameMint && hasInputMintRentReclaim(quote, mint)) continue;
      if (sameMint || isSolMint(item.mint)) count += 1;
    }
  }
  return count;
}

function formatQuoteYouPayUsdSubLabel(quote: Record<string, unknown>): string | null {
  const breakdown = resolveQuoteYouPayUsd(quote);
  if (!breakdown) return null;

  const totalLabel = `$${deps.formatSwapPayUsdAmount(breakdown.totalUsd)}`;
  const stack = getQuotePayHeroCostStack(quote, deps.getSwapInSym());
  if (stack.length === 0) return `≈ ${totalLabel}`;

  return `≈ ${totalLabel} ${formatPayHeroFeeIncludesLabel(countPayHeroCostStackItems(stack))}`;
}

interface QuotePayHeroUsdStackItem {
  usd: number;
  kind: QuotePayHeroCostStackItem['kind'];
  count?: number;
  detailLabel?: string;
}

function summarizePayHeroFeeDetailLabels(labels: string[]): string {
  const unique = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) return `${unique.length} Wallet Fees`;
  return 'Wallet Fee';
}

function formatPayHeroRentDetailLabel(accountSym: string, fallbackSym: string): string {
  const sym = truncateFeeTableTokenSymbol(accountSym.trim() || fallbackSym.trim() || 'Token');
  return `${sym} Rent Fee (Reclaimable)`;
}

function formatPayHeroWalletFeeDetailLabel(base: string): string {
  const trimmed = base.trim();
  if (!trimmed) return 'Wallet Fee (Not Reclaimable)';
  if (/\(not reclaimable\)/i.test(trimmed)) return trimmed;
  return `${trimmed} (Not Reclaimable)`;
}

function payHeroCostRowDetailLabel(row: QuotePayHeroCostStackItem): string {
  if (row.kind === 'rent') {
    if (row.detailLabel?.trim()) return row.detailLabel.trim();
    return formatPayHeroRentDetailLabel('', row.sym);
  }
  if (row.detailLabel?.trim()) return formatPayHeroWalletFeeDetailLabel(row.detailLabel.trim());
  const base = row.count != null && row.count > 1 ? `${row.count} Wallet Fees` : 'Wallet Fee';
  return formatPayHeroWalletFeeDetailLabel(base);
}

function getQuotePayHeroUsdStack(
  quote: Record<string, unknown>,
  inSym: string,
  breakdown: QuoteYouPayUsdBreakdown,
): QuotePayHeroUsdStackItem[] {
  const tokenStack = getQuotePayHeroCostStack(quote, inSym);
  const out: QuotePayHeroUsdStackItem[] = [];
  const feeUsdLines = getQuotePayHeroWalletFeeUsdLineItems(quote);
  if (feeUsdLines.length > 0) {
    out.push(...feeUsdLines);
  } else if (breakdown.feeUsd != null && breakdown.feeUsd > 0) {
    const feeRow = tokenStack.find((row) => row.kind === 'fee');
    out.push({
      usd: breakdown.feeUsd,
      kind: 'fee',
      count: feeRow?.count ?? 1,
      detailLabel: feeRow?.detailLabel,
    });
  }
  if (breakdown.rentUsd != null && breakdown.rentUsd > 0) {
    const rentCount = countDeductedRentFeeItems(quote) || 1;
    const rentRows = tokenStack.filter((row) => row.kind === 'rent');
    out.push({
      usd: breakdown.rentUsd,
      kind: 'rent',
      count: rentCount,
      detailLabel:
        rentRows.length === 1
          ? rentRows[0]?.detailLabel
          : rentRows.length > 1
            ? `${rentRows.length} Rent Fees (Reclaimable)`
            : undefined,
    });
  }
  return out;
}

function payHeroUsdCostDetailLabel(row: QuotePayHeroUsdStackItem, tokenRow?: QuotePayHeroCostStackItem): string {
  if (row.kind === 'rent') {
    if (row.detailLabel?.trim()) return row.detailLabel.trim();
    if (tokenRow) return payHeroCostRowDetailLabel(tokenRow);
    return row.count != null && row.count > 1
      ? `${row.count} Rent Fees (Reclaimable)`
      : 'Rent Fee (Reclaimable)';
  }
  if (row.detailLabel?.trim()) return formatPayHeroWalletFeeDetailLabel(row.detailLabel.trim());
  if (tokenRow) return payHeroCostRowDetailLabel(tokenRow);
  const base = row.count != null && row.count > 1 ? `${row.count} Wallet Fees` : 'Wallet Fee';
  return formatPayHeroWalletFeeDetailLabel(base);
}

function formatPayHeroFeeIncludesLabel(count: number): string {
  const feeWord = count === 1 ? 'fee' : 'fees';
  return `(includes ${count} ${feeWord} paid)`;
}

/** Routing diagram input USD line — total wallet pay in USD (from ix-builder `swapUiUsd` or quote breakdown). */
function formatQuoteDiagramInputTotalLabel(quote: Record<string, unknown>): string | null {
  const ui = quote._swapUiUsd as { inputTotalUsd?: number } | undefined;
  if (ui?.inputTotalUsd != null && Number(ui.inputTotalUsd) > 0) {
    return `≈ $${deps.formatSwapPayUsdAmount(Number(ui.inputTotalUsd))}`;
  }

  const breakdown = resolveQuoteYouPayUsd(quote);
  if (!breakdown) return null;
  return `≈ $${deps.formatSwapPayUsdAmount(breakdown.totalUsd)}`;
}

function getQuoteDiagramInputTotalPlaceholderLabel(): string | null {
  const usdLabel = deps.getQuotePayUsdEstimateLabel();
  return usdLabel ? `≈ ${usdLabel}` : null;
}

function countPayHeroCostStackItems(stack: QuotePayHeroCostStackItem[]): number {
  return stack.reduce(
    (n, row) => n + (row.kind === 'fee' ? Math.max(row.count ?? 1, 1) : 1),
    0,
  );
}

function formatPayHeroFeeCountLabel(count: number): string {
  return count === 1 ? '1 Fee' : `${count} Fees`;
}

function formatReceivePoolFeeCountLabel(count: number): string {
  if (count <= 0) return '· Fees';
  return count === 1 ? '1 Fee' : `${count} Fees`;
}

function formatReceiveReclaimCountLabel(count: number): string {
  if (count <= 0) return '· Reclaims';
  return count === 1 ? '1 Reclaim' : `${count} Reclaims`;
}

function countQuoteReceivePoolFees(quote: Record<string, unknown>): number {
  const nativeCount = getQuoteReceivePoolDeductionNativeStack(quote).length;
  if (nativeCount > 0) return nativeCount;
  return getQuoteReceivePoolDeductionStack(quote).length;
}

function formatPayHeroCostDisplay(ui: number): string {
  return deps.formatFeeStackAmount(ui);
}

function renderPayHeroCostRow(
  row: QuotePayHeroCostStackItem,
  amtCls: string,
): string {
  const { sym, ui, mint, kind } = row;
  const symCls = tokenSymColorClass(mint, sym);
  const isRent = kind === 'rent';
  const amtMod = isRent ? ' swap-quote-summary-amt--rent' : ' swap-quote-summary-amt--fee';
  const partMod = isRent ? ' swap-quote-summary-fee-part--rent' : ' swap-quote-summary-fee-part--wallet';
  const detailLabel = payHeroCostRowDetailLabel(row);
  return `<span class="swap-quote-summary-fee-part${partMod}">
        <span class="swap-quote-summary-amt${amtMod}${amtCls}">${deps.escapeHtml(formatPayHeroCostDisplay(ui))}</span>
        <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(sym)}</span><span class="swap-quote-summary-fee-kind">${deps.escapeHtml(detailLabel)}</span>
      </span>`;
}

function renderPayHeroFeeTooltip(stack: QuotePayHeroCostStackItem[], amtCls: string): string {
  const rows = stack.map((row) => renderPayHeroCostRow(row, amtCls));
  return `<span class="swap-quote-summary-fee-tip" role="tooltip">${rows.join('')}</span>`;
}

function renderPayHeroUsdFeeRow(
  row: QuotePayHeroUsdStackItem,
  tokenRow: QuotePayHeroCostStackItem | undefined,
  amtCls: string,
): string {
  const isRent = row.kind === 'rent';
  const amtMod = isRent ? ' swap-quote-summary-amt--rent' : ' swap-quote-summary-amt--fee';
  const partMod = isRent ? ' swap-quote-summary-fee-part--rent' : ' swap-quote-summary-fee-part--wallet';
  const detailLabel = payHeroUsdCostDetailLabel(row, tokenRow);
  return `<span class="swap-quote-summary-fee-part${partMod}">
        <span class="swap-quote-summary-amt${amtMod}${amtCls}">$${deps.escapeHtml(deps.formatSwapPayUsdAmount(row.usd))}</span><span class="swap-quote-summary-fee-kind">${deps.escapeHtml(detailLabel)}</span>
      </span>`;
}

function renderPayHeroUsdFeeTooltip(
  stack: QuotePayHeroUsdStackItem[],
  tokenStack: QuotePayHeroCostStackItem[],
  amtCls: string,
): string {
  const kindIndex: Record<'fee' | 'rent', number> = { fee: 0, rent: 0 };
  const rows = stack.map((row) => {
    const idx = kindIndex[row.kind];
    kindIndex[row.kind] += 1;
    const tokenRow = tokenStack.filter((t) => t.kind === row.kind)[idx];
    return renderPayHeroUsdFeeRow(row, tokenRow, amtCls);
  });
  return `<span class="swap-quote-summary-fee-tip" role="tooltip">${rows.join('')}</span>`;
}

function wrapQuoteSummarySubBracketed(contentHtml: string): string {
  return `<span class="swap-quote-summary-sub-bracketed"><span class="swap-quote-summary-sub-bracket" aria-hidden="true">(</span>${contentHtml}<span class="swap-quote-summary-sub-bracket" aria-hidden="true">)</span></span>`;
}

function renderQuoteHeroNoFeesDeductedHtml(
  side: 'pay' | 'receive',
  placeholder = false,
): string {
  const subCls = placeholder ? ' swap-quote-summary-sub-amt--placeholder' : '';
  const label =
    side === 'receive' ? 'No fees deducted or reclaims' : 'No fees or rent deductions';
  return `<span class="swap-quote-summary-sub-none${subCls}">${label}</span>`;
}

function wrapQuotePayHeroSubStack(
  breakdownHtml: string | null,
  usdRowHtml: string,
  showNoFees = false,
  placeholder = false,
): string {
  const rows: string[] = [];
  if (breakdownHtml) rows.push(breakdownHtml);
  else if (showNoFees) rows.push(renderQuoteHeroNoFeesDeductedHtml('pay', placeholder));
  rows.push(`<span class="swap-quote-summary-sub-row">${usdRowHtml}</span>`);
  return rows.length === 1 ? rows[0]! : `<span class="swap-quote-summary-sub-stack">${rows.join('')}</span>`;
}

function renderQuotePayHeroBreakdownHtml(
  quote: Record<string, unknown>,
  inSym: string,
  placeholder = false,
): string | null {
  const swapAmt = getQuoteSwapLegLabelFromQuote(quote);
  if (swapAmt === '—') return null;
  const stack = getQuotePayHeroCostStack(quote, inSym);
  if (stack.length === 0) return null;

  const inputMint = quoteInputMint(quote) ?? '';
  const subCls = placeholder ? ' swap-quote-summary-sub-amt--placeholder' : '';
  const symCls = tokenSymColorClass(inputMint, inSym);
  const feeCount = countPayHeroCostStackItems(stack);
  const feeLabel = formatPayHeroFeeCountLabel(feeCount);
  const tooltipStack = getQuotePayHeroTooltipStack(quote, inSym);
  const tipHtml = renderPayHeroFeeTooltip(tooltipStack, subCls);
  const tipTitle = tooltipStack
    .map((row) => `${formatPayHeroCostDisplay(row.ui)} ${row.sym} ${payHeroCostRowDetailLabel(row)}`)
    .join(', ');

  return wrapQuoteSummarySubBracketed(`<span class="swap-quote-summary-sub-breakdown">
      <span class="swap-quote-summary-sub-amt${subCls}">${deps.escapeHtml(swapAmt)}</span>
      <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(inSym)}</span>
      <span class="swap-quote-summary-plus">+</span>
      <span class="swap-quote-summary-fee-trigger swap-quote-summary-fee-trigger--has-tip" tabindex="0" aria-label="${deps.escapeHtml(tipTitle)}">
        <span class="swap-quote-summary-fee-count">${deps.escapeHtml(feeLabel)}</span>
        ${tipHtml}
      </span>
    </span>`);
}

/** You pay hero USD sub-label — total plus compact fee count with hover breakdown. */
export function renderQuotePayHeroSubHtml(
  quote: Record<string, unknown> | null,
  inSym: string,
  placeholder = false,
): string | null {
  if (!quote && placeholder) return renderQuotePayHeroSubPlaceholderHtml(inSym);
  if (!quote) return null;
  const breakdown = resolveQuoteYouPayUsd(quote);
  const tokenStack = getQuotePayHeroCostStack(quote, inSym);
  const breakdownHtml = renderQuotePayHeroBreakdownHtml(quote, inSym, placeholder);
  if (!breakdown) {
    return breakdownHtml;
  }

  const subCls = placeholder ? ' swap-quote-summary-sub-amt--placeholder' : '';
  const totalLabel = `$${deps.formatSwapPayUsdAmount(breakdown.totalUsd)}`;
  const approxPrefix = '≈ ';
  if (tokenStack.length === 0) {
    const usdRow = `<span class="swap-quote-summary-sub-amt${subCls}">${deps.escapeHtml(`${approxPrefix}${totalLabel}`)}</span>`;
    return wrapQuotePayHeroSubStack(breakdownHtml, usdRow, !breakdownHtml, placeholder);
  }

  const feeCount = countPayHeroCostStackItems(tokenStack);
  const includesLabel = formatPayHeroFeeIncludesLabel(feeCount);
  const usdStack = getQuotePayHeroUsdStack(quote, inSym, breakdown);
  const tooltipTokenStack = getQuotePayHeroTooltipStack(quote, inSym);
  const tipHtml = renderPayHeroUsdFeeTooltip(usdStack, tooltipTokenStack, subCls);
  const kindIndex: Record<'fee' | 'rent', number> = { fee: 0, rent: 0 };
  const tipTitle = usdStack
    .map((row) => {
      const idx = kindIndex[row.kind];
      kindIndex[row.kind] += 1;
      const tokenRow = tooltipTokenStack.filter((t) => t.kind === row.kind)[idx];
      const label = payHeroUsdCostDetailLabel(row, tokenRow);
      return `$${deps.formatSwapPayUsdAmount(row.usd)} ${label}`;
    })
    .join(', ');
  const subSummary = `${approxPrefix}${totalLabel} ${includesLabel}`;

  const usdRow = `<span class="swap-quote-summary-sub-amt${subCls}">${deps.escapeHtml(`${approxPrefix}${totalLabel}`)}</span>
      <span class="swap-quote-summary-fee-trigger swap-quote-summary-fee-trigger--has-tip" tabindex="0" aria-label="${deps.escapeHtml(`${subSummary}: ${tipTitle}`)}">
        <span class="swap-quote-summary-fee-count">${deps.escapeHtml(includesLabel)}</span>
        ${tipHtml}
      </span>`;
  return wrapQuotePayHeroSubStack(breakdownHtml, usdRow);
}

/** You pay hero value HTML — swap leg plus stacked fee / rent after +. */
export function renderQuotePayHeroValueHtml(
  quote: Record<string, unknown> | null,
  inSym: string,
  fallbackAmt: string,
  placeholder = false,
  loading = false,
): string {
  const amtCls = placeholder ? ' swap-quote-summary-amt--placeholder' : '';
  const inputMint = (
    quote ? quoteInputMint(quote) : deps.getFormInputMint().trim()
  ).trim();
  const inputSymCls = tokenSymColorClass(inputMint, inSym);
  if (loading && placeholder) {
    return `<span class="swap-quote-summary-amt${amtCls}">${deps.renderLoadingSpinner('md')}</span>`;
  }

  const swapAmt = quote ? getQuoteSwapLegLabelFromQuote(quote) : fallbackAmt;
  if (swapAmt === '—') {
    return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(fallbackAmt)}</span>
        <span class="swap-quote-summary-sym ${inputSymCls}">${deps.escapeHtml(inSym)}</span>`;
  }

  const stack = quote ? getQuotePayHeroCostStack(quote, inSym) : [];
  if (stack.length === 0) {
    if (!quote && fallbackAmt !== '—') {
      return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(fallbackAmt)}</span>
          <span class="swap-quote-summary-sym ${inputSymCls}">${deps.escapeHtml(inSym)}</span>
          <span class="swap-quote-summary-hero-total-label">total</span>`;
    }
    return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(swapAmt)}</span>
        <span class="swap-quote-summary-sym ${inputSymCls}">${deps.escapeHtml(inSym)}</span>`;
  }

  const totalAmt = quote ? getQuoteWalletPayLabelFromQuote(quote) : fallbackAmt;
  return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(totalAmt)}</span>
      <span class="swap-quote-summary-sym ${inputSymCls}">${deps.escapeHtml(inSym)}</span>
      <span class="swap-quote-summary-hero-total-label">total</span>`;
}

export interface QuoteReceiveHeroReclaimItem {
  ui: number;
  sym: string;
  mint: string;
  label: string;
}

/** Input ATA rent returned to wallet (shown on You receive, not You pay). */
export function getQuoteReceiveHeroReclaimStack(
  quote: Record<string, unknown>,
): QuoteReceiveHeroReclaimItem[] {
  const out: QuoteReceiveHeroReclaimItem[] = [];
  for (const entry of getQuoteWalletTokenAccountCloses(quote)) {
    if (entry.category !== 'input') continue;
    const item = closeEntryToReclaimFeeItem(entry);
    const ui = feeAmountToUi(item.amountRaw, item.mint);
    if (ui == null || ui <= 0) continue;
    const accountSym = mintSymbolSync(entry.mint);
    out.push({
      ui,
      sym: 'WSOL',
      mint: WSOL_MINT,
      label: `${accountSym} Rent Reclaim`,
    });
  }
  return out;
}

function renderReceiveReclaimRow(item: QuoteReceiveHeroReclaimItem): string {
  const symCls = tokenSymColorClass(item.mint, item.sym);
  return `<span class="swap-quote-summary-fee-part swap-quote-summary-fee-part--reclaim">
        <span class="swap-quote-summary-amt swap-quote-summary-amt--reclaim">${deps.escapeHtml(formatPayHeroCostDisplay(item.ui))}</span>
        <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(item.sym)}</span><span class="swap-quote-summary-fee-kind"> ${deps.escapeHtml(item.label)}</span>
      </span>`;
}

function countQuoteReceiveReclaimAdjustments(quote: Record<string, unknown>): number {
  return getQuoteReceiveHeroReclaimStack(quote).length;
}

function renderReceiveReclaimTooltip(
  reclaimStack: QuoteReceiveHeroReclaimItem[],
  amtCls: string,
): string {
  const reclaimRows = reclaimStack.map((row) => renderReceiveReclaimRow(row));
  return `<span class="swap-quote-summary-fee-tip" role="tooltip">${reclaimRows.join('')}</span>`;
}

function renderReceiveReclaimTriggerHtml(
  reclaimStack: QuoteReceiveHeroReclaimItem[],
  subCls: string,
): string {
  const reclaimLabel = formatReceiveReclaimCountLabel(reclaimStack.length);
  const tipHtml = renderReceiveReclaimTooltip(reclaimStack, subCls);
  const tipTitle = reclaimStack
    .map((row) => `${formatPayHeroCostDisplay(row.ui)} ${row.sym} ${row.label}`)
    .join(', ');
  return `<span class="swap-quote-summary-plus">+</span>
      <span class="swap-quote-summary-fee-trigger swap-quote-summary-fee-trigger--has-tip swap-quote-summary-fee-trigger--reclaim" tabindex="0" aria-label="${deps.escapeHtml(`${reclaimLabel}: ${tipTitle}`)}">
        <span class="swap-quote-summary-sub-reclaim-label">${deps.escapeHtml(reclaimLabel)}</span>
        ${tipHtml}
      </span>`;
}

function renderReceivePoolFeeTriggerHtml(
  tooltipStack: QuoteReceivePoolDeductionItem[],
  poolCount: number,
  subCls: string,
): string {
  const feeLabel = formatReceivePoolFeeCountLabel(poolCount);
  const tipHtml = renderReceivePoolDeductionTooltip(tooltipStack, subCls);
  const tipTitle = tooltipStack
    .map((row) => `${formatReceivePoolDeductionTooltipAmount(row)} ${row.detailLabel}`)
    .join(', ');
  return `<span class="swap-quote-summary-minus">−</span>
      <span class="swap-quote-summary-fee-trigger swap-quote-summary-fee-trigger--has-tip swap-quote-summary-fee-trigger--pool" tabindex="0" aria-label="${deps.escapeHtml(`${feeLabel}: ${tipTitle}`)}">
        <span class="swap-quote-summary-sub-pool-label">${deps.escapeHtml(feeLabel)}</span>
        ${tipHtml}
      </span>`;
}

/** Grey "total" suffix on the You receive hero amount line. */
function renderQuoteReceiveHeroTotalLabel(): string {
  return `<span class="swap-quote-summary-hero-total-label">total</span>`;
}

/** You receive hero value HTML — swap output plus rent reclaimed from closed input ATAs. */
export function renderQuoteReceiveHeroValueHtml(
  quote: Record<string, unknown> | null,
  outSym: string,
  fallbackAmt: string,
  placeholder = false,
  loading = false,
): string {
  const amtCls = placeholder ? ' swap-quote-summary-amt--placeholder' : '';
  const outputMint = (
    quote ? quoteOutputMint(quote) : deps.getFormOutputMint().trim()
  ).trim();
  const outSymCls = tokenSymColorClass(outputMint, outSym);
  if (loading && placeholder) {
    return `<span class="swap-quote-summary-amt${amtCls}">${deps.renderLoadingSpinner('md')}</span>`;
  }

  const outAmt = fallbackAmt;
  if (outAmt === '—') {
    return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(fallbackAmt)}</span>
        <span class="swap-quote-summary-sym ${outSymCls}">${deps.escapeHtml(outSym)}</span>${renderQuoteReceiveHeroTotalLabel()}`;
  }

  return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(outAmt)}</span>
      <span class="swap-quote-summary-sym ${outSymCls}">${deps.escapeHtml(outSym)}</span>${renderQuoteReceiveHeroTotalLabel()}`;
}

export interface QuoteReceivePoolDeductionItem {
  ui: number;
  sym: string;
  mint: string;
  detailLabel: string;
  /** Hop/output-mint equivalent when the debited mint differs. */
  altUi?: number;
  altSym?: string;
  altMint?: string;
}

/** Express one pool fee row in its hop's output mint UI (not rolled into final receive mint). */
function poolFeeItemInHopOutMintUi(
  item: HopFeeItemLite,
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
): { ui: number; mint: string; sym: string } | null {
  const hopOutMint = swapInfoOutputMint(step.swapInfo);
  if (!hopOutMint) return null;
  if (!isDeductedFromPoolFeeItem(item, quote, hopOutMint)) return null;

  const feeUi = feeAmountToUi(item.amountRaw, item.mint);
  if (feeUi == null || feeUi <= 0) return null;

  if (routeLegMintMatches(item.mint, hopOutMint)) {
    return { ui: feeUi, mint: hopOutMint, sym: mintSymbolSync(hopOutMint) };
  }

  const feePrice = lookupMintPriceUsd(item.mint, quote);
  const hopOutPrice = lookupMintPriceUsd(hopOutMint, quote);
  if (
    Number.isFinite(feePrice) &&
    feePrice > 0 &&
    Number.isFinite(hopOutPrice) &&
    hopOutPrice > 0
  ) {
    return {
      ui: (feeUi * feePrice) / hopOutPrice,
      mint: hopOutMint,
      sym: mintSymbolSync(hopOutMint),
    };
  }

  const si = step.swapInfo;
  const inputMint = si?.inputMintAddress ?? quoteInputMint(quote) ?? '';
  const inRaw = parsePositiveBigInt(si?.inAmount);
  const quotedOutRaw =
    parsePositiveBigInt(getHopFeeBreakdown(step)?.quotedOutRaw) ??
    parsePositiveBigInt(si?.outAmount);
  const feeRaw = parsePositiveBigInt(item.amountRaw);
  if (
    inRaw &&
    quotedOutRaw &&
    quotedOutRaw > 0n &&
    feeRaw &&
    routeLegMintMatches(item.mint, inputMint)
  ) {
    const outRaw = (feeRaw * quotedOutRaw) / inRaw;
    const outUi = deps.rawAmountToUiNumber(outRaw.toString(), deps.getMintDecimals(hopOutMint));
    if (Number.isFinite(outUi) && outUi > 0) {
      return { ui: outUi, mint: hopOutMint, sym: mintSymbolSync(hopOutMint) };
    }
  }

  return { ui: feeUi, mint: item.mint, sym: mintSymbolSync(item.mint) };
}

/** Native pool fee amount as debited (no conversion to hop/final output mint). */
function poolFeeItemNative(
  item: HopFeeItemLite,
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
): QuoteReceivePoolDeductionItem | null {
  const hopOutMint = swapInfoOutputMint(step.swapInfo);
  if (!hopOutMint) return null;
  if (!isDeductedFromPoolFeeItem(item, quote, hopOutMint)) return null;

  const feeUi = feeAmountToUi(item.amountRaw, item.mint);
  if (feeUi == null || feeUi <= 0) return null;
  const label = normalizeFeeItemLabel(item.label).trim() || 'Pool fee';
  return {
    ui: feeUi,
    sym: mintSymbolSync(item.mint),
    mint: item.mint,
    detailLabel: label,
  };
}

/** Pool/output-side fees per hop, each in that hop's output mint (USDC, BONK, …). */
export function getQuoteReceivePoolDeductionStack(
  quote: Record<string, unknown>,
): QuoteReceivePoolDeductionItem[] {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const out: QuoteReceivePoolDeductionItem[] = [];
  for (const step of plan) {
    for (const item of flattenHopFeeItems(getHopFeeBreakdown(step)?.items ?? [])) {
      if (isAccRentFeeLabel(item.label)) continue;
      const converted = poolFeeItemInHopOutMintUi(item, step, quote);
      if (!converted || converted.ui <= 0) continue;
      const label = normalizeFeeItemLabel(item.label).trim() || 'Pool fee';
      out.push({
        ui: converted.ui,
        sym: converted.sym,
        mint: converted.mint,
        detailLabel: label,
      });
    }
  }
  return out;
}

/** Pool fees in the actual debited mint. */
function getQuoteReceivePoolDeductionNativeStack(
  quote: Record<string, unknown>,
): QuoteReceivePoolDeductionItem[] {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const out: QuoteReceivePoolDeductionItem[] = [];
  for (const step of plan) {
    for (const item of flattenHopFeeItems(getHopFeeBreakdown(step)?.items ?? [])) {
      if (isAccRentFeeLabel(item.label)) continue;
      const native = poolFeeItemNative(item, step, quote);
      if (native) out.push(native);
    }
  }
  return out;
}

/** Tooltip rows — hop output mint primary, native debited mint in brackets when different. */
function getQuoteReceivePoolDeductionTooltipStack(
  quote: Record<string, unknown>,
): QuoteReceivePoolDeductionItem[] {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const out: QuoteReceivePoolDeductionItem[] = [];
  for (const step of plan) {
    for (const item of flattenHopFeeItems(getHopFeeBreakdown(step)?.items ?? [])) {
      if (isAccRentFeeLabel(item.label)) continue;
      const native = poolFeeItemNative(item, step, quote);
      if (!native) continue;
      const converted = poolFeeItemInHopOutMintUi(item, step, quote);
      if (
        converted &&
        converted.ui > 0 &&
        !routeLegMintMatches(converted.mint, native.mint)
      ) {
        out.push({
          ui: converted.ui,
          sym: converted.sym,
          mint: converted.mint,
          detailLabel: native.detailLabel,
          altUi: native.ui,
          altSym: native.sym,
          altMint: native.mint,
        });
        continue;
      }
      out.push(native);
    }
  }
  return out;
}

function formatReceivePoolDeductionTooltipAmount(row: QuoteReceivePoolDeductionItem): string {
  const base = `${deps.formatFeeStackAmount(row.ui)} ${row.sym}`;
  if (
    row.altUi == null ||
    !row.altSym ||
    !row.altMint ||
    routeLegMintMatches(row.altMint, row.mint)
  ) {
    return base;
  }
  return `${base} (${deps.formatFeeStackAmount(row.altUi)} ${row.altSym})`;
}

/** One row per mint for the You receive sub-line (multi-hop: USDC + BONK + …). */
function aggregateQuoteReceivePoolDeductionByMint(
  stack: QuoteReceivePoolDeductionItem[],
): QuoteReceivePoolDeductionItem[] {
  const order: string[] = [];
  const byMint = new Map<string, QuoteReceivePoolDeductionItem>();
  for (const row of stack) {
    const existing = byMint.get(row.mint);
    if (existing) {
      existing.ui += row.ui;
      if (!existing.detailLabel.includes(row.detailLabel)) {
        existing.detailLabel = `${existing.detailLabel}, ${row.detailLabel}`;
      }
      continue;
    }
    order.push(row.mint);
    byMint.set(row.mint, { ...row });
  }
  return order.map((mint) => byMint.get(mint)!);
}

function renderReceivePoolDeductionRow(
  row: QuoteReceivePoolDeductionItem,
  amtCls: string,
): string {
  const symCls = tokenSymColorClass(row.mint, row.sym);
  const altHtml =
    row.altUi != null &&
    row.altSym &&
    row.altMint &&
    !routeLegMintMatches(row.altMint, row.mint)
      ? `<span class="swap-quote-summary-fee-kind swap-quote-summary-fee-kind--pool-alt"> (${deps.escapeHtml(deps.formatFeeStackAmount(row.altUi))} ${deps.escapeHtml(row.altSym)})</span>`
      : '';
  return `<span class="swap-quote-summary-fee-part swap-quote-summary-fee-part--pool">
        <span class="swap-quote-summary-amt swap-quote-summary-amt--pool-deduct${amtCls}">${deps.escapeHtml(deps.formatFeeStackAmount(row.ui))}</span>
        <span class="swap-quote-summary-sym swap-quote-summary-amt--pool-deduct ${symCls}">${deps.escapeHtml(row.sym)}</span>${altHtml}<span class="swap-quote-summary-fee-kind swap-quote-summary-fee-kind--pool">${deps.escapeHtml(row.detailLabel)}</span>
      </span>`;
}

function renderReceivePoolDeductionTooltip(
  stack: QuoteReceivePoolDeductionItem[],
  amtCls: string,
): string {
  const rows = stack.map((row) => renderReceivePoolDeductionRow(row, amtCls));
  return `<span class="swap-quote-summary-fee-tip" role="tooltip">${rows.join('')}</span>`;
}

function renderReceivePoolDeductionSummaryPart(
  row: QuoteReceivePoolDeductionItem,
  amtCls: string,
): string {
  const symCls = tokenSymColorClass(row.mint, row.sym);
  return `<span class="swap-quote-summary-pool-part">
        <span class="swap-quote-summary-sub-amt swap-quote-summary-amt--pool-deduct${amtCls}">${deps.escapeHtml(deps.formatFeeStackAmount(row.ui))}</span>
        <span class="swap-quote-summary-sym swap-quote-summary-amt--pool-deduct ${symCls}">${deps.escapeHtml(row.sym)}</span>
      </span>`;
}

/** Pool-side fees on the final hop, summed in receive mint raw units. */
function sumQuoteReceivePoolDeductionInOutputRaw(quote: Record<string, unknown>): bigint {
  const outMint = quoteOutputMint(quote);
  if (!outMint) return 0n;
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastStep = plan.at(-1);
  if (!lastStep) return 0n;
  const hopOutMint = swapInfoOutputMint(lastStep.swapInfo);
  if (!hopOutMint || !routeLegMintMatches(hopOutMint, outMint)) return 0n;

  const hopFees = getHopFeeBreakdown(lastStep);
  if (!hopFees?.items.length) return 0n;
  const si = lastStep.swapInfo;
  const inputMint = si?.inputMintAddress ?? quoteInputMint(quote) ?? '';
  const inRaw =
    parsePositiveBigInt(si?.inAmount) ??
    (plan.length === 1 ? parsePositiveBigInt(String(quote.inAmount ?? '')) : null);
  const quotedOutRaw =
    parsePositiveBigInt(hopFees.quotedOutRaw) ??
    parsePositiveBigInt(si?.outAmount) ??
    parsePositiveBigInt(String(quote._quotedOutAmount ?? ''));
  if (!quotedOutRaw) return 0n;
  return sumHopFeeDeductionInOutputRaw(hopFees, outMint, inRaw, quotedOutRaw, inputMint, quote);
}

function getQuoteReceiveNetOutRaw(quote: Record<string, unknown>): bigint | null {
  const raw =
    quote._simulatedOutAmount != null && quote._simulatedOutAmount !== ''
      ? String(quote._simulatedOutAmount)
      : quote.outAmount != null && quote.outAmount !== ''
        ? String(quote.outAmount)
        : null;
  return parsePositiveBigInt(raw?.replace(/,/g, ''));
}

function getQuoteReceiveGrossOutLabel(quote: Record<string, unknown>): string | null {
  const outMint = quoteOutputMint(quote);
  if (!outMint) return null;
  const netRaw = getQuoteReceiveNetOutRaw(quote);
  if (!netRaw) return null;

  const poolRaw = sumQuoteReceivePoolDeductionInOutputRaw(quote);
  if (poolRaw > 0n) {
    return formatQuoteRawAmountLabel((netRaw + poolRaw).toString(), outMint);
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastStep = plan.at(-1);
  if (lastStep) {
    const amounts = resolveHopOutAmounts(lastStep, quote, true);
    if (amounts && amounts.grossRaw > amounts.netRaw) {
      return formatQuoteRawAmountLabel(amounts.grossRaw.toString(), outMint);
    }
  }
  const deltaUi = getQuoteOutputFeeDeltaUi(quote);
  if (deltaUi != null && deltaUi > 0) {
    const deltaRawNum = Math.round(deltaUi * 10 ** deps.getMintDecimals(outMint));
    if (Number.isFinite(deltaRawNum) && deltaRawNum > 0) {
      try {
        return formatQuoteRawAmountLabel((netRaw + BigInt(deltaRawNum)).toString(), outMint);
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

function sumInputQuoteRentReclaimRaw(quote: Record<string, unknown>): bigint {
  let total = 0n;
  for (const entry of getQuoteWalletTokenAccountCloses(quote)) {
    if (entry.category !== 'input') continue;
    const raw = parsePositiveBigInt(
      entry.reclaimedLamports ?? DEFAULT_TOKEN_ACCOUNT_RENT_LAMPORTS,
    );
    if (raw && raw > 0n) total += raw;
  }
  return total;
}

/** Swap-side base for receive breakdown: starting amount minus reclaim whenever reclaim rows show. */
function getQuoteReceiveBreakdownBaseLabel(
  quote: Record<string, unknown>,
  grossLabel: string | null,
  netLabel: string | null,
  poolCount: number,
  reclaimCount: number,
): string {
  if (reclaimCount <= 0) {
    return poolCount > 0 ? (grossLabel ?? netLabel ?? '—') : (netLabel ?? '—');
  }

  const outMint = quoteOutputMint(quote);
  const netRaw = getQuoteReceiveNetOutRaw(quote);
  if (!outMint || !netRaw) return grossLabel ?? netLabel ?? '—';

  const poolRaw = poolCount > 0 ? sumQuoteReceivePoolDeductionInOutputRaw(quote) : 0n;
  const reclaimRaw = sumInputQuoteRentReclaimRaw(quote);
  const reclaimInOutputMint = reclaimRaw > 0n && routeLegMintMatches(WSOL_MINT, outMint);

  let baseRaw = netRaw + poolRaw;
  if (reclaimInOutputMint) {
    baseRaw = baseRaw > reclaimRaw ? baseRaw - reclaimRaw : 0n;
  }
  const formatted = formatQuoteRawAmountLabel(baseRaw.toString(), outMint);
  if (formatted) return formatted;
  return grossLabel ?? netLabel ?? '—';
}

function renderQuoteReceiveHeroSubPoolHtml(
  quote: Record<string, unknown> | null,
  placeholder = false,
): string | null {
  const tooltipStack = quote ? getQuoteReceivePoolDeductionTooltipStack(quote) : [];
  const reclaimStack = quote && !placeholder ? getQuoteReceiveHeroReclaimStack(quote) : [];
  const grossLabel = quote ? getQuoteReceiveGrossOutLabel(quote) : null;
  const netLabel = quote ? formatQuoteTokenAmount(quote, 'out').display : null;
  const poolCount = quote && !placeholder ? countQuoteReceivePoolFees(quote) : 0;
  const reclaimCount = quote && !placeholder ? countQuoteReceiveReclaimAdjustments(quote) : 0;
  const hasPool = tooltipStack.length > 0;
  const showRow =
    placeholder ||
    reclaimCount > 0 ||
    (hasPool && grossLabel != null) ||
    (grossLabel != null && netLabel != null && grossLabel !== netLabel);
  if (!showRow) return null;

  const outMint = (quote ? quoteOutputMint(quote) : deps.getFormOutputMint().trim()).trim();
  const outSym = mintSymbolSync(outMint);
  const subCls = placeholder ? ' swap-quote-summary-sub-amt--placeholder' : '';
  const symCls = tokenSymColorClass(outMint, outSym);

  if (reclaimCount > 0) {
    const baseLabel = quote
      ? getQuoteReceiveBreakdownBaseLabel(quote, grossLabel, netLabel, poolCount, reclaimCount)
      : netLabel ?? '—';
    const poolPart =
      poolCount > 0 && hasPool
        ? renderReceivePoolFeeTriggerHtml(tooltipStack, poolCount, subCls)
        : '';
    const reclaimPart = renderReceiveReclaimTriggerHtml(reclaimStack, subCls);

    return wrapQuoteSummarySubBracketed(`<span class="swap-quote-summary-sub-breakdown">
        <span class="swap-quote-summary-sub-amt${subCls}">${deps.escapeHtml(baseLabel)}</span>
        <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(outSym)}</span>
        ${poolPart}
        ${reclaimPart}
      </span>`);
  }

  const display = grossLabel ?? '—';
  const feeCount = poolCount;
  const feeLabel = formatReceivePoolFeeCountLabel(feeCount);

  if (!hasPool) {
    return wrapQuoteSummarySubBracketed(`<span class="swap-quote-summary-sub-total${subCls}">
        <span class="swap-quote-summary-sub-amt">${deps.escapeHtml(display)}</span>
        <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(outSym)}</span>
        <span class="swap-quote-summary-minus">−</span>
        <span class="swap-quote-summary-sub-pool-label">${deps.escapeHtml(feeLabel)}</span>
      </span>`);
  }

  const tipHtml = renderReceivePoolDeductionTooltip(tooltipStack, subCls);
  const tipTitle = tooltipStack
    .map((row) => `${formatReceivePoolDeductionTooltipAmount(row)} ${row.detailLabel}`)
    .join(', ');
  const summaryText = `${display} ${outSym} − ${feeLabel}`;

  return wrapQuoteSummarySubBracketed(`<span class="swap-quote-summary-sub-total${subCls}">
      <span class="swap-quote-summary-sub-amt">${deps.escapeHtml(display)}</span>
      <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(outSym)}</span>
      <span class="swap-quote-summary-minus">−</span>
      <span class="swap-quote-summary-fee-trigger swap-quote-summary-fee-trigger--has-tip swap-quote-summary-fee-trigger--pool" tabindex="0" aria-label="${deps.escapeHtml(`${summaryText}: ${tipTitle}`)}">
        <span class="swap-quote-summary-sub-pool-label">${deps.escapeHtml(feeLabel)}</span>
        ${tipHtml}
      </span>
    </span>`);
}

function renderQuotePayHeroSubPlaceholderHtml(inSym: string): string {
  const inMint = deps.getFormInputMint().trim();
  const subCls = ' swap-quote-summary-sub-amt--placeholder';
  const symCls = tokenSymColorClass(inMint, inSym);
  const payLabel = deps.getQuoteWalletPayLabel();
  const swapDisplay = payLabel !== '—' ? payLabel : '·';
  const usdLabel = deps.getQuotePayUsdEstimateLabel();
  const usdDisplay = usdLabel ? `≈ ${usdLabel}` : '≈ ·';
  const breakdownHtml = wrapQuoteSummarySubBracketed(`<span class="swap-quote-summary-sub-breakdown">
      <span class="swap-quote-summary-sub-amt${subCls}">${deps.escapeHtml(swapDisplay)}</span>
      <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(inSym)}</span>
      <span class="swap-quote-summary-plus">+</span>
      <span class="swap-quote-summary-fee-trigger">
        <span class="swap-quote-summary-fee-count">· Fees</span>
      </span>
    </span>`);
  const usdRow = `<span class="swap-quote-summary-sub-amt${subCls}">${deps.escapeHtml(usdDisplay)}</span>
      <span class="swap-quote-summary-fee-trigger">
        <span class="swap-quote-summary-fee-count">(includes · fees paid)</span>
      </span>`;
  return wrapQuotePayHeroSubStack(breakdownHtml, usdRow);
}

/** You receive hero sub-label — per-hop pool deductions and USD estimate. */
export function renderQuoteReceiveHeroSubHtml(
  quote: Record<string, unknown> | null,
  _outSym: string,
  placeholder = false,
): string | null {
  const poolHtml = renderQuoteReceiveHeroSubPoolHtml(quote, placeholder);

  const receiveUsd = quote ? deps.getQuoteReceiveUsd(quote) : null;

  const subCls = placeholder ? ' swap-quote-summary-sub-amt--placeholder' : '';
  let usdRow = '';
  if (receiveUsd != null && receiveUsd > 0) {
    const label = deps.formatSwapReceiveUsdLabel(receiveUsd);
    if (label) {
      usdRow = `<span class="swap-quote-summary-sub-amt${subCls}">≈ ${deps.escapeHtml(label)}</span>`;
    }
  } else if (placeholder) {
    usdRow = `<span class="swap-quote-summary-sub-amt${subCls}">≈ —</span>`;
  }

  const rows: string[] = [];
  if (poolHtml) rows.push(`<span class="swap-quote-summary-sub-row">${poolHtml}</span>`);
  else if (quote && !placeholder) {
    rows.push(`<span class="swap-quote-summary-sub-row">${renderQuoteHeroNoFeesDeductedHtml('receive', false)}</span>`);
  }
  if (usdRow) rows.push(`<span class="swap-quote-summary-sub-row">${usdRow}</span>`);
  if (rows.length === 0) return null;
  return rows.length === 1 ? rows[0]! : `<span class="swap-quote-summary-sub-stack">${rows.join('')}</span>`;
}

/** Sub-label under You receive — pool output USD plus input rent reclaim when present. */
export function getQuoteYouReceiveSubLabel(quote: Record<string, unknown>): string | null {
  const enriched = quote._youReceive as { reclaimUsd?: number } | undefined;
  const receiveUsd = deps.getQuoteReceiveUsd(quote);
  const reclaimUsd =
    enriched && Number.isFinite(enriched.reclaimUsd)
      ? Number(enriched.reclaimUsd)
      : sumInputQuoteRentReclaimUsd(quote);
  if (receiveUsd == null && reclaimUsd <= 0) return null;
  let valuePart = '';
  if (receiveUsd != null && receiveUsd > 0) {
    valuePart = `≈ ${deps.formatSwapReceiveUsdLabel(receiveUsd)}`;
  }
  if (reclaimUsd > 0.001) {
    const reclaimPart = `+ ${deps.formatSwapReceiveUsdLabel(reclaimUsd)} reclaim`;
    valuePart = valuePart ? `${valuePart} ${reclaimPart}` : reclaimPart;
  }
  const parts: string[] = [];
  if (valuePart) parts.push(valuePart);
  parts.push('from quote');
  return parts.join(' · ');
}

/** Input-mint wallet debit for the route diagram chip: swap leg + same-mint fee/rent. */
function getQuoteDiagramInputChipAmountRaw(quote: Record<string, unknown>): string | null {
  const mint = quoteInputMint(quote);
  const swapRawStr = quoteInAmountRaw(quote);
  if (!mint || !swapRawStr) return null;

  let total: bigint;
  try {
    total = BigInt(String(swapRawStr).replace(/,/g, ''));
  } catch {
    return null;
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (!isWalletCostFeeItem(item, quote)) continue;
      if (!routeLegMintMatches(item.mint, mint)) continue;
      if (!item.amountRaw || item.amountRaw === '0') continue;
      try {
        total += BigInt(String(item.amountRaw).replace(/,/g, ''));
      } catch {
        /* skip malformed fee raw */
      }
    }
  }

  const payRawStr = quoteWalletPayRaw(quote);
  if (payRawStr) {
    try {
      const pay = BigInt(String(payRawStr).replace(/,/g, ''));
      if (pay > total) total = pay;
    } catch {
      /* keep computed total */
    }
  }

  return total > 0n ? total.toString() : null;
}

/** Route diagram input chip — total debited in the sell mint (swap + same-mint fees/rent). */
function getQuoteDiagramInputChipLabel(quote: Record<string, unknown>): string {
  const mint = quoteInputMint(quote);
  const totalRaw = getQuoteDiagramInputChipAmountRaw(quote);
  if (totalRaw && mint) {
    const label = formatQuoteRawAmountLabel(totalRaw, mint);
    if (label) return label;
  }
  return getQuoteSwapLegLabelFromQuote(quote);
}

/** Diagram input endpoint fee rows — same amounts/symbols as the You pay hero stack. */
export function getQuoteDiagramInputFeeRows(
  quote: Record<string, unknown>,
  inSym: string,
): QuotePayHeroCostStackItem[] {
  return getQuotePayHeroCostStack(quote, inSym);
}

function formatDiagramInputFeeVal(ui: number): string {
  return `+${deps.formatFeeStackAmount(ui)}`;
}

function diagramInputFeeLineLabel(kind: QuotePayHeroCostStackItem['kind'], feeCountInCurrency: number): string {
  if (kind === 'rent') return 'Rent Fee:';
  if (feeCountInCurrency > 1) return `${feeCountInCurrency} Fees:`;
  return 'Fee:';
}

function renderDiagramInputFeeLine(
  label: string,
  ui: number,
  mint: string,
  sym: string,
): string {
  const symCls = tokenSymColorClass(mint, sym);
  return `<span class="routing-input-addon">${label} <span class="routing-input-addon__val">${deps.escapeHtml(formatDiagramInputFeeVal(ui))} <span class="${symCls}">${deps.escapeHtml(sym)}</span></span></span>`;
}

function renderDiagramInputFeeStackHtml(
  rows: QuotePayHeroCostStackItem[],
  inSym: string,
  showAllEndpointLabels: boolean,
  inMint = '',
): string {
  if (rows.length === 0) {
    if (!showAllEndpointLabels) return '';
    const mint = inMint.trim() || deps.getFormInputMint().trim();
    const symCls = tokenSymColorClass(mint, inSym);
    return `<span class="routing-input-addon">Fee: <span class="routing-input-addon__val">${ROUTING_PLACEHOLDER_DASH} <span class="${symCls}">${deps.escapeHtml(inSym)}</span></span></span>`;
  }

  const feeGroups = new Map<string, { mint: string; sym: string; ui: number; count: number }>();
  const rentRows: QuotePayHeroCostStackItem[] = [];

  for (const row of rows) {
    if (row.kind === 'rent') {
      rentRows.push(row);
      continue;
    }
    const key = row.mint.trim();
    const hit = feeGroups.get(key);
    if (hit) {
      hit.ui += row.ui;
      hit.count += row.count ?? 1;
    } else {
      feeGroups.set(key, { mint: row.mint, sym: row.sym, ui: row.ui, count: row.count ?? 1 });
    }
  }

  const lines: string[] = [];
  for (const group of feeGroups.values()) {
    lines.push(
      renderDiagramInputFeeLine(
        diagramInputFeeLineLabel('fee', group.count),
        group.ui,
        group.mint,
        group.sym,
      ),
    );
  }
  for (const row of rentRows) {
    lines.push(
      renderDiagramInputFeeLine(
        diagramInputFeeLineLabel('rent', 1),
        row.ui,
        row.mint,
        row.sym,
      ),
    );
  }

  if (lines.length === 1) return lines[0]!;
  return `<div class="routing-input-addon-stack">${lines.join('')}</div>`;
}

/** Matches rendered line count in renderDiagramInputFeeStackHtml (fee groups + rent rows). */
function countDiagramInputFeeDisplayLines(
  feeRows: QuotePayHeroCostStackItem[],
  showAllEndpointLabels: boolean,
): number {
  if (feeRows.length === 0) {
    return showAllEndpointLabels ? 1 : 0;
  }
  const feeMints = new Set<string>();
  let rentCount = 0;
  for (const row of feeRows) {
    if (row.kind === 'rent') {
      rentCount += 1;
      continue;
    }
    feeMints.add(row.mint.trim());
  }
  return feeMints.size + rentCount;
}

function renderDiagramOutputAlignSpacers(spacerCount: number): string {
  if (spacerCount <= 0) return '';
  return Array.from(
    { length: spacerCount },
    () => '<span class="routing-output-fees-spacer" aria-hidden="true">&nbsp;</span>',
  ).join('');
}

/** @deprecated Prefer getQuoteDiagramInputFeeRows — kept for single-row callers. */
export function getQuoteDiagramInputFeeAddon(quote: Record<string, unknown>): string | null {
  const walletAddon = getQuoteInputSideAddonLabel(quote);
  if (walletAddon) return walletAddon;
  const inputFeeUi = sumInputSideWalletFeesInSellMintUi(quote);
  if (inputFeeUi == null) return null;
  const formatted = deps.formatFeeStackAmount(inputFeeUi);
  return formatted === '0' ? null : `+${formatted}`;
}

function getQuoteDiagramInputTotalLabel(quote: Record<string, unknown>): string | null {
  return formatQuoteDiagramInputTotalLabel(quote);
}

/** Extra wallet debit above swap leg (fees/rent on input side), e.g. +0.002181 SOL. */
export function getQuoteInputSideAddonLabel(quote: Record<string, unknown>): string | null {
  const mint = quoteInputMint(quote);
  const payRaw = quoteWalletPayRaw(quote);
  const swapRaw = quoteInAmountRaw(quote);
  if (!mint || !payRaw || !swapRaw) return null;
  try {
    const pay = BigInt(payRaw);
    const swap = BigInt(swapRaw);
    if (pay <= swap) return null;
    const deltaRaw = (pay - swap).toString();
    const display = deps.formatRawTokenAmount(deltaRaw, mint).display;
    if (display === '—') return null;
    return `+${display.replace(/,/g, '')}`;
  } catch {
    return null;
  }
}

function detectParallelForkLengthFrom(plan: VybeRoutePlanStepLite[], idx: number): number | null {
  if (idx >= plan.length) return null;
  const p0 = plan[idx]?.percent;
  if (p0 == null || !Number.isFinite(p0) || p0 >= 99.9) return null;

  let sum = 0;
  for (let i = idx; i < plan.length; i++) {
    const p = plan[i]?.percent ?? 0;
    if (i > idx && p >= 99.9) break;
    sum += p;
    const count = i - idx + 1;
    if (count >= 2 && sum >= 98.5 && sum <= 101.5) return count;
    if (sum > 101.5) return null;
  }
  return null;
}

function branchMatchesHead(step: VybeRoutePlanStepLite, headOut: string): boolean {
  if (!headOut) return true;
  const inMint = swapInfoInputMint(step.swapInfo);
  return !inMint || inMint === headOut;
}

function findBranchContinuationStart(
  plan: VybeRoutePlanStepLite[],
  fromIdx: number,
  headOut: string,
  consumed: Set<number>,
): number {
  for (let i = fromIdx; i < plan.length; i++) {
    if (consumed.has(i)) continue;
    if (branchMatchesHead(plan[i]!, headOut)) return i;
  }
  return plan.length;
}

function parseRouteAt(
  plan: VybeRoutePlanStepLite[],
  idx: number,
  depth: number,
  labelPrefix: string | null,
  subSeq: number,
  consumed: Set<number>,
): { node: RouteNode; nextIdx: number } {
  while (idx < plan.length && consumed.has(idx)) idx++;
  if (idx >= plan.length) return { node: { kind: 'empty' }, nextIdx: idx };

  const forkLen = detectParallelForkLengthFrom(plan, idx);
  if (forkLen !== null) {
    const branches: RouteNode[] = [];
    const branchEndIdxs: number[] = [];

    for (let b = 0; b < forkLen; b++) {
      const hopIdx = idx + b;
      consumed.add(hopIdx);
      const branchLabel = labelPrefix ? `${labelPrefix}.${b + 1}` : `${depth}.${b + 1}`;
      const hopNode: RouteNode = {
        kind: 'hop',
        meta: {
          step: plan[hopIdx]!,
          planIndex: hopIdx,
          label: branchLabel,
        },
      };

      const headOut = swapInfoOutputMint(plan[hopIdx]?.swapInfo);
      const contStart = findBranchContinuationStart(plan, idx + forkLen, headOut, consumed);

      let contNode: RouteNode = { kind: 'empty' };
      let contEnd = contStart;

      if (contStart < plan.length) {
        const cont = parseRouteAt(plan, contStart, depth + 1, branchLabel, 1, consumed);
        contNode = cont.node;
        contEnd = cont.nextIdx;
      }

      branchEndIdxs.push(Math.max(hopIdx + 1, contEnd));
      branches.push(
        contNode.kind === 'empty' ? hopNode : { kind: 'seq', nodes: [hopNode, contNode] },
      );
    }

    const forkEnd = Math.max(idx + forkLen, ...branchEndIdxs);
    const forkNode: RouteNode = { kind: 'fork', branches, depth };
    const after = parseRouteAt(plan, forkEnd, depth + 1, labelPrefix, subSeq, consumed);

    if (after.node.kind === 'empty') {
      return { node: forkNode, nextIdx: forkEnd };
    }
    return {
      node: { kind: 'seq', nodes: [forkNode, after.node] },
      nextIdx: after.nextIdx,
    };
  }

  consumed.add(idx);
  const hopLabel = labelPrefix ? `${labelPrefix}.${subSeq}` : String(depth);
  const hopNode: RouteNode = {
    kind: 'hop',
    meta: { step: plan[idx]!, planIndex: idx, label: hopLabel },
  };
  const after = parseRouteAt(plan, idx + 1, depth + 1, labelPrefix, subSeq + 1, consumed);
  if (after.node.kind === 'empty') {
    return { node: hopNode, nextIdx: idx + 1 };
  }
  return { node: { kind: 'seq', nodes: [hopNode, after.node] }, nextIdx: after.nextIdx };
}

function buildRouteTree(plan: VybeRoutePlanStepLite[]): RouteNode {
  if (plan.length === 0) return { kind: 'empty' };
  return parseRouteAt(plan, 0, 1, null, 1, new Set()).node;
}

function collectRouteHopMetas(node: RouteNode, out: RouteHopMeta[]): void {
  if (node.kind === 'empty') return;
  if (node.kind === 'hop') {
    out.push(node.meta);
    return;
  }
  if (node.kind === 'seq') {
    node.nodes.forEach((n) => collectRouteHopMetas(n, out));
    return;
  }
  node.branches.forEach((b) => collectRouteHopMetas(b, out));
}

function routeTreeHasFork(node: RouteNode): boolean {
  if (node.kind === 'fork') return true;
  if (node.kind === 'seq') return node.nodes.some(routeTreeHasFork);
  return false;
}

function countRouteTreeHops(node: RouteNode): number {
  if (node.kind === 'hop') return 1;
  if (node.kind === 'seq') return node.nodes.reduce((sum, n) => sum + countRouteTreeHops(n), 0);
  if (node.kind === 'fork') return node.branches.reduce((sum, b) => sum + countRouteTreeHops(b), 0);
  return 0;
}

function countRouteTreeForkBranches(node: RouteNode): number {
  if (node.kind === 'fork') return node.branches.length;
  if (node.kind === 'seq') {
    return node.nodes.reduce((sum, n) => sum + countRouteTreeForkBranches(n), 0);
  }
  return 0;
}

export function formatRouteChipLabel(plan: VybeRoutePlanStepLite[]): string {
  const hopCount = plan.length;
  if (hopCount === 0) return '—';
  const routeTree = buildRouteTree(plan);
  const routeCount = countRouteTreeForkBranches(routeTree);
  if (routeCount >= 2) {
    return `${routeCount} Routes + ${hopCount} Hops`;
  }
  return hopCount === 1 ? '1 Hop' : `${hopCount} Hops`;
}
function renderRoutingTokenIcon(mint: string, sym: string): string {
  const m = mint.trim();
  const meta = m ? getCachedTokenMeta(m) : null;
  const iconSrc = effectiveTokenIconSrc(meta?.logoUrl);
  if (iconSrc !== TOKEN_ICON_PLACEHOLDER_PATH) {
    return renderTokenIconImgHtml(iconSrc, 'routing-token-img');
  }
  return `<span class="${routingTokenDotClass(m, sym)}" aria-hidden="true"></span>`;
}

function renderRouteEndpointPill(
  amt: string,
  sym: string,
  title?: string,
  amtLoading = false,
  mintOverride = '',
): string {
  const mint =
    mintOverride.trim() ||
    (sym === deps.getSwapInSym()
      ? (deps.getFormInputMint())
      : sym === deps.getSwapOutSym()
        ? (deps.getFormOutputMint())
        : '');
  const boxCls = mint ? tokenBoxColorClass(mint, sym) : '';
  const symCls = tokenSymColorClass(mint, sym);
  const titleAttr = title ? ` title="${deps.escapeHtml(title)}"` : '';
  const amtHtml = amtLoading ? deps.renderLoadingSpinner('md') : deps.escapeHtml(amt);
  return `<div class="routing-pill routing-pill--endpoint${boxCls ? ` ${boxCls}` : ''}"${titleAttr}>
    ${renderRoutingTokenIcon(mint, sym)}
    <span class="routing-amt">${amtHtml}</span>
    <span class="routing-sym ${symCls}">${deps.escapeHtml(sym)}</span>
  </div>`;
}

function renderRoutePctBadge(
  pct: string,
  direction: 'in' | 'out' = 'in',
  title: string | null = null,
): string {
  const outClass = direction === 'out' ? ' routing-pct-badge--out' : '';
  const plusClass = pct.includes('+') ? ' routing-pct-badge--with-plus' : '';
  const titleAttr = title ? ` title="${deps.escapeHtml(title)}"` : '';
  const ariaHidden = title ? '' : ' aria-hidden="true"';
  return `<div class="routing-hop-link routing-hop-link--${direction}"${ariaHidden}>
    <span class="routing-pct-badge${outClass}${plusClass}"${titleAttr}>${deps.escapeHtml(pct)}</span>
  </div>`;
}

function sumRentReclaimUsd(items: HopFeeItemLite[], quote: Record<string, unknown>): number {
  let total = 0;
  for (const item of items) {
    const usd = computeFeeUsdNumeric(item, quote);
    if (usd != null && usd > 0) total += usd;
  }
  return total;
}

/** Sum USD value of all ATA-close / WSOL rent returned to wallet on this quote. */
function sumQuoteRentReclaimUsd(quote: Record<string, unknown>): number {
  return sumRentReclaimUsd(
    getQuoteWalletTokenAccountCloses(quote).map(closeEntryToReclaimFeeItem),
    quote,
  );
}

function renderHopIndexBadge(label: string): string {
  return `<span class="routing-hop-index-badge">Hop #${deps.escapeHtml(label)}</span>`;
}

function normalizeFeeItemLabel(label: string): string {
  const l = label.trim().toLowerCase();
  if (l === 'pda rent' || l === 'token acc rent' || l === 'acc rent fee') return ACC_RENT_FEE_LABEL;
  return label;
}

const PRIORITY_FEE_LABEL = 'Priority fee';
const SLIPPAGE_SPREAD_LABEL = 'Slippage/Spread';

/** User-facing fee name; renames generic route fees by destination kind. */
function displayFeeItemLabel(
  item: Pick<HopFeeItemLite, 'label' | 'destinationKind' | 'mint' | 'accountMint'>,
): string {
  if (isAccRentReclaimItem(item as HopFeeItemLite) || isAccRentWalletFeeItem(item as HopFeeItemLite)) {
    return accRentFeeDisplayLabel(item);
  }
  const base = normalizeFeeItemLabel(item.label);
  const l = base.toLowerCase();
  if (l === 'route fee' || l === 'priority fee' || l === 'slippage/spread') {
    if (item.destinationKind === 'network_priority') return PRIORITY_FEE_LABEL;
    if (item.destinationKind === 'output_deduction') return SLIPPAGE_SPREAD_LABEL;
  }
  if (l === 'priority fee') return PRIORITY_FEE_LABEL;
  if (l === 'slippage/spread') return SLIPPAGE_SPREAD_LABEL;
  return base;
}

function isAccRentFeeLabel(label: string): boolean {
  const l = label.trim().toLowerCase();
  if (l === 'acc rent fee' || l === 'pda rent' || l === 'token acc rent') return true;
  return l.endsWith(' rent fee') && !l.includes('priority');
}

/** SOL/token-account rent — always debited from the wallet, even when selling a non-SOL token. */
function isAccRentWalletFeeItem(item: HopFeeItemLite): boolean {
  if (isAccRentReclaimItem(item)) return false;
  if (isAccRentFeeLabel(item.label)) return true;
  return item.destinationKind === 'new_token_account';
}

function isAccRentReclaimItem(item: HopFeeItemLite): boolean {
  return item.destinationKind === 'closed_token_account';
}

function isOutputSideFeeDisplayItem(item: HopFeeItemLite): boolean {
  const kind = item.destinationKind;
  if (kind === 'lp_pool' || kind === 'output_deduction') return true;
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  return label === 'pool fee' || label === 'slippage/spread';
}

/** Pool/output-side fee rows — not debited from the user's wallet with the swap input. */
function isDeductedFromPoolFeeItem(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
  hopOutMint: string,
): boolean {
  if (isWalletCostFeeItem(item, quote) || isAccRentWalletFeeItem(item)) return false;
  if (isOutputSideFeeDisplayItem(item)) return true;

  const inputMint = quoteInputMint(quote) ?? '';
  if (isInputSideWalletFeeItem(item, inputMint)) return false;

  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  const poolStyleFee =
    label === 'protocol fee' ||
    label === 'route fee' ||
    label === 'pool fee' ||
    label === 'slippage/spread';
  if (!poolStyleFee) return false;

  return Boolean(hopOutMint && routeLegMintMatches(item.mint, hopOutMint));
}

/** Wallet-debited protocol/route/creator fees on the sell mint (incl. pump.fun lp_pool attribution). */
function isInputSideSellMintFeeItem(item: HopFeeItemLite, quote: Record<string, unknown>): boolean {
  const sellMint = quoteInputMint(quote);
  if (!sellMint || !routeLegMintMatches(item.mint, sellMint)) return false;
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  return label === 'protocol fee' || label === 'route fee' || label === 'creator fee';
}

/** Wallet-debited protocol/route on the sell mint (even if destination enrichment tagged lp_pool). */
function isInputSideWalletFeeItem(item: HopFeeItemLite, inputMint: string): boolean {
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  if (label !== 'protocol fee' && label !== 'route fee' && label !== 'creator fee') return false;
  if (isSolMint(inputMint)) return isSolMint(item.mint);
  return item.mint === inputMint;
}

function formatAccRentFeeSolSubline(equiv: FeeAmountEquiv): string {
  const amt = equiv.primary !== '—' ? equiv.primary.replace(/,/g, '') : '—';
  let sym = equiv.feeSym && equiv.feeSym !== '—' ? equiv.feeSym : 'SOL';
  if (sym === 'WSOL') sym = 'SOL';
  return `${amt} ${sym}`;
}

function accRentFeeAmountEquiv(item: HopFeeItemLite, quote: Record<string, unknown>): FeeAmountEquiv {
  const equiv = computeFeeEquivalents(item.amountRaw, item.mint, quote);
  return { ...equiv, feeMint: WSOL_MINT, feeSym: 'WSOL' };
}

function feeEquivForHopItem(item: HopFeeItemLite, quote: Record<string, unknown>): FeeAmountEquiv {
  const fromEnrichment = feeEquivFromEnrichmentItem(item, quote);
  if (fromEnrichment) return fromEnrichment;
  if (isAccRentWalletFeeItem(item) || isAccRentReclaimItem(item)) {
    return accRentFeeAmountEquiv(item, quote);
  }
  return computeFeeEquivalents(item.amountRaw, item.mint, quote);
}

/** Prefer ix-builder `ui` / `usd` on fee items — do not reprice from token-details. */
function feeEquivFromEnrichmentItem(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
): FeeAmountEquiv | null {
  if (typeof item.usd !== 'number' || !Number.isFinite(item.usd) || item.usd <= 0) return null;
  const sellMint = quoteInputMint(quote);
  const inputSym = deps.getSwapInSym();
  const feeMint =
    isAccRentWalletFeeItem(item) || isAccRentReclaimItem(item) ? WSOL_MINT : item.mint;
  const feeSym = mintSymbolSync(feeMint);
  const feeUi =
    typeof item.ui === 'number' && Number.isFinite(item.ui) && item.ui > 0
      ? item.ui
      : feeAmountToUi(item.amountRaw, feeMint);
  const primary =
    feeUi != null && feeUi > 0
      ? deps.formatFeeEquivSmallAmount(feeUi)
      : deps.formatRawTokenAmount(item.amountRaw, feeMint).display;
  const usd = deps.formatFeeEquivUsdFiatDisplay(item.usd);
  const foreign = isForeignFeeMint(feeMint, quote);
  let inputEquiv: string | null = null;
  if (foreign) {
    inputEquiv = solEquivSublineFromUsd(item.usd, quote);
  } else if (feeUi != null && sellMint) {
    const sellLegUi = convertFeeUiToSellLeg(feeUi, feeMint, quote);
    if (sellLegUi != null) {
      inputEquiv = `≈ ${deps.formatFeeEquivSmallAmount(sellLegUi)} ${inputSym}`;
    } else {
      inputEquiv = solEquivSublineFromUsd(item.usd, quote);
    }
  }
  return { feeMint, feeSym, primary, inputEquiv, inputSym, usd };
}

/** Expand legacy nested token-acc rent onto the same row as other hop fees. */
function flattenHopFeeItems(items: HopFeeItemLite[]): HopFeeItemLite[] {
  const flat: HopFeeItemLite[] = [];
  for (const item of items) {
    flat.push({
      label: normalizeFeeItemLabel(item.label),
      amountRaw: item.amountRaw,
      mint: item.mint,
      accountMint: item.accountMint,
      destinationAddress: item.destinationAddress,
      destinationKind: item.destinationKind,
      destinationNote: item.destinationNote,
      ...(typeof item.usd === 'number' && Number.isFinite(item.usd) ? { usd: item.usd } : {}),
      ...(typeof item.ui === 'number' && Number.isFinite(item.ui) ? { ui: item.ui } : {}),
      ...(typeof item.decimals === 'number' && Number.isFinite(item.decimals)
        ? { decimals: item.decimals }
        : {}),
    });
    if (item.pdaRent) {
      flat.push({
        label: normalizeFeeItemLabel(item.pdaRent.label),
        amountRaw: item.pdaRent.amountRaw,
        mint: item.pdaRent.mint,
      });
    }
  }
  return flat;
}

function dedupeHopFeeDisplayItems(items: HopFeeItemLite[]): HopFeeItemLite[] {
  const seen = new Set<string>();
  const out: HopFeeItemLite[] = [];
  for (const item of items) {
    const key = [
      item.label,
      item.amountRaw,
      item.mint,
      item.destinationKind ?? '',
      item.destinationAddress ?? '',
      item.accountMint ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function getHopFeeDisplayItems(step: VybeRoutePlanStepLite): HopFeeItemLite[] {
  const fees = getHopFeeBreakdown(step);
  return fees?.items.length ? dedupeHopFeeDisplayItems(flattenHopFeeItems(fees.items)) : [];
}

function getHopFeeBreakdown(step: VybeRoutePlanStepLite): HopFeeBreakdownLite | null {
  if (step._hopFees?.items?.length) return step._hopFees;
  if (step.hopFees?.items?.length) return step.hopFees;
  const si = step.swapInfo;
  if (si?.feeAmount && si.feeAmount !== '0') {
    const mint = (si.feeMintAddress ?? si.outputMintAddress ?? '').trim();
    return {
      items: [{ label: 'Fee', amountRaw: si.feeAmount, mint }],
      totalAmountRaw: si.feeAmount,
      mint,
    };
  }
  return null;
}

interface FeeAmountEquiv {
  feeMint: string;
  feeSym: string;
  primary: string;
  inputEquiv: string | null;
  inputSym: string;
  usd: string | null;
}

function feeAmountToUi(amountRaw: string, feeMint: string): number | null {
  const digits = String(amountRaw).replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const n = deps.rawAmountToUiNumber(digits, deps.getMintDecimals(feeMint));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Hop fee table amounts — 3 sig figs after leading fractional zeros. */
function formatHopFeeTableAmount(amountRaw: string, feeMint: string): string {
  const feeUi = feeAmountToUi(amountRaw, feeMint);
  if (feeUi != null) return deps.formatFeeEquivSmallAmount(feeUi);
  const fallback = deps.formatRawTokenAmount(amountRaw, feeMint).display;
  return fallback === '—' ? '—' : fallback;
}

export function collectRoutePriceMints(quote: Record<string, unknown>): string[] {
  const mints = new Set<string>();
  mints.add(NATIVE_SOL_MINT);
  const inputMint = quoteInputMint(quote);
  const outputMint = quoteOutputMint(quote);
  if (inputMint) mints.add(inputMint);
  if (outputMint) mints.add(outputMint);

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    const si = step.swapInfo;
    const inM = swapInfoInputMint(si);
    const outM = swapInfoOutputMint(si);
    if (inM) mints.add(inM);
    if (outM) mints.add(outM);
    const siFeeMint = (si?.feeMintAddress ?? '').trim();
    if (siFeeMint) mints.add(siFeeMint);

    const hopFees = getHopFeeBreakdown(step);
    for (const item of hopFees?.items ?? []) {
      if (item.mint) mints.add(item.mint);
      if (item.pdaRent?.mint) mints.add(item.pdaRent.mint);
    }
  }

  return [...mints];
}

export function lookupMintPriceUsd(mint: string, quote: Record<string, unknown>): number {
  const m = mint.trim();
  if (!m) return NaN;

  const cached = deps.getPairTokenStats()[m]?.price;
  if (cached != null && Number.isFinite(cached) && cached > 0) return cached;

  const quoteStats = quote._tokenStats as Record<string, TokenPriceStats> | undefined;
  const fromQuote = quoteStats?.[m]?.price;
  if (fromQuote != null && Number.isFinite(fromQuote) && fromQuote > 0) return fromQuote;

  const metaPrice = getCachedTokenMeta(m)?.price;
  if (metaPrice != null && Number.isFinite(metaPrice) && metaPrice > 0) return metaPrice;

  if (m === quoteInputMint(quote)) {
    const inputPrice = Number(quote._inputPriceUsd);
    if (Number.isFinite(inputPrice) && inputPrice > 0) return inputPrice;
  }
  if (m === quoteOutputMint(quote)) {
    const outputPrice = Number(quote._outputPriceUsd);
    if (Number.isFinite(outputPrice) && outputPrice > 0) return outputPrice;
  }

  if (STABLECOIN_USD_FALLBACK_MINTS.has(m)) return STABLECOIN_USD_FALLBACK_PRICE;

  if (isSolMint(m)) {
    for (const alt of [NATIVE_SOL_MINT, WSOL_MINT]) {
      if (alt === m) continue;
      const altCached = deps.getPairTokenStats()[alt]?.price;
      if (altCached != null && Number.isFinite(altCached) && altCached > 0) return altCached;
      const altQuote = quoteStats?.[alt]?.price;
      if (altQuote != null && Number.isFinite(altQuote) && altQuote > 0) return altQuote;
    }
  }

  return NaN;
}

export function pairCardEffectiveStats(mint: string, quote?: Record<string, unknown>): TokenPriceStats | undefined {
  const base = deps.getPairTokenStats()[mint];
  const price = lookupMintPriceUsd(mint, quote ?? {});
  if (!Number.isFinite(price) || price <= 0) return base;
  if (base) return { ...base, price };
  const cached = getCachedTokenMeta(mint);
  return {
    price,
    price1d: cached?.price1d,
    price7d: cached?.price7d,
    decimals: cached?.decimals ?? deps.getMintDecimals(mint),
    priceFetchedAt: cached?.priceFetchedAt ?? Date.now(),
    priceUpdateTime: cached?.priceUpdateTime,
  };
}

/** Mirror Vybe quote metadata so aggregator routes get buy-side USD + pair-card stats. */
export function attachQuoteTokenPriceMeta(
  quote: Record<string, unknown>,
  inputMint: string,
  outputMint: string,
): Record<string, unknown> {
  const inKey = inputMint.trim();
  const outKey = outputMint.trim();
  const inputStats = deps.getPairTokenStats()[inKey];
  const outputStats = deps.getPairTokenStats()[outKey];
  const tokenStats: Record<string, TokenPriceStats> = {};
  if (inputStats) tokenStats[inKey] = inputStats;
  if (outputStats) tokenStats[outKey] = outputStats;

  const next: Record<string, unknown> = { ...quote };
  if (Object.keys(tokenStats).length > 0) next._tokenStats = tokenStats;
  if (inputStats?.price && next._inputPriceUsd == null) next._inputPriceUsd = inputStats.price;
  if (outputStats?.price && next._outputPriceUsd == null) next._outputPriceUsd = outputStats.price;
  return next;
}

function routeLegMintMatches(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return isSolMint(x) && isSolMint(y);
}

function isSwapEndpointMint(mint: string, quote: Record<string, unknown>): boolean {
  const m = mint.trim();
  if (!m) return false;
  const sell = quoteInputMint(quote);
  const buy = quoteOutputMint(quote);
  return routeLegMintMatches(m, sell) || routeLegMintMatches(m, buy);
}

/** Fee mint is neither the sell nor buy token (e.g. SOL rent on a BONK → ZEC swap). */
function isForeignFeeMint(feeMint: string, quote: Record<string, unknown>): boolean {
  return !isSwapEndpointMint(feeMint, quote);
}

function lookupSolPriceUsd(quote: Record<string, unknown>): number {
  return lookupMintPriceUsd(NATIVE_SOL_MINT, quote);
}

/** Convert a USD notional to SOL using cached token-details / resolve-prices SOL spot. */
function convertFeeUsdToSolUi(usd: number, quote: Record<string, unknown>): number | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const solPrice = lookupSolPriceUsd(quote);
  if (!Number.isFinite(solPrice) || solPrice <= 0) return null;
  const solUi = usd / solPrice;
  return Number.isFinite(solUi) && solUi > 0 ? solUi : null;
}

function solEquivSublineFromUsd(usd: number, quote: Record<string, unknown>): string | null {
  const solUi = convertFeeUsdToSolUi(usd, quote);
  if (solUi == null) return null;
  return `≈ ${deps.formatFeeEquivSmallAmount(solUi)} SOL`;
}

/**
 * Fees debited from the wallet for badge/total math — includes cross-mint costs
 * (SOL acc rent on SPL sells, etc.) priced via token-details USD.
 */
export function isWalletCostFeeItem(item: HopFeeItemLite, quote: Record<string, unknown>): boolean {
  if (isAccRentWalletFeeItem(item)) return true;
  if (isOutputSideFeeDisplayItem(item)) return false;
  if (isInputSideSellMintFeeItem(item, quote)) return true;
  const kind = item.destinationKind;
  if (kind === 'lp_pool' || kind === 'output_deduction') return false;
  if (
    kind === 'fee_recipient' ||
    kind === 'input_wallet' ||
    kind === 'new_token_account' ||
    kind === 'network_priority'
  ) {
    return true;
  }
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  if (label === 'pool fee' || label === 'slippage/spread') return false;
  if (
    label === 'protocol fee' ||
    label === 'route fee' ||
    label === 'priority fee' ||
    label === 'creator fee'
  ) {
    if (isSolMint(item.mint)) return true;
    const sellMint = quoteInputMint(quote);
    return Boolean(sellMint && routeLegMintMatches(item.mint, sellMint));
  }
  return false;
}

function convertFeeUiToSellLeg(
  feeUi: number,
  feeMint: string,
  quote: Record<string, unknown>,
  visited: Set<string> = new Set(),
): number | null {
  const sellMint = quoteInputMint(quote);
  if (!sellMint || !Number.isFinite(feeUi) || feeUi <= 0) return null;
  if (routeLegMintMatches(feeMint, sellMint)) return feeUi;
  if (visited.has(feeMint)) return null;
  visited.add(feeMint);

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    const si = step.swapInfo;
    if (!si) continue;
    const hopIn = swapInfoInputMint(si);
    const hopOut = swapInfoOutputMint(si);
    if (!hopIn || !hopOut || !routeLegMintMatches(hopOut, feeMint)) continue;

    const inRaw = parsePositiveBigInt(si.inAmount);
    const outRaw = parsePositiveBigInt(si.outAmount);
    if (!inRaw || !outRaw || outRaw === 0n) continue;

    const inUi = deps.rawAmountToUiNumber(inRaw.toString(), deps.getMintDecimals(hopIn));
    const outUi = deps.rawAmountToUiNumber(outRaw.toString(), deps.getMintDecimals(hopOut));
    if (!(inUi > 0 && outUi > 0)) continue;

    const feeInHopInUi = feeUi * (inUi / outUi);
    return convertFeeUiToSellLeg(feeInHopInUi, hopIn, quote, visited);
  }

  const outMint = quoteOutputMint(quote);
  const swapRate = Number(quote.swapRate);
  if (routeLegMintMatches(feeMint, outMint) && Number.isFinite(swapRate) && swapRate > 0) {
    return feeUi / swapRate;
  }

  const feePrice = lookupMintPriceUsd(feeMint, quote);
  const sellPrice = lookupMintPriceUsd(sellMint, quote);
  if (Number.isFinite(feePrice) && feePrice > 0 && Number.isFinite(sellPrice) && sellPrice > 0) {
    return (feeUi * feePrice) / sellPrice;
  }
  return null;
}

function convertFeeUiToOutputLeg(
  feeUi: number,
  feeMint: string,
  quote: Record<string, unknown>,
  visited: Set<string> = new Set(),
): number | null {
  const outMint = quoteOutputMint(quote);
  if (!outMint || !Number.isFinite(feeUi) || feeUi <= 0) return null;
  if (routeLegMintMatches(feeMint, outMint)) return feeUi;
  if (visited.has(feeMint)) return null;
  visited.add(feeMint);

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  for (const step of plan) {
    const si = step.swapInfo;
    if (!si) continue;
    const hopIn = swapInfoInputMint(si);
    const hopOut = swapInfoOutputMint(si);
    if (!hopIn || !hopOut || !routeLegMintMatches(hopOut, feeMint)) continue;

    const inRaw = parsePositiveBigInt(si.inAmount);
    const outRaw = parsePositiveBigInt(si.outAmount);
    if (!inRaw || !outRaw || outRaw === 0n) continue;

    const inUi = deps.rawAmountToUiNumber(inRaw.toString(), deps.getMintDecimals(hopIn));
    const outUi = deps.rawAmountToUiNumber(outRaw.toString(), deps.getMintDecimals(hopOut));
    if (!(inUi > 0 && outUi > 0)) continue;

    const feeInHopInUi = feeUi * (inUi / outUi);
    return convertFeeUiToOutputLeg(feeInHopInUi, hopIn, quote);
  }

  const inMint = quoteInputMint(quote);
  const swapRate = Number(quote.swapRate);
  if (routeLegMintMatches(feeMint, inMint) && Number.isFinite(swapRate) && swapRate > 0) {
    return feeUi * swapRate;
  }

  const feePrice = lookupMintPriceUsd(feeMint, quote);
  const outPrice = lookupMintPriceUsd(outMint, quote);
  if (Number.isFinite(feePrice) && feePrice > 0 && Number.isFinite(outPrice) && outPrice > 0) {
    return (feeUi * feePrice) / outPrice;
  }
  return null;
}

function getQuoteOutputFeeDeltaUi(quote: Record<string, unknown>): number | null {
  const outMint = quoteOutputMint(quote);
  if (!outMint) return null;
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastHopOut = plan.length > 0 ? parseRawAmountDigits(plan.at(-1)?.swapInfo?.outAmount) : null;
  const quoted =
    parseRawAmountDigits(quote._quotedOutAmount) ?? lastHopOut ?? parseRawAmountDigits(quote.outAmount);
  const net = parseRawAmountDigits(quote._simulatedOutAmount) ?? parseRawAmountDigits(quote.outAmount);
  if (!quoted || !net) return null;
  try {
    const q = BigInt(quoted);
    const n = BigInt(net);
    if (q <= n) return null;
    const feeUi = deps.rawAmountToUiNumber((q - n).toString(), deps.getMintDecimals(outMint));
    return Number.isFinite(feeUi) && feeUi > 0 ? feeUi : null;
  } catch {
    return null;
  }
}

function getQuoteDiagramOutputUsdSubline(quote: Record<string, unknown>): string | null {
  const ui = quote._swapUiUsd as { outputSwapUsd?: number; outputReclaimUsd?: number } | undefined;
  if (ui?.outputSwapUsd != null && Number(ui.outputSwapUsd) > 0) {
    const label = deps.formatSwapReceiveUsdLabel(Number(ui.outputSwapUsd));
    return label ? `≈ ${label}` : null;
  }

  const swapUsd = deps.getQuoteReceiveUsd(quote);
  if (swapUsd != null && swapUsd > 0) {
    const label = deps.formatSwapReceiveUsdLabel(swapUsd);
    return label ? `≈ ${label}` : null;
  }
  const reclaimUsd = sumQuoteRentReclaimUsd(quote);
  if (reclaimUsd > 0) {
    const label = deps.formatSwapReceiveUsdLabel(reclaimUsd);
    return label ? `≈ ${label}` : null;
  }
  return null;
}

function getQuoteDiagramOutputUsdTitle(quote: Record<string, unknown>): string | null {
  const ui = quote._swapUiUsd as { outputSwapUsd?: number; outputReclaimUsd?: number } | undefined;
  if (ui?.outputSwapUsd != null && Number(ui.outputSwapUsd) > 0) {
    const reclaimUsd = Number(ui.outputReclaimUsd ?? 0);
    const baseTitle = deps.quoteOutputPriceSourceTitle(quote);
    if (!(reclaimUsd > 0.001)) return baseTitle;
    const swapLabel = deps.formatSwapReceiveUsdLabel(Number(ui.outputSwapUsd));
    const reclaimLabel = deps.formatSwapReceiveUsdLabel(reclaimUsd);
    const parts: string[] = [];
    if (baseTitle) parts.push(baseTitle);
    if (swapLabel) parts.push(`swap output ${swapLabel}`);
    if (reclaimLabel) parts.push(`+ ATA/WSOL rent reclaimed ${reclaimLabel}`);
    return parts.join(' · ');
  }

  const reclaimUsd = sumQuoteRentReclaimUsd(quote);
  const baseTitle = deps.quoteOutputPriceSourceTitle(quote);
  if (!(reclaimUsd > 0.001)) return baseTitle;
  const swapUsd = deps.getQuoteReceiveUsd(quote);
  const swapLabel = swapUsd != null ? deps.formatSwapReceiveUsdLabel(swapUsd) : null;
  const reclaimLabel = deps.formatSwapReceiveUsdLabel(reclaimUsd);
  const parts: string[] = [];
  if (baseTitle) parts.push(baseTitle);
  if (swapLabel) parts.push(`swap output ${swapLabel}`);
  if (reclaimLabel) parts.push(`+ ATA/WSOL rent reclaimed ${reclaimLabel}`);
  return parts.join(' · ');
}

function computeFeeEquivalents(
  amountRaw: string,
  feeMint: string,
  quote: Record<string, unknown>,
): FeeAmountEquiv {
  const sellMint = quoteInputMint(quote);
  const inputSym = deps.getSwapInSym();
  const feeSym = mintSymbolSync(feeMint);
  const primary = deps.formatRawTokenAmount(amountRaw, feeMint).display;
  const feeUi = feeAmountToUi(amountRaw, feeMint);
  const foreign = isForeignFeeMint(feeMint, quote);

  let inputEquiv: string | null = null;
  let usd: string | null = null;

  if (feeUi != null) {
    const feePrice = lookupMintPriceUsd(feeMint, quote);
    if (Number.isFinite(feePrice) && feePrice > 0) {
      usd = deps.formatFeeEquivUsdFiatDisplay(feeUi * feePrice);
    }

    const usdNum = usd ? parseFeeEquivUsdNumber(usd) : null;
    if (foreign && usdNum != null) {
      inputEquiv = solEquivSublineFromUsd(usdNum, quote);
    } else {
      const sellLegUi = convertFeeUiToSellLeg(feeUi, feeMint, quote);
      const sellPrice = sellMint ? lookupMintPriceUsd(sellMint, quote) : NaN;
      if (sellLegUi != null && Number.isFinite(sellPrice) && sellPrice > 0) {
        inputEquiv = `≈ ${deps.formatFeeEquivSmallAmount(sellLegUi)} ${inputSym}`;
        if (!usd) {
          usd = deps.formatFeeEquivUsdFiatDisplay(sellLegUi * sellPrice);
        }
      } else if (usdNum != null && !foreign) {
        const solLine = solEquivSublineFromUsd(usdNum, quote);
        if (solLine) inputEquiv = solLine;
      }
    }
  }

  return { feeMint, feeSym, primary, inputEquiv, inputSym, usd };
}

function computeFeeUsdNumeric(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
): number | null {
  // ix-builder enrichment carries each fee item's USD — print it, don't recompute.
  if (typeof item.usd === 'number' && Number.isFinite(item.usd) && item.usd > 0) {
    return item.usd;
  }

  const feeUi = feeAmountToUi(item.amountRaw, item.mint);
  if (feeUi == null || feeUi <= 0) return null;

  const feePrice = lookupMintPriceUsd(item.mint, quote);
  if (Number.isFinite(feePrice) && feePrice > 0) {
    return feeUi * feePrice;
  }

  if (isForeignFeeMint(item.mint, quote) && isSolMint(item.mint)) {
    const solPrice = lookupSolPriceUsd(quote);
    if (Number.isFinite(solPrice) && solPrice > 0) return feeUi * solPrice;
  }

  const sellMint = quoteInputMint(quote);
  const sellLegUi = convertFeeUiToSellLeg(feeUi, item.mint, quote);
  const sellPrice = sellMint ? lookupMintPriceUsd(sellMint, quote) : NaN;
  if (sellLegUi != null && sellLegUi > 0 && Number.isFinite(sellPrice) && sellPrice > 0) {
    return sellLegUi * sellPrice;
  }

  const equiv = computeFeeEquivalents(item.amountRaw, item.mint, quote);
  return equiv.usd ? parseFeeEquivUsdNumber(equiv.usd) : null;
}

function formatFeeEquivDetailText(equiv: FeeAmountEquiv, positive = false): string {
  const sign = positive ? '+' : '−';
  const parts = [`${sign}${equiv.primary} ${equiv.feeSym}`];
  if (equiv.inputEquiv) parts.push(equiv.inputEquiv);
  if (equiv.usd) parts.push(equiv.usd);
  return parts.join(' · ');
}

function feeChipVariant(label: string, reclaim = false): string {
  if (reclaim) return 'fee-token-acc-rent-reclaim';
  const l = label.toLowerCase();
  if (l.includes('protocol')) return 'fee-protocol';
  if (l.includes('creator')) return 'fee-creator';
  if (l.includes('lp fee') || l === 'lp fee') return 'fee-pool-deduct';
  if (l.includes('priority')) return 'fee-route';
  if (l.includes('slippage') || l.includes('spread')) return 'fee-pool-deduct';
  if (l.includes('route')) return 'fee-route';
  if (l.includes('pool')) return 'fee-pool-deduct';
  if (l.includes('acc rent') || l.includes('token acc rent') || l.includes('pda rent') || l.endsWith(' rent fee')) {
    return 'fee-token-acc-rent';
  }
  return 'fee';
}

function feeChipVariantForItem(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
  hopOutMint: string,
  reclaim = false,
): string {
  if (reclaim) return 'fee-token-acc-rent-reclaim';
  if (hopOutMint && isDeductedFromPoolFeeItem(item, quote, hopOutMint)) {
    return 'fee-pool-deduct';
  }
  return feeChipVariant(displayFeeItemLabel(item), reclaim);
}

function renderRoutingFeeChip(
  label: string,
  equiv: FeeAmountEquiv,
  variant: string,
  title: string,
  positive = false,
): string {
  const usdPrefix = positive ? '+' : '';
  const usdInChip = equiv.usd
    ? `${usdPrefix}$${stripFiatPrefixForChip(equiv.usd)} USD`
    : '—';
  const baseBelow = isAccRentFeeLabel(label) || label.endsWith(' Rent Fee')
    ? formatAccRentFeeSolSubline(equiv)
    : equiv.inputEquiv
      ? stripApproxPrefix(equiv.inputEquiv)
      : null;
  const basePrefix = positive && baseBelow && baseBelow !== '—' ? '+' : '';
  return `<div class="routing-chip-stack routing-chip-stack--${variant}" title="${deps.escapeHtml(title)}">
    <span class="routing-chip-top routing-chip-top--fee-label">${deps.escapeHtml(label)}</span>
    <div class="routing-pill routing-pill--chip routing-pill--chip-fee">
      <span class="routing-chip-amt routing-chip-amt--usd">${deps.escapeHtml(usdInChip)}</span>
    </div>
    ${
      baseBelow
        ? `<span class="routing-chip-bottom routing-chip-bottom--base">${deps.escapeHtml(`${basePrefix}${baseBelow}`)}</span>`
        : ''
    }
  </div>`;
}

const ROUTING_PLACEHOLDER_DASH = '—';

function placeholderRoutingFeeEquiv(tokenSubline = `${ROUTING_PLACEHOLDER_DASH} SOL`): FeeAmountEquiv {
  return {
    feeMint: '',
    feeSym: ROUTING_PLACEHOLDER_DASH,
    primary: ROUTING_PLACEHOLDER_DASH,
    inputEquiv: tokenSubline,
    inputSym: 'SOL',
    usd: ROUTING_PLACEHOLDER_DASH,
  };
}

function renderMockAccRentAboveBranch(): string {
  const mockItem: HopFeeItemLite = {
    label: ACC_RENT_FEE_LABEL,
    amountRaw: '0',
    mint: WSOL_MINT,
    accountMint: WSOL_MINT,
    destinationKind: 'new_token_account',
  };
  const label = accRentFeeDisplayLabel(mockItem);
  const chip = renderRoutingFeeChip(
    label,
    placeholderRoutingFeeEquiv(),
    feeChipVariant(label),
    label,
  );
  return `<div class="routing-acc-rent-above" aria-label="Account rent fee at this hop">
    <div class="routing-acc-rent-cards"><div class="routing-fee-slot routing-fee-slot--acc-rent">${chip}</div></div>
    <div class="routing-acc-rent-connectors" aria-hidden="true">${renderRoutingFeeConnectors(1)}</div>
  </div>`;
}

function renderMockRoutingFeeBranch(outputSym = 'SOL'): string {
  const walletLabels = [PRIORITY_FEE_LABEL, 'Protocol fee'];
  const entries: Array<{ label: string; equiv: FeeAmountEquiv }> = [
    ...walletLabels.map((label) => ({
      label,
      equiv: placeholderRoutingFeeEquiv(),
    })),
    {
      label: 'Pool fee',
      equiv: placeholderRoutingFeeEquiv(`${ROUTING_PLACEHOLDER_DASH} ${outputSym}`),
    },
  ];
  const feeCount = entries.length;
  const slots = entries
    .map(({ label, equiv }) => {
      const chip = renderRoutingFeeChip(
        label,
        equiv,
        feeChipVariant(label),
        label,
      );
      return `<div class="routing-fee-slot">${chip}</div>`;
    })
    .join('');

  return `<div class="routing-fee-branch routing-fee-branch--${feeCount} routing-fee-branch--placeholder" aria-label="Fees deducted at this hop">
    <div class="routing-fee-connectors" aria-hidden="true">${renderRoutingFeeConnectors(feeCount)}</div>
    <div class="routing-fee-cards">${slots}</div>
  </div>`;
}

function renderHopFeeAmountHtml(
  mint: string,
  amountRaw: string,
  sym: string,
  placeholder = false,
  positive = false,
): string {
  const symCls = tokenSymColorClass(mint, sym);
  const safeSym = deps.escapeHtml(sym);
  const display = placeholder
    ? ROUTING_PLACEHOLDER_DASH
    : deps.escapeHtml(formatHopFeeTableAmount(amountRaw, mint));
  const sign = positive ? '+' : '−';
  return `<span class="hop-fee-row__amt-val ${symCls}">${sign}${display} ${safeSym}</span>`;
}

function renderMockHopFeeRow(
  label: string,
  destHtml: string,
  feeMint: string,
  feeSym: string,
): string {
  const variant = feeChipVariant(label);
  return `<div class="hop-fee-row hop-fee-row--${variant}">
    <span class="hop-fee-row__label">${deps.escapeHtml(label)}</span>
    <span class="hop-fee-row__dest">${destHtml}</span>
    <span class="hop-fee-row__amt"><span>${renderHopFeeAmountHtml(feeMint, '', feeSym, true)}</span></span>
    <span class="hop-fee-row__usd"><span>${ROUTING_PLACEHOLDER_DASH}</span></span>
  </div>`;
}

function renderMockHopPlanFeesSection(
  walletFeeMint: string,
  walletFeeSym: string,
  outputFeeMint: string,
  outputFeeSym: string,
): string {
  const walletRows = [
    renderMockHopFeeRow(
      PRIORITY_FEE_LABEL,
      renderMockFeeDestBracketOnly('priority', 'Solana Validators/RPC'),
      walletFeeMint,
      walletFeeSym,
    ),
    renderMockHopFeeRow(
      'Protocol fee',
      renderMockFeeDestBracketOnly('recipient', 'Fee Recipient'),
      walletFeeMint,
      walletFeeSym,
    ),
    renderMockHopFeeRow(
      'WSOL Rent Fee',
      renderMockFeeDestBracketOnly('ata', 'WSOL Account'),
      walletFeeMint,
      walletFeeSym,
    ),
  ].join('');
  const outputRows = renderMockHopFeeRow(
    'Pool fee',
    renderMockFeeDestBracketOnly('pool', 'Pool Vault'),
    outputFeeMint,
    outputFeeSym,
  );
  const groupsHtml =
    `<div class="hop-fee-group"><div class="hop-fee-group__title">Paid from wallet</div>${walletRows}</div>` +
    `<div class="hop-fee-group"><div class="hop-fee-group__title">Deducted from pool</div>${outputRows}</div>`;
  const totalHtml = renderHopFeesTotalsChipsMock(walletFeeSym, outputFeeSym);
  return `<section class="swap-hop-panel swap-hop-panel--fees" aria-label="Hop fees">
    <div class="swap-hop-panel__head">
      <h5 class="swap-hop-panel__title">Fees</h5>
      ${totalHtml}
    </div>
    ${groupsHtml}
  </section>`;
}

function renderMockRouteMarketNode(
  meta: RouteHopMeta,
  leg: RouteHopLeg,
  loading = false,
): string {
  const si = meta.step.swapInfo;
  const dexHtml = loading ? deps.renderLoadingSpinner('sm') : deps.escapeHtml(si?.label ?? ROUTING_PLACEHOLDER_DASH);
  const sym = deps.escapeHtml(leg.outSym);
  const accRentAbove = renderMockAccRentAboveBranch();
  const feeBranchBelow = renderMockRoutingFeeBranch(leg.outSym);
  const railNode = `<div class="routing-market-node">
    ${renderHopIndexBadge(meta.label)}
      <div class="routing-pill routing-pill--hop">
      ${renderRoutingTokenIcon(leg.outMint, leg.outSym)}
      <span class="routing-token-sym">${sym}</span>
      </div>
    <div class="routing-dex-caption">${dexHtml}</div>
  </div>`;
  const hopOnRail = `<div class="routing-hop-on-rail">${accRentAbove}${railNode}</div>`;
  return `<div class="routing-hop-column routing-hop-column--has-fees routing-hop-column--has-acc-rent-above">
    ${hopOnRail}
    ${feeBranchBelow}
    </div>`;
}

function renderHopFeeChip(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
  hopOutMint = '',
): string {
  const label = displayFeeItemLabel(item);
  const equiv = feeEquivForHopItem(item, quote);
  const reclaim = isAccRentReclaimItem(item);
  const title = formatFeeEquivDetailText(equiv, reclaim);
  return renderRoutingFeeChip(
    label,
    equiv,
    feeChipVariantForItem(item, quote, hopOutMint, reclaim),
    title,
    reclaim,
  );
}

function isLikelySolanaPubkey(value: string | undefined): boolean {
  const s = value?.trim() ?? '';
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function quoteWalletAddress(quote: Record<string, unknown>): string {
  const fromQuote =
    typeof quote._walletAddress === 'string'
      ? quote._walletAddress.trim()
      : typeof quote.accountAddress === 'string'
        ? quote.accountAddress.trim()
        : '';
  if (fromQuote) return fromQuote;
  return deps.getWalletSnapshot().trim() || deps.getWalletAddress().trim();
}

interface FeeDestinationRenderCtx {
  walletAddress?: string;
  ammKey?: string;
}

function solscanAccountUrl(address: string): string {
  return `https://solscan.io/account/${encodeURIComponent(address.trim())}`;
}

function solscanTokenUrl(mint: string): string {
  return `https://solscan.io/token/${encodeURIComponent(displayHopMintAddress(mint).trim())}`;
}

function renderFeeDestinationAddrLine(addr: string): string {
  const trimmed = addr.trim();
  if (!isLikelySolanaPubkey(trimmed)) return '';
  const display = deps.escapeHtml(deps.truncate(trimmed, 8, 8));
  const url = deps.escapeHtml(solscanAccountUrl(trimmed));
  return `<a class="swap-hop-fee-dest__addr swap-hop-fee-dest__addr-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${deps.escapeHtml(trimmed)}">${display}</a>`;
}

function displayHopMintAddress(mint: string): string {
  const trimmed = mint.trim();
  return trimmed === NATIVE_SOL_MINT ? WSOL_MINT : trimmed;
}

function hopFlowPartClass(mint: string, sym?: string): string {
  return `swap-hop-detail-row__flow-part ${tokenSymColorClass(mint, sym?.trim() || undefined)}`;
}

function renderHopMarketPairSuffix(
  inSym: string,
  outSym: string,
  inMint: string,
  outMint: string,
): string {
  const inLabel = inSym?.trim();
  const outLabel = outSym?.trim();
  if (!inLabel || inLabel === '—' || !outLabel || outLabel === '—') return '';
  const inCls = tokenSymColorClass(inMint, inLabel);
  const outCls = tokenSymColorClass(outMint, outLabel);
  return `<span class="swap-hop-market-row__pair"><span class="swap-hop-market-row__pair-wrap"> (</span><span class="swap-hop-market-row__pair-sym ${inCls}">${deps.escapeHtml(inLabel)}</span><span class="swap-hop-market-row__pair-sep">-</span><span class="swap-hop-market-row__pair-sym ${outCls}">${deps.escapeHtml(outLabel)}</span><span class="swap-hop-market-row__pair-wrap">)</span></span>`;
}

function renderHopMarketDetailAddressHtml(marketRaw: string): string {
  if (isLikelySolanaPubkey(marketRaw)) {
    const url = deps.escapeHtml(solscanAccountUrl(marketRaw));
    return `<a class="swap-hop-market-row__addr swap-hop-market-row__addr-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${deps.escapeHtml(marketRaw)}">${deps.escapeHtml(marketRaw)}</a>`;
  }
  return `<span class="swap-hop-market-row__addr">${deps.escapeHtml(marketRaw)}</span>`;
}

function resolveFeeDestinationAddress(
  item: HopFeeItemLite,
  ctx?: FeeDestinationRenderCtx,
): string {
  const direct = item.destinationAddress?.trim() ?? '';
  if (isLikelySolanaPubkey(direct)) return direct;
  const ammKey = ctx?.ammKey?.trim() ?? '';
  if (item.destinationKind === 'lp_pool' && isLikelySolanaPubkey(ammKey)) return ammKey;
  const wallet = ctx?.walletAddress?.trim() ?? '';
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  if (
    item.destinationKind === 'input_wallet' &&
    isLikelySolanaPubkey(wallet) &&
    label !== 'route fee' &&
    label !== 'priority fee'
  ) {
    return wallet;
  }
  return '';
}

const FEE_DEST_KIND_META: Record<string, { label: string; mod: string }> = {
  lp_pool: { label: 'Pool Vault', mod: 'pool' },
  new_token_account: { label: 'Token Account', mod: 'ata' },
  closed_token_account: { label: 'Token Account', mod: 'ata' },
  fee_recipient: { label: 'Fee Recipient', mod: 'recipient' },
  input_wallet: { label: 'Your wallet', mod: 'input-wallet' },
  network_priority: { label: 'Solana Validators/RPC', mod: 'priority' },
  output_deduction: { label: 'Output deduction', mod: 'deduct' },
};

function renderFeeDestBracketTag(label: string): string {
  return `<span class="hop-fee-dest__kind-tag">(${deps.escapeHtml(label)})</span>`;
}

function renderMockFeeDestBracketOnly(mod: string, label: string): string {
  return `<span class="hop-fee-dest hop-fee-dest--${mod}">${renderFeeDestBracketTag(label)}</span>`;
}

function renderMockFeeDestBracket(mod: string, label: string, addr = ROUTING_PLACEHOLDER_DASH): string {
  return `<span class="hop-fee-dest hop-fee-dest--${mod}"><span class="hop-fee-dest__note">${addr}</span> ${renderFeeDestBracketTag(label)}</span>`;
}

/** One-line destination: address first, then kind in brackets — or kind/note fallback. */
function renderFeeDestinationInline(item: HopFeeItemLite, ctx?: FeeDestinationRenderCtx): string {
  const meta = item.destinationKind ? FEE_DEST_KIND_META[item.destinationKind] : undefined;
  const addr = resolveFeeDestinationAddress(item, ctx);
  const addrHtml = addr ? renderFeeDestinationAddrLine(addr) : '';
  const note =
    item.destinationKind === 'network_priority' ||
    item.destinationKind === 'new_token_account' ||
    item.destinationKind === 'closed_token_account'
      ? ''
      : item.destinationNote?.trim();

  if (!meta && !addrHtml) {
    if (!note) return '';
    return `<span class="hop-fee-dest"><span class="hop-fee-dest__note">${deps.escapeHtml(note)}</span></span>`;
  }

  const mod = meta?.mod ?? 'generic';
  if (addrHtml && meta) {
    const kindLabel =
      item.destinationKind === 'new_token_account' ||
      item.destinationKind === 'closed_token_account'
        ? accRentDestBracketLabel(item)
        : meta.label;
    return `<span class="hop-fee-dest hop-fee-dest--${mod}">${addrHtml} ${renderFeeDestBracketTag(kindLabel)}</span>`;
  }

  if (addrHtml) {
    return `<span class="hop-fee-dest">${addrHtml}</span>`;
  }

  if (meta && !note) {
    const kindLabel =
      item.destinationKind === 'new_token_account' ||
      item.destinationKind === 'closed_token_account'
        ? accRentDestBracketLabel(item)
        : meta.label;
    return `<span class="hop-fee-dest hop-fee-dest--${mod}">${renderFeeDestBracketTag(kindLabel)}</span>`;
  }

  const kindHtml = meta
    ? `<span class="hop-fee-dest__kind">${deps.escapeHtml(meta.label)}</span>`
    : '';
  const tail = note ? `<span class="hop-fee-dest__note">${deps.escapeHtml(note)}</span>` : '';
  const sep = kindHtml && tail ? '<span class="hop-fee-dest__sep" aria-hidden="true">·</span>' : '';
  return `<span class="hop-fee-dest hop-fee-dest--${mod}">${kindHtml}${sep}${tail}</span>`;
}

function formatHopFeeRowUsdDisplay(
  item: HopFeeItemLite,
  equiv: FeeAmountEquiv,
  quote: Record<string, unknown>,
): string {
  const usdNum = computeFeeUsdNumeric(item, quote) ?? parseFeeEquivUsdNumber(equiv.usd);
  if (usdNum == null || usdNum <= 0) return '—';
  return `$${deps.formatHopFeeTableUsdAmount(usdNum)}`;
}

/** Compact fee row: label · destination · token amount · USD. */
function renderHopFeeRow(
  item: HopFeeItemLite,
  equiv: FeeAmountEquiv,
  destCtx?: FeeDestinationRenderCtx,
  quote?: Record<string, unknown>,
  hopOutMint = '',
): string {
  const reclaim = isAccRentReclaimItem(item);
  const label = displayFeeItemLabel(item);
  const variant =
    quote && hopOutMint
      ? feeChipVariantForItem(item, quote, hopOutMint, reclaim)
      : feeChipVariant(label, reclaim);
  const titleParts = [formatFeeEquivDetailText(equiv, reclaim)];
  const note = item.destinationNote?.trim();
  if (note) titleParts.push(note);
  const amtHtml = renderHopFeeAmountHtml(item.mint, item.amountRaw, equiv.feeSym, false, reclaim);
  const usdRaw = quote ? formatHopFeeRowUsdDisplay(item, equiv, quote) : equiv.usd ? `$${stripFiatPrefixForChip(equiv.usd)}` : '—';
  const usd = reclaim && usdRaw !== '—' ? `+${usdRaw}` : usdRaw;
  const usdMod = reclaim ? 'hop-fee-row__usd--credit' : 'hop-fee-row__usd--debit';
  return `<div class="hop-fee-row hop-fee-row--${variant}" title="${deps.escapeHtml(titleParts.join(' — '))}">
    <span class="hop-fee-row__label">${deps.escapeHtml(label)}</span>
    <span class="hop-fee-row__dest">${renderFeeDestinationInline(item, destCtx)}</span>
    <span class="hop-fee-row__amt"><span>${amtHtml}</span></span>
    <span class="hop-fee-row__usd ${usdMod}"><span>${deps.escapeHtml(usd)}</span></span>
  </div>`;
}

function renderHopPlanFeesSection(
  hopFees: HopFeeBreakdownLite,
  leg: RouteHopLeg,
  quote: Record<string, unknown>,
  feeMint: string,
  feeAmt: string | null,
  ammKey?: string,
  reclaimItems: HopFeeItemLite[] = [],
): string {
  const destCtx: FeeDestinationRenderCtx = {
    walletAddress: quoteWalletAddress(quote),
    ammKey: ammKey?.trim() || undefined,
  };
  const rowData = flattenHopFeeItems(hopFees.items).map((item) => ({
    item,
    equiv: feeEquivForHopItem(item, quote),
  }));

  const walletRows: string[] = [];
  const poolRows: string[] = [];
  const reclaimRowsFromHopFees: string[] = [];
  for (const { item, equiv } of rowData) {
    const row = renderHopFeeRow(item, equiv, destCtx, quote, leg.outMint);
    if (isAccRentReclaimItem(item)) {
      reclaimRowsFromHopFees.push(row);
    } else if (isDeductedFromPoolFeeItem(item, quote, leg.outMint)) {
      poolRows.push(row);
    } else {
      walletRows.push(row);
    }
  }

  const extraReclaimItems = dedupeSyntheticReclaimItems(hopFees.items, reclaimItems);
  const reclaimRows = [
    ...reclaimRowsFromHopFees,
    ...extraReclaimItems.map((item) =>
      renderHopFeeRow(item, feeEquivForHopItem(item, quote), destCtx, quote),
    ),
  ];

  const group = (title: string, rows: string[]) =>
    rows.length
      ? `<div class="hop-fee-group"><div class="hop-fee-group__title">${deps.escapeHtml(title)}</div>${rows.join('')}</div>`
      : '';
  const groupsHtml =
    group('Paid from wallet', walletRows) +
    group('Returned to wallet', reclaimRows) +
    group('Deducted from pool', poolRows);

  const totalHtml = renderHopFeesTotalsChips(rowData, quote, reclaimItems);

  return `<section class="swap-hop-panel swap-hop-panel--fees" aria-label="Hop fees">
    <div class="swap-hop-panel__head">
      <h5 class="swap-hop-panel__title">Fees</h5>
      ${totalHtml}
    </div>
    ${groupsHtml}
  </section>`;
}

function stripApproxPrefix(s: string): string {
  return s.replace(/^≈\s*/, '').trim();
}

function routePlanHasHopFees(plan: VybeRoutePlanStepLite[]): boolean {
  return plan.some((s) => (getHopFeeBreakdown(s)?.items.length ?? 0) > 0);
}

function routePlanHasAccRentFee(plan: VybeRoutePlanStepLite[]): boolean {
  for (const step of plan) {
    for (const item of getHopFeeDisplayItems(step)) {
      if (isAccRentWalletFeeItem(item)) return true;
    }
  }
  return false;
}

function routePlanMaxAccRentAboveCount(
  plan: VybeRoutePlanStepLite[],
  quote: Record<string, unknown>,
): number {
  let max = 0;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    const isLastHop = i === plan.length - 1;
    const count = hopAccRentDisplayItems(step, quote, i, isLastHop).length;
    if (count > max) max = count;
  }
  return max;
}

function routePlanMaxRouteFeeBelowCount(plan: VybeRoutePlanStepLite[]): number {
  let max = 0;
  for (const step of plan) {
    const { routeFeeItems } = partitionHopFeeDisplayItems(getHopFeeDisplayItems(step));
    if (routeFeeItems.length > max) max = routeFeeItems.length;
  }
  return max;
}

function routePlanHasAccRentAbove(
  plan: VybeRoutePlanStepLite[],
  quote: Record<string, unknown>,
): boolean {
  if (routePlanHasAccRentFee(plan)) return true;
  return quoteHasAtaRentReclaim(quote);
}

function stripFiatPrefixForChip(usd: string): string {
  return usd.replace(/^~?\$/, '').trim();
}

function parseFeeEquivUsdNumber(usd: string | null | undefined): number | null {
  if (!usd) return null;
  const n = Number(stripFiatPrefixForChip(usd).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseInputEquivUi(inputEquiv: string | null | undefined): number | null {
  if (!inputEquiv) return null;
  const stripped = stripApproxPrefix(inputEquiv);
  const match = stripped.match(/^([\d,.]+)/);
  if (!match) return null;
  const n = Number(match[1]!.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Base-column UI amount for one fee row (sell leg, or SOL via USD for foreign-mint fees). */
function feeTableBaseLegUi(
  item: HopFeeItemLite,
  equiv: FeeAmountEquiv,
  quote: Record<string, unknown>,
): number | null {
  if (isAccRentWalletFeeItem(item)) {
    return feeAmountToUi(item.amountRaw, item.mint);
  }
  const fromEquiv = parseInputEquivUi(equiv.inputEquiv);
  if (fromEquiv != null) return fromEquiv;
  const usdNum = parseFeeEquivUsdNumber(equiv.usd);
  if (usdNum != null && isForeignFeeMint(item.mint, quote)) {
    const solUi = convertFeeUsdToSolUi(usdNum, quote);
    if (solUi != null) return solUi;
  }
  const feeUi = feeAmountToUi(item.amountRaw, item.mint);
  if (feeUi == null) return null;
  return convertFeeUiToSellLeg(feeUi, item.mint, quote);
}

interface HopFeeMintTotal {
  mint: string;
  sym: string;
  display: string;
  feeCount: number;
}

function sumHopPlanFeeTotalsByMint(
  rowData: Array<{ item: HopFeeItemLite; equiv: FeeAmountEquiv }>,
): HopFeeMintTotal[] {
  const totals = new Map<string, bigint>();
  const counts = new Map<string, number>();
  for (const { item } of rowData) {
    if (isAccRentReclaimItem(item)) continue;
    const mint = item.mint.trim();
    if (!mint || !item.amountRaw || !/^\d+$/.test(item.amountRaw)) continue;
    try {
      totals.set(mint, (totals.get(mint) ?? 0n) + BigInt(item.amountRaw));
      counts.set(mint, (counts.get(mint) ?? 0) + 1);
    } catch {
      continue;
    }
  }

  const rows: HopFeeMintTotal[] = [];
  for (const [mint, total] of totals) {
    if (total <= 0n) continue;
    const display = formatHopFeeTableAmount(total.toString(), mint);
    if (display === '—') continue;
    rows.push({
      mint,
      sym: mintSymbolSync(mint),
      display,
      feeCount: counts.get(mint) ?? 1,
    });
  }

  rows.sort((a, b) => {
    const aSol = isSolMint(a.mint) ? 0 : 1;
    const bSol = isSolMint(b.mint) ? 0 : 1;
    if (aSol !== bSol) return aSol - bSol;
    return a.sym.localeCompare(b.sym);
  });
  return rows;
}

function hopFeeCountLabel(feeCount: number): string {
  return feeCount > 1 ? 'Fees' : 'Fee';
}

function renderHopFeeTotalChip(
  mint: string,
  sym: string,
  display: string,
  feeCount = 1,
): string {
  const boxCls = tokenBoxColorClass(mint, sym);
  const symCls = tokenSymColorClass(mint, sym);
  const safeSym = deps.escapeHtml(sym);
  const feeLabel = hopFeeCountLabel(feeCount);
  const amt = deps.escapeHtml(display.startsWith('−') ? display : `−${display}`);
  return `<span class="swap-pair-chg hop-fees-total-chip ${boxCls}" title="Total ${safeSym} ${feeLabel.toLowerCase()} this hop"><span class="hop-fees-total-chip__amt">${amt}</span> <span class="hop-fees-total-chip__sym ${symCls}">${safeSym}</span> <span class="hop-fees-total-chip__kind">(${feeLabel})</span></span>`;
}

function sumHopPlanFeeTotalUsd(
  rowData: Array<{ item: HopFeeItemLite; equiv: FeeAmountEquiv }>,
  quote: Record<string, unknown>,
): number | null {
  let totalUsd = 0;
  let found = false;
  for (const { item, equiv } of rowData) {
    if (isAccRentReclaimItem(item)) continue;
    const usdN = computeFeeUsdNumeric(item, quote) ?? parseFeeEquivUsdNumber(equiv.usd);
    if (usdN != null && usdN > 0) {
      totalUsd += usdN;
      found = true;
    }
  }
  if (!found || totalUsd <= 0) return null;
  return totalUsd;
}

function formatHopFeeUsdTotalDisplay(usd: number): string {
  if (usd < 0.000001) return '< $0.01';
  if (usd < 0.01) return `−$${deps.formatHopFeeTableUsdAmount(usd)}`;
  return `−$${deps.formatSwapPayUsdAmount(usd)}`;
}

function renderHopFeeUsdTotalChip(usd: number | null, placeholder = false): string {
  if (!placeholder && (usd == null || usd <= 0)) return '';
  const amt = placeholder ? ROUTING_PLACEHOLDER_DASH : formatHopFeeUsdTotalDisplay(usd!);
  return `<span class="swap-pair-chg hop-fees-total-chip hop-fees-total-chip--usd" title="Combined USD total fees this hop"><span class="hop-fees-total-chip__amt">${deps.escapeHtml(amt)}</span> <span class="hop-fees-total-chip__sym">USD</span> <span class="hop-fees-total-chip__kind">(Total Fees)</span></span>`;
}

function renderHopFeesTotalsChips(
  rowData: Array<{ item: HopFeeItemLite; equiv: FeeAmountEquiv }>,
  quote: Record<string, unknown>,
  reclaimItems: HopFeeItemLite[] = [],
): string {
  const totals = sumHopPlanFeeTotalsByMint(rowData);
  const currencyChips = totals
    .map(({ mint, sym, display, feeCount }) => renderHopFeeTotalChip(mint, sym, display, feeCount))
    .join('');
  const usdChip = renderHopFeeUsdTotalChip(sumHopPlanFeeTotalUsd(rowData, quote));
  if (!currencyChips && !usdChip) return '';
  return `<div class="hop-fees-totals" aria-label="Fee totals by currency">${currencyChips}${usdChip}</div>`;
}

function renderHopFeesTotalsChipsMock(walletSym: string, outputSym: string): string {
  const walletMint = walletSym.toUpperCase() === 'SOL' ? NATIVE_SOL_MINT : '';
  const chips = [
    renderHopFeeTotalChip(walletMint, walletSym, ROUTING_PLACEHOLDER_DASH, 3),
    renderHopFeeTotalChip('', outputSym, ROUTING_PLACEHOLDER_DASH, 1),
    renderHopFeeUsdTotalChip(null, true),
  ].join('');
  return `<div class="hop-fees-totals" aria-label="Fee totals by currency">${chips}</div>`;
}

/** Native amount total when every row shares one mint; otherwise mixed-mint fees cannot be summed. */
function sumHopPlanFeeTableNativeAmount(
  rowData: Array<{ item: HopFeeItemLite; equiv: FeeAmountEquiv }>,
): { display: string; sym: string } | null {
  const mints = new Set(rowData.map(({ item }) => item.mint.trim()).filter(Boolean));
  if (mints.size !== 1) return null;
  const mint = [...mints][0]!;
  let total = 0n;
  for (const { item } of rowData) {
    if (!item.amountRaw || !/^\d+$/.test(item.amountRaw)) continue;
    try {
      total += BigInt(item.amountRaw);
    } catch {
      return null;
    }
  }
  if (total <= 0n) return null;
  const formatted = formatHopFeeTableAmount(total.toString(), mint);
  if (formatted === '—') return null;
  return { display: formatted, sym: mintSymbolSync(mint) };
}

/** Sum per-row USD + wallet-debited input-leg fees (excludes output-side pool/route cuts). */
function sumHopPlanFeeTableTotals(
  rowData: Array<{ item: HopFeeItemLite; equiv: FeeAmountEquiv }>,
  quote: Record<string, unknown>,
): (FeeAmountEquiv & { amountDisplay: string }) | null {
  if (rowData.length <= 1) return null;

  let totalUsd = 0;
  let walletBaseUi = 0;
  let foundUsd = false;
  let foundWalletBase = false;
  const inputSym = deps.getSwapInSym();
  const sellMint = quoteInputMint(quote) ?? '';

  for (const { item, equiv } of rowData) {
    const usdN = computeFeeUsdNumeric(item, quote) ?? parseFeeEquivUsdNumber(equiv.usd);
    const includeUsd =
      usdN != null &&
      usdN > 0 &&
      (isWalletCostFeeItem(item, quote) ||
        isAccRentWalletFeeItem(item) ||
        !isOutputSideFeeDisplayItem(item) ||
        isInputSideWalletFeeItem(item, sellMint));
    if (includeUsd) {
      totalUsd += usdN;
      foundUsd = true;
    }
    if (
      !sellMint ||
      (!isHopFeeTableWalletColumnItem(item, sellMint, quote) &&
        !isInputSideWalletFeeItem(item, sellMint))
    ) {
      continue;
    }
    const baseUi = feeTableBaseLegUi(item, equiv, quote);
    if (baseUi != null && baseUi > 0) {
      walletBaseUi += baseUi;
      foundWalletBase = true;
    }
  }

  if (!foundUsd && !foundWalletBase) return null;

  const nativeTotal = sumHopPlanFeeTableNativeAmount(rowData);
  const walletFmt = foundWalletBase ? deps.formatFeeEquivSmallAmount(walletBaseUi) : '—';
  const amountDisplay = nativeTotal
    ? `−${nativeTotal.display} ${nativeTotal.sym}`
    : '—';

  return {
    feeMint: sellMint,
    feeSym: inputSym,
    primary: walletFmt,
    inputEquiv: foundWalletBase ? `${walletFmt} ${inputSym}` : null,
    inputSym,
    usd: foundUsd ? `~$${deps.formatSwapPayUsdAmount(totalUsd)}` : null,
    amountDisplay,
  };
}

function renderRoutingFeeConnectors(
  feeCount: number,
  spread: 'default' | 'compact' = 'default',
): string {
  const vbW = 248;
  const vbH = 72;
  const cx = vbW / 2;
  const barY = 22;
  const endY = vbH;
  const r = 8;

  const dropXs =
    spread === 'compact'
      ? feeCount === 2
        ? [vbW * 0.4, vbW * 0.6]
        : feeCount === 3
          ? [vbW * 0.32, vbW * 0.5, vbW * 0.68]
          : feeCount >= 4
            ? [vbW * 0.26, vbW * 0.42, vbW * 0.58, vbW * 0.74].slice(0, feeCount)
            : [cx]
      : feeCount === 2
        ? [vbW * 0.25, vbW * 0.75]
        : feeCount === 3
          ? [vbW / 6, vbW / 2, (vbW * 5) / 6]
          : feeCount >= 4
            ? [vbW * 0.12, vbW * 0.38, vbW * 0.62, vbW * 0.88].slice(0, feeCount)
            : [cx];

  const segments: string[] = [];

  if (feeCount === 1) {
    segments.push(`M ${cx} 0 L ${cx} ${endY}`);
  } else {
    segments.push(`M ${cx} 0 L ${cx} ${barY}`);
    const sorted = [...dropXs].sort((a, b) => a - b);
    const barLeft = sorted[0]! + r;
    const barRight = sorted[sorted.length - 1]! - r;
    if (barRight > barLeft) {
      segments.push(`M ${barLeft} ${barY} L ${barRight} ${barY}`);
    }
    for (const x of dropXs) {
      if (x < cx - 0.5) {
        segments.push(`M ${x + r} ${barY} A ${r} ${r} 0 0 0 ${x} ${barY + r} L ${x} ${endY}`);
      } else if (x > cx + 0.5) {
        segments.push(`M ${x - r} ${barY} A ${r} ${r} 0 0 1 ${x} ${barY + r} L ${x} ${endY}`);
      } else {
        segments.push(`M ${x} ${barY} L ${x} ${endY}`);
      }
    }
  }

  const d = segments.join(' ');
  return `<svg class="routing-fee-svg" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="#3f3f46" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linecap="butt" stroke-linejoin="miter"/>
  </svg>`;
}

function isEphemeralBridgeWsolReclaimItem(
  item: HopFeeItemLite,
  plan: VybeRoutePlanStepLite[],
  hopIdx: number,
): boolean {
  if (!isAccRentReclaimItem(item)) return false;
  if (!isSolMint(accRentAccountMint(item))) return false;
  const step = plan[hopIdx];
  const inMint = step?.swapInfo?.inputMintAddress;
  if (!inMint || !isSolMint(String(inMint))) return false;
  const prevOut = plan[hopIdx - 1]?.swapInfo?.outputMintAddress;
  return Boolean(prevOut && isSolMint(String(prevOut)));
}

function hopAccRentDisplayItems(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  planIndex: number,
  isLastHop: boolean,
): HopFeeItemLite[] {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const { accRentItems } = partitionHopFeeDisplayItems(getHopFeeDisplayItems(step));
  let items = accRentItems.some(isAccRentReclaimItem)
    ? accRentItems
    : (() => {
        const synthetic = getHopAtaRentReclaimItems(quote, planIndex, isLastHop);
        if (synthetic.length === 0) return accRentItems;
        return dedupeHopFeeDisplayItems([...accRentItems, ...synthetic]);
      })();
  items = items.filter((item) => !isEphemeralBridgeWsolReclaimItem(item, plan, planIndex));
  return items;
}

function partitionHopFeeDisplayItems(items: HopFeeItemLite[]): {
  accRentItems: HopFeeItemLite[];
  routeFeeItems: HopFeeItemLite[];
} {
  const accRentItems: HopFeeItemLite[] = [];
  const routeFeeItems: HopFeeItemLite[] = [];
  for (const item of items) {
    if (isAccRentWalletFeeItem(item) || isAccRentReclaimItem(item)) accRentItems.push(item);
    else routeFeeItems.push(item);
  }
  return { accRentItems, routeFeeItems };
}

function renderHopFeesAboveBranch(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  planIndex: number,
  isLastHop: boolean,
): string {
  const allItems = hopAccRentDisplayItems(step, quote, planIndex, isLastHop);
  if (allItems.length === 0) return '';

  const feeCount = allItems.length;
  const countMod = feeCount >= 4 ? 'many' : String(feeCount);
  const hasReclaim = allItems.some(isAccRentReclaimItem);
  const slots = allItems
    .map((item) => {
      const chip = renderHopFeeChip(item, quote);
      const slotCls = isAccRentReclaimItem(item)
        ? 'routing-fee-slot--acc-rent-reclaim'
        : 'routing-fee-slot--acc-rent';
      return `<div class="routing-fee-slot ${slotCls}">${chip}</div>`;
    })
    .join('');

  return `<div class="routing-acc-rent-above routing-acc-rent-above--${countMod}${hasReclaim ? ' routing-acc-rent-above--reclaim' : ''}" aria-label="Account rent fees at this hop">
    <div class="routing-acc-rent-cards routing-acc-rent-cards--${countMod}">${slots}</div>
    <div class="routing-acc-rent-connectors" aria-hidden="true">${renderRoutingFeeConnectors(feeCount, 'compact')}</div>
  </div>`;
}

function renderRoutingFeeBranch(
  step: VybeRoutePlanStepLite,
  leg: RouteHopLeg,
  quote: Record<string, unknown>,
): string {
  const { routeFeeItems } = partitionHopFeeDisplayItems(getHopFeeDisplayItems(step));
  if (routeFeeItems.length === 0) return '';

  const feeCount = routeFeeItems.length;
  const countMod = feeCount >= 4 ? 'many' : String(feeCount);
  const slots = routeFeeItems
    .map((item) => {
      const chip = renderHopFeeChip(item, quote, leg.outMint);
      return `<div class="routing-fee-slot">${chip}</div>`;
    })
    .join('');

  return `<div class="routing-fee-branch routing-fee-branch--${countMod}" aria-label="Fees deducted at this hop">
    <div class="routing-fee-connectors" aria-hidden="true">${renderRoutingFeeConnectors(feeCount)}</div>
    <div class="routing-fee-cards routing-fee-cards--${countMod}">${slots}</div>
  </div>`;
}

function renderRouteMarketNode(
  meta: RouteHopMeta,
  leg: RouteHopLeg,
  quote: Record<string, unknown>,
  isLastHop: boolean,
  dexLoading = false,
): string {
  const si = meta.step.swapInfo;
  const dexHtml = dexLoading ? deps.renderLoadingSpinner('sm') : deps.escapeHtml(si?.label ?? 'DEX');
  const sym = deps.escapeHtml(leg.outSym);
  const accRentStackAbove = dexLoading
    ? ''
    : renderHopFeesAboveBranch(meta.step, quote, meta.planIndex, isLastHop);
  const feeBranchBelow = dexLoading ? '' : renderRoutingFeeBranch(meta.step, leg, quote);
  const hasFees = Boolean(accRentStackAbove || feeBranchBelow);
  const railNode = `<div class="routing-market-node">
    ${renderHopIndexBadge(meta.label)}
      <div class="routing-pill routing-pill--hop">
      ${renderRoutingTokenIcon(leg.outMint, leg.outSym)}
      <span class="routing-token-sym">${sym}</span>
      </div>
    <div class="routing-dex-caption">${dexHtml}</div>
  </div>`;
  const hopOnRail = accRentStackAbove
    ? `<div class="routing-hop-on-rail">${accRentStackAbove}${railNode}</div>`
    : railNode;
  return `<div class="routing-hop-column${hasFees ? ' routing-hop-column--has-fees' : ''}${accRentStackAbove ? ' routing-hop-column--has-acc-rent-above' : ''}">
    ${hopOnRail}
    ${feeBranchBelow}
    </div>`;
}

const ROUTING_CONNECTORS = `<div class="routing-connectors" aria-hidden="true">
  <div class="routing-corner routing-corner--in"></div>
  <div class="routing-corner routing-corner--out"></div>
</div>`;

function parseHopPctLabel(label: string | null): number | null {
  if (!label) return null;
  const n = Number(label.replace(/%/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function renderHopOutgoingLinkBadge(
  quote: Record<string, unknown>,
  planIndex: number,
  step: VybeRoutePlanStepLite,
  isLastHop: boolean,
): string {
  const retention = resolveHopRetentionPctsAtHop(quote, planIndex, step, isLastHop);
  return renderRoutePctBadge(
    formatHopPctLabel(retention.outPct),
    'out',
    retention.outTitle,
  );
}

function renderRouteTrack(node: RouteNode, legs: RouteHopLeg[], quote: Record<string, unknown>): string {
  const metas: RouteHopMeta[] = [];
  collectRouteHopMetas(node, metas);
  if (metas.length === 0) return '';

  const inner = metas
    .map((meta, i) => {
      const leg = legs[meta.planIndex];
      if (!leg) return '';
      const isLastHop = i === metas.length - 1;
      const inLink =
        i === 0 ? renderRoutePctBadge(hopPercentLabel(meta.step)) : '';
      const outLink = renderHopOutgoingLinkBadge(quote, meta.planIndex, meta.step, isLastHop);
      return inLink + renderRouteMarketNode(meta, leg, quote, isLastHop) + outLink;
    })
    .join('');

  return `<div class="routing-rail-row">${inner}<div class="routing-rail-tail" aria-hidden="true"></div></div>`;
}

function renderRouteFork(
  node: Extract<RouteNode, { kind: 'fork' }>,
  legs: RouteHopLeg[],
  quote: Record<string, unknown>,
): string {
  const n = node.branches.length;
  const boardClass =
    n === 1 ? 'routing-split-board--1' : n === 2 ? 'routing-split-board--2' : 'routing-split-board--multi';
  const tracks = node.branches.map((b) => renderRouteTrack(b, legs, quote)).join('');
  return `<div class="routing-split-board ${boardClass}">${tracks}</div>`;
}

function renderRouteBody(
  node: RouteNode,
  legs: RouteHopLeg[],
  quote: Record<string, unknown>,
): string {
  if (node.kind === 'empty') return '';
  if (node.kind === 'fork') {
    return renderRouteFork(node, legs, quote);
  }
  if (node.kind === 'hop') {
    return renderRouteTrack(node, legs, quote);
  }
  const hasFork = node.nodes.some((n) => n.kind === 'fork');
  if (hasFork) {
    return node.nodes.map((n) => renderRouteBody(n, legs, quote)).join('');
  }
  return renderRouteTrack(node, legs, quote);
}

function routingCanvasHopClass(hopCount: number): string {
  if (hopCount === 2) return ' routing-canvas--hops-2';
  if (hopCount === 3) return ' routing-canvas--hops-3';
  if (hopCount > 3) return ' routing-canvas--hops-many';
  return '';
}

function renderRoutingDiagramLegend(): string {
  const items: Array<{ swatch: string; label: string }> = [
    { swatch: 'routing-legend__swatch--retention-in', label: 'Input retention' },
    { swatch: 'routing-legend__swatch--retention-out', label: 'Output retention' },
    { swatch: 'routing-legend__swatch--pool-fee', label: 'Pool-side fee' },
    { swatch: 'routing-legend__swatch--wallet-fee', label: 'Wallet fee' },
    { swatch: 'routing-legend__swatch--refundable-rent', label: 'Refundable rent' },
  ];
  const rows = items
    .map(
      (item) =>
        `<li class="routing-legend__item"><span class="routing-legend__swatch ${item.swatch}" aria-hidden="true"></span><span class="routing-legend__label">${deps.escapeHtml(item.label)}</span></li>`,
    )
    .join('');
  return `<div class="routing-legend" aria-label="Diagram color key"><ul class="routing-legend__list">${rows}</ul></div>`;
}

function renderRoutingFrame(
  inDisplay: string,
  inSym: string,
  outDisplay: string,
  outSym: string,
  outTitle: string | undefined,
  body: string,
  split: boolean,
  hopCount = 0,
  placeholder = false,
  loading = false,
  hasFees = false,
  hasAccRentAbove = false,
  inputFeeRows: QuotePayHeroCostStackItem[] | null = null,
  inputTotalLabel: string | null = null,
  outputUsdSubline: string | null = null,
  outputUsdTitle: string | null = null,
  showAllEndpointLabels = false,
  maxAccRentAbove = 1,
  maxRouteFeeBelow = 1,
): string {
  const placeholderClass = placeholder ? ' routing-canvas--placeholder' : '';
  const loadingClass = loading ? ' routing-canvas--loading' : '';
  const feesClass = hasFees ? ' routing-canvas--has-fees' : '';
  const accRentClass = hasAccRentAbove ? ' routing-canvas--has-acc-rent-above' : '';
  const feeRows = inputFeeRows ?? [];
  const inputTotalVal =
    inputTotalLabel && inputTotalLabel !== '—'
      ? inputTotalLabel
      : showAllEndpointLabels
        ? `≈ $${ROUTING_PLACEHOLDER_DASH}`
        : ROUTING_PLACEHOLDER_DASH;
  const outputUsdVal =
    outputUsdSubline && outputUsdSubline !== '—'
      ? outputUsdSubline
      : `≈ $${ROUTING_PLACEHOLDER_DASH}`;

  const inputTopRowCount =
    showAllEndpointLabels || (inputTotalLabel && inputTotalLabel !== '—') ? 1 : 0;
  const outputTopRowCount =
    showAllEndpointLabels || (outputUsdSubline && outputUsdSubline !== '—') ? 1 : 0;
  const outputAlignSpacerHtml = renderDiagramOutputAlignSpacers(
    Math.max(0, inputTopRowCount - outputTopRowCount),
  );
  const multiInputFeesClass = '';
  const multiAccRentClass =
    maxAccRentAbove >= 2 ? ' routing-frame--multi-acc-rent-above' : '';
  const accRentSpreadClass =
    maxAccRentAbove >= 3
      ? ' routing-canvas--acc-rent-above-3'
      : maxAccRentAbove >= 2
        ? ' routing-canvas--acc-rent-above-2'
        : '';
  const feeBranchSpreadClass = maxRouteFeeBelow >= 4 ? ' routing-canvas--fee-branch-many' : '';
  const inputTotalHtml =
    showAllEndpointLabels || (inputTotalLabel && inputTotalLabel !== '—')
      ? `<span class="routing-input-total">USD Input: <span class="routing-input-total__val">${deps.escapeHtml(inputTotalVal)}</span></span>`
      : '';
  const outputUsdHtml =
    showAllEndpointLabels || (outputUsdSubline && outputUsdSubline !== '—')
      ? `<span class="routing-output-usd"${outputUsdTitle ? ` title="${deps.escapeHtml(outputUsdTitle)}"` : ''}>USD Output: <span class="routing-output-usd__val">${deps.escapeHtml(outputUsdVal)}</span></span>`
      : '';
  return `<div class="routing-canvas routing-canvas--flow${split ? ' routing-canvas--split' : ''}${routingCanvasHopClass(hopCount)}${feesClass}${accRentClass}${accRentSpreadClass}${feeBranchSpreadClass}${placeholderClass}${loadingClass}">
    <div class="routing-frame${multiInputFeesClass}${multiAccRentClass}">
      <div class="routing-endpoint routing-endpoint--in">
        <div class="routing-endpoint-stack">
          ${inputTotalHtml}
          ${renderRouteEndpointPill(inDisplay, inSym, undefined, loading && inDisplay === '—', deps.getFormInputMint())}
        </div>
      </div>
      <div class="routing-endpoint routing-endpoint--out">
        <div class="routing-endpoint-stack">
          ${outputAlignSpacerHtml}
          ${outputUsdHtml}
          ${renderRouteEndpointPill(outDisplay, outSym, outTitle, loading, deps.getFormOutputMint())}
        </div>
      </div>
      <div class="routing-path">
        ${ROUTING_CONNECTORS}
        <div class="routing-stem routing-stem--in" aria-hidden="true"></div>
        <div class="routing-stem routing-stem--out" aria-hidden="true"></div>
        <div class="routing-track-wrap">${body}</div>
      </div>
    </div>
  </div>`;
}

export function renderRoutingDiagram(quote: Record<string, unknown>): string {
  const inSym = deps.getSwapInSym();
  const outSym = deps.getSwapOutSym();
  const inTotalDisplay = getQuoteWalletPayLabelFromQuote(quote);
  const inDisplay = getQuoteDiagramInputChipLabel(quote);
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  const inputFeeRows = getQuoteDiagramInputFeeRows(quote, inSym);
  const inputTotalLabel = getQuoteDiagramInputTotalLabel(quote);
  const outputUsdSubline = getQuoteDiagramOutputUsdSubline(quote);
  const outputUsdTitle = getQuoteDiagramOutputUsdTitle(quote);

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const legs = resolveRouteHopLegs(plan, quote);

  if (plan.length === 0) {
    return renderRoutingFrame(
      inDisplay,
      inSym,
      outAmt.display,
      outSym,
      outAmt.full || undefined,
      '<p class="routing-empty">No route steps in this quote.</p>',
      false,
      0,
      false,
      false,
      false,
      false,
      inputFeeRows,
      inputTotalLabel,
      outputUsdSubline,
      outputUsdTitle,
    );
  }

  const tree = buildRouteTree(plan);
  const split = routeTreeHasFork(tree);
  const hasFees = routePlanHasHopFees(plan);
  const hasAccRentAbove = routePlanHasAccRentAbove(plan, quote);
  const maxAccRentAbove = routePlanMaxAccRentAboveCount(plan, quote);
  const maxRouteFeeBelow = routePlanMaxRouteFeeBelowCount(plan);
  const body = renderRouteBody(tree, legs, quote);

  return renderRoutingFrame(
    inDisplay,
    inSym,
    outAmt.display,
    outSym,
    outAmt.full || undefined,
    body,
    split,
    plan.length,
    false,
    false,
    hasFees,
    hasAccRentAbove,
    inputFeeRows,
    inputTotalLabel,
    outputUsdSubline,
    outputUsdTitle,
    false,
    maxAccRentAbove,
    maxRouteFeeBelow,
  );
}

export function renderRoutingDiagramPlaceholder(loading = false): string {
  const inSym = deps.getSwapInSym();
  const outSym = deps.getSwapOutSym();
  const inMint = deps.getFormInputMint();
  const outMint = deps.getFormOutputMint();
  const lastQuote = deps.getLastQuote();
  const inChipDisplay = lastQuote
    ? getQuoteDiagramInputChipLabel(lastQuote)
    : deps.getQuoteWalletPayLabel();
  const hasIn = inChipDisplay !== '—';
  const inputFeeRows = lastQuote ? getQuoteDiagramInputFeeRows(lastQuote, inSym) : [];
  const inputTotalLabel = lastQuote
    ? getQuoteDiagramInputTotalLabel(lastQuote)
    : getQuoteDiagramInputTotalPlaceholderLabel();
  const outputUsdSubline = lastQuote ? getQuoteDiagramOutputUsdSubline(lastQuote) : null;
  const outputUsdTitle = lastQuote ? getQuoteDiagramOutputUsdTitle(lastQuote) : null;
  const outPctLabel =
    lastQuote != null
      ? computeFinalReceivePctBreakdown(lastQuote)?.pctLabel ?? `${ROUTING_PLACEHOLDER_DASH}%`
      : `${ROUTING_PLACEHOLDER_DASH}%`;
  const outAmtDisplay =
    lastQuote != null ? formatQuoteTokenAmount(lastQuote, 'out').display : ROUTING_PLACEHOLDER_DASH;
  const mockLeg: RouteHopLeg = {
    inMint,
    outMint,
    inSym,
    outSym,
    inAmt: hasIn ? inChipDisplay : ROUTING_PLACEHOLDER_DASH,
    outAmt: ROUTING_PLACEHOLDER_DASH,
  };
  const mockMeta: RouteHopMeta = {
    label: '1',
    planIndex: 0,
    step: { percent: 100, swapInfo: { label: ROUTING_PLACEHOLDER_DASH } },
  };
  const body =
    renderRoutePctBadge('100%') +
    renderMockRouteMarketNode(mockMeta, mockLeg, loading) +
    renderRoutePctBadge(outPctLabel, 'out');
  const trackBody = `<div class="routing-rail-row">${body}<div class="routing-rail-tail" aria-hidden="true"></div></div>`;
  return renderRoutingFrame(
    hasIn ? inChipDisplay : ROUTING_PLACEHOLDER_DASH,
    inSym,
    outAmtDisplay,
    outSym,
    undefined,
    trackBody,
    false,
    1,
    true,
    loading,
    true,
    true,
    inputFeeRows,
    inputTotalLabel,
    outputUsdSubline,
    outputUsdTitle,
    true,
  );
}
export function normalizeRouterId(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'jupiter' || raw === 'titan' || raw === 'vybe') return raw;
  return raw || 'vybe';
}

export function routerDisplayLabel(routerId: string): string {
  const id = normalizeRouterId(routerId);
  if (id === 'jupiter') return 'Jupiter';
  if (id === 'titan') return 'Titan';
  if (id === 'vybe') return 'Vybe';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function detectAggregatorBrand(text: string): 'vybe' | 'jupiter' | 'titan' | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '—') return null;
  const id = normalizeRouterId(trimmed);
  if (id === 'vybe' || id === 'jupiter' || id === 'titan') return id;
  const lower = trimmed.toLowerCase();
  if (lower.includes('jupiter')) return 'jupiter';
  if (lower.includes('titan')) return 'titan';
  if (lower.includes('vybe')) return 'vybe';
  return null;
}

function routerIconSrc(brand: 'vybe' | 'jupiter' | 'titan'): string {
  if (brand === 'vybe') return '/favicon.svg';
  if (brand === 'jupiter') return '/images/jupiter-logo.png';
  return '/images/titan-logo.png';
}

function quoteRouterBrand(quote: Record<string, unknown>): 'vybe' | 'jupiter' | 'titan' {
  const id = normalizeRouterId(
    quote._effectiveRouter ?? quote._buildRouter ?? quote._selectedRouter ?? quote.router ?? deps.getSwapRouter(),
  );
  if (id === 'jupiter' || id === 'titan' || id === 'vybe') return id;
  return 'vybe';
}

function renderViaRouterBadge(brand: 'vybe' | 'jupiter' | 'titan'): string {
  const label = routerDisplayLabel(brand);
  const iconClass = `swap-hop-via-router__icon swap-hop-via-router__icon--${brand}`;
  return `<span class="swap-hop-via-router"><img class="${iconClass}" src="${routerIconSrc(brand)}" alt="" width="14" height="14" decoding="async" /><span class="swap-hop-via-router__label">(via ${deps.escapeHtml(label)})</span></span>`;
}

function renderHopVenueHtml(
  dexLabel: string,
  quote: Record<string, unknown>,
  options: { loading: boolean; pendingHop: boolean },
): string {
  const router = quoteRouterBrand(quote);
  if (options.pendingHop && (dexLabel === '—' || dexLabel === 'Unknown DEX')) {
    if (options.loading) return hopDetailPendingCell(true, '—');
    return renderViaRouterBadge(router);
  }
  if (dexLabel === '—' || dexLabel === 'Unknown DEX') {
    return renderViaRouterBadge(router);
  }
  const dexBrand = detectAggregatorBrand(dexLabel);
  if (dexBrand === router) {
    return renderViaRouterBadge(router);
  }
  return `<span class="swap-hop-venue-display"><span class="swap-hop-venue-display__dex">${deps.escapeHtml(dexLabel)}</span>${renderViaRouterBadge(router)}</span>`;
}

export function formatRouteDiagramTitle(quote: Record<string, unknown>): string {
  const selected = normalizeRouterId(
    quote._selectedRouter ?? quote.router ?? deps.getSwapRouter(),
  );
  const effective = normalizeRouterId(
    quote._effectiveRouter ?? quote._buildRouter ?? selected,
  );
  const fallback =
    quote._routerFallbackUsed === true ||
    quote._quoteSource === 'vybe-swap-quote-fallback' ||
    effective !== selected;

  if (fallback) {
    const selectedLabel = routerDisplayLabel(selected);
    const effectiveLabel = routerDisplayLabel(effective);
    if (effectiveLabel === selectedLabel) {
      return `Route · ${effectiveLabel} (fallback)`;
    }
    return `Route · ${effectiveLabel} (fallback from ${selectedLabel})`;
  }
  return `Route · ${routerDisplayLabel(selected)}`;
}

function simulationOutputWarningFromQuote(quote: Record<string, unknown>): Record<string, unknown> | null {
  const w = quote._simulationOutputWarning;
  if (!w || typeof w !== 'object') return null;
  const rec = w as Record<string, unknown>;
  if (rec.warn !== true) return null;
  const shortfallPct = Number(rec.shortfallPct);
  if (!Number.isFinite(shortfallPct)) return null;
  return rec;
}

function lowLiquidityWarningFromQuote(
  quote: Record<string, unknown>,
  marketScore?: number,
): Record<string, unknown> | null {
  const w = quote._lowLiquidityWarning;
  if (w && typeof w === 'object') {
    const rec = w as Record<string, unknown>;
    if (rec.warn === true) {
      const liquidityUsd = Number(rec.liquidityUsd);
      if (Number.isFinite(liquidityUsd)) return rec;
    }
  }
  const score = Number(marketScore);
  if (Number.isFinite(score) && score > 0 && score < 1000) {
    return { warn: true, thresholdUsd: 1000, liquidityUsd: score };
  }
  return null;
}

function swapRouteWarningLevel(
  quote: Record<string, unknown>,
  marketScore?: number,
): 'none' | 'orange' | 'red' {
  const sim = simulationOutputWarningFromQuote(quote);
  const liq = lowLiquidityWarningFromQuote(quote, marketScore);
  if (sim && liq) return 'red';
  if (sim || liq) return 'orange';
  return 'none';
}

function simulationOutputWarningTitle(w: Record<string, unknown>): string {
  return `Simulated output is ${Number(w.shortfallPct).toFixed(1)}% below quote. Token account rent/reclaim excluded.`;
}

function lowLiquidityWarningTitle(w: Record<string, unknown>): string {
  const liq = Number(w.liquidityUsd);
  return `Pool liquidity is $${liq.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`;
}

function combinedRouteWarningTitle(quote: Record<string, unknown>, marketScore?: number): string {
  const parts: string[] = [];
  const liq = lowLiquidityWarningFromQuote(quote, marketScore);
  const sim = simulationOutputWarningFromQuote(quote);
  if (liq) parts.push(lowLiquidityWarningTitle(liq));
  if (sim) parts.push(simulationOutputWarningTitle(sim));
  return parts.join(' ');
}

export function updateRouteDiagramTitle(quote: Record<string, unknown>): void {
  const base = formatRouteDiagramTitle(quote);
  const warnLevel = swapRouteWarningLevel(quote);
  const warnTitle = warnLevel !== 'none' ? combinedRouteWarningTitle(quote) : '';
  const warnClass =
    warnLevel === 'red'
      ? 'swap-quote-route-warning swap-quote-route-warning--severe'
      : warnLevel === 'orange'
        ? 'swap-quote-route-warning swap-quote-route-warning--caution'
        : 'swap-quote-route-warning';

  const applyTitle = (el: HTMLElement | null) => {
    if (!el) return;
    if (warnLevel !== 'none') {
      el.innerHTML = `<span class="swap-quote-route-title-text">${deps.escapeHtml(base)}</span><span class="${warnClass}" title="${deps.escapeHtml(warnTitle)}" aria-label="${deps.escapeHtml(warnTitle)}">⚠</span>`;
    } else {
      el.textContent = base;
    }
  };

  applyTitle(deps.dom.swapQuoteRouteSubtitleEl);
  applyTitle(deps.dom.routingDialogTitleEl);
}
export function renderRoutePanels(quote: Record<string, unknown>): void {
  updateRouteDiagramTitle(quote);
  renderRouteOptionsPanel();
  mountRoutingDiagram(deps.dom.swapQuoteDetailsRoutingEl, renderRoutingDiagram(quote));
  if (deps.dom.swapQuoteDetailsRouteStepsEl) deps.dom.swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanSteps(quote);
  deps.syncRoutePlanStepsUi();
  mountRoutingDiagram(deps.dom.routingDialogBodyEl, renderRoutingDiagram(quote));
}

const ROUTING_DIAGRAM_ZOOM_STEP = 0.125;
const ROUTING_DIAGRAM_ZOOM_MAX = 2.5;
const ROUTING_DIAGRAM_DRAG_THRESHOLD_PX = 4;

type RoutingDiagramDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  dragging: boolean;
};

type RoutingDiagramHostState = {
  fitScale: number;
  userScale: number;
  viewport: HTMLElement;
  scrollSizer: HTMLElement;
  scaler: HTMLElement;
  zoomOutBtn: HTMLButtonElement;
  zoomInBtn: HTMLButtonElement;
  dragPanBound: boolean;
};

const routingDiagramHostState = new WeakMap<HTMLElement, RoutingDiagramHostState>();
const routingDiagramDragState = new WeakMap<HTMLElement, RoutingDiagramDragState | null>();

function bindRoutingDiagramDragPan(container: HTMLElement, state: RoutingDiagramHostState): void {
  if (state.dragPanBound) return;
  state.dragPanBound = true;

  const viewport = state.viewport;

  viewport.addEventListener('pointerdown', (event) => {
    if (!container.classList.contains('routing-diagram-host--zoomed')) return;
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest('.routing-diagram-zoom-controls')) return;

    routingDiagramDragState.set(container, {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      dragging: false,
    });
  });

  viewport.addEventListener('pointermove', (event) => {
    const drag = routingDiagramDragState.get(container);
    if (!drag || event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < ROUTING_DIAGRAM_DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('routing-diagram-viewport--dragging');
    }

    viewport.scrollLeft = drag.scrollLeft - dx;
    viewport.scrollTop = drag.scrollTop - dy;
    event.preventDefault();
  });

  const endDrag = (event: PointerEvent) => {
    const drag = routingDiagramDragState.get(container);
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.dragging) {
      viewport.releasePointerCapture(event.pointerId);
      viewport.classList.remove('routing-diagram-viewport--dragging');
    }
    routingDiagramDragState.set(container, null);
  };

  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
}

function ensureRoutingDiagramHost(container: HTMLElement): RoutingDiagramHostState {
  const existing = routingDiagramHostState.get(container);
  if (existing) return existing;

  container.classList.add('routing-diagram-host');

  const viewport = document.createElement('div');
  viewport.className = 'routing-diagram-viewport';

  const scrollSizer = document.createElement('div');
  scrollSizer.className = 'routing-diagram-scroll-sizer';

  const scaler = document.createElement('div');
  scaler.className = 'routing-diagram-scaler';
  scrollSizer.appendChild(scaler);
  viewport.appendChild(scrollSizer);

  const controls = document.createElement('div');
  controls.className = 'routing-diagram-zoom-controls';
  controls.setAttribute('aria-label', 'Route diagram zoom');

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.type = 'button';
  zoomOutBtn.className = 'routing-diagram-zoom-btn';
  zoomOutBtn.dataset.zoom = 'out';
  zoomOutBtn.setAttribute('aria-label', 'Zoom out');
  zoomOutBtn.title = 'Zoom out';
  zoomOutBtn.textContent = '−';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.type = 'button';
  zoomInBtn.className = 'routing-diagram-zoom-btn';
  zoomInBtn.dataset.zoom = 'in';
  zoomInBtn.setAttribute('aria-label', 'Zoom in');
  zoomInBtn.title = 'Zoom in';
  zoomInBtn.textContent = '+';

  controls.append(zoomOutBtn, zoomInBtn);

  const legend = document.createElement('div');
  legend.innerHTML = renderRoutingDiagramLegend();
  const legendEl = legend.firstElementChild as HTMLElement | null;
  if (legendEl) container.append(viewport, legendEl, controls);
  else container.append(viewport, controls);

  const state: RoutingDiagramHostState = {
    fitScale: 1,
    userScale: 1,
    viewport,
    scrollSizer,
    scaler,
    zoomOutBtn,
    zoomInBtn,
    dragPanBound: false,
  };
  routingDiagramHostState.set(container, state);

  bindRoutingDiagramDragPan(container, state);

  if (!routingDiagramResizeObservers.has(container)) {
    const observer = new ResizeObserver(() => scheduleRoutingDiagramZoom());
    observer.observe(container);
    observer.observe(viewport);
    routingDiagramResizeObservers.set(container, observer);
  }

  controls.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-zoom]');
    if (!target || target.disabled) return;
    const dir = target.dataset.zoom;
    if (dir === 'in') stepRoutingDiagramZoom(container, ROUTING_DIAGRAM_ZOOM_STEP);
    else if (dir === 'out') stepRoutingDiagramZoom(container, -ROUTING_DIAGRAM_ZOOM_STEP);
  });

  return state;
}

function measureRoutingDiagramNaturalSize(scaler: HTMLElement): { width: number; height: number } {
  const prevTransform = scaler.style.transform;
  scaler.style.transform = 'none';
  const width = Math.max(scaler.scrollWidth, scaler.offsetWidth);
  const height = Math.max(scaler.scrollHeight, scaler.offsetHeight);
  scaler.style.transform = prevTransform;
  return { width, height };
}

function updateRoutingDiagramZoomButtons(state: RoutingDiagramHostState): void {
  state.zoomOutBtn.disabled = state.userScale <= 1 + 1e-6;
  state.zoomInBtn.disabled = state.userScale >= ROUTING_DIAGRAM_ZOOM_MAX - 1e-6;
}

function centerRoutingDiagramViewportScroll(viewport: HTMLElement): void {
  const overflowX = viewport.scrollWidth - viewport.clientWidth;
  if (overflowX > 2) viewport.scrollLeft = overflowX / 2;
}

function applyRoutingDiagramScale(container: HTMLElement): void {
  const state = routingDiagramHostState.get(container);
  if (!state || state.scaler.childElementCount === 0) return;

  const { width: naturalWidth, height: naturalHeight } = measureRoutingDiagramNaturalSize(state.scaler);
  if (naturalWidth <= 0 || naturalHeight <= 0) return;

  const viewportWidth = Math.max(state.viewport.clientWidth, 1);
  state.fitScale = Math.min(1, viewportWidth / naturalWidth);
  const effectiveScale = state.fitScale * state.userScale;

  state.scaler.style.width = `${naturalWidth}px`;
  state.scaler.style.transform = `scale(${effectiveScale})`;
  state.scaler.style.transformOrigin = 'top left';
  state.scrollSizer.style.width = `${naturalWidth * effectiveScale}px`;
  state.scrollSizer.style.height = `${naturalHeight * effectiveScale}px`;

  const zoomed = state.userScale > 1 + 1e-6;
  container.classList.toggle('routing-diagram-host--zoomed', zoomed);
  state.viewport.style.overflowX = zoomed ? 'auto' : 'hidden';
  state.viewport.style.overflowY = zoomed ? 'auto' : 'hidden';

  if (zoomed) {
    state.scrollSizer.style.marginLeft = '0';
    centerRoutingDiagramViewportScroll(state.viewport);
  } else {
    const scaledWidth = naturalWidth * effectiveScale;
    state.scrollSizer.style.marginLeft = `${Math.max(0, (viewportWidth - scaledWidth) / 2)}px`;
    state.viewport.scrollLeft = 0;
  }

  updateRoutingDiagramZoomButtons(state);
}

function stepRoutingDiagramZoom(container: HTMLElement, delta: number): void {
  const state = routingDiagramHostState.get(container);
  if (!state) return;

  const prevScale = state.userScale;
  state.userScale = Math.min(
    ROUTING_DIAGRAM_ZOOM_MAX,
    Math.max(1, state.userScale + delta),
  );
  if (Math.abs(state.userScale - prevScale) < 1e-6) return;

  applyRoutingDiagramScale(container);
}

function applyRoutingDiagramScaleForContainer(container: HTMLElement | null): void {
  if (!container) return;
  applyRoutingDiagramScale(container);
}

export function mountRoutingDiagram(container: HTMLElement | null, html: string): void {
  if (!container) return;
  const state = ensureRoutingDiagramHost(container);
  state.userScale = 1;
  state.scaler.innerHTML = html;
  scheduleRoutingDiagramZoom();
}

export function clearRoutingDiagram(container: HTMLElement | null): void {
  if (!container) return;
  const state = routingDiagramHostState.get(container);
  if (!state) {
    container.innerHTML = '';
    return;
  }
  state.userScale = 1;
  state.scaler.innerHTML = '';
  container.classList.remove('routing-diagram-host--zoomed');
  state.viewport.style.overflowX = 'hidden';
  state.viewport.style.overflowY = 'hidden';
  state.viewport.classList.remove('routing-diagram-viewport--dragging');
  routingDiagramDragState.set(container, null);
  state.viewport.scrollLeft = 0;
  state.viewport.scrollTop = 0;
  state.scrollSizer.style.width = '';
  state.scrollSizer.style.height = '';
  state.scrollSizer.style.marginLeft = '';
  updateRoutingDiagramZoomButtons(state);
}

export function scheduleRoutingDiagramZoom(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      applyRoutingDiagramScaleForContainer(deps.dom.swapQuoteDetailsRoutingEl);
      applyRoutingDiagramScaleForContainer(deps.dom.routingDialogBodyEl);
    });
  });
}

let routingDiagramScrollBound = false;
const routingDiagramResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

export function bindRoutingDiagramZoomListeners(): void {
  if (routingDiagramScrollBound) return;
  routingDiagramScrollBound = true;
  window.addEventListener('resize', scheduleRoutingDiagramZoom);
}
function getPlaceholderHopInAmountRaw(): string | null {
  const amount = Number(deps.getFormSwapAmount());
  const inputMint = deps.getFormInputMint();
  if (!Number.isFinite(amount) || amount <= 0 || !inputMint) return null;
  const decimals = deps.getMintDecimals(inputMint);
  try {
    const raw = BigInt(Math.round(amount * 10 ** decimals));
    return raw.toString();
  } catch {
    return null;
  }
}

function hopDetailPendingCell(loading: boolean, html: string): string {
  return loading ? deps.renderLoadingSpinner('sm') : html;
}

/** NET vs pre-fees % — show through first non-zero decimal (e.g. -0.005%, not -0%). */
function formatHopQuotedToNetPctChange(
  quotedRaw: string | undefined,
  netRaw: string | undefined,
): string | null {
  const quoted = parsePositiveBigInt(quotedRaw);
  const net = parsePositiveBigInt(netRaw);
  if (quoted === null || net === null || quoted === 0n) return null;
  const diff = net - quoted;
  if (diff === 0n) return null;

  const pct = (Number(diff) / Number(quoted)) * 100;
  if (!Number.isFinite(pct) || pct === 0) return null;

  const sign = pct > 0 ? '+' : '-';
  const abs = Math.abs(pct);

  for (let d = 1; d <= 8; d++) {
    const factor = 10 ** d;
    const truncated = Math.floor(abs * factor) / factor;
    const prevTruncated = d === 1 ? 0 : Math.floor(abs * 10 ** (d - 1)) / 10 ** (d - 1);
    if (truncated > prevTruncated) {
      let numStr = truncated.toFixed(d);
      numStr = numStr.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      return `${sign}${numStr}%`;
    }
  }

  return `${sign}${abs.toExponential(1)}%`;
}

function renderHopNetPctChangeLabelHtml(
  quotedRaw: string | undefined,
  netRaw: string | undefined,
): string {
  const formatted = formatHopQuotedToNetPctChange(quotedRaw, netRaw);
  if (!formatted) return '';
  const cls =
    formatted.startsWith('-')
      ? 'swap-hop-amount-tile__chg--down'
      : 'swap-hop-amount-tile__chg--up';
  return `<span class="swap-hop-amount-tile__chg ${cls}"> (${deps.escapeHtml(formatted)})</span>`;
}

function renderHopAmountTile(
  label: string,
  amtHtml: string,
  sym: string,
  mint: string,
  title?: string,
  labelExtraHtml = '',
): string {
  const boxCls = mint ? tokenBoxColorClass(mint, sym) : '';
  const symCls = tokenSymColorClass(mint, sym);
  const titleAttr = title ? ` title="${deps.escapeHtml(title)}"` : '';
  const symPart =
    sym && sym !== '—'
      ? `<span class="swap-hop-amount-tile__sym ${symCls}">${deps.escapeHtml(sym)}</span>`
      : '';
  const iconPart = mint
    ? `<span class="swap-hop-amount-tile__icon">${renderRoutingTokenIcon(mint, sym)}</span>`
    : '';
  return `<div class="swap-hop-amount-tile${boxCls ? ` ${boxCls}` : ''}"${titleAttr}>
    <span class="swap-hop-amount-tile__label">${deps.escapeHtml(label)}${labelExtraHtml}</span>
    <span class="swap-hop-amount-tile__value">${iconPart}<span class="swap-hop-amount-tile__amt">${amtHtml}</span>${symPart}</span>
  </div>`;
}

function renderHopAmountsArrow(): string {
  return `<span class="swap-hop-amounts-arrow" aria-hidden="true"><span class="swap-hop-amounts-arrow-icon">→</span></span>`;
}

function renderHopVenueMarketLine(
  marketAddrHtml: string,
  marketPairHtml: string,
  title?: string,
): string {
  if (!marketAddrHtml && !marketPairHtml) return '';
  const titleAttr = title ? ` title="${deps.escapeHtml(title)}"` : '';
  return `<span class="swap-hop-venue-market"${titleAttr}><span class="swap-hop-market-row__value">${marketAddrHtml}${marketPairHtml}</span></span>`;
}

function renderHopCardSwapTokenIconLink(mint: string, sym: string): string {
  const displayMint = displayHopMintAddress(mint);
  const iconHtml = renderRoutingTokenIcon(mint, sym);
  if (!isLikelySolanaPubkey(displayMint)) {
    return `<span class="swap-hop-card__swap-icon">${iconHtml}</span>`;
  }
  const symLabel = sym?.trim() || displayMint;
  const url = deps.escapeHtml(solscanTokenUrl(mint));
  return `<a class="swap-hop-card__swap-icon swap-hop-card__swap-icon-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${deps.escapeHtml(symLabel)} on Solscan" aria-label="View ${deps.escapeHtml(symLabel)} on Solscan">${iconHtml}</a>`;
}

function renderHopCardPctBadge(
  pct: string,
  direction: 'in' | 'out' = 'in',
  title?: string | null,
): string {
  const outCls = direction === 'out' ? ' swap-hop-card__pct--out' : '';
  const titleAttr = title ? ` title="${deps.escapeHtml(title)}"` : '';
  return `<span class="swap-hop-card__pct${outCls}"${titleAttr}>${deps.escapeHtml(pct)}</span>`;
}

function renderHopCardPctGroup(
  leg: RouteHopLeg,
  mintSide: 'in' | 'out',
  pct: string,
  direction: 'in' | 'out',
  title?: string | null,
): string {
  const mint = (mintSide === 'in' ? leg.inMint : leg.outMint)?.trim() ?? '';
  const sym = mintSide === 'in' ? leg.inSym : leg.outSym;
  const iconHtml = mint ? renderHopCardSwapTokenIconLink(mint, sym) : '';
  return `<span class="swap-hop-card__pct-group">${iconHtml}${renderHopCardPctBadge(pct, direction, title)}</span>`;
}

function renderHopCardPctArrow(): string {
  return `<span class="swap-hop-card__pct-arrow" aria-hidden="true">→</span>`;
}

function pendingQuoteRecord(quote: Record<string, unknown>): boolean {
  return !quote || Object.keys(quote).length === 0;
}

/** Green = cumulative wallet % entering hop; blue = cumulative % after hop. */
function resolveHopCardRetentionPcts(
  quote: Record<string, unknown>,
  planIndex: number,
  step: VybeRoutePlanStepLite,
  isLastHop: boolean,
): { inPct: string; outPct: string; outTitle: string | null } {
  if (pendingQuoteRecord(quote)) {
    const p = hopPercentLabel(step);
    const fallback = p === '—' ? '100%' : p;
    return { inPct: '100%', outPct: fallback, outTitle: null };
  }

  const retention = resolveHopRetentionPctsAtHop(quote, planIndex, step, isLastHop);

  return {
    inPct: formatHopPctLabel(retention.inPct),
    outPct: formatHopPctLabel(retention.outPct),
    outTitle: retention.outTitle,
  };
}

function renderRoutePlanStepDetail(
  step: VybeRoutePlanStepLite,
  hopLabel: string,
  leg: RouteHopLeg,
  expanded = false,
  placeholder = false,
  loading = false,
  quote: Record<string, unknown> = {},
  planIndex = 0,
  isLastHop = true,
  collapsible = true,
): string {
  const si = step.swapInfo;
  const dex = si?.label ?? 'Unknown DEX';
  const pendingHop = placeholder || loading;
  const hasInAmt = leg.inAmt !== '—' && leg.inAmt !== '';
  const hopFees = getHopFeeBreakdown(step);
  const feeSym = hopFees?.mint
    ? mintSymbolSync(hopFees.mint)
    : si?.feeMintAddress
      ? mintSymbolSync(si.feeMintAddress)
      : '—';
  const feeMint = (hopFees?.mint ?? si?.feeMintAddress ?? '').trim();
  const feeAmtMint = feeMint || leg.inMint;
  const feeAmt =
    hopFees?.totalAmountRaw && hopFees.totalAmountRaw !== '0'
      ? formatHopFeeTableAmount(hopFees.totalAmountRaw, feeAmtMint)
      : si?.feeAmount && si.feeAmount !== '0'
        ? formatHopFeeTableAmount(si.feeAmount, feeAmtMint)
        : null;

  const venueHtml = renderHopVenueHtml(dex, quote, { loading, pendingHop });

  const marketRaw = si?.ammKey?.trim() ?? '';
  const marketTitle = marketRaw ? deps.escapeHtml(marketRaw) : undefined;
  const marketPairHtml = renderHopMarketPairSuffix(leg.inSym, leg.outSym, leg.inMint, leg.outMint);
  let marketAddrHtml: string;
  if (marketRaw) {
    marketAddrHtml = renderHopMarketDetailAddressHtml(marketRaw);
  } else if (pendingHop) {
    marketAddrHtml = hopDetailPendingCell(loading, '—');
  } else {
    marketAddrHtml = '—';
  }
  const marketLineHtml =
    marketRaw || pendingHop
      ? renderHopVenueMarketLine(marketAddrHtml, marketPairHtml, marketTitle)
      : '';
  const dexSummaryHtml = marketLineHtml
    ? `<span class="swap-hop-venue-stack">${venueHtml}${marketLineHtml}</span>`
    : venueHtml;

  let inAmtHtml: string;
  if (si?.inAmount) {
    inAmtHtml = deps.escapeHtml(deps.formatRawTokenAmount(si.inAmount, leg.inMint).display);
  } else if (pendingHop) {
    inAmtHtml = hasInAmt ? deps.escapeHtml(leg.inAmt) : hopDetailPendingCell(loading, '—');
  } else {
    inAmtHtml = '—';
  }

  const hopOutAmounts = resolveHopOutAmounts(step, quote, isLastHop);
  const preFeesOutRaw =
    hopOutAmounts != null ? String(hopOutAmounts.grossRaw) : si?.outAmount;
  let preFeesAmtHtml: string;
  if (preFeesOutRaw) {
    preFeesAmtHtml = deps.escapeHtml(deps.formatRawTokenAmount(preFeesOutRaw, leg.outMint).display);
  } else {
    preFeesAmtHtml = pendingHop ? hopDetailPendingCell(loading, '—') : '—';
  }

  const netOutRaw =
    hopOutAmounts != null ? String(hopOutAmounts.netRaw) : hopFees?.netOutRaw || si?.outAmount;
  let netAmtHtml: string;
  if (netOutRaw) {
    netAmtHtml = deps.escapeHtml(deps.formatRawTokenAmount(netOutRaw, leg.outMint).display);
  } else {
    netAmtHtml = pendingHop ? hopDetailPendingCell(loading, '—') : '—';
  }

  const inAmountTitle =
    si?.inAmount
      ? (() => {
          const inFmt = deps.formatRawTokenAmount(si.inAmount, leg.inMint);
          return `${inFmt.full || inFmt.display} ${leg.inSym} (${si.inAmount} raw)`;
        })()
      : hasInAmt && pendingHop
        ? (() => {
            const inRaw = getPlaceholderHopInAmountRaw();
            return inRaw ? `${leg.inAmt} ${leg.inSym} (${inRaw} raw)` : undefined;
          })()
        : undefined;

  const preFeesTitle = preFeesOutRaw
    ? (() => {
        const grossFmt = deps.formatRawTokenAmount(preFeesOutRaw, leg.outMint);
        return `Pre-fees total output: ${grossFmt.full || grossFmt.display} ${leg.outSym} (${preFeesOutRaw} raw)`;
      })()
    : undefined;

  const netTitle = netOutRaw
    ? (() => {
        const netFmt = deps.formatRawTokenAmount(netOutRaw, leg.outMint);
        return `${netFmt.full || netFmt.display} ${leg.outSym} (${netOutRaw} raw)`;
      })()
    : undefined;

  const reclaimItems = getHopAtaRentReclaimItems(quote, planIndex, isLastHop);

  let feesHtml = '';
  if (hopFees?.items.length || reclaimItems.length) {
    feesHtml = renderHopPlanFeesSection(
      hopFees ?? { items: [], totalAmountRaw: '0', mint: feeAmtMint },
      leg,
      quote,
      feeMint,
      feeAmt,
      si?.ammKey,
      reclaimItems,
    );
  } else if (placeholder) {
    const mockWalletFeeSym = feeSym !== '—' ? feeSym : leg.inSym;
    const mockOutputFeeSym = leg.outSym !== '—' ? leg.outSym : 'USDT';
    feesHtml = renderMockHopPlanFeesSection(
      feeAmtMint || leg.inMint,
      mockWalletFeeSym,
      leg.outMint || feeMint,
      mockOutputFeeSym,
    );
  } else if (feeAmt) {
    const feeRaw = hopFees?.totalAmountRaw ?? si?.feeAmount ?? '';
    const singleFeeItem: HopFeeItemLite = {
      label: 'Fee',
      amountRaw: feeRaw,
      mint: feeAmtMint,
    };
    const singleRowData = [
      {
        item: singleFeeItem,
        equiv: computeFeeEquivalents(feeRaw, feeAmtMint, quote),
      },
    ];
    const feeTotalsHtml = renderHopFeesTotalsChips(singleRowData, quote);
    feesHtml = `<section class="swap-hop-panel swap-hop-panel--fees" aria-label="Hop fees">
      <div class="swap-hop-panel__head">
        <h5 class="swap-hop-panel__title">Fees</h5>
        ${feeTotalsHtml}
      </div>
      <div class="hop-fee-group">
        <div class="hop-fee-row hop-fee-row--fee">
          <span class="hop-fee-row__label">Fee</span>
          <span class="hop-fee-row__dest"></span>
          <span class="hop-fee-row__amt"><span>${renderHopFeeAmountHtml(feeAmtMint, feeRaw, feeSym)}</span></span>
          <span class="hop-fee-row__usd"><span>—</span></span>
        </div>
      </div>
    </section>`;
  }

  const amountsSectionHtml = `<section class="swap-hop-panel swap-hop-panel--amounts" aria-label="Hop amounts">
    <div class="swap-hop-amounts-flow">
      ${renderHopAmountTile('In', inAmtHtml, leg.inSym, leg.inMint, inAmountTitle)}
      ${renderHopAmountsArrow()}
      ${renderHopAmountTile('Pre-fees output', preFeesAmtHtml, leg.outSym, leg.outMint, preFeesTitle)}
      ${renderHopAmountsArrow()}
      ${renderHopAmountTile(
        'Net',
        netAmtHtml,
        leg.outSym,
        leg.outMint,
        netTitle,
        renderHopNetPctChangeLabelHtml(preFeesOutRaw, netOutRaw),
      )}
    </div>
  </section>`;

  const retentionPcts = resolveHopCardRetentionPcts(quote, planIndex, step, isLastHop);
  const shareBadgeHtml = `<span class="swap-hop-card__trail">${renderHopCardPctGroup(leg, 'in', retentionPcts.inPct, 'in')}${renderHopCardPctArrow()}${renderHopCardPctGroup(leg, 'out', retentionPcts.outPct, 'out', retentionPcts.outTitle)}</span>`;

  const placeholderClass = placeholder ? ' swap-hop-step-details--placeholder' : '';
  const loadingClass = loading ? ' swap-hop-step-details--loading' : '';
  const lockedClass = !collapsible ? ' swap-hop-step-details--locked' : '';
  const isOpen = !collapsible || expanded;
  return `<details class="swap-hop-step-card swap-hop-step-details${placeholderClass}${loadingClass}${lockedClass}"${isOpen ? ' open' : ''}${!collapsible ? ' data-hop-locked="true"' : ''}>
    <summary class="swap-hop-step-details__summary"${!collapsible ? ' aria-disabled="true"' : ''}>
      <span class="swap-hop-card__index">Hop #${deps.escapeHtml(hopLabel)}</span>
      <span class="swap-hop-step-details__main">
        <span class="swap-hop-card__dex">${dexSummaryHtml}</span>
      </span>
      ${shareBadgeHtml}
    </summary>
    <div class="swap-hop-step-details__body">
      ${amountsSectionHtml}
      ${feesHtml}
    </div>
  </details>`;
}

export function renderQuoteRoutePlanStepsPlaceholder(loading = false): string {
  const inSym = deps.getSwapInSym();
  const outSym = deps.getSwapOutSym();
  const inMint = deps.getFormInputMint();
  const outMint = deps.getFormOutputMint();
  const inDisplay = deps.getQuoteWalletPayLabel();
  const hasIn = inDisplay !== '—';
  const mockLeg: RouteHopLeg = {
    inMint,
    outMint,
    inSym,
    outSym,
    inAmt: hasIn ? inDisplay : '—',
    outAmt: '—',
  };
  const mockStep: VybeRoutePlanStepLite = {
    percent: 100,
    swapInfo: { label: '—' },
  };
  return renderRoutePlanStepDetail(mockStep, '1', mockLeg, true, true, loading, {}, 0, true, false);
}

export function renderQuoteRoutePlanSteps(quote: Record<string, unknown>): string {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  if (plan.length === 0) return '<p class="routing-empty">No route steps in this quote.</p>';
  const legs = resolveRouteHopLegs(plan, quote);
  const tree = buildRouteTree(plan);
  const metas: RouteHopMeta[] = [];
  collectRouteHopMetas(tree, metas);
  const hopCount = metas.length > 0 ? metas.length : plan.length;
  const singleHop = hopCount === 1;
  if (metas.length === 0) {
    return plan
      .map((s, i) =>
        renderRoutePlanStepDetail(
          s,
          String(i + 1),
          legs[i]!,
          i === 0,
          false,
          false,
          quote,
          i,
          i === plan.length - 1,
          !singleHop,
        ),
      )
      .join('');
  }
  return metas
    .map((meta, i) =>
      renderRoutePlanStepDetail(
        meta.step,
        meta.label,
        legs[meta.planIndex]!,
        i === 0,
        false,
        false,
        quote,
        meta.planIndex,
        i === metas.length - 1,
        !singleHop,
      ),
    )
    .join('');
}

function shortSolAddress(addr: string, head = 4, tail = 4): string {
  const a = addr.trim();
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

const ROUTE_VIA_TRADES_DISABLED_LABELS: Record<string, string> = {
  discovery_off: 'Market fetch mode not set',
  manual_pool: 'Manual pool pin — trade routing skipped',
  manual_protocol: 'Manual protocol set — trade routing skipped',
  router_not_vybe: 'Router is not Vybe — trade routing skipped',
};

const ROUTE_VIA_TRADES_OUTCOME_LABELS: Record<string, string> = {
  direct: 'Direct pool build succeeded',
  multi: 'Multiple routes enumerated',
  unpinned_vybe: 'Trade queue exhausted — unpinned Vybe RPC scan',
  rpc_only: 'Vybe RPC pool scan (trades skipped)',
  titan_fallback: 'Trade queue exhausted — switched to Titan',
  jupiter_fallback: 'Trade queue exhausted — switched to Jupiter',
  skipped: 'Route via Trades not used',
  failed: 'Trade queue failed',
};

function formatTradesOldestLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Relative coverage label from oldest trade blockTime (unix seconds). */
export function formatTradesFetchLookback(oldestBlockTimeSec: unknown): string {
  const bt = Number(oldestBlockTimeSec);
  if (!Number.isFinite(bt) || bt <= 0) return '';
  const ageSec = Math.max(0, Date.now() / 1000 - bt);
  const ageHours = ageSec / 3600;
  if (ageHours < 24) {
    const hours = ageHours >= 10 ? Math.round(ageHours) : Math.round(ageHours * 10) / 10;
    return `last ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round((ageHours / 24) * 10) / 10;
  return `last ${days} day${days === 1 ? '' : 's'}`;
}

export function renderRouteViaTradesLogHtml(meta: Record<string, unknown> | null | undefined): string {
  if (!meta || typeof meta !== 'object') {
    return '<p class="routing-empty">Route via Trades log appears on Vybe quotes.</p>';
  }

  const enabled = meta.enabled === true;
  const outcome = String(meta.outcome ?? '');
  const outcomeLabel = ROUTE_VIA_TRADES_OUTCOME_LABELS[outcome] ?? (outcome || '—');
  const parts: string[] = [];

  parts.push('<div class="rvt-log">');
  parts.push('<div class="rvt-log__summary">');
  if (!enabled) {
    const reason = String(meta.disabledReason ?? '');
    const reasonLabel = ROUTE_VIA_TRADES_DISABLED_LABELS[reason] ?? (reason || 'Disabled');
    parts.push(`<p class="rvt-log__line rvt-log__line--muted"><strong>Skipped:</strong> ${escapeHtml(reasonLabel)}</p>`);
  } else {
    parts.push(`<p class="rvt-log__line"><strong>Outcome:</strong> ${escapeHtml(outcomeLabel)}</p>`);
    const fetched = Number(meta.tradesFetched ?? 0);
    const limit = Number(meta.tradesFetchLimit ?? 1000);
    const fetchOk = meta.tradesFetchOk === true;
    const pairCount = Number(meta.pairTradeCount ?? 0);
    const lookback = formatTradesFetchLookback(meta.tradesOldestBlockTime);
    const oldestAt =
      typeof meta.tradesOldestAt === 'string' && meta.tradesOldestAt.trim()
        ? meta.tradesOldestAt.trim()
        : '';
    const lookbackBit = lookback
      ? ` · ${lookback}${oldestAt ? ` <span class="rvt-log__muted" title="${escapeHtml(oldestAt)}">(from ${escapeHtml(formatTradesOldestLabel(oldestAt))})</span>` : ''}`
      : '';
    parts.push(
      `<p class="rvt-log__line"><strong>Trades:</strong> ${fetched} rows (limit ${limit})${fetchOk ? '' : ' (empty)'} — ${pairCount} matched sell→buy pair${lookbackBit}</p>`,
    );
    const maxCount = Number(meta.maxTradeCount ?? 0);
    const minThreshold = Number(meta.minCountThreshold ?? 0);
    const tradeEligible = Number(meta.tradeMarketsEligible ?? 0);
    const queued = Array.isArray(meta.queued) ? meta.queued : [];
    parts.push(
      `<p class="rvt-log__line"><strong>Markets:</strong> top pool ${maxCount} trades — queue ≥ ${Math.round(minThreshold)} (5% rule, max 5 tries) · ${tradeEligible} eligible · ${queued.length} queued</p>`,
    );
  }
  parts.push('</div>');

  const topMarkets = Array.isArray(meta.topMarkets) ? (meta.topMarkets as Record<string, unknown>[]) : [];
  if (topMarkets.length > 0) {
    parts.push('<div class="rvt-log__section"><h5 class="rvt-log__heading">Ranked from trades</h5><ul class="rvt-log__list">');
    for (const row of topMarkets) {
      const rank = Number(row.rank ?? 0);
      const label = String(row.programLabel ?? '');
      const addr = String(row.marketAddress ?? '');
      const count = Number(row.tradeCount ?? 0);
      const eligible = row.eligible === true;
      const supported = row.supportedProgram === true;
      parts.push(
        `<li class="rvt-log__item${eligible ? '' : ' rvt-log__item--fail'}">` +
          `#${rank} <strong>${count}</strong> trades · ${escapeHtml(label)} ` +
          `<code class="rvt-log__addr" title="${escapeHtml(addr)}">${escapeHtml(shortSolAddress(addr, 6, 6))}</code> ` +
          `${eligible ? '<span class="rvt-log__badge rvt-log__badge--ok">queued</span>' : supported ? '<span class="rvt-log__badge rvt-log__badge--fail">&lt;5%</span>' : '<span class="rvt-log__badge rvt-log__badge--fail">unsupported</span>'}` +
          `</li>`,
      );
    }
    parts.push('</ul></div>');
  }

  const queued = Array.isArray(meta.queued) ? (meta.queued as Record<string, unknown>[]) : [];
  if (queued.length > 0) {
    parts.push('<div class="rvt-log__section"><h5 class="rvt-log__heading">Build queue</h5><ul class="rvt-log__list">');
    for (const q of queued) {
      const idx = Number(q.queueIndex ?? 0);
      const label = String(q.programLabel ?? '');
      const addr = String(q.marketAddress ?? '');
      const count = Number(q.tradeCount ?? 0);
      parts.push(
        `<li class="rvt-log__item"><span class="rvt-log__badge rvt-log__badge--queue">#${idx}</span> ` +
          `<strong>${count}</strong> trades · ${escapeHtml(label)} ` +
          `<code class="rvt-log__addr" title="${escapeHtml(addr)}">${escapeHtml(shortSolAddress(addr, 6, 6))}</code></li>`,
      );
    }
    parts.push('</ul></div>');
  }

  const buildLog = Array.isArray(meta.buildLog) ? (meta.buildLog as Record<string, unknown>[]) : [];
  if (buildLog.length > 0) {
    parts.push('<div class="rvt-log__section"><h5 class="rvt-log__heading">Build attempts</h5><ul class="rvt-log__list">');
    for (const entry of buildLog) {
      const ok = entry.success === true;
      const idx = Number(entry.queueIndex ?? 0);
      const attempt = String(entry.attempt ?? '');
      const provider = entry.provider ? String(entry.provider) : '';
      const err = entry.error ? String(entry.error) : '';
      const statusClass = ok ? 'ok' : 'fail';
      const providerBit = provider ? ` · ${escapeHtml(provider)}` : '';
      const errBit = err ? `<span class="rvt-log__err" title="${escapeHtml(err)}">${escapeHtml(err.length > 80 ? `${err.slice(0, 77)}…` : err)}</span>` : '';
      parts.push(
        `<li class="rvt-log__item rvt-log__item--${statusClass}">` +
          `<span class="rvt-log__badge rvt-log__badge--${statusClass}">${ok ? 'OK' : 'FAIL'}</span> ` +
          `#${idx} ${escapeHtml(attempt)}${providerBit}${errBit ? ` — ${errBit}` : ''}</li>`,
      );
    }
    parts.push('</ul></div>');
  }

  const selected = meta.selected as Record<string, unknown> | undefined;
  if (selected && typeof selected === 'object' && selected.marketAddress) {
    const addr = String(selected.marketAddress);
    const programLabel = String(selected.programLabel ?? selected.programAddress ?? '');
    const programBit = programLabel
      ? ` <span class="rvt-log__muted">(${escapeHtml(programLabel)})</span>`
      : '';
    parts.push(
      `<p class="rvt-log__line rvt-log__line--selected"><strong>Selected pool:</strong> ` +
        `<code class="rvt-log__addr" title="${escapeHtml(addr)}">${escapeHtml(shortSolAddress(addr, 8, 8))}</code>${programBit}</p>`,
    );
  }

  const recoveryLog = Array.isArray(meta.recoveryLog) ? (meta.recoveryLog as Record<string, unknown>[]) : [];
  if (recoveryLog.length > 0) {
    parts.push('<div class="rvt-log__section"><h5 class="rvt-log__heading">Recovery</h5><ul class="rvt-log__list">');
    for (const step of recoveryLog) {
      const ok = step.success === true;
      const name = String(step.step ?? '').replace(/_/g, ' ');
      const provider = step.provider ? String(step.provider) : '';
      const err = step.error ? String(step.error) : '';
      const statusClass = ok ? 'ok' : 'fail';
      parts.push(
        `<li class="rvt-log__item rvt-log__item--${statusClass}">` +
          `<span class="rvt-log__badge rvt-log__badge--${statusClass}">${ok ? 'OK' : 'FAIL'}</span> ` +
          `${escapeHtml(name)}${provider ? ` · ${escapeHtml(provider)}` : ''}` +
          `${err ? ` — <span class="rvt-log__err">${escapeHtml(err)}</span>` : ''}</li>`,
      );
    }
    parts.push('</ul></div>');
  }

  if (meta.lastError && (meta.directRouteFailed === true || outcome === 'jupiter_fallback' || outcome === 'titan_fallback' || outcome === 'unpinned_vybe')) {
    const err = String(meta.lastError);
    parts.push(`<p class="rvt-log__line rvt-log__line--warn"><strong>Last queue error:</strong> ${escapeHtml(err)}</p>`);
  }

  const timings = meta.timingsMs as Record<string, number> | undefined;
  if (timings && typeof timings === 'object') {
    const bits: string[] = [];
    if (timings.fetchTrades != null) bits.push(`trades fetch ${timings.fetchTrades}ms`);
    const probeMs = timings.sequentialProbe ?? timings.parallelProbe;
    if (probeMs != null) bits.push(`queue probe ${probeMs}ms`);
    if (timings.total != null) bits.push(`route total ${timings.total}ms`);
    if (bits.length > 0) {
      parts.push(`<p class="rvt-log__line rvt-log__line--muted"><strong>Timing:</strong> ${escapeHtml(bits.join(' · '))}</p>`);
    }
  }

  parts.push('</div>');
  return parts.join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
