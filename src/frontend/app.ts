/**
 * Swap quote & build UI — built from TypeScript; compiles to public/app.js.
 */

import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import {
  buildTokenHintsForMints,
  ensureTokenCatalogLoaded,
  ensureTokenMetaForMint,
  getCachedTokenMeta,
  getTokenDecimalsFromCache,
  getWalletSellableAmountUi,
  getWalletBalanceAmountUi,
  isSolMint,
  preferNativeSolMint,
  NATIVE_SOL_MINT,
  SOL_MIN_AUTO_PICK_TOTAL_UI,
  WSOL_MINT,
  initTokenPicker,
  openTokenPicker,
  prefetchTokenMetas,
  prefetchWalletBalances,
  refreshWalletBalancesPanel,
  renderChipTokenIcon,
  resolveLogoUrl,
  saveTokenPriceStats,
  saveWalletBalanceItemsToCache,
  type TokenPickerSide,
  type TokenPriceStats,
  type WalletBalanceListItem,
} from './token-picker.js';

interface TokenSymbolResponse {
  symbol?: string;
  decimals?: number;
  error?: string;
}

interface VybeSwapInfoLite {
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

interface HopFeeItemLite {
  label: string;
  amountRaw: string;
  mint: string;
  destinationAddress?: string;
  destinationKind?: 'lp_pool' | 'new_token_account' | 'fee_recipient' | 'output_deduction' | 'input_wallet' | 'network_priority';
  destinationNote?: string;
  pdaRent?: {
    label: string;
    amountRaw: string;
    mint: string;
  };
}

interface HopFeeBreakdownLite {
  items: HopFeeItemLite[];
  totalAmountRaw: string;
  mint: string;
  quotedOutRaw?: string;
  netOutRaw?: string;
}

interface VybeRoutePlanStepLite {
  percent?: number;
  bps?: number | null;
  swapInfo?: VybeSwapInfoLite;
  _hopFees?: HopFeeBreakdownLite;
}

const MAX_FETCH_RETRIES = 5;
const FETCH_RETRY_DELAY_MS = 2000;
const VYBE_QUOTE_TX_REUSE_MS = 45_000;
const ACC_RENT_FEE_LABEL = 'Acc Rent Fee';

/** Hardcoded mint → symbol; never fetch these from API. */
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
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const STABLECOIN_USD_FALLBACK_PRICE = 1;

/** Prefer SOL, then USDC, then USDT when auto-picking sell token from wallet balances. */
const SELL_TOKEN_PRIORITY_MINTS: readonly string[] = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
];

let walletBalanceFetchGen = 0;
let walletBalanceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastWalletBalanceFetchAddress = '';
let lastAutoAppliedWalletAddress = '';

const swapQuoteLoading = document.getElementById('swapQuoteLoading') as HTMLElement | null;
const swapQuoteError = document.getElementById('swapQuoteError') as HTMLElement | null;
const swapQuoteWarning = document.getElementById('swapQuoteWarning') as HTMLElement | null;
const swapWalletAddressInput = document.getElementById('swapWalletAddress') as HTMLInputElement | null;
const swapInputMintInput = document.getElementById('swapInputMint') as HTMLInputElement | null;
const swapOutputMintInput = document.getElementById('swapOutputMint') as HTMLInputElement | null;
const swapAmountInput = document.getElementById('swapAmount') as HTMLInputElement | null;
const swapInputTokenBtn = document.getElementById('swapInputTokenBtn') as HTMLButtonElement | null;
const swapOutputTokenBtn = document.getElementById('swapOutputTokenBtn') as HTMLButtonElement | null;
const swapInputTokenIconEl = document.getElementById('swapInputTokenIcon') as HTMLElement | null;
const swapOutputTokenIconEl = document.getElementById('swapOutputTokenIcon') as HTMLElement | null;
const swapSlippageInput = document.getElementById('swapSlippage') as HTMLInputElement | null;
const swapRouterInput = document.getElementById('swapRouter') as HTMLInputElement | null;
const swapRouterSwitchEl = document.getElementById('swapRouterSwitch') as HTMLElement | null;
const swapVybeFallbackRowEl = document.getElementById('swapVybeFallbackRow') as HTMLElement | null;
const swapRouterFallbackLabelEl = document.getElementById('swapRouterFallbackLabel') as HTMLElement | null;
const swapRouterFallbackSwitchEl = document.getElementById('swapRouterFallbackSwitch') as HTMLLabelElement | null;
const swapVybeFallbackCheckbox = document.getElementById('swapVybeFallback') as HTMLInputElement | null;
const swapGaslessCheckbox = document.getElementById('swapGasless') as HTMLInputElement | null;
const swapAutoSlippageCheckbox = document.getElementById('swapAutoSlippage') as HTMLInputElement | null;
const swapSimulateCheckbox = document.getElementById('swapSimulate') as HTMLInputElement | null;
const swapEnablePartnerCheckbox = document.getElementById('swapEnablePartner') as HTMLInputElement | null;
const swapPartnerFieldEl = document.getElementById('swapPartnerField') as HTMLElement | null;
const swapPartnerInput = document.getElementById('swapPartner') as HTMLInputElement | null;
const swapEnablePoolAddressCheckbox = document.getElementById('swapEnablePoolAddress') as HTMLInputElement | null;
const swapPoolAddressFieldEl = document.getElementById('swapPoolAddressField') as HTMLElement | null;
const swapPoolAddressInput = document.getElementById('swapPoolAddress') as HTMLInputElement | null;
const swapEnableProtocolCheckbox = document.getElementById('swapEnableProtocol') as HTMLInputElement | null;
const swapProtocolFieldEl = document.getElementById('swapProtocolField') as HTMLElement | null;
const swapProtocolSelect = document.getElementById('swapProtocol') as HTMLSelectElement | null;
const swapEnableServiceFeeCheckbox = document.getElementById('swapEnableServiceFee') as HTMLInputElement | null;
const swapServiceFeeFieldEl = document.getElementById('swapServiceFeeField') as HTMLElement | null;
const swapServiceFeeInput = document.getElementById('swapServiceFee') as HTMLInputElement | null;
const swapQuoteBtn = document.getElementById('swapQuoteBtn') as HTMLButtonElement | null;
const swapBuildBtn = document.getElementById('swapBuildBtn') as HTMLButtonElement | null;
const swapBuildResultEl = document.getElementById('swapBuildResult') as HTMLElement | null;
const swapTxBase64El = document.getElementById('swapTxBase64') as HTMLTextAreaElement | null;
const swapCopyTxBtn = document.getElementById('swapCopyTxBtn') as HTMLButtonElement | null;
const swapModeBuildBtn = document.getElementById('swapModeBuild') as HTMLButtonElement | null;
const swapModeBuildSignBtn = document.getElementById('swapModeBuildSign') as HTMLButtonElement | null;
const swapModePasteSignBtn = document.getElementById('swapModePasteSign') as HTMLButtonElement | null;
const swapPasteSignPanelEl = document.getElementById('swapPasteSignPanel') as HTMLElement | null;
const swapPasteTxInputEl = document.getElementById('swapPasteTxInput') as HTMLTextAreaElement | null;
const swapStandardFlowEl = document.getElementById('swapStandardFlow') as HTMLElement | null;
const swapConnectWalletBtn = document.getElementById('swapConnectWalletBtn') as HTMLButtonElement | null;
const swapConnectWalletBtnIconEl = document.getElementById('swapConnectWalletBtnIcon') as HTMLElement | null;
const swapConnectWalletBtnTextEl = document.getElementById('swapConnectWalletBtnText') as HTMLElement | null;
const swapDisconnectWalletBtn = document.getElementById('swapDisconnectWalletBtn') as HTMLButtonElement | null;
const swapWalletSignRowEl = document.getElementById('swapWalletSignRow') as HTMLElement | null;
const swapBuildResultTitleEl = document.getElementById('swapBuildResultTitle') as HTMLElement | null;
const swapBuildResultMetaEl = document.getElementById('swapBuildResultMeta') as HTMLElement | null;
const swapAdvancedBuildHintEl = document.getElementById('swapAdvancedBuildHint') as HTMLElement | null;

interface SolanaWalletProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect?: () => Promise<{ publicKey: { toString(): string } }>;
  disconnect?: () => Promise<void>;
  signTransaction?: (tx: unknown) => Promise<{ serialize(): Uint8Array }>;
  signAllTransactions?: (txs: unknown[]) => Promise<Array<{ serialize(): Uint8Array }>>;
  signAndSendTransaction?: (
    tx: unknown,
    options?: { skipPreflight?: boolean; maxRetries?: number; preflightCommitment?: string },
  ) => Promise<{ signature: string }>;
}

interface SignableVersionedTransaction {
  serialize(): Uint8Array;
}

type WindowWithSolana = Window & {
  solana?: SolanaWalletProvider;
  phantom?: { solana?: SolanaWalletProvider };
  bs58?: { decode(source: string): Uint8Array };
  __swapBrowserConnection?: Connection;
};

function getSolanaWindow(): WindowWithSolana {
  return window as WindowWithSolana;
}

const swapInputSymbolEl = document.getElementById('swapInputSymbol') as HTMLElement | null;
const swapOutputSymbolEl = document.getElementById('swapOutputSymbol') as HTMLElement | null;
const swapSellLabelTokenEl = document.getElementById('swapSellLabelToken') as HTMLElement | null;
const swapBuyLabelTokenEl = document.getElementById('swapBuyLabelToken') as HTMLElement | null;
const swapBuyAmountDisplayEl = document.getElementById('swapBuyAmountDisplay') as HTMLElement | null;
const swapSellFiatEl = document.getElementById('swapSellFiat') as HTMLElement | null;
const swapBuyFiatEl = document.getElementById('swapBuyFiat') as HTMLElement | null;
const swapFooterRateEl = document.getElementById('swapFooterRate') as HTMLElement | null;
const swapFooterImpactEl = document.getElementById('swapFooterImpact') as HTMLElement | null;
const swapFooterMinOutEl = document.getElementById('swapFooterMinOut') as HTMLElement | null;
const swapFooterMaxSlippageEl = document.getElementById('swapFooterMaxSlippage') as HTMLElement | null;
const swapRouteBtnEl = document.getElementById('swapRouteBtn') as HTMLButtonElement | null;
const swapRouteChipTextEl = swapRouteBtnEl?.querySelector('.swap-route-chip-text') as HTMLElement | null;
const swapFlipBtnEl = document.getElementById('swapFlipBtn') as HTMLButtonElement | null;
const swapPasteOutputBtnEl = document.getElementById('swapPasteOutputBtn') as HTMLButtonElement | null;
const swapCardSellEl = document.getElementById('swapCardSell') as HTMLElement | null;
const swapCardBuyEl = document.getElementById('swapCardBuy') as HTMLElement | null;

const routingDialogEl = document.getElementById('routingDialog') as HTMLDialogElement | null;
const routingDialogTitleEl = document.getElementById('routingDialogTitle') as HTMLElement | null;
const routingDialogBodyEl = document.getElementById('routingDialogBody') as HTMLElement | null;
const routingDialogCloseEl = document.getElementById('routingDialogClose') as HTMLButtonElement | null;
const swapSignConfirmDialogEl = document.getElementById('swapSignConfirmDialog') as HTMLDialogElement | null;
const swapSignConfirmPayEl = document.getElementById('swapSignConfirmPay') as HTMLElement | null;
const swapSignConfirmReceiveEl = document.getElementById('swapSignConfirmReceive') as HTMLElement | null;
const swapSignConfirmRouteEl = document.getElementById('swapSignConfirmRoute') as HTMLElement | null;
const swapSignConfirmProceedEl = document.getElementById('swapSignConfirmProceed') as HTMLButtonElement | null;
const swapSignConfirmCancelEl = document.getElementById('swapSignConfirmCancel') as HTMLButtonElement | null;
const swapSignConfirmCloseEl = document.getElementById('swapSignConfirmClose') as HTMLButtonElement | null;
const swapPairCardsEl = document.getElementById('swapPairCards') as HTMLElement | null;
const swapQuoteDetailsEmptyEl = document.getElementById('swapQuoteDetailsEmpty') as HTMLElement | null;
const swapQuoteDetailsBodyEl = document.getElementById('swapQuoteDetailsBody') as HTMLElement | null;
const swapQuoteDetailsRoutingEl = document.getElementById('swapQuoteDetailsRouting') as HTMLElement | null;
const swapQuoteRouteSubtitleEl = document.getElementById('swapQuoteRouteSubtitle') as HTMLElement | null;
const swapQuoteDetailsFieldsEl = document.getElementById('swapQuoteDetailsFields') as HTMLElement | null;
const swapQuoteDetailsRouteStepsEl = document.getElementById('swapQuoteDetailsRouteSteps') as HTMLElement | null;
const swapQuoteRoutePlanDetailsEl = document.getElementById('swapQuoteRoutePlanDetails') as HTMLDetailsElement | null;
const swapQuoteSummaryEl = document.getElementById('swapQuoteSummary') as HTMLElement | null;
const swapRawQuoteResponseEl = document.getElementById('swapRawQuoteResponse') as HTMLElement | null;
const swapRawSwapResponseEl = document.getElementById('swapRawSwapResponse') as HTMLElement | null;

/** Last successful swap quote response (for build tx validation). */
let lastSwapQuoteOk: Record<string, unknown> | null = null;
let lastRawQuoteResponse: unknown = null;
let lastRawSwapResponse: unknown = null;
let lastVybeBuild: { tx: string; builtAt: number; paramsKey: string; buildPayload: unknown } | null = null;
const quotedMintSession = new Set<string>();
let pairTokenStats: Record<string, TokenPriceStats> = {};

type SwapBuildMode = 'build' | 'build-sign' | 'paste-sign';
let swapBuildMode: SwapBuildMode = 'build-sign';
let walletConnectLoading = false;
let swapQuoteFetching = false;
let swapQuoteWalletSnapshot = '';

function renderLoadingSpinner(size: 'sm' | 'md' | 'lg' = 'sm'): string {
  return `<span class="inline-loading-spinner inline-loading-spinner--${size}" aria-hidden="true"></span>`;
}

function setSwapQuoteButtonLoading(loading: boolean): void {
  if (!swapQuoteBtn) return;
  swapQuoteBtn.disabled = loading;
  swapQuoteBtn.classList.toggle('swap-action-btn--loading', loading);
  swapQuoteBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
  const labelEl = swapQuoteBtn.querySelector('.swap-action-btn__label');
  const hintEl = swapQuoteBtn.querySelector('.swap-action-btn__hint');
  if (labelEl) labelEl.textContent = loading ? 'Loading…' : 'Get quote';
  if (hintEl) hintEl.textContent = loading ? 'Fetching route & pricing' : 'Fetch route & pricing';
}

function setFooterStatsLoading(loading: boolean): void {
  const html = loading ? renderLoadingSpinner('sm') : '—';
  if (swapFooterRateEl) swapFooterRateEl.innerHTML = html;
  if (swapFooterImpactEl) swapFooterImpactEl.innerHTML = html;
  if (swapFooterMinOutEl) swapFooterMinOutEl.innerHTML = html;
  if (swapFooterMaxSlippageEl) swapFooterMaxSlippageEl.innerHTML = html;
  if (swapRouteChipTextEl) swapRouteChipTextEl.innerHTML = html;
  if (swapRouteBtnEl) swapRouteBtnEl.disabled = true;
}

function setBuyReadoutLoading(loading: boolean): void {
  if (!swapBuyAmountDisplayEl) return;
  if (loading) {
    swapBuyAmountDisplayEl.innerHTML = renderLoadingSpinner('lg');
    swapBuyAmountDisplayEl.dataset.empty = 'true';
    swapBuyAmountDisplayEl.dataset.loading = 'true';
    swapBuyAmountDisplayEl.removeAttribute('title');
    return;
  }
  if (swapBuyAmountDisplayEl.dataset.loading === 'true') {
    swapBuyAmountDisplayEl.dataset.loading = 'false';
    swapBuyAmountDisplayEl.textContent = '0.00';
    swapBuyAmountDisplayEl.dataset.empty = 'true';
    swapBuyAmountDisplayEl.removeAttribute('title');
  }
}

function setBuyFiatLoading(loading: boolean): void {
  if (!swapBuyFiatEl) return;
  if (loading) {
    swapBuyFiatEl.innerHTML = renderLoadingSpinner('sm');
    return;
  }
  if (!lastSwapQuoteOk) swapBuyFiatEl.textContent = '~$0.00';
}

function refreshPendingQuoteUi(loading = swapQuoteFetching): void {
  if (swapQuoteSummaryEl) {
    swapQuoteSummaryEl.innerHTML = renderQuoteSummaryPlaceholder(loading);
  }
  if (swapQuoteDetailsRoutingEl) {
    swapQuoteDetailsRoutingEl.innerHTML = renderRoutingDiagramPlaceholder(loading);
  }
  scheduleRoutingDiagramZoom();
  if (swapQuoteDetailsRouteStepsEl) {
    swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanStepsPlaceholder(loading);
  }
  if (swapQuoteDetailsFieldsEl && loading) {
    swapQuoteDetailsFieldsEl.innerHTML = `<p class="routing-empty routing-empty--loading">${renderLoadingSpinner('sm')}</p>`;
  }
}

function applyQuoteLoadingUi(): void {
  swapQuoteFetching = true;
  setSwapQuoteButtonLoading(true);
  setFooterStatsLoading(true);
  setBuyReadoutLoading(true);
  setBuyFiatLoading(true);
  refreshPendingQuoteUi(true);
  updateSwapPairCards(undefined, true);
}

/** Mint → symbol cache for route hop labels (filled after quote). */
const routeMintSymbolCache: Record<string, string> = {};
const routeMintDecimalsCache: Record<string, number> = {};

interface RouteHopLeg {
  inMint: string;
  outMint: string;
  inSym: string;
  outSym: string;
  inAmt: string;
  outAmt: string;
}

interface RouteHopMeta {
  step: VybeRoutePlanStepLite;
  planIndex: number;
  label: string;
}

type RouteNode =
  | { kind: 'empty' }
  | { kind: 'seq'; nodes: RouteNode[] }
  | { kind: 'hop'; meta: RouteHopMeta }
  | { kind: 'fork'; branches: RouteNode[]; depth: number };

function showInlineError(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.hidden = false;
  el.removeAttribute('aria-hidden');
}

function clearInlineError(el: HTMLElement): void {
  el.textContent = '';
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}

function showInlineWarning(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.hidden = false;
  el.removeAttribute('aria-hidden');
}

function clearInlineWarning(el: HTMLElement): void {
  el.textContent = '';
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}

async function refreshLowSolTradeWarning(): Promise<void> {
  if (!swapQuoteWarning) return;
  clearInlineWarning(swapQuoteWarning);

  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  if (!wallet || !inputMint || !outputMint || !isValidSolanaWalletAddress(wallet)) return;
  if (isSolMint(inputMint)) return;

  const gasless = swapGaslessCheckbox?.checked === true;
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    gasless: gasless ? '1' : '0',
  });

  try {
    const res = await fetch(
      `/api/wallets/${encodeURIComponent(wallet)}/low-sol-trade-warning?${params.toString()}`,
    );
    const body = (await res.json().catch(() => ({}))) as { warn?: boolean; message?: string };
    if (body.warn && body.message) {
      showInlineWarning(swapQuoteWarning, body.message);
    }
  } catch {
    /* non-blocking */
  }
}

function truncate(s: string | undefined, front = 4, back = 4): string {
  if (!s) return '—';
  if (s.length <= front + back + 4) return s;
  return s.slice(0, front) + '....' + s.slice(-back);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n: number, maxFrac: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function fmtTrailingAfterZero(n: number): string | null {
  const abs = Math.abs(n);
  if (abs >= 0.1 || abs === 0) return null;
  const s = abs.toFixed(10);
  if (!s.startsWith('0.')) return null;
  let i = 2;
  while (i < s.length && s[i] === '0') i++;
  if (i >= s.length) return (n < 0 ? '-' : '') + s;
  const prefix = s.slice(0, i);
  const threeDigits = s.slice(i, i + 3);
  return (n < 0 ? '-' : '') + prefix + threeDigits;
}

function fmtPointOneToOne(n: number): string | null {
  const abs = Math.abs(n);
  if (abs < 0.1 || abs >= 1) return null;
  return String(Math.floor(n * 1000) / 1000);
}

const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
function toSuperscript(exp: number): string {
  if (exp >= 0) return SUPERSCRIPT_DIGITS[exp] ?? String(exp);
  const s = String(exp);
  return '⁻' + s.slice(1).replace(/\d/g, (d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d);
}

function fmtSmallNumber(n: number): string | null {
  const abs = Math.abs(n);
  if (abs === 0 || abs >= 0.001) return null;
  const exp = Math.floor(Math.log10(abs));
  const numZeros = -exp;
  const mantissa = n * 10 ** -exp;
  const rounded = Math.round(mantissa * 100) / 100;
  const digits = String(rounded.toFixed(2)).replace('.', '').replace(/0+$/, '');
  return `0.0${toSuperscript(numZeros)}${digits}`;
}

function fmtUsd(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  const small = fmtSmallNumber(n);
  if (small !== null) return `$${small}`;
  const trailing = fmtTrailingAfterZero(n);
  if (trailing !== null) return `$${trailing}`;
  const pointOneToOne = fmtPointOneToOne(n);
  if (pointOneToOne !== null) return `$${pointOneToOne}`;
  const abs = Math.abs(n);
  const maxFrac = abs >= 9.99 ? 0 : abs >= 1 ? 2 : 9;
  return `$${fmtNum(n, maxFrac)}`;
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

function displaySymbol(sym: string): string {
  return sym === 'WSOL' ? 'SOL' : sym;
}

async function fetchSymbol(mint: string): Promise<string> {
  const m = mint.trim();
  if (!m) return '—';
  const hard = HARDCODED_MINT_SYMBOLS[m];
  if (hard) return hard;
  const res = await fetchWithRetry(`/api/token-symbol/${encodeURIComponent(m)}`);
  const body = (await res.json().catch(() => ({}))) as TokenSymbolResponse;
  const sym = (body.symbol ?? m).replace(/\0/g, '').trim();
  return displaySymbol(sym || truncate(m, 4, 4));
}

function resolvedSideSymbol(mint: string, chipSymbol: string): string {
  const chip = chipSymbol?.trim();
  if (chip && chip !== '—') return displaySymbol(chip);
  const metaSym = getCachedTokenMeta(mint)?.symbol?.trim();
  if (metaSym) return displaySymbol(metaSym);
  const hard = HARDCODED_MINT_SYMBOLS[mint.trim()];
  if (hard) return hard;
  return '';
}

function looksLikeTruncatedAddress(value: string, mint: string): boolean {
  if (!value || value === mint) return false;
  if (value === truncate(mint, 4, 4)) return true;
  return /^[1-9A-HJ-NP-Za-km-z]{4}[.…]{1,5}[1-9A-HJ-NP-Za-km-z]{4}$/.test(value);
}

function swapSideTokenName(mint: string, chipSymbol: string): string {
  const m = mint.trim();
  if (!m) return '';

  if (HARDCODED_MINT_NAMES[m] || isSolMint(m)) return 'Solana';

  const meta = getCachedTokenMeta(m);
  const metaName = meta?.name?.trim();
  if (metaName && !looksLikeTruncatedAddress(metaName, m)) return metaName;

  const sym = resolvedSideSymbol(m, chipSymbol);
  if (sym) return sym;

  return truncate(m, 4, 4);
}

async function syncSwapSideLabels(): Promise<void> {
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const mints = [...new Set([inMint, outMint].filter(Boolean))];
  await Promise.all(mints.map((mint) => ensureTokenMetaForMint(mint)));
  const sellSym = getSwapInSym();
  const buySym = getSwapOutSym();
  if (swapSellLabelTokenEl) swapSellLabelTokenEl.textContent = swapSideTokenName(inMint, sellSym);
  if (swapBuyLabelTokenEl) swapBuyLabelTokenEl.textContent = swapSideTokenName(outMint, buySym);
}

async function refreshSwapSymbols(): Promise<void> {
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const tasks: Promise<void>[] = [];
  if (inMint && swapInputSymbolEl) {
    tasks.push(
      fetchSymbol(inMint).then((sym) => {
        swapInputSymbolEl!.textContent = sym;
      }),
    );
  }
  if (outMint && swapOutputSymbolEl) {
    tasks.push(
      fetchSymbol(outMint).then((sym) => {
        swapOutputSymbolEl!.textContent = sym;
      }),
    );
  }
  await Promise.all(tasks);
  await syncSwapSideLabels();
  updateSwapTokenIcons();
  updateSwapPairCards();
  if (!lastSwapQuoteOk) refreshSwapQuoteDetailsPlaceholders();
}

function updateSwapTokenIcons(): void {
  renderChipTokenIcon(swapInputTokenIconEl, swapInputMintInput?.value, endpointTokenDotClass(getSwapInSym()));
  renderChipTokenIcon(swapOutputTokenIconEl, swapOutputMintInput?.value, endpointTokenDotClass(getSwapOutSym()));
  updateSwapPairCards();
}

function trimUsdTrailingZeros(formatted: string): string {
  if (!formatted.includes('.')) return formatted;
  return formatted.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

/**
 * Fee SOL/USD equivalents — show 2 non-zero fractional digits (0.00012, 0.00302);
 * trim trailing zero on the 2nd when it would be 0 (0.00010 → 0.0001).
 */
function formatFeeEquivSmallAmount(n: number): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(abs) || abs === 0) return '0';
  if (abs >= 1) return trimUsdTrailingZeros(abs.toFixed(4));

  const frac = abs.toFixed(14).split('.')[1] ?? '';
  const nonZeroPositions: number[] = [];
  for (let i = 0; i < frac.length; i++) {
    if (frac[i] !== '0') {
      nonZeroPositions.push(i);
      if (nonZeroPositions.length === 2) break;
    }
  }
  if (nonZeroPositions.length === 0) return '0';

  const endPos =
    nonZeroPositions.length >= 2 ? nonZeroPositions[1]! + 1 : nonZeroPositions[0]! + 1;
  const fracOut = frac.slice(0, endPos).replace(/0+$/, '');
  return `0.${fracOut}`;
}

function formatFeeEquivUsdFiatDisplay(n: number): string {
  return `~$${formatFeeEquivSmallAmount(n)}`;
}

/** Sell / you-pay USD — always 2 decimal places. */
function formatSwapPayUsdAmount(n: number): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(abs)) return '0.00';
  return abs.toFixed(2);
}

function formatSwapPayFiatDisplay(v: unknown): string {
  if (v == null || v === '') return '~$0.00';
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return '~$0.00';
  return `~$${formatSwapPayUsdAmount(n)}`;
}

function formatSwapPayUsdLabel(v: unknown): string | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return null;
  return `$${formatSwapPayUsdAmount(n)}`;
}

/** Receive / output USD — min 2 dp, max 3 dp (0.8 → 0.80, 0.802 → 0.802). */
function formatSwapLegUsdAmount(n: number): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(abs)) return '0.00';
  const rounded = Math.round(abs * 1000) / 1000;
  if (rounded === 0) return '0.00';
  let s = rounded.toFixed(3);
  if (s.endsWith('0')) s = s.slice(0, -1);
  const dotIdx = s.indexOf('.');
  if (dotIdx === -1) return `${s}.00`;
  const fracLen = s.length - dotIdx - 1;
  if (fracLen < 2) return `${s}${'0'.repeat(2 - fracLen)}`;
  return s;
}

function formatSwapReceiveFiatDisplay(v: unknown): string {
  if (v == null || v === '') return '~$0.00';
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return '~$0.00';
  return `~$${formatSwapLegUsdAmount(n)}`;
}

function syncSwapSellAmountUi(): void {
  const amount = Number(swapAmountInput?.value);
  const hasPositiveAmount = Number.isFinite(amount) && amount > 0;

  if (!hasPositiveAmount) {
    lastSwapQuoteOk = null;
    lastVybeBuild = null;
    if (swapBuildBtn) syncBuildButtonState();
    if (swapBuyAmountDisplayEl) {
      swapBuyAmountDisplayEl.textContent = '0.00';
      swapBuyAmountDisplayEl.dataset.empty = 'true';
      swapBuyAmountDisplayEl.removeAttribute('title');
    }
    if (swapSellFiatEl) swapSellFiatEl.textContent = '~$0.00';
    if (swapBuyFiatEl) swapBuyFiatEl.textContent = '~$0.00';
    resetSwapQuoteDetailsPanel();
    if (swapFooterRateEl) swapFooterRateEl.textContent = '—';
    if (swapFooterImpactEl) swapFooterImpactEl.textContent = '—';
    if (swapFooterMinOutEl) swapFooterMinOutEl.textContent = '—';
    if (swapFooterMaxSlippageEl) swapFooterMaxSlippageEl.textContent = '—';
    setRouteChipLabel('—', true);
    if (routingDialogBodyEl) routingDialogBodyEl.innerHTML = '';
    return;
  }

  if (swapQuoteFetching) {
    const sellMint = swapInputMintInput?.value.trim() ?? '';
    const price = lookupMintPriceUsd(sellMint, lastSwapQuoteOk ?? {});
    if (sellMint && Number.isFinite(price) && price > 0 && swapSellFiatEl) {
      swapSellFiatEl.textContent = formatSwapPayFiatDisplay(amount * price);
    }
    setBuyReadoutLoading(true);
    setBuyFiatLoading(true);
    refreshPendingQuoteUi(true);
    updateSwapPairCards(undefined, true);
    return;
  }

  if (swapBuyFiatEl) swapBuyFiatEl.textContent = '~$0.00';
  const sellMint = swapInputMintInput?.value.trim() ?? '';
  const price = lookupMintPriceUsd(sellMint, lastSwapQuoteOk ?? {});
  if (!sellMint || !Number.isFinite(price) || price <= 0) {
    if (swapSellFiatEl) swapSellFiatEl.textContent = '~$0.00';
    refreshSwapQuoteDetailsPlaceholders();
    return;
  }
  if (swapSellFiatEl) swapSellFiatEl.textContent = formatSwapPayFiatDisplay(amount * price);
  refreshSwapQuoteDetailsPlaceholders();
}

function resetSwapQuoteToMock(): void {
  swapQuoteFetching = false;
  setSwapQuoteButtonLoading(false);
  if (swapQuoteLoading) {
    swapQuoteLoading.hidden = true;
    swapQuoteLoading.setAttribute('aria-hidden', 'true');
  }
  lastSwapQuoteOk = null;
  lastVybeBuild = null;
  lastRawQuoteResponse = null;
  swapQuoteWalletSnapshot = '';
  if (swapBuildBtn) syncBuildButtonState();
  setFooterStatsLoading(false);
  setBuyReadoutLoading(false);
  setBuyFiatLoading(false);
  if (swapBuyAmountDisplayEl) {
    swapBuyAmountDisplayEl.textContent = '0.00';
    swapBuyAmountDisplayEl.dataset.empty = 'true';
    swapBuyAmountDisplayEl.removeAttribute('title');
  }
  if (swapBuyFiatEl) swapBuyFiatEl.textContent = '~$0.00';
  if (swapFooterRateEl) swapFooterRateEl.textContent = '—';
  if (swapFooterImpactEl) swapFooterImpactEl.textContent = '—';
  if (swapFooterMinOutEl) swapFooterMinOutEl.textContent = '—';
  if (swapFooterMaxSlippageEl) swapFooterMaxSlippageEl.textContent = '—';
  setRouteChipLabel('—', true);
  if (routingDialogBodyEl) routingDialogBodyEl.innerHTML = '';
  if (swapBuildResultEl) swapBuildResultEl.hidden = true;
  if (swapTxBase64El) swapTxBase64El.value = '';
  resetSwapQuoteDetailsPanel();
  renderRawResponsePanels();
  syncSwapSellAmountUi();
}

function hasStaleSwapQuoteState(): boolean {
  return (
    lastSwapQuoteOk != null ||
    lastVybeBuild != null ||
    lastRawQuoteResponse != null ||
    swapQuoteFetching
  );
}

function invalidateSwapQuoteAfterInputChange(): void {
  if (!hasStaleSwapQuoteState()) return;
  resetSwapQuoteToMock();
}

function invalidateSwapQuoteUi(): void {
  resetSwapQuoteToMock();
}

const SOLANA_WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidSolanaWalletAddress(value: string): boolean {
  const addr = value.trim();
  if (!addr || !SOLANA_WALLET_RE.test(addr)) return false;
  try {
    const pk = new PublicKey(addr);
    return pk.toBase58() === addr;
  } catch {
    return false;
  }
}

function hasValidSwapWallet(): boolean {
  return isValidSolanaWalletAddress(swapWalletAddressInput?.value.trim() ?? '');
}

const SWAP_WALLET_LOCKED_TITLE = 'Enter or connect a valid Solana wallet first';

function lockTokenChipButton(
  btn: HTMLButtonElement | null,
  locked: boolean,
  lockedTitle: string,
): void {
  if (!btn) return;
  btn.classList.toggle('swap-token-chip--locked', locked);
  btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
  btn.tabIndex = locked ? -1 : 0;
  btn.title = locked ? lockedTitle : '';
}

function setWalletGatedDisabled(
  el: HTMLInputElement | HTMLButtonElement | HTMLSelectElement | null,
  disabled: boolean,
  lockedTitle = SWAP_WALLET_LOCKED_TITLE,
): void {
  if (!el) return;
  el.disabled = disabled;
  if (disabled) el.title = lockedTitle;
}

function syncSellTokenPickerState(): void {
  const valid = hasValidSwapWallet();
  lockTokenChipButton(
    swapInputTokenBtn,
    !valid,
    'Enter or connect a valid Solana wallet to choose a sell token',
  );
  lockTokenChipButton(
    swapOutputTokenBtn,
    !valid,
    'Enter or connect a valid Solana wallet to choose a buy token',
  );

  if (swapFlipBtnEl) {
    swapFlipBtnEl.disabled = !valid;
    swapFlipBtnEl.title = valid ? 'Flip tokens' : SWAP_WALLET_LOCKED_TITLE;
  }
  if (swapPasteOutputBtnEl) {
    swapPasteOutputBtnEl.disabled = !valid;
    swapPasteOutputBtnEl.title = valid ? 'Paste mint from clipboard' : SWAP_WALLET_LOCKED_TITLE;
  }

  setWalletGatedDisabled(swapAutoSlippageCheckbox, !valid);
  setWalletGatedDisabled(swapGaslessCheckbox, !valid);
  setWalletGatedDisabled(swapVybeFallbackCheckbox, !valid);
  setWalletGatedDisabled(swapEnablePoolAddressCheckbox, !valid);
  setWalletGatedDisabled(swapPoolAddressInput, !valid);
  setWalletGatedDisabled(swapEnableProtocolCheckbox, !valid);
  setWalletGatedDisabled(swapProtocolSelect, !valid);
  setWalletGatedDisabled(swapSimulateCheckbox, !valid);
  setWalletGatedDisabled(swapEnablePartnerCheckbox, !valid);
  setWalletGatedDisabled(swapPartnerInput, !valid);
  setWalletGatedDisabled(swapEnableServiceFeeCheckbox, !valid);
  setWalletGatedDisabled(swapServiceFeeInput, !valid);

  syncSlippageInputForAutoSlippage();
  syncSellPctButtonsState();
}

function getMaxSellPercentForMint(_mint: string): number {
  return 100;
}

function formatMaxSellPercentButtonLabel(_mint: string): string {
  return '100%';
}

function syncSellPctButtonsState(): void {
  const container = document.getElementById('swapSellPctBtns');
  if (!container) return;
  const mint = swapInputMintInput?.value.trim() ?? '';
  const enabled =
    hasValidSwapWallet() && mint.length > 0 && (getWalletSellableAmountUi(mint) ?? 0) > 0;
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.swap-sell-pct-btn')) {
    btn.disabled = !enabled;
  }
  const maxBtn = container.querySelector<HTMLButtonElement>('[data-sell-pct-max]');
  if (maxBtn && mint) {
    const maxPct = getMaxSellPercentForMint(mint);
    maxBtn.dataset.sellPct = String(maxPct);
    maxBtn.textContent = formatMaxSellPercentButtonLabel(mint);
  } else if (maxBtn) {
    maxBtn.dataset.sellPct = '100';
    maxBtn.textContent = '100%';
  }
}

function applySellAmountPercent(percent: number): void {
  if (!swapInputMintInput || !swapAmountInput) return;
  const mint = swapInputMintInput.value.trim();
  if (!mint) return;
  if (!hasValidSwapWallet()) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Enter or connect a wallet to set sell amount.');
    return;
  }

  const total = getWalletBalanceAmountUi(mint);
  if (total == null || total <= 0) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'No balance for this token in the connected wallet.');
    return;
  }

  const sellable = getWalletSellableAmountUi(mint);
  if (sellable == null || sellable <= 0) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Balance too low to sell this token.');
    return;
  }

  let amount =
    percent >= getMaxSellPercentForMint(mint) ? sellable : total * (percent / 100);
  if (amount > sellable) amount = sellable;
  if (amount <= 0) return;

  if (swapQuoteError) clearInlineError(swapQuoteError);
  setSwapSellAmountToBalance(amount, mint);
}

function formatSwapInputAmountValue(amount: number, decimals = 9): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  return formatSwapAmountValue(amount).replace(/,/g, '');
}

function findSolBalanceItem(items: WalletBalanceListItem[]): WalletBalanceListItem | null {
  const native = items.find((i) => i.mintAddress === NATIVE_SOL_MINT);
  const wrapped = items.find((i) => i.mintAddress === WSOL_MINT);
  if (!native && !wrapped) return null;
  const totalUi = (native?.amountUi ?? 0) + (wrapped?.amountUi ?? 0);
  if (totalUi < SOL_MIN_AUTO_PICK_TOTAL_UI) return null;
  const base = native ?? wrapped!;
  return {
    ...base,
    mintAddress: NATIVE_SOL_MINT,
    symbol: 'SOL',
    amountUi: totalUi,
  };
}

function pickDefaultSellBalance(items: WalletBalanceListItem[]): WalletBalanceListItem | null {
  const positive = items.filter((i) => i.amountUi > 0);
  if (positive.length === 0) return null;
  const sol = findSolBalanceItem(positive);
  if (sol) return sol;
  for (const mint of SELL_TOKEN_PRIORITY_MINTS) {
    if (isSolMint(mint)) continue;
    const hit = positive.find((i) => i.mintAddress === mint);
    if (hit) return hit;
  }
  return (
    positive
      .filter((i) => !isSolMint(i.mintAddress))
      .sort((a, b) => b.valueUsd - a.valueUsd || b.amountUi - a.amountUi)[0] ?? null
  );
}

function syncSwapAmountMaxFromBalance(): void {
  if (!swapAmountInput || !swapInputMintInput) return;
  const mint = swapInputMintInput.value.trim();
  const sellable = getWalletSellableAmountUi(mint);
  if (sellable != null && sellable > 0) {
    swapAmountInput.max = formatSwapInputAmountValue(sellable, getMintDecimals(mint));
  } else if (hasValidSwapWallet() && mint) {
    swapAmountInput.max = '0';
  } else {
    swapAmountInput.removeAttribute('max');
  }
  clampSwapAmountInputToMax();
  syncSellPctButtonsState();
  syncSwapSellAmountUi();
}

function getSwapAmountMaxUi(): number | null {
  if (!swapAmountInput) return null;
  const maxAttr = swapAmountInput.max;
  if (maxAttr !== '' && Number.isFinite(Number(maxAttr))) return Number(maxAttr);
  const mint = swapInputMintInput?.value.trim() ?? '';
  if (!mint || !hasValidSwapWallet()) return null;
  return getWalletSellableAmountUi(mint);
}

function clampSwapAmountInputToMax(): boolean {
  if (!swapAmountInput || !swapInputMintInput) return false;
  const raw = swapAmountInput.value.trim();
  if (!raw || raw === '.' || raw === '-') return false;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return false;
  const max = getSwapAmountMaxUi();
  if (max == null || amount <= max) return false;
  const mint = swapInputMintInput.value.trim();
  const formatted = formatSwapInputAmountValue(max, getMintDecimals(mint));
  if (swapAmountInput.value === formatted) return false;
  swapAmountInput.value = formatted;
  flashSellPct100Button();
  return true;
}

function flashSellPct100Button(): void {
  const btn = document
    .getElementById('swapSellPctBtns')
    ?.querySelector<HTMLButtonElement>('[data-sell-pct-max]');
  if (!btn) return;
  btn.classList.remove('swap-sell-pct-btn--max-flash');
  void btn.offsetWidth;
  btn.classList.add('swap-sell-pct-btn--max-flash');
  const onEnd = (): void => {
    btn.classList.remove('swap-sell-pct-btn--max-flash');
    btn.removeEventListener('animationend', onEnd);
  };
  btn.addEventListener('animationend', onEnd);
}

function setSwapSellAmountToBalance(amountUi: number, mint: string): void {
  if (!swapAmountInput) return;
  const formatted = formatSwapInputAmountValue(amountUi, getMintDecimals(mint));
  swapAmountInput.value = formatted;
  syncSwapAmountMaxFromBalance();
  swapAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function applySellTokenFromBalance(item: WalletBalanceListItem, useMaxAmount: boolean): void {
  if (!swapInputMintInput) return;
  const swapMint = preferNativeSolMint(item.mintAddress);
  swapInputMintInput.value = swapMint;
  const sym =
    item.symbol ||
    HARDCODED_MINT_SYMBOLS[swapMint] ||
    HARDCODED_MINT_SYMBOLS[item.mintAddress] ||
    item.mintAddress.slice(0, 6);
  if (swapInputSymbolEl) swapInputSymbolEl.textContent = sym === 'WSOL' ? 'SOL' : sym;
  void syncSwapSideLabels();
  if (item.decimals != null) routeMintDecimalsCache[swapMint] = item.decimals;
  updateSwapTokenIcons();
  updateSwapPairCards();
  void refreshSwapSymbols();
  syncSwapAmountMaxFromBalance();
  if (useMaxAmount) {
    const sellable = getWalletSellableAmountUi(swapMint);
    if (sellable != null && sellable > 0) {
      setSwapSellAmountToBalance(sellable, swapMint);
    }
  }
}

async function refreshWalletBalancesForSwap(wallet: string, applyDefaults: boolean): Promise<void> {
  const gen = ++walletBalanceFetchGen;
  const force = wallet !== lastWalletBalanceFetchAddress;
  try {
    const items = await prefetchWalletBalances(wallet, force);
    if (gen !== walletBalanceFetchGen) return;
    lastWalletBalanceFetchAddress = wallet;
    saveWalletBalanceItemsToCache(items);
    refreshWalletBalancesPanel();

    if (applyDefaults) {
      lastAutoAppliedWalletAddress = wallet;
      const pick = pickDefaultSellBalance(items);
      if (pick) {
        applySellTokenFromBalance(pick, true);
        return;
      }
    }

    syncSwapAmountMaxFromBalance();
  } catch {
    if (gen !== walletBalanceFetchGen) return;
    refreshWalletBalancesPanel();
  }
}

function onWalletAddressReady(immediate = false): void {
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (
    hasStaleSwapQuoteState() &&
    (!isValidSolanaWalletAddress(wallet) || wallet !== swapQuoteWalletSnapshot)
  ) {
    resetSwapQuoteToMock();
  }
  syncSellTokenPickerState();

  if (walletBalanceRefreshTimer) {
    clearTimeout(walletBalanceRefreshTimer);
    walletBalanceRefreshTimer = null;
  }

  if (!isValidSolanaWalletAddress(wallet)) {
    walletBalanceFetchGen++;
    lastWalletBalanceFetchAddress = '';
    lastAutoAppliedWalletAddress = '';
    if (swapAmountInput) swapAmountInput.removeAttribute('max');
    return;
  }

  if (swapQuoteError && !swapQuoteError.hidden) {
    clearInlineError(swapQuoteError);
  }

  const applyDefaults = wallet !== lastAutoAppliedWalletAddress;
  const run = (): void => {
    void refreshWalletBalancesForSwap(wallet, applyDefaults);
  };

  if (immediate) {
    run();
    return;
  }

  walletBalanceRefreshTimer = setTimeout(run, 300);
}

function tryOpenBuyTokenPicker(): void {
  if (!hasValidSwapWallet()) {
    if (swapQuoteError) {
      showInlineError(
        swapQuoteError,
        'Enter or connect a valid Solana wallet to choose a buy token.',
      );
    }
    return;
  }
  openTokenPicker('output');
}

function tryOpenSellTokenPicker(): void {
  if (!hasValidSwapWallet()) {
    if (swapQuoteError) {
      showInlineError(
        swapQuoteError,
        'Enter a valid Solana wallet address or connect your wallet to choose a sell token.',
      );
    }
    return;
  }
  openTokenPicker('input');
}

function wireTokenPickerOpen(
  btn: HTMLButtonElement | null,
  mintInput: HTMLInputElement | null,
  side: TokenPickerSide,
): void {
  if (!btn || !mintInput) return;
  if (side === 'input') {
    btn.addEventListener('click', tryOpenSellTokenPicker);
    mintInput.addEventListener('click', tryOpenSellTokenPicker);
    return;
  }
  btn.addEventListener('click', tryOpenBuyTokenPicker);
  mintInput.addEventListener('click', tryOpenBuyTokenPicker);
}

function applySelectedToken(mint: string, side: TokenPickerSide): void {
  invalidateSwapQuoteAfterInputChange();
  const input = side === 'input' ? swapInputMintInput : swapOutputMintInput;
  const symbolEl = side === 'input' ? swapInputSymbolEl : swapOutputSymbolEl;
  if (!input) return;
  const resolvedMint = side === 'input' ? preferNativeSolMint(mint) : mint;
  input.value = resolvedMint;
  const meta = getCachedTokenMeta(resolvedMint);
  if (meta && symbolEl) symbolEl.textContent = meta.symbol === 'WSOL' || meta.symbol === 'wSOL' ? 'SOL' : meta.symbol;
  void syncSwapSideLabels();
  if (meta?.decimals != null) routeMintDecimalsCache[resolvedMint] = meta.decimals;
  updateSwapTokenIcons();
  updateSwapPairCards();
  void refreshSwapSymbols();
  if (side === 'input') {
    syncSwapAmountMaxFromBalance();
    const sellable = getWalletSellableAmountUi(resolvedMint);
    if (sellable != null && sellable > 0) {
      setSwapSellAmountToBalance(sellable, resolvedMint);
    }
  }
  void prefetchSwapPairPrices({ forceFullDetails: true });
  void refreshLowSolTradeWarning();
}

function getSwapInSym(): string {
  const t = swapInputSymbolEl?.textContent?.trim();
  return t && t.length > 0 ? t : '—';
}

function getSwapOutSym(): string {
  const t = swapOutputSymbolEl?.textContent?.trim();
  return t && t.length > 0 ? t : '—';
}

function formatSwapReceiveUsdLabel(v: unknown): string | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return null;
  return `$${formatSwapLegUsdAmount(n)}`;
}

function quoteOutputUiAmount(quote: Record<string, unknown>): number | null {
  const outMint = quoteOutputMint(quote);
  const sim = parseRawAmountDigits(quote._simulatedOutAmount);
  if (sim) {
    const n = rawAmountToUiNumber(sim, getMintDecimals(outMint));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const raw = quote.outAmount;
  if (raw != null && raw !== '') {
    const digits = String(raw).replace(/,/g, '');
    if (/^\d+$/.test(digits)) {
      const n = rawAmountToUiNumber(digits, getMintDecimals(outMint));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const ui = quote.outAmountUi ?? quote.outAmountUI;
  if (typeof ui === 'number' && Number.isFinite(ui) && ui > 0) return ui;
  return null;
}

/** USD notional of the sell/input leg (what you pay). */
function getQuotePayUsd(quote: Record<string, unknown>): number | null {
  const fromQuote = quote.swapUsdValue;
  if (fromQuote != null && fromQuote !== '') {
    const n = Number(fromQuote);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const amount = quoteWalletPayUi(quote) ?? quoteInAmountUi(quote) ?? Number(swapAmountInput?.value);
  const inMint = quoteInputMint(quote);
  const inPrice = lookupMintPriceUsd(inMint, quote);
  if (Number.isFinite(amount) && amount > 0 && Number.isFinite(inPrice) && inPrice > 0) {
    return amount * inPrice;
  }
  return null;
}

/** USD notional of the receive/output leg (net out amount × output price, after on-chain deductions). */
function getQuoteReceiveUsd(quote: Record<string, unknown>): number | null {
  const outUi = quoteOutputUiAmount(quote);
  if (outUi == null) return null;
  const outMint = quoteOutputMint(quote);
  const outPrice = lookupMintPriceUsd(outMint, quote);
  if (!Number.isFinite(outPrice) || outPrice <= 0) return null;
  return outUi * outPrice;
}

function getMintDecimals(mint: string): number {
  const m = mint.trim();
  if (!m) return 9;
  const hard = HARDCODED_MINT_DECIMALS[m];
  if (hard != null) return hard;
  const fromPicker = getTokenDecimalsFromCache(m);
  if (fromPicker != null) return fromPicker;
  const cached = routeMintDecimalsCache[m];
  if (cached != null) return cached;
  return 9;
}

/** Convert on-chain integer amount (lamports / smallest units) to a UI number. */
function rawAmountToUiNumber(raw: string, decimals: number): number {
  const s = String(raw).trim().replace(/,/g, '');
  if (!s || !/^\d+$/.test(s)) return NaN;
  const bi = BigInt(s);
  const div = 10n ** BigInt(decimals);
  const whole = bi / div;
  const frac = bi % div;
  return Number(whole) + Number(frac) / Number(div);
}

function formatRawTokenAmount(
  raw: string | undefined,
  mint: string,
): { display: string; full: string } {
  if (raw == null || raw === '' || raw === '0') return { display: '—', full: '' };
  const decimals = getMintDecimals(mint);
  const digits = String(raw).replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return formatSwapAmount(raw);
  const bi = BigInt(digits);
  const div = 10n ** BigInt(decimals);
  const whole = bi / div;
  const frac = bi % div;
  const n = rawAmountToUiNumber(digits, decimals);
  const full = Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: decimals, useGrouping: true })
    : digits;
  if (whole > 0n) {
    if (!Number.isFinite(n)) return formatSwapAmount(raw);
    return { display: formatSwapAmountValue(n), full };
  }
  if (frac === 0n) return { display: '0', full };
  const fracStr = frac.toString().padStart(decimals, '0');
  return { display: formatFractionTail(fracStr), full };
}

function applySmallAmountTrailingZeroRule(digits: string): string {
  if (!digits) return '0';
  const trailingMatch = digits.match(/0+$/);
  const trailingCount = trailingMatch ? trailingMatch[0].length : 0;
  if (trailingCount >= 3) {
    const stripped = digits.replace(/0+$/, '');
    return stripped || '0';
  }
  return digits;
}

/** Sub-unit amounts: leading zeros preserved, then up to 4 non-zero fractional digits. */
function formatFractionTail(fracPadded: string): string {
  let i = 0;
  while (i < fracPadded.length && fracPadded[i] === '0') i++;
  if (i >= fracPadded.length) return '0';
  const leadingZeros = fracPadded.slice(0, i);
  let sig = '';
  let nonZeroCount = 0;
  for (let j = i; j < fracPadded.length; j++) {
    const d = fracPadded[j]!;
    if (nonZeroCount >= 4 && d === '0') break;
    sig += d;
    if (d !== '0') nonZeroCount++;
    if (nonZeroCount >= 4) break;
  }
  sig = sig.replace(/0+$/, '');
  return sig ? `0.${leadingZeros}${sig}` : '0';
}

function needsSmallDecimalFormat(n: number): boolean {
  const abs = Math.abs(n);
  if (abs === 0) return false;
  return Math.round(n * 10_000) / 10_000 === 0;
}

function formatSmallDecimalAmount(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  const zeroCount = Math.max(0, Math.floor(-Math.log10(abs)));
  const decPlaces = Math.min(100, zeroCount + 5);
  const s = abs.toFixed(decPlaces);
  const dot = s.indexOf('.');
  if (dot === -1) return sign + s;
  const fullFrac = s.slice(dot + 1);
  return sign + formatFractionTail(fullFrac);
}

function stripFormattedTrailingZeros(formatted: string): string {
  const match = formatted.match(/^(.+?)([.,])(\d+)$/);
  if (!match) return formatted;
  const frac = match[3]!.replace(/0+$/, '');
  return frac ? `${match[1]}${match[2]}${frac}` : match[1]!;
}

/** Full amount display: no k/m/b; ≥100k integer; <100k up to 4 decimals; tiny amounts show leading zeros. */
function formatSwapAmountValue(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 100_000) {
    return Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0, useGrouping: true });
  }
  if (needsSmallDecimalFormat(n) || abs < 1) {
    return formatSmallDecimalAmount(n);
  }
  const rounded = Math.round(n * 10_000) / 10_000;
  const formatted = rounded.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
    useGrouping: true,
  });
  return stripFormattedTrailingZeros(formatted);
}

function formatSwapAmount(value: unknown): { display: string; full: string } {
  if (value == null || value === '') return { display: '—', full: '' };
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) {
    const s = String(value);
    return { display: s, full: s };
  }
  const full = n.toLocaleString(undefined, { maximumFractionDigits: 12, useGrouping: true });
  return { display: formatSwapAmountValue(n), full };
}

function getQuoteOutputMint(quote: Record<string, unknown>): string {
  return quoteOutputMint(quote);
}

function swapInfoInputMint(si: VybeSwapInfoLite | undefined): string {
  return String(si?.inputMintAddress ?? si?.inputMint ?? '').trim();
}

function swapInfoOutputMint(si: VybeSwapInfoLite | undefined): string {
  return String(si?.outputMintAddress ?? si?.outputMint ?? '').trim();
}

function parseRawAmountDigits(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/,/g, '');
  return /^\d+$/.test(s) ? s : null;
}

function uiAmountToRawBigInt(amountUi: number, mint: string): bigint {
  const decimals = getMintDecimals(mint);
  const formatted = formatSwapInputAmountValue(amountUi, decimals);
  const [whole, frac = ''] = formatted.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(`${whole}${fracPadded}`);
}

function quoteInAmountRaw(quote: Record<string, unknown>): string | null {
  return parseRawAmountDigits(quote.inAmount);
}

function quoteInAmountUi(quote: Record<string, unknown>, mint?: string): number | null {
  const raw = quoteInAmountRaw(quote);
  if (!raw) return null;
  const m = mint ?? quoteInputMint(quote);
  if (!m) return null;
  const n = rawAmountToUiNumber(raw, getMintDecimals(m));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractAuthoritativeInAmountRaw(
  quoteBody: Record<string, unknown>,
  swapBody: Record<string, unknown>,
): string | null {
  const details = swapBody.details as Record<string, unknown> | undefined;
  const buildQuote = details?.quote as Record<string, unknown> | undefined;
  const fromBuild = parseRawAmountDigits(buildQuote?.inAmount);
  if (fromBuild) return fromBuild;

  const plan = quoteBody.routePlan;
  if (Array.isArray(plan) && plan.length > 0) {
    const hopIn = parseRawAmountDigits((plan[0] as VybeRoutePlanStepLite)?.swapInfo?.inAmount);
    if (hopIn) return hopIn;
  }

  return parseRawAmountDigits(quoteBody.inAmount);
}

/** Align sell input with on-chain inAmount from quote/build (Jupiter/Titan often normalize UI amount). */
function syncSellAmountInputFromInAmountRaw(raw: string, mint: string): number | null {
  if (!swapAmountInput || !mint) return null;
  const digits = parseRawAmountDigits(raw);
  if (!digits) return null;
  const { display } = formatRawTokenAmount(digits, mint);
  if (display === '—') return null;
  swapAmountInput.value = display.replace(/,/g, '');
  const n = Number(display.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function quoteInputMint(quote: Record<string, unknown>): string {
  return String(quote.inputMintAddress ?? quote.inputMint ?? swapInputMintInput?.value ?? '').trim();
}

function quoteOutputMint(quote: Record<string, unknown>): string {
  return String(quote.outputMintAddress ?? quote.outputMint ?? swapOutputMintInput?.value ?? '').trim();
}

function quoteUiAmount(quote: Record<string, unknown>, field: 'out' | 'min'): unknown {
  if (field === 'out') return quote.outAmountUi ?? quote.outAmountUI;
  return quote.otherAmountThresholdUi ?? quote.otherAmountThresholdUI;
}

/** Format quote out/min amounts — prefer raw on-chain integer + mint decimals (matches route hops). */
function formatQuoteTokenAmount(
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
    if (/^\d+$/.test(digits)) return formatRawTokenAmount(digits, mint);
  }
  const ui = quoteUiAmount(quote, field);
  if (typeof ui === 'number' && Number.isFinite(ui)) return formatSwapAmount(ui);
  if (ui != null && ui !== '') return formatSwapAmount(ui);
  return { display: '—', full: '' };
}

function quoteTokenAmountUiNumber(quote: Record<string, unknown>, field: 'out' | 'min'): number | null {
  const mint = getQuoteOutputMint(quote);
  const rawKey = field === 'out' ? 'outAmount' : 'otherAmountThreshold';
  const raw = quote[rawKey];
  if (raw != null && raw !== '') {
    const digits = String(raw).replace(/,/g, '');
    if (/^\d+$/.test(digits)) {
      const n = rawAmountToUiNumber(digits, getMintDecimals(mint));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const ui = quoteUiAmount(quote, field);
  if (typeof ui === 'number' && Number.isFinite(ui) && ui > 0) return ui;
  if (ui != null && ui !== '') {
    const n = Number(ui);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Max slippage % = (1 − min received ÷ output) × 100 */
function formatMaxSlippageRatio(quote: Record<string, unknown>): string {
  const out = quoteTokenAmountUiNumber(quote, 'out');
  const min = quoteTokenAmountUiNumber(quote, 'min');
  if (out == null || min == null || out <= 0) return '—';
  const pct = (1 - min / out) * 100;
  if (!Number.isFinite(pct)) return '—';
  const abs = Math.abs(pct);
  if (abs === 0) return '0%';
  if (abs < 0.01) return '< 0.01%';
  return `${pct.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 })}%`;
}

function formatSwapRate(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatSwapAmount(value).display;
}

/** Human-readable price impact — "< 0.01%" for tiny values, else max 2 decimals. */
function formatPriceImpactPct(value: unknown): string {
  if (value == null || value === '') return '—';
  const raw = String(value).trim().replace(/%$/, '');
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${String(value).replace(/%$/, '')}%`;

  const abs = Math.abs(n);
  if (abs === 0) return '0% (No Impact)';
  if (abs < 0.01) return '< 0.01%';

  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 })}%`;
}

/** Fees that belong in the hop table SOL/wallet column total (excludes output-side deductions). */
function isHopFeeTableWalletColumnItem(item: HopFeeItemLite, inputMint: string): boolean {
  if (isAccRentFeeLabel(item.label)) {
    return isSolMint(inputMint) && isSolMint(item.mint);
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
  if (label === 'protocol fee' || label === 'route fee' || label === 'priority fee') {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint;
  }
  return false;
}

function isWalletDebitedFeeItem(item: HopFeeItemLite, inputMint: string): boolean {
  if (isAccRentFeeLabel(item.label)) {
    return isSolMint(inputMint) && isSolMint(item.mint);
  }
  const kind = item.destinationKind;
  if (kind === 'lp_pool' || kind === 'output_deduction' || kind === 'network_priority') {
    return false;
  }
  if (kind === 'fee_recipient' || kind === 'input_wallet' || kind === 'new_token_account') {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint;
  }
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  if (label === 'pool fee') return false;
  if (label === 'protocol fee') {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint;
  }
  return false;
}

/** Hop fees actually debited from the wallet (matches Phantom), not output-side pool/route cuts. */
function sumInputSideWalletFeesInSellMintUi(quote: Record<string, unknown>): number | null {
  const sellMint = quoteInputMint(quote);
  if (!sellMint) return null;
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  let total = 0;
  let found = false;
  for (const step of plan) {
    const fees = getHopFeeBreakdown(step);
    for (const item of fees?.items ?? []) {
      if (!isWalletDebitedFeeItem(item, sellMint)) continue;
      const feeUi = feeAmountToUi(item.amountRaw, item.mint);
      if (feeUi == null || feeUi <= 0) continue;
      const sellUi =
        item.mint === sellMint ? feeUi : convertFeeUiToSellLeg(feeUi, item.mint, quote);
      if (sellUi != null && sellUi > 0) {
        total += sellUi;
        found = true;
      }
    }
  }
  return found && total > 0 ? total : null;
}

function estimateInputSideWalletPayDebitFromQuote(quote: Record<string, unknown>): string | null {
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
        if (isSolMint(inputMint) && isSolMint(item.mint)) total += BigInt(item.amountRaw);
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

function quoteWalletPayRaw(quote: Record<string, unknown>): string | null {
  return resolveWalletPayDebitRaw(quote);
}

function quoteWalletPayUi(quote: Record<string, unknown>, mint?: string): number | null {
  const raw = quoteWalletPayRaw(quote);
  if (!raw) return null;
  const m = mint ?? quoteInputMint(quote);
  if (!m) return null;
  const n = rawAmountToUiNumber(raw, getMintDecimals(m));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatQuoteRawAmountLabel(
  raw: string | null | undefined,
  mint: string | null | undefined,
): string | null {
  if (!raw || !mint) return null;
  const fmt = formatRawTokenAmount(raw, mint);
  return fmt.display !== '—' ? fmt.display : null;
}

function getQuoteSwapLegLabelFromQuote(quote: Record<string, unknown>): string {
  const mint = quoteInputMint(quote);
  const fromRaw = formatQuoteRawAmountLabel(quoteInAmountRaw(quote), mint);
  if (fromRaw) return fromRaw;
  return getQuoteWalletPayLabelFromQuote(quote);
}

function getQuoteWalletPayLabelFromQuote(quote: Record<string, unknown>): string {
  const mint = quoteInputMint(quote);
  const fromWalletPay = formatQuoteRawAmountLabel(quoteWalletPayRaw(quote), mint);
  if (fromWalletPay) return fromWalletPay;
  const fromSwapLeg = formatQuoteRawAmountLabel(quoteInAmountRaw(quote), mint);
  if (fromSwapLeg) return fromSwapLeg;
  return '—';
}

/** Total wallet debit (swap + input-side fees) — matches Phantom balance change. */
function getQuoteWalletPayLabel(): string {
  if (lastSwapQuoteOk) {
    const mint = quoteInputMint(lastSwapQuoteOk);
    const inputMint = swapInputMintInput?.value.trim() ?? '';
    if (mint && mint === inputMint) {
      return getQuoteWalletPayLabelFromQuote(lastSwapQuoteOk);
    }
  }
  const raw = swapAmountInput?.value.trim() ?? '';
  if (!raw) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return formatSwapAmount(n).display;
}

function getSwapSellAmountLabel(): string {
  if (lastSwapQuoteOk) {
    const mint = quoteInputMint(lastSwapQuoteOk);
    const inputMint = swapInputMintInput?.value.trim() ?? '';
    if (mint && mint === inputMint) {
      const fromRaw = formatQuoteRawAmountLabel(quoteInAmountRaw(lastSwapQuoteOk), mint);
      if (fromRaw) return fromRaw;
    }
  }
  const raw = swapAmountInput?.value.trim() ?? '';
  if (!raw) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return formatSwapAmount(n).display;
}

function formatPctChange(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  const abs = Math.abs(pct);
  if (abs < 0.99) {
    return `${sign}${abs.toFixed(2)}%`;
  }
  return `${sign}${Math.trunc(abs)}%`;
}

function formatPctChangeWithArrow(pct: number): string {
  const arrow = pct >= 0 ? '↑' : '↓';
  const abs = Math.abs(pct);
  if (abs < 0.99) {
    return `${arrow}${abs.toFixed(2)}%`;
  }
  return `${arrow}${Math.trunc(abs)}%`;
}

function pairCardSymbol(mint: string, side: 'sell' | 'buy'): string {
  const meta = getCachedTokenMeta(mint);
  if (meta?.symbol) return displaySymbol(meta.symbol);
  return side === 'sell' ? getSwapInSym() : getSwapOutSym();
}

function pairCardUnitSymbol(mint: string, chipSymbol: string): string {
  if (isSolMint(mint)) return 'SOL';
  const sym = displaySymbol(chipSymbol);
  if (sym === 'SOL' || sym === 'WSOL') return 'SOL';
  return sym.toUpperCase();
}

function renderPairCardSpotHtml(
  stats: TokenPriceStats | undefined,
  mint: string,
  chipSymbol: string,
  loading = false,
): string {
  if (!stats?.price || !Number.isFinite(stats.price) || stats.price <= 0) {
    if (loading) {
      return `<div class="swap-pair-spot"><span class="swap-pair-spot-value swap-pair-spot-value--loading">${renderLoadingSpinner('sm')}</span></div>`;
    }
    return '<div class="swap-pair-spot"><span class="swap-pair-spot-value swap-pair-spot-value--empty">—</span></div>';
  }
  const unit = pairCardUnitSymbol(mint, chipSymbol);
  const price = fmtUsd(stats.price);
  return `<div class="swap-pair-spot">
    <span class="swap-pair-spot-value">${escapeHtml(price)}</span>
    <span class="swap-pair-spot-unit">USD / 1 ${escapeHtml(unit)}</span>
  </div>`;
}

function renderPairCard(
  el: HTMLElement | null,
  mint: string,
  side: 'sell' | 'buy',
  loading = false,
): void {
  if (!el) return;
  if (!mint) {
    el.innerHTML = '<div class="swap-pair-empty">Select a token</div>';
    return;
  }
  const symbol = pairCardSymbol(mint, side);
  const displayName = swapSideTokenName(mint, symbol);
  const stats = pairCardEffectiveStats(mint, lastSwapQuoteOk ?? undefined);
  const showLoading = loading && side === 'buy';

  el.innerHTML = `<div class="swap-pair-card-head-left">
      <span class="swap-pair-icon">${renderPairCardIcon(mint, symbol)}</span>
      <div class="swap-pair-identity">
        <div class="swap-pair-name">${escapeHtml(displayName)}</div>
        <div class="swap-pair-mint">${escapeHtml(truncate(mint, 4, 4))}</div>
      </div>
    </div>
    <div class="swap-pair-changes">${renderPairCardChangesHtml(stats, showLoading)}</div>
    ${renderPairCardSpotHtml(stats, mint, symbol, showLoading)}`;
}

function renderPairCardIcon(mint: string, symbol: string): string {
  const meta = getCachedTokenMeta(mint);
  const src = resolveLogoUrl(meta?.logoUrl);
  if (src) {
    return `<img class="swap-pair-icon-img" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`;
  }
  const letter = (symbol || '?').slice(0, 1).toUpperCase();
  return `<span class="swap-pair-icon-fallback" aria-hidden="true">${escapeHtml(letter)}</span>`;
}

function renderSwapSideChangeHtml(stats?: TokenPriceStats, loading = false): string {
  if (!stats?.price || stats.price <= 0 || !stats.price1d || stats.price1d <= 0) {
    if (loading) {
      return `<span class="swap-pair-chg swap-pair-chg--loading">${renderLoadingSpinner('sm')}</span>`;
    }
    return '<span class="swap-pair-chg swap-pair-chg--muted">—</span>';
  }
  const pct1d = ((stats.price - stats.price1d) / stats.price1d) * 100;
  const cls = pct1d >= 0 ? 'swap-pair-chg--up' : 'swap-pair-chg--down';
  return `<span class="swap-pair-chg ${cls}">24hr: ${formatPctChangeWithArrow(pct1d)}</span>`;
}

function renderPairCardChangesHtml(stats?: TokenPriceStats, loading = false): string {
  if (!stats?.price || stats.price <= 0) {
    if (loading) {
      return `<span class="swap-pair-chg swap-pair-chg--loading">${renderLoadingSpinner('sm')}</span>`;
    }
    return '<span class="swap-pair-chg swap-pair-chg--muted">—</span>';
  }
  const parts: string[] = [];
  if (stats.price1d && stats.price1d > 0) {
    const pct1d = ((stats.price - stats.price1d) / stats.price1d) * 100;
    const cls1d = pct1d >= 0 ? 'swap-pair-chg--up' : 'swap-pair-chg--down';
    parts.push(`<span class="swap-pair-chg ${cls1d}">24hr: ${formatPctChangeWithArrow(pct1d)}</span>`);
  }
  if (stats.price7d && stats.price7d > 0) {
    const pct7 = ((stats.price - stats.price7d) / stats.price7d) * 100;
    const cls7 = pct7 >= 0 ? 'swap-pair-chg--up' : 'swap-pair-chg--down';
    parts.push(`<span class="swap-pair-chg ${cls7}">7d: ${formatPctChangeWithArrow(pct7)}</span>`);
  }
  if (parts.length === 0) {
    return '<span class="swap-pair-chg swap-pair-chg--muted">—</span>';
  }
  return parts.join('');
}

function updateSwapSideChanges(loading = false): void {
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const sellEl = document.getElementById('swapSellChanges');
  const buyEl = document.getElementById('swapBuyChanges');
  if (sellEl) sellEl.innerHTML = renderSwapSideChangeHtml(inMint ? pairTokenStats[inMint] : undefined);
  if (buyEl) {
    buyEl.innerHTML = renderSwapSideChangeHtml(
      outMint ? pairTokenStats[outMint] : undefined,
      loading,
    );
  }
}

function updateSwapPairCards(stats?: Record<string, TokenPriceStats>, loading = false): void {
  if (stats) pairTokenStats = { ...pairTokenStats, ...stats };
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  renderPairCard(swapCardSellEl, inMint, 'sell', loading);
  renderPairCard(swapCardBuyEl, outMint, 'buy', loading);
  updateSwapSideChanges(loading);
}

function routeOutputMintSymbol(mint: string | undefined): string {
  return mintSymbolSync(mint);
}

function mintSymbolSync(mint: string | undefined): string {
  const m = (mint ?? '').trim();
  if (!m) return '—';
  const hard = HARDCODED_MINT_SYMBOLS[m];
  if (hard) return hard;
  const cached = routeMintSymbolCache[m];
  if (cached) return cached;
  return truncate(m, 4, 4);
}

async function fetchMintMeta(mint: string): Promise<void> {
  const m = mint.trim();
  if (!m) return;
  if (HARDCODED_MINT_SYMBOLS[m] && !routeMintSymbolCache[m]) {
    routeMintSymbolCache[m] = HARDCODED_MINT_SYMBOLS[m];
  }
  if (HARDCODED_MINT_DECIMALS[m] != null && routeMintDecimalsCache[m] == null) {
    routeMintDecimalsCache[m] = HARDCODED_MINT_DECIMALS[m];
  }
  const needSymbol = !routeMintSymbolCache[m];
  const needDecimals = routeMintDecimalsCache[m] == null;
  if (!needSymbol && !needDecimals) return;
  const res = await fetchWithRetry(
    `/api/token-symbol/${encodeURIComponent(m)}${needDecimals ? '?decimals=1' : ''}`,
  );
  const body = (await res.json().catch(() => ({}))) as TokenSymbolResponse;
  if (needSymbol) {
    const sym = (body.symbol ?? m).replace(/\0/g, '').trim();
    routeMintSymbolCache[m] = displaySymbol(sym || truncate(m, 4, 4));
  }
  if (needDecimals && typeof body.decimals === 'number' && Number.isFinite(body.decimals)) {
    routeMintDecimalsCache[m] = body.decimals;
  }
}

async function prefetchRouteMintSymbols(quote: Record<string, unknown>): Promise<void> {
  const mints = new Set<string>();
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
    const feeM = (si?.feeMintAddress ?? '').trim();
    if (feeM) mints.add(feeM);
  }
  await Promise.all([...mints].map((m) => fetchMintMeta(m)));
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

    const inAmt = si?.inAmount ? formatRawTokenAmount(si.inAmount, inMint).display : '—';
    let outAmt = si?.outAmount ? formatRawTokenAmount(si.outAmount, outMint).display : '—';
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

function hopPercentLabel(step: VybeRoutePlanStepLite): string {
  if (step.percent == null || !Number.isFinite(step.percent)) return '—';
  const rounded = Math.round(step.percent * 100) / 100;
  return `${rounded}%`;
}

function parsePositiveBigInt(raw: string | undefined | null): bigint | null {
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

/** Sum hop fees (output-mint + PDA rent) expressed in output-token raw units. */
function sumHopFeeDeductionInOutputRaw(
  hopFees: HopFeeBreakdownLite,
  outMint: string,
  inRaw: bigint | null,
  quotedOutRaw: bigint,
  inputMint: string,
): bigint {
  let total = 0n;
  for (const item of hopFees.items) {
    if (isAccRentFeeLabel(item.label)) continue;
    if (item.mint === outMint) {
      const amt = parsePositiveBigInt(item.amountRaw);
      if (amt) total += amt;
    }
    if (item.pdaRent?.amountRaw && inRaw && inRaw > 0n && quotedOutRaw > 0n) {
      const rent = parsePositiveBigInt(item.pdaRent.amountRaw);
      if (!rent) continue;
      const rentMint = item.pdaRent.mint;
      if (rentMint === inputMint || rentMint === WSOL_MINT) {
        total += (rent * quotedOutRaw) / inRaw;
      }
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
): HopOutgoingPercentBreakdown | null {
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
      ? sumHopFeeDeductionInOutputRaw(hopFees, outMint, inRaw, quotedRaw, inputMint)
      : 0n;

  const derivedNetFromFees =
    feeDeductionOut > 0n && quotedRaw > feeDeductionOut ? quotedRaw - feeDeductionOut : null;

  let netRaw = parsePositiveBigInt(hopFees?.netOutRaw);
  if (!netRaw && isLastHop) {
    netRaw = parsePositiveBigInt(String(quote._simulatedOutAmount ?? ''));
  }
  // Vybe quotes often omit simulation net while hop fees are still present — outAmount may
  // equal quoted gross, which would hide the output % badge entirely.
  if ((!netRaw || netRaw >= quotedRaw) && derivedNetFromFees != null) {
    netRaw = derivedNetFromFees;
  } else if (!netRaw && isLastHop) {
    const fromOut = parsePositiveBigInt(String(quote.outAmount ?? ''));
    if (fromOut && fromOut < quotedRaw) netRaw = fromOut;
  }
  if (!netRaw) return null;

  let grossRaw = quotedRaw;
  if (feeDeductionOut > 0n) {
    const impliedGross = netRaw + feeDeductionOut;
    if (impliedGross > grossRaw) grossRaw = impliedGross;
  }

  const denom = isLastHop ? scaleQuotedRawToWalletPay(quotedRaw, quote) : grossRaw;
  if (netRaw >= denom) return null;

  const pct = Number((netRaw * 10000n) / denom) / 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;

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

  return {
    pctLabel: `${Math.round(pct * 100) / 100}%`,
    netDisplay: formatRawTokenAmount(String(netRaw), outMint).display,
    quotedDisplay: formatRawTokenAmount(String(quotedRaw), outMint).display,
    denomDisplay: formatRawTokenAmount(String(denom), outMint).display,
    outSym: mintSymbolSync(outMint),
    inputScaled,
    payDisplay: formatQuoteRawAmountLabel(payRaw, quoteInputMint(quote)),
    swapDisplay: formatQuoteRawAmountLabel(swapRaw, quoteInputMint(quote)),
    inSym: getSwapInSym(),
  };
}

/** % of hop quoted output that continues after fees (e.g. 99% net to wallet). */
function hopOutgoingPercentLabel(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
  isLastHop: boolean,
): string | null {
  return computeHopOutgoingPercentBreakdown(step, quote, isLastHop)?.pctLabel ?? null;
}

/** Best total wallet debit: simulation first, then input-side fee estimate. */
function resolveWalletPayDebitRaw(quote: Record<string, unknown>): string | null {
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

/** Diagram input endpoint: wallet debit addon (input-side fees only). */
function getQuoteDiagramInputFeeAddon(quote: Record<string, unknown>): string | null {
  const walletAddon = getQuoteInputSideAddonLabel(quote);
  if (walletAddon) return walletAddon;
  const inputFeeUi = sumInputSideWalletFeesInSellMintUi(quote);
  if (inputFeeUi == null) return null;
  const formatted = formatSwapAmountValue(inputFeeUi).replace(/,/g, '');
  return formatted === '—' ? null : `+${formatted}`;
}

function getQuoteDiagramInputTotalLabel(
  quote: Record<string, unknown>,
  feeAddon: string | null,
): string | null {
  if (!feeAddon || feeAddon === '—') return null;
  const walletTotal = getQuoteWalletPayLabelFromQuote(quote);
  return walletTotal !== '—' ? walletTotal : null;
}

/** Extra wallet debit above swap leg (fees/rent on input side), e.g. +0.002181 SOL. */
function getQuoteInputSideAddonLabel(quote: Record<string, unknown>): string | null {
  const mint = quoteInputMint(quote);
  const payRaw = quoteWalletPayRaw(quote);
  const swapRaw = quoteInAmountRaw(quote);
  if (!mint || !payRaw || !swapRaw) return null;
  try {
    const pay = BigInt(payRaw);
    const swap = BigInt(swapRaw);
    if (pay <= swap) return null;
    const deltaRaw = (pay - swap).toString();
    const display = formatRawTokenAmount(deltaRaw, mint).display;
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

function formatRouteChipLabel(plan: VybeRoutePlanStepLite[]): string {
  const hopCount = plan.length;
  if (hopCount === 0) return '—';
  const routeTree = buildRouteTree(plan);
  const routeCount = countRouteTreeForkBranches(routeTree);
  if (routeCount >= 2) {
    return `${routeCount} Routes + ${hopCount} Hops`;
  }
  return hopCount === 1 ? '1 Hop' : `${hopCount} Hops`;
}

function setRouteChipLabel(label: string, disabled: boolean): void {
  if (swapRouteChipTextEl) swapRouteChipTextEl.textContent = label;
  else if (swapRouteBtnEl) swapRouteBtnEl.textContent = label;
  if (swapRouteBtnEl) swapRouteBtnEl.disabled = disabled;
}

function renderHopConversionLeg(
  leg: RouteHopLeg,
  className = 'route-hop-conversion',
  loading?: { in?: boolean; out?: boolean },
): string {
  const inAmtHtml = loading?.in ? renderLoadingSpinner('sm') : escapeHtml(leg.inAmt);
  const outAmtHtml = loading?.out ? renderLoadingSpinner('sm') : escapeHtml(leg.outAmt);
  return `<div class="${className}">
    <span class="route-hop-leg">
      <span class="route-hop-amt">${inAmtHtml}</span>
      <span class="route-hop-sym">${escapeHtml(leg.inSym)}</span>
    </span>
    <span class="route-hop-arrow" aria-hidden="true">→</span>
    <span class="route-hop-leg">
      <span class="route-hop-amt">${outAmtHtml}</span>
      <span class="route-hop-sym">${escapeHtml(leg.outSym)}</span>
    </span>
  </div>`;
}

function renderRoutingTokenIcon(mint: string, sym: string): string {
  const meta = getCachedTokenMeta(mint);
  const src = resolveLogoUrl(meta?.logoUrl);
  if (src) {
    return `<img class="routing-token-img" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`;
  }
  return `<span class="routing-token-dot ${endpointTokenDotClass(sym)}" aria-hidden="true"></span>`;
}

function renderJupiterEndpointPill(
  amt: string,
  sym: string,
  title?: string,
  amtLoading = false,
): string {
  const mint =
    sym === getSwapInSym()
      ? (swapInputMintInput?.value.trim() ?? '')
      : sym === getSwapOutSym()
        ? (swapOutputMintInput?.value.trim() ?? '')
        : '';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  const amtHtml = amtLoading ? renderLoadingSpinner('md') : escapeHtml(amt);
  return `<div class="routing-pill routing-pill--endpoint"${titleAttr}>
    ${renderRoutingTokenIcon(mint, sym)}
    <span class="routing-amt">${amtHtml}</span>
    <span class="routing-sym">${escapeHtml(sym)}</span>
  </div>`;
}

function renderJupiterPctLink(
  pct: string,
  direction: 'in' | 'out' = 'in',
  quote?: Record<string, unknown>,
  lastHopStep?: VybeRoutePlanStepLite,
): string {
  const outClass = direction === 'out' ? ' routing-pct-badge--out' : '';
  const tipHtml =
    direction === 'out' && quote
      ? renderOutputPctBadgeTooltip(quote, lastHopStep, pct)
      : '';
  const tipClass = tipHtml ? ' routing-pct-badge--has-tip' : '';
  const tabIdx = tipHtml ? ' tabindex="0"' : '';
  return `<div class="routing-hop-link routing-hop-link--${direction}" aria-hidden="true">
    <span class="routing-pct-badge${outClass}${tipClass}"${tabIdx}>${escapeHtml(pct)}${tipHtml}</span>
  </div>`;
}

function renderHopIndexBadge(label: string): string {
  return `<span class="routing-hop-index-badge">Hop #${escapeHtml(label)}</span>`;
}

function normalizeFeeItemLabel(label: string): string {
  const l = label.trim().toLowerCase();
  if (l === 'pda rent' || l === 'token acc rent' || l === 'acc rent fee') return ACC_RENT_FEE_LABEL;
  return label;
}

const PRIORITY_FEE_LABEL = 'Priority fee';
const SLIPPAGE_SPREAD_LABEL = 'Slippage/Spread';

/** User-facing fee name; renames generic route fees by destination kind. */
function displayFeeItemLabel(item: Pick<HopFeeItemLite, 'label' | 'destinationKind'>): string {
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
  const l = normalizeFeeItemLabel(label).toLowerCase();
  return l === 'acc rent fee';
}

function formatAccRentFeeSolSubline(equiv: FeeAmountEquiv): string {
  const amt = equiv.primary !== '—' ? equiv.primary.replace(/,/g, '') : '—';
  return `${amt} SOL`;
}

/** Expand legacy nested token-acc rent onto the same row as other hop fees. */
function flattenHopFeeItems(items: HopFeeItemLite[]): HopFeeItemLite[] {
  const flat: HopFeeItemLite[] = [];
  for (const item of items) {
    flat.push({
      label: normalizeFeeItemLabel(item.label),
      amountRaw: item.amountRaw,
      mint: item.mint,
      destinationAddress: item.destinationAddress,
      destinationKind: item.destinationKind,
      destinationNote: item.destinationNote,
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

function getHopFeeDisplayItems(step: VybeRoutePlanStepLite): HopFeeItemLite[] {
  const fees = getHopFeeBreakdown(step);
  return fees?.items.length ? flattenHopFeeItems(fees.items) : [];
}

function getHopFeeBreakdown(step: VybeRoutePlanStepLite): HopFeeBreakdownLite | null {
  if (step._hopFees?.items?.length) return step._hopFees;
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
  const n = rawAmountToUiNumber(digits, getMintDecimals(feeMint));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function collectRoutePriceMints(quote: Record<string, unknown>): string[] {
  const mints = new Set<string>();
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

function lookupMintPriceUsd(mint: string, quote: Record<string, unknown>): number {
  const m = mint.trim();
  if (!m) return NaN;

  const cached = pairTokenStats[m]?.price;
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

  return NaN;
}

function pairCardEffectiveStats(mint: string, quote?: Record<string, unknown>): TokenPriceStats | undefined {
  const base = pairTokenStats[mint];
  const price = lookupMintPriceUsd(mint, quote ?? {});
  if (!Number.isFinite(price) || price <= 0) return base;
  if (base) return { ...base, price };
  const cached = getCachedTokenMeta(mint);
  return {
    price,
    price1d: cached?.price1d,
    price7d: cached?.price7d,
    decimals: cached?.decimals ?? getMintDecimals(mint),
    priceFetchedAt: cached?.priceFetchedAt ?? Date.now(),
    priceUpdateTime: cached?.priceUpdateTime,
  };
}

/** Mirror Vybe quote metadata so aggregator routes get buy-side USD + pair-card stats. */
function attachQuoteTokenPriceMeta(
  quote: Record<string, unknown>,
  inputMint: string,
  outputMint: string,
): Record<string, unknown> {
  const inKey = inputMint.trim();
  const outKey = outputMint.trim();
  const inputStats = pairTokenStats[inKey];
  const outputStats = pairTokenStats[outKey];
  const tokenStats: Record<string, TokenPriceStats> = {};
  if (inputStats) tokenStats[inKey] = inputStats;
  if (outputStats) tokenStats[outKey] = outputStats;

  const next: Record<string, unknown> = { ...quote };
  if (Object.keys(tokenStats).length > 0) next._tokenStats = tokenStats;
  if (inputStats?.price) next._inputPriceUsd = inputStats.price;
  if (outputStats?.price) next._outputPriceUsd = outputStats.price;
  return next;
}

function routeLegMintMatches(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return isSolMint(x) && isSolMint(y);
}

function convertFeeUiToSellLeg(
  feeUi: number,
  feeMint: string,
  quote: Record<string, unknown>,
): number | null {
  const sellMint = quoteInputMint(quote);
  if (!sellMint || !Number.isFinite(feeUi) || feeUi <= 0) return null;
  if (routeLegMintMatches(feeMint, sellMint)) return feeUi;

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

    const inUi = rawAmountToUiNumber(inRaw.toString(), getMintDecimals(hopIn));
    const outUi = rawAmountToUiNumber(outRaw.toString(), getMintDecimals(hopOut));
    if (!(inUi > 0 && outUi > 0)) continue;

    const feeInHopInUi = feeUi * (inUi / outUi);
    return convertFeeUiToSellLeg(feeInHopInUi, hopIn, quote);
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
): number | null {
  const outMint = quoteOutputMint(quote);
  if (!outMint || !Number.isFinite(feeUi) || feeUi <= 0) return null;
  if (routeLegMintMatches(feeMint, outMint)) return feeUi;

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

    const inUi = rawAmountToUiNumber(inRaw.toString(), getMintDecimals(hopIn));
    const outUi = rawAmountToUiNumber(outRaw.toString(), getMintDecimals(hopOut));
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
    const feeUi = rawAmountToUiNumber((q - n).toString(), getMintDecimals(outMint));
    return Number.isFinite(feeUi) && feeUi > 0 ? feeUi : null;
  } catch {
    return null;
  }
}

/** Sum hop fees converted to the receive/output mint (excludes acc rent). */
function sumOutputSideRouteFeesUi(quote: Record<string, unknown>): number | null {
  const outMint = quoteOutputMint(quote);
  if (!outMint) return null;
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  let total = 0;
  let found = false;
  for (const step of plan) {
    const fees = getHopFeeBreakdown(step);
    for (const item of flattenHopFeeItems(fees?.items ?? [])) {
      if (isAccRentFeeLabel(item.label)) continue;
      const feeUi = feeAmountToUi(item.amountRaw, item.mint);
      if (feeUi == null || feeUi <= 0) continue;
      const outUi =
        routeLegMintMatches(item.mint, outMint)
          ? feeUi
          : convertFeeUiToOutputLeg(feeUi, item.mint, quote);
      if (outUi != null && outUi > 0) {
        total += outUi;
        found = true;
      }
    }
  }
  return found && total > 0 ? total : null;
}

function getQuoteDiagramOutputFeeAddon(quote: Record<string, unknown>): string | null {
  const feeUi = getQuoteOutputFeeDeltaUi(quote) ?? sumOutputSideRouteFeesUi(quote);
  if (feeUi == null) return null;
  const formatted = formatSwapAmountValue(feeUi).replace(/,/g, '');
  return formatted === '—' ? null : `−${formatted}`;
}

function getQuoteDiagramOutputUsdSubline(quote: Record<string, unknown>): string | null {
  const usd = getQuoteReceiveUsd(quote);
  if (usd == null) return null;
  const label = formatSwapReceiveUsdLabel(usd);
  return label ? `≈ ${label}` : null;
}

function computeFeeEquivalents(
  amountRaw: string,
  feeMint: string,
  quote: Record<string, unknown>,
): FeeAmountEquiv {
  const sellMint = quoteInputMint(quote);
  const inputSym = getSwapInSym();
  const feeSym = mintSymbolSync(feeMint);
  const primary = formatRawTokenAmount(amountRaw, feeMint).display;
  const feeUi = feeAmountToUi(amountRaw, feeMint);

  let inputEquiv: string | null = null;
  let usd: string | null = null;

  if (feeUi != null) {
    const feePrice = lookupMintPriceUsd(feeMint, quote);
    if (Number.isFinite(feePrice) && feePrice > 0) {
      usd = formatFeeEquivUsdFiatDisplay(feeUi * feePrice);
    }

    const sellLegUi = convertFeeUiToSellLeg(feeUi, feeMint, quote);
    const sellPrice = lookupMintPriceUsd(sellMint, quote);
    if (sellLegUi != null && Number.isFinite(sellPrice) && sellPrice > 0) {
      inputEquiv = `≈ ${formatFeeEquivSmallAmount(sellLegUi)} ${inputSym}`;
      if (!usd) {
        usd = formatFeeEquivUsdFiatDisplay(sellLegUi * sellPrice);
      }
    }
  }

  return { feeMint, feeSym, primary, inputEquiv, inputSym, usd };
}

function computeFeeUsdNumeric(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
): number | null {
  const feeUi = feeAmountToUi(item.amountRaw, item.mint);
  if (feeUi == null || feeUi <= 0) return null;

  const feePrice = lookupMintPriceUsd(item.mint, quote);
  if (Number.isFinite(feePrice) && feePrice > 0) {
    return feeUi * feePrice;
  }

  const sellMint = quoteInputMint(quote);
  const sellLegUi = convertFeeUiToSellLeg(feeUi, item.mint, quote);
  const sellPrice = sellMint ? lookupMintPriceUsd(sellMint, quote) : NaN;
  if (sellLegUi != null && sellLegUi > 0 && Number.isFinite(sellPrice) && sellPrice > 0) {
    return sellLegUi * sellPrice;
  }
  return null;
}

function formatFeeEquivDetailText(equiv: FeeAmountEquiv): string {
  const parts = [`−${equiv.primary} ${equiv.feeSym}`];
  if (equiv.inputEquiv) parts.push(equiv.inputEquiv);
  if (equiv.usd) parts.push(equiv.usd);
  return parts.join(' · ');
}

function feeChipVariant(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('protocol')) return 'fee-protocol';
  if (l.includes('priority')) return 'fee-route';
  if (l.includes('slippage') || l.includes('spread')) return 'fee-pool';
  if (l.includes('route')) return 'fee-route';
  if (l.includes('pool')) return 'fee-pool';
  if (l.includes('acc rent') || l.includes('token acc rent') || l.includes('pda rent')) {
    return 'fee-token-acc-rent';
  }
  return 'fee';
}

function renderRoutingFeeChip(
  label: string,
  equiv: FeeAmountEquiv,
  variant: string,
  title: string,
): string {
  const usdInChip = equiv.usd
    ? `$${stripFiatPrefixForChip(equiv.usd)} USD`
    : '—';
  const baseBelow = isAccRentFeeLabel(label)
    ? formatAccRentFeeSolSubline(equiv)
    : equiv.inputEquiv
      ? stripApproxPrefix(equiv.inputEquiv)
      : null;
  return `<div class="routing-chip-stack routing-chip-stack--${variant}" title="${escapeHtml(title)}">
    <span class="routing-chip-top routing-chip-top--fee-label">${escapeHtml(label)}</span>
    <div class="routing-pill routing-pill--chip routing-pill--chip-fee">
      <span class="routing-chip-amt routing-chip-amt--usd">${escapeHtml(usdInChip)}</span>
    </div>
    ${
      baseBelow
        ? `<span class="routing-chip-bottom routing-chip-bottom--base">${escapeHtml(baseBelow)}</span>`
        : ''
    }
  </div>`;
}

function renderHopFeeChip(item: HopFeeItemLite, quote: Record<string, unknown>): string {
  const label = displayFeeItemLabel(item);
  const equiv = computeFeeEquivalents(item.amountRaw, item.mint, quote);
  const title = formatFeeEquivDetailText(equiv);
  return renderRoutingFeeChip(label, equiv, feeChipVariant(label), title);
}

function renderHopPlanFeeTableRowFromItem(
  item: HopFeeItemLite,
  quote: Record<string, unknown>,
  destCtx?: FeeDestinationRenderCtx,
): string {
  return flattenHopFeeItems([item])
    .map((flatItem) => {
      const equiv = computeFeeEquivalents(flatItem.amountRaw, flatItem.mint, quote);
      const label = displayFeeItemLabel(flatItem);
      return renderHopPlanFeeTableRow(label, equiv, feeChipVariant(label), flatItem, destCtx);
    })
    .join('');
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
  return swapQuoteWalletSnapshot?.trim() || swapWalletAddressInput?.value.trim() || '';
}

interface FeeDestinationRenderCtx {
  walletAddress?: string;
  ammKey?: string;
}

function renderFeeDestinationAddrLine(addr: string): string {
  const trimmed = addr.trim();
  if (!isLikelySolanaPubkey(trimmed)) return '';
  return `<code class="swap-hop-fee-dest__addr" title="${escapeHtml(trimmed)}">${escapeHtml(truncate(trimmed, 8, 8))}</code>`;
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
  if (
    (item.destinationKind === 'input_wallet' || item.destinationKind === 'network_priority') &&
    isLikelySolanaPubkey(wallet)
  ) {
    return wallet;
  }
  return '';
}

function renderHopPlanFeeTableRow(
  label: string,
  equiv: FeeAmountEquiv,
  variant: string,
  item?: HopFeeItemLite,
  destCtx?: FeeDestinationRenderCtx,
  opts?: { amountDisplay?: string },
): string {
  const title = formatFeeEquivDetailText(equiv);
  const primary =
    opts?.amountDisplay ??
    `−${equiv.primary} ${equiv.feeSym}`;
  const usd = equiv.usd ? `$${stripFiatPrefixForChip(equiv.usd)}` : '—';
  const base = isAccRentFeeLabel(label)
    ? formatAccRentFeeSolSubline(equiv)
    : equiv.inputEquiv
      ? stripApproxPrefix(equiv.inputEquiv)
      : '—';
  const dest = item ? renderFeeDestinationCell(item, destCtx) : '—';
  return `<div class="swap-hop-fees-table__row swap-hop-fees-table__row--${variant}" title="${escapeHtml(title)}">
    <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--label">${escapeHtml(label)}</span>
    <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--amt">${escapeHtml(primary)}</span>
    <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--usd">${escapeHtml(usd)}</span>
    <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--base">${escapeHtml(base)}</span>
    <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--dest">${dest}</span>
  </div>`;
}

function renderFeeDestinationCell(item: HopFeeItemLite, ctx?: FeeDestinationRenderCtx): string {
  const kind = item.destinationKind;
  const note = item.destinationNote?.trim();
  const addr = resolveFeeDestinationAddress(item, ctx);
  const addrHtml = addr ? renderFeeDestinationAddrLine(addr) : '';

  if (kind === 'lp_pool') {
    return `<span class="swap-hop-fee-dest swap-hop-fee-dest--pool"${addr ? ` title="${escapeHtml(addr)}"` : ''}><span class="swap-hop-fee-dest__kind">Pool vault</span>${addrHtml || `<span class="swap-hop-fee-dest__note">${escapeHtml(note ?? 'Pool account')}</span>`}</span>`;
  }
  if (kind === 'new_token_account') {
    return `<span class="swap-hop-fee-dest swap-hop-fee-dest--ata"${addr ? ` title="${escapeHtml(addr)}"` : ''}><span class="swap-hop-fee-dest__kind">New token account</span>${addrHtml}<span class="swap-hop-fee-dest__note">Rent-exempt deposit</span></span>`;
  }
  if (kind === 'fee_recipient') {
    return `<span class="swap-hop-fee-dest swap-hop-fee-dest--recipient"${addr ? ` title="${escapeHtml(addr)}"` : ''}><span class="swap-hop-fee-dest__kind">Fee recipient</span>${addrHtml || `<span class="swap-hop-fee-dest__note">${escapeHtml(note ?? '—')}</span>`}</span>`;
  }
  if (kind === 'input_wallet') {
    return `<span class="swap-hop-fee-dest swap-hop-fee-dest--input-wallet"${addr ? ` title="${escapeHtml(addr)}"` : ''}><span class="swap-hop-fee-dest__kind">Your wallet</span>${addrHtml}<span class="swap-hop-fee-dest__note">${escapeHtml(note ?? 'Debited with swap input')}</span></span>`;
  }
  if (kind === 'network_priority') {
    return `<span class="swap-hop-fee-dest swap-hop-fee-dest--priority"${addr ? ` title="${escapeHtml(addr)}"` : ''}><span class="swap-hop-fee-dest__kind">Priority fee</span>${addrHtml}<span class="swap-hop-fee-dest__note">${escapeHtml(note ?? 'Solana validators')}</span></span>`;
  }
  if (kind === 'output_deduction') {
    return `<span class="swap-hop-fee-dest swap-hop-fee-dest--deduct">${addrHtml}<span class="swap-hop-fee-dest__note">${escapeHtml(note ?? 'Reduces quoted output')}</span></span>`;
  }
  if (addrHtml) return `<span class="swap-hop-fee-dest">${addrHtml}</span>`;
  if (note) return `<span class="swap-hop-fee-dest"><span class="swap-hop-fee-dest__note">${escapeHtml(note)}</span></span>`;
  return '—';
}

function renderHopPlanFeesSection(
  hopFees: HopFeeBreakdownLite,
  leg: RouteHopLeg,
  quote: Record<string, unknown>,
  feeMint: string,
  feeAmt: string | null,
  ammKey?: string,
): string {
  const inputSym = getSwapInSym();
  const destCtx: FeeDestinationRenderCtx = {
    walletAddress: quoteWalletAddress(quote),
    ammKey: ammKey?.trim() || undefined,
  };
  const head = `<div class="swap-hop-fees-table__row swap-hop-fees-table__row--head">
    <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--label">Fee</span>
    <span class="swap-hop-fees-table__cell">Amount</span>
    <span class="swap-hop-fees-table__cell">USD</span>
    <span class="swap-hop-fees-table__cell">${escapeHtml(inputSym)}</span>
    <span class="swap-hop-fees-table__cell">Destination</span>
  </div>`;
  const rowData = flattenHopFeeItems(hopFees.items).map((item) => ({
    item,
    equiv: computeFeeEquivalents(item.amountRaw, item.mint, quote),
  }));
  const bodyRows = rowData
    .map(({ item, equiv }) => {
      const label = displayFeeItemLabel(item);
      return renderHopPlanFeeTableRow(label, equiv, feeChipVariant(label), item, destCtx);
    })
    .join('');

  let totalRow = '';
  if (rowData.length > 1) {
    const totalEquiv = sumHopPlanFeeTableTotals(rowData, quote);
    if (totalEquiv) {
      totalRow = renderHopPlanFeeTableRow('Total fees', totalEquiv, 'total', undefined, destCtx, {
        amountDisplay: totalEquiv.amountDisplay,
      });
    }
  }

  return `<section class="swap-hop-panel swap-hop-panel--fees" aria-label="Hop fees">
    <h5 class="swap-hop-panel__title">Fee breakdown</h5>
    <div class="swap-hop-fees-table">${head}${bodyRows}${totalRow}</div>
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
      if (isAccRentFeeLabel(item.label)) return true;
    }
  }
  return false;
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

/** Base-column UI amount for one fee row (input/sell leg, or SOL for acc rent). */
function feeTableBaseLegUi(
  item: HopFeeItemLite,
  equiv: FeeAmountEquiv,
  quote: Record<string, unknown>,
): number | null {
  if (isAccRentFeeLabel(item.label)) {
    return feeAmountToUi(item.amountRaw, item.mint);
  }
  const fromEquiv = parseInputEquivUi(equiv.inputEquiv);
  if (fromEquiv != null) return fromEquiv;
  const feeUi = feeAmountToUi(item.amountRaw, item.mint);
  if (feeUi == null) return null;
  return convertFeeUiToSellLeg(feeUi, item.mint, quote);
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
  const formatted = formatRawTokenAmount(total.toString(), mint).display;
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
  const inputSym = getSwapInSym();
  const sellMint = quoteInputMint(quote) ?? '';

  for (const { item, equiv } of rowData) {
    const usdN = computeFeeUsdNumeric(item, quote) ?? parseFeeEquivUsdNumber(equiv.usd);
    if (usdN != null && usdN > 0) {
      totalUsd += usdN;
      foundUsd = true;
    }
    if (!sellMint || !isHopFeeTableWalletColumnItem(item, sellMint)) continue;
    const baseUi = feeTableBaseLegUi(item, equiv, quote);
    if (baseUi != null && baseUi > 0) {
      walletBaseUi += baseUi;
      foundWalletBase = true;
    }
  }

  if (!foundUsd && !foundWalletBase) return null;

  const nativeTotal = sumHopPlanFeeTableNativeAmount(rowData);
  const walletFmt = foundWalletBase
    ? formatSwapAmountValue(walletBaseUi).replace(/,/g, '')
    : '—';
  const amountDisplay = nativeTotal
    ? `−${nativeTotal.display} ${nativeTotal.sym}`
    : '—';

  return {
    feeMint: sellMint,
    feeSym: inputSym,
    primary: walletFmt,
    inputEquiv: foundWalletBase ? `${walletFmt} ${inputSym}` : null,
    inputSym,
    usd: foundUsd ? `~$${formatSwapPayUsdAmount(totalUsd)}` : null,
    amountDisplay,
  };
}

function formatHopFeeUsdCell(usd: number): string {
  return `$${stripFiatPrefixForChip(formatFeeEquivUsdFiatDisplay(usd))}`;
}

function collectQuoteRouteFeeUsdLines(
  quote: Record<string, unknown>,
): Array<{ label: string; usd: number }> {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lines: Array<{ label: string; usd: number }> = [];

  for (const step of plan) {
    const hopFees = getHopFeeBreakdown(step);
    if (!hopFees?.items.length) continue;
    for (const item of flattenHopFeeItems(hopFees.items)) {
      const equiv = computeFeeEquivalents(item.amountRaw, item.mint, quote);
      const usdN = computeFeeUsdNumeric(item, quote) ?? parseFeeEquivUsdNumber(equiv.usd);
      if (usdN == null || usdN <= 0) continue;
      lines.push({ label: displayFeeItemLabel(item), usd: usdN });
    }
  }
  return lines;
}

function getQuoteTotalInputUsdIncludingFees(quote: Record<string, unknown>): number | null {
  const mint = quoteInputMint(quote);
  if (!mint) return null;
  const price = lookupMintPriceUsd(mint, quote);
  if (!Number.isFinite(price) || price <= 0) return null;

  const walletPayUi = quoteWalletPayUi(quote);
  if (walletPayUi != null && walletPayUi > 0) return walletPayUi * price;

  const swapUi = quoteInAmountUi(quote, mint);
  if (swapUi == null || swapUi <= 0) return null;
  const inputFeeUi = sumInputSideWalletFeesInSellMintUi(quote) ?? 0;
  return (swapUi + inputFeeUi) * price;
}

function renderOutputPctBreakdownSection(
  breakdown: HopOutgoingPercentBreakdown,
  pctLabel: string,
): string {
  const tok = breakdown.outSym;
  const rows: string[] = [
    `<span class="routing-pct-tip__section-title">Output %</span>`,
    `<span class="routing-pct-tip__row"><span class="routing-pct-tip__label">Net output</span><span class="routing-pct-tip__amt">${escapeHtml(breakdown.netDisplay)} ${escapeHtml(tok)}</span></span>`,
  ];
  if (
    breakdown.inputScaled &&
    breakdown.payDisplay &&
    breakdown.swapDisplay &&
    breakdown.quotedDisplay !== breakdown.denomDisplay
  ) {
    rows.push(
      `<span class="routing-pct-tip__row routing-pct-tip__row--detail"><span class="routing-pct-tip__label">Hop quoted</span><span class="routing-pct-tip__amt">${escapeHtml(breakdown.quotedDisplay)} ${escapeHtml(tok)}</span></span>`,
      `<span class="routing-pct-tip__row routing-pct-tip__row--detail"><span class="routing-pct-tip__label">Route input</span><span class="routing-pct-tip__amt">${escapeHtml(breakdown.payDisplay)} ${escapeHtml(breakdown.inSym)}</span></span>`,
      `<span class="routing-pct-tip__row routing-pct-tip__row--detail"><span class="routing-pct-tip__label">Swap leg</span><span class="routing-pct-tip__amt">${escapeHtml(breakdown.swapDisplay)} ${escapeHtml(breakdown.inSym)}</span></span>`,
    );
  } else if (breakdown.quotedDisplay !== breakdown.netDisplay) {
    rows.push(
      `<span class="routing-pct-tip__row routing-pct-tip__row--detail"><span class="routing-pct-tip__label">Hop quoted</span><span class="routing-pct-tip__amt">${escapeHtml(breakdown.quotedDisplay)} ${escapeHtml(tok)}</span></span>`,
    );
  }
  rows.push(
    `<span class="routing-pct-tip__row"><span class="routing-pct-tip__label">Cost basis</span><span class="routing-pct-tip__amt">${escapeHtml(breakdown.denomDisplay)} ${escapeHtml(tok)}</span></span>`,
    `<span class="routing-pct-tip__row routing-pct-tip__row--pct-total"><span class="routing-pct-tip__label">Output retain</span><span class="routing-pct-tip__pct">${escapeHtml(pctLabel)}</span></span>`,
    `<span class="routing-pct-tip__formula">${escapeHtml(breakdown.netDisplay)} ÷ ${escapeHtml(breakdown.denomDisplay)} = ${escapeHtml(pctLabel)}</span>`,
  );
  if (
    breakdown.inputScaled &&
    breakdown.payDisplay &&
    breakdown.swapDisplay &&
    breakdown.quotedDisplay !== breakdown.denomDisplay
  ) {
    rows.push(
      `<span class="routing-pct-tip__formula routing-pct-tip__formula--detail">${escapeHtml(breakdown.quotedDisplay)} × ${escapeHtml(breakdown.payDisplay)} ÷ ${escapeHtml(breakdown.swapDisplay)} = ${escapeHtml(breakdown.denomDisplay)} ${escapeHtml(tok)}</span>`,
    );
  }
  return `<span class="routing-pct-tip__section">${rows.join('')}</span>`;
}

function renderOutputPctBadgeTooltip(
  quote: Record<string, unknown>,
  lastHopStep?: VybeRoutePlanStepLite,
  pctLabel?: string,
): string {
  const feeLines = collectQuoteRouteFeeUsdLines(quote);
  const totalInputUsd = getQuoteTotalInputUsdIncludingFees(quote);
  const breakdown =
    lastHopStep && pctLabel
      ? computeHopOutgoingPercentBreakdown(lastHopStep, quote, true)
      : null;
  const outputSection =
    breakdown && pctLabel ? renderOutputPctBreakdownSection(breakdown, pctLabel) : '';
  if (feeLines.length === 0 && totalInputUsd == null && !outputSection) return '';

  const rows: string[] = [];
  for (const { label, usd } of feeLines) {
    rows.push(
      `<span class="routing-pct-tip__row"><span class="routing-pct-tip__label">${escapeHtml(label)}</span><span class="routing-pct-tip__usd">${escapeHtml(formatHopFeeUsdCell(usd))}</span></span>`,
    );
  }
  if (feeLines.length > 1) {
    const feeTotal = feeLines.reduce((sum, line) => sum + line.usd, 0);
    rows.push(
      `<span class="routing-pct-tip__row routing-pct-tip__row--fees-total"><span class="routing-pct-tip__label">Total fees</span><span class="routing-pct-tip__usd">${escapeHtml(`$${formatSwapPayUsdAmount(feeTotal)}`)}</span></span>`,
    );
  }
  if (totalInputUsd != null) {
    const totalLabel = formatSwapPayUsdLabel(totalInputUsd);
    rows.push(
      `<span class="routing-pct-tip__row routing-pct-tip__row--input-total"><span class="routing-pct-tip__label">Total input (incl. fees)</span><span class="routing-pct-tip__usd">${escapeHtml(totalLabel ?? '—')}</span></span>`,
    );
  }
  const feeSection = rows.length > 0 ? `<span class="routing-pct-tip__section routing-pct-tip__section--fees">${rows.join('')}</span>` : '';
  return `<span class="routing-pct-tip" role="tooltip">${outputSection}${feeSection}</span>`;
}

function renderRoutingFeeConnectors(feeCount: number): string {
  const vbW = 248;
  const vbH = 72;
  const cx = vbW / 2;
  const barY = 22;
  const endY = vbH;
  const r = 8;

  const dropXs =
    feeCount === 2
      ? [vbW * 0.25, vbW * 0.75]
      : feeCount === 3
        ? [vbW / 6, vbW / 2, (vbW * 5) / 6]
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

function partitionHopFeeDisplayItems(items: HopFeeItemLite[]): {
  accRentItems: HopFeeItemLite[];
  routeFeeItems: HopFeeItemLite[];
} {
  const accRentItems: HopFeeItemLite[] = [];
  const routeFeeItems: HopFeeItemLite[] = [];
  for (const item of items) {
    if (isAccRentFeeLabel(item.label)) accRentItems.push(item);
    else routeFeeItems.push(item);
  }
  return { accRentItems, routeFeeItems };
}

function renderRoutingAccRentConnectorDown(): string {
  const vbW = 48;
  const vbH = 28;
  const cx = vbW / 2;
  return `<svg class="routing-acc-rent-connector-svg" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none">
    <path d="M ${cx} 0 L ${cx} ${vbH}" fill="none" stroke="#3f3f46" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linecap="butt"/>
  </svg>`;
}

function renderHopAccRentAboveBranch(
  step: VybeRoutePlanStepLite,
  quote: Record<string, unknown>,
): string {
  const { accRentItems } = partitionHopFeeDisplayItems(getHopFeeDisplayItems(step));
  if (accRentItems.length === 0) return '';

  const slots = accRentItems
    .map((item) => {
      const chip = renderHopFeeChip(item, quote);
      return `<div class="routing-fee-slot routing-fee-slot--acc-rent">${chip}</div>`;
    })
    .join('');

  return `<div class="routing-acc-rent-above" aria-label="Account rent fee at this hop">
    <div class="routing-acc-rent-cards">${slots}</div>
    <div class="routing-acc-rent-connector" aria-hidden="true">${renderRoutingAccRentConnectorDown()}</div>
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
  const slots = routeFeeItems
    .map((item) => {
      const chip = renderHopFeeChip(item, quote);
      return `<div class="routing-fee-slot">${chip}</div>`;
    })
    .join('');

  return `<div class="routing-fee-branch routing-fee-branch--${feeCount}" aria-label="Fees deducted at this hop">
    <div class="routing-fee-connectors" aria-hidden="true">${renderRoutingFeeConnectors(feeCount)}</div>
    <div class="routing-fee-cards">${slots}</div>
  </div>`;
}

function renderJupiterMarketNode(
  meta: RouteHopMeta,
  leg: RouteHopLeg,
  quote: Record<string, unknown>,
  dexLoading = false,
): string {
  const si = meta.step.swapInfo;
  const dexHtml = dexLoading ? renderLoadingSpinner('sm') : escapeHtml(si?.label ?? 'DEX');
  const sym = escapeHtml(leg.outSym);
  const accRentAbove = dexLoading ? '' : renderHopAccRentAboveBranch(meta.step, quote);
  const feeBranchBelow = dexLoading ? '' : renderRoutingFeeBranch(meta.step, leg, quote);
  const hasFees = Boolean(accRentAbove || feeBranchBelow);
  const railNode = `<div class="routing-market-node">
    ${renderHopIndexBadge(meta.label)}
    <div class="routing-pill routing-pill--hop">
      ${renderRoutingTokenIcon(leg.outMint, leg.outSym)}
      <span class="routing-token-sym">${sym}</span>
    </div>
    <div class="routing-dex-caption">${dexHtml}</div>
  </div>`;
  const hopOnRail = accRentAbove
    ? `<div class="routing-hop-on-rail">${accRentAbove}${railNode}</div>`
    : railNode;
  return `<div class="routing-hop-column${hasFees ? ' routing-hop-column--has-fees' : ''}${accRentAbove ? ' routing-hop-column--has-acc-rent-above' : ''}">
    ${hopOnRail}
    ${feeBranchBelow}
  </div>`;
}

const ROUTING_CONNECTORS = `<div class="routing-connectors" aria-hidden="true">
  <div class="routing-corner routing-corner--in"></div>
  <div class="routing-corner routing-corner--out"></div>
</div>`;

function renderJupiterTrack(node: RouteNode, legs: RouteHopLeg[], quote: Record<string, unknown>): string {
  const metas: RouteHopMeta[] = [];
  collectRouteHopMetas(node, metas);
  if (metas.length === 0) return '';

  const inner = metas
    .map((meta, i) => {
      const leg = legs[meta.planIndex];
      if (!leg) return '';
      const isLastHop = i === metas.length - 1;
      const inLink = i === 0 ? renderJupiterPctLink(hopPercentLabel(meta.step)) : '';
      const outPct = hopOutgoingPercentLabel(meta.step, quote, isLastHop);
      const outLink =
        outPct && outPct !== '100%'
          ? renderJupiterPctLink(outPct, 'out', quote, isLastHop ? meta.step : undefined)
          : '';
      return inLink + renderJupiterMarketNode(meta, leg, quote) + outLink;
    })
    .join('');

  return `<div class="routing-rail-row">${inner}<div class="routing-rail-tail" aria-hidden="true"></div></div>`;
}

function renderJupiterFork(
  node: Extract<RouteNode, { kind: 'fork' }>,
  legs: RouteHopLeg[],
  quote: Record<string, unknown>,
): string {
  const n = node.branches.length;
  const boardClass =
    n === 1 ? 'routing-split-board--1' : n === 2 ? 'routing-split-board--2' : 'routing-split-board--multi';
  const tracks = node.branches.map((b) => renderJupiterTrack(b, legs, quote)).join('');
  return `<div class="routing-split-board ${boardClass}">${tracks}</div>`;
}

function renderJupiterRouteBody(
  node: RouteNode,
  legs: RouteHopLeg[],
  quote: Record<string, unknown>,
): string {
  if (node.kind === 'empty') return '';
  if (node.kind === 'fork') {
    return renderJupiterFork(node, legs, quote);
  }
  if (node.kind === 'hop') {
    return renderJupiterTrack(node, legs, quote);
  }
  const hasFork = node.nodes.some((n) => n.kind === 'fork');
  if (hasFork) {
    return node.nodes.map((n) => renderJupiterRouteBody(n, legs, quote)).join('');
  }
  return renderJupiterTrack(node, legs, quote);
}

function routingCanvasHopClass(hopCount: number): string {
  if (hopCount === 2) return ' routing-canvas--hops-2';
  if (hopCount === 3) return ' routing-canvas--hops-3';
  if (hopCount > 3) return ' routing-canvas--hops-many';
  return '';
}

function routingCanvasLayoutAttrs(hopCount: number, hasAccRentAbove: boolean): string {
  return ` data-routing-hop-count="${hopCount}" data-routing-acc-rent="${hasAccRentAbove ? '1' : '0'}"`;
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
  inputAddon: string | null = null,
  inputTotalLabel: string | null = null,
  outputAddon: string | null = null,
  outputUsdSubline: string | null = null,
): string {
  const placeholderClass = placeholder ? ' routing-canvas--placeholder' : '';
  const loadingClass = loading ? ' routing-canvas--loading' : '';
  const feesClass = hasFees ? ' routing-canvas--has-fees' : '';
  const accRentClass = hasAccRentAbove ? ' routing-canvas--has-acc-rent-above' : '';
  const inputAddonHtml =
    inputAddon && inputAddon !== '—'
      ? `<span class="routing-input-addon">Fee: ${escapeHtml(inputAddon)} ${escapeHtml(inSym)}</span>`
      : '';
  const inputTotalHtml =
    inputTotalLabel && inputTotalLabel !== '—' && inputAddon
      ? `<span class="routing-input-total">Total: <span class="routing-input-total__val">${escapeHtml(inputTotalLabel)} ${escapeHtml(inSym)}</span></span>`
      : '';
  const outputAddonHtml =
    outputAddon && outputAddon !== '—'
      ? `<span class="routing-output-addon">Fee: ${escapeHtml(outputAddon)} ${escapeHtml(outSym)}</span>`
      : '';
  const outputUsdHtml =
    outputUsdSubline && outputUsdSubline !== '—'
      ? `<span class="routing-output-usd">USD Output: <span class="routing-output-usd__val">${escapeHtml(outputUsdSubline)}</span></span>`
      : '';
  return `<div class="routing-canvas routing-canvas--flow${split ? ' routing-canvas--split' : ''}${routingCanvasHopClass(hopCount)}${feesClass}${accRentClass}${placeholderClass}${loadingClass}"${routingCanvasLayoutAttrs(hopCount, hasAccRentAbove)}>
    <div class="routing-frame">
      <div class="routing-endpoint routing-endpoint--in">
        <div class="routing-endpoint-stack">
          ${inputAddonHtml}
          ${renderJupiterEndpointPill(inDisplay, inSym, undefined, loading && inDisplay === '—')}
          ${inputTotalHtml}
        </div>
      </div>
      <div class="routing-endpoint routing-endpoint--out">
        <div class="routing-endpoint-stack">
          ${outputAddonHtml}
          ${renderJupiterEndpointPill(outDisplay, outSym, outTitle, loading)}
          ${outputUsdHtml}
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

function renderRoutingDiagram(quote: Record<string, unknown>): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const inTotalDisplay = getQuoteWalletPayLabelFromQuote(quote);
  const inDisplay = getQuoteSwapLegLabelFromQuote(quote);
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  const inputAddon = getQuoteDiagramInputFeeAddon(quote);
  const inputTotalLabel = getQuoteDiagramInputTotalLabel(quote, inputAddon);
  const outputAddon = getQuoteDiagramOutputFeeAddon(quote);
  const outputUsdSubline = getQuoteDiagramOutputUsdSubline(quote);

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
      inputAddon,
      inputTotalLabel,
      outputAddon,
      outputUsdSubline,
    );
  }

  const tree = buildRouteTree(plan);
  const split = routeTreeHasFork(tree);
  const hasFees = routePlanHasHopFees(plan);
  const hasAccRentAbove = routePlanHasAccRentFee(plan);
  const body = renderJupiterRouteBody(tree, legs, quote);

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
    inputAddon,
    inputTotalLabel,
    outputAddon,
    outputUsdSubline,
  );
}

function renderRoutingDiagramPlaceholder(loading = false): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const inTotalDisplay = lastSwapQuoteOk
    ? getQuoteWalletPayLabelFromQuote(lastSwapQuoteOk)
    : getQuoteWalletPayLabel();
  const inChipDisplay = lastSwapQuoteOk
    ? getQuoteSwapLegLabelFromQuote(lastSwapQuoteOk)
    : inTotalDisplay;
  const hasIn = inChipDisplay !== '—';
  const inputAddon = lastSwapQuoteOk ? getQuoteDiagramInputFeeAddon(lastSwapQuoteOk) : null;
  const inputTotalLabel = lastSwapQuoteOk
    ? getQuoteDiagramInputTotalLabel(lastSwapQuoteOk, inputAddon)
    : null;
  const outputAddon = lastSwapQuoteOk ? getQuoteDiagramOutputFeeAddon(lastSwapQuoteOk) : null;
  const outputUsdSubline = lastSwapQuoteOk ? getQuoteDiagramOutputUsdSubline(lastSwapQuoteOk) : null;
  const mockLeg: RouteHopLeg = {
    inMint,
    outMint,
    inSym,
    outSym,
    inAmt: hasIn ? inChipDisplay : '—',
    outAmt: '—',
  };
  const mockMeta: RouteHopMeta = {
    label: '1',
    planIndex: 0,
    step: { percent: 100, swapInfo: { label: '—' } },
  };
  const body =
    renderJupiterPctLink('100%') +
    renderJupiterMarketNode(mockMeta, mockLeg, {}, loading);
  const trackBody = `<div class="routing-rail-row">${body}<div class="routing-rail-tail" aria-hidden="true"></div></div>`;
  return renderRoutingFrame(
    hasIn ? inChipDisplay : '—',
    inSym,
    '—',
    outSym,
    undefined,
    trackBody,
    false,
    1,
    !hasIn && !loading,
    loading,
    false,
    false,
    inputAddon,
    inputTotalLabel,
    outputAddon,
    outputUsdSubline,
  );
}

function getSwapRouter(): string {
  return swapRouterInput?.value.trim() || 'vybe';
}

function setSwapRouter(router: string, options?: { invalidateQuote?: boolean }): void {
  const normalized = normalizeRouterId(router);
  const prev = normalizeRouterId(getSwapRouter());
  if (swapRouterInput) swapRouterInput.value = normalized;
  for (const btn of swapRouterSwitchEl?.querySelectorAll<HTMLButtonElement>('[data-router]') ?? []) {
    const active = btn.dataset.router === normalized;
    btn.classList.toggle('swap-mode-switch__btn--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (normalized !== prev && options?.invalidateQuote !== false) {
    invalidateSwapQuoteAfterInputChange();
  }
  syncRouterFallbackToggleUi();
}

function isRouterFallbackEnabled(): boolean {
  return swapVybeFallbackCheckbox?.checked === true;
}

function getRouterFallbackLabel(): string {
  const router = normalizeRouterId(getSwapRouter());
  if (router === 'jupiter') return 'Fallback to Titan if Jupiter cannot find routes';
  return 'Fallback to Jupiter or Titan if Vybe cannot find routes';
}

function getRouterFallbackSwitchTitle(): string {
  const router = normalizeRouterId(getSwapRouter());
  if (router === 'jupiter') return 'Switch to Titan and refetch when Jupiter has no route';
  return 'Switch to Jupiter or Titan and refetch when Vybe has no route';
}

function syncRouterFallbackToggleUi(): void {
  if (!swapVybeFallbackRowEl) return;
  const router = normalizeRouterId(getSwapRouter());
  swapVybeFallbackRowEl.hidden = router === 'titan';
  if (swapRouterFallbackLabelEl) {
    swapRouterFallbackLabelEl.textContent = getRouterFallbackLabel();
  }
  if (swapRouterFallbackSwitchEl) {
    swapRouterFallbackSwitchEl.title = getRouterFallbackSwitchTitle();
  }
}

function detectVybeAggregatorFallbackRouter(
  body: Record<string, unknown>,
  selectedRouter: string,
): 'jupiter' | 'titan' | null {
  if (normalizeRouterId(selectedRouter) !== 'vybe') return null;
  const build = body._build as Record<string, unknown> | undefined;
  const effective = normalizeRouterId(
    body._effectiveRouter ?? body._buildRouter ?? build?.provider,
  );
  if (effective === 'jupiter' || effective === 'titan') return effective;
  return null;
}

function isEmptyAggregatorQuote(quoteBody: Record<string, unknown>): boolean {
  const plan = quoteBody.routePlan;
  if (Array.isArray(plan) && plan.length > 0) return false;
  const outRaw = parsePositiveBigInt(String(quoteBody.outAmount ?? ''));
  return outRaw == null || outRaw <= 0n;
}

function jupiterRouteUnavailableError(fallbackEnabled: boolean): Error {
  if (fallbackEnabled) {
    return new Error('Jupiter could not find a route for this swap.');
  }
  return new Error(
    'Jupiter could not find a route for this swap. Enable "Fallback to Titan if Jupiter cannot find routes" or select Titan manually.',
  );
}

function vybeRouteUnavailableError(fallbackRouter: string): Error {
  const label = routerDisplayLabel(fallbackRouter);
  return new Error(
    `Vybe could not find a route for this swap. Enable "${getRouterFallbackLabel()}" or select ${label} manually.`,
  );
}

function normalizeRouterId(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'jupiter' || raw === 'titan' || raw === 'vybe') return raw;
  return raw || 'vybe';
}

function routerDisplayLabel(routerId: string): string {
  const id = normalizeRouterId(routerId);
  if (id === 'jupiter') return 'Jupiter';
  if (id === 'titan') return 'Titan';
  if (id === 'vybe') return 'Vybe';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function formatRouteDiagramTitle(quote: Record<string, unknown>): string {
  const selected = normalizeRouterId(
    quote._selectedRouter ?? quote.router ?? getSwapRouter(),
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

function updateRouteDiagramTitle(quote: Record<string, unknown>): void {
  const title = formatRouteDiagramTitle(quote);
  if (swapQuoteRouteSubtitleEl) swapQuoteRouteSubtitleEl.textContent = title;
  if (routingDialogTitleEl) routingDialogTitleEl.textContent = title;
}

function annotateQuoteRouterMeta(
  quote: Record<string, unknown>,
  selectedRouter: string,
): Record<string, unknown> {
  const selected = normalizeRouterId(selectedRouter);
  return {
    ...quote,
    _selectedRouter: selected,
    _effectiveRouter: normalizeRouterId(quote._effectiveRouter ?? quote._buildRouter ?? selected),
    _routerFallbackUsed:
      quote._routerFallbackUsed === true ||
      normalizeRouterId(quote._effectiveRouter ?? quote._buildRouter ?? selected) !== selected,
  };
}

function applyFeeEnrichmentToQuote(
  quote: Record<string, unknown>,
  enrichment: Record<string, unknown> | null | undefined,
  buildPayload?: Record<string, unknown>,
): Record<string, unknown> {
  const source =
    enrichment ??
    (buildPayload?._feeEnrichment as Record<string, unknown> | undefined) ??
    null;

  const simulatedOutRaw =
    (source?.simulatedOutRaw as string | undefined) ??
    (buildPayload?._simulatedOutAmount as string | undefined);
  const quotedOutRaw =
    (source?.quotedOutRaw as string | undefined) ??
    (buildPayload?._quotedOutAmount as string | undefined);
  const outputFromSimulation = source?.outputFromSimulation === true;
  const totalFeeRaw = source?.totalFeeRaw;
  const swapFeePct = source?.swapFeePct;
  const buildDetails = buildPayload?.details as Record<string, unknown> | undefined;
  const swapFeeRaw = source?.swapFeeRaw ?? buildDetails?.swapFee ?? quote._swapFee;
  const routePlan = source?.routePlan;

  let next: Record<string, unknown> = {
    ...quote,
    ...(Array.isArray(routePlan) ? { routePlan } : {}),
    _quotedOutAmount: quotedOutRaw ?? quote._quotedOutAmount,
    _simulatedOutAmount: simulatedOutRaw ?? quote._simulatedOutAmount,
    _outputFromSimulation: outputFromSimulation || quote._outputFromSimulation === true,
    _totalFeeRaw: totalFeeRaw ?? quote._totalFeeRaw,
    _swapFeePct: swapFeePct ?? quote._swapFeePct,
    _swapFee: swapFeeRaw ?? quote._swapFee,
  };

  const walletPayDebitRaw =
    buildPayload?._walletPayDebitRaw ??
    source?.walletPayDebitRaw ??
    quote._walletPayDebitRaw;
  if (typeof walletPayDebitRaw === 'string' && walletPayDebitRaw.length > 0) {
    next._walletPayDebitRaw = walletPayDebitRaw;
  }

  if (typeof simulatedOutRaw === 'string' && simulatedOutRaw.length > 0) {
    const outMint = quoteOutputMint(next);
    next.outAmount = simulatedOutRaw;
    const outFmt = formatRawTokenAmount(simulatedOutRaw, outMint);
    next.outAmountUi = Number(outFmt.display.replace(/,/g, ''));
    next._outputFromSimulation = outputFromSimulation;
    const slippagePct = swapSlippageInput ? Number(swapSlippageInput.value) : 0.5;
    if (Number.isFinite(slippagePct) && slippagePct >= 0) {
      try {
        const out = BigInt(simulatedOutRaw);
        const bps = BigInt(Math.max(0, Math.round(slippagePct * 100)));
        const threshold = out - (out * bps) / 10000n;
        const thresholdRaw = threshold < 0n ? '0' : threshold.toString();
        next.otherAmountThreshold = thresholdRaw;
        const thFmt = formatRawTokenAmount(thresholdRaw, outMint);
        next.otherAmountThresholdUi = Number(thFmt.display.replace(/,/g, ''));
      } catch {
        /* keep existing threshold */
      }
    }
  }

  return next;
}

function refreshQuoteUiAfterBuild(buildPayload: Record<string, unknown>): void {
  if (!lastSwapQuoteOk) return;
  const enriched = applyFeeEnrichmentToQuote(lastSwapQuoteOk, null, buildPayload);
  lastSwapQuoteOk = enriched;
  renderSwapQuoteUI(enriched);
  void enrichRouteLabels(enriched);
}

function renderRoutePanels(quote: Record<string, unknown>): void {
  updateRouteDiagramTitle(quote);
  if (swapQuoteDetailsRoutingEl) swapQuoteDetailsRoutingEl.innerHTML = renderRoutingDiagram(quote);
  if (swapQuoteDetailsRouteStepsEl) swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanSteps(quote);
  syncRoutePlanStepsUi();
  if (routingDialogBodyEl) routingDialogBodyEl.innerHTML = renderRoutingDiagram(quote);
  scheduleRoutingDiagramZoom();
}

const ROUTING_SCROLL_FIT_SCALE_DEFAULT = 0.75;

function routingScrollFitScale(canvas: HTMLElement): number {
  const hops = Number(canvas.dataset.routingHopCount ?? '0');
  const accRent = canvas.dataset.routingAccRent === '1';
  if (hops >= 4) return 0.68;
  if (hops >= 3) return 0.72;
  if (hops >= 2 && accRent) return 0.78;
  if (hops >= 2) return 0.82;
  if (accRent) return 0.85;
  return ROUTING_SCROLL_FIT_SCALE_DEFAULT;
}

function routingCanvasPrefersScrollFit(canvas: HTMLElement): boolean {
  const hops = Number(canvas.dataset.routingHopCount ?? '0');
  const accRent = canvas.dataset.routingAccRent === '1';
  return hops >= 3 || (hops >= 2 && accRent);
}

function syncRoutingDiagramZoom(container: HTMLElement | null): void {
  if (!container) return;
  const canvas = container.querySelector(':scope > .routing-canvas') as HTMLElement | null;
  if (!canvas) {
    container.classList.remove('swap-quote-details-routing--scroll-fit', 'routing-dialog-body--scroll-fit');
    return;
  }

  canvas.classList.remove('routing-canvas--scroll-fit');
  canvas.style.removeProperty('--routing-scroll-fit-scale');
  container.classList.remove('swap-quote-details-routing--scroll-fit', 'routing-dialog-body--scroll-fit');

  const overflows = canvas.scrollWidth > container.clientWidth + 2;
  const prefersFit = routingCanvasPrefersScrollFit(canvas);
  if (!overflows && !prefersFit) return;

  const scale = routingScrollFitScale(canvas);
  canvas.style.setProperty('--routing-scroll-fit-scale', String(scale));
  canvas.classList.add('routing-canvas--scroll-fit');
  if (container.id === 'routingDialogBody') {
    container.classList.add('routing-dialog-body--scroll-fit');
  } else {
    container.classList.add('swap-quote-details-routing--scroll-fit');
  }
}

function scheduleRoutingDiagramZoom(): void {
  requestAnimationFrame(() => {
    syncRoutingDiagramZoom(swapQuoteDetailsRoutingEl);
    syncRoutingDiagramZoom(routingDialogBodyEl);
    requestAnimationFrame(() => {
      syncRoutingDiagramZoom(swapQuoteDetailsRoutingEl);
      syncRoutingDiagramZoom(routingDialogBodyEl);
    });
  });
}

let routingDiagramZoomBound = false;

function bindRoutingDiagramZoomListeners(): void {
  if (routingDiagramZoomBound) return;
  routingDiagramZoomBound = true;
  window.addEventListener('resize', scheduleRoutingDiagramZoom);
}

function endpointTokenDotClass(sym: string): string {
  const u = sym.toUpperCase();
  if (u.includes('SOL')) return 'routing-token-dot--sol';
  if (u === 'USDC') return 'routing-token-dot--usdc';
  if (u === 'USDT' || u === 'USDT1') return 'routing-token-dot--usdt';
  if (u === 'BONK') return 'routing-token-dot--bonk';
  return 'routing-token-dot';
}

const SWAP_QUOTE_FIELD_ORDER: readonly string[] = [
  'inputMintAddress',
  'inputMint',
  'inAmount',
  'outputMintAddress',
  'outputMint',
  'outAmount',
  'otherAmountThreshold',
  'swapMode',
  'priceImpactPct',
  'outAmountUi',
  'outAmountUI',
  'otherAmountThresholdUi',
  'otherAmountThresholdUI',
  'swapRate',
  'contextSlot',
  'slippageBps',
  '_quotedOutAmount',
  '_simulatedOutAmount',
  '_outputFromSimulation',
  '_swapFee',
  '_swapFeePct',
  '_totalFeeRaw',
  'swapUsdValue',
  'timeTaken',
  'mostReliableAmmsQuoteReport',
  'otherRoutePlans',
];

const SWAP_QUOTE_SUMMARY_KEYS = new Set([
  'inAmount',
  'outAmount',
  'outAmountUi',
  'swapRate',
  'priceImpactPct',
  'otherAmountThresholdUi',
  'otherAmountThreshold',
  'swapUsdValue',
]);

const SWAP_QUOTE_NESTED_KEYS = new Set(['mostReliableAmmsQuoteReport', 'otherRoutePlans']);
const SWAP_QUOTE_LONG_STRING_MIN = 48;

function getQuotePayFeeUsd(quote: Record<string, unknown>): number | null {
  const payRaw = quoteWalletPayRaw(quote);
  const swapRaw = quoteInAmountRaw(quote);
  const mint = quoteInputMint(quote);
  if (payRaw && swapRaw && mint) {
    try {
      const pay = BigInt(payRaw);
      const swap = BigInt(swapRaw);
      if (pay > swap) {
        const feeUi = rawAmountToUiNumber((pay - swap).toString(), getMintDecimals(mint));
        if (Number.isFinite(feeUi) && feeUi > 0) {
          const price = lookupMintPriceUsd(mint, quote);
          if (Number.isFinite(price) && price > 0) return feeUi * price;
        }
      }
    } catch {
      /* fall through to route fees */
    }
  }
  const routeFeeUi = sumInputSideWalletFeesInSellMintUi(quote);
  if (routeFeeUi == null || !mint) return null;
  const price = lookupMintPriceUsd(mint, quote);
  if (!Number.isFinite(price) || price <= 0) return null;
  return routeFeeUi * price;
}

function estimateSwapPayUsdFromInput(): number | null {
  const amount =
    (lastSwapQuoteOk ? quoteWalletPayUi(lastSwapQuoteOk) : null) ??
    (lastSwapQuoteOk ? quoteInAmountUi(lastSwapQuoteOk) : null) ??
    Number(swapAmountInput?.value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const sellMint = swapInputMintInput?.value.trim() ?? '';
  const price = lookupMintPriceUsd(sellMint, lastSwapQuoteOk ?? {});
  if (!Number.isFinite(price) || price <= 0) return null;
  return amount * price;
}

function buildQuotePaySubLabel(quote: Record<string, unknown> | null): string | null {
  const payUsd = quote != null ? getQuotePayUsd(quote) : estimateSwapPayUsdFromInput();
  const payUsdLabel = payUsd != null ? formatSwapPayUsdLabel(payUsd) : null;
  const feeUsd =
    quote != null
      ? getQuotePayFeeUsd(quote)
      : lastSwapQuoteOk
        ? getQuotePayFeeUsd(lastSwapQuoteOk)
        : null;
  const hasBreakdown =
    quote != null
      ? getQuotePayFeeAmountLabel(quote) != null
      : lastSwapQuoteOk != null && getQuotePayFeeAmountLabel(lastSwapQuoteOk) != null;
  const parts: string[] = [];
  if (payUsdLabel) parts.push(`≈ ${payUsdLabel}`);
  if (hasBreakdown && feeUsd != null) {
    const feeLabel = formatSwapPayUsdLabel(feeUsd);
    if (feeLabel) parts.push(`+ ${feeLabel} (fees)`);
  }
  return parts.length ? parts.join(' ') : null;
}

function getQuotePayFeeAmountLabel(quote: Record<string, unknown>): string | null {
  const addon = getQuoteInputSideAddonLabel(quote);
  if (addon) return addon.replace(/^\+/, '').replace(/,/g, '');
  const inputFeeUi = sumInputSideWalletFeesInSellMintUi(quote);
  if (inputFeeUi == null) return null;
  return formatSwapAmountValue(inputFeeUi).replace(/,/g, '');
}

function renderQuotePayHeroValueHtml(
  quote: Record<string, unknown> | null,
  inSym: string,
  fallbackAmt: string,
  placeholder = false,
  loading = false,
): string {
  const amtCls = placeholder ? ' swap-quote-summary-amt--placeholder' : '';
  if (loading && placeholder) {
    return `<span class="swap-quote-summary-amt${amtCls}">${renderLoadingSpinner('md')}</span>`;
  }
  const swapAmt = quote ? getQuoteSwapLegLabelFromQuote(quote) : fallbackAmt;
  const feeAmt = quote ? getQuotePayFeeAmountLabel(quote) : null;
  if (!feeAmt || swapAmt === '—') {
    const amt = swapAmt !== '—' ? swapAmt : fallbackAmt;
    return `<span class="swap-quote-summary-amt${amtCls}">${escapeHtml(amt)}</span>
        <span class="swap-quote-summary-sym">${escapeHtml(inSym)}</span>`;
  }
  return `<span class="swap-quote-summary-amt${amtCls}">${escapeHtml(swapAmt)}</span>
      <span class="swap-quote-summary-sym">${escapeHtml(inSym)}</span>
      <span class="swap-quote-summary-plus">+</span>
      <span class="swap-quote-summary-fee-part">
        <span class="swap-quote-summary-amt swap-quote-summary-amt--fee${amtCls}">${escapeHtml(feeAmt)}</span>
        <span class="swap-quote-summary-sym">${escapeHtml(inSym)}</span>
      </span>`;
}

function renderQuoteSummaryHeroTile(
  label: string,
  amt: string,
  sym: string,
  variant: 'pay' | 'receive',
  sub?: string | null,
  placeholder = false,
  loading = false,
  valueHtml?: string,
): string {
  const amtCls = placeholder ? ' swap-quote-summary-amt--placeholder' : '';
  const subCls = placeholder ? ' swap-quote-summary-sub--placeholder' : '';
  const amtHtml =
    loading && placeholder ? renderLoadingSpinner('md') : escapeHtml(amt);
  const valueInner =
    valueHtml ??
    `<span class="swap-quote-summary-amt${amtCls}">${amtHtml}</span>
        <span class="swap-quote-summary-sym">${escapeHtml(sym)}</span>`;
  const subHtml =
    loading && placeholder && sub
      ? renderLoadingSpinner('sm')
      : sub
        ? escapeHtml(sub)
        : '';
  return `<div class="swap-quote-summary-tile swap-quote-summary-tile--hero swap-quote-summary-tile--${variant}">
      <span class="swap-quote-summary-label">${escapeHtml(label)}</span>
      <span class="swap-quote-summary-value">${valueInner}</span>
      ${subHtml ? `<span class="swap-quote-summary-sub${subCls}">${subHtml}</span>` : ''}
    </div>`;
}

function getSwapSellUsdSubLabel(): string | null {
  const payUsd = estimateSwapPayUsdFromInput();
  return payUsd != null ? formatSwapPayFiatDisplay(payUsd) : null;
}

function renderQuoteSummaryPlaceholder(loading = false): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const payAmt = getQuoteWalletPayLabel();
  const hasPay = payAmt !== '—';
  const paySub = buildQuotePaySubLabel(lastSwapQuoteOk) ?? '≈ —';
  const payValueHtml = renderQuotePayHeroValueHtml(
    lastSwapQuoteOk,
    inSym,
    hasPay ? payAmt : '—',
    !hasPay,
    loading && !hasPay,
  );
  return `<div class="swap-quote-summary-primary" data-quote-placeholder="true">
      ${renderQuoteSummaryHeroTile('You pay', hasPay ? payAmt : '—', inSym, 'pay', paySub, !hasPay, loading && !hasPay, payValueHtml)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', '—', outSym, 'receive', '≈ —', true, loading)}
    </div>`;
}

function renderQuoteSummary(quote: Record<string, unknown>): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const payAmt = getQuoteWalletPayLabelFromQuote(quote);
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  const payUsd = getQuotePayUsd(quote);
  const receiveUsd = getQuoteReceiveUsd(quote);
  const payUsdLabel = payUsd != null ? formatSwapPayUsdLabel(payUsd) : null;
  const receiveUsdLabel = receiveUsd != null ? formatSwapReceiveUsdLabel(receiveUsd) : null;
  const paySub = buildQuotePaySubLabel(quote);
  const payValueHtml = renderQuotePayHeroValueHtml(quote, inSym, payAmt);
  const receiveSub = quote._simulatedOutAmount
    ? receiveUsdLabel
      ? `≈ ${receiveUsdLabel} · wallet estimate`
      : 'Wallet estimate (simulated)'
    : receiveUsdLabel
      ? `≈ ${receiveUsdLabel}`
      : null;

  return `<div class="swap-quote-summary-primary">
      ${renderQuoteSummaryHeroTile('You pay', payAmt, inSym, 'pay', paySub, false, false, payValueHtml)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', outAmt.display, outSym, 'receive', receiveSub)}
    </div>`;
}

function renderQuoteFieldCellHtml(key: string, v: unknown): string {
  if (v === null || v === undefined) return '<span class="swap-quote-null">null</span>';

  if (SWAP_QUOTE_NESTED_KEYS.has(key) || (typeof v === 'object' && v !== null)) {
    try {
      const json = JSON.stringify(v, null, 2);
      const flat = json.replace(/\s+/g, ' ');
      const preview =
        flat.length > SWAP_QUOTE_LONG_STRING_MIN ? truncate(flat, 24, 12) : flat;
      return `<details class="swap-quote-nested"><summary><code>${escapeHtml(preview)}</code></summary><pre class="swap-quote-pre">${escapeHtml(json)}</pre></details>`;
    } catch {
      return `<code>${escapeHtml(String(v))}</code>`;
    }
  }

  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    const s = String(v);
    if (typeof v === 'string' && s.length > SWAP_QUOTE_LONG_STRING_MIN) {
      return `<code title="${escapeHtml(s)}">${escapeHtml(truncate(s, 8, 8))}</code>`;
    }
    return `<code>${escapeHtml(s)}</code>`;
  }

  return `<code>${escapeHtml(String(v))}</code>`;
}

function renderQuoteFieldsTable(quote: Record<string, unknown>): string {
  const ordered = SWAP_QUOTE_FIELD_ORDER.filter((k) => k in quote);
  const orderedSet = new Set(ordered);
  const rest = Object.keys(quote)
    .filter((k) => k !== 'routePlan' && !orderedSet.has(k))
    .sort();
  const keys = [...ordered, ...rest];

  const rowHtml = keys.map((key) => {
    const v = quote[key];
    const dupClass = SWAP_QUOTE_SUMMARY_KEYS.has(key) ? ' swap-quote-field-item--summary-dup' : '';
    return `<div class="swap-quote-field-item${dupClass}"><div class="swap-quote-k">${escapeHtml(key)}</div><div class="swap-quote-v">${renderQuoteFieldCellHtml(key, v)}</div></div>`;
  });

  let routeRow: string;
  if (Array.isArray(quote.routePlan)) {
    const n = quote.routePlan.length;
    routeRow =
      n > 0
        ? `<div class="swap-quote-field-item swap-quote-field-item--full"><div class="swap-quote-k">routePlan</div><div class="swap-quote-v"><em>${escapeHtml(`${n} hop(s) — see Route plan steps above`)}</em></div></div>`
        : `<div class="swap-quote-field-item swap-quote-field-item--full"><div class="swap-quote-k">routePlan</div><div class="swap-quote-v"><code>[]</code></div></div>`;
  } else {
    routeRow = `<div class="swap-quote-field-item swap-quote-field-item--full"><div class="swap-quote-k">routePlan</div><div class="swap-quote-v">${renderQuoteFieldCellHtml('routePlan', quote.routePlan)}</div></div>`;
  }

  return `<div class="swap-quote-fields-grid">${rowHtml.join('')}${routeRow}</div>`;
}

function getPlaceholderHopInAmountRaw(): string | null {
  const amount = Number(swapAmountInput?.value);
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  if (!Number.isFinite(amount) || amount <= 0 || !inputMint) return null;
  const decimals = getMintDecimals(inputMint);
  try {
    const raw = BigInt(Math.round(amount * 10 ** decimals));
    return raw.toString();
  } catch {
    return null;
  }
}

function hopDetailPendingCell(loading: boolean, html: string): string {
  return loading ? renderLoadingSpinner('sm') : html;
}

function renderRoutePlanStepDetail(
  step: VybeRoutePlanStepLite,
  hopLabel: string,
  leg: RouteHopLeg,
  expanded = false,
  placeholder = false,
  loading = false,
  quote: Record<string, unknown> = {},
  isFirstHopInRoute = false,
): string {
  const si = step.swapInfo;
  const dex = si?.label ?? 'Unknown DEX';
  const pct = hopPercentLabel(step);
  const showRouteShare = isFirstHopInRoute || (pct !== '100%' && pct !== '—');
  const pendingHop = placeholder || loading;
  const hasInAmt = leg.inAmt !== '—' && leg.inAmt !== '';
  const hasOutAmt = leg.outAmt !== '—' && leg.outAmt !== '';
  const previewInAmt =
    loading && !hasInAmt ? renderLoadingSpinner('sm') : escapeHtml(leg.inAmt);
  const previewOutAmt = loading && !hasOutAmt ? renderLoadingSpinner('sm') : escapeHtml(leg.outAmt);
  const preview = `${previewInAmt} ${escapeHtml(leg.inSym)} → ${previewOutAmt} ${escapeHtml(leg.outSym)}`;
  const previewShare = showRouteShare ? ` · ${escapeHtml(pct)} route share` : '';
  const hopFees = getHopFeeBreakdown(step);
  const feeSym = hopFees?.mint
    ? mintSymbolSync(hopFees.mint)
    : si?.feeMintAddress
      ? mintSymbolSync(si.feeMintAddress)
      : '—';
  const feeMint = (hopFees?.mint ?? si?.feeMintAddress ?? '').trim();
  const feeAmt =
    hopFees?.totalAmountRaw && hopFees.totalAmountRaw !== '0'
      ? formatRawTokenAmount(hopFees.totalAmountRaw, feeMint || leg.inMint).display
      : si?.feeAmount && si.feeAmount !== '0'
        ? formatRawTokenAmount(si.feeAmount, feeMint || leg.inMint).display
        : null;

  const detailCell = (
    label: string,
    valueHtml: string,
    opts?: { full?: string; mono?: boolean },
  ) => {
    const valClass = opts?.mono ? ' swap-hop-detail-v--mono' : '';
    return `<div class="swap-hop-detail-cell">
      <span class="swap-hop-detail-k">${escapeHtml(label)}</span>
      <span class="swap-hop-detail-v${valClass}"${opts?.full ? ` title="${escapeHtml(opts.full)}"` : ''}>${valueHtml}</span>
    </div>`;
  };

  const venueHtml =
    dex !== '—' && dex !== 'Unknown DEX'
      ? escapeHtml(dex)
      : hopDetailPendingCell(loading, '—');
  const inputHtml = hasInAmt
    ? `${escapeHtml(leg.inAmt)} ${escapeHtml(leg.inSym)}`
    : `${hopDetailPendingCell(loading, '—')} ${escapeHtml(leg.inSym)}`;
  const outputHtml = hasOutAmt
    ? `${escapeHtml(leg.outAmt)} ${escapeHtml(leg.outSym)}`
    : `${hopDetailPendingCell(loading, '—')} ${escapeHtml(leg.outSym)}`;
  const dexSummaryHtml =
    dex !== '—' && dex !== 'Unknown DEX'
      ? escapeHtml(dex)
      : hopDetailPendingCell(loading, '—');

  const detailRow = (cells: string[], cols: 2 | 3) =>
    `<div class="swap-hop-detail-grid__row swap-hop-detail-grid__row--${cols}">${cells.join('')}</div>`;

  const marketHtml = si?.ammKey
    ? detailCell('Market (AMM)', escapeHtml(truncate(si.ammKey, 8, 8)), {
        full: si.ammKey,
        mono: true,
      })
    : pendingHop
      ? detailCell('Market (AMM)', hopDetailPendingCell(loading, '—'))
      : detailCell('Market (AMM)', '—');

  const inputMintHtml = leg.inMint
    ? detailCell('Input mint', escapeHtml(truncate(leg.inMint, 8, 8)), {
        full: leg.inMint,
        mono: true,
      })
    : pendingHop
      ? detailCell('Input mint', hopDetailPendingCell(loading, '—'))
      : detailCell('Input mint', '—');

  const outputMintHtml = leg.outMint
    ? detailCell('Output mint', escapeHtml(truncate(leg.outMint, 8, 8)), {
        full: leg.outMint,
        mono: true,
      })
    : pendingHop
      ? detailCell('Output mint', hopDetailPendingCell(loading, '—'))
      : detailCell('Output mint', '—');

  let inAmountHtml: string;
  if (si?.inAmount) {
    const inFmt = formatRawTokenAmount(si.inAmount, leg.inMint);
    inAmountHtml = detailCell(
      'In amount',
      `${escapeHtml(inFmt.display)} <span class="swap-hop-detail-raw">(${escapeHtml(String(si.inAmount))} raw)</span>`,
      { full: inFmt.full || String(si.inAmount) },
    );
  } else if (pendingHop) {
    const inRaw = getPlaceholderHopInAmountRaw();
    const inAmountValue =
      hasInAmt && inRaw
        ? `${escapeHtml(leg.inAmt)} <span class="swap-hop-detail-raw">(${escapeHtml(inRaw)} raw)</span>`
        : hopDetailPendingCell(loading, '—');
    inAmountHtml = detailCell('In amount', inAmountValue);
  } else {
    inAmountHtml = detailCell('In amount', '—');
  }

  let outAmountHtml: string;
  if (si?.outAmount) {
    const outFmt = formatRawTokenAmount(si.outAmount, leg.outMint);
    outAmountHtml = detailCell(
      'Out amount',
      `${escapeHtml(outFmt.display)} <span class="swap-hop-detail-raw">(${escapeHtml(String(si.outAmount))} raw)</span>`,
      { full: outFmt.full || String(si.outAmount) },
    );
  } else if (pendingHop) {
    outAmountHtml = detailCell('Out amount', hopDetailPendingCell(loading, '—'));
  } else {
    outAmountHtml = detailCell('Out amount', '—');
  }

  let feesHtml = '';
  if (hopFees?.items.length) {
    feesHtml = renderHopPlanFeesSection(hopFees, leg, quote, feeMint, feeAmt, si?.ammKey);
  } else if (feeAmt) {
    feesHtml = `<section class="swap-hop-panel swap-hop-panel--fees" aria-label="Hop fees">
      <h5 class="swap-hop-panel__title">Fee breakdown</h5>
      <div class="swap-hop-fees-table">
        <div class="swap-hop-fees-table__row swap-hop-fees-table__row--head">
          <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--label">Fee</span>
          <span class="swap-hop-fees-table__cell">Amount</span>
          <span class="swap-hop-fees-table__cell">USD</span>
          <span class="swap-hop-fees-table__cell">${escapeHtml(feeSym)}</span>
          <span class="swap-hop-fees-table__cell">Destination</span>
        </div>
        <div class="swap-hop-fees-table__row swap-hop-fees-table__row--fee">
          <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--label">Fee</span>
          <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--amt">−${escapeHtml(feeAmt)} ${escapeHtml(feeSym)}</span>
          <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--usd">—</span>
          <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--base">—</span>
          <span class="swap-hop-fees-table__cell swap-hop-fees-table__cell--dest">—</span>
        </div>
      </div>
    </section>`;
  }

  let quotedOutputHtml: string;
  let netToWalletHtml: string;
  if (hopFees?.quotedOutRaw) {
    const grossFmt = formatRawTokenAmount(hopFees.quotedOutRaw, leg.outMint);
    quotedOutputHtml = detailCell('Quoted output', escapeHtml(`${grossFmt.display} ${leg.outSym}`), {
      full: grossFmt.full,
    });
  } else if (si?.outAmount) {
    const outFmt = formatRawTokenAmount(si.outAmount, leg.outMint);
    quotedOutputHtml = detailCell('Quoted output', escapeHtml(`${outFmt.display} ${leg.outSym}`), {
      full: outFmt.full,
    });
  } else if (pendingHop) {
    quotedOutputHtml = detailCell('Quoted output', hopDetailPendingCell(loading, '—'));
  } else {
    quotedOutputHtml = detailCell('Quoted output', '—');
  }

  if (hopFees?.netOutRaw) {
    const netFmt = formatRawTokenAmount(hopFees.netOutRaw, leg.outMint);
    netToWalletHtml = detailCell('Net to wallet', escapeHtml(`${netFmt.display} ${leg.outSym}`), {
      full: netFmt.full,
    });
  } else if (si?.outAmount) {
    const outFmt = formatRawTokenAmount(si.outAmount, leg.outMint);
    netToWalletHtml = detailCell('Net to wallet', escapeHtml(`${outFmt.display} ${leg.outSym}`), {
      full: outFmt.full,
    });
  } else if (pendingHop) {
    netToWalletHtml = detailCell('Net to wallet', hopDetailPendingCell(loading, '—'));
  } else {
    netToWalletHtml = detailCell('Net to wallet', '—');
  }

  const detailRowsHtml = [
    detailRow([detailCell('Venue', venueHtml), marketHtml], 2),
    detailRow([inputMintHtml, outputMintHtml], 2),
    detailRow([detailCell('Input', inputHtml), inAmountHtml], 2),
    detailRow([detailCell('Output', outputHtml), outAmountHtml], 2),
    detailRow([quotedOutputHtml, netToWalletHtml], 2),
  ].join('');

  const feesPanelHtml = feesHtml;

  const shareBadgeHtml = showRouteShare
    ? `<span class="swap-hop-card__pct">${escapeHtml(pct)}</span>`
    : '';

  const placeholderClass = placeholder ? ' swap-hop-step-details--placeholder' : '';
  const loadingClass = loading ? ' swap-hop-step-details--loading' : '';
  return `<details class="swap-hop-step-card swap-hop-step-details${placeholderClass}${loadingClass}"${expanded ? ' open' : ''}>
    <summary class="swap-hop-step-details__summary">
      <span class="swap-hop-card__index">Hop #${escapeHtml(hopLabel)}</span>
      <span class="swap-hop-step-details__main">
        <span class="swap-hop-card__dex">${dexSummaryHtml}</span>
        <span class="swap-hop-step-details__preview">${preview}${previewShare}</span>
      </span>
      ${shareBadgeHtml}
    </summary>
    <div class="swap-hop-step-details__body">
      <section class="swap-hop-panel swap-hop-panel--swap">
        <h5 class="swap-hop-panel__title">Swap leg</h5>
        ${renderHopConversionLeg(leg, 'route-hop-conversion route-hop-conversion--card swap-hop-conversion', {
          in: loading && !hasInAmt,
          out: loading && !hasOutAmt,
        })}
      </section>
      ${feesPanelHtml}
      <section class="swap-hop-panel swap-hop-panel--details">
        <h5 class="swap-hop-panel__title">Technical details</h5>
        <div class="swap-hop-detail-grid swap-hop-detail-grid--rows">${detailRowsHtml}</div>
      </section>
    </div>
  </details>`;
}

function renderQuoteRoutePlanStepsPlaceholder(loading = false): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const inDisplay = getQuoteWalletPayLabel();
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
  return renderRoutePlanStepDetail(mockStep, '1', mockLeg, true, true, loading, {}, true);
}

function renderQuoteRoutePlanSteps(quote: Record<string, unknown>): string {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  if (plan.length === 0) return '<p class="routing-empty">No route steps in this quote.</p>';
  const legs = resolveRouteHopLegs(plan, quote);
  const tree = buildRouteTree(plan);
  const metas: RouteHopMeta[] = [];
  collectRouteHopMetas(tree, metas);
  if (metas.length === 0) {
    return plan
      .map((s, i) =>
        renderRoutePlanStepDetail(s, String(i + 1), legs[i]!, i === 0, false, false, quote, i === 0),
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
        i === 0,
      ),
    )
    .join('');
}

function renderRawJsonEl(el: HTMLElement | null, data: unknown, emptyMsg: string): void {
  if (!el) return;
  if (data == null) {
    el.textContent = emptyMsg;
    return;
  }
  try {
    el.textContent = JSON.stringify(data, null, 2);
  } catch {
    el.textContent = String(data);
  }
}

function renderRawResponsePanels(): void {
  renderRawJsonEl(swapRawQuoteResponseEl, lastRawQuoteResponse, 'No quote response yet.');
  renderRawJsonEl(
    swapRawSwapResponseEl,
    lastRawSwapResponse,
    'Build a swap to see the raw swap response.',
  );
}

function renderSwapQuoteDetailsPanel(quote: Record<string, unknown>): void {
  if (swapQuoteDetailsEmptyEl) swapQuoteDetailsEmptyEl.hidden = true;
  if (swapQuoteDetailsBodyEl) swapQuoteDetailsBodyEl.hidden = false;
  if (swapQuoteSummaryEl) {
    swapQuoteSummaryEl.innerHTML = renderQuoteSummary(quote);
    swapQuoteSummaryEl.hidden = false;
  }
  renderRoutePanels(quote);
  if (swapQuoteDetailsFieldsEl) swapQuoteDetailsFieldsEl.innerHTML = renderQuoteFieldsTable(quote);
  renderRawResponsePanels();
}

function bindRoutePlanStepsAccordion(): void {
  if (!swapQuoteDetailsRouteStepsEl) return;
  if (swapQuoteDetailsRouteStepsEl.dataset.accordionBound === 'true') return;
  swapQuoteDetailsRouteStepsEl.dataset.accordionBound = 'true';
  swapQuoteDetailsRouteStepsEl.addEventListener('toggle', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLDetailsElement) || !target.classList.contains('swap-hop-step-details')) return;
    if (!target.open) return;
    swapQuoteDetailsRouteStepsEl
      ?.querySelectorAll<HTMLDetailsElement>('.swap-hop-step-details')
      .forEach((el) => {
        if (el !== target) el.open = false;
      });
  });
}

function ensureRoutePlanStepsExpanded(): void {
  if (swapQuoteRoutePlanDetailsEl) swapQuoteRoutePlanDetailsEl.open = true;
}

function ensureFirstHopExpanded(): void {
  const hops =
    swapQuoteDetailsRouteStepsEl?.querySelectorAll<HTMLDetailsElement>('.swap-hop-step-details');
  if (!hops?.length) return;
  hops.forEach((el, i) => {
    el.open = i === 0;
  });
}

function syncRoutePlanStepsUi(): void {
  bindRoutePlanStepsAccordion();
  ensureRoutePlanStepsExpanded();
  ensureFirstHopExpanded();
}

function refreshSwapQuoteDetailsPlaceholders(loading = swapQuoteFetching): void {
  if (lastSwapQuoteOk) return;
  refreshPendingQuoteUi(loading);
}

function resetSwapQuoteDetailsPanel(): void {
  if (swapQuoteDetailsEmptyEl) swapQuoteDetailsEmptyEl.hidden = true;
  if (swapQuoteDetailsBodyEl) swapQuoteDetailsBodyEl.hidden = false;
  if (swapQuoteSummaryEl) {
    swapQuoteSummaryEl.innerHTML = renderQuoteSummaryPlaceholder(swapQuoteFetching);
    swapQuoteSummaryEl.hidden = false;
  }
  if (swapQuoteDetailsRoutingEl) {
    swapQuoteDetailsRoutingEl.innerHTML = renderRoutingDiagramPlaceholder(swapQuoteFetching);
  }
  if (swapQuoteDetailsRouteStepsEl) {
    swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanStepsPlaceholder(swapQuoteFetching);
  }
  syncRoutePlanStepsUi();
  if (swapQuoteDetailsFieldsEl) {
    swapQuoteDetailsFieldsEl.innerHTML = swapQuoteFetching
      ? `<p class="routing-empty routing-empty--loading">${renderLoadingSpinner('sm')}</p>`
      : '<p class="routing-empty">—</p>';
  }
  if (swapQuoteRouteSubtitleEl) swapQuoteRouteSubtitleEl.textContent = 'Route';
  if (routingDialogTitleEl) routingDialogTitleEl.textContent = 'Routing';
  renderRawResponsePanels();
}

async function prefetchSwapPairPrices(options?: {
  forceFullDetails?: boolean;
  mints?: string[];
}): Promise<void> {
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const mints = [...new Set((options?.mints ?? [inputMint, outputMint]).filter(Boolean))];
  if (mints.length === 0) return;
  try {
    const forceFullDetailsMints = options?.forceFullDetails ? mints : [];
    const res = await fetchWithRetry('/api/tokens/resolve-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mints,
        tokenHints: buildTokenHintsForMints(mints),
        forceFullDetailsMints,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      stats?: Record<string, TokenPriceStats>;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error || `Price resolve failed (${res.status})`);
    }
    const stats = body.stats ?? {};
    for (const [mint, s] of Object.entries(stats)) {
      saveTokenPriceStats(mint, s);
    }
    updateSwapPairCards(stats);
    syncSwapSellAmountUi();
  } catch {
    // Prefetch is best-effort; pair cards keep last known stats or em dashes.
  }
}

function clearSwapQuotePanel(): void {
  for (const k of Object.keys(routeMintSymbolCache)) delete routeMintSymbolCache[k];
  for (const k of Object.keys(routeMintDecimalsCache)) delete routeMintDecimalsCache[k];
  if (swapSellFiatEl) swapSellFiatEl.textContent = '~$0.00';
  resetSwapQuoteToMock();
  if (swapPairCardsEl) {
    swapPairCardsEl.hidden = false;
    swapPairCardsEl.removeAttribute('aria-hidden');
  }
  if (swapQuoteError) clearInlineError(swapQuoteError);
}

function renderSwapQuoteUI(quote: Record<string, unknown>): void {
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  if (swapBuyAmountDisplayEl) {
    swapBuyAmountDisplayEl.textContent = outAmt.display;
    swapBuyAmountDisplayEl.dataset.empty = outAmt.display === '—' ? 'true' : 'false';
    if (outAmt.full) swapBuyAmountDisplayEl.title = outAmt.full;
    else swapBuyAmountDisplayEl.removeAttribute('title');
  }

  const payUsdLabel = formatSwapPayFiatDisplay(getQuotePayUsd(quote));
  const receiveUsdLabel = formatSwapReceiveFiatDisplay(getQuoteReceiveUsd(quote));
  if (swapSellFiatEl) swapSellFiatEl.textContent = payUsdLabel;
  if (swapBuyFiatEl) swapBuyFiatEl.textContent = receiveUsdLabel;

  const inS = getSwapInSym();
  const outS = getSwapOutSym();
  if (swapFooterRateEl) {
    if (typeof quote.swapRate === 'number' && Number.isFinite(quote.swapRate)) {
      swapFooterRateEl.textContent = `1 ${inS} ≈ ${formatSwapRate(quote.swapRate)} ${outS}`;
    } else {
      swapFooterRateEl.textContent = '—';
    }
  }

  if (swapFooterImpactEl) {
    if (quote.priceImpactPct != null && String(quote.priceImpactPct).length > 0) {
      swapFooterImpactEl.textContent = formatPriceImpactPct(quote.priceImpactPct);
    } else {
      swapFooterImpactEl.textContent = '—';
    }
  }

  if (swapFooterMinOutEl) {
    const minOut = formatQuoteTokenAmount(quote, 'min');
    if (minOut.display !== '—') {
      swapFooterMinOutEl.textContent = `${minOut.display} ${outS}`;
    } else {
      swapFooterMinOutEl.textContent = '—';
    }
  }

  if (swapFooterMaxSlippageEl) {
    swapFooterMaxSlippageEl.textContent = formatMaxSlippageRatio(quote);
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  setRouteChipLabel(formatRouteChipLabel(plan), plan.length === 0);

  if (routingDialogBodyEl) routingDialogBodyEl.innerHTML = renderRoutingDiagram(quote);

  renderSwapQuoteDetailsPanel(quote);
  updateSwapPairCards();
}

async function prefetchRouteTokenMetas(quote: Record<string, unknown>): Promise<void> {
  const mints = new Set<string>();
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
  }
  await prefetchTokenMetas([...mints]);
}

async function prefetchRouteTokenPrices(quote: Record<string, unknown>): Promise<void> {
  const mints = collectRoutePriceMints(quote).filter((m) => {
    const price = lookupMintPriceUsd(m, quote);
    return !(Number.isFinite(price) && price > 0);
  });
  if (mints.length === 0) return;

  try {
    const forceFullDetailsMints = mints.filter((m) => !quotedMintSession.has(m));
    const res = await fetchWithRetry('/api/tokens/resolve-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mints,
        tokenHints: buildTokenHintsForMints(mints),
        forceFullDetailsMints,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      stats?: Record<string, TokenPriceStats>;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error || `Price resolve failed (${res.status})`);
    }
    const stats = body.stats ?? {};
    for (const [mint, s] of Object.entries(stats)) {
      saveTokenPriceStats(mint, s);
    }
    if (Object.keys(stats).length > 0) {
      updateSwapPairCards(stats);
      if (lastSwapQuoteOk) {
        const inputMint = swapInputMintInput?.value.trim() ?? '';
        const outputMint = swapOutputMintInput?.value.trim() ?? '';
        lastSwapQuoteOk = attachQuoteTokenPriceMeta(lastSwapQuoteOk, inputMint, outputMint);
        renderSwapQuoteUI(lastSwapQuoteOk);
      }
    }
  } catch {
    // Best-effort — fee USD chips fall back to em dash when price is unavailable.
  }
}

async function enrichRouteLabels(quote: Record<string, unknown>): Promise<void> {
  try {
    await prefetchRouteMintSymbols(quote);
    await prefetchRouteTokenMetas(quote);
    await prefetchRouteTokenPrices(quote);
    const inputMint = swapInputMintInput?.value.trim() ?? quoteInputMint(quote) ?? '';
    const outputMint = swapOutputMintInput?.value.trim() ?? quoteOutputMint(quote) ?? '';
    const activeQuote = attachQuoteTokenPriceMeta(
      lastSwapQuoteOk ?? quote,
      inputMint,
      outputMint,
    );
    lastSwapQuoteOk = activeQuote;
    renderSwapQuoteUI(activeQuote);
    updateSwapTokenIcons();
    updateSwapPairCards();
    scheduleRoutingDiagramZoom();
  } catch {
    /* keep initial render on symbol fetch failure */
  }
}

function syncSlippageInputForAutoSlippage(): void {
  const walletOk = hasValidSwapWallet();
  const auto = swapAutoSlippageCheckbox?.checked === true;
  if (swapSlippageInput) {
    swapSlippageInput.disabled = !walletOk || auto;
    swapSlippageInput.title = !walletOk
      ? SWAP_WALLET_LOCKED_TITLE
      : auto
        ? 'Disabled while auto slippage is on'
        : 'Slippage percent';
  }
}

function collectSwapBuildOptions(): Record<string, unknown> {
  const slippage = swapSlippageInput ? Number(swapSlippageInput.value) : undefined;
  const router = getSwapRouter();
  const serviceFeeRaw =
    swapEnableServiceFeeCheckbox?.checked === true ? (swapServiceFeeInput?.value.trim() ?? '') : '';
  const serviceFeeN = serviceFeeRaw ? Number(serviceFeeRaw) : NaN;
  return {
    slippage: Number.isFinite(slippage) ? slippage : undefined,
    router,
    gasless: swapGaslessCheckbox?.checked === true,
    autoCalculateSlippage: swapAutoSlippageCheckbox?.checked === true,
    simulate: swapSimulateCheckbox?.checked === true,
    partner:
      swapEnablePartnerCheckbox?.checked === true ? swapPartnerInput?.value.trim() || undefined : undefined,
    poolAddress:
      swapEnablePoolAddressCheckbox?.checked === true
        ? swapPoolAddressInput?.value.trim() || undefined
        : undefined,
    protocol:
      swapEnableProtocolCheckbox?.checked === true
        ? swapProtocolSelect?.value.trim() || undefined
        : undefined,
    swapFee:
      swapEnableServiceFeeCheckbox?.checked === true &&
      Number.isFinite(serviceFeeN) &&
      serviceFeeN >= 0
        ? serviceFeeN
        : 0,
  };
}

function vybeBuildParamsKey(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  opts: Record<string, unknown>,
): string {
  return JSON.stringify({ wallet, inputMint, outputMint, amount, ...opts });
}

type VybeQuoteApiBody = Record<string, unknown> & {
  error?: string;
  _build?: Record<string, unknown>;
  _builtAt?: number;
  _tokenStats?: Record<string, TokenPriceStats>;
  _buildUnavailable?: boolean;
};

function isVybeQuoteTxFresh(paramsKey: string): boolean {
  return (
    lastVybeBuild != null &&
    lastVybeBuild.paramsKey === paramsKey &&
    Date.now() - lastVybeBuild.builtAt < VYBE_QUOTE_TX_REUSE_MS
  );
}

function cacheVybeQuoteBuild(
  body: VybeQuoteApiBody,
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): string | null {
  const buildTx = extractSwapBuildTransaction(body._build);
  if (buildTx && typeof body._builtAt === 'number') {
    lastRawSwapResponse = body._build;
    lastVybeBuild = {
      tx: buildTx,
      builtAt: body._builtAt,
      paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, amount, buildOpts),
      buildPayload: body._build as Record<string, unknown>,
    };
    return buildTx;
  }
  return null;
}

function applyVybeQuoteBodyToUi(
  body: VybeQuoteApiBody,
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): void {
  if (!swapQuoteFetching) return;
  if (body._tokenStats) {
    for (const [mint, s] of Object.entries(body._tokenStats)) {
      saveTokenPriceStats(mint, s);
    }
    updateSwapPairCards(body._tokenStats, swapQuoteFetching);
  }
  quotedMintSession.add(inputMint);
  quotedMintSession.add(outputMint);
  const selectedRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const quote = annotateQuoteRouterMeta(stripVybeQuoteMetadata(body), selectedRouter);
  lastSwapQuoteOk = quote;
  lastRawQuoteResponse = body;
  swapQuoteWalletSnapshot = wallet;
  cacheVybeQuoteBuild(body, wallet, inputMint, outputMint, amount, buildOpts);
  renderRawResponsePanels();
  renderSwapQuoteUI(quote);
  void enrichRouteLabels(quote);
  if (swapBuildBtn) syncBuildButtonState();
}

async function fetchAggregatorSwapQuote(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippage: number | undefined,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  params.set('amount', String(amount));
  params.set('inputMintAddress', inputMint);
  params.set('outputMintAddress', outputMint);
  if (wallet) params.set('accountAddress', wallet);
  if (typeof slippage === 'number' && Number.isFinite(slippage)) {
    params.set('slippage', String(slippage));
  }

  const quoteRes = await fetchWithRetry(`/api/trading/swap-quote?${params.toString()}`);
  const quoteBody = (await quoteRes.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };
  if (!quoteRes.ok) {
    throw new Error(quoteBody.error || `Quote failed (${quoteRes.status})`);
  }
  return quoteBody;
}

async function requestAggregatorQuoteAndBuild(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  try {
    return await executeAggregatorQuoteAndBuild(wallet, inputMint, outputMint, amount, buildOpts);
  } catch (err) {
    if (router !== 'jupiter' || !isRouterFallbackEnabled()) throw err;
    setSwapRouter('titan', { invalidateQuote: false });
    return executeAggregatorQuoteAndBuild(wallet, inputMint, outputMint, amount, {
      ...buildOpts,
      router: 'titan',
    });
  }
}

async function executeAggregatorQuoteAndBuild(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const slippage = buildOpts.slippage;
  const slippageNum = typeof slippage === 'number' && Number.isFinite(slippage) ? slippage : undefined;

  let quoteBody = await fetchAggregatorSwapQuote(
    wallet,
    inputMint,
    outputMint,
    amount,
    slippageNum,
  );

  if (router === 'jupiter' && isEmptyAggregatorQuote(quoteBody)) {
    throw jupiterRouteUnavailableError(isRouterFallbackEnabled());
  }

  let inRaw = extractAuthoritativeInAmountRaw(quoteBody, {});
  let buildAmount = amount;
  if (inRaw) {
    const normalized = rawAmountToUiNumber(inRaw, getMintDecimals(inputMint));
    if (Number.isFinite(normalized) && normalized > 0) buildAmount = normalized;
    try {
      if (uiAmountToRawBigInt(amount, inputMint).toString() !== inRaw) {
        quoteBody = await fetchAggregatorSwapQuote(
          wallet,
          inputMint,
          outputMint,
          buildAmount,
          slippageNum,
        );
        inRaw = extractAuthoritativeInAmountRaw(quoteBody, {});
        if (inRaw) {
          const renormalized = rawAmountToUiNumber(inRaw, getMintDecimals(inputMint));
          if (Number.isFinite(renormalized) && renormalized > 0) buildAmount = renormalized;
        }
      }
    } catch {
      /* keep buildAmount from first normalization */
    }
  }

  const routePlan = Array.isArray(quoteBody.routePlan) ? quoteBody.routePlan : undefined;
  const swapRes = await fetchWithRetry('/api/trading/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountAddress: wallet,
      amount: buildAmount,
      inputMintAddress: inputMint,
      outputMintAddress: outputMint,
      ...(routePlan ? { routePlan } : {}),
      ...buildOpts,
      router,
    }),
  });
  const swapBody = (await swapRes.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };
  if (!swapRes.ok) {
    throw new Error(swapBody.error || `Build failed (${swapRes.status})`);
  }

  const buildProvider = normalizeRouterId(swapBody.provider ?? router);
  if (router === 'jupiter' && buildProvider === 'titan') {
    if (!isRouterFallbackEnabled()) {
      throw jupiterRouteUnavailableError(false);
    }
    setSwapRouter('titan', { invalidateQuote: false });
    return executeAggregatorQuoteAndBuild(wallet, inputMint, outputMint, amount, {
      ...buildOpts,
      router: 'titan',
    });
  }

  applyAggregatorBuildToUi(
    quoteBody,
    swapBody,
    router,
    wallet,
    inputMint,
    outputMint,
    buildAmount,
    buildOpts,
  );

  const buildTx = extractSwapBuildTransaction(swapBody);
  if (!buildTx) {
    throw new Error('Swap build did not return a transaction.');
  }
  return { tx: buildTx, buildPayload: swapBody };
}

function applyAggregatorBuildToUi(
  quoteBody: Record<string, unknown>,
  swapBody: Record<string, unknown>,
  router: string,
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): void {
  if (!swapQuoteFetching) return;
  quotedMintSession.add(inputMint);
  quotedMintSession.add(outputMint);
  lastRawQuoteResponse = quoteBody;
  lastRawSwapResponse = swapBody;

  let quote = annotateQuoteRouterMeta(quoteBody, router);
  quote = applyFeeEnrichmentToQuote(
    quote,
    swapBody._feeEnrichment as Record<string, unknown> | undefined,
    swapBody,
  );

  const inAmountRaw = extractAuthoritativeInAmountRaw(quoteBody, swapBody);
  let effectiveAmount = amount;
  if (inAmountRaw) {
    quote = { ...quote, inAmount: inAmountRaw };
    if (Array.isArray(quote.routePlan) && quote.routePlan.length > 0) {
      quote.routePlan = (quote.routePlan as VybeRoutePlanStepLite[]).map((step, idx) => {
        if (idx !== 0 || !step.swapInfo) return step;
        return { ...step, swapInfo: { ...step.swapInfo, inAmount: inAmountRaw } };
      });
    }
    const synced = syncSellAmountInputFromInAmountRaw(inAmountRaw, inputMint);
    if (synced != null) effectiveAmount = synced;
  }

  if (!quote._walletPayDebitRaw) {
    const estimatedPay = estimateInputSideWalletPayDebitFromQuote(quote);
    if (estimatedPay) {
      quote = { ...quote, _walletPayDebitRaw: estimatedPay };
    }
  }

  quote = attachQuoteTokenPriceMeta(quote, inputMint, outputMint);
  lastSwapQuoteOk = quote;
  swapQuoteWalletSnapshot = wallet;

  const buildTx = extractSwapBuildTransaction(swapBody);
  if (buildTx) {
    lastVybeBuild = {
      tx: buildTx,
      builtAt: Date.now(),
      paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, effectiveAmount, buildOpts),
      buildPayload: swapBody,
    };
  }

  renderRawResponsePanels();
  renderSwapQuoteUI(quote);
  void enrichRouteLabels(quote);
  if (swapBuildBtn) syncBuildButtonState();
}

async function resolveAggregatorBuildTx(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  const paramsKey = vybeBuildParamsKey(wallet, inputMint, outputMint, amount, buildOpts);
  if (isVybeQuoteTxFresh(paramsKey) && lastVybeBuild) {
    lastRawSwapResponse = lastVybeBuild.buildPayload;
    renderRawResponsePanels();
    return {
      tx: lastVybeBuild.tx,
      buildPayload: lastVybeBuild.buildPayload as Record<string, unknown>,
    };
  }
  return requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, amount, buildOpts);
}

async function requestVybeQuote(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  const forceFullDetailsMints = [inputMint, outputMint].filter((m) => !quotedMintSession.has(m));
  const selectedRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const res = await fetchWithRetry('/api/trading/vybe-quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountAddress: wallet,
      amount,
      inputMintAddress: inputMint,
      outputMintAddress: outputMint,
      ...buildOpts,
      router: selectedRouter,
      tokenHints: buildTokenHintsForMints([inputMint, outputMint]),
      forceFullDetailsMints,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as VybeQuoteApiBody;
  if (!res.ok) {
    throw new Error(body.error || `Quote failed (${res.status})`);
  }

  const fallbackRouter = detectVybeAggregatorFallbackRouter(body, selectedRouter);
  if (fallbackRouter) {
    if (!isRouterFallbackEnabled()) {
      throw vybeRouteUnavailableError(fallbackRouter);
    }
    setSwapRouter(fallbackRouter, { invalidateQuote: false });
    return requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, amount, {
      ...buildOpts,
      router: fallbackRouter,
    });
  }

  applyVybeQuoteBodyToUi(body, wallet, inputMint, outputMint, amount, buildOpts);
  const buildTx = extractSwapBuildTransaction(body._build);
  if (!buildTx) {
    throw new Error('Vybe quote did not return a transaction.');
  }
  return { tx: buildTx, buildPayload: body._build as Record<string, unknown> };
}

async function resolveVybeBuildTx(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  const paramsKey = vybeBuildParamsKey(wallet, inputMint, outputMint, amount, buildOpts);
  if (isVybeQuoteTxFresh(paramsKey) && lastVybeBuild) {
    lastRawSwapResponse = lastVybeBuild.buildPayload;
    renderRawResponsePanels();
    return {
      tx: lastVybeBuild.tx,
      buildPayload: lastVybeBuild.buildPayload as Record<string, unknown>,
    };
  }
  return requestVybeQuote(wallet, inputMint, outputMint, amount, buildOpts);
}

/** Vybe returns base64 wire tx as `tx` — use that string exactly, no transforms. */
function extractSwapBuildTransaction(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const tx = payload.tx ?? payload.transaction;
  return typeof tx === 'string' && tx.length > 0 ? tx : null;
}

async function resolvePairTokenPrices(
  inputMint: string,
  outputMint: string,
  forceFullDetailsMints: string[],
): Promise<Record<string, TokenPriceStats>> {
  const mints = [inputMint, outputMint].filter(Boolean);
  const res = await fetchWithRetry('/api/tokens/resolve-prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mints,
      tokenHints: buildTokenHintsForMints(mints),
      forceFullDetailsMints,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    stats?: Record<string, TokenPriceStats>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || `Price resolve failed (${res.status})`);
  }
  const stats = body.stats ?? {};
  for (const [mint, s] of Object.entries(stats)) {
    saveTokenPriceStats(mint, s);
  }
  return stats;
}

async function assertVybeSellBalance(
  wallet: string,
  inputMint: string,
  amount: number,
  symbol?: string,
): Promise<void> {
  const params = new URLSearchParams({
    mint: inputMint,
    amount: String(amount),
  });
  if (symbol?.trim()) params.set('symbol', symbol.trim());
  const res = await fetchWithRetry(
    `/api/wallets/${encodeURIComponent(wallet)}/sell-balance-check?${params.toString()}`,
  );
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `Balance check failed (${res.status})`);
  }
}

function stripVybeQuoteMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const { _build, _builtAt, _tokenStats, _buildUnavailable, ...quote } = body;
  return quote;
}

function getBrowserWalletAddress(): string {
  return getSolanaWalletProvider()?.publicKey?.toString() ?? '';
}

/** Returns an error message when Vybe quote prerequisites are not met. */
function validateVybeQuoteWallet(): string | null {
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (!wallet) {
    return 'Connect your wallet or enter a signer address to get a quote.';
  }
  if (!hasValidSwapWallet()) {
    return 'Enter a valid Solana wallet address.';
  }
  const connected = getBrowserWalletAddress();
  if (!connected) {
    return 'Connect your wallet to get a quote.';
  }
  if (connected !== wallet) {
    return 'Connected wallet does not match the address field.';
  }
  return null;
}

async function fetchSwapQuote(): Promise<void> {
  if (!swapInputMintInput || !swapOutputMintInput || !swapAmountInput) return;
  const inputMint = swapInputMintInput.value.trim();
  const outputMint = swapOutputMintInput.value.trim();
  const amount = Number(swapAmountInput.value);
  const wallet = swapWalletAddressInput?.value.trim() ?? '';

  if (!inputMint || !outputMint) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Input and output mint required for quote.');
    return;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Amount must be a positive number.');
    syncSwapSellAmountUi();
    return;
  }
  if (amount === 0) {
    if (swapQuoteError) clearInlineError(swapQuoteError);
    syncSwapSellAmountUi();
    return;
  }
  if (hasValidSwapWallet()) {
    const sellable = getWalletSellableAmountUi(inputMint);
    if (sellable != null && amount > sellable) {
      clampSwapAmountInputToMax();
      syncSwapSellAmountUi();
      if (swapQuoteError) {
        showInlineError(
          swapQuoteError,
          `Amount exceeds max sellable balance (${formatSwapInputAmountValue(sellable, getMintDecimals(inputMint))}).`
        );
      }
      return;
    }
  }

  const router = getSwapRouter();
  if (router === 'vybe') {
    const walletErr = validateVybeQuoteWallet();
    if (walletErr) {
      if (swapQuoteError) showInlineError(swapQuoteError, walletErr);
      return;
    }
  } else if (!wallet) {
    if (swapQuoteError) {
      showInlineError(swapQuoteError, 'Wallet address is required to quote and build with Jupiter or Titan.');
    }
    return;
  } else if (!hasValidSwapWallet()) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Enter a valid Solana wallet address.');
    return;
  }

  lastSwapQuoteOk = null;
  lastVybeBuild = null;
  if (swapBuildBtn) syncBuildButtonState();
  resetSwapQuoteDetailsPanel();
  if (swapQuoteError) clearInlineError(swapQuoteError);
  if (swapQuoteWarning) clearInlineWarning(swapQuoteWarning);
  applyQuoteLoadingUi();

  const buildOpts = collectSwapBuildOptions();
  const forceFullDetailsMints = [inputMint, outputMint].filter((m) => !quotedMintSession.has(m));

  try {
    if (router === 'vybe') {
      try {
        await assertVybeSellBalance(wallet, inputMint, amount, getSwapInSym());
      } catch (balanceErr) {
        if (swapQuoteError) {
          showInlineError(
            swapQuoteError,
            balanceErr instanceof Error ? balanceErr.message : String(balanceErr),
          );
        }
        invalidateSwapQuoteUi();
        return;
      }
    }
    void refreshLowSolTradeWarning();

    try {
      const pairStats = await resolvePairTokenPrices(inputMint, outputMint, forceFullDetailsMints);
      updateSwapPairCards(pairStats, swapQuoteFetching);
    } catch (priceErr) {
      if (swapQuoteError) {
        showInlineError(
          swapQuoteError,
          priceErr instanceof Error ? priceErr.message : String(priceErr),
        );
      }
      invalidateSwapQuoteUi();
      return;
    }

    try {
      if (router === 'vybe') {
        await requestVybeQuote(wallet, inputMint, outputMint, amount, buildOpts);
      } else {
        await requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, amount, buildOpts);
      }
    } catch (quoteErr) {
      if (swapQuoteError) {
        showInlineError(
          swapQuoteError,
          quoteErr instanceof Error ? quoteErr.message : String(quoteErr),
        );
      }
      invalidateSwapQuoteUi();
    }
  } catch (err) {
    if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
  } finally {
    swapQuoteFetching = false;
    setSwapQuoteButtonLoading(false);
    if (swapQuoteLoading) {
      swapQuoteLoading.hidden = true;
      swapQuoteLoading.setAttribute('aria-hidden', 'true');
    }
  }
}

function formatSignConfirmRoute(
  quote: Record<string, unknown>,
  buildPayload?: Record<string, unknown>,
): string {
  const details = buildPayload?.details as Record<string, unknown> | undefined;
  const buildQuote = details?.quote as Record<string, unknown> | undefined;
  const provider = String(buildPayload?.provider ?? buildQuote?.provider ?? '').trim();
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const labels = plan
    .map((step) => step.swapInfo?.label?.trim())
    .filter((label): label is string => !!label);
  if (labels.length) return [...new Set(labels)].join(' → ');
  if (provider) return provider;
  return 'Vybe';
}

function getSignConfirmSummary(
  quote: Record<string, unknown>,
  buildPayload?: Record<string, unknown>,
): { pay: string; receive: string; route: string } {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const payAmt = getQuoteWalletPayLabelFromQuote(quote);
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  return {
    pay: `${payAmt} ${inSym}`,
    receive: `${outAmt.display} ${outSym}`,
    route: formatSignConfirmRoute(quote, buildPayload),
  };
}

let signConfirmResolver: ((confirmed: boolean) => void) | null = null;

function finishSignConfirm(confirmed: boolean): void {
  const resolve = signConfirmResolver;
  signConfirmResolver = null;
  if (swapSignConfirmDialogEl?.open) swapSignConfirmDialogEl.close();
  resolve?.(confirmed);
}

function promptSignSwapConfirm(
  quote: Record<string, unknown>,
  buildPayload?: Record<string, unknown>,
): Promise<boolean> {
  const summary = getSignConfirmSummary(quote, buildPayload);
  if (swapSignConfirmPayEl) swapSignConfirmPayEl.textContent = summary.pay;
  if (swapSignConfirmReceiveEl) swapSignConfirmReceiveEl.textContent = summary.receive;
  if (swapSignConfirmRouteEl) swapSignConfirmRouteEl.textContent = summary.route;
  swapSignConfirmDialogEl?.showModal();
  return new Promise((resolve) => {
    signConfirmResolver = resolve;
  });
}

async function applyBuiltSwapTx(buildTx: string, buildPayload: Record<string, unknown>): Promise<boolean> {
  if (!swapTxBase64El || !swapBuildResultEl) return false;
  swapTxBase64El.value = buildTx;
  swapBuildResultEl.hidden = false;
  refreshQuoteUiAfterBuild(buildPayload);
  renderRawResponsePanels();
  return true;
}

async function postPasteSignSwap(): Promise<void> {
  if (!swapPasteTxInputEl || !swapBuildResultEl || !swapTxBase64El) return;
  const pasted = swapPasteTxInputEl.value.trim();
  if (!pasted) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Paste a base64 transaction first.');
    return;
  }
  if (swapQuoteError) clearInlineError(swapQuoteError);
  try {
    await ensureBrowserWalletConnected(swapWalletAddressInput?.value.trim() ?? '');
  } catch (err) {
    if (swapQuoteError) {
      showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (swapBuildBtn) swapBuildBtn.disabled = true;
  try {
    swapTxBase64El.value = await signSwapTransactionBase64(pasted, true);
    swapBuildResultEl.hidden = false;
  } catch (err) {
    if (swapQuoteError) {
      showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
    }
  } finally {
    syncBuildButtonState();
  }
}

function syncBuildButtonState(): void {
  if (!swapBuildBtn) return;
  if (swapBuildMode === 'paste-sign') {
    swapBuildBtn.disabled = false;
    return;
  }
  swapBuildBtn.disabled = !lastSwapQuoteOk;
}

async function postBuildSwap(): Promise<void> {
  if (swapBuildMode === 'paste-sign') {
    return postPasteSignSwap();
  }
  if (!lastSwapQuoteOk) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Get a quote first.');
    return;
  }
  let wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (swapBuildMode === 'build-sign') {
    try {
      wallet = await ensureBrowserWalletConnected(wallet);
    } catch (err) {
      if (swapQuoteError) {
        showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const confirmed = await promptSignSwapConfirm(lastSwapQuoteOk);
    if (!confirmed) return;
  } else if (!wallet) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Wallet (accountAddress) is required to build the transaction.');
    return;
  }
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = swapAmountInput ? Number(swapAmountInput.value) : NaN;
  const buildOpts = collectSwapBuildOptions();
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());

  if (!swapBuildResultEl || !swapTxBase64El) return;
  if (swapQuoteError) clearInlineError(swapQuoteError);
  void refreshLowSolTradeWarning();
  if (swapBuildBtn) swapBuildBtn.disabled = true;

  try {
    const { tx: buildTx, buildPayload } =
      router === 'vybe'
        ? await resolveVybeBuildTx(wallet, inputMint, outputMint, amount, buildOpts)
        : await resolveAggregatorBuildTx(wallet, inputMint, outputMint, amount, buildOpts);
    if (swapBuildMode === 'build-sign') {
      swapTxBase64El.value = await signSwapTransactionBase64(buildTx, true);
      swapBuildResultEl.hidden = false;
    } else {
      const ok = await applyBuiltSwapTx(buildTx, buildPayload);
      if (!ok) return;
    }
  } catch (err) {
    if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
  } finally {
    syncBuildButtonState();
  }
}

function getSolanaWalletProvider(): SolanaWalletProvider | null {
  const w = getSolanaWindow();
  if (w.phantom?.solana?.signTransaction) return w.phantom.solana;
  if (w.solana?.signTransaction) return w.solana;
  if (w.phantom?.solana?.connect) return w.phantom.solana;
  if (w.solana?.connect) return w.solana;
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

async function ensureBrowserWalletConnected(existingWallet: string): Promise<string> {
  const provider = getSolanaWalletProvider();
  if (!provider) {
    throw new Error('No browser wallet found. Install Phantom or another Solana wallet extension.');
  }
  if (!provider.publicKey && provider.connect) {
    await provider.connect();
  }
  const connected = provider.publicKey?.toString() ?? '';
  if (!connected) {
    throw new Error('Connect your wallet to build and sign the swap.');
  }
  if (swapWalletAddressInput) swapWalletAddressInput.value = connected;
  if (existingWallet && existingWallet !== connected) {
    throw new Error('Connected wallet does not match the wallet address field.');
  }
  syncWalletFieldForMode();
  syncSellTokenPickerState();
  onWalletAddressReady(true);
  return connected;
}

function getBrowserConnection(): Connection {
  const w = getSolanaWindow();
  if (!w.__swapBrowserConnection) {
    w.__swapBrowserConnection = new Connection(`${window.location.origin}/api/solana/rpc`, 'confirmed');
  }
  return w.__swapBrowserConnection;
}

function decodeVersionedTxFromBase64(txString: string): VersionedTransaction {
  const trimmed = txString.trim();
  try {
    return VersionedTransaction.deserialize(
      Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0)),
    );
  } catch {
    throw new Error('Could not decode swap transaction (expected base64 wire bytes).');
  }
}

/** Vybe v0 swap txs use ALTs — refresh blockhash (+ ALTs) before wallet sign/simulate. */
async function prepareSwapTxForSigning(txString: string): Promise<VersionedTransaction> {
  const trimmed = txString.trim();
  try {
    const res = await fetch('/api/solana/prepare-swap-tx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: trimmed }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      tx?: string;
      simulationErr?: unknown;
      error?: string;
    };
    if (res.ok && typeof body.tx === 'string' && body.tx.length > 0) {
      if (body.simulationErr) {
        console.warn('Swap tx simulation warning:', body.simulationErr);
      }
      return decodeVersionedTxFromBase64(body.tx);
    }
    if (!res.ok && body.error) {
      console.warn('Server prepare-swap-tx failed, using browser fallback:', body.error);
    }
  } catch (err) {
    console.warn('Server prepare-swap-tx unavailable, using browser fallback:', err);
  }

  const vtx = decodeVersionedTxFromBase64(trimmed);
  const connection = getBrowserConnection();
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const lookups = vtx.message.addressTableLookups;

  if (lookups.length > 0) {
    const altAccounts: AddressLookupTableAccount[] = [];
    for (const lookup of lookups) {
      const res = await connection.getAddressLookupTable(lookup.accountKey);
      if (!res.value) {
        throw new Error(`Failed to load address lookup table ${lookup.accountKey.toBase58()}.`);
      }
      altAccounts.push(res.value);
    }
    const decompiled = TransactionMessage.decompile(vtx.message, {
      addressLookupTableAccounts: altAccounts,
    });
    decompiled.recentBlockhash = blockhash;
    return new VersionedTransaction(decompiled.compileToV0Message(altAccounts));
  }

  vtx.message.recentBlockhash = blockhash;
  return vtx;
}

/** Phantom shows balance changes only when the wallet simulates before sign — use signAndSendTransaction. */
async function signSwapTransactionBase64(txString: string, sendAfterSign = false): Promise<string> {
  const provider = getSolanaWalletProvider();
  if (
    !provider?.signAndSendTransaction &&
    !provider?.signTransaction &&
    !provider?.signAllTransactions
  ) {
    throw new Error('Connected wallet cannot sign transactions.');
  }

  const vtx = await prepareSwapTxForSigning(txString);

  if (sendAfterSign && provider.signAndSendTransaction) {
    const { signature } = await provider.signAndSendTransaction(vtx, {
      skipPreflight: false,
    });
    if (swapQuoteWarning) {
      showInlineWarning(swapQuoteWarning, `Transaction sent: ${signature}`);
    }
    return signature;
  }

  if (!provider.signTransaction && !provider.signAllTransactions) {
    throw new Error('Connected wallet cannot sign transactions.');
  }

  let signed: SignableVersionedTransaction;
  if (provider.signTransaction) {
    signed = await provider.signTransaction(vtx);
  } else {
    signed = (await provider.signAllTransactions!([vtx]))[0]!;
  }

  if (sendAfterSign) {
    const sig = await getBrowserConnection().sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
    if (swapQuoteWarning) {
      showInlineWarning(swapQuoteWarning, `Transaction sent: ${sig}`);
    }
    return bytesToBase64(signed.serialize());
  }

  return bytesToBase64(signed.serialize());
}

function updateConnectWalletButtonUi(address: string, hasWallet: boolean): void {
  const btn = swapConnectWalletBtn;
  const disconnectBtn = swapDisconnectWalletBtn;
  const iconEl = swapConnectWalletBtnIconEl;
  const textEl = swapConnectWalletBtnTextEl;
  if (!btn || !textEl) return;

  btn.classList.remove('swap-wallet-field-connect--connected', 'swap-wallet-field-connect--loading');

  if (walletConnectLoading) {
    btn.disabled = true;
    btn.classList.add('swap-wallet-field-connect--loading');
    if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--spinner';
    textEl.textContent = 'Connecting…';
    if (disconnectBtn) disconnectBtn.hidden = true;
    return;
  }

  if (hasWallet) {
    btn.disabled = true;
    btn.classList.add('swap-wallet-field-connect--connected');
    if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--wallet';
    textEl.textContent = truncate(address, 4, 4);
    if (disconnectBtn) disconnectBtn.hidden = false;
    return;
  }

  btn.disabled = false;
  if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--wallet';
  textEl.textContent = 'Connect wallet';
  if (disconnectBtn) disconnectBtn.hidden = true;
}

async function disconnectBrowserWallet(): Promise<void> {
  const provider = getSolanaWalletProvider();
  if (provider?.disconnect) {
    try {
      await provider.disconnect();
    } catch {
      /* extension may reject if already disconnected */
    }
  }
  if (swapWalletAddressInput) swapWalletAddressInput.value = '';
  walletConnectLoading = false;
  syncWalletFieldForMode();
  syncSellTokenPickerState();
  onWalletAddressReady(true);
}

function syncWalletFieldForMode(): void {
  const needsWalletConnect = swapBuildMode === 'build-sign' || swapBuildMode === 'paste-sign';
  const address = swapWalletAddressInput?.value.trim() ?? '';
  const hasWallet = Boolean(address);

  if (swapWalletSignRowEl) swapWalletSignRowEl.hidden = !needsWalletConnect;

  if (swapWalletAddressInput) {
    swapWalletAddressInput.hidden = needsWalletConnect;
    swapWalletAddressInput.readOnly = false;
  }

  if (!needsWalletConnect) return;

  updateConnectWalletButtonUi(address, hasWallet);
}

function syncSwapBuildModeUi(): void {
  const isSignMode = swapBuildMode === 'build-sign';
  const isPasteMode = swapBuildMode === 'paste-sign';
  const isBuildOnlyMode = swapBuildMode === 'build';

  swapModeBuildBtn?.classList.toggle('swap-mode-switch__btn--active', isBuildOnlyMode);
  swapModeBuildSignBtn?.classList.toggle('swap-mode-switch__btn--active', isSignMode);
  swapModePasteSignBtn?.classList.toggle('swap-mode-switch__btn--active', isPasteMode);
  swapModeBuildBtn?.setAttribute('aria-selected', isBuildOnlyMode ? 'true' : 'false');
  swapModeBuildSignBtn?.setAttribute('aria-selected', isSignMode ? 'true' : 'false');
  swapModePasteSignBtn?.setAttribute('aria-selected', isPasteMode ? 'true' : 'false');

  if (swapPasteSignPanelEl) swapPasteSignPanelEl.hidden = !isPasteMode;
  if (swapStandardFlowEl) swapStandardFlowEl.hidden = isPasteMode;
  if (swapQuoteBtn) swapQuoteBtn.hidden = isPasteMode;

  syncWalletFieldForMode();
  syncBuildButtonState();

  const buildLabelEl = swapBuildBtn?.querySelector('.swap-action-btn__label');
  const buildHintEl = swapBuildBtn?.querySelector('.swap-action-btn__hint');
  if (buildLabelEl) {
    buildLabelEl.textContent = isPasteMode
      ? 'Sign pasted tx'
      : isSignMode
        ? 'Build & sign swap'
        : 'Build swap (no signing)';
  }
  if (buildHintEl) {
    buildHintEl.textContent = isPasteMode
      ? 'Wallet signs pasted base64'
      : isSignMode
        ? 'Connect wallet & sign'
        : 'Requires quote & wallet';
  }
  if (swapBuildResultTitleEl) {
    swapBuildResultTitleEl.textContent =
      isSignMode || isPasteMode ? 'Transaction signature' : 'Unsigned transaction (base64)';
  }
  if (swapBuildResultMetaEl) {
    swapBuildResultMetaEl.textContent =
      isSignMode || isPasteMode
        ? 'Signed and sent via your browser wallet (Phantom simulates balance changes before you approve).'
        : 'Unsigned wire transaction from Vybe build. Copy or sign separately.';
  }
  if (swapAdvancedBuildHintEl) {
    if (isPasteMode) {
      swapAdvancedBuildHintEl.textContent = 'Not used in Paste & Sign mode.';
    } else {
      swapAdvancedBuildHintEl.innerHTML = isSignMode
        ? 'Used only when you click <strong>Build &amp; sign swap</strong>.'
        : 'Used only when you click <strong>Build swap (no signing)</strong>.';
    }
  }
}

function setSwapBuildMode(mode: SwapBuildMode): void {
  swapBuildMode = mode;
  syncSwapBuildModeUi();
}

function getSwapAmountStep(): number {
  if (!swapAmountInput) return 0.01;
  const raw = swapAmountInput.getAttribute('step');
  if (raw && raw !== 'any') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0.01;
}

function adjustSwapAmountByStep(direction: 1 | -1): void {
  if (!swapAmountInput) return;
  const cur = Number(swapAmountInput.value);
  const base = Number.isFinite(cur) ? cur : 0;
  const step = getSwapAmountStep();
  let next = base + direction * step;
  const minAttr = swapAmountInput.min;
  const min = minAttr !== '' && Number.isFinite(Number(minAttr)) ? Number(minAttr) : 0;
  if (next < min) next = min;
  const maxAttr = swapAmountInput.max;
  const max = maxAttr !== '' && Number.isFinite(Number(maxAttr)) ? Number(maxAttr) : null;
  if (max != null && next > max) next = max;
  const rounded = Math.round(next / step) * step;
  const out =
    Number.isInteger(rounded) || Math.abs(rounded - Math.round(rounded)) < 1e-9
      ? String(Math.round(rounded))
      : String(parseFloat(rounded.toFixed(10)));
  swapAmountInput.value = out;
  swapAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function wireBuildOptionToggle(
  enableEl: HTMLInputElement | null,
  fieldEl: HTMLElement | null,
  valueEl: HTMLInputElement | HTMLSelectElement | null,
): void {
  if (!enableEl || !fieldEl) return;
  const sync = (): void => {
    const on = enableEl.checked;
    fieldEl.hidden = !on;
    if (!on && valueEl) {
      if (valueEl instanceof HTMLSelectElement) valueEl.selectedIndex = 0;
      else valueEl.value = '';
    }
    invalidateSwapQuoteAfterInputChange();
  };
  enableEl.addEventListener('change', sync);
  valueEl?.addEventListener('input', invalidateSwapQuoteAfterInputChange);
  valueEl?.addEventListener('change', invalidateSwapQuoteAfterInputChange);
  sync();
}

wireBuildOptionToggle(swapEnablePartnerCheckbox, swapPartnerFieldEl, swapPartnerInput);
wireBuildOptionToggle(swapEnablePoolAddressCheckbox, swapPoolAddressFieldEl, swapPoolAddressInput);
wireBuildOptionToggle(swapEnableProtocolCheckbox, swapProtocolFieldEl, swapProtocolSelect);
wireBuildOptionToggle(swapEnableServiceFeeCheckbox, swapServiceFeeFieldEl, swapServiceFeeInput);

swapModeBuildBtn?.addEventListener('click', () => setSwapBuildMode('build'));
swapModeBuildSignBtn?.addEventListener('click', () => setSwapBuildMode('build-sign'));
swapModePasteSignBtn?.addEventListener('click', () => setSwapBuildMode('paste-sign'));
swapRouterSwitchEl?.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-router]');
  if (!btn?.dataset.router) return;
  setSwapRouter(btn.dataset.router);
});
swapVybeFallbackCheckbox?.addEventListener('change', invalidateSwapQuoteAfterInputChange);
syncRouterFallbackToggleUi();
swapConnectWalletBtn?.addEventListener('click', () => {
  if (walletConnectLoading || swapConnectWalletBtn.disabled) return;
  walletConnectLoading = true;
  syncWalletFieldForMode();
  void ensureBrowserWalletConnected(swapWalletAddressInput?.value.trim() ?? '')
    .catch((err) => {
      if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      walletConnectLoading = false;
      syncWalletFieldForMode();
    });
});
swapDisconnectWalletBtn?.addEventListener('click', () => {
  void disconnectBrowserWallet();
});
swapWalletAddressInput?.addEventListener('input', () => onWalletAddressReady(false));
swapWalletAddressInput?.addEventListener('change', () => onWalletAddressReady(true));
syncSwapBuildModeUi();
syncSellTokenPickerState();
onWalletAddressReady(true);

if (swapQuoteBtn) swapQuoteBtn.addEventListener('click', () => void fetchSwapQuote());
if (swapBuildBtn) swapBuildBtn.addEventListener('click', () => void postBuildSwap());
if (swapCopyTxBtn && swapTxBase64El) {
  swapCopyTxBtn.addEventListener('click', async () => {
    const v = swapTxBase64El.value.trim();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
    } catch {
      swapTxBase64El.select();
      document.execCommand('copy');
    }
  });
}

initTokenPicker({
  onSelect: applySelectedToken,
  getWalletAddress: () => swapWalletAddressInput?.value.trim() ?? '',
  canOpenSellPicker: hasValidSwapWallet,
  canOpenBuyPicker: hasValidSwapWallet,
});
wireTokenPickerOpen(swapInputTokenBtn, swapInputMintInput, 'input');
wireTokenPickerOpen(swapOutputTokenBtn, swapOutputMintInput, 'output');

if (swapFlipBtnEl && swapInputMintInput && swapOutputMintInput) {
  swapFlipBtnEl.addEventListener('click', () => {
    if (!hasValidSwapWallet()) return;
    invalidateSwapQuoteAfterInputChange();
    const a = swapInputMintInput.value;
    const b = swapOutputMintInput.value;
    swapInputMintInput.value = b;
    swapOutputMintInput.value = a;
    const sa = swapInputSymbolEl?.textContent ?? '';
    const sb = swapOutputSymbolEl?.textContent ?? '';
    if (swapInputSymbolEl) swapInputSymbolEl.textContent = sb.trim() || '—';
    if (swapOutputSymbolEl) swapOutputSymbolEl.textContent = sa.trim() || '—';
    void syncSwapSideLabels();
    updateSwapTokenIcons();
    updateSwapPairCards();
    syncSwapAmountMaxFromBalance();
    const newSellMint = swapInputMintInput.value.trim();
    if (newSellMint && hasValidSwapWallet()) {
      applySellAmountPercent(getMaxSellPercentForMint(newSellMint));
    }
    void prefetchSwapPairPrices({ forceFullDetails: true, mints: [newSellMint] });
  });
}

if (swapPasteOutputBtnEl && swapOutputMintInput) {
  swapPasteOutputBtnEl.addEventListener('click', async () => {
    if (!hasValidSwapWallet()) return;
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) return;
      invalidateSwapQuoteAfterInputChange();
      swapOutputMintInput.value = t;
      void ensureTokenMetaForMint(t).then(() => {
        updateSwapTokenIcons();
        void refreshSwapSymbols();
        updateSwapPairCards();
        void prefetchSwapPairPrices({ forceFullDetails: true });
      });
    } catch {
      if (swapQuoteError) showInlineError(swapQuoteError, 'Could not read clipboard (permission denied).');
    }
  });
}

const swapSellPctBtnsEl = document.getElementById('swapSellPctBtns');
if (swapSellPctBtnsEl) {
  swapSellPctBtnsEl.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('.swap-sell-pct-btn');
    if (!btn || btn.disabled) return;
    const pct = Number(btn.dataset.sellPct);
    if (!Number.isFinite(pct) || pct <= 0) return;
    applySellAmountPercent(pct);
  });
}

if (swapRouteBtnEl && swapQuoteDetailsRoutingEl) {
  swapRouteBtnEl.addEventListener('click', () => {
    if (swapRouteBtnEl.disabled || !lastSwapQuoteOk) return;
    swapQuoteDetailsRoutingEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

routingDialogEl?.addEventListener('close', () => {
  if (swapPairCardsEl) {
    swapPairCardsEl.hidden = false;
    swapPairCardsEl.setAttribute('aria-hidden', 'false');
  }
});

routingDialogCloseEl?.addEventListener('click', () => routingDialogEl?.close());

swapSignConfirmProceedEl?.addEventListener('click', () => finishSignConfirm(true));
swapSignConfirmCancelEl?.addEventListener('click', () => finishSignConfirm(false));
swapSignConfirmCloseEl?.addEventListener('click', () => finishSignConfirm(false));
swapSignConfirmDialogEl?.addEventListener('cancel', (event) => {
  event.preventDefault();
  finishSignConfirm(false);
});

swapGaslessCheckbox?.addEventListener('change', () => {
  invalidateSwapQuoteAfterInputChange();
  void refreshLowSolTradeWarning();
});
swapAutoSlippageCheckbox?.addEventListener('change', () => {
  syncSlippageInputForAutoSlippage();
  invalidateSwapQuoteAfterInputChange();
});
swapSlippageInput?.addEventListener('input', invalidateSwapQuoteAfterInputChange);
swapSlippageInput?.addEventListener('change', invalidateSwapQuoteAfterInputChange);
swapSimulateCheckbox?.addEventListener('change', invalidateSwapQuoteAfterInputChange);
syncSlippageInputForAutoSlippage();

if (swapInputMintInput) {
  swapInputMintInput.addEventListener('input', () => {
    invalidateSwapQuoteAfterInputChange();
    updateSwapPairCards();
    void refreshSwapSymbols();
    void refreshLowSolTradeWarning();
    syncSwapAmountMaxFromBalance();
    void prefetchSwapPairPrices({ forceFullDetails: true });
  });
}
if (swapOutputMintInput) {
  swapOutputMintInput.addEventListener('input', () => {
    invalidateSwapQuoteAfterInputChange();
    updateSwapPairCards();
    void refreshSwapSymbols();
    void refreshLowSolTradeWarning();
    void prefetchSwapPairPrices({ forceFullDetails: true });
  });
}

swapAmountInput?.addEventListener('input', () => {
  invalidateSwapQuoteAfterInputChange();
  clampSwapAmountInputToMax();
  syncSwapSellAmountUi();
});
swapAmountInput?.addEventListener('change', () => {
  invalidateSwapQuoteAfterInputChange();
  clampSwapAmountInputToMax();
  syncSwapSellAmountUi();
});

void ensureTokenCatalogLoaded().then(() => updateSwapTokenIcons());
void refreshSwapSymbols();
updateSwapPairCards();
syncSellPctButtonsState();
bindRoutingDiagramZoomListeners();
scheduleRoutingDiagramZoom();
resetSwapQuoteDetailsPanel();
const initialSellMint = swapInputMintInput?.value.trim() ?? '';
if (initialSellMint) {
  void prefetchSwapPairPrices({ forceFullDetails: true, mints: [initialSellMint] });
}
