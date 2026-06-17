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
  buildSwapAtaHintsFromWalletCache,
  isWalletBalanceCacheReady,
  getWalletBalanceAmountUi,
  getWalletBalanceListItem,
  getWalletTotalBalanceUsd,
  formatWalletTotalUsd,
  isSplValueTradable,
  isWalletTokenTradable,
  noteSplMaxSellFraction,
  swapSimulationFailed,
  shouldApplySellAmountFromQuoteInAmount,
  computeSplSellAmountForRetryStep,
  shouldContinueSplSellSimRetry,
  SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER,
  isSolMint,
  isNearMaxSellAmountUi,
  isAtMaxSellAmountUi,
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
  effectiveTokenIconSrc,
  renderTokenIconImgHtml,
  tokenBoxColorClass,
  tokenSymColorClass,
  routingTokenDotClass,
  saveTokenPriceStats,
  saveWalletBalanceItemsToCache,
  type TokenPickerSide,
  type TokenPriceStats,
  type WalletBalanceListItem,
} from './token-picker.js';
import {
  initRouteUi,
  clearRouteMintCaches,
  routeMintSymbolCache,
  routeMintDecimalsCache,
  type VybeRoutePlanStepLite,
  quoteInputMint,
  quoteOutputMint,
  quoteInAmountRaw,
  quoteInAmountUi,
  quoteWalletPayRaw,
  quoteWalletPayUi,
  parseRawAmountDigits,
  parsePositiveBigInt,
  getQuoteOutputMint,
  quoteUiAmount,
  swapInfoInputMint,
  swapInfoOutputMint,
  formatQuoteTokenAmount,
  formatQuoteRawAmountLabel,
  getQuoteWalletPayLabelFromQuote,
  getQuoteSwapLegLabelFromQuote,
  sumInputSideWalletFeesInSellMintUi,
  estimateInputSideWalletPayDebitFromQuote,
  lookupMintPriceUsd,
  attachQuoteTokenPriceMeta,
  pairCardEffectiveStats,
  collectRoutePriceMints,
  formatRouteChipLabel,
  renderRoutingDiagram,
  renderRoutingDiagramPlaceholder,
  renderQuoteRoutePlanStepsPlaceholder,
  renderRoutePanels,
  renderRouteOptionsPanel,
  bindRoutingDiagramZoomListeners,
  scheduleRoutingDiagramZoom,
  normalizeRouterId,
  routerDisplayLabel,
  getQuoteWalletCostBucketsUsd,
  getQuoteYouPaySubLabel,
  renderQuotePayHeroValueHtml,
  renderQuoteReceiveHeroValueHtml,
  getQuoteYouReceiveSubLabel,
  renderRouteViaTradesLogHtml,
  type EnumeratedRoutesUiState,
} from './route-ui.js';

interface TokenSymbolResponse {
  symbol?: string;
  decimals?: number;
  error?: string;
}


const MAX_FETCH_RETRIES = 5;
const FETCH_RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 90_000;
const VYBE_QUOTE_TX_REUSE_MS = 45_000;
/** Default service fee % on build for Vybe, Jupiter, and Titan (0 = none). */
const DEFAULT_SWAP_SERVICE_FEE_PCT = 0;

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

/** Default slippage tolerance percent (matches #swapSlippage input). */
const DEFAULT_SWAP_SLIPPAGE_PCT = 2;

/** Prefer SOL, then USDC, then USDT when auto-picking sell token from wallet balances. */
const SELL_TOKEN_PRIORITY_MINTS: readonly string[] = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
];

let walletBalanceFetchGen = 0;
let walletBalanceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let walletBalancesFetching = false;
let walletBalancesReadyFor = '';
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
const swapMarketFetchModeSelect = document.getElementById('swapMarketFetchMode') as HTMLSelectElement | null;
const swapEnumerateRoutesCheckbox = document.getElementById('swapEnumerateRoutes') as HTMLInputElement | null;
const swapRouteOptionsEl = document.getElementById('swapRouteOptions') as HTMLElement | null;
const swapQuoteBtn = document.getElementById('swapQuoteBtn') as HTMLButtonElement | null;
const swapQuoteBtnDebugEl = document.getElementById('swapQuoteBtnDebug') as HTMLElement | null;
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
const swapWalletTrayEl = document.getElementById('swapWalletTray') as HTMLElement | null;
const swapWalletTotalUsdEl = document.getElementById('swapWalletTotalUsd') as HTMLButtonElement | null;
const swapWalletTotalUsdValEl = document.getElementById('swapWalletTotalUsdVal') as HTMLElement | null;
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
  __swapQuoteBtnDebug?: SwapQuoteBtnDiagnostics;
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
const swapRouteViaTradesLogEl = document.getElementById('swapRouteViaTradesLog') as HTMLElement | null;
const swapQuoteSummaryEl = document.getElementById('swapQuoteSummary') as HTMLElement | null;
const swapRawQuoteResponseEl = document.getElementById('swapRawQuoteResponse') as HTMLElement | null;
const swapRawSwapResponseEl = document.getElementById('swapRawSwapResponse') as HTMLElement | null;

/** Last successful swap quote response (for build tx validation). */
let lastSwapQuoteOk: Record<string, unknown> | null = null;
let lastRawQuoteResponse: unknown = null;
let lastRawSwapResponse: unknown = null;
let lastVybeBuild: { tx: string; builtAt: number; paramsKey: string; buildPayload: unknown } | null = null;
let enumeratedRoutesUiState: EnumeratedRoutesUiState | null = null;
let lastVybeQuoteBodyForRoutes: Record<string, unknown> | null = null;
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

function isPartnerConfigValid(): boolean {
  if (swapEnablePartnerCheckbox?.checked !== true) return true;
  return Boolean(swapPartnerInput?.value.trim());
}

function isWalletBalancesGateOpen(wallet: string): boolean {
  if (walletBalancesFetching) return false;
  if (walletBalancesReadyFor === wallet) return true;
  // Race: cache populated but ready flag not set yet (superseded fetch gen, etc.).
  return isWalletBalanceCacheReady(wallet);
}

type SwapQuoteBtnDiagnostics = {
  ready: boolean;
  blockReason: string | null;
  swapQuoteFetching: boolean;
  swapBuildMode: SwapBuildMode;
  wallet: string;
  walletValid: boolean;
  connectedWallet: string;
  vybeWalletErr: string | null;
  partnerValid: boolean;
  partnerEnabled: boolean;
  walletBalancesFetching: boolean;
  walletBalancesReadyFor: string;
  walletCacheReady: boolean;
  balancesGateOpen: boolean;
  sellMint: string;
  amountRaw: string;
  amount: number;
  amountMaxAttr: string;
  sellable: number | null;
  maxSell: number | null;
  buttonHidden: boolean;
  syncSkippedQuoteFetching: boolean;
};

function getSwapQuoteDisabledReason(): string | null {
  if (swapQuoteFetching) return 'Quote fetch in progress (swapQuoteFetching=true)';
  if (swapBuildMode === 'paste-sign') return 'Paste & Sign mode — use Sign pasted tx instead';
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (!hasValidSwapWallet()) {
    return wallet ? `Invalid wallet address: "${truncate(wallet, 6, 4)}"` : 'No wallet address';
  }
  if (!isPartnerConfigValid()) return 'Partner enabled but Partner ID is empty';
  if (!isWalletBalancesGateOpen(wallet)) {
    if (walletBalancesFetching) return 'Wallet balances still loading';
    return `Balances not ready (readyFor=${walletBalancesReadyFor ? truncate(walletBalancesReadyFor, 4, 4) : '—'}, cache=${isWalletBalanceCacheReady(wallet)})`;
  }
  const sellMint = swapInputMintInput?.value.trim() ?? '';
  if (!sellMint) return 'No sell mint selected';
  const amountRaw = swapAmountInput?.value ?? '';
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    const maxAttr = swapAmountInput?.max ?? '';
    const sellable = getWalletSellableForUi(sellMint);
    return `Sell amount invalid: raw="${amountRaw}" parsed=${amount} maxAttr="${maxAttr}" sellable=${sellable ?? 'null'}`;
  }
  if (getSwapRouter() === 'vybe') {
    const vybeErr = validateVybeQuoteWallet();
    if (vybeErr) return vybeErr;
  }
  return null;
}

function collectSwapQuoteBtnDiagnostics(): SwapQuoteBtnDiagnostics {
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const sellMint = swapInputMintInput?.value.trim() ?? '';
  const amountRaw = swapAmountInput?.value ?? '';
  const amount = Number(amountRaw);
  const blockReason = getSwapQuoteDisabledReason();
  return {
    ready: blockReason === null,
    blockReason,
    swapQuoteFetching,
    swapBuildMode,
    wallet,
    walletValid: hasValidSwapWallet(),
    connectedWallet: getBrowserWalletAddress(),
    vybeWalletErr: getSwapRouter() === 'vybe' ? validateVybeQuoteWallet() : null,
    partnerValid: isPartnerConfigValid(),
    partnerEnabled: swapEnablePartnerCheckbox?.checked === true,
    walletBalancesFetching,
    walletBalancesReadyFor,
    walletCacheReady: isWalletBalanceCacheReady(wallet),
    balancesGateOpen: isWalletBalancesGateOpen(wallet),
    sellMint,
    amountRaw,
    amount,
    amountMaxAttr: swapAmountInput?.max ?? '',
    sellable: sellMint ? getWalletSellableForUi(sellMint) : null,
    maxSell: sellMint ? getMaxSellAmountForInput(sellMint) : null,
    buttonHidden: swapQuoteBtn?.hidden === true,
    syncSkippedQuoteFetching: false,
  };
}

function renderSwapQuoteBtnDebug(diag: SwapQuoteBtnDiagnostics): void {
  if (!swapQuoteBtnDebugEl) return;
  if (diag.ready) {
    swapQuoteBtnDebugEl.hidden = true;
    swapQuoteBtnDebugEl.textContent = '';
    if (swapQuoteBtn) swapQuoteBtn.removeAttribute('title');
    return;
  }
  swapQuoteBtnDebugEl.hidden = false;
  swapQuoteBtnDebugEl.innerHTML = [
    `<strong>Get quote blocked:</strong> ${diag.blockReason ?? 'unknown'}`,
    `<br />wallet=${diag.walletValid ? truncate(diag.wallet, 4, 4) : 'invalid'}`,
    ` connected=${diag.connectedWallet ? truncate(diag.connectedWallet, 4, 4) : '—'}`,
    ` balances=${diag.balancesGateOpen ? 'ready' : diag.walletBalancesFetching ? 'loading' : 'not-ready'}`,
    ` amount=${diag.amountRaw || '—'} sellable=${diag.sellable ?? '—'}`,
    ` mode=${diag.swapBuildMode} router=${getSwapRouter()}`,
  ].join('');
  if (swapQuoteBtn) swapQuoteBtn.title = diag.blockReason ?? '';
}

function isSwapQuoteInputReady(): boolean {
  return getSwapQuoteDisabledReason() === null;
}

function syncSwapQuoteButtonState(): void {
  const diag = collectSwapQuoteBtnDiagnostics();
  if (!swapQuoteBtn || swapQuoteBtn.hidden) {
    console.debug('[swap-quote-btn]', { ...diag, note: 'button missing or hidden' });
    renderSwapQuoteBtnDebug(diag);
    return;
  }
  const ready = diag.blockReason === null;
  swapQuoteBtn.disabled = !ready;
  renderSwapQuoteBtnDebug(diag);
  console.debug('[swap-quote-btn]', diag);
  const w = getSolanaWindow();
  w.__swapQuoteBtnDebug = diag;
}

function setSwapQuoteButtonLoading(loading: boolean): void {
  if (!swapQuoteBtn) return;
  swapQuoteBtn.classList.toggle('swap-action-btn--loading', loading);
  swapQuoteBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
  const labelEl = swapQuoteBtn.querySelector('.swap-action-btn__label');
  const hintEl = swapQuoteBtn.querySelector('.swap-action-btn__hint');
  if (labelEl) labelEl.textContent = loading ? 'Loading…' : 'Get quote';
  if (hintEl) hintEl.textContent = loading ? 'Fetching route & pricing' : 'Fetch route & pricing';
  if (loading) {
    swapQuoteBtn.disabled = true;
  } else {
    syncSwapQuoteButtonState();
  }
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

function showInlineError(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.title = msg;
  el.hidden = false;
  el.removeAttribute('aria-hidden');
}

function clearInlineError(el: HTMLElement): void {
  el.textContent = '';
  el.removeAttribute('title');
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}

function showInlineWarning(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.title = msg;
  el.hidden = false;
  el.removeAttribute('aria-hidden');
}

function clearInlineWarning(el: HTMLElement): void {
  el.textContent = '';
  el.removeAttribute('title');
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
      const res = await fetch(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
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
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  renderChipTokenIcon(swapInputTokenIconEl, inMint, routingTokenDotClass(inMint, getSwapInSym()));
  renderChipTokenIcon(swapOutputTokenIconEl, outMint, routingTokenDotClass(outMint, getSwapOutSym()));
  updateSwapPairCards();
}

function trimUsdTrailingZeros(formatted: string): string {
  if (!formatted.includes('.')) return formatted;
  return formatted.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function roundToSigFigs(abs: number, sigFigs: number): number {
  if (!Number.isFinite(abs) || abs === 0) return 0;
  const exp = Math.floor(Math.log10(abs));
  const scale = Math.pow(10, sigFigs - 1 - exp);
  return Math.round(abs * scale) / scale;
}

/** Small fee/rent amounts — sig figs after leading fractional zeros; rounds the last digit. */
function formatFeeStackAmount(n: number, sigFigs = 3): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (!Number.isFinite(abs) || abs === 0) return '0';
  if (abs >= 1) return sign + trimUsdTrailingZeros(abs.toFixed(4));

  const rounded = roundToSigFigs(abs, sigFigs);
  if (rounded === 0) return '0';
  const exp = Math.floor(Math.log10(rounded));
  const decPlaces = Math.max(0, -exp + (sigFigs - 1));
  let out = rounded.toFixed(Math.min(decPlaces, 14));
  out = out.replace(/(\.\d*?)0+$/, '$1');
  return sign + out;
}

/** Hop fee table USD column — 2 sig figs (e.g. $0.0082, $0.00043). */
function formatHopFeeTableUsdAmount(n: number): string {
  return formatFeeStackAmount(n, 2);
}

/**
 * Fee SOL/USD equivalents in route hop details — same 3 sig fig rule as the You pay stack.
 */
function formatFeeEquivSmallAmount(n: number): string {
  return formatFeeStackAmount(n);
}

function formatFeeEquivUsdFiatDisplay(n: number): string {
  return `~$${formatFeeEquivSmallAmount(n)}`;
}

/** Sell / you-pay USD — 2 dp when ≥ $0.01; otherwise show first significant sub-cent digits. */
function formatSwapPayUsdAmount(n: number): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(abs) || abs === 0) return '0.00';
  const twoDp = abs.toFixed(2);
  if (Number(twoDp) > 0) return twoDp;
  const small = formatFeeStackAmount(abs);
  return small === '0' ? '0.00' : small;
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
    syncSwapQuoteButtonState();
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

  if (lastSwapQuoteOk) {
    setBuyReadoutLoading(false);
    setBuyFiatLoading(false);
    const outAmt = formatQuoteTokenAmount(lastSwapQuoteOk, 'out');
    if (swapBuyAmountDisplayEl && outAmt.display !== '—') {
      swapBuyAmountDisplayEl.textContent = outAmt.display;
      swapBuyAmountDisplayEl.dataset.empty = 'false';
      if (outAmt.full) swapBuyAmountDisplayEl.title = outAmt.full;
      else swapBuyAmountDisplayEl.removeAttribute('title');
    }
    if (swapBuyFiatEl) {
      swapBuyFiatEl.textContent = formatSwapReceiveFiatDisplay(getQuoteReceiveUsd(lastSwapQuoteOk));
    }
    if (swapSellFiatEl) {
      swapSellFiatEl.textContent = formatSwapPayFiatDisplay(getQuotePayUsd(lastSwapQuoteOk));
    }
    syncSwapQuoteButtonState();
    return;
  }

  if (swapBuyFiatEl) swapBuyFiatEl.textContent = '~$0.00';
  const sellMint = swapInputMintInput?.value.trim() ?? '';
  const price = lookupMintPriceUsd(sellMint, lastSwapQuoteOk ?? {});
  if (!sellMint || !Number.isFinite(price) || price <= 0) {
    if (swapSellFiatEl) swapSellFiatEl.textContent = '~$0.00';
    refreshSwapQuoteDetailsPlaceholders();
    syncSwapQuoteButtonState();
    return;
  }
  if (swapSellFiatEl) swapSellFiatEl.textContent = formatSwapPayFiatDisplay(amount * price);
  refreshSwapQuoteDetailsPlaceholders();
  syncSwapQuoteButtonState();
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
  enumeratedRoutesUiState = null;
  lastVybeQuoteBodyForRoutes = null;
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
  if (swapTxBase64El) swapTxBase64El.value = '';
  syncSwapBuildResultPanel();
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
  // Programmatic sell updates during an in-flight quote must not abort the fetch/retry loop.
  if (swapQuoteFetching) return;
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
const SWAP_SERVICE_FEE_PARTNER_LOCKED_TITLE = 'Enable Partner first';

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

function getFlipBlockedReason(): string | null {
  if (!hasValidSwapWallet()) {
    return 'Enter or connect a valid Solana wallet to flip tokens.';
  }
  const buyMint = preferNativeSolMint(swapOutputMintInput?.value.trim() ?? '');
  if (!buyMint) {
    return 'Choose a buy token to flip.';
  }
  if (!isWalletTokenTradable(buyMint)) {
    const sym =
      getCachedTokenMeta(buyMint)?.symbol ??
      HARDCODED_MINT_SYMBOLS[buyMint] ??
      buyMint.slice(0, 4).toUpperCase();
    return `No sellable ${sym} balance in this wallet — flip would sell that token after swapping sides.`;
  }
  return null;
}

function canFlipSellBuyTokens(): boolean {
  return getFlipBlockedReason() === null;
}

function clearFlipInlineErrorIfShown(): void {
  if (!swapQuoteError || swapQuoteError.hidden) return;
  const msg = swapQuoteError.textContent ?? '';
  if (
    msg.includes('to flip tokens') ||
    msg.includes('to flip.') ||
    msg.startsWith('No sellable ')
  ) {
    clearInlineError(swapQuoteError);
  }
}

function syncFlipButtonState(): void {
  if (!swapFlipBtnEl) return;
  const reason = getFlipBlockedReason();
  const blocked = reason !== null;
  swapFlipBtnEl.disabled = false;
  swapFlipBtnEl.classList.toggle('swap-flip-fab--blocked', blocked);
  swapFlipBtnEl.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  swapFlipBtnEl.title = blocked ? reason! : 'Flip tokens';
  if (!blocked) clearFlipInlineErrorIfShown();
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
    syncFlipButtonState();
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
  syncServiceFeePartnerGate(valid);

  syncSlippageInputForAutoSlippage();
  syncSellPctButtonsState();
}

function getMaxSellPercentForMint(_mint: string): number {
  return 100;
}

function formatMaxSellPercentButtonLabel(_mint: string): string {
  return '100%';
}

function sellAmountRoughlyEqual(a: number, b: number, mint: string): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return true;
  const decimals = getMintDecimals(mint);
  const eps = Math.pow(10, -Math.min(Math.max(decimals, 0), 12)) * 1.5;
  return Math.abs(a - b) <= eps;
}

function sellAmountMatchesVybeExactBalance(mint: string): boolean {
  if (!swapAmountInput) return false;
  const item = getWalletBalanceListItem(mint);
  const exact = item?.amountExact?.trim().replace(/,/g, '');
  if (!exact) return false;
  return swapAmountInput.value.trim() === exact;
}

function sellAmountMatchesPercent(currentUi: number, percent: number, mint: string): boolean {
  const total = getWalletBalanceAmountUi(mint);
  const sellable = getWalletSellableForUi(mint);
  if (total == null || total <= 0 || sellable == null || sellable <= 0) return false;
  if (!Number.isFinite(currentUi) || currentUi <= 0) return false;

  const maxPct = getMaxSellPercentForMint(mint);
  if (percent >= maxPct) {
    if (sellAmountMatchesVybeExactBalance(mint)) return true;
    const maxInput = getMaxSellAmountForInput(mint);
    if (maxInput == null || maxInput <= 0) return false;
    return sellAmountRoughlyEqual(currentUi, maxInput, mint);
  }

  const target = Math.min(total * (percent / 100), sellable);
  return sellAmountRoughlyEqual(currentUi, target, mint);
}

function resolveActiveSellPercent(currentUi: number, mint: string): number | null {
  for (const pct of [25, 50]) {
    if (sellAmountMatchesPercent(currentUi, pct, mint)) return pct;
  }
  const maxPct = getMaxSellPercentForMint(mint);
  if (sellAmountMatchesPercent(currentUi, maxPct, mint)) return maxPct;
  return null;
}

function syncSellPctButtonsState(): void {
  const container = document.getElementById('swapSellPctBtns');
  if (!container) return;
  const mint = swapInputMintInput?.value.trim() ?? '';
  const walletReady =
    hasValidSwapWallet() && mint.length > 0 && (getWalletSellableForUi(mint) ?? 0) > 0;
  const currentUi = Number(swapAmountInput?.value.trim() ?? '');
  const activePct =
    walletReady && Number.isFinite(currentUi) && currentUi > 0
      ? resolveActiveSellPercent(currentUi, mint)
      : null;
  const maxPct = mint ? getMaxSellPercentForMint(mint) : 100;

  for (const btn of container.querySelectorAll<HTMLButtonElement>('.swap-sell-pct-btn')) {
    const pct = Number(btn.dataset.sellPct);
    const isMaxBtn = btn.hasAttribute('data-sell-pct-max');
    const isActive =
      activePct != null &&
      (isMaxBtn ? activePct >= maxPct : Number.isFinite(pct) && pct === activePct);
    btn.classList.toggle('swap-sell-pct-btn--active', isActive);
    btn.disabled = !walletReady || isActive;
  }

  const maxBtn = container.querySelector<HTMLButtonElement>('[data-sell-pct-max]');
  if (maxBtn && mint) {
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

  const sellable = getWalletSellableForUi(mint);
  if (sellable == null || sellable <= 0) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Balance too low to sell this token.');
    return;
  }

  const maxInput = getMaxSellAmountForInput(mint) ?? sellable;
  let amount =
    percent >= getMaxSellPercentForMint(mint) ? maxInput : total * (percent / 100);
  if (percent >= getMaxSellPercentForMint(mint) && getSwapRouter() === 'vybe') {
    const item = getWalletBalanceListItem(mint);
    const exact = item?.amountExact?.trim();
    if (exact) {
      if (swapQuoteError) clearInlineError(swapQuoteError);
      swapAmountInput!.value = exact.replace(/,/g, '');
      syncSwapAmountMaxFromBalance();
      swapAmountInput!.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }
  if (amount > maxInput) amount = maxInput;
  if (amount <= 0) return;

  if (swapQuoteError) clearInlineError(swapQuoteError);
  setSwapSellAmountToBalance(amount, mint);
}

function formatSwapInputAmountValue(amount: number, decimals = 9): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  return formatSwapAmountValue(amount).replace(/,/g, '');
}

/** Max sell amount as stored in the amount input (matches 4-decimal display rounding). */
function getMaxSellAmountForInput(mint: string): number | null {
  const sellable = getWalletSellableForUi(mint);
  if (sellable == null || sellable <= 0) return null;
  const formatted = formatSwapInputAmountValue(sellable, getMintDecimals(mint));
  const parsed = Number(formatted);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : sellable;
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
    if (hit && isWalletTokenTradable(preferNativeSolMint(hit.mintAddress))) return hit;
  }
  return (
    positive
      .filter((i) => !isSolMint(i.mintAddress) && isSplValueTradable(i.valueUsd))
      .sort((a, b) => b.valueUsd - a.valueUsd || b.amountUi - a.amountUi)[0] ?? null
  );
}

function syncSwapAmountMaxFromBalance(): void {
  if (!swapAmountInput || !swapInputMintInput) return;
  const mint = swapInputMintInput.value.trim();
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const balancesReady = isWalletBalancesGateOpen(wallet);
  const sellable = getWalletSellableForUi(mint);
  if (sellable != null && sellable > 0) {
    swapAmountInput.max = formatSwapInputAmountValue(sellable, getMintDecimals(mint));
  } else if (hasValidSwapWallet() && mint && balancesReady) {
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
  return getMaxSellAmountForInput(mint);
}

function clampSwapAmountInputToMax(): boolean {
  if (!swapAmountInput || !swapInputMintInput) return false;
  const raw = swapAmountInput.value.trim();
  if (!raw || raw === '.' || raw === '-') return false;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return false;
  const max = getSwapAmountMaxUi();
  if (max == null || max <= 0 || amount <= max) return false;
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

function setSwapSellAmountToBalance(amountUi: number, mint: string, silent = false): void {
  if (!swapAmountInput) return;
  const formatted = formatSwapInputAmountValue(amountUi, getMintDecimals(mint));
  swapAmountInput.value = formatted;
  syncSwapAmountMaxFromBalance();
  if (!silent) {
    swapAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
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
  if (item.decimals != null) routeMintDecimalsCache[swapMint] = item.decimals;
  syncSwapAmountMaxFromBalance();
  if (useMaxAmount) {
    const sellable = getWalletSellableForUi(swapMint);
    if (sellable != null && sellable > 0) {
      setSwapSellAmountToBalance(sellable, swapMint, true);
    }
  }
  void refreshSwapSymbols();
}

async function refreshWalletBalancesForSwap(wallet: string, applyDefaults: boolean): Promise<void> {
  const gen = ++walletBalanceFetchGen;
  walletBalancesFetching = true;
  syncSwapQuoteButtonState();
  updateWalletTotalUsdUi();
  const force = wallet !== lastWalletBalanceFetchAddress;
  let markReady = false;
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
        await prefetchSwapPairPrices({
          forceFullDetails: true,
          mints: [preferNativeSolMint(pick.mintAddress)],
        });
        markReady = true;
        return;
      }
    }

    syncSwapAmountMaxFromBalance();
    await prefetchSwapPairPrices({ forceFullDetails: true });
    markReady = true;
  } catch {
    if (gen !== walletBalanceFetchGen) return;
    refreshWalletBalancesPanel();
    // Allow quoting with manual amount even when balance fetch fails.
    markReady = true;
  } finally {
    if (gen === walletBalanceFetchGen) {
      walletBalancesFetching = false;
      if (markReady) walletBalancesReadyFor = wallet;
      syncSwapAmountMaxFromBalance();
      syncSwapQuoteButtonState();
      updateWalletTotalUsdUi();
    }
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
    walletBalancesFetching = false;
    walletBalancesReadyFor = '';
    lastWalletBalanceFetchAddress = '';
    lastAutoAppliedWalletAddress = '';
    if (swapAmountInput) swapAmountInput.removeAttribute('max');
    syncSwapQuoteButtonState();
    updateWalletTotalUsdUi();
    return;
  }

  if (swapQuoteError && !swapQuoteError.hidden) {
    clearInlineError(swapQuoteError);
  }

  const applyDefaults = wallet !== lastAutoAppliedWalletAddress;
  if (
    !applyDefaults &&
    walletBalancesReadyFor === wallet &&
    isWalletBalanceCacheReady(wallet)
  ) {
    syncSwapAmountMaxFromBalance();
    syncSwapQuoteButtonState();
    return;
  }

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

function swapPairMintsMatch(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return false;
  return preferNativeSolMint(left) === preferNativeSolMint(right);
}

function parseFlipOutputAmountUi(): number | null {
  if (lastSwapQuoteOk) {
    const fromQuote = quoteOutputUiAmount(lastSwapQuoteOk);
    if (fromQuote != null && fromQuote > 0) return fromQuote;
  }
  if (!swapBuyAmountDisplayEl) return null;
  if (swapBuyAmountDisplayEl.dataset.empty === 'true') return null;
  if (swapBuyAmountDisplayEl.dataset.loading === 'true') return null;
  const fromTitle = swapBuyAmountDisplayEl.getAttribute('title')?.replace(/,/g, '').trim();
  if (fromTitle) {
    const t = Number(fromTitle);
    if (Number.isFinite(t) && t > 0) return t;
  }
  const raw = swapBuyAmountDisplayEl.textContent?.replace(/,/g, '').trim() ?? '';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function applyFlippedOutputAsSellAmount(outputAmountUi: number): void {
  if (!swapInputMintInput || !swapAmountInput) return;
  const mint = swapInputMintInput.value.trim();
  if (!mint || !hasValidSwapWallet()) return;

  syncSwapAmountMaxFromBalance();
  let amount = outputAmountUi;
  const max = getSwapAmountMaxUi();
  if (max != null && amount > max) {
    amount = max;
    flashSellPct100Button();
  }
  if (swapQuoteError) clearInlineError(swapQuoteError);
  setSwapSellAmountToBalance(amount, mint);
}

function flipSellBuyTokens(): void {
  if (getFlipBlockedReason()) return;
  if (!swapInputMintInput || !swapOutputMintInput) return;
  const sellMint = swapInputMintInput.value;
  const buyMint = swapOutputMintInput.value;
  swapInputMintInput.value = buyMint;
  swapOutputMintInput.value = sellMint;
  const sellSym = swapInputSymbolEl?.textContent ?? '';
  const buySym = swapOutputSymbolEl?.textContent ?? '';
  if (swapInputSymbolEl) swapInputSymbolEl.textContent = buySym.trim() || '—';
  if (swapOutputSymbolEl) swapOutputSymbolEl.textContent = sellSym.trim() || '—';
}

function afterSellBuyTokensFlipped(flippedOutputAmountUi: number | null = null): void {
  void syncSwapSideLabels();
  updateSwapTokenIcons();
  updateSwapPairCards();
  syncSwapAmountMaxFromBalance();
  const newSellMint = swapInputMintInput?.value.trim() ?? '';
  if (newSellMint && hasValidSwapWallet()) {
    if (flippedOutputAmountUi != null) {
      applyFlippedOutputAsSellAmount(flippedOutputAmountUi);
    } else {
      applySellAmountPercent(getMaxSellPercentForMint(newSellMint));
    }
  }
  void prefetchSwapPairPrices({ forceFullDetails: true, mints: newSellMint ? [newSellMint] : undefined });
  void refreshLowSolTradeWarning();
  syncFlipButtonState();
}

function applySelectedToken(mint: string, side: TokenPickerSide): void {
  invalidateSwapQuoteAfterInputChange();
  const input = side === 'input' ? swapInputMintInput : swapOutputMintInput;
  const otherInput = side === 'input' ? swapOutputMintInput : swapInputMintInput;
  const symbolEl = side === 'input' ? swapInputSymbolEl : swapOutputSymbolEl;
  if (!input) return;
  const resolvedMint = side === 'input' ? preferNativeSolMint(mint) : mint.trim();
  const otherMint = otherInput?.value.trim() ?? '';

  if (otherMint && swapPairMintsMatch(resolvedMint, otherMint)) {
    const flippedOutputAmountUi = parseFlipOutputAmountUi();
    flipSellBuyTokens();
    void refreshSwapSymbols().then(() => afterSellBuyTokensFlipped(flippedOutputAmountUi));
    return;
  }

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
    const sellable = getWalletSellableForUi(resolvedMint);
    if (sellable != null && sellable > 0) {
      setSwapSellAmountToBalance(sellable, resolvedMint);
    }
    void prefetchSwapPairPrices({ forceFullDetails: true, mints: [resolvedMint] }).then(() => {
      syncSwapQuoteButtonState();
    });
  } else {
    void prefetchSwapPairPrices({ forceFullDetails: true });
  }
  void refreshLowSolTradeWarning();
  syncFlipButtonState();
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

/** `swapUsdValue` from the swap/quote response (input leg USD at quote time). */
function getQuoteSwapUsdValue(quote: Record<string, unknown>): number | null {
  const v = quote.swapUsdValue;
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function quoteQuotedOutUiAmount(quote: Record<string, unknown>): number | null {
  const outMint = quoteOutputMint(quote);
  const fromQuoted = parseRawAmountDigits(quote._quotedOutAmount);
  if (fromQuoted) {
    const n = rawAmountToUiNumber(fromQuoted, getMintDecimals(outMint));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastHop = plan.at(-1);
  const hopOut = parseRawAmountDigits(lastHop?.swapInfo?.outAmount);
  if (hopOut) {
    const n = rawAmountToUiNumber(hopOut, getMintDecimals(outMint));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseQuotePriceImpactPct(quote: Record<string, unknown>): number | null {
  const v = quote.priceImpactPct;
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/%$/, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Scale swapUsdValue by a same-mint amount ratio (e.g. wallet pay ÷ swap leg, both SOL). */
function scaleQuoteSwapUsdBySameMintRatio(
  quote: Record<string, unknown>,
  numeratorUi: number | null,
  denominatorUi: number | null,
): number | null {
  const swapUsd = getQuoteSwapUsdValue(quote);
  if (swapUsd == null || numeratorUi == null || denominatorUi == null || denominatorUi <= 0) {
    return null;
  }
  return swapUsd * (numeratorUi / denominatorUi);
}

/** USD notional of the sell/swap input leg — from quote `swapUsdValue` only. */
function getQuotePayUsd(quote: Record<string, unknown>): number | null {
  return getQuoteSwapUsdValue(quote);
}

/** USD notional of the swap leg only (same as pay when no extra wallet debit). */
function quoteSwapLegUsd(quote: Record<string, unknown>): number | null {
  return getQuoteSwapUsdValue(quote);
}

/** USD notional of total wallet debit — `swapUsdValue` scaled by wallet pay ÷ swap leg (same mint). */
function quoteWalletPayUsd(quote: Record<string, unknown>): number | null {
  const payUi = quoteWalletPayUi(quote);
  const inUi = quoteInAmountUi(quote);
  return scaleQuoteSwapUsdBySameMintRatio(quote, payUi, inUi) ?? getQuoteSwapUsdValue(quote);
}

/**
 * USD notional of receive/output — from quote fields only.
 * Uses swapUsdValue × (net out ÷ quoted out) when both are in the output mint;
 * otherwise falls back to swapUsdValue adjusted by priceImpactPct.
 */
function getQuoteReceiveUsd(quote: Record<string, unknown>): number | null {
  const swapUsd = getQuoteSwapUsdValue(quote);
  if (swapUsd == null) return null;

  const netUi = quoteOutputUiAmount(quote);
  const quotedUi = quoteQuotedOutUiAmount(quote);

  if (netUi != null && quotedUi != null && quotedUi > 0 && netUi > 0) {
    if (netUi <= quotedUi) {
      return swapUsd * (netUi / quotedUi);
    }
    /* Vybe synthesized routes can report simulated net out above hop quoted out.
       Do not inflate receive USD past swap pay — use output mint spot instead. */
    const outMint = quoteOutputMint(quote);
    const outPrice = lookupMintPriceUsd(outMint ?? '', quote);
    if (Number.isFinite(outPrice) && outPrice > 0) {
      return netUi * outPrice;
    }
    return swapUsd;
  }

  const impact = parseQuotePriceImpactPct(quote);
  if (impact != null) {
    return swapUsd * (1 + impact / 100);
  }

  return swapUsd;
}

/** Tooltip explaining quote-response USD basis (not token-details prefetch). */
function quoteOutputPriceSourceTitle(quote: Record<string, unknown>): string {
  const swapUsd = getQuoteSwapUsdValue(quote);
  const netUi = quoteOutputUiAmount(quote);
  const quotedUi = quoteQuotedOutUiAmount(quote);
  if (swapUsd == null) {
    return 'USD estimate unavailable — swap quote did not include swapUsdValue';
  }
  if (netUi != null && quotedUi != null && quotedUi > 0) {
    if (netUi <= quotedUi) {
      return `swapUsdValue $${formatSwapLegUsdAmount(swapUsd)} × net out ÷ quoted out (from quote response)`;
    }
    return `net out × output mint USD price (simulated out exceeds hop quoted out on this route)`;
  }
  const impact = parseQuotePriceImpactPct(quote);
  if (impact != null) {
    return `swapUsdValue $${formatSwapLegUsdAmount(swapUsd)} × (1 ${impact >= 0 ? '+' : ''}${impact}%) price impact (from quote response)`;
  }
  return `swapUsdValue $${formatSwapLegUsdAmount(swapUsd)} (from quote response)`;
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


function uiAmountToRawBigInt(amountUi: number, mint: string): bigint {
  const decimals = getMintDecimals(mint);
  const formatted = formatSwapInputAmountValue(amountUi, decimals);
  const [whole, frac = ''] = formatted.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(`${whole}${fracPadded}`);
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
function syncSellAmountInputFromInAmountRaw(
  raw: string,
  mint: string,
  requestedUi?: number,
): number | null {
  if (!swapAmountInput || !mint) return null;
  const digits = parseRawAmountDigits(raw);
  if (!digits) return null;
  const { display } = formatRawTokenAmount(digits, mint);
  if (display === '—') return null;
  const n = Number(display.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (
    requestedUi != null &&
    !shouldApplySellAmountFromQuoteInAmount(requestedUi, n, mint, getSwapSellRouterOptions())
  ) {
    return requestedUi;
  }
  swapAmountInput.value = display.replace(/,/g, '');
  return n;
}

function maybeShowSplSellReducedWarning(amountUi: number, mint: string, originalAmountUi?: number): void {
  if (!swapQuoteWarning) return;
  const sellable = getWalletSellableForUi(mint);
  if (sellable != null && amountUi >= sellable * 0.995) return;
  const balance = getWalletBalanceAmountUi(mint);
  if (balance == null) return;
  if (originalAmountUi != null && amountUi >= originalAmountUi * 0.999) return;
  if (originalAmountUi == null && amountUi >= balance * 0.995) return;
  const sym =
    getCachedTokenMeta(mint)?.symbol ??
    HARDCODED_MINT_SYMBOLS[mint] ??
    mint.slice(0, 4).toUpperCase();
  showInlineWarning(
    swapQuoteWarning,
    `Sell amount reduced to ${formatSwapInputAmountValue(amountUi, getMintDecimals(mint))} ${sym} to leave room for ${sym} fees.`,
  );
}

/** Full wallet balance (100%) when switching routers after sim retries are exhausted. */
function getSplRouterResetSellAmountUi(mint: string): number | null {
  if (isSolMint(mint)) return getWalletSellableForUi(mint);
  const balance = getWalletBalanceAmountUi(mint);
  if (balance == null || balance <= 0) return null;
  return balance;
}

function resetSplSellAmountForRouterSwitch(mint: string, fallbackAmount: number): number {
  const reset = getSplRouterResetSellAmountUi(mint);
  if (reset != null && reset > 0) {
    setSwapSellAmountToBalance(reset, mint, true);
    return reset;
  }
  return fallbackAmount;
}

function nextSplSellRetryAmountUi(
  inputMint: string,
  currentAmountUi: number,
  step: number,
): number | null {
  const balance = getWalletBalanceAmountUi(inputMint);
  if (balance == null) return null;
  const sellable = getWalletSellableForUi(inputMint);
  if (sellable != null && currentAmountUi <= sellable * 1.001) return null;
  if (!shouldContinueSplSellSimRetry(inputMint, currentAmountUi, balance, step)) return null;

  const nextStep = step + 1;
  const nextAmount = computeSplSellAmountForRetryStep(balance, nextStep);
  if (!(nextAmount > 0) || nextAmount >= currentAmountUi * 0.999) return null;
  return nextAmount;
}

function rememberSplMaxSellAfterSimRetry(
  inputMint: string,
  attemptAmountUi: number,
  splSimStep: number,
): void {
  if (splSimStep <= 0) return;
  noteSplMaxSellFraction(
    inputMint,
    attemptAmountUi,
    getWalletBalanceAmountUi(inputMint) ?? attemptAmountUi,
  );
  syncSwapAmountMaxFromBalance();
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

function formatFooterPctAlwaysTwoDecimals(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

/** Max slippage % = (1 − min received ÷ output) × 100 */
function formatMaxSlippageRatio(quote: Record<string, unknown>): string {
  // ix-builder enrichment carries the authoritative max slippage % — print it, don't recompute.
  const enriched = quote._maxSlippagePct;
  if (typeof enriched === 'number' && Number.isFinite(enriched) && enriched >= 0) {
    return formatFooterPctAlwaysTwoDecimals(enriched);
  }
  const out = quoteTokenAmountUiNumber(quote, 'out');
  const min = quoteTokenAmountUiNumber(quote, 'min');
  if (out == null || min == null || out <= 0) return '—';
  const pct = (1 - min / out) * 100;
  if (!Number.isFinite(pct)) return '—';
  return formatFooterPctAlwaysTwoDecimals(pct);
}

function formatSwapRate(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatSwapAmount(value).display;
}

/** Footer price impact — always two decimal places (e.g. 0.30%); zero shows (No Impact). */
function formatPriceImpactPct(value: unknown): string {
  if (value == null || value === '') return '—';
  const raw = String(value).trim().replace(/%$/, '');
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  const formatted = formatFooterPctAlwaysTwoDecimals(n);
  return formatted === '0.00%' ? '0.00% (No Impact)' : formatted;
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
  const unitSymCls = tokenSymColorClass(mint, chipSymbol);
  return `<div class="swap-pair-spot">
    <span class="swap-pair-spot-value">${escapeHtml(price)}</span>
    <span class="swap-pair-spot-unit"><span class="swap-pair-spot-fiat-label">USD</span> / <span class="${unitSymCls}">1 ${escapeHtml(unit)}</span></span>
  </div>`;
}

function applyTokenBoxColor(el: HTMLElement | null, mint: string, symbolHint?: string): void {
  if (!el) return;
  el.classList.remove('swap-token-color--sol', 'swap-token-color--stable', 'swap-token-color--alt');
  if (mint) el.classList.add(tokenBoxColorClass(mint, symbolHint));
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

function renderPairCardIcon(mint: string, _symbol: string): string {
  const meta = getCachedTokenMeta(mint);
  return renderTokenIconImgHtml(effectiveTokenIconSrc(meta?.logoUrl), 'swap-pair-icon-img');
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
  applyTokenBoxColor(swapCardSellEl, inMint, getSwapInSym());
  applyTokenBoxColor(swapCardBuyEl, outMint, getSwapOutSym());
  renderPairCard(swapCardSellEl, inMint, 'sell', loading);
  renderPairCard(swapCardBuyEl, outMint, 'buy', loading);
  updateSwapSideChanges(loading);
}


function setRouteChipLabel(label: string, disabled: boolean): void {
  if (swapRouteChipTextEl) swapRouteChipTextEl.textContent = label;
  else if (swapRouteBtnEl) swapRouteBtnEl.textContent = label;
  if (swapRouteBtnEl) swapRouteBtnEl.disabled = disabled;
}


function getSwapRouter(): string {
  return swapRouterInput?.value.trim() || 'vybe';
}

function getSwapSellRouterOptions(): { router: string } {
  return { router: getSwapRouter() };
}

function getWalletSellableForUi(mint: string): number | null {
  return getWalletSellableAmountUi(mint, getSwapSellRouterOptions());
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
  syncSwapAmountMaxFromBalance();
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

function resolveVybeHandoffAggregatorRouter(body: Record<string, unknown>): 'jupiter' | 'titan' | null {
  const build = body._build as Record<string, unknown> | undefined;
  const plan = Array.isArray(body.routePlan) ? body.routePlan : [];
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    const s = String(value ?? '').trim().toLowerCase();
    if (s) candidates.push(s);
  };

  push(body._effectiveRouter);
  push(body._buildRouter);
  push(build?.provider);
  for (const step of plan) {
    const si = (step as VybeRoutePlanStepLite)?.swapInfo;
    push(si?.label);
    push(si?.ammKey);
  }
  const details = build?.details as Record<string, unknown> | undefined;
  const buildQuote = details?.quote as Record<string, unknown> | undefined;
  push(buildQuote?.provider);
  const intermediate = buildQuote?.intermediateQuote as Record<string, unknown> | undefined;
  push(intermediate?.provider);

  for (const c of candidates) {
    if (c === 'jupiter') return 'jupiter';
    if (c === 'titan') return 'titan';
  }
  for (const c of candidates) {
    if (c.includes('titan')) return 'titan';
    if (c.includes('jupiter')) return 'jupiter';
  }
  return null;
}

function detectVybeAggregatorFallbackRouter(
  body: Record<string, unknown>,
  selectedRouter: string,
): 'jupiter' | 'titan' | null {
  if (normalizeRouterId(selectedRouter) !== 'vybe') return null;
  const rvtHandoff = detectRouteViaTradesAggregatorHandoff(body);
  if (rvtHandoff) return rvtHandoff;
  if (body._routeViaTrades != null) return null;
  return resolveVybeHandoffAggregatorRouter(body);
}

function hasAcceptableVybeRouteQuote(body: Record<string, unknown>): boolean {
  const rvt = body._routeViaTrades as { outcome?: string; routes?: unknown[] } | undefined;
  if (rvt?.outcome === 'multi' || rvt?.outcome === 'direct') return true;
  const plan = body.routePlan;
  if (!Array.isArray(plan) || plan.length === 0) return false;
  const build = body._build as Record<string, unknown> | undefined;
  const tx = build?.tx ?? build?.transaction;
  return typeof tx === 'string' && tx.length > 0;
}

function detectRouteViaTradesAggregatorHandoff(
  body: Record<string, unknown>,
): 'jupiter' | 'titan' | null {
  const rvt = body._routeViaTrades as {
    enabled?: boolean;
    fallbackRouter?: string;
    outcome?: string;
  } | undefined;
  if (!rvt?.enabled) return null;
  if (rvt.outcome === 'multi' || rvt.outcome === 'direct') return null;
  if (rvt.fallbackRouter === 'jupiter' || rvt.fallbackRouter === 'titan') {
    return rvt.fallbackRouter;
  }
  if (rvt.outcome === 'titan_fallback') return 'titan';
  if (rvt.outcome === 'jupiter_fallback') return 'jupiter';
  const build = body._build as Record<string, unknown> | undefined;
  const provider = normalizeRouterId(String(build?.provider ?? ''));
  if (provider === 'jupiter' || provider === 'titan') {
    return provider;
  }
  return null;
}

function handoffVybeQuoteToAggregator(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
  fallbackRouter: 'jupiter' | 'titan',
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  if (!isRouterFallbackEnabled()) {
    throw vybeRouteUnavailableError(fallbackRouter);
  }
  setSwapRouter(fallbackRouter, { invalidateQuote: false });
  return requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, amount, {
    ...buildOpts,
    router: fallbackRouter,
  });
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

  // Carry ix-builder's print-ready display fields forward from the final build (authoritative).
  for (const key of [
    '_youPay',
    '_youReceive',
    '_maxSlippagePct',
    '_tokens',
    '_inputPriceUsd',
    '_outputPriceUsd',
  ] as const) {
    const value = buildPayload?.[key];
    if (value != null) next[key] = value;
  }

  const walletPayDebitRaw =
    buildPayload?._walletPayDebitRaw ??
    source?.walletPayDebitRaw ??
    quote._walletPayDebitRaw;
  if (typeof walletPayDebitRaw === 'string' && walletPayDebitRaw.length > 0) {
    next._walletPayDebitRaw = walletPayDebitRaw;
  }

  const walletTokenAccountCloses =
    buildPayload?._walletTokenAccountCloses ?? quote._walletTokenAccountCloses;
  if (Array.isArray(walletTokenAccountCloses)) {
    next._walletTokenAccountCloses = walletTokenAccountCloses;
  }

  if (typeof simulatedOutRaw === 'string' && simulatedOutRaw.length > 0) {
    const outMint = quoteOutputMint(next);
    next.outAmount = simulatedOutRaw;
    const outFmt = formatRawTokenAmount(simulatedOutRaw, outMint);
    next.outAmountUi = Number(outFmt.display.replace(/,/g, ''));
    next._outputFromSimulation = outputFromSimulation;

    // Prefer ix-builder's min-received threshold (printed, not recomputed). Only fall back to
    // the client slippage math when the build did not return an enriched threshold.
    const enrThreshRaw = buildPayload?._otherAmountThresholdRaw;
    if (typeof enrThreshRaw === 'string' && enrThreshRaw.length > 0) {
      next.otherAmountThreshold = enrThreshRaw;
      const enrThreshUi = buildPayload?._otherAmountThresholdUi;
      next.otherAmountThresholdUi =
        typeof enrThreshUi === 'number' && Number.isFinite(enrThreshUi)
          ? enrThreshUi
          : Number(formatRawTokenAmount(enrThreshRaw, outMint).display.replace(/,/g, ''));
    } else {
      const slippagePct = swapSlippageInput ? Number(swapSlippageInput.value) : DEFAULT_SWAP_SLIPPAGE_PCT;
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
  const q = quote ?? lastSwapQuoteOk;
  if (q) {
    const label = getQuoteYouPaySubLabel(q);
    if (label) return label;
  }
  const payUsd = estimateSwapPayUsdFromInput();
  const payUsdLabel = payUsd != null ? formatSwapPayUsdLabel(payUsd) : null;
  return payUsdLabel ? `≈ ${payUsdLabel}` : null;
}

function renderQuoteSummaryHeroTile(
  label: string,
  amt: string,
  sym: string,
  variant: 'pay' | 'receive',
  mint: string,
  sub?: string | null,
  placeholder = false,
  loading = false,
  valueHtml?: string,
): string {
  const amtCls = placeholder ? ' swap-quote-summary-amt--placeholder' : '';
  const subCls = placeholder ? ' swap-quote-summary-sub--placeholder' : '';
  const symCls = tokenSymColorClass(mint, sym);
  const boxCls = tokenBoxColorClass(mint, sym);
  const amtHtml =
    loading && placeholder ? renderLoadingSpinner('md') : escapeHtml(amt);
  const valueInner =
    valueHtml ??
    `<span class="swap-quote-summary-amt${amtCls}">${amtHtml}</span>
        <span class="swap-quote-summary-sym ${symCls}">${escapeHtml(sym)}</span>`;
  const subHtml =
    loading && placeholder && sub
      ? renderLoadingSpinner('sm')
      : sub
        ? escapeHtml(sub)
        : '';
  return `<div class="swap-quote-summary-tile swap-quote-summary-tile--hero swap-quote-summary-tile--${variant} ${boxCls}">
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
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
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
      ${renderQuoteSummaryHeroTile('You pay', hasPay ? payAmt : '—', inSym, 'pay', inMint, paySub, !hasPay, loading && !hasPay, payValueHtml)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', '—', outSym, 'receive', outMint, '≈ —', true, loading)}
    </div>`;
}

function renderQuoteSummary(quote: Record<string, unknown>): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const inMint = quoteInputMint(quote) ?? swapInputMintInput?.value.trim() ?? '';
  const outMint = quoteOutputMint(quote) ?? swapOutputMintInput?.value.trim() ?? '';
  const payAmt = getQuoteWalletPayLabelFromQuote(quote);
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  const payUsd = getQuotePayUsd(quote);
  const receiveUsd = getQuoteReceiveUsd(quote);
  const payUsdLabel = payUsd != null ? formatSwapPayUsdLabel(payUsd) : null;
  const receiveUsdLabel = receiveUsd != null ? formatSwapReceiveUsdLabel(receiveUsd) : null;
  const paySub = buildQuotePaySubLabel(quote);
  const payValueHtml = renderQuotePayHeroValueHtml(quote, inSym, payAmt);
  const receiveValueHtml = renderQuoteReceiveHeroValueHtml(quote, outSym, outAmt.display);
  const receiveSub = getQuoteYouReceiveSubLabel(quote);

  return `<div class="swap-quote-summary-primary">
      ${renderQuoteSummaryHeroTile('You pay', payAmt, inSym, 'pay', inMint, paySub, false, false, payValueHtml)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', outAmt.display, outSym, 'receive', outMint, receiveSub, false, false, receiveValueHtml)}
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

function renderRouteViaTradesLogPanel(): void {
  if (!swapRouteViaTradesLogEl) return;
  const raw = lastRawQuoteResponse as Record<string, unknown> | null;
  const meta = raw?._routeViaTrades as Record<string, unknown> | undefined;
  swapRouteViaTradesLogEl.innerHTML = swapQuoteFetching
    ? `<p class="routing-empty routing-empty--loading">${renderLoadingSpinner('sm')}</p>`
    : renderRouteViaTradesLogHtml(meta);
}

function renderRawResponsePanels(): void {
  renderRawJsonEl(swapRawQuoteResponseEl, lastRawQuoteResponse, 'No quote response yet.');
  renderRawJsonEl(
    swapRawSwapResponseEl,
    lastRawSwapResponse,
    'Build a swap to see the raw swap response.',
  );
  renderRouteViaTradesLogPanel();
  renderRouteOptionsPanel();
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
  swapQuoteDetailsRouteStepsEl.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a')) return;
    const details = target.closest<HTMLDetailsElement>('.swap-hop-step-details');
    if (!details || !swapQuoteDetailsRouteStepsEl.contains(details)) return;
    if (details.dataset.hopLocked === 'true') return;
    if (!target.closest('.swap-hop-step-details__summary')) return;

    const hops = [
      ...swapQuoteDetailsRouteStepsEl.querySelectorAll<HTMLDetailsElement>('.swap-hop-step-details'),
    ].filter((el) => el.dataset.hopLocked !== 'true');
    if (hops.length <= 1) return;

    e.preventDefault();
    if (details.open) return;
    for (const hop of hops) {
      hop.open = hop === details;
    }
  });
}

function bindQuoteDetailsPanelAccordion(): void {
  if (!swapQuoteDetailsBodyEl) return;
  if (swapQuoteDetailsBodyEl.dataset.panelAccordionBound === 'true') return;
  swapQuoteDetailsBodyEl.dataset.panelAccordionBound = 'true';
  swapQuoteDetailsBodyEl.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a')) return;
    const panel = target.closest<HTMLDetailsElement>('.swap-quote-details-collapsible');
    if (!panel || !swapQuoteDetailsBodyEl.contains(panel)) return;
    if (!target.closest('.swap-quote-details-collapsible__summary')) return;

    const panels = [
      ...swapQuoteDetailsBodyEl.querySelectorAll<HTMLDetailsElement>('.swap-quote-details-collapsible'),
    ];
    if (panels.length <= 1) return;

    e.preventDefault();
    if (panel.open) return;
    for (const p of panels) {
      p.open = p === panel;
    }
  });
}

function ensureDefaultQuoteDetailsPanelOpen(): void {
  if (!swapQuoteDetailsBodyEl) return;
  const panels = [
    ...swapQuoteDetailsBodyEl.querySelectorAll<HTMLDetailsElement>('.swap-quote-details-collapsible'),
  ];
  panels.forEach((panel, i) => {
    panel.open = i === 0;
  });
}

function openRoutePlanPanelIfClosed(): void {
  if (!swapQuoteDetailsBodyEl) return;
  const routePlanPanel = document.getElementById(
    'swapQuoteRoutePlanDetails',
  ) as HTMLDetailsElement | null;
  if (!routePlanPanel || routePlanPanel.open) return;

  const panels = [
    ...swapQuoteDetailsBodyEl.querySelectorAll<HTMLDetailsElement>('.swap-quote-details-collapsible'),
  ];
  for (const panel of panels) {
    panel.open = panel === routePlanPanel;
  }
}

function ensureFirstHopExpanded(): void {
  const hops =
    swapQuoteDetailsRouteStepsEl?.querySelectorAll<HTMLDetailsElement>('.swap-hop-step-details');
  if (!hops?.length) return;
  hops.forEach((el, i) => {
    if (el.dataset.hopLocked === 'true') {
      el.open = true;
      return;
    }
    el.open = i === 0;
  });
}

function syncRoutePlanStepsUi(): void {
  bindRoutePlanStepsAccordion();
  bindQuoteDetailsPanelAccordion();
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
  ensureDefaultQuoteDetailsPanelOpen();
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
    syncSwapQuoteButtonState();
  } catch {
    // Prefetch is best-effort; pair cards keep last known stats or em dashes.
  }
}

function clearSwapQuotePanel(): void {
  clearRouteMintCaches();
  if (swapSellFiatEl) swapSellFiatEl.textContent = '~$0.00';
  resetSwapQuoteToMock();
  if (swapPairCardsEl) {
    swapPairCardsEl.hidden = false;
    swapPairCardsEl.removeAttribute('aria-hidden');
  }
  if (swapQuoteError) clearInlineError(swapQuoteError);
}

function renderSwapQuoteUI(quote: Record<string, unknown>): void {
  setBuyReadoutLoading(false);
  setBuyFiatLoading(false);
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
  if (swapBuyFiatEl) {
    swapBuyFiatEl.textContent = receiveUsdLabel;
    swapBuyFiatEl.title = quoteOutputPriceSourceTitle(quote);
  }

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

function resolveSwapServiceFeePct(): number {
  if (swapEnableServiceFeeCheckbox?.checked !== true) return DEFAULT_SWAP_SERVICE_FEE_PCT;
  const raw = swapServiceFeeInput?.value.trim() ?? '';
  const n = raw ? Number(raw) : DEFAULT_SWAP_SERVICE_FEE_PCT;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SWAP_SERVICE_FEE_PCT;
}

function isVybeMaxSellSelected(mint: string): boolean {
  if (getSwapRouter() !== 'vybe' || !mint) return false;
  const maxInput = getMaxSellAmountForInput(mint);
  const currentUi = Number(swapAmountInput?.value.trim() ?? '');
  if (maxInput == null || !Number.isFinite(currentUi) || currentUi <= 0) return false;
  if (sellAmountMatchesVybeExactBalance(mint)) return true;
  return sellAmountRoughlyEqual(currentUi, maxInput, mint);
}

function vybeMarketDiscoveryActive(): boolean {
  return (
    getSwapRouter() === 'vybe' &&
    swapEnablePoolAddressCheckbox?.checked !== true &&
    swapEnableProtocolCheckbox?.checked !== true
  );
}

function collectSwapBuildOptions(): Record<string, unknown> {
  const slippage = swapSlippageInput ? Number(swapSlippageInput.value) : undefined;
  const router = getSwapRouter();
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const amountUi = Number(swapAmountInput?.value);
  const maxSellSelected = router === 'vybe' && isVybeMaxSellSelected(inputMint);
  const ataFromCache =
    router === 'vybe' &&
    isWalletBalanceCacheReady(wallet) &&
    inputMint &&
    outputMint &&
    Number.isFinite(amountUi) &&
    amountUi > 0
      ? buildSwapAtaHintsFromWalletCache({
          inputMint,
          outputMint,
          amountUi,
          router,
          maxSellSelected,
        })
      : null;

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
    marketFetchMode: vybeMarketDiscoveryActive()
      ? (swapMarketFetchModeSelect?.value.trim() as 'full' | 'trades' | 'markets' | 'rpc' | undefined) || 'full'
      : undefined,
    enumerateRoutes: vybeMarketDiscoveryActive()
      ? swapEnumerateRoutesCheckbox?.checked !== false
      : false,
    swapFee: resolveSwapServiceFeePct(),
    ...(ataFromCache
      ? {
          closeWsolAta: ataFromCache.closeWsolAta,
          ...(typeof ataFromCache.createOutputAta === 'boolean'
            ? { createOutputAta: ataFromCache.createOutputAta }
            : {}),
        }
      : {}),
    ...(ataFromCache?.closeInputAta ? { closeInputAta: true } : {}),
    ...(ataFromCache?.inputBalanceExact ? { inputBalanceExact: ataFromCache.inputBalanceExact } : {}),
    ...(ataFromCache?.inputDecimals != null ? { inputDecimals: ataFromCache.inputDecimals } : {}),
    ...(ataFromCache && ataFromCache.amountUi !== amountUi ? { amount: ataFromCache.amountUi } : {}),
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

function syncEnumeratedRoutesFromBody(body: Record<string, unknown>): void {
  const rvt = body._routeViaTrades as { routes?: Array<Record<string, unknown>> } | undefined;
  if (!Array.isArray(rvt?.routes) || rvt.routes.length === 0) {
    enumeratedRoutesUiState = null;
    lastVybeQuoteBodyForRoutes = null;
    return;
  }
  lastVybeQuoteBodyForRoutes = body;
  enumeratedRoutesUiState = {
    routes: rvt.routes.map((r, i) => ({
      index: Number(r.index ?? i),
      source: typeof r.source === 'string' ? r.source : undefined,
      candidate: r.candidate as EnumeratedRoutesUiState['routes'][0]['candidate'],
      quote: (r.quote as Record<string, unknown> | undefined) ?? undefined,
    })),
    selectedIndex: 0,
    expanded: false,
  };
}

function getQuoteBodyForActiveRoute(body: Record<string, unknown>): Record<string, unknown> {
  if (!enumeratedRoutesUiState?.routes.length) return body;
  const route =
    enumeratedRoutesUiState.routes.find((r) => r.index === enumeratedRoutesUiState!.selectedIndex) ??
    enumeratedRoutesUiState.routes[0];
  if (!route?.quote) return body;
  const routesMeta = (body._routeViaTrades as { routes?: Array<{ build?: unknown }> } | undefined)?.routes;
  const routeBuild = routesMeta?.find((r) => Number((r as { index?: number }).index) === route.index)?.build
    ?? routesMeta?.[route.index]?.build;
  return {
    ...body,
    ...route.quote,
    _build: routeBuild ?? body._build,
  };
}

function applyActiveRouteQuoteToUi(
  body: Record<string, unknown>,
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): void {
  const selectedRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  let quote = annotateQuoteRouterMeta(stripVybeQuoteMetadata(body), selectedRouter);
  quote = attachQuoteTokenPriceMeta(quote, inputMint, outputMint);
  if (!quote._walletPayDebitRaw) {
    const estimatedPay = estimateInputSideWalletPayDebitFromQuote(quote);
    if (estimatedPay) quote = { ...quote, _walletPayDebitRaw: estimatedPay };
  }
  lastSwapQuoteOk = quote;
  lastRawQuoteResponse = body;
  const buildTx = extractSwapBuildTransaction(body._build as Record<string, unknown> | undefined);
  if (buildTx && typeof body._builtAt === 'number') {
    lastRawSwapResponse = body._build;
    lastVybeBuild = {
      tx: buildTx,
      builtAt: body._builtAt as number,
      paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, amount, {
        ...buildOpts,
        routeIndex: enumeratedRoutesUiState?.selectedIndex ?? 0,
      }),
      buildPayload: body._build,
    };
  }
  renderRawResponsePanels();
  renderSwapQuoteUI(quote);
  renderRouteOptionsPanel();
  void enrichRouteLabels(quote);
  if (swapBuildBtn) syncBuildButtonState();
  syncSwapBuildResultFromQuote();
}

function selectEnumeratedRoute(index: number): void {
  if (!enumeratedRoutesUiState || !lastVybeQuoteBodyForRoutes) return;
  const route = enumeratedRoutesUiState.routes.find((r) => r.index === index);
  if (!route) return;
  enumeratedRoutesUiState = { ...enumeratedRoutesUiState, selectedIndex: index };
  const wallet = swapQuoteWalletSnapshot ?? swapWalletAddressInput?.value.trim() ?? '';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = Number(swapAmountInput?.value);
  if (!wallet || !inputMint || !outputMint || !Number.isFinite(amount)) return;
  const buildOpts = collectSwapBuildOptions();
  applyActiveRouteQuoteToUi(
    getQuoteBodyForActiveRoute(lastVybeQuoteBodyForRoutes),
    wallet,
    inputMint,
    outputMint,
    amount,
    buildOpts,
  );
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
  syncEnumeratedRoutesFromBody(body);
  const activeBody = getQuoteBodyForActiveRoute(body);
  const selectedRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  let quote = annotateQuoteRouterMeta(stripVybeQuoteMetadata(activeBody), selectedRouter);
  quote = attachQuoteTokenPriceMeta(quote, inputMint, outputMint);
  let effectiveAmount = amount;
  const inRaw = parseRawAmountDigits(activeBody.inAmount ?? quote.inAmount);
  if (inRaw) {
    quote = { ...quote, inAmount: inRaw };
    const synced = syncSellAmountInputFromInAmountRaw(inRaw, inputMint, amount);
    if (synced != null) effectiveAmount = synced;
  }
  lastSwapQuoteOk = quote;
  lastRawQuoteResponse = body;
  swapQuoteWalletSnapshot = wallet;
  if (!quote._walletPayDebitRaw) {
    const estimatedPay = estimateInputSideWalletPayDebitFromQuote(quote);
    if (estimatedPay) {
      quote = { ...quote, _walletPayDebitRaw: estimatedPay };
      lastSwapQuoteOk = quote;
    }
  }
  cacheVybeQuoteBuild(activeBody, wallet, inputMint, outputMint, effectiveAmount, {
    ...buildOpts,
    routeIndex: enumeratedRoutesUiState?.selectedIndex ?? 0,
  });
  if (swapQuoteError) clearInlineError(swapQuoteError);
  const rvt = body._routeViaTrades as {
    directRouteFailed?: boolean;
    lastError?: string;
    fallbackRouter?: string;
    unpinnedVybeRetry?: boolean;
    tradesUnavailable?: boolean;
    userMessage?: string;
  } | undefined;
  if (swapQuoteWarning) {
    if (rvt?.userMessage) {
      showInlineWarning(swapQuoteWarning, rvt.userMessage);
    } else if (rvt?.directRouteFailed && rvt.lastError) {
      let summary = 'Route via Trades: pinned pools unavailable';
      if (rvt.fallbackRouter === 'jupiter') summary += ' — fell back to Jupiter';
      else if (rvt.fallbackRouter === 'titan') summary += ' — fell back to Titan';
      else if (rvt.unpinnedVybeRetry) summary += ' — using Vybe auto-route';
      showInlineWarning(swapQuoteWarning, `${summary}. ${rvt.lastError}`);
    }
  }
  renderRawResponsePanels();
  renderSwapQuoteUI(quote);
  renderRouteOptionsPanel();
  openRoutePlanPanelIfClosed();
  void enrichRouteLabels(quote);
  if (swapBuildBtn) syncBuildButtonState();
  syncSwapBuildResultFromQuote();
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
    const resetAmount = resetSplSellAmountForRouterSwitch(inputMint, amount);
    return executeAggregatorQuoteAndBuild(wallet, inputMint, outputMint, resetAmount, {
      ...buildOpts,
      router: 'titan',
    });
  }
}

async function fetchAggregatorQuoteAndBuildOnce(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
  router: string,
): Promise<{
  quoteBody: Record<string, unknown>;
  swapBody: Record<string, unknown>;
  buildAmount: number;
  buildProvider: string;
}> {
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
  return { quoteBody, swapBody, buildAmount, buildProvider };
}

async function executeAggregatorQuoteAndBuild(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const originalAmount = amount;
  let attemptAmount = amount;
  let splSimStep = 0;
  let last:
    | Awaited<ReturnType<typeof fetchAggregatorQuoteAndBuildOnce>>
    | null = null;

  while (splSimStep < SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER) {
    last = await fetchAggregatorQuoteAndBuildOnce(
      wallet,
      inputMint,
      outputMint,
      attemptAmount,
      buildOpts,
      router,
    );

    if (router === 'jupiter' && last.buildProvider === 'titan') {
      if (!isRouterFallbackEnabled()) {
        throw jupiterRouteUnavailableError(false);
      }
      setSwapRouter('titan', { invalidateQuote: false });
      const resetAmount = resetSplSellAmountForRouterSwitch(inputMint, attemptAmount);
      return executeAggregatorQuoteAndBuild(wallet, inputMint, outputMint, resetAmount, {
        ...buildOpts,
        router: 'titan',
      });
    }

    const buildTx = extractSwapBuildTransaction(last.swapBody);
    const simFailed = swapSimulationFailed(
      last.swapBody._simulatedOutAmount as string | null | undefined,
      buildTx,
      last.swapBody,
    );
    if (!simFailed) {
      if (attemptAmount < originalAmount * 0.999) {
        rememberSplMaxSellAfterSimRetry(inputMint, attemptAmount, splSimStep);
        maybeShowSplSellReducedWarning(attemptAmount, inputMint, originalAmount);
      }
      applyAggregatorBuildToUi(
        last.quoteBody,
        last.swapBody,
        router,
        wallet,
        inputMint,
        outputMint,
        last.buildAmount,
        buildOpts,
      );
      if (!buildTx) {
        throw new Error('Swap build did not return a transaction.');
      }
      return { tx: buildTx, buildPayload: last.swapBody };
    }

    const nextAmount = nextSplSellRetryAmountUi(inputMint, last.buildAmount, splSimStep);
    if (nextAmount == null) break;

    splSimStep++;
    attemptAmount = nextAmount;
    setSwapSellAmountToBalance(attemptAmount, inputMint, true);
    maybeShowSplSellReducedWarning(attemptAmount, inputMint, originalAmount);
  }

  if (last) {
    applyAggregatorBuildToUi(
      last.quoteBody,
      last.swapBody,
      router,
      wallet,
      inputMint,
      outputMint,
      last.buildAmount,
      buildOpts,
    );
  }
  if (router === 'jupiter' && isRouterFallbackEnabled()) {
    const resetAmount = resetSplSellAmountForRouterSwitch(inputMint, originalAmount);
    setSwapRouter('titan', { invalidateQuote: false });
    return executeAggregatorQuoteAndBuild(wallet, inputMint, outputMint, resetAmount, {
      ...buildOpts,
      router: 'titan',
    });
  }
  throw new Error(
    'Swap simulation failed after reducing sell amount for fees. Try a lower amount.',
  );
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
    const synced = syncSellAmountInputFromInAmountRaw(inAmountRaw, inputMint, amount);
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
  openRoutePlanPanelIfClosed();
  void enrichRouteLabels(quote);
  if (swapBuildBtn) syncBuildButtonState();
  syncSwapBuildResultFromQuote();
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
  const originalAmount = amount;
  let attemptAmount = amount;
  let splSimStep = 0;
  let lastBody: VybeQuoteApiBody | null = null;
  const selectedRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());

  while (splSimStep < SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER) {
    const forceFullDetailsMints = [inputMint, outputMint].filter((m) => !quotedMintSession.has(m));
    const res = await fetchWithRetry('/api/trading/vybe-quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountAddress: wallet,
        amount: attemptAmount,
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
    lastBody = body;

    const inRaw = parseRawAmountDigits(body.inAmount);
    if (inRaw) {
      const synced = syncSellAmountInputFromInAmountRaw(inRaw, inputMint, attemptAmount);
      if (synced != null) attemptAmount = synced;
    }

    const fallbackRouter = detectVybeAggregatorFallbackRouter(body, selectedRouter);
    if (fallbackRouter) {
      return handoffVybeQuoteToAggregator(
        wallet,
        inputMint,
        outputMint,
        originalAmount,
        buildOpts,
        fallbackRouter,
      );
    }

    const buildTx = extractSwapBuildTransaction(body._build);
    const simFailed = swapSimulationFailed(
      body._simulatedOutAmount as string | null | undefined,
      buildTx,
      (body._build as Record<string, unknown> | undefined) ?? body,
    );
    if (!simFailed) {
      if (attemptAmount < originalAmount * 0.999) {
        rememberSplMaxSellAfterSimRetry(inputMint, attemptAmount, splSimStep);
        maybeShowSplSellReducedWarning(attemptAmount, inputMint, originalAmount);
      }
      applyVybeQuoteBodyToUi(body, wallet, inputMint, outputMint, originalAmount, buildOpts);
      if (!buildTx) {
        throw new Error('Vybe quote did not return a transaction.');
      }
      return { tx: buildTx, buildPayload: body._build as Record<string, unknown> };
    }

    const balanceUi = getWalletBalanceAmountUi(inputMint) ?? 0;
    if (
      selectedRouter === 'vybe' &&
      isRouterFallbackEnabled() &&
      !hasAcceptableVybeRouteQuote(body) &&
      balanceUi > 0 &&
      isNearMaxSellAmountUi(attemptAmount, balanceUi)
    ) {
      setSwapRouter('jupiter', { invalidateQuote: false });
      return requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, originalAmount, {
        ...buildOpts,
        router: 'jupiter',
      });
    }

    const nextAmount = nextSplSellRetryAmountUi(inputMint, attemptAmount, splSimStep);
    if (nextAmount == null) break;

    splSimStep++;
    attemptAmount = nextAmount;
    setSwapSellAmountToBalance(attemptAmount, inputMint, true);
    maybeShowSplSellReducedWarning(attemptAmount, inputMint, originalAmount);
  }

  const handoffRouter =
    lastBody != null ? detectVybeAggregatorFallbackRouter(lastBody, selectedRouter) : null;
  if (handoffRouter) {
    return handoffVybeQuoteToAggregator(
      wallet,
      inputMint,
      outputMint,
      originalAmount,
      buildOpts,
      handoffRouter,
    );
  }

  if (
    selectedRouter === 'vybe' &&
    isRouterFallbackEnabled() &&
    !(lastBody && hasAcceptableVybeRouteQuote(lastBody))
  ) {
    setSwapRouter('jupiter', { invalidateQuote: false });
    return requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, originalAmount, {
      ...buildOpts,
      router: 'jupiter',
    });
  }

  if (lastBody) {
    applyVybeQuoteBodyToUi(lastBody, wallet, inputMint, outputMint, originalAmount, buildOpts);
  }
  if (swapQuoteWarning && splSimStep > 0) {
    const sym =
      getCachedTokenMeta(inputMint)?.symbol ??
      HARDCODED_MINT_SYMBOLS[inputMint] ??
      inputMint.slice(0, 4).toUpperCase();
    showInlineWarning(
      swapQuoteWarning,
      `Could not simulate max ${sym} sell — reduce amount manually or try again.`,
    );
  }
  throw new Error(
    'Swap simulation failed after reducing sell amount for fees. Try a lower amount.',
  );
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
  const txs = extractSwapBuildTransactions(payload);
  return txs.length > 0 ? txs[txs.length - 1]! : null;
}

/** Ordered leg txs for quote-bridge routes: pre → main → post (each signed atomically). */
function extractSwapBuildTransactions(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload) return [];
  const details = payload.details as Record<string, unknown> | undefined;
  const pre =
    typeof payload.preSwapTransaction === 'string'
      ? payload.preSwapTransaction
      : typeof details?.preSwapTransaction === 'string'
        ? details.preSwapTransaction
        : '';
  const mainRaw = payload.tx ?? payload.transaction;
  const main = typeof mainRaw === 'string' ? mainRaw : '';
  const post =
    typeof payload.postSwapTransaction === 'string'
      ? payload.postSwapTransaction
      : typeof details?.postSwapTransaction === 'string'
        ? details.postSwapTransaction
        : '';
  const txs: string[] = [];
  if (pre.trim()) txs.push(pre.trim());
  if (main.trim()) txs.push(main.trim());
  if (post.trim()) txs.push(post.trim());
  return txs;
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
  /* A connected wallet is only needed when we will also sign; build-only
     quotes work from the typed address, same as Jupiter/Titan. */
  if (swapBuildMode === 'build-sign') {
    const connected = getBrowserWalletAddress();
    if (!connected) {
      return 'Connect your wallet to get a quote.';
    }
    if (connected !== wallet) {
      return 'Connected wallet does not match the address field.';
    }
  }
  return null;
}

async function fetchSwapQuote(): Promise<void> {
  if (!swapInputMintInput || !swapOutputMintInput || !swapAmountInput) return;
  if (!isSwapQuoteInputReady()) return;
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
    const totalBal = getWalletBalanceAmountUi(inputMint);
    if (totalBal != null && amount > totalBal) {
      clampSwapAmountInputToMax();
      syncSwapSellAmountUi();
      if (swapQuoteError) {
        showInlineError(
          swapQuoteError,
          `Amount exceeds wallet balance (${formatSwapInputAmountValue(totalBal, getMintDecimals(inputMint))}).`
        );
      }
      return;
    }
  }

  if (!isPartnerConfigValid()) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Enter a Partner ID or disable Partner.');
    return;
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

  try {
    const buildOpts = collectSwapBuildOptions();
    const quoteAmount =
      typeof buildOpts.amount === 'number' && Number.isFinite(buildOpts.amount)
        ? buildOpts.amount
        : amount;
    void refreshLowSolTradeWarning();

    if (router === 'vybe') {
      // Vybe quote builds on the server (balance check, prices, ix-builder) — no preflight.
      try {
        await requestVybeQuote(wallet, inputMint, outputMint, quoteAmount, buildOpts);
      } catch (quoteErr) {
        if (swapQuoteError) {
          showInlineError(
            swapQuoteError,
            quoteErr instanceof Error ? quoteErr.message : String(quoteErr),
          );
        }
        invalidateSwapQuoteUi();
      }
    } else {
      const forceFullDetailsMints = [inputMint, outputMint].filter((m) => !quotedMintSession.has(m));
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
        await requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, quoteAmount, buildOpts);
      } catch (quoteErr) {
        if (swapQuoteError) {
          showInlineError(
            swapQuoteError,
            quoteErr instanceof Error ? quoteErr.message : String(quoteErr),
          );
        }
        invalidateSwapQuoteUi();
      }
    }
  } catch (err) {
    if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
    invalidateSwapQuoteUi();
  } finally {
    swapQuoteFetching = false;
    setSwapQuoteButtonLoading(false);
    if (!lastSwapQuoteOk) {
      setBuyReadoutLoading(false);
      setBuyFiatLoading(false);
      setFooterStatsLoading(false);
    }
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
  syncSwapBuildResultPanel();
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
    syncSwapBuildResultPanel();
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

function getSelectedEnumeratedRouteCandidate():
  | NonNullable<EnumeratedRoutesUiState['routes'][0]['candidate']>
  | null {
  if (!enumeratedRoutesUiState?.routes.length) return null;
  const route =
    enumeratedRoutesUiState.routes.find((r) => r.index === enumeratedRoutesUiState!.selectedIndex) ??
    enumeratedRoutesUiState.routes[0];
  return route?.candidate ?? null;
}

/** Apply selected route pins to the build request only — never mutate manual pool/protocol UI fields. */
function mergeSelectedRoutePinIntoBuildOpts(opts: Record<string, unknown>): Record<string, unknown> {
  const candidate = getSelectedEnumeratedRouteCandidate();
  if (!candidate?.marketAddress?.trim()) return opts;
  const next: Record<string, unknown> = {
    ...opts,
    poolAddress: candidate.marketAddress.trim(),
    marketFetchMode: undefined,
    enumerateRoutes: false,
  };
  if (candidate.programAddress?.trim()) next.programAddress = candidate.programAddress.trim();
  if (candidate.protocol?.trim()) next.protocol = candidate.protocol.trim();
  return next;
}

function tryCachedVybeBuildTxForSelectedRoute(): {
  tx: string;
  buildPayload: Record<string, unknown>;
} | null {
  if (!lastVybeQuoteBodyForRoutes) return null;
  const activeBody = getQuoteBodyForActiveRoute(lastVybeQuoteBodyForRoutes);
  const buildPayload = activeBody._build as Record<string, unknown> | undefined;
  const tx = extractSwapBuildTransaction(buildPayload);
  if (!tx || !buildPayload) return null;
  return { tx, buildPayload };
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
  const buildOpts = mergeSelectedRoutePinIntoBuildOpts(collectSwapBuildOptions());
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());

  if (!swapBuildResultEl || !swapTxBase64El) return;
  if (swapQuoteError) clearInlineError(swapQuoteError);
  void refreshLowSolTradeWarning();
  if (swapBuildBtn) swapBuildBtn.disabled = true;

  try {
    let buildTx: string;
    let buildPayload: Record<string, unknown>;
    if (router === 'vybe') {
      const cached = tryCachedVybeBuildTxForSelectedRoute();
      if (cached) {
        buildTx = cached.tx;
        buildPayload = cached.buildPayload;
        lastRawSwapResponse = buildPayload;
        lastVybeBuild = {
          tx: buildTx,
          builtAt: Date.now(),
          paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, amount, buildOpts),
          buildPayload,
        };
        renderRawResponsePanels();
      } else {
        const resolved = await resolveVybeBuildTx(wallet, inputMint, outputMint, amount, buildOpts);
        buildTx = resolved.tx;
        buildPayload = resolved.buildPayload;
      }
    } else {
      const resolved = await resolveAggregatorBuildTx(wallet, inputMint, outputMint, amount, buildOpts);
      buildTx = resolved.tx;
      buildPayload = resolved.buildPayload;
    }
    if (swapBuildMode === 'build-sign') {
      const legTxs = extractSwapBuildTransactions(buildPayload);
      const toSign = legTxs.length > 0 ? legTxs : [buildTx];
      swapTxBase64El.value = await signSwapTransactionsBase64(toSign, true);
      syncSwapBuildResultPanel();
    } else {
      const legTxs = extractSwapBuildTransactions(buildPayload);
      const ok = await applyBuiltSwapTx(
        legTxs.length > 0 ? legTxs.join('\n\n') : buildTx,
        buildPayload,
      );
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

/** Sign one or more swap legs; multi-hop routes use signAllTransactions then send in order. */
async function signSwapTransactionsBase64(txStrings: string[], sendAfterSign = false): Promise<string> {
  const txs = txStrings.map((t) => t.trim()).filter(Boolean);
  if (txs.length === 0) {
    throw new Error('No transaction to sign.');
  }
  if (txs.length === 1) {
    return signSwapTransactionBase64(txs[0]!, sendAfterSign);
  }

  const provider = getSolanaWalletProvider();
  if (!provider?.signAllTransactions && !provider?.signTransaction) {
    throw new Error('Connected wallet cannot sign transactions.');
  }
  if (!provider.signAllTransactions) {
    throw new Error(
      'This route requires multiple transactions. Use a wallet that supports signAllTransactions (e.g. Phantom).',
    );
  }

  const prepared = await Promise.all(txs.map((t) => prepareSwapTxForSigning(t)));
  const signed = await provider.signAllTransactions!(prepared);

  if (sendAfterSign) {
    const connection = getBrowserConnection();
    let lastSig = '';
    for (const stx of signed) {
      lastSig = await connection.sendRawTransaction(stx.serialize(), { skipPreflight: false });
    }
    if (swapQuoteWarning) {
      showInlineWarning(
        swapQuoteWarning,
        txs.length > 1 ? `${txs.length} transactions sent (last: ${lastSig})` : `Transaction sent: ${lastSig}`,
      );
    }
    return signed.map((stx) => bytesToBase64(stx.serialize())).join('\n\n');
  }

  return signed.map((stx) => bytesToBase64(stx.serialize())).join('\n\n');
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

function updateWalletTotalUsdUi(): void {
  const wrap = swapWalletTotalUsdEl;
  const valEl = swapWalletTotalUsdValEl;
  if (!wrap || !valEl) return;

  const address = swapWalletAddressInput?.value.trim() ?? '';
  const needsWalletConnect = swapBuildMode === 'build-sign' || swapBuildMode === 'paste-sign';
  if (!needsWalletConnect) return;

  if (!address) {
    valEl.textContent = '—';
    return;
  }

  if (walletBalancesFetching) {
    valEl.textContent = '…';
    return;
  }
  valEl.textContent = formatWalletTotalUsd(getWalletTotalBalanceUsd());
}

function updateConnectWalletButtonUi(address: string, hasWallet: boolean): void {
  const btn = swapConnectWalletBtn;
  const tray = swapWalletTrayEl;
  const totalEl = swapWalletTotalUsdEl;
  const disconnectBtn = swapDisconnectWalletBtn;
  const iconEl = swapConnectWalletBtnIconEl;
  const textEl = swapConnectWalletBtnTextEl;
  if (!btn || !textEl) return;

  btn.classList.remove('swap-wallet-field-connect--connected', 'swap-wallet-field-connect--loading', 'swap-btn-3d--static');
  if (tray) tray.classList.toggle('swap-wallet-field-tray--connected', hasWallet && !walletConnectLoading);
  if (totalEl) totalEl.hidden = !hasWallet || walletConnectLoading;
  if (disconnectBtn) disconnectBtn.hidden = !hasWallet || walletConnectLoading;

  if (walletConnectLoading) {
    btn.disabled = true;
    btn.classList.add('swap-wallet-field-connect--loading');
    if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--spinner';
    textEl.textContent = 'Connecting…';
    updateWalletTotalUsdUi();
      return;
    }

  if (hasWallet) {
    btn.disabled = true;
    btn.classList.add('swap-wallet-field-connect--connected', 'swap-btn-3d--static');
    if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--wallet';
    textEl.textContent = truncate(address, 4, 4);
    updateWalletTotalUsdUi();
    return;
  }

  btn.disabled = false;
  if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--wallet';
  textEl.textContent = 'Connect wallet';
  updateWalletTotalUsdUi();
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

function syncSwapBuildResultPanel(): void {
  if (!swapBuildResultEl) return;

  const hasTx = Boolean(swapTxBase64El?.value.trim());
  const isBuildFlow = swapBuildMode === 'build' || swapBuildMode === 'build-sign';

  if (swapBuildMode === 'paste-sign') {
    swapBuildResultEl.hidden = !hasTx;
  } else if (isBuildFlow) {
    swapBuildResultEl.hidden = false;
  } else {
    swapBuildResultEl.hidden = true;
  }

  if (swapCopyTxBtn) swapCopyTxBtn.disabled = !hasTx;
}

function syncSwapBuildResultFromQuote(): void {
  const buildTx = lastVybeBuild?.tx?.trim() ?? '';
  if (swapTxBase64El) swapTxBase64El.value = buildTx;
  syncSwapBuildResultPanel();
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
  if (swapQuoteBtn) swapQuoteBtn.hidden = false;

  syncWalletFieldForMode();
  syncBuildButtonState();
  syncSwapQuoteButtonState();

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
        ? 'Applied when you click <strong>Get quote</strong> or <strong>Build &amp; sign swap</strong>.'
        : 'Applied when you click <strong>Get quote</strong> or <strong>Build swap (no signing)</strong>.';
    }
  }
  syncSwapBuildResultPanel();
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

/* Must run before any top-level init below — route-ui functions need deps wired. */
initRouteUi({
  getFormInputMint: () => swapInputMintInput?.value.trim() ?? '',
  getFormOutputMint: () => swapOutputMintInput?.value.trim() ?? '',
  getFormSwapAmount: () => swapAmountInput?.value ?? '',
  getSwapInSym,
  getSwapOutSym,
  getSwapRouter,
  getLastQuote: () => lastSwapQuoteOk,
  getQuoteWalletPayLabel,
  getWalletAddress: () => swapWalletAddressInput?.value.trim() ?? '',
  getWalletSnapshot: () => swapQuoteWalletSnapshot,
  getPairTokenStats: () => pairTokenStats,
  getMintDecimals,
  rawAmountToUiNumber,
  formatRawTokenAmount,
  formatSwapAmountValue,
  formatSwapAmount,
  formatFeeStackAmount,
  formatFeeEquivSmallAmount,
  formatFeeEquivUsdFiatDisplay,
  formatHopFeeTableUsdAmount,
  formatSwapPayUsdAmount,
  formatSwapReceiveUsdLabel,
  getQuoteSwapUsdValue,
  getQuoteReceiveUsd,
  quoteOutputUiAmount,
  quoteWalletPayUsd,
  quoteOutputPriceSourceTitle,
  escapeHtml,
  truncate,
  displaySymbol,
  renderLoadingSpinner,
  syncRoutePlanStepsUi,
  getEnumeratedRoutesState: () => enumeratedRoutesUiState,
  setEnumeratedRoutesExpanded: (expanded: boolean) => {
    if (enumeratedRoutesUiState) {
      enumeratedRoutesUiState = { ...enumeratedRoutesUiState, expanded };
    }
  },
  selectEnumeratedRoute,
  dom: {
    swapRouteOptionsEl,
    swapQuoteDetailsRoutingEl,
    swapQuoteDetailsRouteStepsEl,
    routingDialogBodyEl,
    routingDialogTitleEl,
    swapQuoteRouteSubtitleEl,
  },
});

wireBuildOptionToggle(swapEnablePartnerCheckbox, swapPartnerFieldEl, swapPartnerInput);
swapEnablePartnerCheckbox?.addEventListener('change', () => {
  syncServiceFeePartnerGate(hasValidSwapWallet());
  invalidateSwapQuoteAfterInputChange();
  syncSwapQuoteButtonState();
});
swapPartnerInput?.addEventListener('input', syncSwapQuoteButtonState);
swapPartnerInput?.addEventListener('change', syncSwapQuoteButtonState);
wireBuildOptionToggle(swapEnablePoolAddressCheckbox, swapPoolAddressFieldEl, swapPoolAddressInput);
wireBuildOptionToggle(swapEnableProtocolCheckbox, swapProtocolFieldEl, swapProtocolSelect);
swapMarketFetchModeSelect?.addEventListener('change', invalidateSwapQuoteAfterInputChange);
swapEnumerateRoutesCheckbox?.addEventListener('change', invalidateSwapQuoteAfterInputChange);

function syncServiceFeePartnerGate(walletValid = hasValidSwapWallet()): void {
  const partnerOn = swapEnablePartnerCheckbox?.checked === true;

  if (!partnerOn) {
    if (swapEnableServiceFeeCheckbox?.checked) {
      swapEnableServiceFeeCheckbox.checked = false;
    }
    if (swapServiceFeeFieldEl) swapServiceFeeFieldEl.hidden = true;
    if (swapServiceFeeInput) swapServiceFeeInput.value = '';
  }

  const blocked = !walletValid || !partnerOn;
  const lockedTitle = !walletValid
    ? SWAP_WALLET_LOCKED_TITLE
    : SWAP_SERVICE_FEE_PARTNER_LOCKED_TITLE;

  if (swapEnableServiceFeeCheckbox) {
    swapEnableServiceFeeCheckbox.disabled = blocked;
    swapEnableServiceFeeCheckbox.title = blocked ? lockedTitle : 'Add service fee percent on build';
  }
  if (swapServiceFeeInput) {
    const inputBlocked = blocked || swapEnableServiceFeeCheckbox?.checked !== true;
    swapServiceFeeInput.disabled = inputBlocked;
    swapServiceFeeInput.title = blocked ? lockedTitle : '';
  }
}

function wireServiceFeeToggle(): void {
  if (!swapEnableServiceFeeCheckbox || !swapServiceFeeFieldEl) return;
  const sync = (): void => {
    const on = swapEnableServiceFeeCheckbox.checked;
    swapServiceFeeFieldEl.hidden = !on;
    if (!on && swapServiceFeeInput) {
      swapServiceFeeInput.value = '';
    } else if (on && swapServiceFeeInput && !swapServiceFeeInput.value.trim()) {
      swapServiceFeeInput.value = String(DEFAULT_SWAP_SERVICE_FEE_PCT);
    }
    syncServiceFeePartnerGate();
    invalidateSwapQuoteAfterInputChange();
  };
  swapEnableServiceFeeCheckbox.addEventListener('change', sync);
  swapServiceFeeInput?.addEventListener('input', invalidateSwapQuoteAfterInputChange);
  swapServiceFeeInput?.addEventListener('change', invalidateSwapQuoteAfterInputChange);
  sync();
}

wireServiceFeeToggle();
syncServiceFeePartnerGate(hasValidSwapWallet());

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
swapWalletTotalUsdEl?.addEventListener('click', () => {
  tryOpenSellTokenPicker();
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
  swapFlipBtnEl.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const blockedReason = getFlipBlockedReason();
    if (blockedReason) {
      if (swapQuoteError) showInlineError(swapQuoteError, blockedReason);
      return;
    }
    if (swapQuoteError) clearInlineError(swapQuoteError);
    const flippedOutputAmountUi = parseFlipOutputAmountUi();
    invalidateSwapQuoteAfterInputChange();
    flipSellBuyTokens();
    afterSellBuyTokensFlipped(flippedOutputAmountUi);
  });
}

if (swapPasteOutputBtnEl && swapOutputMintInput) {
  swapPasteOutputBtnEl.addEventListener('click', async () => {
    if (!hasValidSwapWallet()) return;
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) return;
      invalidateSwapQuoteAfterInputChange();
      void ensureTokenMetaForMint(t).then(() => applySelectedToken(t, 'output'));
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
    syncFlipButtonState();
    void prefetchSwapPairPrices({ forceFullDetails: true });
  });
}

swapAmountInput?.addEventListener('input', () => {
  invalidateSwapQuoteAfterInputChange();
  clampSwapAmountInputToMax();
  syncSwapSellAmountUi();
  syncSellPctButtonsState();
});
swapAmountInput?.addEventListener('change', () => {
  invalidateSwapQuoteAfterInputChange();
  clampSwapAmountInputToMax();
  syncSwapSellAmountUi();
  syncSellPctButtonsState();
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
syncSwapQuoteButtonState();
