/**
 * Swap quote & build UI — built from TypeScript; compiles to public/app.js.
 */

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

interface VybeRoutePlanStepLite {
  percent?: number;
  bps?: number | null;
  swapInfo?: VybeSwapInfoLite;
}

const MAX_FETCH_RETRIES = 5;
const FETCH_RETRY_DELAY_MS = 2000;
const VYBE_BUILD_REUSE_MS = 5000;

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
const swapConnectWalletBtn = document.getElementById('swapConnectWalletBtn') as HTMLButtonElement | null;
const swapBuildResultTitleEl = document.getElementById('swapBuildResultTitle') as HTMLElement | null;
const swapBuildResultMetaEl = document.getElementById('swapBuildResultMeta') as HTMLElement | null;
const swapAdvancedBuildHintEl = document.getElementById('swapAdvancedBuildHint') as HTMLElement | null;

interface SolanaWalletProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect?: () => Promise<{ publicKey: { toString(): string } }>;
  signTransaction?: (tx: unknown) => Promise<{ serialize(): Uint8Array }>;
}

interface SolanaWeb3Global {
  VersionedTransaction: { deserialize(bytes: Uint8Array): unknown };
  Transaction: { from(bytes: Uint8Array): unknown };
  PublicKey?: new (value: string) => { toBase58(): string };
}

type WindowWithSolana = Window & {
  solana?: SolanaWalletProvider;
  phantom?: { solana?: SolanaWalletProvider };
  solanaWeb3?: SolanaWeb3Global;
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
let lastVybeBuild: { transaction: string; builtAt: number; paramsKey: string; buildPayload: unknown } | null =
  null;
const quotedMintSession = new Set<string>();
let pairTokenStats: Record<string, TokenPriceStats> = {};

type SwapBuildMode = 'build' | 'build-sign';
let swapBuildMode: SwapBuildMode = 'build-sign';

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
}

function updateSwapTokenIcons(): void {
  renderChipTokenIcon(swapInputTokenIconEl, swapInputMintInput?.value, endpointTokenDotClass(getSwapInSym()));
  renderChipTokenIcon(swapOutputTokenIconEl, swapOutputMintInput?.value, endpointTokenDotClass(getSwapOutSym()));
  updateSwapPairCards();
}

function formatSwapFiatDisplay(v: unknown): string {
  if (v == null || v === '') return '~$0.00';
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return '~$0.00';
  return `~$${n.toFixed(2)}`;
}

const SOLANA_WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidSolanaWalletAddress(value: string): boolean {
  const addr = value.trim();
  if (!addr || !SOLANA_WALLET_RE.test(addr)) return false;
  try {
    const PublicKey = getSolanaWindow().solanaWeb3?.PublicKey;
    if (PublicKey) {
      const pk = new PublicKey(addr);
      return pk.toBase58() === addr;
    }
  } catch {
    return false;
  }
  return true;
}

function hasValidSwapWallet(): boolean {
  return isValidSolanaWalletAddress(swapWalletAddressInput?.value.trim() ?? '');
}

function syncSellTokenPickerState(): void {
  const valid = hasValidSwapWallet();
  if (swapInputTokenBtn) {
    swapInputTokenBtn.classList.toggle('swap-token-chip--locked', !valid);
    swapInputTokenBtn.setAttribute('aria-disabled', valid ? 'false' : 'true');
    swapInputTokenBtn.tabIndex = valid ? 0 : -1;
    swapInputTokenBtn.title = valid ? '' : 'Enter or connect a valid Solana wallet to choose a sell token';
  }
  syncSellPctButtonsState();
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

  let amount = percent >= 100 ? sellable : total * (percent / 100);
  if (amount > sellable) amount = sellable;
  if (amount <= 0) return;

  if (swapQuoteError) clearInlineError(swapQuoteError);
  setSwapSellAmountToBalance(amount, mint);
}

function formatSwapInputAmountValue(amount: number, decimals = 9): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  const maxFrac = Math.min(Math.max(decimals, 0), 9);
  const s = amount.toFixed(maxFrac).replace(/\.?0+$/, '');
  return s || '0';
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
  } else {
    swapAmountInput.removeAttribute('max');
  }
  syncSellPctButtonsState();
}

function setSwapSellAmountToBalance(amountUi: number, mint: string): void {
  if (!swapAmountInput) return;
  const formatted = formatSwapInputAmountValue(amountUi, getMintDecimals(mint));
  swapAmountInput.value = formatted;
  swapAmountInput.max = formatted;
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
        void fetchSwapQuote();
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
  btn.addEventListener('click', () => openTokenPicker(side));
  mintInput.addEventListener('click', () => openTokenPicker(side));
}

function applySelectedToken(mint: string, side: TokenPickerSide): void {
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
  void fetchSwapQuote();
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

function formatSwapUsdLabel(v: unknown): string | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return null;
  return fmtUsd(n);
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
  if (needsSmallDecimalFormat(n)) {
    const fracStr = frac.toString().padStart(decimals, '0');
    return { display: formatFractionTail(fracStr), full };
  }
  if (!Number.isFinite(n)) return formatSwapAmount(raw);
  return formatSwapAmount(n);
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

/** Sub-unit amounts: all leading zeros, then up to 4 digits; trim only if 3+ trailing zeros in that group. */
function formatFractionTail(fracPadded: string): string {
  let i = 0;
  while (i < fracPadded.length && fracPadded[i] === '0') i++;
  if (i >= fracPadded.length) return '0';
  const leadingZeros = fracPadded.slice(0, i);
  const sigDigits = fracPadded.slice(i, i + 4);
  const trimmed = applySmallAmountTrailingZeroRule(sigDigits);
  return `0.${leadingZeros}${trimmed}`;
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
  if (needsSmallDecimalFormat(n)) {
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
  const raw = quote[rawKey];
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

function getSwapSellAmountLabel(): string {
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
): string {
  if (!stats?.price || !Number.isFinite(stats.price) || stats.price <= 0) {
    return '<div class="swap-pair-spot"><span class="swap-pair-spot-value swap-pair-spot-value--empty">—</span></div>';
  }
  const unit = pairCardUnitSymbol(mint, chipSymbol);
  const price = fmtUsd(stats.price);
  return `<div class="swap-pair-spot">
    <span class="swap-pair-spot-value">${escapeHtml(price)}</span>
    <span class="swap-pair-spot-unit">USD / 1 ${escapeHtml(unit)}</span>
  </div>`;
}

function renderPairCard(el: HTMLElement | null, mint: string, side: 'sell' | 'buy'): void {
  if (!el) return;
  if (!mint) {
    el.innerHTML = '<div class="swap-pair-empty">Select a token</div>';
    return;
  }
  const symbol = pairCardSymbol(mint, side);
  const displayName = swapSideTokenName(mint, symbol);
  const stats = pairTokenStats[mint];

  el.innerHTML = `<div class="swap-pair-card-head-left">
      <span class="swap-pair-icon">${renderPairCardIcon(mint, symbol)}</span>
      <div class="swap-pair-identity">
        <div class="swap-pair-name">${escapeHtml(displayName)}</div>
        <div class="swap-pair-mint">${escapeHtml(truncate(mint, 4, 4))}</div>
      </div>
    </div>
    <div class="swap-pair-changes">${renderPairCardChangesHtml(stats)}</div>
    ${renderPairCardSpotHtml(stats, mint, symbol)}`;
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

function renderSwapSideChangeHtml(stats?: TokenPriceStats): string {
  if (!stats?.price || stats.price <= 0 || !stats.price1d || stats.price1d <= 0) {
    return '<span class="swap-pair-chg swap-pair-chg--muted">—</span>';
  }
  const pct1d = ((stats.price - stats.price1d) / stats.price1d) * 100;
  const cls = pct1d >= 0 ? 'swap-pair-chg--up' : 'swap-pair-chg--down';
  return `<span class="swap-pair-chg ${cls}">24hr: ${formatPctChangeWithArrow(pct1d)}</span>`;
}

function renderPairCardChangesHtml(stats?: TokenPriceStats): string {
  if (!stats?.price || stats.price <= 0) {
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

function updateSwapSideChanges(): void {
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const sellEl = document.getElementById('swapSellChanges');
  const buyEl = document.getElementById('swapBuyChanges');
  if (sellEl) sellEl.innerHTML = renderSwapSideChangeHtml(inMint ? pairTokenStats[inMint] : undefined);
  if (buyEl) buyEl.innerHTML = renderSwapSideChangeHtml(outMint ? pairTokenStats[outMint] : undefined);
}

function updateSwapPairCards(stats?: Record<string, TokenPriceStats>): void {
  if (stats) pairTokenStats = { ...pairTokenStats, ...stats };
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  renderPairCard(swapCardSellEl, inMint, 'sell');
  renderPairCard(swapCardBuyEl, outMint, 'buy');
  updateSwapSideChanges();
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

function renderHopConversionLeg(leg: RouteHopLeg, className = 'route-hop-conversion'): string {
  return `<div class="${className}">
    <span class="route-hop-leg">
      <span class="route-hop-amt">${escapeHtml(leg.inAmt)}</span>
      <span class="route-hop-sym">${escapeHtml(leg.inSym)}</span>
    </span>
    <span class="route-hop-arrow" aria-hidden="true">→</span>
    <span class="route-hop-leg">
      <span class="route-hop-amt">${escapeHtml(leg.outAmt)}</span>
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

function renderJupiterEndpointPill(amt: string, sym: string, title?: string): string {
  const mint =
    sym === getSwapInSym()
      ? (swapInputMintInput?.value.trim() ?? '')
      : sym === getSwapOutSym()
        ? (swapOutputMintInput?.value.trim() ?? '')
        : '';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<div class="routing-pill routing-pill--endpoint"${titleAttr}>
    ${renderRoutingTokenIcon(mint, sym)}
    <span class="routing-amt">${escapeHtml(amt)}</span>
    <span class="routing-sym">${escapeHtml(sym)}</span>
  </div>`;
}

function renderJupiterPctLink(pct: string): string {
  return `<div class="routing-hop-link" aria-hidden="true">
    <span class="routing-hop-link-line"></span>
    <span class="routing-pct-badge">${escapeHtml(pct)}</span>
  </div>`;
}

function renderHopIndexBadge(label: string): string {
  return `<span class="routing-hop-index-badge">Hop #${escapeHtml(label)}</span>`;
}

function renderJupiterMarketNode(meta: RouteHopMeta, leg: RouteHopLeg): string {
  const si = meta.step.swapInfo;
  const dex = escapeHtml(si?.label ?? 'DEX');
  const sym = escapeHtml(leg.outSym);
  return `<div class="routing-market-node">
    ${renderHopIndexBadge(meta.label)}
    <div class="routing-pill routing-pill--hop">
      ${renderRoutingTokenIcon(leg.outMint, leg.outSym)}
      <span class="routing-token-sym">${sym}</span>
    </div>
    <div class="routing-dex-caption">${dex}</div>
  </div>`;
}

const ROUTING_CONNECTORS = `<div class="routing-connectors" aria-hidden="true">
  <div class="routing-corner routing-corner--in"></div>
  <div class="routing-corner routing-corner--out"></div>
</div>`;

function renderJupiterTrack(node: RouteNode, legs: RouteHopLeg[]): string {
  const metas: RouteHopMeta[] = [];
  collectRouteHopMetas(node, metas);
  if (metas.length === 0) return '';

  const inner = metas
    .map((meta) => {
      const leg = legs[meta.planIndex];
      if (!leg) return '';
      return renderJupiterPctLink(hopPercentLabel(meta.step)) + renderJupiterMarketNode(meta, leg);
    })
    .join('');

  return `<div class="routing-rail-row">${inner}<div class="routing-rail-tail" aria-hidden="true"></div></div>`;
}

function renderJupiterFork(node: Extract<RouteNode, { kind: 'fork' }>, legs: RouteHopLeg[]): string {
  const n = node.branches.length;
  const boardClass =
    n === 1 ? 'routing-split-board--1' : n === 2 ? 'routing-split-board--2' : 'routing-split-board--multi';
  const tracks = node.branches.map((b) => renderJupiterTrack(b, legs)).join('');
  return `<div class="routing-split-board ${boardClass}">${tracks}</div>`;
}

function renderJupiterRouteBody(node: RouteNode, legs: RouteHopLeg[]): string {
  if (node.kind === 'empty') return '';
  if (node.kind === 'fork') {
    return renderJupiterFork(node, legs);
  }
  if (node.kind === 'hop') {
    return renderJupiterTrack(node, legs);
  }
  const hasFork = node.nodes.some((n) => n.kind === 'fork');
  if (hasFork) {
    return node.nodes.map((n) => renderJupiterRouteBody(n, legs)).join('');
  }
  return renderJupiterTrack(node, legs);
}

function routingCanvasHopClass(hopCount: number): string {
  if (hopCount === 3) return ' routing-canvas--hops-3';
  if (hopCount > 3) return ' routing-canvas--hops-many';
  return '';
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
): string {
  const placeholderClass = placeholder ? ' routing-canvas--placeholder' : '';
  return `<div class="routing-canvas routing-canvas--flow${split ? ' routing-canvas--split' : ''}${routingCanvasHopClass(hopCount)}${placeholderClass}">
    <div class="routing-frame">
      <div class="routing-endpoint routing-endpoint--in">
        ${renderJupiterEndpointPill(inDisplay, inSym)}
      </div>
      <div class="routing-endpoint routing-endpoint--out">
        ${renderJupiterEndpointPill(outDisplay, outSym, outTitle)}
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
  const inDisplay = getSwapSellAmountLabel();
  const outAmt = formatQuoteTokenAmount(quote, 'out');

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
    );
  }

  const tree = buildRouteTree(plan);
  const split = routeTreeHasFork(tree);
  const body = renderJupiterRouteBody(tree, legs);

  return renderRoutingFrame(
    inDisplay,
    inSym,
    outAmt.display,
    outSym,
    outAmt.full || undefined,
    body,
    split,
    plan.length,
  );
}

function renderRoutingDiagramPlaceholder(): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const mockLeg: RouteHopLeg = {
    inMint,
    outMint,
    inSym,
    outSym,
    inAmt: '—',
    outAmt: '—',
  };
  const mockMeta: RouteHopMeta = {
    label: '1',
    planIndex: 0,
    step: { percent: 100, swapInfo: { label: '—' } },
  };
  const body =
    renderJupiterPctLink('100%') +
    renderJupiterMarketNode(mockMeta, mockLeg);
  const trackBody = `<div class="routing-rail-row">${body}<div class="routing-rail-tail" aria-hidden="true"></div></div>`;
  return renderRoutingFrame('—', inSym, '—', outSym, undefined, trackBody, false, 1, true);
}

function getSwapRouter(): string {
  return swapRouterInput?.value.trim() || 'vybe';
}

function setSwapRouter(router: string): void {
  const normalized = normalizeRouterId(router);
  if (swapRouterInput) swapRouterInput.value = normalized;
  for (const btn of swapRouterSwitchEl?.querySelectorAll<HTMLButtonElement>('[data-router]') ?? []) {
    const active = btn.dataset.router === normalized;
    btn.classList.toggle('swap-mode-switch__btn--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
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

function renderRoutePanels(quote: Record<string, unknown>): void {
  updateRouteDiagramTitle(quote);
  if (swapQuoteDetailsRoutingEl) swapQuoteDetailsRoutingEl.innerHTML = renderRoutingDiagram(quote);
  if (swapQuoteDetailsRouteStepsEl) swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanSteps(quote);
  syncRoutePlanStepsUi();
  if (routingDialogBodyEl) routingDialogBodyEl.innerHTML = renderRoutingDiagram(quote);
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

function renderQuoteSummaryHeroTile(
  label: string,
  amt: string,
  sym: string,
  variant: 'pay' | 'receive',
  sub?: string | null,
  placeholder = false,
): string {
  const amtCls = placeholder ? ' swap-quote-summary-amt--placeholder' : '';
  const subCls = placeholder ? ' swap-quote-summary-sub--placeholder' : '';
  return `<div class="swap-quote-summary-tile swap-quote-summary-tile--hero swap-quote-summary-tile--${variant}">
      <span class="swap-quote-summary-label">${escapeHtml(label)}</span>
      <span class="swap-quote-summary-value">
        <span class="swap-quote-summary-amt${amtCls}">${escapeHtml(amt)}</span>
        <span class="swap-quote-summary-sym">${escapeHtml(sym)}</span>
      </span>
      ${sub ? `<span class="swap-quote-summary-sub${subCls}">${escapeHtml(sub)}</span>` : ''}
    </div>`;
}

function renderQuoteSummaryPlaceholder(): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  return `<div class="swap-quote-summary-primary" data-quote-placeholder="true">
      ${renderQuoteSummaryHeroTile('You pay', '—', inSym, 'pay', '≈ —', true)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', '—', outSym, 'receive', '≈ —', true)}
    </div>`;
}

function renderQuoteSummary(quote: Record<string, unknown>): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const payAmt = getSwapSellAmountLabel();
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  const usd = formatSwapUsdLabel(quote.swapUsdValue);

  return `<div class="swap-quote-summary-primary">
      ${renderQuoteSummaryHeroTile('You pay', payAmt, inSym, 'pay', usd ? `≈ ${usd}` : null)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', outAmt.display, outSym, 'receive', usd ? `≈ ${usd}` : null)}
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

function renderRoutePlanStepDetail(
  step: VybeRoutePlanStepLite,
  hopLabel: string,
  leg: RouteHopLeg,
  expanded = false,
  placeholder = false,
): string {
  const si = step.swapInfo;
  const dex = si?.label ?? 'Unknown DEX';
  const pct = hopPercentLabel(step);
  const preview = `${leg.inAmt} ${leg.inSym} → ${leg.outAmt} ${leg.outSym} · ${pct}`;
  const feeSym = si?.feeMintAddress ? mintSymbolSync(si.feeMintAddress) : '—';
  const feeMint = (si?.feeMintAddress ?? '').trim();
  const feeAmt =
    si?.feeAmount && si.feeAmount !== '0'
      ? formatRawTokenAmount(si.feeAmount, feeMint || leg.inMint).display
      : null;

  const detailRow = (label: string, value: string, full?: string) =>
    `<div class="swap-hop-detail-row">
      <span class="swap-hop-detail-k">${escapeHtml(label)}</span>
      <span class="swap-hop-detail-v"${full ? ` title="${escapeHtml(full)}"` : ''}><code>${escapeHtml(value)}</code></span>
    </div>`;

  const rows: string[] = [
    detailRow('Route share', pct),
    detailRow('Venue', dex),
    detailRow('Input', `${leg.inAmt} ${leg.inSym}`),
    detailRow('Output', `${leg.outAmt} ${leg.outSym}`),
  ];
  if (step.bps != null && Number.isFinite(Number(step.bps))) {
    rows.push(detailRow('BPS', String(step.bps)));
  }
  if (si?.ammKey) rows.push(detailRow('Market (AMM)', truncate(si.ammKey, 8, 8), si.ammKey));
  if (leg.inMint) rows.push(detailRow('Input mint', truncate(leg.inMint, 8, 8), leg.inMint));
  if (leg.outMint) rows.push(detailRow('Output mint', truncate(leg.outMint, 8, 8), leg.outMint));
  if (si?.inAmount) {
    const inFmt = formatRawTokenAmount(si.inAmount, leg.inMint);
    rows.push(detailRow('In amount', `${inFmt.display} (${String(si.inAmount)} raw)`, inFmt.full || String(si.inAmount)));
  }
  if (si?.outAmount) {
    const outFmt = formatRawTokenAmount(si.outAmount, leg.outMint);
    rows.push(detailRow('Out amount', `${outFmt.display} (${String(si.outAmount)} raw)`, outFmt.full || String(si.outAmount)));
  }
  if (feeAmt) rows.push(detailRow('Fee', `${feeAmt} ${feeSym}`));

  const placeholderClass = placeholder ? ' swap-hop-step-details--placeholder' : '';
  return `<details class="swap-hop-step-details${placeholderClass}"${expanded ? ' open' : ''}>
    <summary class="swap-hop-step-details__summary">
      <span class="swap-hop-card__index">Hop #${escapeHtml(hopLabel)}</span>
      <span class="swap-hop-step-details__main">
        <span class="swap-hop-card__dex">${escapeHtml(dex)}</span>
        <span class="swap-hop-step-details__preview">${escapeHtml(preview)}</span>
      </span>
      <span class="swap-hop-card__pct">${escapeHtml(pct)}</span>
    </summary>
    <div class="swap-hop-step-details__body">
      ${renderHopConversionLeg(leg, 'route-hop-conversion route-hop-conversion--card')}
      <div class="swap-hop-detail-grid">${rows.join('')}</div>
    </div>
  </details>`;
}

function renderQuoteRoutePlanStepsPlaceholder(): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  const mockLeg: RouteHopLeg = {
    inMint,
    outMint,
    inSym,
    outSym,
    inAmt: '—',
    outAmt: '—',
  };
  const mockStep: VybeRoutePlanStepLite = {
    percent: 100,
    swapInfo: { label: '—' },
  };
  return renderRoutePlanStepDetail(mockStep, '1', mockLeg, true, true);
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
      .map((s, i) => renderRoutePlanStepDetail(s, String(i + 1), legs[i]!, i === 0))
      .join('');
  }
  return metas
    .map((meta, i) =>
      renderRoutePlanStepDetail(meta.step, meta.label, legs[meta.planIndex]!, i === 0),
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
  ensureRoutePlanStepsExpanded();
  ensureFirstHopExpanded();
}

function resetSwapQuoteDetailsPanel(): void {
  if (swapQuoteDetailsEmptyEl) swapQuoteDetailsEmptyEl.hidden = true;
  if (swapQuoteDetailsBodyEl) swapQuoteDetailsBodyEl.hidden = false;
  if (swapQuoteSummaryEl) {
    swapQuoteSummaryEl.innerHTML = renderQuoteSummaryPlaceholder();
    swapQuoteSummaryEl.hidden = false;
  }
  if (swapQuoteDetailsRoutingEl) {
    swapQuoteDetailsRoutingEl.innerHTML = renderRoutingDiagramPlaceholder();
  }
  if (swapQuoteDetailsRouteStepsEl) {
    swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanStepsPlaceholder();
  }
  syncRoutePlanStepsUi();
  if (swapQuoteDetailsFieldsEl) {
    swapQuoteDetailsFieldsEl.innerHTML = '<p class="routing-empty">—</p>';
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
  } catch {
    // Prefetch is best-effort; pair cards keep last known stats or em dashes.
  }
}

function clearSwapQuotePanel(): void {
  lastSwapQuoteOk = null;
  lastRawQuoteResponse = null;
  for (const k of Object.keys(routeMintSymbolCache)) delete routeMintSymbolCache[k];
  for (const k of Object.keys(routeMintDecimalsCache)) delete routeMintDecimalsCache[k];
  if (swapBuildBtn) swapBuildBtn.disabled = true;
  if (swapBuyAmountDisplayEl) {
    swapBuyAmountDisplayEl.textContent = '0.00';
    swapBuyAmountDisplayEl.dataset.empty = 'true';
  }
  if (swapSellFiatEl) swapSellFiatEl.textContent = '~$0.00';
  if (swapBuyFiatEl) swapBuyFiatEl.textContent = '~$0.00';
  if (swapFooterRateEl) swapFooterRateEl.textContent = '—';
  if (swapFooterImpactEl) swapFooterImpactEl.textContent = '—';
  if (swapFooterMinOutEl) swapFooterMinOutEl.textContent = '—';
  if (swapFooterMaxSlippageEl) swapFooterMaxSlippageEl.textContent = '—';
  setRouteChipLabel('—', true);
  if (routingDialogBodyEl) routingDialogBodyEl.innerHTML = '';
  resetSwapQuoteDetailsPanel();
  if (swapPairCardsEl) {
    swapPairCardsEl.hidden = false;
    swapPairCardsEl.removeAttribute('aria-hidden');
  }
  if (swapBuildResultEl) swapBuildResultEl.hidden = true;
  if (swapTxBase64El) swapTxBase64El.value = '';
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

  const usdLabel = formatSwapFiatDisplay(quote.swapUsdValue);
  if (swapSellFiatEl) swapSellFiatEl.textContent = usdLabel;
  if (swapBuyFiatEl) swapBuyFiatEl.textContent = usdLabel;

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

async function enrichRouteLabels(quote: Record<string, unknown>): Promise<void> {
  try {
    await prefetchRouteMintSymbols(quote);
    await prefetchRouteTokenMetas(quote);
    renderRoutePanels(quote);
    updateSwapTokenIcons();
    updateSwapPairCards();
  } catch {
    /* keep initial render on symbol fetch failure */
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
        : undefined,
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

async function fetchSwapQuote(): Promise<void> {
  if (!swapInputMintInput || !swapOutputMintInput || !swapAmountInput) return;
  const inputMint = swapInputMintInput.value.trim();
  const outputMint = swapOutputMintInput.value.trim();
  const amount = Number(swapAmountInput.value);
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const slippage = swapSlippageInput ? Number(swapSlippageInput.value) : NaN;

  if (!inputMint || !outputMint) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Input and output mint required for quote.');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Amount must be a positive number.');
    return;
  }

  lastSwapQuoteOk = null;
  lastVybeBuild = null;
  if (swapBuildBtn) swapBuildBtn.disabled = true;
  resetSwapQuoteDetailsPanel();
  if (swapQuoteError) clearInlineError(swapQuoteError);
  if (swapQuoteWarning) clearInlineWarning(swapQuoteWarning);
  if (swapQuoteLoading) {
    swapQuoteLoading.hidden = false;
    swapQuoteLoading.setAttribute('aria-hidden', 'false');
  }

  const params = new URLSearchParams();
  params.set('amount', String(amount));
  params.set('inputMintAddress', inputMint);
  params.set('outputMintAddress', outputMint);
  if (wallet) params.set('accountAddress', wallet);
  if (Number.isFinite(slippage)) params.set('slippage', String(slippage));

  const router = getSwapRouter();
  const buildOpts = collectSwapBuildOptions();
  const forceFullDetailsMints = [inputMint, outputMint].filter((m) => !quotedMintSession.has(m));

  try {
    if (router === 'vybe') {
      if (!wallet) {
        if (swapQuoteError) {
          showInlineError(
            swapQuoteError,
            'Wallet required for Vybe quotes (used to build the swap transaction).',
          );
        }
        return;
      }
      try {
        await assertVybeSellBalance(wallet, inputMint, amount, getSwapInSym());
      } catch (balanceErr) {
        if (swapQuoteError) {
          showInlineError(
            swapQuoteError,
            balanceErr instanceof Error ? balanceErr.message : String(balanceErr),
          );
        }
        return;
      }
      void refreshLowSolTradeWarning();
    } else {
      void refreshLowSolTradeWarning();
    }

    let stats: Record<string, TokenPriceStats> = {};
    try {
      stats = await resolvePairTokenPrices(inputMint, outputMint, forceFullDetailsMints);
      updateSwapPairCards(stats);
    } catch (priceErr) {
      if (swapQuoteError) {
        showInlineError(
          swapQuoteError,
          priceErr instanceof Error ? priceErr.message : String(priceErr),
        );
      }
      return;
    }

    if (router === 'vybe') {
      const res = await fetchWithRetry('/api/trading/vybe-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountAddress: wallet,
          amount,
          inputMintAddress: inputMint,
          outputMintAddress: outputMint,
          ...buildOpts,
          router: 'vybe',
          tokenHints: buildTokenHintsForMints([inputMint, outputMint]),
          forceFullDetailsMints,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: string;
        _build?: { transaction?: string };
        _builtAt?: number;
        _tokenStats?: Record<string, TokenPriceStats>;
      };
      if (!res.ok) {
        if (swapQuoteError) showInlineError(swapQuoteError, body.error || `Quote failed (${res.status})`);
        return;
      }

      if (body._tokenStats) {
        for (const [mint, s] of Object.entries(body._tokenStats)) {
          saveTokenPriceStats(mint, s);
        }
        updateSwapPairCards(body._tokenStats);
      }

      quotedMintSession.add(inputMint);
      quotedMintSession.add(outputMint);

      const quote = annotateQuoteRouterMeta(stripVybeQuoteMetadata(body), router);
      lastSwapQuoteOk = quote;
      lastRawQuoteResponse = body;
      if (typeof body._build?.transaction === 'string' && typeof body._builtAt === 'number') {
        lastRawSwapResponse = body._build;
        lastVybeBuild = {
          transaction: body._build.transaction,
          builtAt: body._builtAt,
          paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, amount, buildOpts),
          buildPayload: body._build,
        };
        renderRawResponsePanels();
      }
      renderSwapQuoteUI(quote);
      void enrichRouteLabels(quote);
      if (swapBuildBtn) swapBuildBtn.disabled = false;
      return;
    }

    const res = await fetchWithRetry(`/api/trading/swap-quote?${params.toString()}`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) {
      if (swapQuoteError) showInlineError(swapQuoteError, body.error || `Quote failed (${res.status})`);
      return;
    }
    lastSwapQuoteOk = annotateQuoteRouterMeta(body, router);
    lastRawQuoteResponse = body;
    quotedMintSession.add(inputMint);
    quotedMintSession.add(outputMint);
    renderSwapQuoteUI(body);
    void enrichRouteLabels(body);
    if (swapBuildBtn) swapBuildBtn.disabled = false;
  } catch (err) {
    if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
  } finally {
    if (swapQuoteLoading) {
      swapQuoteLoading.hidden = true;
      swapQuoteLoading.setAttribute('aria-hidden', 'true');
    }
  }
}

async function postBuildSwap(): Promise<void> {
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
  } else if (!wallet) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Wallet (accountAddress) is required to build the transaction.');
    return;
  }
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = swapAmountInput ? Number(swapAmountInput.value) : NaN;
  const buildOpts = collectSwapBuildOptions();
  const router = (buildOpts.router as string | undefined) ?? 'vybe';

  if (!swapBuildResultEl || !swapTxBase64El) return;
  if (swapQuoteError) clearInlineError(swapQuoteError);
  void refreshLowSolTradeWarning();
  if (swapBuildBtn) swapBuildBtn.disabled = true;

  const paramsKey = vybeBuildParamsKey(wallet, inputMint, outputMint, amount, buildOpts);
  if (
    router === 'vybe' &&
    lastVybeBuild &&
    Date.now() - lastVybeBuild.builtAt < VYBE_BUILD_REUSE_MS &&
    lastVybeBuild.paramsKey === paramsKey
  ) {
    try {
      lastRawSwapResponse = lastVybeBuild.buildPayload;
      renderRawResponsePanels();
      if (swapBuildMode === 'build-sign') {
        try {
          swapTxBase64El.value = await signSwapTransactionBase64(lastVybeBuild.transaction);
        } catch (err) {
          if (swapQuoteError) {
            showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
          }
          return;
        }
      } else {
        swapTxBase64El.value = lastVybeBuild.transaction;
      }
      swapBuildResultEl.hidden = false;
    } finally {
      if (swapBuildBtn) swapBuildBtn.disabled = false;
    }
    return;
  }

  try {
    const res = await fetchWithRetry('/api/trading/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountAddress: wallet,
        amount,
        inputMintAddress: inputMint,
        outputMintAddress: outputMint,
        ...buildOpts,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      transaction?: string;
      error?: string;
    };
    if (!res.ok) {
      if (swapQuoteError) showInlineError(swapQuoteError, body.error || `Build failed (${res.status})`);
      return;
    }
    lastRawSwapResponse = body;
    if (router === 'vybe' && typeof body.transaction === 'string') {
      lastVybeBuild = {
        transaction: body.transaction,
        builtAt: Date.now(),
        paramsKey,
        buildPayload: body,
      };
    }
    renderRawResponsePanels();
    if (typeof body.transaction === 'string') {
      if (swapBuildMode === 'build-sign') {
        try {
          swapTxBase64El.value = await signSwapTransactionBase64(body.transaction);
        } catch (err) {
          if (swapQuoteError) {
            showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
          }
          return;
        }
      } else {
        swapTxBase64El.value = body.transaction;
      }
      swapBuildResultEl.hidden = false;
    }
  } catch (err) {
    if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
  } finally {
    if (swapBuildBtn) swapBuildBtn.disabled = false;
  }
}

function getSolanaWalletProvider(): SolanaWalletProvider | null {
  const w = getSolanaWindow();
  if (w.solana?.signTransaction || w.solana?.connect) return w.solana;
  if (w.phantom?.solana) return w.phantom.solana;
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

async function signSwapTransactionBase64(base64: string): Promise<string> {
  const provider = getSolanaWalletProvider();
  if (!provider?.signTransaction) {
    throw new Error('Connected wallet cannot sign transactions.');
  }
  const web3 = getSolanaWindow().solanaWeb3;
  if (!web3) {
    throw new Error('Signing library is still loading. Wait a moment and try again.');
  }
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  let tx: unknown;
  try {
    tx = web3.VersionedTransaction.deserialize(bytes);
  } catch {
    tx = web3.Transaction.from(bytes);
  }
  const signed = await provider.signTransaction(tx);
  return bytesToBase64(signed.serialize());
}

function syncWalletFieldForMode(): void {
  const isSignMode = swapBuildMode === 'build-sign';
  const hasWallet = Boolean(swapWalletAddressInput?.value.trim());
  if (swapWalletAddressInput) {
    swapWalletAddressInput.hidden = isSignMode && !hasWallet;
    swapWalletAddressInput.readOnly = isSignMode && hasWallet;
    if (!isSignMode) swapWalletAddressInput.readOnly = false;
  }
  if (swapConnectWalletBtn) {
    swapConnectWalletBtn.hidden = !isSignMode || hasWallet;
  }
}

function syncSwapBuildModeUi(): void {
  const isSignMode = swapBuildMode === 'build-sign';
  swapModeBuildBtn?.classList.toggle('swap-mode-switch__btn--active', !isSignMode);
  swapModeBuildSignBtn?.classList.toggle('swap-mode-switch__btn--active', isSignMode);
  swapModeBuildBtn?.setAttribute('aria-selected', isSignMode ? 'false' : 'true');
  swapModeBuildSignBtn?.setAttribute('aria-selected', isSignMode ? 'true' : 'false');
  syncWalletFieldForMode();
  const buildLabelEl = swapBuildBtn?.querySelector('.swap-action-btn__label');
  const buildHintEl = swapBuildBtn?.querySelector('.swap-action-btn__hint');
  if (buildLabelEl) {
    buildLabelEl.textContent = isSignMode ? 'Build & sign swap' : 'Build swap (no signing)';
  }
  if (buildHintEl) {
    buildHintEl.textContent = isSignMode ? 'Connect wallet & sign' : 'Requires quote & wallet';
  }
  if (swapBuildResultTitleEl) {
    swapBuildResultTitleEl.textContent = isSignMode
      ? 'Signed transaction (base64)'
      : 'Unsigned transaction (base64)';
  }
  if (swapBuildResultMetaEl) {
    swapBuildResultMetaEl.textContent = isSignMode
      ? 'Signed in your browser wallet. This app does not broadcast.'
      : 'Sign in your wallet. This app does not broadcast.';
  }
  if (swapAdvancedBuildHintEl) {
    swapAdvancedBuildHintEl.innerHTML = isSignMode
      ? 'Used only when you click <strong>Build &amp; sign swap</strong>. Quote uses wallet, slippage, and mints.'
      : 'Used only when you click <strong>Build swap (no signing)</strong>. Quote uses wallet, slippage, and mints.';
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
  valueEl: HTMLInputElement | HTMLSelectElement | null
): void {
  if (!enableEl || !fieldEl) return;
  const sync = (): void => {
    const on = enableEl.checked;
    fieldEl.hidden = !on;
    if (!on && valueEl) {
      if (valueEl instanceof HTMLSelectElement) valueEl.selectedIndex = 0;
      else valueEl.value = '';
    }
  };
  enableEl.addEventListener('change', sync);
  sync();
}

wireBuildOptionToggle(swapEnablePartnerCheckbox, swapPartnerFieldEl, swapPartnerInput);
wireBuildOptionToggle(swapEnablePoolAddressCheckbox, swapPoolAddressFieldEl, swapPoolAddressInput);
wireBuildOptionToggle(swapEnableProtocolCheckbox, swapProtocolFieldEl, swapProtocolSelect);
wireBuildOptionToggle(swapEnableServiceFeeCheckbox, swapServiceFeeFieldEl, swapServiceFeeInput);

swapModeBuildBtn?.addEventListener('click', () => setSwapBuildMode('build'));
swapModeBuildSignBtn?.addEventListener('click', () => setSwapBuildMode('build-sign'));
swapRouterSwitchEl?.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-router]');
  if (!btn?.dataset.router) return;
  setSwapRouter(btn.dataset.router);
});
swapConnectWalletBtn?.addEventListener('click', () => {
  void ensureBrowserWalletConnected(swapWalletAddressInput?.value.trim() ?? '').catch((err) => {
    if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
  });
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
});
wireTokenPickerOpen(swapInputTokenBtn, swapInputMintInput, 'input');
wireTokenPickerOpen(swapOutputTokenBtn, swapOutputMintInput, 'output');

if (swapFlipBtnEl && swapInputMintInput && swapOutputMintInput) {
  swapFlipBtnEl.addEventListener('click', () => {
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
    void fetchSwapQuote();
  });
}

if (swapPasteOutputBtnEl && swapOutputMintInput) {
  swapPasteOutputBtnEl.addEventListener('click', async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) return;
      swapOutputMintInput.value = t;
      void ensureTokenMetaForMint(t).then(() => {
        updateSwapTokenIcons();
        void refreshSwapSymbols();
        void fetchSwapQuote();
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

swapGaslessCheckbox?.addEventListener('change', () => {
  void refreshLowSolTradeWarning();
});

if (swapInputMintInput) {
  swapInputMintInput.addEventListener('input', () => {
    updateSwapPairCards();
    void refreshSwapSymbols();
    void refreshLowSolTradeWarning();
    if (!lastSwapQuoteOk) resetSwapQuoteDetailsPanel();
    void prefetchSwapPairPrices({ forceFullDetails: true });
  });
}
if (swapOutputMintInput) {
  swapOutputMintInput.addEventListener('input', () => {
    updateSwapPairCards();
    void refreshSwapSymbols();
    void refreshLowSolTradeWarning();
    if (!lastSwapQuoteOk) resetSwapQuoteDetailsPanel();
    void prefetchSwapPairPrices({ forceFullDetails: true });
  });
}

void ensureTokenCatalogLoaded().then(() => updateSwapTokenIcons());
void refreshSwapSymbols();
updateSwapPairCards();
resetSwapQuoteDetailsPanel();
const initialSellMint = swapInputMintInput?.value.trim() ?? '';
if (initialSellMint) {
  void prefetchSwapPairPrices({ forceFullDetails: true, mints: [initialSellMint] });
}
