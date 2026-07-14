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
  computeSwapTxSizesBytes,
  computeNetworkFeeLamportsFromSwapTxStrings,
  estimateNetworkFeeLamportsForSwapTxs,
} from './swap-tx-network-fee.js';
import {
  buildSwapClientParams,
  getSwapMintQuoteReadinessIssues,
  ensureTokenCatalogLoaded,
  ensureTokenMetaForMint,
  getCachedTokenMeta,
  getTokenDecimalsFromCache,
  getWalletSellableAmountUi,
  buildSwapAtaHintsFromSessionBalances,
  isWalletBalanceCacheReady,
  getWalletBalanceAmountUi,
  getWalletBalanceListItem,
  maxSwapInputStringForWalletItem,
  isVybeFullSplSellAmount,
  amountExceedsWalletBalance,
  formatSwapInputAmountValueFloor,
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
  isNativeSolMint,
  isWsolMint,
  isNearMaxSellAmountUi,
  isAtMaxSellAmountUi,
  preferNativeSolMint,
  isSolOrStableMint,
  NATIVE_SOL_MINT,
  SOL_MIN_AUTO_PICK_TOTAL_UI,
  WSOL_MINT,
  setWalletBalanceStreamListener,
  initTokenPicker,
  openTokenPicker,
  closeTokenPicker,
  prefetchTokenMetas,
  prefetchWalletBalances,
  refreshWalletBalancesPanel,
  syncRefetchHoldingsBtn,
  renderChipTokenIcon,
  effectiveTokenIconSrc,
  resolveTokenLogoUrl,
  renderTokenIconImgHtml,
  tokenBoxColorClass,
  tokenSymColorClass,
  getTokenMintColorKind,
  routingTokenDotClass,
  saveTokenPriceStats,
  getSessionTokenPriceStats,
  applyResolvedTokenFromApi,
  walletItemValueUsd,
  mintsForPricePrefetch,
  dedupeMintsForPriceResolve,
  sessionQuotePricesFreshForMints,
  RESOLVE_PRICES_TTL_MS,
  persistWalletBalanceMetadata,
  clearSessionWalletBalances,
  getSessionWalletBalanceItems,
  type TokenPickerSide,
  type TokenPriceStats,
  type WalletBalanceListItem,
  lockPageScroll,
  unlockPageScroll,
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
  renderRouteSubtitleHtml,
  routerBrandFromId,
  renderRoutingDiagram,
  renderRoutingDiagramPlaceholder,
  renderNoLiquidityRoutingDiagram,
  renderNoLiquidityRouteOptionsPanel,
  renderQuoteRoutePlanSteps,
  renderQuoteRoutePlanStepsPlaceholder,
  quoteHasRoutePlan,
  renderQuoteRouteDiagramAndSteps,
  clearQuoteRouteDiagramAndSteps,
  renderRoutePanels,
  renderRouteOptionsPanel,
  isEnumeratedRouteSelectable,
  getRouteMarketWarning,
  bindRoutingDiagramZoomListeners,
  scheduleRoutingDiagramZoom,
  mountRoutingDiagram,
  clearRoutingDiagram,
  normalizeRouterId,
  routerDisplayLabel,
  getQuoteWalletCostBucketsUsd,
  getQuoteYouPaySubLabel,
  renderQuotePayHeroValueHtml,
  renderQuotePayHeroSubHtml,
  renderQuoteReceiveHeroValueHtml,
  renderQuoteReceiveHeroSubHtml,
  renderSignConfirmSummaryHtml,
  mintSymbolSync,
  type EnumeratedRoutesUiState,
} from './route-ui.js';
import {
  applyPriceImpactTierClass,
  clearPriceImpactTierClass,
  displayPriceImpactPct,
  formatPriceImpactPctMarketBox,
  formatPriceImpactPctWithArrow,
  parsePriceImpactPct,
} from './price-impact-tier.js';
import { wireSwapProtocolPicker, type ProtocolPickerHandle } from './protocol-picker.js';

interface TokenSymbolResponse {
  symbol?: string;
  decimals?: number;
  error?: string;
}


const MAX_FETCH_RETRIES = 5;
const FETCH_RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 90_000;
const VYBE_QUOTE_TX_REUSE_MS = 10_000;
const SWAP_TX_CONFIRM_POLL_MS = 1_000;
const SWAP_TX_CONFIRM_MAX_POLLS = 90;
const POST_TX_CONFIRM_WALLET_REFRESH_DELAY_MS = 500;
/** Default service fee % on build for Vybe, Jupiter, and Titan (0 = none). */
const DEFAULT_SWAP_SERVICE_FEE_PCT = 0;
/** Default buy token when selling a non-SOL/non-stable and output is invalid. */
const SWAP_DEFAULT_STABLE_OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Hardcoded mint → symbol; never fetch these from API. */
const HARDCODED_MINT_SYMBOLS: Record<string, string> = {
  [NATIVE_SOL_MINT]: 'SOL',
  So11111111111111111111111111111111111111112: 'WSOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
};

const HARDCODED_MINT_NAMES: Record<string, string> = {
  [NATIVE_SOL_MINT]: 'Solana',
  So11111111111111111111111111111111111111112: 'Wrapped SOL',
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
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', // JupUSD
  'yUSDX7W89jXWn4zzDPLnhykDymSjQSmpaJ8e4fjC1fg', // yUSD
]);
const STABLECOIN_USD_FALLBACK_PRICE = 1;

/** Default slippage tolerance percent (matches #swapSlippage input). */
const DEFAULT_SWAP_SLIPPAGE_PCT = 5;

/** Default sell-amount percent for SOL and stablecoins when auto-filling from wallet balance. */
const DEFAULT_SOL_STABLE_SELL_AMOUNT_PERCENT = 25;

/** Prefer native SOL, then USDC when auto-picking sell token from wallet balances. */
const SELL_TOKEN_PRIORITY_MINTS: readonly string[] = [
  NATIVE_SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
];

let walletBalanceFetchGen = 0;
let walletBalanceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let postTxConfirmRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let postTxConfirmRefreshPromise: Promise<void> | null = null;
let walletBalancesFetching = false;
let walletBalancesReadyFor = '';
let lastWalletBalanceFetchAddress = '';
let lastAutoAppliedWalletAddress = '';
let swapBalanceRecoveryInFlight = false;

const swapQuoteLoading = document.getElementById('swapQuoteLoading') as HTMLElement | null;
const swapQuoteError = document.getElementById('swapQuoteError') as HTMLElement | null;
const swapQuoteWarning = document.getElementById('swapQuoteWarning') as HTMLElement | null;
const swapRouteOptionsWarningEl = document.getElementById('swapRouteOptionsWarning') as HTMLElement | null;
const swapWalletAddressInput = document.getElementById('swapWalletAddress') as HTMLInputElement | null;
const swapInputMintInput = document.getElementById('swapInputMint') as HTMLInputElement | null;
const swapOutputMintInput = document.getElementById('swapOutputMint') as HTMLInputElement | null;
const swapAmountInput = document.getElementById('swapAmount') as HTMLInputElement | null;
const swapAmountDisplayEl = document.getElementById('swapAmountDisplay') as HTMLElement | null;
const swapInputTokenBtn = document.getElementById('swapInputTokenBtn') as HTMLButtonElement | null;
const swapOutputTokenBtn = document.getElementById('swapOutputTokenBtn') as HTMLButtonElement | null;
const swapInputTokenIconEl = document.getElementById('swapInputTokenIcon') as HTMLElement | null;
const swapOutputTokenIconEl = document.getElementById('swapOutputTokenIcon') as HTMLElement | null;
const swapSlippageInput = document.getElementById('swapSlippage') as HTMLInputElement | null;
const swapRouterInput = document.getElementById('swapRouter') as HTMLInputElement | null;
const swapRouterSwitchEl = document.getElementById('swapRouterSwitch') as HTMLElement | null;
const swapVybeFallbackRowEl = document.getElementById('swapVybeFallbackRow') as HTMLElement | null;
const ROUTER_FALLBACK_LOCKED_TITLE = 'Router fallback is enabled';
const swapRouterFallbackLabelEl = document.getElementById('swapRouterFallbackLabel') as HTMLElement | null;
const swapRouterFallbackSwitchEl = document.getElementById('swapRouterFallbackSwitch') as HTMLLabelElement | null;
const swapVybeFallbackCheckbox = document.getElementById('swapVybeFallback') as HTMLInputElement | null;
const swapGaslessCheckbox = document.getElementById('swapGasless') as HTMLInputElement | null;
const swapAutoSlippageCheckbox = document.getElementById('swapAutoSlippage') as HTMLInputElement | null;
const swapEnablePartnerCheckbox = document.getElementById('swapEnablePartner') as HTMLInputElement | null;
const swapPartnerFieldEl = document.getElementById('swapPartnerField') as HTMLElement | null;
const swapPartnerInput = document.getElementById('swapPartner') as HTMLInputElement | null;
const swapEnablePoolAddressCheckbox = document.getElementById('swapEnablePoolAddress') as HTMLInputElement | null;
const swapPoolAddressInput = document.getElementById('swapPoolAddress') as HTMLInputElement | null;
const swapEnableProtocolCheckbox = document.getElementById('swapEnableProtocol') as HTMLInputElement | null;
const swapProtocolSelect = document.getElementById('swapProtocol') as HTMLSelectElement | null;
const swapProtocolPickerRoot = document.getElementById('swapProtocolPicker');
const swapProtocolPicker: ProtocolPickerHandle | null =
  swapProtocolSelect && swapProtocolPickerRoot
    ? wireSwapProtocolPicker(swapProtocolSelect, swapProtocolPickerRoot)
    : null;
const swapEnableServiceFeeCheckbox = document.getElementById('swapEnableServiceFee') as HTMLInputElement | null;
const swapServiceFeeFieldEl = document.getElementById('swapServiceFeeField') as HTMLElement | null;
const swapServiceFeeInput = document.getElementById('swapServiceFee') as HTMLInputElement | null;
const swapMarketFetchModeSelect = document.getElementById('swapMarketFetchMode') as HTMLSelectElement | null;
const MARKET_FETCH_MODE = 'full' as const;
const MARKET_FETCH_MODE_LOCKED_TITLE = 'Market fetch is locked to Full';

function syncMarketFetchModeSelectLocked(): void {
  if (!swapMarketFetchModeSelect) return;
  swapMarketFetchModeSelect.value = MARKET_FETCH_MODE;
  swapMarketFetchModeSelect.disabled = true;
  swapMarketFetchModeSelect.title = MARKET_FETCH_MODE_LOCKED_TITLE;
}
const swapEnumerateRoutesCheckbox = document.getElementById('swapEnumerateRoutes') as HTMLInputElement | null;
const swapPinRouteCheckbox = document.getElementById('swapPinRoute') as HTMLInputElement | null;
const swapRouteDiscoveryRowEl = document.getElementById('swapRouteDiscoveryRow') as HTMLElement | null;
const swapRoutePinRowEl = document.getElementById('swapRoutePinRow') as HTMLElement | null;
const swapQuoteRouteOptionsEl = document.querySelector('.swap-quote-route-options') as HTMLElement | null;
const swapRouteOptionsEl = document.getElementById('swapRouteOptions') as HTMLElement | null;
const swapQuoteBtn = document.getElementById('swapQuoteBtn') as HTMLButtonElement | null;
const swapQuoteBtnTimerEl = document.getElementById('swapQuoteBtnTimer') as HTMLElement | null;
const swapQuoteBtnDebugEl = document.getElementById('swapQuoteBtnDebug') as HTMLElement | null;
const swapBuildBtn = document.getElementById('swapBuildBtn') as HTMLButtonElement | null;
const swapBuildBtnTimerEl = document.getElementById('swapBuildBtnTimer') as HTMLElement | null;

const SWAP_QUOTE_BTN_COOLDOWN_SEC = 5;
const SWAP_REFRESH_QUOTE_BTN_COOLDOWN_SEC = 5;
const SWAP_BUILD_BTN_QUOTE_TTL_SEC = 5;
/** Empty readout / fiat before quote or when price is unknown. */
const SWAP_UI_EMPTY = '—';

let swapQuoteBtnDebugEnabled = false;

let quoteBtnCooldownEndsAt = 0;
let quoteBtnCooldownRaf = 0;
let buildBtnQuoteValidUntil = 0;
let buildBtnQuoteRaf = 0;
const swapBuildResultEl = document.getElementById('swapBuildResult') as HTMLElement | null;
const swapTxBase64El = document.getElementById('swapTxBase64') as HTMLTextAreaElement | null;
const swapCopyTxBtn = document.getElementById('swapCopyTxBtn') as HTMLButtonElement | null;
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
const swapAdvancedBuildDetailsEl = document.getElementById('swapAdvancedBuild') as HTMLDetailsElement | null;
const swapQuoteSlippageRowEl = document.querySelector('.swap-quote-slippage-row') as HTMLElement | null;

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
const swapSignConfirmSummaryEl = document.getElementById('swapSignConfirmSummary') as HTMLElement | null;
const swapSignConfirmLogsEl = document.getElementById('swapSignConfirmLogs') as HTMLElement | null;
const swapSignConfirmCancelEl = document.getElementById('swapSignConfirmCancel') as HTMLButtonElement | null;
const swapSignConfirmDismissEl = document.getElementById('swapSignConfirmDismiss') as HTMLButtonElement | null;
const swapSignConfirmTxidsEl = document.getElementById('swapSignConfirmTxids') as HTMLElement | null;
const swapSignConfirmRefetchRetryEl = document.getElementById('swapSignConfirmRefetchRetry') as HTMLButtonElement | null;
const swapSignConfirmRoutePanelEl = document.getElementById(
  'swapSignConfirmRoutePanel',
) as HTMLElement | null;
const swapSignConfirmRoutingEl = document.getElementById(
  'swapSignConfirmRouting',
) as HTMLElement | null;
const swapSignConfirmRouteStepsEl = document.getElementById(
  'swapSignConfirmRouteSteps',
) as HTMLElement | null;
const routeWarningConfirmDialogEl = document.getElementById(
  'routeWarningConfirmDialog',
) as HTMLDialogElement | null;
const routeWarningConfirmMessageEl = document.getElementById(
  'routeWarningConfirmMessage',
) as HTMLElement | null;
const routeWarningConfirmMessageTextEl = document.getElementById(
  'routeWarningConfirmMessageText',
) as HTMLElement | null;
const routeWarningConfirmCancelEl = document.getElementById(
  'routeWarningConfirmCancel',
) as HTMLButtonElement | null;
const routeWarningConfirmDismissEl = document.getElementById(
  'routeWarningConfirmDismiss',
) as HTMLButtonElement | null;
const routeWarningConfirmOkEl = document.getElementById(
  'routeWarningConfirmOk',
) as HTMLButtonElement | null;
const swapPairCardsEl = document.getElementById('swapPairCards') as HTMLElement | null;
const swapQuoteDetailsEmptyEl = document.getElementById('swapQuoteDetailsEmpty') as HTMLElement | null;
const swapQuoteDetailsBodyEl = document.getElementById('swapQuoteDetailsBody') as HTMLElement | null;
const swapQuoteDetailsRoutingEl = document.getElementById('swapQuoteDetailsRouting') as HTMLElement | null;
const swapQuoteRouteSubtitleEl = document.getElementById('swapQuoteRouteSubtitle') as HTMLElement | null;
const swapQuoteDetailsFieldsEl = document.getElementById('swapQuoteDetailsFields') as HTMLElement | null;
const swapQuoteDetailsRouteStepsEl = document.getElementById('swapQuoteDetailsRouteSteps') as HTMLElement | null;
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

type SwapNoLiquidityStickyState = {
  inputMint: string;
  outputMint: string;
  rawError: string;
};
let swapNoLiquiditySticky: SwapNoLiquidityStickyState | null = null;

const STICKY_NO_DIRECT_POOLS_ERROR = 'No direct or 2 hop pools found for this pair';

function normalizeStickyRouteUnavailableError(rawError: string): string {
  const lower = rawError.trim().toLowerCase();
  if (
    lower.includes('no direct or quote-bridge pools') ||
    lower.includes('no direct or 2 hop pools')
  ) {
    return STICKY_NO_DIRECT_POOLS_ERROR;
  }
  return rawError.trim();
}

function isSimulationPoolQuoteError(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  return (
    m.includes('single-hop simulation failed') ||
    m.includes('ProgramFailedToComplete') ||
    m.includes('route simulation gate failed')
  );
}

function isStickyRouteUnavailableQuoteError(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (isSimulationPoolQuoteError(m)) return true;
  const lower = m.toLowerCase();
  return (
    lower.includes('no direct or quote-bridge pools') ||
    lower.includes('no direct or 2 hop pools') ||
    lower.includes('no pools found during scan') ||
    lower.includes('no markets from vybe') ||
    lower.includes('no usable markets from vybe') ||
    lower.includes('all pools failed') ||
    lower.includes('all vyberouter pools failed') ||
    lower.includes('vybe swap enumeration returned no routes') ||
    lower.includes('vybe rpc pool scan returned no routes') ||
    lower.includes('no_usable_vybe_pools') ||
    lower.includes('no_vybe_markets')
  );
}

function stickyRouteUnavailableDisplayTitle(rawError: string): string {
  if (isSimulationPoolQuoteError(rawError)) return 'No Liquidity Available';
  return normalizeStickyRouteUnavailableError(rawError);
}

function formatStickyRouteUnavailableInlineError(rawError: string): string {
  if (isSimulationPoolQuoteError(rawError)) {
    return `No Liquidity left in pool (error: "${rawError}")`;
  }
  return normalizeStickyRouteUnavailableError(rawError);
}

function currentSwapMintPair(): { inputMint: string; outputMint: string } {
  return {
    inputMint: swapInputMintInput?.value.trim() ?? '',
    outputMint: swapOutputMintInput?.value.trim() ?? '',
  };
}

function swapNoLiquidityStickyActiveForForm(): boolean {
  if (!swapNoLiquiditySticky) return false;
  const { inputMint, outputMint } = currentSwapMintPair();
  return (
    inputMint === swapNoLiquiditySticky.inputMint &&
    outputMint === swapNoLiquiditySticky.outputMint
  );
}

function clearSwapNoLiquidityStickyOnMintChange(): void {
  if (!swapNoLiquiditySticky) return;
  swapNoLiquiditySticky = null;
  if (swapQuoteError) clearInlineError(swapQuoteError);
  syncSwapQuoteButtonState();
}

function applySwapNoLiquidityStickyUi(rawError: string): void {
  const { inputMint, outputMint } = currentSwapMintPair();
  if (!inputMint || !outputMint) return;
  swapNoLiquiditySticky = { inputMint, outputMint, rawError };
  reapplySwapNoLiquidityStickyUi();
}

function reapplySwapNoLiquidityStickyUi(): void {
  if (!swapNoLiquidityStickyActiveForForm() || !swapNoLiquiditySticky) return;
  const { rawError, outputMint } = swapNoLiquiditySticky;
  const displayTitle = stickyRouteUnavailableDisplayTitle(rawError);
  if (swapQuoteError) {
    showInlineError(swapQuoteError, formatStickyRouteUnavailableInlineError(rawError));
  }
  if (swapQuoteSummaryEl) {
    swapQuoteSummaryEl.innerHTML = renderQuoteSummaryPlaceholder(false);
    swapQuoteSummaryEl.hidden = false;
  }
  mountRoutingDiagram(
    swapQuoteDetailsRoutingEl,
    renderNoLiquidityRoutingDiagram(outputMint, displayTitle),
  );
  if (swapQuoteDetailsRouteStepsEl) {
    swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanStepsPlaceholder(false);
  }
  if (swapRouteOptionsEl && swapRouteOptionsPanelActive()) {
    swapRouteOptionsEl.hidden = false;
    swapRouteOptionsEl.innerHTML = renderNoLiquidityRouteOptionsPanel(displayTitle);
  }
  if (swapQuoteDetailsFieldsEl) {
    swapQuoteDetailsFieldsEl.innerHTML = '<p class="routing-empty">—</p>';
  }
  setBuyReadoutLoading(false);
  setBuyFiatLoading(false);
  updateSwapPairCards(undefined, false);
  syncSwapQuoteButtonState();
}

function isSwapBalanceInsufficientError(msg: string): boolean {
  const m = msg.trim().toLowerCase();
  if (!m) return false;
  if (/insufficient liquidity/i.test(m)) return false;
  return (
    /insufficient balance/i.test(m) ||
    /amount exceeds wallet balance/i.test(m) ||
    /insufficientbalance/i.test(m) ||
    /balance too low/i.test(m) ||
    /not enough balance/i.test(m) ||
    (/no .+ in this wallet/i.test(m) && !/liquidity/i.test(m))
  );
}

function applyMaxSellAmountForMint(mint: string): boolean {
  if (!swapInputMintInput || !swapAmountInput) return false;
  const sellable = getWalletSellableForUi(mint);
  if (sellable == null || sellable <= 0) return false;

  if (getSwapRouter() === 'vybe' && !isNativeSolMint(mint)) {
    const item = getWalletBalanceListItem(mint);
    if (item && item.amountUi > 0) {
      if (swapQuoteError) clearInlineError(swapQuoteError);
      swapAmountInput.value = maxSwapInputStringForWalletItem(item);
      syncSwapAmountMaxFromBalance();
      swapAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }

  const maxInput = getMaxSellAmountForInput(mint) ?? sellable;
  if (!Number.isFinite(maxInput) || maxInput <= 0) return false;
  if (swapQuoteError) clearInlineError(swapQuoteError);
  setSwapSellAmountToBalance(maxInput, mint);
  return true;
}

function switchSellTokenToSolWithMaxAmount(): boolean {
  clearSwapNoLiquidityStickyOnMintChange();
  const positive = getSessionWalletBalanceItems().filter((i) => i.amountUi > 0);
  const solItem = findNativeSolBalanceItem(positive);
  if (solItem) {
    applySellTokenFromBalance(solItem, 'max');
    updateSwapPairCards();
    updateSwapTokenIcons();
    return true;
  }
  applySelectedToken(NATIVE_SOL_MINT, 'input');
  return applyMaxSellAmountForMint(NATIVE_SOL_MINT);
}

async function recoverSellAmountAfterBalanceError(failedMint: string): Promise<void> {
  if (swapBalanceRecoveryInFlight) return;
  const mint = failedMint.trim();
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (!mint || !hasValidSwapWallet()) return;
  if ((swapInputMintInput?.value.trim() ?? '') !== mint) return;

  swapBalanceRecoveryInFlight = true;
  try {
    await refreshWalletBalancesForSwap(wallet, false);
    if ((swapInputMintInput?.value.trim() ?? '') !== mint) return;

    updateSwapPairCards();
    updateSwapTokenIcons();

    const item = getWalletBalanceListItem(mint);
    const stillTradable =
      item != null && item.amountUi > 0 && isWalletTokenTradable(mint);

    const recovered = stillTradable
      ? applyMaxSellAmountForMint(mint)
      : switchSellTokenToSolWithMaxAmount();

    syncSwapSellAmountUi();
    syncSellPctButtonsState();
    syncSwapQuoteButtonState();
    void refreshLowSolTradeWarning();
    if (recovered && swapQuoteError) clearInlineError(swapQuoteError);
  } finally {
    swapBalanceRecoveryInFlight = false;
  }
}

function handleSwapQuoteFetchFailure(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  invalidateSwapQuoteUi();
  if (isStickyRouteUnavailableQuoteError(msg)) {
    applySwapNoLiquidityStickyUi(msg);
  } else if (swapQuoteError) {
    showInlineError(swapQuoteError, msg);
  }
  if (isSwapBalanceInsufficientError(msg)) {
    void recoverSellAmountAfterBalanceError(swapInputMintInput?.value.trim() ?? '');
  }
}

const quotedMintSession = new Set<string>();
let pairTokenStats: Record<string, TokenPriceStats> = {};

let walletConnectLoading = false;
let swapQuoteFetching = false;
/** Suppress client /api/tokens/resolve-prices during build/refetch/sign-retry flows. */
let suppressClientPriceResolve = 0;
let swapQuoteWalletSnapshot = '';
function pushSuppressClientPriceResolve(): void {
  suppressClientPriceResolve++;
}

function popSuppressClientPriceResolve(): void {
  suppressClientPriceResolve = Math.max(0, suppressClientPriceResolve - 1);
}

function clientPriceResolveSuppressed(): boolean {
  return suppressClientPriceResolve > 0;
}

/** Build-option changes keep route UI visible; quote refetches on Build & sign. */
let swapQuoteBuildOptsStale = false;
let lastSwapQuoteBuildOptsKey: string | null = null;
/** Wallet + mints + sell amount when the last quote succeeded — unchanged inputs → refresh selected route only. */
let lastSwapQuoteFormContextKey: string | null = null;
/** Whether the last Vybe quote used route enumeration (false = single-market fetch). */
let lastSwapQuoteEnumerateRoutes: boolean | null = null;

/** Per-router quote + route UI cached when switching routers without refetching. */
type SwapRouterId = 'vybe' | 'jupiter' | 'titan';

type RouterQuoteCache = {
  contextKey: string;
  enumeratedRoutesUiState: EnumeratedRoutesUiState | null;
  lastVybeQuoteBodyForRoutes: Record<string, unknown> | null;
  lastSwapQuoteOk: Record<string, unknown>;
  lastRawQuoteResponse: unknown;
  lastRawSwapResponse: unknown;
  lastVybeBuild: { tx: string; builtAt: number; paramsKey: string; buildPayload: unknown } | null;
  lastSwapQuoteBuildOptsKey: string | null;
  swapQuoteBuildOptsStale: boolean;
  lastSwapQuoteFormContextKey: string | null;
  lastSwapQuoteEnumerateRoutes: boolean | null;
  swapQuoteWalletSnapshot: string;
  quoteBtnCooldownEndsAt: number;
  buildBtnQuoteValidUntil: number;
};

const routerQuoteCaches: Partial<Record<SwapRouterId, RouterQuoteCache>> = {};

function isSwapRouterId(router: string): router is SwapRouterId {
  return router === 'vybe' || router === 'jupiter' || router === 'titan';
}

function clearAllRouterQuoteCaches(): void {
  for (const key of Object.keys(routerQuoteCaches) as SwapRouterId[]) {
    delete routerQuoteCaches[key];
  }
}

function clearRouterQuoteCache(router: SwapRouterId): void {
  delete routerQuoteCaches[router];
}

function renderLoadingSpinner(size: 'sm' | 'md' | 'lg' = 'sm'): string {
  return `<span class="inline-loading-spinner inline-loading-spinner--${size}" aria-hidden="true"></span>`;
}

function isPartnerModeEnabled(): boolean {
  return swapEnablePartnerCheckbox?.checked === true;
}

function partnerQuoteMissingFields(): { partnerId: boolean; serviceFee: boolean } {
  if (!isPartnerModeEnabled()) return { partnerId: false, serviceFee: false };
  const partnerIdMissing = !Boolean(swapPartnerInput?.value.trim());
  const feeEnabled = swapEnableServiceFeeCheckbox?.checked === true;
  const serviceFeeMissing = !feeEnabled || resolveSwapServiceFeePct() <= 0;
  return { partnerId: partnerIdMissing, serviceFee: serviceFeeMissing };
}

function isPartnerConfigValid(): boolean {
  const missing = partnerQuoteMissingFields();
  return !missing.partnerId && !missing.serviceFee;
}

function getPartnerQuoteDisabledReason(): string | null {
  if (!isPartnerModeEnabled()) return null;
  const missing = partnerQuoteMissingFields();
  if (missing.partnerId && missing.serviceFee) {
    return 'Partner: enter Partner ID and set service fee above 0%';
  }
  if (missing.partnerId) return 'Partner: enter Partner ID';
  if (missing.serviceFee) {
    return swapEnableServiceFeeCheckbox?.checked === true
      ? 'Partner: set service fee above 0%'
      : 'Partner: enable service fee';
  }
  return null;
}

function isPartnerQuoteBlockReason(reason: string | null): boolean {
  return reason !== null && reason.startsWith('Partner:');
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
  if (swapNoLiquidityStickyActiveForForm()) {
    return 'No liquidity in pool for this pair — change sell or buy token to quote again';
  }
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (!hasValidSwapWallet()) {
    return wallet ? `Invalid wallet address: "${truncate(wallet, 6, 4)}"` : 'No wallet address';
  }
  if (!isWalletBalancesGateOpen(wallet)) {
    if (walletBalancesFetching) return 'Wallet balances still loading';
    return `Balances not ready (readyFor=${walletBalancesReadyFor ? truncate(walletBalancesReadyFor, 4, 4) : '—'}, cache=${isWalletBalanceCacheReady(wallet)})`;
  }
  const sellMint = swapInputMintInput?.value.trim() ?? '';
  if (!sellMint) return 'No sell mint selected';
  const buyMint = swapOutputMintInput?.value.trim() ?? '';
  if (!buyMint) return 'No buy mint selected';
  const tokenMetaIssues = [
    ...getSwapMintQuoteReadinessIssues(sellMint, getSwapInSym()),
    ...getSwapMintQuoteReadinessIssues(buyMint, getSwapOutSym()),
  ];
  if (tokenMetaIssues.length > 0) {
    return `Waiting for token data: ${tokenMetaIssues.join(', ')}`;
  }
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
  const pinErr = getPinRouteQuoteDisabledReason();
  if (pinErr) return pinErr;
  const partnerErr = getPartnerQuoteDisabledReason();
  if (partnerErr) return partnerErr;
  if (isSwapQuoteRefreshMode() && !selectedRoutePinFields()) {
    return 'Select a route market before refreshing the quote.';
  }
  return null;
}

const PIN_ROUTE_MIN_MARKET_ADDRESS_LEN = 40;

/** Program id → Vybe protocol select value (mirrors pinned-swap-params). */
const PIN_ROUTE_PROGRAM_TO_PROTOCOL: Record<string, string> = {
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: 'METEORADBC',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'METEORADAMM2',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'METEORADLMM',
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: 'RAYDIUMLAUNCHLAB',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'RAYDIUMAMMV4',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'RAYDIUMCPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'RAYDIUMCLMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'PUMPFUN',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PUMPSWAP',
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx': 'SANCTUM',
};

function normalizePinProtocolKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s_-]+/g, '');
}

function resolvePinProtocolSelectValue(
  candidate: EnumeratedRoutesUiState['routes'][0]['candidate'] | null | undefined,
): string | null {
  if (!candidate || !swapProtocolSelect) return null;
  const protocolRaw = candidate.protocol?.trim();
  if (protocolRaw) {
    const key = normalizePinProtocolKey(protocolRaw);
    for (const opt of swapProtocolSelect.options) {
      if (opt.value && normalizePinProtocolKey(opt.value) === key) return opt.value;
    }
  }
  const program = candidate.programAddress?.trim();
  if (program && PIN_ROUTE_PROGRAM_TO_PROTOCOL[program]) {
    return PIN_ROUTE_PROGRAM_TO_PROTOCOL[program];
  }
  return null;
}

function applyEnumeratedRouteCandidateToPinFields(
  candidate: EnumeratedRoutesUiState['routes'][0]['candidate'] | null | undefined,
): void {
  if (!candidate || !isSwapRoutePinMode()) return;
  const market = candidate.marketAddress?.trim();
  if (market && swapPoolAddressInput) swapPoolAddressInput.value = market;
  const protocol = resolvePinProtocolSelectValue(candidate);
  if (protocol && swapProtocolSelect) {
    swapProtocolSelect.value = protocol;
    swapProtocolPicker?.syncFromSelect();
  }
}

function isPinRouteProtocolSelected(): boolean {
  return Boolean(swapProtocolSelect?.value.trim());
}

function isPinRouteMarketAddressValid(): boolean {
  return (swapPoolAddressInput?.value.trim() ?? '').length >= PIN_ROUTE_MIN_MARKET_ADDRESS_LEN;
}

function pinRouteQuoteMissingFields(): { market: boolean; protocol: boolean } {
  if (!isSwapRoutePinMode()) return { market: false, protocol: false };
  return {
    market: !isPinRouteMarketAddressValid(),
    protocol: !isPinRouteProtocolSelected(),
  };
}

function getPinRouteQuoteDisabledReason(): string | null {
  if (!isSwapRoutePinMode()) return null;
  const missing = pinRouteQuoteMissingFields();
  if (missing.market && missing.protocol) {
    return 'Direct market: enter market address (40+ chars) and select program';
  }
  if (missing.market) return 'Direct market: enter market address (40+ chars)';
  if (missing.protocol) return 'Direct market: select program/protocol';
  return null;
}

function isPinRouteQuoteBlockReason(reason: string | null): boolean {
  return reason !== null && reason.startsWith('Direct market:');
}

function isFlashOnlyQuoteBlockReason(reason: string | null): boolean {
  return isPinRouteQuoteBlockReason(reason) || isPartnerQuoteBlockReason(reason);
}

function flashSwapValidationField(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove('swap-pin-route-field--flash');
  void el.offsetWidth;
  el.classList.add('swap-pin-route-field--flash');
  el.addEventListener(
    'animationend',
    () => {
      el.classList.remove('swap-pin-route-field--flash');
    },
    { once: true },
  );
}

function flashPinRouteField(el: HTMLElement | null): void {
  flashSwapValidationField(el);
}

function flashPillSwitchTrack(checkbox: HTMLInputElement | null | undefined): void {
  if (!checkbox) return;
  const track = checkbox.nextElementSibling;
  if (track instanceof HTMLElement && track.classList.contains('swap-pill-switch__track')) {
    flashSwapValidationField(track);
  }
}

function flashPinRouteQuoteMissingFields(): void {
  const missing = pinRouteQuoteMissingFields();
  if (missing.market) flashPinRouteField(swapPoolAddressInput);
  if (missing.protocol) flashPinRouteField(swapProtocolPicker?.trigger ?? swapProtocolSelect);
}

function revealPartnerBuildOptions(): void {
  if (swapAdvancedBuildDetailsEl) swapAdvancedBuildDetailsEl.open = true;
}

function flashPartnerQuoteMissingFields(): void {
  const missing = partnerQuoteMissingFields();
  if (!missing.partnerId && !missing.serviceFee) return;
  revealPartnerBuildOptions();
  if (missing.partnerId) flashSwapValidationField(swapPartnerInput);
  if (missing.serviceFee) {
    if (swapEnableServiceFeeCheckbox?.checked === true) {
      flashSwapValidationField(swapServiceFeeInput);
    } else {
      flashPillSwitchTrack(swapEnableServiceFeeCheckbox);
    }
  }
}

function pinRouteQuoteHasMissingFields(): boolean {
  if (!isSwapRoutePinMode()) return false;
  const missing = pinRouteQuoteMissingFields();
  return missing.market || missing.protocol;
}

function partnerQuoteHasMissingFields(): boolean {
  if (!isPartnerModeEnabled()) return false;
  const missing = partnerQuoteMissingFields();
  return missing.partnerId || missing.serviceFee;
}

function tryFlashValidationFieldsOnQuoteAttempt(): boolean {
  const pinMissing = pinRouteQuoteHasMissingFields();
  const partnerMissing = partnerQuoteHasMissingFields();
  if (!pinMissing && !partnerMissing) return false;
  if (pinMissing) flashPinRouteQuoteMissingFields();
  if (partnerMissing) flashPartnerQuoteMissingFields();
  return true;
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
  if (!swapQuoteBtnDebugEl || !swapQuoteBtnDebugEnabled) {
    if (swapQuoteBtnDebugEl) {
      swapQuoteBtnDebugEl.hidden = true;
      swapQuoteBtnDebugEl.textContent = '';
    }
    return;
  }
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
    ` router=${getSwapRouter()}`,
  ].join('');
  if (swapQuoteBtn) swapQuoteBtn.title = diag.blockReason ?? '';
}

function isSwapQuoteInputReady(): boolean {
  const reason = getSwapQuoteDisabledReason();
  return reason === null || isFlashOnlyQuoteBlockReason(reason);
}

function isQuoteBtnInCooldown(): boolean {
  return quoteBtnCooldownEndsAt > performance.now();
}

function isBuildBtnQuoteExpired(): boolean {
  // validUntil <= 0 means no TTL started yet (e.g. mid-fetch) — not expired.
  if (buildBtnQuoteValidUntil <= 0) return false;
  return performance.now() >= buildBtnQuoteValidUntil;
}

function setActionBtnTimerVisible(
  btn: HTMLButtonElement | null,
  timerEl: HTMLElement | null,
  visible: boolean,
  durationSec?: number,
): void {
  if (!btn || !timerEl) return;
  timerEl.hidden = !visible;
  btn.classList.toggle('swap-action-btn--cooldown', visible);
  if (!visible) return;
  const progress = timerEl.querySelector('.swap-action-btn__timer-progress') as SVGCircleElement | null;
  if (progress && typeof durationSec === 'number' && Number.isFinite(durationSec)) {
    progress.style.animation = 'none';
    void progress.getBoundingClientRect();
    progress.style.setProperty('--swap-action-timer-duration', `${durationSec}s`);
    progress.style.animation = '';
  }
}

function clearQuoteBtnCooldown(): void {
  cancelAnimationFrame(quoteBtnCooldownRaf);
  quoteBtnCooldownRaf = 0;
  quoteBtnCooldownEndsAt = 0;
  setActionBtnTimerVisible(swapQuoteBtn, swapQuoteBtnTimerEl, false);
}

function clearBuildBtnQuoteWindow(): void {
  cancelAnimationFrame(buildBtnQuoteRaf);
  buildBtnQuoteRaf = 0;
  buildBtnQuoteValidUntil = 0;
  setActionBtnTimerVisible(swapBuildBtn, swapBuildBtnTimerEl, false);
}

function clearSwapActionCooldowns(): void {
  clearQuoteBtnCooldown();
  clearBuildBtnQuoteWindow();
}

function tickQuoteBtnCooldown(now: number): void {
  if (!swapQuoteBtn || quoteBtnCooldownEndsAt <= 0) return;
  const remainMs = quoteBtnCooldownEndsAt - now;
  if (remainMs <= 0) {
    clearQuoteBtnCooldown();
    syncSwapQuoteButtonState();
    return;
  }
  const label = swapQuoteBtnTimerEl?.querySelector('.swap-action-btn__timer-label');
  if (label) label.textContent = String(Math.max(1, Math.ceil(remainMs / 1000)));
  quoteBtnCooldownRaf = requestAnimationFrame(() => tickQuoteBtnCooldown(performance.now()));
}

function tickBuildBtnQuoteWindow(now: number): void {
  if (!swapBuildBtn || buildBtnQuoteValidUntil <= 0) return;
  const remainMs = buildBtnQuoteValidUntil - now;
  if (remainMs <= 0) {
    cancelAnimationFrame(buildBtnQuoteRaf);
    buildBtnQuoteRaf = 0;
    setActionBtnTimerVisible(swapBuildBtn, swapBuildBtnTimerEl, false);
    syncBuildButtonState();
    syncBuildButtonLabel();
    return;
  }
  const label = swapBuildBtnTimerEl?.querySelector('.swap-action-btn__timer-label');
  if (label) label.textContent = String(Math.max(1, Math.ceil(remainMs / 1000)));
  buildBtnQuoteRaf = requestAnimationFrame(() => tickBuildBtnQuoteWindow(performance.now()));
}

function startQuoteBtnCooldown(): void {
  if (!swapQuoteBtn || !swapQuoteBtnTimerEl) return;
  const durationSec = SWAP_QUOTE_BTN_COOLDOWN_SEC;
  quoteBtnCooldownEndsAt = performance.now() + durationSec * 1000;
  const label = swapQuoteBtnTimerEl.querySelector('.swap-action-btn__timer-label');
  if (label) label.textContent = String(durationSec);
  setActionBtnTimerVisible(swapQuoteBtn, swapQuoteBtnTimerEl, true, durationSec);
  swapQuoteBtn.disabled = true;
  cancelAnimationFrame(quoteBtnCooldownRaf);
  quoteBtnCooldownRaf = requestAnimationFrame(() => tickQuoteBtnCooldown(performance.now()));
}

function startRefreshQuoteBtnCooldown(): void {
  if (!swapQuoteBtn || !swapQuoteBtnTimerEl) return;
  const durationSec = SWAP_REFRESH_QUOTE_BTN_COOLDOWN_SEC;
  quoteBtnCooldownEndsAt = performance.now() + durationSec * 1000;
  const label = swapQuoteBtnTimerEl.querySelector('.swap-action-btn__timer-label');
  if (label) label.textContent = String(durationSec);
  setActionBtnTimerVisible(swapQuoteBtn, swapQuoteBtnTimerEl, true, durationSec);
  swapQuoteBtn.disabled = true;
  cancelAnimationFrame(quoteBtnCooldownRaf);
  quoteBtnCooldownRaf = requestAnimationFrame(() => tickQuoteBtnCooldown(performance.now()));
}

function startBuildBtnQuoteWindow(): void {
  if (!swapBuildBtn || !swapBuildBtnTimerEl) return;
  const durationSec = SWAP_BUILD_BTN_QUOTE_TTL_SEC;
  buildBtnQuoteValidUntil = performance.now() + durationSec * 1000;
  const label = swapBuildBtnTimerEl.querySelector('.swap-action-btn__timer-label');
  if (label) label.textContent = String(durationSec);
  setActionBtnTimerVisible(swapBuildBtn, swapBuildBtnTimerEl, true, durationSec);
  syncBuildButtonState();
  cancelAnimationFrame(buildBtnQuoteRaf);
  buildBtnQuoteRaf = requestAnimationFrame(() => tickBuildBtnQuoteWindow(performance.now()));
}

function startSwapActionCooldownsAfterQuote(opts?: { skipQuoteCooldown?: boolean }): void {
  if (!opts?.skipQuoteCooldown) {
    if (isSwapQuoteRefreshMode()) {
      startRefreshQuoteBtnCooldown();
    } else {
      startQuoteBtnCooldown();
    }
  }
  startBuildBtnQuoteWindow();
}

function currentSwapQuoteFormContextKey(): string | null {
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = parseSwapAmountInputValue(swapAmountInput?.value ?? '');
  if (!wallet || !inputMint || !outputMint || !Number.isFinite(amount) || amount <= 0) return null;
  return JSON.stringify({ wallet, inputMint, outputMint, amount });
}

function rememberSwapQuoteFormContextKey(): void {
  lastSwapQuoteFormContextKey = currentSwapQuoteFormContextKey();
}

function clearSwapQuoteFormContextKey(): void {
  lastSwapQuoteFormContextKey = null;
}

function rememberSwapQuoteEnumerateRoutes(buildOpts: Record<string, unknown>): void {
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  if (router !== 'vybe' || !vybeMarketDiscoveryActive()) {
    lastSwapQuoteEnumerateRoutes = null;
    return;
  }
  // Single-hop pinned refresh sends enumerateRoutes:false — do not clobber discovery tracking.
  if (
    buildOpts.enumerateRoutes === false &&
    String(buildOpts.poolAddress ?? '').trim() &&
    !isSelectedVybeMultiHopMarket()
  ) {
    return;
  }
  lastSwapQuoteEnumerateRoutes = buildOpts.enumerateRoutes !== false;
}

function clearSwapQuoteEnumerateRoutesTracking(): void {
  lastSwapQuoteEnumerateRoutes = null;
}

/** Single-market quote exists; user enabled route enumeration for the same pair/amount. */
function shouldRefetchMarketsAfterEnablingEnumeration(): boolean {
  if (!vybeMarketDiscoveryActive() || !isSwapEnumerateRoutesEnabled()) return false;
  if (!lastSwapQuoteOk || lastSwapQuoteEnumerateRoutes !== false) return false;
  const key = currentSwapQuoteFormContextKey();
  return key != null && key === lastSwapQuoteFormContextKey;
}

function isSwapEnumerateRoutesEnabled(): boolean {
  return vybeMarketDiscoveryActive() && swapEnumerateRoutesCheckbox?.checked !== false;
}

/** Same wallet/mints/amount as last quote — only input changes reset to Get quote(s). */
function isSwapQuoteRefreshMode(): boolean {
  if (normalizeRouterId(getSwapRouter()) !== 'vybe') return false;
  if (!lastSwapQuoteOk) return false;
  const key = currentSwapQuoteFormContextKey();
  return key != null && key === lastSwapQuoteFormContextKey;
}

function getSwapQuoteButtonLabel(): string {
  if (isSwapQuoteRefreshMode()) return 'Refetch quote for selected route';
  if (isSwapEnumerateRoutesEnabled()) return 'Get quotes (up to 3)';
  return 'Get quote';
}

function getSwapQuoteButtonHint(): string {
  if (isSwapQuoteRefreshMode()) return 'Update pricing for the selected market';
  if (isSwapEnumerateRoutesEnabled()) return 'Compare up to 3 routes';
  return 'Fetch route & pricing';
}

function updateSwapQuoteButtonLabel(): void {
  if (!swapQuoteBtn || swapQuoteBtn.classList.contains('swap-action-btn--loading')) return;
  const labelEl = swapQuoteBtn.querySelector('.swap-action-btn__label');
  const hintEl = swapQuoteBtn.querySelector('.swap-action-btn__hint');
  if (labelEl) labelEl.textContent = getSwapQuoteButtonLabel();
  if (hintEl) hintEl.textContent = getSwapQuoteButtonHint();
}

function syncSwapQuoteButtonState(): void {
  const diag = collectSwapQuoteBtnDiagnostics();
  if (!swapQuoteBtn || swapQuoteBtn.hidden) {
    console.debug('[swap-quote-btn]', { ...diag, note: 'button missing or hidden' });
    renderSwapQuoteBtnDebug(diag);
    return;
  }
  const hardBlocked =
    diag.blockReason !== null && !isFlashOnlyQuoteBlockReason(diag.blockReason);
  swapQuoteBtn.disabled =
    isSwapSignConfirmDialogOpen() || hardBlocked || isQuoteBtnInCooldown();
  if (swapQuoteBtn) {
    if (hardBlocked && diag.blockReason) swapQuoteBtn.title = diag.blockReason;
    else if (!isQuoteBtnInCooldown()) swapQuoteBtn.removeAttribute('title');
  }
  updateSwapQuoteButtonLabel();
  renderSwapQuoteBtnDebug(diag);
  console.debug('[swap-quote-btn]', diag);
  const w = getSolanaWindow();
  w.__swapQuoteBtnDebug = diag;
}

function setSwapQuoteButtonLoading(loading: boolean, opts?: { skipEnableSync?: boolean }): void {
  if (!swapQuoteBtn) return;
  swapQuoteBtn.classList.toggle('swap-action-btn--loading', loading);
  swapQuoteBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
  const labelEl = swapQuoteBtn.querySelector('.swap-action-btn__label');
  const hintEl = swapQuoteBtn.querySelector('.swap-action-btn__hint');
  if (labelEl) labelEl.textContent = loading ? 'Loading…' : getSwapQuoteButtonLabel();
  if (hintEl) hintEl.textContent = loading ? 'Fetching route & pricing' : getSwapQuoteButtonHint();
  if (loading) {
    swapQuoteBtn.disabled = true;
  } else if (!opts?.skipEnableSync && !isQuoteBtnInCooldown()) {
    syncSwapQuoteButtonState();
  }
}

function setFooterStatsLoading(loading: boolean): void {
  const html = loading ? renderLoadingSpinner('sm') : '—';
  if (swapFooterRateEl) swapFooterRateEl.innerHTML = html;
  if (swapFooterImpactEl) {
    clearPriceImpactTierClass(swapFooterImpactEl);
    swapFooterImpactEl.innerHTML = html;
  }
  if (swapFooterMinOutEl) swapFooterMinOutEl.innerHTML = html;
  if (swapFooterMaxSlippageEl) swapFooterMaxSlippageEl.innerHTML = html;
  if (swapRouteChipTextEl) swapRouteChipTextEl.innerHTML = html;
  if (swapRouteBtnEl) swapRouteBtnEl.disabled = true;
}

function formatIntegerWithGrouping(digits: string): string {
  const d = digits.replace(/^0+(?=\d)/, '') || '0';
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatAmountDisplayIntPart(intPartRaw: string): string {
  const cleaned = intPartRaw.replace(/,/g, '').trim();
  if (!cleaned) return intPartRaw;
  const neg = cleaned.startsWith('-');
  const digits = neg ? cleaned.slice(1) : cleaned;
  if (!/^\d+$/.test(digits)) return intPartRaw;
  const grouped = formatIntegerWithGrouping(digits);
  return neg ? `-${grouped}` : grouped;
}

function shouldUseSmallSwapAmountDecimals(value: string): boolean {
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized || normalized === '—') return false;
  const dot = normalized.indexOf('.');
  if (dot === -1) return false;
  const frac = normalized.slice(dot + 1);
  return frac.length > 0 && /\d/.test(frac);
}

function renderSwapAmountDisplayHtml(
  value: string,
  opts?: { groupThousands?: boolean },
): string {
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized || normalized === '—') return escapeHtml(value);

  const groupThousands = opts?.groupThousands !== false;
  const lastDot = normalized.lastIndexOf('.');
  const intPartRaw = lastDot === -1 ? normalized : normalized.slice(0, lastDot);
  const decPart = lastDot === -1 ? '' : normalized.slice(lastDot + 1);
  const intPart = groupThousands ? formatAmountDisplayIntPart(intPartRaw) : intPartRaw;

  if (!shouldUseSmallSwapAmountDecimals(normalized)) {
    if (lastDot === -1) return escapeHtml(intPart);
    return escapeHtml(`${intPart}.${decPart}`);
  }

  return `<span class="swap-amount-value"><span class="swap-amount-int">${escapeHtml(intPart)}</span><span class="swap-amount-frac"><span class="swap-amount-dot">.</span>${escapeHtml(decPart)}</span></span>`;
}

function syncSwapAmountDisplayOverlay(): void {
  if (!swapAmountDisplayEl || !swapAmountInput) return;
  if (document.activeElement === swapAmountInput) {
    swapAmountDisplayEl.innerHTML = '';
    return;
  }
  const raw = swapAmountInput.value.trim();
  swapAmountDisplayEl.innerHTML = raw
    ? renderSwapAmountDisplayHtml(raw, { groupThousands: true })
    : '';
}

function setSwapBuyAmountDisplay(
  display: string,
  opts?: { empty?: boolean; full?: string },
): void {
  if (!swapBuyAmountDisplayEl) return;
  if (swapBuyAmountDisplayEl.dataset.loading === 'true') return;
  swapBuyAmountDisplayEl.innerHTML = renderSwapAmountDisplayHtml(display, { groupThousands: true });
  if (opts?.empty !== undefined) {
    swapBuyAmountDisplayEl.dataset.empty = opts.empty ? 'true' : 'false';
  }
  if (opts?.full !== undefined) {
    if (opts.full) swapBuyAmountDisplayEl.title = opts.full;
    else swapBuyAmountDisplayEl.removeAttribute('title');
  }
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
    setSwapBuyAmountDisplay(SWAP_UI_EMPTY, { empty: true });
  }
}

function setBuyFiatLoading(loading: boolean): void {
  if (!swapBuyFiatEl) return;
  if (loading) {
    swapBuyFiatEl.innerHTML = renderLoadingSpinner('sm');
    return;
  }
  if (!lastSwapQuoteOk) swapBuyFiatEl.textContent = SWAP_UI_EMPTY;
}

function refreshPendingQuoteUi(loading = swapQuoteFetching): void {
  if (swapQuoteSummaryEl) {
    swapQuoteSummaryEl.innerHTML = renderQuoteSummaryPlaceholder(loading);
  }
  mountRoutingDiagram(swapQuoteDetailsRoutingEl, renderRoutingDiagramPlaceholder(loading));
  if (swapQuoteDetailsRouteStepsEl) {
    swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanStepsPlaceholder(loading);
  }
  renderRouteOptionsPanel();
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
  syncSwapSellAmountUi();
  syncSwapRouterSwitchState();
  syncBuildButtonState();
}

function clearSwapQuoteFetchLockClasses(): void {
  swapAmountInput?.closest('.swap-amount-field')?.classList.remove('swap-amount-field--locked');
  swapQuoteSlippageRowEl?.classList.remove('swap-quote-inputs--fetch-locked');
  swapQuoteRouteOptionsEl?.classList.remove('swap-quote-inputs--fetch-locked');
  swapAdvancedBuildDetailsEl?.classList.remove('swap-quote-inputs--fetch-locked');
  swapVybeFallbackRowEl?.classList.remove('swap-quote-inputs--fetch-locked');
}

function syncSwapAmountInputLockState(): void {
  if (!swapAmountInput || swapQuoteFetching) return;
  swapAmountInput.disabled = false;
  swapAmountInput.readOnly = false;
  swapAmountInput.title = 'Amount to sell';
}

function syncSwapWalletTrayLockState(): void {
  const fetching = swapQuoteFetching;
  const title = SWAP_QUOTE_FETCH_LOCKED_TITLE;
  if (swapWalletTotalUsdEl && !swapWalletTotalUsdEl.hidden) {
    swapWalletTotalUsdEl.disabled = fetching;
    if (fetching) swapWalletTotalUsdEl.title = title;
    else swapWalletTotalUsdEl.removeAttribute('title');
  }
  if (swapDisconnectWalletBtn && !swapDisconnectWalletBtn.hidden) {
    swapDisconnectWalletBtn.disabled = fetching;
    if (fetching) swapDisconnectWalletBtn.title = title;
    else swapDisconnectWalletBtn.removeAttribute('title');
  }
}

/** Lock swap inputs and build options while a quote fetch is in flight. */
function applySwapQuoteFetchLocks(): void {
  closeTokenPicker();
  const title = SWAP_QUOTE_FETCH_LOCKED_TITLE;

  lockTokenChipButton(swapInputTokenBtn, true, title);
  lockTokenChipButton(swapOutputTokenBtn, true, title);

  if (swapAmountInput) {
    swapAmountInput.disabled = true;
    swapAmountInput.readOnly = true;
    swapAmountInput.title = title;
  }
  swapAmountInput?.closest('.swap-amount-field')?.classList.add('swap-amount-field--locked');

  const pctContainer = document.getElementById('swapSellPctBtns');
  for (const btn of pctContainer?.querySelectorAll<HTMLButtonElement>('.swap-sell-pct-btn') ?? []) {
    btn.disabled = true;
    btn.title = title;
  }

  if (swapPasteOutputBtnEl) {
    swapPasteOutputBtnEl.disabled = true;
    swapPasteOutputBtnEl.title = title;
  }

  setWalletGatedDisabled(swapSlippageInput, true, title);
  setWalletGatedDisabled(swapAutoSlippageCheckbox, true, title);
  setWalletGatedDisabled(swapGaslessCheckbox, true, title);

  setWalletGatedDisabled(swapPinRouteCheckbox, true, title);
  setWalletGatedDisabled(swapEnumerateRoutesCheckbox, true, title);
  if (swapMarketFetchModeSelect) {
    swapMarketFetchModeSelect.disabled = true;
    swapMarketFetchModeSelect.title = title;
  }
  setWalletGatedDisabled(swapEnablePoolAddressCheckbox, true, title);
  setWalletGatedDisabled(swapEnableProtocolCheckbox, true, title);
  setWalletGatedDisabled(swapPoolAddressInput, true, title);
  setWalletGatedDisabled(swapProtocolSelect, true, title);
  swapProtocolPicker?.setDisabled(true, title);

  if (swapVybeFallbackCheckbox) {
    swapVybeFallbackCheckbox.disabled = true;
    swapVybeFallbackCheckbox.title = title;
  }
  swapVybeFallbackRowEl?.classList.add('swap-router-fallback-row--locked');

  setWalletGatedDisabled(swapEnablePartnerCheckbox, true, title);
  setWalletGatedDisabled(swapPartnerInput, true, title);
  setWalletGatedDisabled(swapEnableServiceFeeCheckbox, true, title);
  setWalletGatedDisabled(swapServiceFeeInput, true, title);

  swapQuoteSlippageRowEl?.classList.add('swap-quote-inputs--fetch-locked');
  swapQuoteRouteOptionsEl?.classList.add('swap-quote-inputs--fetch-locked');
  swapAdvancedBuildDetailsEl?.classList.add('swap-quote-inputs--fetch-locked');
  swapVybeFallbackRowEl?.classList.add('swap-quote-inputs--fetch-locked');
}

/** Disable router tabs and swap inputs while a quote fetch is in flight. */
function syncSwapRouterSwitchState(): void {
  const fetching = swapQuoteFetching;
  const routerLockTitle = 'Wait for the quote to finish before switching routers';
  for (const btn of swapRouterSwitchEl?.querySelectorAll<HTMLButtonElement>('[data-router]') ?? []) {
    btn.disabled = fetching;
    if (fetching) btn.title = routerLockTitle;
    else btn.removeAttribute('title');
  }
  if (swapRouterSwitchEl) {
    swapRouterSwitchEl.classList.toggle('swap-router-switch--locked', fetching);
    swapRouterSwitchEl.setAttribute('aria-busy', fetching ? 'true' : 'false');
  }

  if (fetching) {
    applySwapQuoteFetchLocks();
  } else {
    clearSwapQuoteFetchLockClasses();
    syncSellTokenPickerState();
    syncSwapAmountInputLockState();
  }

  syncSwapWalletTrayLockState();
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

type SwapRouteWarningLevel = 'none' | 'orange' | 'red';

const MIN_ROUTE_POOL_LIQUIDITY_USD = 1000;

function renderRouteWarningsHtml(level: Exclude<SwapRouteWarningLevel, 'none'>, message: string): string {
  const levelClass =
    level === 'red' ? ' swap-quote-simulation-warning--severe' : ' swap-quote-simulation-warning--caution';
  return `<div class="swap-quote-simulation-warning${levelClass}" role="status">
      <span class="swap-quote-simulation-warning__icon" aria-hidden="true">⚠</span>
      <span class="swap-quote-simulation-warning__text">${escapeHtml(message)}</span>
    </div>`;
}

function syncRouteOptionsWarningBanner(_quote: Record<string, unknown>): void {
  if (!swapRouteOptionsWarningEl) return;
  const state = enumeratedRoutesUiState;
  const route =
    state?.routes.find((r) => r.index === state.selectedIndex) ?? state?.routes[0] ?? null;
  const warning =
    state && route ? getRouteMarketWarning(state.routes, route, getSwapOutSym()) : null;
  if (!warning || warning.level === 'none' || !warning.message) {
    swapRouteOptionsWarningEl.hidden = true;
    swapRouteOptionsWarningEl.setAttribute('aria-hidden', 'true');
    swapRouteOptionsWarningEl.innerHTML = '';
    return;
  }
  swapRouteOptionsWarningEl.innerHTML = renderRouteWarningsHtml(warning.level, warning.message);
  swapRouteOptionsWarningEl.hidden = false;
  swapRouteOptionsWarningEl.removeAttribute('aria-hidden');
}

function syncSwapRouteWarnings(quote: Record<string, unknown>): void {
  syncRouteOptionsWarningBanner(quote);
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
  return sym === 'wSOL' ? 'WSOL' : sym;
}

async function fetchSymbol(mint: string): Promise<string> {
  const m = mint.trim();
  if (!m) return '—';
  const hard = HARDCODED_MINT_SYMBOLS[m];
  if (hard) return hard;
  const cachedMeta = getCachedTokenMeta(m)?.symbol?.replace(/\0/g, '').trim();
  if (cachedMeta) return displaySymbol(cachedMeta);
  const sessionSym = getSessionTokenPriceStats(m)?.symbol?.replace(/\0/g, '').trim();
  if (sessionSym) return displaySymbol(sessionSym);
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
  const cachedRouteSym = routeMintSymbolCache[m];
  let needSymbol = !cachedRouteSym || looksLikeTruncatedAddress(cachedRouteSym, m);
  let needDecimals = routeMintDecimalsCache[m] == null;
  const cachedMeta = getCachedTokenMeta(m);
  const sessionStats = getSessionTokenPriceStats(m);
  if (needSymbol) {
    const sym = cachedMeta?.symbol?.replace(/\0/g, '').trim() || sessionStats?.symbol?.replace(/\0/g, '').trim();
    if (sym && !looksLikeTruncatedAddress(sym, m)) {
      routeMintSymbolCache[m] = displaySymbol(sym);
      needSymbol = false;
    }
  }
  if (needDecimals) {
    const dec = cachedMeta?.decimals ?? sessionStats?.decimals;
    if (typeof dec === 'number' && Number.isFinite(dec)) {
      routeMintDecimalsCache[m] = dec;
      needDecimals = false;
    }
  }
  if (!needSymbol && !needDecimals) return;
  const res = await fetchWithRetry(
    `/api/token-symbol/${encodeURIComponent(m)}${needDecimals ? '?decimals=1' : ''}`,
  );
  const body = (await res.json().catch(() => ({}))) as TokenSymbolResponse;
  if (needSymbol) {
    const sym = (body.symbol ?? m).replace(/\0/g, '').trim();
    const resolved = displaySymbol(sym || truncate(m, 4, 4));
    if (!looksLikeTruncatedAddress(resolved, m) || !routeMintSymbolCache[m]) {
      routeMintSymbolCache[m] = resolved;
    }
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

function upgradeRouteMintSymbolCache(mint: string, symbol: string | undefined): void {
  const m = mint.trim();
  const sym = symbol?.replace(/\0/g, '').trim();
  if (!m || !sym || looksLikeTruncatedAddress(sym, m)) return;
  routeMintSymbolCache[m] = displaySymbol(sym);
}

function saveTokenPriceStatsForUi(mint: string, stats: TokenPriceStats): void {
  saveTokenPriceStats(mint, stats);
  upgradeRouteMintSymbolCache(mint, stats.symbol);
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
  // toFixed(14) can round tiny values to "0.00000000000000" → strip → "0."
  if (out === '0.' || (out === '0' && rounded > 0)) {
    out = rounded
      .toPrecision(sigFigs)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.0+$/, '');
  }
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
  if (v == null || v === '') return SWAP_UI_EMPTY;
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n) || n <= 0) return SWAP_UI_EMPTY;
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
  if (v == null || v === '') return SWAP_UI_EMPTY;
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n) || n <= 0) return SWAP_UI_EMPTY;
  return `~$${formatSwapLegUsdAmount(n)}`;
}

/** Buy-side fiat under the output token amount — pool output USD from ix-builder. */
function renderSwapBuyFiatHtml(quote: Record<string, unknown> | null): string {
  if (!quote) return SWAP_UI_EMPTY;
  const ui = quote._swapUiUsd as { buyBoxUsd?: number } | undefined;
  const enriched = quote._youReceive as { outUsd?: number } | undefined;
  const usd = ui?.buyBoxUsd ?? enriched?.outUsd;
  if (usd == null || !(Number(usd) > 0)) return SWAP_UI_EMPTY;
  return escapeHtml(formatSwapReceiveFiatDisplay(usd));
}

function parseSwapAmountInputValue(raw: string): number {
  const cleaned = raw.trim().replace(/,/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '-') return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function syncSwapSellAmountUi(): void {
  discardSwapQuoteIfPairMismatch();
  syncSwapAmountDisplayOverlay();
  const amount = parseSwapAmountInputValue(swapAmountInput?.value ?? '');
  const hasPositiveAmount = Number.isFinite(amount) && amount > 0;

  if (!hasPositiveAmount) {
    lastSwapQuoteOk = null;
    lastVybeBuild = null;
    if (swapBuildBtn) syncBuildButtonState();
    if (swapBuyAmountDisplayEl) {
      setSwapBuyAmountDisplay(SWAP_UI_EMPTY, { empty: true });
    }
    if (swapSellFiatEl) swapSellFiatEl.textContent = SWAP_UI_EMPTY;
    if (swapBuyFiatEl) swapBuyFiatEl.textContent = SWAP_UI_EMPTY;
    resetSwapQuoteDetailsPanel();
    if (swapFooterRateEl) swapFooterRateEl.textContent = '—';
    if (swapFooterImpactEl) {
      clearPriceImpactTierClass(swapFooterImpactEl);
      swapFooterImpactEl.textContent = '—';
    }
    if (swapFooterMinOutEl) swapFooterMinOutEl.textContent = '—';
    if (swapFooterMaxSlippageEl) swapFooterMaxSlippageEl.textContent = '—';
    setRouteChipLabel('—', true);
    clearRoutingDiagram(routingDialogBodyEl);
    syncSwapQuoteButtonState();
    return;
  }

  if (swapQuoteFetching) {
    const sellMint = swapInputMintInput?.value.trim() ?? '';
    const price = lookupMintPriceUsd(sellMint, lastSwapQuoteOk ?? {});
    if (sellMint && Number.isFinite(price) && price > 0 && swapSellFiatEl) {
      swapSellFiatEl.textContent = formatSwapPayFiatDisplay(amount * price);
    }
    // Keep the live quote (including route warnings) visible once vybe-quote returns,
    // even if swapQuoteFetching is still true until fetchSwapQuote's finally block runs.
    if (lastSwapQuoteOk) {
      setBuyReadoutLoading(false);
      setBuyFiatLoading(false);
      renderSwapQuoteUI(lastSwapQuoteOk);
      syncSwapQuoteButtonState();
      return;
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
      setSwapBuyAmountDisplay(outAmt.display, { empty: false, full: outAmt.full || undefined });
    }
    if (swapBuyFiatEl) {
      swapBuyFiatEl.innerHTML = renderSwapBuyFiatHtml(lastSwapQuoteOk);
    }
    if (swapSellFiatEl) {
      swapSellFiatEl.textContent = formatSwapPayFiatDisplay(getQuotePayUsd(lastSwapQuoteOk));
    }
    syncSwapQuoteButtonState();
    return;
  }

  if (swapBuyFiatEl) swapBuyFiatEl.textContent = SWAP_UI_EMPTY;
  const sellMint = swapInputMintInput?.value.trim() ?? '';
  const price = lookupMintPriceUsd(sellMint, lastSwapQuoteOk ?? {});
  if (!sellMint || !Number.isFinite(price) || price <= 0) {
    if (swapSellFiatEl) swapSellFiatEl.textContent = SWAP_UI_EMPTY;
    refreshSwapQuoteDetailsPlaceholders();
    syncSwapQuoteButtonState();
    return;
  }
  if (swapSellFiatEl) swapSellFiatEl.textContent = formatSwapPayFiatDisplay(amount * price);
  refreshSwapQuoteDetailsPlaceholders();
  syncSwapQuoteButtonState();
}

function resetSwapQuoteToMock(options?: { preserveRouterCaches?: boolean }): void {
  clearSwapActionCooldowns();
  swapQuoteFetching = false;
  setSwapQuoteButtonLoading(false);
  if (swapQuoteLoading) {
    swapQuoteLoading.hidden = true;
    swapQuoteLoading.setAttribute('aria-hidden', 'true');
  }
  lastSwapQuoteOk = null;
  lastVybeBuild = null;
  lastRawQuoteResponse = null;
  lastRawSwapResponse = null;
  enumeratedRoutesUiState = null;
  lastVybeQuoteBodyForRoutes = null;
  if (!options?.preserveRouterCaches) clearAllRouterQuoteCaches();
  clearSwapQuoteBuildOptsTracking();
  swapQuoteWalletSnapshot = '';
  if (swapBuildBtn) syncBuildButtonState();
  setFooterStatsLoading(false);
  setBuyReadoutLoading(false);
  setBuyFiatLoading(false);
  if (swapBuyAmountDisplayEl) {
    setSwapBuyAmountDisplay(SWAP_UI_EMPTY, { empty: true });
  }
  if (swapBuyFiatEl) swapBuyFiatEl.textContent = SWAP_UI_EMPTY;
  if (swapFooterRateEl) swapFooterRateEl.textContent = '—';
  if (swapFooterImpactEl) {
    clearPriceImpactTierClass(swapFooterImpactEl);
    swapFooterImpactEl.textContent = '—';
  }
  if (swapFooterMinOutEl) swapFooterMinOutEl.textContent = '—';
  if (swapFooterMaxSlippageEl) swapFooterMaxSlippageEl.textContent = '—';
  setRouteChipLabel('—', true);
  clearRoutingDiagram(routingDialogBodyEl);
  if (swapRouteOptionsWarningEl) {
    swapRouteOptionsWarningEl.hidden = true;
    swapRouteOptionsWarningEl.setAttribute('aria-hidden', 'true');
    swapRouteOptionsWarningEl.innerHTML = '';
  }
  if (swapTxBase64El) swapTxBase64El.value = '';
  syncSwapBuildResultPanel();
  resetSwapQuoteDetailsPanel();
  renderRouteOptionsPanel();
  renderRawResponsePanels();
  syncSwapSellAmountUi();
  syncSwapRouterSwitchState();
  updateSwapPairCards(undefined, false);
  if (swapNoLiquidityStickyActiveForForm()) {
    reapplySwapNoLiquidityStickyUi();
  }
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
  clearAllRouterQuoteCaches();
  if (!hasStaleSwapQuoteState()) return;
  resetSwapQuoteToMock();
}

function vybeRouteDiscoveryUiVisible(): boolean {
  return normalizeRouterId(getSwapRouter()) === 'vybe';
}

function isAggregatorRouter(): boolean {
  const router = normalizeRouterId(getSwapRouter());
  return router === 'jupiter' || router === 'titan';
}

function currentSwapQuoteRestoreContextKey(): string | null {
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = parseSwapAmountInputValue(swapAmountInput?.value ?? '');
  if (!wallet || !inputMint || !outputMint || !Number.isFinite(amount) || amount <= 0) return null;
  const slippage = swapSlippageInput ? Number(swapSlippageInput.value) : undefined;
  return JSON.stringify({
    wallet,
    inputMint,
    outputMint,
    amount,
    pin: isSwapRoutePinMode(),
    poolAddress: isSwapRoutePinMode() ? swapPoolAddressInput?.value.trim() ?? '' : '',
    protocol: isSwapRoutePinMode() ? swapProtocolSelect?.value.trim() ?? '' : '',
    opts: {
      slippage: Number.isFinite(slippage) ? slippage : undefined,
      gasless: swapGaslessCheckbox?.checked === true,
      autoCalculateSlippage: swapAutoSlippageCheckbox?.checked === true,
      partner:
        swapEnablePartnerCheckbox?.checked === true ? swapPartnerInput?.value.trim() || undefined : undefined,
      swapFee: resolveSwapServiceFeePct(),
      marketFetchMode: MARKET_FETCH_MODE,
      enumerateRoutes: swapEnumerateRoutesCheckbox?.checked !== false,
    },
  });
}

function hideVybeRouteDiscoveryPanels(): void {
  if (swapRouteOptionsEl) {
    swapRouteOptionsEl.hidden = true;
    swapRouteOptionsEl.innerHTML = '';
  }
  clearQuoteRouteDiagramAndSteps(false);
}

function restoreSwapActionTimersFromCache(cache: RouterQuoteCache): void {
  const now = performance.now();

  if (cache.quoteBtnCooldownEndsAt > now) {
    const remainSec = Math.max(1, Math.ceil((cache.quoteBtnCooldownEndsAt - now) / 1000));
    quoteBtnCooldownEndsAt = cache.quoteBtnCooldownEndsAt;
    const label = swapQuoteBtnTimerEl?.querySelector('.swap-action-btn__timer-label');
    if (label) label.textContent = String(remainSec);
    setActionBtnTimerVisible(swapQuoteBtn, swapQuoteBtnTimerEl, true, remainSec);
    if (swapQuoteBtn) swapQuoteBtn.disabled = true;
    cancelAnimationFrame(quoteBtnCooldownRaf);
    quoteBtnCooldownRaf = requestAnimationFrame(() => tickQuoteBtnCooldown(performance.now()));
  } else {
    clearQuoteBtnCooldown();
  }

  cancelAnimationFrame(buildBtnQuoteRaf);
  buildBtnQuoteRaf = 0;

  if (cache.buildBtnQuoteValidUntil > now) {
    const remainSec = Math.max(1, Math.ceil((cache.buildBtnQuoteValidUntil - now) / 1000));
    buildBtnQuoteValidUntil = cache.buildBtnQuoteValidUntil;
    const label = swapBuildBtnTimerEl?.querySelector('.swap-action-btn__timer-label');
    if (label) label.textContent = String(remainSec);
    setActionBtnTimerVisible(swapBuildBtn, swapBuildBtnTimerEl, true, remainSec);
    buildBtnQuoteRaf = requestAnimationFrame(() => tickBuildBtnQuoteWindow(performance.now()));
  } else if (cache.buildBtnQuoteValidUntil > 0) {
    // Quote TTL started but elapsed while on another router — keep expired state (do not zero:
    // buildBtnQuoteValidUntil <= 0 reads as "not started", not expired).
    buildBtnQuoteValidUntil = cache.buildBtnQuoteValidUntil;
    setActionBtnTimerVisible(swapBuildBtn, swapBuildBtnTimerEl, false);
  } else {
    clearBuildBtnQuoteWindow();
  }

  syncBuildButtonLabel();
}

function snapshotRouterQuoteForRouterSwitch(router: SwapRouterId): void {
  if (!lastSwapQuoteOk) {
    clearRouterQuoteCache(router);
    return;
  }
  const contextKey = currentSwapQuoteRestoreContextKey();
  if (!contextKey) return;
  routerQuoteCaches[router] = {
    contextKey,
    enumeratedRoutesUiState,
    lastVybeQuoteBodyForRoutes,
    lastSwapQuoteOk,
    lastRawQuoteResponse,
    lastRawSwapResponse,
    lastVybeBuild,
    lastSwapQuoteBuildOptsKey,
    swapQuoteBuildOptsStale,
    lastSwapQuoteFormContextKey,
    lastSwapQuoteEnumerateRoutes,
    swapQuoteWalletSnapshot,
    quoteBtnCooldownEndsAt,
    buildBtnQuoteValidUntil,
  };
}

function restoreRouterQuoteFromCache(router: SwapRouterId): boolean {
  const cache = routerQuoteCaches[router];
  if (!cache) return false;
  const contextKey = currentSwapQuoteRestoreContextKey();
  if (!contextKey || contextKey !== cache.contextKey) return false;

  enumeratedRoutesUiState = cache.enumeratedRoutesUiState;
  lastVybeQuoteBodyForRoutes = cache.lastVybeQuoteBodyForRoutes;
  lastSwapQuoteOk = cache.lastSwapQuoteOk;
  lastRawQuoteResponse = cache.lastRawQuoteResponse;
  lastRawSwapResponse = cache.lastRawSwapResponse;
  lastVybeBuild = cache.lastVybeBuild;
  lastSwapQuoteBuildOptsKey = cache.lastSwapQuoteBuildOptsKey;
  swapQuoteBuildOptsStale = cache.swapQuoteBuildOptsStale;
  lastSwapQuoteFormContextKey = cache.lastSwapQuoteFormContextKey;
  lastSwapQuoteEnumerateRoutes = cache.lastSwapQuoteEnumerateRoutes;
  swapQuoteWalletSnapshot = cache.swapQuoteWalletSnapshot;

  if ((!enumeratedRoutesUiState || !enumeratedRoutesUiState.routes.length) && lastVybeQuoteBodyForRoutes) {
    syncEnumeratedRoutesFromBody(lastVybeQuoteBodyForRoutes);
  }

  restoreSwapActionTimersFromCache(cache);
  renderSwapQuoteUI(lastSwapQuoteOk);
  renderRouteOptionsPanel();
  renderRawResponsePanels();
  if (router !== 'vybe') openRoutePlanPanelIfClosed();
  if (lastSwapQuoteOk) void enrichRouteLabels(lastSwapQuoteOk, { skipPricePrefetch: true });
  scheduleRoutingDiagramZoom();
  if (swapBuildBtn) syncBuildButtonState();
  syncSwapBuildResultFromQuote();
  syncSwapQuoteButtonState();
  return true;
}

function clearActiveRouterQuoteUiIfNoCache(router: SwapRouterId): void {
  if (restoreRouterQuoteFromCache(router)) return;
  resetSwapQuoteToMock({ preserveRouterCaches: true });
}

function quoteAffectingBuildOptsSnapshot(buildOpts: Record<string, unknown>): Record<string, unknown> {
  const poolPinned = String(buildOpts.poolAddress ?? '').trim().length > 0;
  const multiHopEnumerated =
    !poolPinned && buildOpts.enumerateRoutes === true && isSelectedVybeMultiHopMarket();
  return {
    slippage: buildOpts.slippage,
    gasless: buildOpts.gasless,
    autoCalculateSlippage: buildOpts.autoCalculateSlippage,
    partner: buildOpts.partner,
    swapFee: buildOpts.swapFee,
    marketFetchMode: multiHopEnumerated || !poolPinned ? buildOpts.marketFetchMode : undefined,
    enumerateRoutes: multiHopEnumerated ? true : poolPinned ? false : buildOpts.enumerateRoutes,
    router: buildOpts.router,
    ...(multiHopEnumerated
      ? { routeIndex: enumeratedRoutesUiState?.selectedIndex ?? 0 }
      : {}),
  };
}

/** Same wallet/mints/amount/build opts key used when quoting and when building. */
function currentSwapQuoteTrackingKey(): string | null {
  const wallet = swapQuoteWalletSnapshot ?? swapWalletAddressInput?.value.trim() ?? '';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amountUi = swapAmountInput ? parseSwapAmountInputValue(swapAmountInput.value) : NaN;
  if (!inputMint || !outputMint || !Number.isFinite(amountUi)) return null;
  const buildOpts = mergeSelectedRoutePinIntoBuildOpts(collectSwapBuildOptions());
  const amount =
    typeof buildOpts.amount === 'number' && Number.isFinite(buildOpts.amount)
      ? buildOpts.amount
      : amountUi;
  return quoteAffectingBuildOptsKey(wallet, inputMint, outputMint, amount, buildOpts);
}

function quoteAffectingBuildOptsKey(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): string {
  return JSON.stringify({
    wallet,
    inputMint,
    outputMint,
    amount,
    opts: quoteAffectingBuildOptsSnapshot(buildOpts),
  });
}

function rememberSwapQuoteBuildOptsKey(): void {
  swapQuoteBuildOptsStale = false;
  lastSwapQuoteBuildOptsKey = currentSwapQuoteTrackingKey();
}

function clearSwapQuoteBuildOptsTracking(): void {
  swapQuoteBuildOptsStale = false;
  lastSwapQuoteBuildOptsKey = null;
  clearSwapQuoteFormContextKey();
  clearSwapQuoteEnumerateRoutesTracking();
}

/** Slippage, gasless, discovery, partner/fee, etc. — keep diagram + market cards. */
function markSwapQuoteBuildOptsStale(): void {
  if (swapQuoteFetching) return;
  if (!lastSwapQuoteOk) return;
  swapQuoteBuildOptsStale = true;
  lastVybeBuild = null;
  lastRawSwapResponse = null;
  syncBuildButtonState();
}

function canUseCachedRouteBuildWithoutRefetch(): boolean {
  if (isBuildBtnQuoteExpired()) return false;
  if (swapQuoteBuildOptsStale) return false;
  if (tryCachedVybeBuildTxForSelectedRoute() != null) return true;
  if (!lastSwapQuoteOk || !lastVybeBuild?.tx?.trim()) return false;
  const key = currentSwapQuoteTrackingKey();
  if (!key || !lastSwapQuoteBuildOptsKey || lastSwapQuoteBuildOptsKey !== key) return false;
  const wallet = swapQuoteWalletSnapshot ?? swapWalletAddressInput?.value.trim() ?? '';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amountUi = swapAmountInput ? parseSwapAmountInputValue(swapAmountInput.value) : NaN;
  if (!wallet || !inputMint || !outputMint || !Number.isFinite(amountUi)) return false;
  const buildOpts = mergeSelectedRoutePinIntoBuildOpts(collectSwapBuildOptions());
  const amount =
    typeof buildOpts.amount === 'number' && Number.isFinite(buildOpts.amount)
      ? buildOpts.amount
      : amountUi;
  const paramsKey = vybeBuildParamsKey(wallet, inputMint, outputMint, amount, vybeCacheBuildOpts(buildOpts));
  return isQuoteBuildTxWithinTtl(paramsKey);
}

function needsQuoteRefetchBeforeBuild(): boolean {
  if (!lastSwapQuoteOk) return false;
  if (canUseCachedRouteBuildWithoutRefetch()) return false;
  if (swapQuoteBuildOptsStale) return true;
  const key = currentSwapQuoteTrackingKey();
  if (!key || !lastSwapQuoteBuildOptsKey) return false;
  return lastSwapQuoteBuildOptsKey !== key;
}

async function refetchSwapQuoteBeforeBuild(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<void> {
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const pinnedOpts = swapBuildOptsForRefetchQuote(
    mergeSelectedRoutePinIntoBuildOpts(buildOpts),
  );
  if (enumeratedRoutesUiState?.routes.length && !selectedRoutePinFields()) {
    throw new Error('Select a route market before refetching the quote.');
  }
  const quoteAmount =
    typeof pinnedOpts.amount === 'number' && Number.isFinite(pinnedOpts.amount)
      ? pinnedOpts.amount
      : amount;

  await ensureResolvePricesBeforeQuote(inputMint, outputMint, { force: true });

  swapQuoteFetching = true;
  pushSuppressClientPriceResolve();
  syncSwapRouterSwitchState();
  syncSwapQuoteButtonState();
  syncBuildButtonState();
  try {
    if (router === 'vybe') {
      const walletErr = validateVybeQuoteWallet();
      if (walletErr) throw new Error(walletErr);
      await requestVybeQuote(wallet, inputMint, outputMint, quoteAmount, pinnedOpts, {
        skipEnsurePrices: true,
      });
    } else {
      await requestAggregatorQuoteAndBuild(wallet, inputMint, outputMint, quoteAmount, pinnedOpts);
    }
    if (!lastSwapQuoteOk) {
      throw new Error('Quote refresh failed before build.');
    }
    rememberSwapQuoteBuildOptsKey();
    startBuildBtnQuoteWindow();
  } finally {
    swapQuoteFetching = false;
    popSuppressClientPriceResolve();
    syncSwapRouterSwitchState();
    syncSwapQuoteButtonState();
    syncBuildButtonState();
  }
}

function onSwapBuildOptionChanged(): void {
  markSwapQuoteBuildOptsStale();
  syncSwapQuoteButtonState();
}

function onEnumerateRoutesChanged(): void {
  if (swapEnumerateRoutesCheckbox?.checked === false) {
    if (!swapQuoteBuildOptsStale && tryCachedVybeBuildTxForSelectedRoute()) {
      rememberSwapQuoteBuildOptsKey();
    } else {
      markSwapQuoteBuildOptsStale();
    }
  } else {
    markSwapQuoteBuildOptsStale();
    if (
      !swapQuoteFetching &&
      shouldRefetchMarketsAfterEnablingEnumeration() &&
      isSwapQuoteInputReady()
    ) {
      void fetchSwapQuote();
      return;
    }
  }
  syncSwapQuoteButtonState();
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
const SWAP_QUOTE_FETCH_LOCKED_TITLE = 'Wait for the quote to finish before changing this';
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
  swapFlipBtnEl.disabled = false;
  swapFlipBtnEl.classList.remove('swap-flip-fab--blocked');
  swapFlipBtnEl.removeAttribute('aria-disabled');
  swapFlipBtnEl.title = 'Flip tokens';
  if (getFlipBlockedReason() === null) clearFlipInlineErrorIfShown();
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
  syncRouterFallbackToggleUi();
  setWalletGatedDisabled(swapPinRouteCheckbox, !valid);
  syncSwapRoutePinMode(valid);
  setWalletGatedDisabled(swapEnablePartnerCheckbox, !valid);
  setWalletGatedDisabled(swapPartnerInput, !valid);
  syncServiceFeePartnerGate(valid);

  syncSlippageInputForAutoSlippage();
  syncSellPctButtonsState();
}

function getMaxSellPercentForMint(_mint: string): number {
  return 100;
}

function getDefaultSellAmountPercentForMint(mint: string, symbolHint?: string): number {
  const kind = getTokenMintColorKind(mint, symbolHint);
  return kind === 'sol' || kind === 'stable'
    ? DEFAULT_SOL_STABLE_SELL_AMOUNT_PERCENT
    : getMaxSellPercentForMint(mint);
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
  const input = swapAmountInput.value.trim().replace(/,/g, '');
  if (!input) return false;
  if (input === exact) return true;
  const inputUi = parseSwapAmountInputValue(input);
  return Number.isFinite(inputUi) && sellAmountRoughlyEqual(inputUi, item!.amountUi, mint);
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
  if (swapQuoteFetching) return;
  const mint = swapInputMintInput?.value.trim() ?? '';
  const walletReady =
    hasValidSwapWallet() && mint.length > 0 && (getWalletSellableForUi(mint) ?? 0) > 0;
  const currentUi = parseSwapAmountInputValue(swapAmountInput?.value ?? '');
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
    btn.disabled = !walletReady;
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
  if (swapQuoteFetching) return;
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
    if (item && item.amountUi > 0) {
      if (swapQuoteError) clearInlineError(swapQuoteError);
      swapAmountInput!.value = maxSwapInputStringForWalletItem(item);
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
  return formatSwapInputAmountValueFloor(amount, decimals);
}

/** Max sell amount as stored in the amount input (never rounds above wallet balance). */
function getMaxSellAmountForInput(mint: string): number | null {
  const item = getWalletBalanceListItem(mint);
  const sellable = getWalletSellableForUi(mint);
  if (sellable == null || sellable <= 0) return null;
  if (item && getSwapRouter() === 'vybe' && !isNativeSolMint(mint)) {
    const formatted = maxSwapInputStringForWalletItem(item);
    const parsed = Number(formatted);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : sellable;
  }
  const formatted = formatSwapInputAmountValueFloor(sellable, getMintDecimals(mint));
  const parsed = Number(formatted);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : sellable;
}

function findNativeSolBalanceItem(items: WalletBalanceListItem[]): WalletBalanceListItem | null {
  const native = items.find((i) => i.mintAddress === NATIVE_SOL_MINT);
  if (!native || native.amountUi < SOL_MIN_AUTO_PICK_TOTAL_UI) return null;
  return { ...native, symbol: 'SOL' };
}

function pickDefaultSellBalance(items: WalletBalanceListItem[]): WalletBalanceListItem | null {
  const positive = items.filter((i) => i.amountUi > 0);
  if (positive.length === 0) return null;
  const sol = findNativeSolBalanceItem(positive);
  if (sol) return sol;
  for (const mint of SELL_TOKEN_PRIORITY_MINTS) {
    if (isSolMint(mint)) continue;
    const hit = positive.find((i) => i.mintAddress === mint);
    if (hit && isWalletTokenTradable(hit.mintAddress)) return hit;
  }
  return (
    positive
      .filter((i) => !isSolMint(i.mintAddress) && isSplValueTradable(walletItemValueUsd(i)))
      .sort((a, b) => walletItemValueUsd(b) - walletItemValueUsd(a) || b.amountUi - a.amountUi)[0] ?? null
  );
}

function syncSwapAmountMaxFromBalance(): void {
  if (!swapAmountInput || !swapInputMintInput) return;
  const mint = swapInputMintInput.value.trim();
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const balancesReady = isWalletBalancesGateOpen(wallet);
  const sellable = getWalletSellableForUi(mint);
  if (sellable != null && sellable > 0) {
    const item = getWalletBalanceListItem(mint);
    if (item && getSwapRouter() === 'vybe' && !isNativeSolMint(mint)) {
      swapAmountInput.max = maxSwapInputStringForWalletItem(item);
    } else {
      swapAmountInput.max = formatSwapInputAmountValue(sellable, getMintDecimals(mint));
    }
  } else if (hasValidSwapWallet() && mint && balancesReady) {
    swapAmountInput.max = '0';
  } else {
    swapAmountInput.removeAttribute('max');
  }
  if (document.activeElement !== swapAmountInput) {
    clampSwapAmountInputToMax();
  }
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
  const amount = parseSwapAmountInputValue(raw);
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
  const item = getWalletBalanceListItem(mint);
  let formatted: string;
  if (
    item &&
    getSwapRouter() === 'vybe' &&
    !isSolMint(mint) &&
    isVybeFullSplSellAmount(amountUi, item, false)
  ) {
    formatted = maxSwapInputStringForWalletItem(item);
  } else {
    formatted = formatSwapInputAmountValue(amountUi, getMintDecimals(mint));
  }
  swapAmountInput.value = formatted;
  syncSwapAmountMaxFromBalance();
  if (!silent) {
    swapAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function applySellTokenFromBalance(
  item: WalletBalanceListItem,
  initialSellPercent?: number | 'max',
): void {
  if (!swapInputMintInput) return;
  const swapMint = item.mintAddress.trim();
  if (swapMint !== swapInputMintInput.value.trim()) {
    resetPinRouteOnMintPairChange();
  }
  swapInputMintInput.value = swapMint;
  const sym =
    item.symbol ||
    HARDCODED_MINT_SYMBOLS[swapMint] ||
    item.mintAddress.slice(0, 6);
  if (swapInputSymbolEl) swapInputSymbolEl.textContent = sym;
  if (item.decimals != null) routeMintDecimalsCache[swapMint] = item.decimals;
  syncSwapAmountMaxFromBalance();
  const sellPercent = initialSellPercent ?? getDefaultSellAmountPercentForMint(swapMint, sym);
  if (sellPercent === 'max') {
    const item = getWalletBalanceListItem(swapMint);
    if (item && getSwapRouter() === 'vybe' && !isNativeSolMint(swapMint)) {
      if (swapAmountInput) {
        swapAmountInput.value = maxSwapInputStringForWalletItem(item);
        syncSwapAmountMaxFromBalance();
      }
    } else {
      const sellable = getWalletSellableForUi(swapMint);
      if (sellable != null && sellable > 0) {
        setSwapSellAmountToBalance(sellable, swapMint, true);
      }
    }
  } else {
    applySellAmountPercent(sellPercent);
  }
  void refreshSwapSymbols();
}

async function refreshWalletBalancesForSwap(
  wallet: string,
  applyDefaults: boolean,
): Promise<void> {
  const gen = ++walletBalanceFetchGen;
  walletBalancesFetching = true;
  syncSwapQuoteButtonState();
  syncRefetchHoldingsBtn();
  refreshWalletBalancesPanel();
  updateWalletTotalUsdUi();
  let markReady = false;
  try {
    const items = await prefetchWalletBalances(wallet);
    if (gen !== walletBalanceFetchGen) return;
    lastWalletBalanceFetchAddress = wallet;
    persistWalletBalanceMetadata(items);
    refreshWalletBalancesPanel();

    if (applyDefaults) {
      lastAutoAppliedWalletAddress = wallet;
      const pick = pickDefaultSellBalance(items);
      if (pick) {
        applySellTokenFromBalance(pick);
        markReady = true;
        return;
      }
    }

    syncSwapAmountMaxFromBalance();
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
      syncRefetchHoldingsBtn();
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
    clearSessionWalletBalances();
    syncRefetchHoldingsBtn();
    if (swapAmountInput) swapAmountInput.removeAttribute('max');
    syncSwapQuoteButtonState();
    updateWalletTotalUsdUi();
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

function isLikelyTxSignature(value: string): boolean {
  const s = value.trim();
  if (!s || s.includes('\n') || s.length < 80 || s.length > 100) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function scheduleWalletRefreshAfterTxConfirm(context?: {
  soldMint?: string;
  buyMint?: string;
}): void {
  if (postTxConfirmRefreshTimer) {
    clearTimeout(postTxConfirmRefreshTimer);
    postTxConfirmRefreshTimer = null;
  }
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (!isValidSolanaWalletAddress(wallet)) return;

  postTxConfirmRefreshTimer = setTimeout(() => {
    postTxConfirmRefreshTimer = null;
    postTxConfirmRefreshPromise = refreshWalletStateAfterTxConfirm(wallet, context);
    void postTxConfirmRefreshPromise;
  }, POST_TX_CONFIRM_WALLET_REFRESH_DELAY_MS);
}

async function refreshWalletHoldingsFull(
  wallet: string,
  context?: { soldMint?: string; buyMint?: string },
): Promise<void> {
  await refreshWalletBalancesForSwap(wallet, false);
  refreshWalletBalancesPanel();

  // Wallet list metadata: phase-2 enrichWalletItemsOnClient only (top 10, 1 req/s).
  // Do not prefetchTokenMetas for every holding — that duplicates /api/token in parallel.

  resetSwapQuoteToMock();
  updateSwapPairCards();
  updateSwapTokenIcons();
  syncSwapAmountMaxFromBalance();
  syncSwapQuoteButtonState();
  void refreshSwapSymbols();
}

async function refreshWalletStateAfterTxConfirm(
  wallet: string,
  context?: { soldMint?: string; buyMint?: string },
): Promise<void> {
  updateSwapPairCards(undefined, true);
  try {
    await refreshWalletHoldingsFull(wallet, context);
  } catch {
    updateSwapPairCards();
  }
}

async function waitForTxConfirmThenRefreshWallet(signature: string): Promise<void> {
  const confirmed = await pollTransactionConfirmation(signature, null);
  if (confirmed.ok) scheduleWalletRefreshAfterTxConfirm();
}

function tryOpenBuyTokenPicker(): void {
  if (swapQuoteFetching) return;
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
  if (swapQuoteFetching) return;
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
  return left === right;
}

function swapFormMintMatchesQuoteMint(formMint: string, quoteMint: string): boolean {
  const a = preferNativeSolMint(formMint.trim());
  const b = preferNativeSolMint(quoteMint.trim());
  return Boolean(a && b && a === b);
}

function swapQuoteMatchesFormPair(quote: Record<string, unknown> | null): boolean {
  if (!quote || !swapInputMintInput || !swapOutputMintInput) return false;
  const formIn = swapInputMintInput.value.trim();
  const formOut = swapOutputMintInput.value.trim();
  const quoteIn = quoteInputMint(quote) ?? '';
  const quoteOut = quoteOutputMint(quote) ?? '';
  return (
    swapFormMintMatchesQuoteMint(formIn, quoteIn) &&
    swapFormMintMatchesQuoteMint(formOut, quoteOut)
  );
}

/** Drop cached quote/enrichment when mint inputs no longer match the quoted pair. */
function discardSwapQuoteIfPairMismatch(): boolean {
  if (!lastSwapQuoteOk || swapQuoteMatchesFormPair(lastSwapQuoteOk)) return false;
  lastSwapQuoteOk = null;
  lastVybeBuild = null;
  lastRawQuoteResponse = null;
  lastRawSwapResponse = null;
  enumeratedRoutesUiState = null;
  lastVybeQuoteBodyForRoutes = null;
  if (swapBuildBtn) syncBuildButtonState();
  return true;
}

function activeSwapQuoteForUi(): Record<string, unknown> | null {
  discardSwapQuoteIfPairMismatch();
  return lastSwapQuoteOk;
}

function isSwapQuoteSolOrStableMint(mint: string, symbolHint?: string): boolean {
  return isSolOrStableMint(mint, symbolHint);
}

function setSwapOutputMintUi(mint: string): void {
  if (!swapOutputMintInput) return;
  const resolvedMint = mint.trim();
  swapOutputMintInput.value = resolvedMint;
  const meta = getCachedTokenMeta(resolvedMint);
  if (meta && swapOutputSymbolEl) {
    swapOutputSymbolEl.textContent =
      meta.symbol === 'wSOL' ? 'WSOL' : meta.symbol === 'WSOL' ? 'WSOL' : meta.symbol;
  }
  if (meta?.decimals != null) routeMintDecimalsCache[resolvedMint] = meta.decimals;
}

/** When true, non-SOL/non-stable sells may only buy SOL or stables. Off = alt→alt allowed. */
const RESTRICT_ALT_SELL_OUTPUT_TO_SOL_OR_STABLE = false;

/** Non-SOL/non-stable sells may only buy SOL or stables — reset invalid output mints. */
function applyOutputMintConstraintForInput(): void {
  if (!RESTRICT_ALT_SELL_OUTPUT_TO_SOL_OR_STABLE) return;
  if (!swapInputMintInput || !swapOutputMintInput) return;
  const inputMint = swapInputMintInput.value.trim();
  const inputSym = swapInputSymbolEl?.textContent?.trim();
  const outputMint = swapOutputMintInput.value.trim();
  if (isSolOrStableMint(inputMint, inputSym)) return;
  if (!outputMint || isSolOrStableMint(outputMint)) return;
  resetPinRouteOnMintPairChange();
  setSwapOutputMintUi(SWAP_DEFAULT_STABLE_OUTPUT_MINT);
  updateSwapTokenIcons();
  updateSwapPairCards();
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

function flipSellBuyTokens(options?: { force?: boolean }): void {
  if (!options?.force && getFlipBlockedReason()) return;
  if (!swapInputMintInput || !swapOutputMintInput) return;
  clearSwapNoLiquidityStickyOnMintChange();
  resetPinRouteOnMintPairChange();
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
  invalidateSwapQuoteUi();
  void syncSwapSideLabels();
  updateSwapTokenIcons();
  applyOutputMintConstraintForInput();
  updateSwapPairCards();
  syncSwapAmountMaxFromBalance();
  const newSellMint = swapInputMintInput?.value.trim() ?? '';
  const newBuyMint = swapOutputMintInput?.value.trim() ?? '';
  if (newSellMint && hasValidSwapWallet()) {
    if (flippedOutputAmountUi != null) {
      applyFlippedOutputAsSellAmount(flippedOutputAmountUi);
    } else {
      applySellAmountPercent(
        getDefaultSellAmountPercentForMint(newSellMint, swapInputSymbolEl?.textContent ?? undefined),
      );
    }
  }
  updateSwapPairCards();
  syncSwapSellAmountUi();
  void refreshLowSolTradeWarning();
  syncFlipButtonState();
}

function applySelectedToken(mint: string, side: TokenPickerSide): void {
  clearSwapNoLiquidityStickyOnMintChange();
  invalidateSwapQuoteAfterInputChange();
  const input = side === 'input' ? swapInputMintInput : swapOutputMintInput;
  const otherInput = side === 'input' ? swapOutputMintInput : swapInputMintInput;
  const symbolEl = side === 'input' ? swapInputSymbolEl : swapOutputSymbolEl;
  if (!input) return;
  const previousInputMint = side === 'input' ? input.value.trim() : '';
  const previousInputSym = side === 'input' ? swapInputSymbolEl?.textContent?.trim() : undefined;
  const resolvedMint = mint.trim();
  const otherMint = otherInput?.value.trim() ?? '';

  if (
    RESTRICT_ALT_SELL_OUTPUT_TO_SOL_OR_STABLE &&
    side === 'output' &&
    swapInputMintInput &&
    !isSolOrStableMint(swapInputMintInput.value.trim(), swapInputSymbolEl?.textContent?.trim()) &&
    !isSolOrStableMint(resolvedMint)
  ) {
    return;
  }

  if (otherMint && swapPairMintsMatch(resolvedMint, otherMint)) {
    resetPinRouteOnMintPairChange();
    const flippedOutputAmountUi = parseFlipOutputAmountUi();
    flipSellBuyTokens({ force: true });
    void refreshSwapSymbols().then(() => afterSellBuyTokensFlipped(flippedOutputAmountUi));
    return;
  }

  const sideMintBefore = input.value.trim();
  if (resolvedMint !== sideMintBefore) {
    resetPinRouteOnMintPairChange();
  }

  let autoOutputMint: string | null = null;
  if (
    side === 'input' &&
    previousInputMint &&
    otherInput &&
    isSwapQuoteSolOrStableMint(previousInputMint, previousInputSym) &&
    !isSwapQuoteSolOrStableMint(resolvedMint) &&
    !swapPairMintsMatch(resolvedMint, previousInputMint)
  ) {
    autoOutputMint = previousInputMint;
  } else if (
    side === 'input' &&
    otherInput &&
    !isSwapQuoteSolOrStableMint(resolvedMint) &&
    otherMint &&
    !isSwapQuoteSolOrStableMint(otherMint)
  ) {
    autoOutputMint = SWAP_DEFAULT_STABLE_OUTPUT_MINT;
  }

  input.value = resolvedMint;
  const meta = getCachedTokenMeta(resolvedMint);
  if (meta && symbolEl) {
    symbolEl.textContent =
      meta.symbol === 'wSOL' ? 'WSOL' : meta.symbol === 'WSOL' ? 'WSOL' : meta.symbol;
  }
  if (autoOutputMint && swapOutputMintInput) {
    setSwapOutputMintUi(autoOutputMint);
  }
  applyOutputMintConstraintForInput();
  void syncSwapSideLabels();
  if (meta?.decimals != null) routeMintDecimalsCache[resolvedMint] = meta.decimals;
  updateSwapTokenIcons();
  updateSwapPairCards();
  syncSwapSellAmountUi();
  void refreshSwapSymbols();
  if (side === 'input') {
    syncSwapAmountMaxFromBalance();
    const sellable = getWalletSellableForUi(resolvedMint);
    if (sellable != null && sellable > 0) {
      applySellAmountPercent(
        getDefaultSellAmountPercentForMint(resolvedMint, meta?.symbol),
      );
    }
  }
  syncSwapQuoteButtonState();
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
  if (v != null && v !== '') {
    const n = Number(String(v).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }

  const youPay = quote._youPay as { swapUsd?: number } | undefined;
  if (youPay?.swapUsd != null) {
    const swapUsd = Number(youPay.swapUsd);
    if (Number.isFinite(swapUsd) && swapUsd > 0) return swapUsd;
  }

  const inUi = quoteInAmountUi(quote);
  const inMint = quoteInputMint(quote) ?? '';
  const price = lookupMintPriceUsd(inMint, quote);
  if (inUi != null && inUi > 0 && Number.isFinite(price) && price > 0) {
    return inUi * price;
  }

  return null;
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

/** USD for the selected pool's net output (per-route when enumerating). */
function quotePoolOutputUsd(quote: Record<string, unknown>): number | null {
  const enriched = quote._youReceive as { outUsd?: number } | undefined;
  const enrichedOutUsd = enriched?.outUsd;
  if (enrichedOutUsd != null && Number.isFinite(enrichedOutUsd) && enrichedOutUsd > 0) {
    return enrichedOutUsd;
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastHop = plan.at(-1);
  if (lastHop) {
    const hopOutUsd = lastHop._outUsd ?? (lastHop as { outUsd?: number }).outUsd;
    if (hopOutUsd != null && Number.isFinite(Number(hopOutUsd)) && Number(hopOutUsd) > 0) {
      return Number(hopOutUsd);
    }
  }

  const outMint = quoteOutputMint(quote);
  const netUi = quoteOutputUiAmount(quote);
  if (netUi != null && netUi > 0 && outMint) {
    const enrichedOutPrice = Number(quote._outputPriceUsd);
    if (Number.isFinite(enrichedOutPrice) && enrichedOutPrice > 0) {
      return netUi * enrichedOutPrice;
    }
    const outPrice = lookupMintPriceUsd(outMint, quote);
    if (Number.isFinite(outPrice) && outPrice > 0) return netUi * outPrice;
  }

  return null;
}

/**
 * USD notional of receive/output — pool output × output mint price for the active route.
 * Falls back to swapUsdValue parity only when enrichment lacks output pricing.
 */
function getQuoteReceiveUsd(quote: Record<string, unknown>): number | null {
  const poolOut = quotePoolOutputUsd(quote);
  if (poolOut != null) return poolOut;

  const swapUsd = getQuoteSwapUsdValue(quote);
  if (swapUsd == null) return null;

  const netUi = quoteOutputUiAmount(quote);
  const quotedUi = quoteQuotedOutUiAmount(quote);

  if (netUi != null && quotedUi != null && quotedUi > 0 && netUi > 0) {
    if (netUi <= quotedUi) {
      return swapUsd * (netUi / quotedUi);
    }
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
  const enriched = quote._youReceive as { outUsd?: number } | undefined;
  const enrichedOutUsd = enriched?.outUsd;
  if (enrichedOutUsd != null && Number.isFinite(enrichedOutUsd) && enrichedOutUsd > 0) {
    const outUi = quoteOutputUiAmount(quote);
    const outSym = getSwapOutSym();
    if (outUi != null && outUi > 0) {
      return `Pool output ${outUi} ${outSym} × output mint USD price (enrichment youReceive.outUsd)`;
    }
    return 'Pool output USD from enrichment youReceive.outUsd';
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const lastHop = plan.at(-1);
  const hopOutUsd = lastHop?._outUsd ?? (lastHop as { outUsd?: number } | undefined)?.outUsd;
  if (hopOutUsd != null && Number.isFinite(Number(hopOutUsd)) && Number(hopOutUsd) > 0) {
    return 'Last hop net output × output mint USD price (routePlan.outUsd)';
  }

  const outMint = quoteOutputMint(quote);
  const netUi = quoteOutputUiAmount(quote);
  const outPrice = outMint ? lookupMintPriceUsd(outMint, quote) : NaN;
  if (netUi != null && netUi > 0 && Number.isFinite(outPrice) && outPrice > 0) {
    return `Pool output ${netUi} × $${formatSwapLegUsdAmount(outPrice)} output mint price`;
  }

  const swapUsd = getQuoteSwapUsdValue(quote);
  if (swapUsd == null) {
    return 'USD estimate unavailable — swap quote did not include output or swapUsdValue';
  }
  return `Fallback: swapUsdValue $${formatSwapLegUsdAmount(swapUsd)} (input-leg parity)`;
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
  if (isNativeSolMint(mint)) return getWalletSellableForUi(mint);
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

/** Footer price impact — compact K/M for extreme values; two decimals otherwise. */
function formatPriceImpactPct(value: unknown): string {
  if (value == null || value === '') return '—';
  const n = parsePriceImpactPct(value);
  if (n == null) return '—';
  const displayed = displayPriceImpactPct(n);
  if (displayed === 0) return '0%';
  const formatted = formatPriceImpactPctMarketBox(displayed, { leadingPlus: displayed > 0 });
  return formatPriceImpactPctWithArrow(displayed, formatted);
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
  if (isNativeSolMint(mint)) return 'SOL';
  if (isWsolMint(mint)) return 'WSOL';
  const sym = displaySymbol(chipSymbol);
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
  const stats = pairCardEffectiveStats(mint, activeSwapQuoteForUi() ?? undefined);
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
  return renderTokenIconImgHtml(effectiveTokenIconSrc(resolveTokenLogoUrl(mint)), 'swap-pair-icon-img');
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
  const quote = activeSwapQuoteForUi() ?? undefined;
  if (sellEl) {
    sellEl.innerHTML = renderSwapSideChangeHtml(
      inMint ? pairCardEffectiveStats(inMint, quote) : undefined,
    );
  }
  if (buyEl) {
    buyEl.innerHTML = renderSwapSideChangeHtml(
      outMint ? pairCardEffectiveStats(outMint, quote) : undefined,
      loading,
    );
  }
}

function mergeTokenPriceStats(
  _prev: TokenPriceStats | undefined,
  next: TokenPriceStats,
): TokenPriceStats {
  return next;
}

function updateSwapPairCards(stats?: Record<string, TokenPriceStats>, loading = false): void {
  if (stats) {
    for (const [mint, incoming] of Object.entries(stats)) {
      pairTokenStats[mint] = mergeTokenPriceStats(pairTokenStats[mint], incoming);
    }
  }
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

function syncDefaultRouteSubtitle(): void {
  if (!swapQuoteRouteSubtitleEl || lastSwapQuoteOk) return;
  const router = getSwapRouter();
  swapQuoteRouteSubtitleEl.innerHTML = renderRouteSubtitleHtml(
    `Route · ${routerDisplayLabel(router)}`,
    routerBrandFromId(router),
  );
}

function setSwapRouter(router: string, options?: { invalidateQuote?: boolean }): void {
  const normalized = normalizeRouterId(router);
  const prev = normalizeRouterId(getSwapRouter());
  if (normalized !== prev && swapQuoteFetching && options?.invalidateQuote !== false) {
    return;
  }
  if (swapRouterInput) swapRouterInput.value = normalized;
  for (const btn of swapRouterSwitchEl?.querySelectorAll<HTMLButtonElement>('[data-router]') ?? []) {
    const active = btn.dataset.router === normalized;
    btn.classList.toggle('swap-mode-switch__btn--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (normalized !== prev && options?.invalidateQuote !== false) {
    if (isSwapRouterId(prev)) {
      snapshotRouterQuoteForRouterSwitch(prev);
    }

    if (normalized === 'vybe') {
      clearActiveRouterQuoteUiIfNoCache('vybe');
    } else if (normalized === 'jupiter' || normalized === 'titan') {
      clearActiveRouterQuoteUiIfNoCache(normalized);
    } else {
      clearAllRouterQuoteCaches();
      invalidateSwapQuoteAfterInputChange();
    }
  }
  syncRouterFallbackToggleUi();
  syncSwapAmountMaxFromBalance();
  syncSwapRoutePinMode(hasValidSwapWallet());
  syncSwapQuoteButtonState();
  syncSwapRouterSwitchState();
  syncDefaultRouteSubtitle();
}

function isRouterFallbackEnabled(): boolean {
  const router = normalizeRouterId(getSwapRouter());
  if (router === 'vybe' || router === 'titan') return true;
  return swapVybeFallbackCheckbox?.checked === true;
}

function getRouterFallbackLabel(): string {
  const router = normalizeRouterId(getSwapRouter());
  if (router === 'jupiter') return 'Fallback to Titan if Jupiter cannot find routes';
  if (router === 'titan') return 'Fallback to Jupiter if Titan cannot find routes';
  return 'Fallback to Jupiter or Titan if Vybe cannot find routes';
}

function getRouterFallbackSwitchTitle(): string {
  const router = normalizeRouterId(getSwapRouter());
  if (router === 'jupiter') return 'Switch to Titan and refetch when Jupiter has no route';
  if (router === 'titan') {
    return 'Titan automatically falls back to Jupiter when it cannot find a route (display only)';
  }
  return 'Switch to Jupiter or Titan and refetch when Vybe has no route';
}

function syncRouterFallbackToggleUi(): void {
  if (!swapVybeFallbackRowEl || !swapVybeFallbackCheckbox) return;
  swapVybeFallbackRowEl.hidden = false;
  if (swapRouterFallbackLabelEl) {
    swapRouterFallbackLabelEl.textContent = getRouterFallbackLabel();
  }
  const router = normalizeRouterId(getSwapRouter());
  if (swapRouterFallbackSwitchEl) {
    swapRouterFallbackSwitchEl.title = getRouterFallbackSwitchTitle();
  }
  if (router === 'jupiter') {
    swapVybeFallbackRowEl.classList.remove('swap-router-fallback-row--locked');
    swapRouterFallbackSwitchEl?.classList.remove('swap-router-fallback-row--locked');
    swapVybeFallbackCheckbox.removeAttribute('title');
    setWalletGatedDisabled(swapVybeFallbackCheckbox, !hasValidSwapWallet());
    return;
  }
  swapVybeFallbackCheckbox.checked = true;
  swapVybeFallbackCheckbox.disabled = true;
  swapVybeFallbackCheckbox.title =
    router === 'titan' ? getRouterFallbackSwitchTitle() : ROUTER_FALLBACK_LOCKED_TITLE;
  swapVybeFallbackRowEl.classList.add('swap-router-fallback-row--locked');
  swapRouterFallbackSwitchEl?.classList.add('swap-router-fallback-row--locked');
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
  const rvtHandoff = detectRouteDiscoveryAggregatorHandoff(body);
  if (rvtHandoff) return rvtHandoff;
  if (body._routeDiscovery != null) return null;
  return resolveVybeHandoffAggregatorRouter(body);
}

function hasAcceptableVybeRouteQuote(body: Record<string, unknown>): boolean {
  const rvt = body._routeDiscovery as { outcome?: string; routes?: unknown[] } | undefined;
  if (rvt?.outcome === 'multi' || rvt?.outcome === 'direct') return true;
  const plan = body.routePlan;
  if (!Array.isArray(plan) || plan.length === 0) return false;
  const build = body._build as Record<string, unknown> | undefined;
  const tx = build?.tx ?? build?.transaction;
  return typeof tx === 'string' && tx.length > 0;
}

function detectRouteDiscoveryAggregatorHandoff(
  body: Record<string, unknown>,
): 'jupiter' | 'titan' | null {
  const rvt = body._routeDiscovery as {
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

/** Map ix-builder enrichment route steps onto the UI shape (`hopFees` → `_hopFees`, etc.). */
function mapEnrichmentRoutePlanStep(step: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = { ...step };
  const hopFees = step.hopFees as Record<string, unknown> | undefined;
  if (hopFees && !mapped._hopFees) mapped._hopFees = hopFees;
  if (step.retentionInPct != null && mapped._retentionInPct == null) {
    mapped._retentionInPct = step.retentionInPct;
  }
  if (step.retentionOutPct != null && mapped._retentionOutPct == null) {
    mapped._retentionOutPct = step.retentionOutPct;
  }
  if (step.outgoingPct != null && mapped._outgoingPct == null) mapped._outgoingPct = step.outgoingPct;
  if (step.inUsd != null && mapped._inUsd == null) mapped._inUsd = step.inUsd;
  if (step.outUsd != null && mapped._outUsd == null) mapped._outUsd = step.outUsd;
  if (step.netOutRaw != null && mapped._netOutRaw == null) mapped._netOutRaw = step.netOutRaw;
  if (step.grossOutRaw != null && mapped._grossOutRaw == null) mapped._grossOutRaw = step.grossOutRaw;
  return mapped;
}

function mapEnrichmentRoutePlanForUi(plan: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(plan)) return undefined;
  return plan.map((step) =>
    typeof step === 'object' && step != null
      ? mapEnrichmentRoutePlanStep(step as Record<string, unknown>)
      : (step as Record<string, unknown>),
  );
}

/** Project ix-builder `enrichment` onto the browser swap-body shape (matches POST /api/trading/swap). */
function projectSwapBuildForBrowser(build: Record<string, unknown>): Record<string, unknown> {
  const enrichment = build.enrichment as Record<string, unknown> | undefined;
  if (!enrichment || typeof enrichment !== 'object') return { ...build };

  const buildDetails = build.details as Record<string, unknown> | undefined;
  const buildQuote = buildDetails?.quote as Record<string, unknown> | undefined;
  const feeEnrichment = {
    routePlan: mapEnrichmentRoutePlanForUi(enrichment.routePlan) ?? enrichment.routePlan,
    quotedOutRaw: enrichment.quotedOutRaw,
    simulatedOutRaw: enrichment.simulatedOutRaw,
    totalFeeRaw: enrichment.totalFeeRaw,
    swapFeePct: enrichment.swapFeePct,
    swapFeeRaw: enrichment.swapFeeRaw,
    outputFromSimulation: enrichment.outputFromSimulation,
    walletPayDebitRaw: enrichment.walletPayDebitRaw,
    networkFeeLamports: enrichment.networkFeeLamports,
    simulationOutputWarning: enrichment.simulationOutputWarning ?? null,
    lowLiquidityWarning: enrichment.lowLiquidityWarning ?? null,
  };

  return {
    ...build,
    ...(typeof build.closeWsolAta === 'boolean' ? { closeWsolAta: build.closeWsolAta } : {}),
    ...(typeof buildDetails?.closeWsolAta === 'boolean' ? { closeWsolAta: buildDetails.closeWsolAta } : {}),
    _feeEnrichment: feeEnrichment,
    _simulatedOutAmount: enrichment.simulatedOutRaw ?? null,
    _quotedOutAmount: enrichment.quotedOutRaw ?? buildQuote?.outAmount,
    _walletPayDebitRaw: enrichment.walletPayDebitRaw ?? null,
    _networkFeeLamports: enrichment.networkFeeLamports ?? null,
    _walletTokenAccountCloses: enrichment.walletTokenAccountCloses ?? [],
    _youPay: enrichment.youPay,
    _youReceive: enrichment.youReceive,
    _swapUiUsd: enrichment.swapUiUsd,
    _maxSlippagePct: enrichment.maxSlippagePct,
    _tokens: enrichment.tokens,
    _inputPriceUsd: enrichment.inputPriceUsd,
    _outputPriceUsd: enrichment.outputPriceUsd,
    _otherAmountThresholdRaw: enrichment.otherAmountThresholdRaw,
    _otherAmountThresholdUi: enrichment.otherAmountThresholdUi,
    _simulationOutputWarning: enrichment.simulationOutputWarning ?? null,
    _lowLiquidityWarning: enrichment.lowLiquidityWarning ?? null,
  };
}

function applyFeeEnrichmentToQuote(
  quote: Record<string, unknown>,
  enrichment: Record<string, unknown> | null | undefined,
  buildPayload?: Record<string, unknown>,
): Record<string, unknown> {
  const buildEnrichment = buildPayload?.enrichment as Record<string, unknown> | undefined;
  const source =
    enrichment ??
    (buildPayload?._feeEnrichment as Record<string, unknown> | undefined) ??
    buildEnrichment ??
    null;

  const simulatedOutRaw =
    (source?.simulatedOutRaw as string | undefined) ??
    (buildPayload?._simulatedOutAmount as string | undefined);
  const quotedOutRaw =
    (source?.quotedOutRaw as string | undefined) ??
    (buildPayload?._quotedOutAmount as string | undefined);
  const outputFromSimulation =
    source?.outputFromSimulation === true || buildEnrichment?.outputFromSimulation === true;
  const totalFeeRaw = source?.totalFeeRaw ?? buildEnrichment?.totalFeeRaw;
  const swapFeePct = source?.swapFeePct ?? buildEnrichment?.swapFeePct;
  const buildDetails = buildPayload?.details as Record<string, unknown> | undefined;
  const swapFeeRaw =
    source?.swapFeeRaw ?? buildEnrichment?.swapFeeRaw ?? buildDetails?.swapFee ?? quote._swapFee;
  const routePlan =
    mapEnrichmentRoutePlanForUi(source?.routePlan ?? buildEnrichment?.routePlan) ??
    (Array.isArray(quote.routePlan) ? (quote.routePlan as Record<string, unknown>[]) : undefined);

  let next: Record<string, unknown> = {
    ...quote,
    ...(routePlan ? { routePlan } : {}),
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
    '_swapUiUsd',
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

  const networkFeeLamports =
    buildPayload?._networkFeeLamports ??
    source?.networkFeeLamports ??
    quote._networkFeeLamports;
  if (networkFeeLamports != null && String(networkFeeLamports).trim() !== '') {
    next._networkFeeLamports = networkFeeLamports;
  }

  const walletTokenAccountCloses =
    buildPayload?._walletTokenAccountCloses ?? quote._walletTokenAccountCloses;
  if (Array.isArray(walletTokenAccountCloses)) {
    next._walletTokenAccountCloses = walletTokenAccountCloses;
  }

  const closeWsolAta =
    buildPayload?.closeWsolAta ??
    (buildDetails?.closeWsolAta as boolean | undefined) ??
    quote.closeWsolAta;
  if (typeof closeWsolAta === 'boolean') {
    next.closeWsolAta = closeWsolAta;
  }

  const simulationOutputWarning =
    buildPayload?._simulationOutputWarning ??
    source?.simulationOutputWarning ??
    buildEnrichment?.simulationOutputWarning ??
    quote._simulationOutputWarning ??
    null;
  if (simulationOutputWarning && typeof simulationOutputWarning === 'object') {
    next._simulationOutputWarning = simulationOutputWarning;
  } else if (!buildPayloadHasEnrichment(buildPayload)) {
    if (quote._simulationOutputWarning != null) {
      next._simulationOutputWarning = quote._simulationOutputWarning;
    }
  } else {
    next._simulationOutputWarning = null;
  }

  const lowLiquidityWarning =
    buildPayload?._lowLiquidityWarning ??
    source?.lowLiquidityWarning ??
    buildEnrichment?.lowLiquidityWarning ??
    quote._lowLiquidityWarning ??
    null;
  if (lowLiquidityWarning && typeof lowLiquidityWarning === 'object') {
    next._lowLiquidityWarning = lowLiquidityWarning;
  } else if (!buildPayloadHasEnrichment(buildPayload)) {
    if (quote._lowLiquidityWarning != null) {
      next._lowLiquidityWarning = quote._lowLiquidityWarning;
    }
  } else {
    next._lowLiquidityWarning = null;
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
  const prev = lastSwapQuoteOk;
  let enriched = applyFeeEnrichmentToQuote(prev, null, buildPayload);
  if (!buildPayloadHasEnrichment(buildPayload)) {
    enriched = preserveQuoteEnrichmentDisplay(prev, enriched);
  }
  lastSwapQuoteOk = enriched;
  renderSwapQuoteUI(enriched);
  void enrichRouteLabels(enriched, { skipPricePrefetch: true });
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
    parseSwapAmountInputValue(swapAmountInput?.value ?? '');
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
  subHtml?: string | null,
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
  const subInner =
    loading && placeholder && (subHtml || sub)
      ? renderLoadingSpinner('sm')
      : subHtml
        ? subHtml
        : sub
          ? escapeHtml(sub)
          : '';
  return `<div class="swap-quote-summary-tile swap-quote-summary-tile--hero swap-quote-summary-tile--${variant} ${boxCls}">
      <span class="swap-quote-summary-label">${escapeHtml(label)}</span>
      <span class="swap-quote-summary-value">${valueInner}</span>
      ${subInner ? `<span class="swap-quote-summary-sub${subCls}">${subInner}</span>` : ''}
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
  const paySubHtml =
    lastSwapQuoteOk && hasPay
      ? renderQuotePayHeroSubHtml(lastSwapQuoteOk, inSym, false)
      : renderQuotePayHeroSubHtml(null, inSym, true);
  const hasReceive =
    lastSwapQuoteOk != null && formatQuoteTokenAmount(lastSwapQuoteOk, 'out').display !== '—';
  const receiveAmt = hasReceive ? formatQuoteTokenAmount(lastSwapQuoteOk!, 'out').display : '—';
  const receiveValueHtml = renderQuoteReceiveHeroValueHtml(
    lastSwapQuoteOk,
    outSym,
    hasReceive ? receiveAmt : '—',
    !hasReceive,
    loading && !hasReceive,
  );
  const receiveSubHtml =
    lastSwapQuoteOk && hasReceive
      ? renderQuoteReceiveHeroSubHtml(lastSwapQuoteOk, outSym, false)
      : renderQuoteReceiveHeroSubHtml(null, outSym, true);
  return `<div class="swap-quote-summary-primary" data-quote-placeholder="true">
      ${renderQuoteSummaryHeroTile('You pay', hasPay ? payAmt : '—', inSym, 'pay', inMint, paySub, !hasPay, loading && !hasPay, payValueHtml, paySubHtml)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', hasReceive ? receiveAmt : '—', outSym, 'receive', outMint, null, !hasReceive, loading && !hasReceive, receiveValueHtml, receiveSubHtml)}
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
  const paySubHtml = renderQuotePayHeroSubHtml(quote, inSym);
  const receiveValueHtml = renderQuoteReceiveHeroValueHtml(quote, outSym, outAmt.display);
  const receiveSubHtml = renderQuoteReceiveHeroSubHtml(quote, outSym, false);

  return `<div class="swap-quote-summary-primary">
      ${renderQuoteSummaryHeroTile('You pay', payAmt, inSym, 'pay', inMint, paySub, false, false, payValueHtml, paySubHtml)}
      <span class="swap-quote-summary-arrow" aria-hidden="true"><span class="swap-quote-summary-arrow-icon">→</span></span>
      ${renderQuoteSummaryHeroTile('You receive', outAmt.display, outSym, 'receive', outMint, null, false, false, receiveValueHtml, receiveSubHtml)}
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

function renderRawResponsePanels(): void {
  renderRawJsonEl(swapRawQuoteResponseEl, lastRawQuoteResponse, 'No quote response yet.');
  renderRawJsonEl(
    swapRawSwapResponseEl,
    lastRawSwapResponse,
    'Build a swap to see the raw swap response.',
  );
  renderRouteOptionsPanel();
}

function renderSwapQuoteDetailsPanel(quote: Record<string, unknown>): void {
  if (swapQuoteDetailsEmptyEl) swapQuoteDetailsEmptyEl.hidden = true;
  if (swapQuoteDetailsBodyEl) swapQuoteDetailsBodyEl.hidden = false;
  if (swapQuoteSummaryEl) {
    swapQuoteSummaryEl.innerHTML = renderQuoteSummary(quote);
    swapQuoteSummaryEl.hidden = false;
  }
  if (vybeRouteDiscoveryUiVisible() || isAggregatorRouter()) {
    renderRoutePanels(quote);
  } else {
    if (swapRouteOptionsEl) {
      swapRouteOptionsEl.hidden = true;
      swapRouteOptionsEl.innerHTML = '';
    }
    if (quoteHasRoutePlan(quote)) {
      renderQuoteRouteDiagramAndSteps(quote);
    } else {
      clearQuoteRouteDiagramAndSteps(false);
    }
  }
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
  mountRoutingDiagram(
    swapQuoteDetailsRoutingEl,
    renderRoutingDiagramPlaceholder(swapQuoteFetching),
  );
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
  if (swapQuoteRouteSubtitleEl) syncDefaultRouteSubtitle();
  if (routingDialogTitleEl) routingDialogTitleEl.textContent = 'Routing';
  renderRawResponsePanels();
}

async function ensureResolvePricesBeforeQuote(
  inputMint: string,
  outputMint: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!options?.force && clientPriceResolveSuppressed()) return;
  const mints = mintsForPricePrefetch([inputMint, outputMint]);
  if (!options?.force && sessionQuotePricesFreshForMints(mints, RESOLVE_PRICES_TTL_MS)) {
    if (isSwapSignDialogActive()) {
      recordSwapSignResolvePricesSkipped(mints);
      appendSwapSignLog('Prices fresh — skipping resolve-prices', 'neutral');
      appendResolvePricesSignLogs(mints, sessionStatsForResolveLogMints(mints));
    }
    return;
  }
  await prefetchSwapPairPrices({ mints, forceFullDetails: options?.force });
}

async function prefetchSwapPairPrices(options?: {
  forceFullDetails?: boolean;
  force?: boolean;
  mints?: string[];
}): Promise<void> {
  if (!options?.force && clientPriceResolveSuppressed()) return;
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const mints = mintsForPricePrefetch(options?.mints ?? [inputMint, outputMint]);
  if (mints.length === 0) return;
  const signActive = isSwapSignDialogActive();
  const forceFull = Boolean(options?.forceFullDetails);
  let resolveStarted = 0;
  if (signActive) {
    resolveStarted = performance.now();
    recordSwapSignResolvePricesStart(mints);
    appendSwapSignLog(
      'Fetching prices (resolve-prices)…',
      'pending',
      `mints: ${formatSignLogMintList(mints)}${forceFull ? ' · forceFull' : ''}`,
    );
  }
  try {
    const forceFullDetailsMints = forceFull ? mints : [];
    const res = await fetchWithRetry('/api/tokens/resolve-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        mints,
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
      saveTokenPriceStatsForUi(mint, s);
    }
    updateSwapPairCards(stats);
    updateSwapTokenIcons();
    syncSwapSellAmountUi();
    refreshWalletBalancesPanel();
    updateWalletTotalUsdUi();
    if (signActive) {
      recordSwapSignResolvePricesDone();
      appendResolvePricesSignLogs(mints, stats, {
        headline: `Prices received in ${formatSignLogDurationMs(performance.now() - resolveStarted)}`,
      });
    }
  } catch {
    if (signActive) {
      appendSwapSignLog('Price resolve failed', 'error');
    }
    // Prefetch is best-effort; pair cards keep last known stats or em dashes.
  } finally {
    syncSwapQuoteButtonState();
  }
}

function clearSwapQuotePanel(): void {
  clearRouteMintCaches();
  if (swapSellFiatEl) swapSellFiatEl.textContent = SWAP_UI_EMPTY;
  resetSwapQuoteToMock();
  if (swapPairCardsEl) {
    swapPairCardsEl.hidden = false;
    swapPairCardsEl.removeAttribute('aria-hidden');
  }
  if (swapQuoteError) clearInlineError(swapQuoteError);
}

function renderSwapQuoteUI(quote: Record<string, unknown>): void {
  if (!swapQuoteMatchesFormPair(quote)) {
    discardSwapQuoteIfPairMismatch();
    syncSwapSellAmountUi();
    return;
  }
  setBuyReadoutLoading(false);
  setBuyFiatLoading(false);
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  if (swapBuyAmountDisplayEl) {
    setSwapBuyAmountDisplay(outAmt.display, {
      empty: outAmt.display === '—',
      full: outAmt.full || undefined,
    });
  }

  const payUsdLabel = formatSwapPayFiatDisplay(getQuotePayUsd(quote));
  if (swapSellFiatEl) swapSellFiatEl.textContent = payUsdLabel;
  if (swapBuyFiatEl) {
    swapBuyFiatEl.innerHTML = renderSwapBuyFiatHtml(quote);
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
      applyPriceImpactTierClass(swapFooterImpactEl, quote.priceImpactPct);
    } else {
      clearPriceImpactTierClass(swapFooterImpactEl);
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

  if (vybeRouteDiscoveryUiVisible()) {
    mountRoutingDiagram(routingDialogBodyEl, renderRoutingDiagram(quote));
  } else {
    clearRoutingDiagram(routingDialogBodyEl);
  }

  renderSwapQuoteDetailsPanel(quote);
  syncSwapRouteWarnings(quote);
  updateSwapPairCards();
  updateSwapTokenIcons();
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
  if (clientPriceResolveSuppressed()) return;
  const mints = collectRoutePriceMints(quote).filter((m) => {
    const price = lookupMintPriceUsd(m, quote);
    return !(Number.isFinite(price) && price > 0);
  });
  if (mints.length === 0) return;

  try {
    const forceFullDetailsMints = dedupeMintsForPriceResolve(
      mints.filter((m) => !quotedMintSession.has(m)),
    );
    const res = await fetchWithRetry('/api/tokens/resolve-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        mints,
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
      saveTokenPriceStatsForUi(mint, s);
    }
    if (Object.keys(stats).length > 0) {
      updateSwapPairCards(stats);
      updateSwapTokenIcons();
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

function mergeQuoteTokenStatsFromBody(
  quote: Record<string, unknown>,
  tokenStats: Record<string, TokenPriceStats> | undefined,
): Record<string, unknown> {
  if (!tokenStats || Object.keys(tokenStats).length === 0) return quote;
  const prev = (quote._tokenStats as Record<string, TokenPriceStats> | undefined) ?? {};
  return { ...quote, _tokenStats: { ...prev, ...tokenStats } };
}

function routePriceMintsMissingFromQuote(quote: Record<string, unknown>): string[] {
  return collectRoutePriceMints(quote).filter((m) => {
    const price = lookupMintPriceUsd(m, quote);
    return !(Number.isFinite(price) && price > 0);
  });
}

type EnrichRouteLabelsOptions = {
  /** Vybe/aggregator quote responses already include _tokenStats from server-side resolve. */
  skipPricePrefetch?: boolean;
};

function shouldSkipRoutePricePrefetch(quote: Record<string, unknown>, options?: EnrichRouteLabelsOptions): boolean {
  if (options?.skipPricePrefetch || clientPriceResolveSuppressed()) return true;
  const quoteStats = quote._tokenStats as Record<string, unknown> | undefined;
  if (quoteStats && Object.keys(quoteStats).length > 0) return true;
  const raw = lastRawQuoteResponse as Record<string, unknown> | null;
  const rawStats = raw?._tokenStats as Record<string, unknown> | undefined;
  if (rawStats && Object.keys(rawStats).length > 0) return true;
  return false;
}

async function enrichRouteLabels(
  quote: Record<string, unknown>,
  options?: EnrichRouteLabelsOptions,
): Promise<void> {
  try {
    await prefetchRouteMintSymbols(quote);
    await prefetchRouteTokenMetas(quote);
    if (!shouldSkipRoutePricePrefetch(quote, options) && routePriceMintsMissingFromQuote(quote).length > 0) {
      await prefetchRouteTokenPrices(quote);
    }
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
  const currentUi = parseSwapAmountInputValue(swapAmountInput?.value ?? '');
  if (maxInput == null || !Number.isFinite(currentUi) || currentUi <= 0) return false;
  if (sellAmountMatchesVybeExactBalance(mint)) return true;
  return sellAmountRoughlyEqual(currentUi, maxInput, mint);
}

function isSwapRoutePinMode(): boolean {
  if (isAggregatorRouter()) return false;
  return swapPinRouteCheckbox?.checked === true;
}

/** Pin route is pair-specific — clear market/protocol and turn pin off when mints change. */
function resetPinRouteOnMintPairChange(): void {
  if (!swapPinRouteCheckbox?.checked) return;
  swapPinRouteCheckbox.checked = false;
  if (swapPoolAddressInput) swapPoolAddressInput.value = '';
  if (swapProtocolSelect) swapProtocolSelect.selectedIndex = 0;
  swapProtocolPicker?.syncFromSelect();
  syncSwapRoutePinMode();
}

let swapRoutePinModeWasOn: boolean | null = null;

function syncSwapRoutePinMode(walletValid = hasValidSwapWallet()): void {
  const aggregator = isAggregatorRouter();
  const vybeLockedTitle = aggregator
    ? 'Route discovery options are only available with Vybe'
    : SWAP_WALLET_LOCKED_TITLE;

  if (aggregator && swapPinRouteCheckbox?.checked) {
    swapPinRouteCheckbox.checked = false;
    swapRoutePinModeWasOn = false;
  }

  const pinOn = !aggregator && isSwapRoutePinMode();
  const enteringPin = swapRoutePinModeWasOn !== true && pinOn;
  const leavingPin = swapRoutePinModeWasOn === true && !pinOn;
  swapRoutePinModeWasOn = pinOn;

  if (swapRouteDiscoveryRowEl) swapRouteDiscoveryRowEl.hidden = pinOn;
  if (swapRoutePinRowEl) swapRoutePinRowEl.hidden = !pinOn;
  swapQuoteRouteOptionsEl?.classList.toggle('swap-quote-route-options--pin', pinOn);
  swapQuoteRouteOptionsEl?.classList.toggle('swap-quote-route-options--aggregator', aggregator);

  const discoveryDisabled = aggregator || !walletValid;

  if (pinOn) {
    if (swapEnablePoolAddressCheckbox) {
      swapEnablePoolAddressCheckbox.checked = true;
      swapEnablePoolAddressCheckbox.disabled = true;
    }
    if (swapEnableProtocolCheckbox) {
      swapEnableProtocolCheckbox.checked = true;
      swapEnableProtocolCheckbox.disabled = true;
    }
    setWalletGatedDisabled(swapPoolAddressInput, !walletValid);
    setWalletGatedDisabled(swapProtocolSelect, !walletValid);
    swapProtocolPicker?.setDisabled(!walletValid, SWAP_WALLET_LOCKED_TITLE);
    if (enteringPin && enumeratedRoutesUiState?.routes.length) {
      applyEnumeratedRouteCandidateToPinFields(getSelectedEnumeratedRouteCandidate());
      renderRouteOptionsPanel();
    }
  } else {
    if (swapEnablePoolAddressCheckbox) {
      swapEnablePoolAddressCheckbox.checked = false;
      swapEnablePoolAddressCheckbox.disabled = true;
    }
    if (swapEnableProtocolCheckbox) {
      swapEnableProtocolCheckbox.checked = false;
      swapEnableProtocolCheckbox.disabled = true;
    }
    if (swapPoolAddressInput) swapPoolAddressInput.value = '';
    if (swapProtocolSelect) swapProtocolSelect.selectedIndex = 0;
    swapProtocolPicker?.syncFromSelect();
    if (swapEnumerateRoutesCheckbox) {
      if (leavingPin) swapEnumerateRoutesCheckbox.checked = true;
      setWalletGatedDisabled(swapEnumerateRoutesCheckbox, discoveryDisabled, vybeLockedTitle);
    }
    syncMarketFetchModeSelectLocked();
  }

  setWalletGatedDisabled(swapPinRouteCheckbox, discoveryDisabled, vybeLockedTitle);
}

function vybeMarketDiscoveryActive(): boolean {
  return getSwapRouter() === 'vybe' && !isSwapRoutePinMode();
}

function swapRouteOptionsPanelActive(): boolean {
  if (isAggregatorRouter()) return true;
  if (!vybeRouteDiscoveryUiVisible()) return false;
  if (isSwapRoutePinMode()) {
    return Boolean(enumeratedRoutesUiState?.routes.length);
  }
  return true;
}

function collectSwapBuildOptions(): Record<string, unknown> {
  const slippage = swapSlippageInput ? Number(swapSlippageInput.value) : undefined;
  const router = getSwapRouter();
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  const amountUi = parseSwapAmountInputValue(swapAmountInput?.value ?? '');
  const maxSellSelected = router === 'vybe' && isVybeMaxSellSelected(inputMint);
  const ataFromCache =
    router === 'vybe' &&
    isWalletBalanceCacheReady(wallet) &&
    inputMint &&
    outputMint &&
    Number.isFinite(amountUi) &&
    amountUi > 0
      ? buildSwapAtaHintsFromSessionBalances({
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
    partner:
      swapEnablePartnerCheckbox?.checked === true ? swapPartnerInput?.value.trim() || undefined : undefined,
    poolAddress: isSwapRoutePinMode()
        ? swapPoolAddressInput?.value.trim() || undefined
        : undefined,
    protocol: isSwapRoutePinMode()
        ? swapProtocolSelect?.value.trim() || undefined
        : undefined,
    marketFetchMode: vybeMarketDiscoveryActive() ? MARKET_FETCH_MODE : undefined,
    enumerateRoutes: vybeMarketDiscoveryActive()
      ? swapEnumerateRoutesCheckbox?.checked !== false
      : false,
    swapFee: resolveSwapServiceFeePct(),
    ...(ataFromCache
      ? {
          ...(ataFromCache.closeWsolAta === true ? { closeWsolAta: true } : { closeWsolAta: false }),
          ...(typeof ataFromCache.createOutputAta === 'boolean'
            ? { createOutputAta: ataFromCache.createOutputAta }
            : {}),
          closeInputAta: ataFromCache.closeInputAta === true,
        }
      : {}),
    ...(ataFromCache?.inputBalanceExact ? { inputBalanceExact: ataFromCache.inputBalanceExact } : {}),
    ...(ataFromCache?.inputDecimals != null
      ? { inputMintDecimals: ataFromCache.inputDecimals }
      : {}),
    ...(ataFromCache?.closeInputAta && ataFromCache.amountUi
      ? { amount: ataFromCache.amountUi }
      : {}),
  };
}

/** Fast rebuild path — skip ix-builder enrichment RPC (balance checks + sim). */
function swapBuildOptsWithoutEnrich(buildOpts: Record<string, unknown>): Record<string, unknown> {
  return { ...buildOpts, enrich: false };
}

/** Request quote(s) — always ask ix-builder for print-ready enrichment. */
function swapBuildOptsWithEnrich(buildOpts: Record<string, unknown>): Record<string, unknown> {
  return { ...buildOpts, enrich: true };
}

/** Refetch/requote: multi-hop Vybe routes need full enrichment + enumeration; single-hop can skip enrich. */
function swapBuildOptsForRefetchQuote(buildOpts: Record<string, unknown>): Record<string, unknown> {
  return isSelectedVybeMultiHopMarket()
    ? swapBuildOptsWithEnrich(buildOpts)
    : swapBuildOptsWithoutEnrich(buildOpts);
}

/** Quote fields that power the route diagram + fee/pay table (ix-builder enrichment). */
const ENRICHMENT_DISPLAY_QUOTE_KEYS = [
  'routePlan',
  'priceImpactPct',
  '_youPay',
  '_youReceive',
  '_swapUiUsd',
  '_maxSlippagePct',
  '_tokens',
  '_inputPriceUsd',
  '_outputPriceUsd',
  '_feeEnrichment',
  '_simulationOutputWarning',
  '_lowLiquidityWarning',
  '_otherAmountThresholdRaw',
  '_otherAmountThresholdUi',
  '_walletTokenAccountCloses',
  '_quotedOutAmount',
  '_simulatedOutAmount',
  '_outputFromSimulation',
  '_totalFeeRaw',
  '_swapFeePct',
  '_swapFee',
  '_networkFeeLamports',
  '_walletPayDebitRaw',
] as const;

function buildPayloadHasEnrichment(buildPayload?: Record<string, unknown> | null): boolean {
  if (!buildPayload) return false;
  const enrichment = buildPayload.enrichment as Record<string, unknown> | undefined;
  if (enrichment && typeof enrichment === 'object') return true;
  if (buildPayload._youPay != null || buildPayload._youReceive != null) return true;
  if (buildPayload._feeEnrichment != null) return true;
  return false;
}

/** Keep diagram/fee-table data from a prior enrich:true quote when a fast build omits enrichment. */
function preserveQuoteEnrichmentDisplay(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...next };
  for (const key of ENRICHMENT_DISPLAY_QUOTE_KEYS) {
    const value = prev[key];
    if (value != null) merged[key] = value;
  }
  return merged;
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

function vybeCacheBuildOpts(buildOpts: Record<string, unknown>): Record<string, unknown> {
  return {
    ...mergeSelectedRoutePinIntoBuildOpts(buildOpts),
    routeIndex: enumeratedRoutesUiState?.selectedIndex ?? 0,
  };
}

function tryReuseLastVybeBuildFromQuote(): { tx: string; buildPayload: Record<string, unknown> } | null {
  if (!lastVybeBuild || !lastSwapQuoteOk) return null;
  if (!isQuoteBuildTxWithinTtl()) return null;
  const buildPayload = lastVybeBuild.buildPayload as Record<string, unknown>;
  const tx = lastVybeBuild.tx?.trim();
  if (!tx) return null;
  return { tx, buildPayload: projectSwapBuildForBrowser(buildPayload) };
}

function isQuoteBuildTxWithinTtl(paramsKey?: string): boolean {
  if (!lastVybeBuild?.tx?.trim()) return false;
  if (paramsKey != null && lastVybeBuild.paramsKey !== paramsKey) return false;
  if (buildBtnQuoteValidUntil > 0) return !isBuildBtnQuoteExpired();
  return Date.now() - lastVybeBuild.builtAt < VYBE_QUOTE_TX_REUSE_MS;
}

function tryReuseCachedBuildTx(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): { tx: string; buildPayload: Record<string, unknown> } | null {
  const cachedRoute = tryCachedVybeBuildTxForSelectedRoute(buildOpts);
  if (cachedRoute) return cachedRoute;
  const cacheOpts = vybeCacheBuildOpts(buildOpts);
  const paramsKey = vybeBuildParamsKey(wallet, inputMint, outputMint, amount, cacheOpts);
  if (!isQuoteBuildTxWithinTtl(paramsKey)) return null;
  return {
    tx: lastVybeBuild!.tx,
    buildPayload: projectSwapBuildForBrowser(lastVybeBuild!.buildPayload as Record<string, unknown>),
  };
}

type VybeQuoteApiBody = Record<string, unknown> & {
  error?: string;
  _build?: Record<string, unknown>;
  _builtAt?: number;
  _tokenStats?: Record<string, TokenPriceStats>;
  _buildUnavailable?: boolean;
};

function isVybeQuoteTxFresh(paramsKey: string): boolean {
  return lastVybeBuild != null && lastVybeBuild.paramsKey === paramsKey && isQuoteBuildTxWithinTtl(paramsKey);
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

function poolLiquidityFromRouteEntry(r: Record<string, unknown>): number | undefined {
  const candidate = r.candidate as { liquidity?: number } | undefined;
  const fromCandidate = Number(candidate?.liquidity);
  if (Number.isFinite(fromCandidate) && fromCandidate > 0 && fromCandidate <= 10_000_000_000) {
    return fromCandidate;
  }
  const build = r.build as { details?: { poolLiquidity?: number; liquidity?: number } } | undefined;
  const fromBuild = Number(build?.details?.poolLiquidity ?? build?.details?.liquidity);
  if (Number.isFinite(fromBuild) && fromBuild > 0 && fromBuild <= 10_000_000_000) return fromBuild;
  return undefined;
}

function poolLiquidityFromQuoteBody(body: Record<string, unknown>): number | undefined {
  const build = body._build as { details?: { poolLiquidity?: number; liquidity?: number } } | undefined;
  const fromBuild = Number(build?.details?.poolLiquidity ?? build?.details?.liquidity);
  if (Number.isFinite(fromBuild) && fromBuild > 0 && fromBuild <= 10_000_000_000) return fromBuild;
  const rvt = body._routeDiscovery as { selected?: { liquidity?: number } } | undefined;
  const fromSelected = Number(rvt?.selected?.liquidity);
  if (Number.isFinite(fromSelected) && fromSelected > 0 && fromSelected <= 10_000_000_000) {
    return fromSelected;
  }
  return undefined;
}

function mapEnumeratedRouteEntry(
  r: Record<string, unknown>,
  i: number,
): EnumeratedRoutesUiState['routes'][0] {
  const candidate = r.candidate as EnumeratedRoutesUiState['routes'][0]['candidate'];
  const liquidity = poolLiquidityFromRouteEntry(r);
  const rawQuote = (r.quote as Record<string, unknown> | undefined) ?? {};
  const quote =
    liquidity != null &&
    Number.isFinite(liquidity) &&
    liquidity >= MIN_ROUTE_POOL_LIQUIDITY_USD &&
    rawQuote._lowLiquidityWarning
      ? { ...rawQuote, _lowLiquidityWarning: null }
      : rawQuote;
  const build =
    r.build && typeof r.build === 'object' ? (r.build as Record<string, unknown>) : undefined;
  return {
    index: Number(r.index ?? i),
    source: typeof r.source === 'string' ? r.source : undefined,
    candidate:
      candidate && liquidity != null ? { ...candidate, liquidity } : candidate,
    quote,
    ...(build ? { build } : {}),
  };
}

function poolAddressFromQuoteBody(body: Record<string, unknown>): string {
  const build = body._build as Record<string, unknown> | undefined;
  const top = String(body.poolAddress ?? build?.poolAddress ?? '').trim();
  if (top) return top;
  const details = build?.details as Record<string, unknown> | undefined;
  const fromDetails = String(details?.poolAddress ?? '').trim();
  if (fromDetails) return fromDetails;
  const quoteDetails = details?.quote as Record<string, unknown> | undefined;
  const fromQuote = String(quoteDetails?.poolAddress ?? quoteDetails?.pool ?? '').trim();
  if (fromQuote) return fromQuote;
  const plan = body.routePlan;
  if (Array.isArray(plan) && plan.length > 0) {
    const swapInfo = (plan[0] as { swapInfo?: { ammKey?: string } })?.swapInfo;
    const amm = String(swapInfo?.ammKey ?? '').trim();
    if (amm) return amm;
  }
  return '';
}

function programAddressFromQuoteBody(body: Record<string, unknown>): string {
  const build = body._build as Record<string, unknown> | undefined;
  const top = String(body.programAddress ?? build?.programAddress ?? '').trim();
  if (top) return top;
  const details = build?.details as Record<string, unknown> | undefined;
  return String(details?.programAddress ?? details?.programId ?? '').trim();
}

function protocolFromQuoteBody(body: Record<string, unknown>): string {
  const build = body._build as Record<string, unknown> | undefined;
  const protocolRaw = body.protocol ?? build?.protocol;
  if (typeof protocolRaw === 'string' && protocolRaw.trim()) return protocolRaw.trim();
  const programAddress = programAddressFromQuoteBody(body);
  if (programAddress && PIN_ROUTE_PROGRAM_TO_PROTOCOL[programAddress]) {
    return PIN_ROUTE_PROGRAM_TO_PROTOCOL[programAddress];
  }
  return '';
}

function resolvePinProgramFromProtocol(protocol: string): string | null {
  const key = normalizePinProtocolKey(protocol);
  for (const [program, proto] of Object.entries(PIN_ROUTE_PROGRAM_TO_PROTOCOL)) {
    if (normalizePinProtocolKey(proto) === key) return program;
  }
  return null;
}

function canonicalPinProtocolValue(
  protocol: string,
  programAddress?: string,
): string {
  return (
    resolvePinProtocolSelectValue({
      protocol,
      programAddress,
      marketAddress: '',
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
    }) ?? protocol
  );
}

function completeRoutePinFields(pin: {
  poolAddress: string;
  programAddress?: string;
  protocol?: string;
}): { poolAddress: string; programAddress?: string; protocol?: string } | null {
  let programAddress = pin.programAddress?.trim() ?? '';
  let protocol = pin.protocol?.trim() ?? '';
  if (programAddress && !protocol) {
    protocol =
      PIN_ROUTE_PROGRAM_TO_PROTOCOL[programAddress] ??
      resolvePinProtocolSelectValue({
        programAddress,
        marketAddress: pin.poolAddress,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
      }) ??
      '';
  }
  if (protocol && !programAddress) {
    programAddress = resolvePinProgramFromProtocol(protocol) ?? '';
  }
  if (!programAddress && !protocol) return null;
  return {
    poolAddress: pin.poolAddress,
    ...(programAddress ? { programAddress } : {}),
    ...(protocol ? { protocol: canonicalPinProtocolValue(protocol, programAddress) } : {}),
  };
}

function activeRouteQuoteBodyForPin(): Record<string, unknown> | undefined {
  if (lastVybeQuoteBodyForRoutes) {
    return getQuoteBodyForActiveRoute(lastVybeQuoteBodyForRoutes);
  }
  const quote = getActiveEnumeratedRoute()?.quote;
  return quote && typeof quote === 'object' ? (quote as Record<string, unknown>) : undefined;
}

function enrichTradeCandidateFromBody(
  base: NonNullable<EnumeratedRoutesUiState['routes'][0]['candidate']>,
  body: Record<string, unknown>,
): EnumeratedRoutesUiState['routes'][0]['candidate'] {
  const fromPlan = tradeCandidateFromRoutePlan(body);
  const build = body._build as Record<string, unknown> | undefined;
  const protocolRaw = body.protocol ?? build?.protocol;
  const programAddress =
    base.programAddress?.trim() ||
    programAddressFromQuoteBody(body) ||
    fromPlan?.programAddress?.trim() ||
    '';
  const protocol =
    base.protocol?.trim() ||
    (typeof protocolRaw === 'string' ? protocolRaw.trim() : '') ||
    (programAddress ? PIN_ROUTE_PROGRAM_TO_PROTOCOL[programAddress] : '') ||
    undefined;
  const programLabel =
    base.programLabel?.trim() ||
    fromPlan?.programLabel?.trim() ||
    undefined;
  return {
    ...base,
    marketAddress: base.marketAddress?.trim() || poolAddressFromQuoteBody(body) || fromPlan?.marketAddress || '',
    programAddress,
    protocol,
    programLabel,
  };
}

function tradeCandidateFromRoutePlan(
  body: Record<string, unknown>,
): EnumeratedRoutesUiState['routes'][0]['candidate'] | null {
  const plan = body.routePlan;
  if (!Array.isArray(plan)) return null;
  for (const step of plan) {
    const si = (step as VybeRoutePlanStepLite).swapInfo;
    if (!si) continue;
    const marketAddress = String(si.ammKey ?? '').trim();
    const programLabel = String(si.label ?? '').trim();
    if (marketAddress || programLabel) {
      return {
        marketAddress,
        programAddress: '',
        programLabel: programLabel || undefined,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
      };
    }
  }
  return null;
}

function tradeCandidateFromRouterOnly(
  body: Record<string, unknown>,
): EnumeratedRoutesUiState['routes'][0]['candidate'] | null {
  const router = normalizeRouterId(
    String(
      body._effectiveRouter ??
        body._selectedRouter ??
        body._buildRouter ??
        body.router ??
        getSwapRouter(),
    ),
  );
  if (router !== 'jupiter' && router !== 'titan') return null;
  if (quoteOutputUiAmount(body) == null) return null;
  return {
    marketAddress: poolAddressFromQuoteBody(body),
    programAddress: programAddressFromQuoteBody(body),
    programLabel: routerDisplayLabel(router),
    tradeCount: 0,
    buyCount: 0,
    sellCount: 0,
  };
}

function routeOptionCandidatePresent(
  candidate: EnumeratedRoutesUiState['routes'][0]['candidate'] | null | undefined,
): boolean {
  return !!(
    candidate?.marketAddress?.trim() ||
    candidate?.programAddress?.trim() ||
    candidate?.programLabel?.trim()
  );
}

function tradeCandidateFromActiveQuote(
  body: Record<string, unknown>,
): EnumeratedRoutesUiState['routes'][0]['candidate'] | null {
  const rvt = body._routeDiscovery as { selected?: Record<string, unknown> } | undefined;
  const selected = rvt?.selected;
  if (selected && typeof selected === 'object') {
    const marketAddress = String(selected.marketAddress ?? '').trim();
    const programAddress = String(selected.programAddress ?? '').trim();
    if (marketAddress || programAddress) {
      return enrichTradeCandidateFromBody(
        {
          marketAddress: marketAddress || poolAddressFromQuoteBody(body),
          programAddress: programAddress || programAddressFromQuoteBody(body),
          protocol: typeof selected.protocol === 'string' ? selected.protocol : undefined,
          tradeCount: Number(selected.tradeCount ?? 0),
          buyCount: Number(selected.buyCount ?? 0),
          sellCount: Number(selected.sellCount ?? 0),
          programLabel:
            typeof selected.programLabel === 'string' ? selected.programLabel.trim() || undefined : undefined,
          liquidity:
            selected.liquidity != null &&
            Number.isFinite(Number(selected.liquidity)) &&
            Number(selected.liquidity) > 0 &&
            Number(selected.liquidity) <= 10_000_000_000
              ? Number(selected.liquidity)
              : undefined,
        },
        body,
      );
    }
  }
  const marketAddress = poolAddressFromQuoteBody(body);
  const programAddress = programAddressFromQuoteBody(body);
  if (marketAddress || programAddress) {
    return enrichTradeCandidateFromBody(
      {
        marketAddress,
        programAddress,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
      },
      body,
    );
  }
  return tradeCandidateFromRoutePlan(body) ?? tradeCandidateFromRouterOnly(body);
}

function inferDirectRouteSource(
  rvt: {
    tradesFetched?: number;
    pairTradeCount?: number;
  },
): string {
  if ((rvt.tradesFetched ?? 0) > 0 || (rvt.pairTradeCount ?? 0) > 0) return 'trades';
  return 'markets';
}

function inferRouteOptionSource(
  body: Record<string, unknown>,
  rvt: {
    tradesFetched?: number;
    pairTradeCount?: number;
  },
): string {
  const router = normalizeRouterId(
    String(
      body._effectiveRouter ??
        body._selectedRouter ??
        body._buildRouter ??
        body.router ??
        getSwapRouter(),
    ),
  );
  if (router === 'jupiter' || router === 'titan') return router;
  return inferDirectRouteSource(rvt);
}

function isMultiHopEnumerateRouteRefetch(buildOpts: Record<string, unknown>): boolean {
  return buildOpts.enumerateRoutes === true && isSelectedVybeMultiHopMarket();
}

function shouldPreserveEnumeratedRoutesOnQuoteApply(buildOpts: Record<string, unknown>): boolean {
  if (!enumeratedRoutesUiState?.routes.length) return false;
  if (isMultiHopEnumerateRouteRefetch(buildOpts)) return false;
  // Pinned to the selected market card (single-hop). Keep cards + selection even when the
  // UI still has enumerateRoutes checked — mergeSelectedRoutePinIntoBuildOpts clears it.
  const pool = String(buildOpts.poolAddress ?? '').trim();
  if (!pool) return false;
  if (enumeratedRoutesUiState.routes.length <= 1) return true;
  const candidate = getSelectedEnumeratedRouteCandidate();
  let selectedPool = String(candidate?.marketAddress ?? '').trim();
  if (!selectedPool) {
    const activeRoute = getActiveEnumeratedRoute();
    if (activeRoute?.quote) selectedPool = poolAddressFromQuoteBody(activeRoute.quote);
    if (!selectedPool && activeRoute?.build) {
      selectedPool = poolAddressFromQuoteBody({ _build: activeRoute.build });
    }
  }
  return Boolean(selectedPool) && selectedPool === pool;
}

/** Update only the selected route card — leave other enumerated markets untouched. */
function mergePinnedRouteCandidateForRefetch(
  prev: EnumeratedRoutesUiState['routes'][0]['candidate'] | undefined,
  next: EnumeratedRoutesUiState['routes'][0]['candidate'] | null,
  liquidityFromBody: number | undefined,
  body?: Record<string, unknown>,
): EnumeratedRoutesUiState['routes'][0]['candidate'] | undefined {
  if (!prev && !next) return undefined;
  const liquidity =
    liquidityFromBody != null && Number.isFinite(liquidityFromBody) && liquidityFromBody > 0
      ? liquidityFromBody
      : prev?.liquidity ?? next?.liquidity;
  const merged = {
    ...(prev ?? {}),
    ...(next ?? {}),
    marketAddress: prev?.marketAddress?.trim() || next?.marketAddress || '',
    programAddress: prev?.programAddress?.trim() || next?.programAddress || '',
    programLabel: prev?.programLabel ?? next?.programLabel,
    protocol: prev?.protocol ?? next?.protocol,
    tradeCount: prev?.tradeCount ?? next?.tradeCount ?? 0,
    buyCount: prev?.buyCount ?? next?.buyCount ?? 0,
    sellCount: prev?.sellCount ?? next?.sellCount ?? 0,
    ...(liquidity != null ? { liquidity } : {}),
  };
  if (!body) return merged;
  return enrichTradeCandidateFromBody(merged, body);
}

/** Keep discovery liquidity/impact on market cards; refresh output amounts from the refetch. */
function mergePinnedRouteCardQuoteForRefetch(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return preserveQuoteEnrichmentDisplay(prev, next);
}

function mergePinnedRouteQuoteIntoEnumeratedRoutes(body: Record<string, unknown>): void {
  if (!enumeratedRoutesUiState) return;

  const selectedIndex = enumeratedRoutesUiState.selectedIndex;
  const routeIdx = enumeratedRoutesUiState.routes.findIndex((r) => r.index === selectedIndex);
  if (routeIdx < 0) return;

  const prevRoute = enumeratedRoutesUiState.routes[routeIdx];
  const rvt = body._routeDiscovery as
    | {
        tradesFetched?: number;
        pairTradeCount?: number;
      }
    | undefined;
  const liquidityFromBody = poolLiquidityFromQuoteBody(body);
  const newCandidate = tradeCandidateFromActiveQuote(body);
  const newQuote = stripVybeQuoteMetadata(body);
  const buildPayload = body._build;
  const source = inferRouteOptionSource(body, rvt ?? {});

  const updatedCandidate = mergePinnedRouteCandidateForRefetch(
    prevRoute.candidate,
    newCandidate,
    liquidityFromBody,
    body,
  );
  const updatedQuote = mergePinnedRouteCardQuoteForRefetch(prevRoute.quote ?? {}, newQuote);

  const updatedBuild =
    buildPayload && typeof buildPayload === 'object'
      ? (buildPayload as Record<string, unknown>)
      : prevRoute.build;

  const routes = enumeratedRoutesUiState.routes.map((r, i) =>
    i === routeIdx
      ? {
          ...r,
          source,
          candidate: updatedCandidate,
          quote: updatedQuote,
          ...(updatedBuild ? { build: updatedBuild } : {}),
        }
      : r,
  );

  enumeratedRoutesUiState = {
    routes,
    selectedIndex: enumeratedRoutesUiState.selectedIndex,
    expanded: enumeratedRoutesUiState.expanded,
  };

  const prevBody = lastVybeQuoteBodyForRoutes ?? body;
  const prevRvt = prevBody._routeDiscovery as { routes?: Array<Record<string, unknown>> } | undefined;
  if (Array.isArray(prevRvt?.routes) && prevRvt.routes.length > 0) {
    const metaRoutes = prevRvt.routes.map((r) => {
      const ri = Number(r.index ?? -1);
      if (ri !== selectedIndex) return r;
      return {
        ...r,
        source,
        candidate: updatedCandidate,
        quote: updatedQuote,
        build: buildPayload ?? r.build,
      };
    });
    lastVybeQuoteBodyForRoutes = {
      ...prevBody,
      _routeDiscovery: { ...prevRvt, routes: metaRoutes },
    };
  } else {
    lastVybeQuoteBodyForRoutes = prevBody;
  }
}

function syncEnumeratedRoutesFromBody(
  body: Record<string, unknown>,
  options?: { preserveSelectedIndex?: boolean },
): void {
  const rvt = body._routeDiscovery as
    | {
        routes?: Array<Record<string, unknown>>;
        enabled?: boolean;
        outcome?: string;
        selected?: Record<string, unknown>;
        tradesFetched?: number;
        pairTradeCount?: number;
      }
    | undefined;
  if (Array.isArray(rvt?.routes) && rvt.routes.length > 0) {
    lastVybeQuoteBodyForRoutes = body;
    const routes = rvt.routes.map(mapEnumeratedRouteEntry);
    const prevSelected = enumeratedRoutesUiState?.selectedIndex;
    const defaultIndex = routes[0]?.index ?? 0;
    const selectedIndex =
      options?.preserveSelectedIndex &&
      prevSelected != null &&
      routes.some((r) => r.index === prevSelected)
        ? prevSelected
        : defaultIndex;
    enumeratedRoutesUiState = {
      routes,
      selectedIndex,
      expanded: options?.preserveSelectedIndex
        ? (enumeratedRoutesUiState?.expanded ?? false)
        : false,
    };
    return;
  }

  if (!swapRouteOptionsPanelActive() && !isSwapRoutePinMode()) {
    enumeratedRoutesUiState = null;
    lastVybeQuoteBodyForRoutes = null;
    return;
  }

  const candidate = tradeCandidateFromActiveQuote(body);
  if (!routeOptionCandidatePresent(candidate)) {
    enumeratedRoutesUiState = null;
    lastVybeQuoteBodyForRoutes = null;
    return;
  }

  const liquidity = poolLiquidityFromQuoteBody(body);
  lastVybeQuoteBodyForRoutes = body;
  enumeratedRoutesUiState = {
    routes: [
      {
        index: 0,
        source: inferRouteOptionSource(body, rvt ?? {}),
        candidate: candidate && liquidity != null ? { ...candidate, liquidity } : candidate,
        quote: stripVybeQuoteMetadata(body),
      },
    ],
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
  const routesMeta = (body._routeDiscovery as { routes?: Array<{ index?: number; build?: unknown }> } | undefined)
    ?.routes;
  const routeBuild =
    route.build ??
    (routesMeta?.find((r) => Number(r.index) === route.index)?.build as
      | Record<string, unknown>
      | undefined);
  // Never fall back to the primary route's `_build` for a different selected card.
  const primaryIndex = enumeratedRoutesUiState.routes[0]?.index ?? 0;
  const build =
    routeBuild ?? (route.index === primaryIndex ? body._build : undefined);
  return {
    ...body,
    ...route.quote,
    ...(build != null ? { _build: build } : {}),
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
  const buildPayload = body._build as Record<string, unknown> | undefined;
  if (buildPayload) {
    quote = applyFeeEnrichmentToQuote(quote, undefined, projectSwapBuildForBrowser(buildPayload));
  }
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
      paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, amount, vybeCacheBuildOpts(buildOpts)),
      buildPayload: body._build,
    };
  }
  renderRawResponsePanels();
  renderSwapQuoteUI(quote);
  renderRouteOptionsPanel();
  void enrichRouteLabels(quote, { skipPricePrefetch: true });
  if (swapBuildBtn) syncBuildButtonState();
  syncSwapBuildResultFromQuote();
}

let routeWarningConfirmResolver: ((confirmed: boolean) => void) | null = null;

function settleRouteWarningConfirm(confirmed: boolean): void {
  const resolve = routeWarningConfirmResolver;
  routeWarningConfirmResolver = null;
  if (routeWarningConfirmDialogEl?.open) routeWarningConfirmDialogEl.close();
  resolve?.(confirmed);
}

function confirmRouteWarningSelection(
  message: string,
  level: Exclude<SwapRouteWarningLevel, 'none'>,
): Promise<boolean> {
  if (!routeWarningConfirmDialogEl || !routeWarningConfirmMessageEl || !routeWarningConfirmMessageTextEl) {
    return Promise.resolve(false);
  }
  if (routeWarningConfirmResolver) settleRouteWarningConfirm(false);
  routeWarningConfirmMessageTextEl.textContent = message;
  routeWarningConfirmMessageEl.classList.toggle(
    'swap-quote-simulation-warning--severe',
    level === 'red',
  );
  routeWarningConfirmMessageEl.classList.toggle(
    'swap-quote-simulation-warning--caution',
    level !== 'red',
  );
  return new Promise((resolve) => {
    routeWarningConfirmResolver = resolve;
    if (!routeWarningConfirmDialogEl.open) routeWarningConfirmDialogEl.showModal();
  });
}

function routeEntryWarning(
  route: NonNullable<typeof enumeratedRoutesUiState>['routes'][number],
): { level: Exclude<SwapRouteWarningLevel, 'none'>; message: string } | null {
  if (!enumeratedRoutesUiState) return null;
  const warning = getRouteMarketWarning(
    enumeratedRoutesUiState.routes,
    route,
    getSwapOutSym(),
  );
  if (warning.level === 'none' || !warning.message) return null;
  return { level: warning.level, message: warning.message };
}

function applyEnumeratedRouteSelection(index: number): void {
  if (!enumeratedRoutesUiState || !lastVybeQuoteBodyForRoutes) return;
  const route = enumeratedRoutesUiState.routes.find((r) => r.index === index);
  if (!route) return;
  if (!isEnumeratedRouteSelectable(enumeratedRoutesUiState.routes, index)) return;
  enumeratedRoutesUiState = { ...enumeratedRoutesUiState, selectedIndex: index };
  applyEnumeratedRouteCandidateToPinFields(route.candidate);
  renderRouteOptionsPanel();
  const wallet = swapQuoteWalletSnapshot ?? swapWalletAddressInput?.value.trim() ?? '';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = parseSwapAmountInputValue(swapAmountInput?.value ?? '');
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
  syncSwapQuoteButtonState();
}

function selectEnumeratedRoute(
  index: number,
  options?: { confirmWarnings?: boolean },
): void {
  void (async () => {
    if (!enumeratedRoutesUiState || !lastVybeQuoteBodyForRoutes) return;
    const route = enumeratedRoutesUiState.routes.find((r) => r.index === index);
    if (!route) return;
    if (!isEnumeratedRouteSelectable(enumeratedRoutesUiState.routes, index)) return;
    if (index === enumeratedRoutesUiState.selectedIndex) return;

    if (options?.confirmWarnings) {
      const warning = routeEntryWarning(route);
      if (warning) {
        const confirmed = await confirmRouteWarningSelection(warning.message, warning.level);
        if (!confirmed) return;
        if (!enumeratedRoutesUiState?.routes.some((r) => r.index === index)) return;
        if (!isEnumeratedRouteSelectable(enumeratedRoutesUiState.routes, index)) return;
      }
    }

    applyEnumeratedRouteSelection(index);
  })();
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
  const quoteRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  if (isSwapRouterId(quoteRouter)) clearRouterQuoteCache(quoteRouter);
  if (body._tokenStats) {
    for (const [mint, s] of Object.entries(body._tokenStats)) {
      saveTokenPriceStatsForUi(mint, s);
    }
    updateSwapPairCards(body._tokenStats, swapQuoteFetching);
  }
  quotedMintSession.add(inputMint);
  quotedMintSession.add(outputMint);
  const multiHopEnumerateRefetch = isMultiHopEnumerateRouteRefetch(buildOpts);
  const preserveEnumeratedRoutes = shouldPreserveEnumeratedRoutesOnQuoteApply(buildOpts);
  const prevEnrichedQuote = (() => {
    if ((preserveEnumeratedRoutes || multiHopEnumerateRefetch) && enumeratedRoutesUiState) {
      const selectedIndex = enumeratedRoutesUiState.selectedIndex;
      const route = enumeratedRoutesUiState.routes.find((r) => r.index === selectedIndex);
      if (route?.quote && typeof route.quote === 'object') {
        return route.quote as Record<string, unknown>;
      }
    }
    return lastSwapQuoteOk;
  })();
  if (multiHopEnumerateRefetch) {
    syncEnumeratedRoutesFromBody(body, { preserveSelectedIndex: true });
  } else if (preserveEnumeratedRoutes) {
    mergePinnedRouteQuoteIntoEnumeratedRoutes(body);
  } else {
    syncEnumeratedRoutesFromBody(body);
  }
  const quoteBody =
    preserveEnumeratedRoutes && lastVybeQuoteBodyForRoutes ? lastVybeQuoteBodyForRoutes : body;
  const activeBody = getQuoteBodyForActiveRoute(quoteBody);
  const selectedRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  let quote = annotateQuoteRouterMeta(stripVybeQuoteMetadata(activeBody), selectedRouter);
  const buildPayload = activeBody._build as Record<string, unknown> | undefined;
  if (buildPayload) {
    quote = applyFeeEnrichmentToQuote(quote, undefined, projectSwapBuildForBrowser(buildPayload));
  }
  if (buildOpts.enrich === false && prevEnrichedQuote) {
    quote = preserveQuoteEnrichmentDisplay(prevEnrichedQuote, quote);
  }
  quote = attachQuoteTokenPriceMeta(quote, inputMint, outputMint);
  quote = mergeQuoteTokenStatsFromBody(quote, body._tokenStats);
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
  cacheVybeQuoteBuild(activeBody, wallet, inputMint, outputMint, effectiveAmount, vybeCacheBuildOpts(buildOpts));
  if (swapQuoteError) clearInlineError(swapQuoteError);
  const rvt = body._routeDiscovery as {
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
      let summary = 'Route discovery: pinned pools unavailable';
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
  void enrichRouteLabels(quote, { skipPricePrefetch: true });
  rememberSwapQuoteBuildOptsKey();
  rememberSwapQuoteFormContextKey();
  rememberSwapQuoteEnumerateRoutes(buildOpts);
  if (swapBuildBtn) syncBuildButtonState();
  syncSwapBuildResultFromQuote();
  syncSwapQuoteButtonState();
}

async function fetchAggregatorSwapQuote(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippage: number | undefined,
  router: string,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  params.set('amount', String(amount));
  params.set('inputMintAddress', inputMint);
  params.set('outputMintAddress', outputMint);
  if (wallet) params.set('accountAddress', wallet);
  if (typeof slippage === 'number' && Number.isFinite(slippage)) {
    params.set('slippage', String(slippage));
  }
  const routerId = normalizeRouterId(router);
  if (routerId === 'jupiter' || routerId === 'titan') {
    params.set('router', routerId);
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
    router,
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
          router,
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

  const atomicBuild = quoteBody._build as Record<string, unknown> | undefined;
  const atomicTx = extractSwapBuildTransaction(atomicBuild);
  let swapBody: Record<string, unknown>;
  if (atomicTx && atomicBuild) {
    // Router-specific GET swap-quote returns quote + build atomically — reuse it so
    // displayed outAmount/min-received match the signed transaction.
    swapBody = projectSwapBuildForBrowser(atomicBuild);
  } else {
    const routePlan = Array.isArray(quoteBody.routePlan) ? quoteBody.routePlan : undefined;
    const swapRes = await fetchWithRetry('/api/trading/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        accountAddress: wallet,
        amount: buildAmount,
        inputMintAddress: inputMint,
        outputMintAddress: outputMint,
        ...(routePlan ? { routePlan } : {}),
        ...buildOpts,
        router,
        ...buildSwapClientParams(inputMint, outputMint),
      }),
    });
    swapBody = (await swapRes.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: string;
    };
    if (!swapRes.ok) {
      throw new Error(swapBody.error || `Build failed (${swapRes.status})`);
    }
    swapBody = projectSwapBuildForBrowser(swapBody);
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
  const signActive = isSwapSignDialogActive();
  const quoteParamsDetail = formatAggregatorQuoteParamsForSignLog(
    wallet,
    inputMint,
    outputMint,
    amount,
    buildOpts,
  );
  let quoteStarted = 0;
  if (signActive) {
    quoteStarted = performance.now();
    recordSwapSignQuoteTxStart('swap-quote');
    appendSwapSignLog('Requesting swap-quote + build…', 'pending', quoteParamsDetail);
  }
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
      if (signActive) {
        recordSwapSignQuoteTxDone();
        appendSwapSignLog(
          `Quote tx received in ${formatSignLogDurationMs(performance.now() - quoteStarted)}`,
          'neutral',
        );
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
  const quoteRouter = normalizeRouterId(router);
  if (isSwapRouterId(quoteRouter)) clearRouterQuoteCache(quoteRouter);
  quotedMintSession.add(inputMint);
  quotedMintSession.add(outputMint);
  lastRawQuoteResponse = quoteBody;
  lastRawSwapResponse = swapBody;

  const tokenStats = quoteBody._tokenStats as Record<string, TokenPriceStats> | undefined;
  if (tokenStats) {
    for (const [mint, s] of Object.entries(tokenStats)) {
      saveTokenPriceStatsForUi(mint, s);
    }
    updateSwapPairCards(tokenStats);
  }

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
  quote = mergeQuoteTokenStatsFromBody(quote, tokenStats);
  lastSwapQuoteOk = quote;
  swapQuoteWalletSnapshot = wallet;

  syncEnumeratedRoutesFromBody({ ...quote, _build: swapBody });

  const buildTx = extractSwapBuildTransaction(swapBody);
  if (buildTx) {
    lastVybeBuild = {
      tx: buildTx,
      builtAt: Date.now(),
      paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, effectiveAmount, vybeCacheBuildOpts(buildOpts)),
      buildPayload: swapBody,
    };
  }

  renderRawResponsePanels();
  renderSwapQuoteUI(quote);
  openRoutePlanPanelIfClosed();
  void enrichRouteLabels(quote, { skipPricePrefetch: Boolean(tokenStats) });
  rememberSwapQuoteBuildOptsKey();
  rememberSwapQuoteFormContextKey();
  rememberSwapQuoteEnumerateRoutes(buildOpts);
  if (swapBuildBtn) syncBuildButtonState();
  syncSwapBuildResultFromQuote();
  syncSwapQuoteButtonState();
}

async function resolveAggregatorBuildTx(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  const cachedFromQuote = tryReuseLastVybeBuildFromQuote();
  if (cachedFromQuote) {
    lastRawSwapResponse = cachedFromQuote.buildPayload;
    renderRawResponsePanels();
    return cachedFromQuote;
  }
  const cacheOpts = vybeCacheBuildOpts(buildOpts);
  const paramsKey = vybeBuildParamsKey(wallet, inputMint, outputMint, amount, cacheOpts);
  if (isVybeQuoteTxFresh(paramsKey) && lastVybeBuild) {
    lastRawSwapResponse = lastVybeBuild.buildPayload;
    renderRawResponsePanels();
    return {
      tx: lastVybeBuild.tx,
      buildPayload: projectSwapBuildForBrowser(lastVybeBuild.buildPayload as Record<string, unknown>),
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
  options?: { skipEnsurePrices?: boolean },
): Promise<{ tx: string; buildPayload: Record<string, unknown> }> {
  if (!options?.skipEnsurePrices) {
    await ensureResolvePricesBeforeQuote(inputMint, outputMint);
  }

  const originalAmount = amount;
  let attemptAmount = amount;
  let splSimStep = 0;
  let lastBody: VybeQuoteApiBody | null = null;
  const selectedRouter = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const signActive = isSwapSignDialogActive();
  const quoteParamsDetail = formatVybeQuoteParamsForSignLog(
    wallet,
    inputMint,
    outputMint,
    amount,
    buildOpts,
  );
  let quoteStarted = 0;
  if (signActive) {
    quoteStarted = performance.now();
    recordSwapSignQuoteTxStart('vybe-quote');
    appendSwapSignLog('Requesting vybe-quote…', 'pending', quoteParamsDetail);
  }

  while (splSimStep < SPL_SELL_SIM_MAX_ATTEMPTS_PER_ROUTER) {
    const res = await fetchWithRetry('/api/trading/vybe-quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        accountAddress: wallet,
        amount: attemptAmount,
        inputMintAddress: inputMint,
        outputMintAddress: outputMint,
        ...buildOpts,
        router: selectedRouter,
        ...buildSwapClientParams(inputMint, outputMint),
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
      if (signActive) {
        recordSwapSignQuoteTxDone();
        appendSwapSignLog(
          `Quote tx received in ${formatSignLogDurationMs(performance.now() - quoteStarted)}`,
          'neutral',
        );
      }
      return { tx: buildTx, buildPayload: projectSwapBuildForBrowser(body._build as Record<string, unknown>) };
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
  const cachedFromQuote = tryReuseLastVybeBuildFromQuote();
  if (cachedFromQuote) {
    if (isSwapSignDialogActive()) {
      recordSwapSignQuoteTxCached('vybe-quote');
      appendSwapSignLog('Using cached vybe-quote tx', 'neutral');
    }
    lastRawSwapResponse = cachedFromQuote.buildPayload;
    renderRawResponsePanels();
    return cachedFromQuote;
  }
  const cacheOpts = vybeCacheBuildOpts(buildOpts);
  const paramsKey = vybeBuildParamsKey(wallet, inputMint, outputMint, amount, cacheOpts);
  if (isVybeQuoteTxFresh(paramsKey) && lastVybeBuild) {
    if (isSwapSignDialogActive()) {
      recordSwapSignQuoteTxCached('vybe-quote');
      appendSwapSignLog('Using cached vybe-quote tx', 'neutral');
    }
    lastRawSwapResponse = lastVybeBuild.buildPayload;
    renderRawResponsePanels();
    return {
      tx: lastVybeBuild.tx,
      buildPayload: projectSwapBuildForBrowser(lastVybeBuild.buildPayload as Record<string, unknown>),
    };
  }
  return requestVybeQuote(wallet, inputMint, outputMint, amount, buildOpts, {
    skipEnsurePrices: true,
  });
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
  const mints = mintsForPricePrefetch([inputMint, outputMint].filter(Boolean));
  const forceFullCanonical = dedupeMintsForPriceResolve(forceFullDetailsMints);
  const res = await fetchWithRetry('/api/tokens/resolve-prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mints,
      forceFullDetailsMints: forceFullCanonical,
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
    saveTokenPriceStatsForUi(mint, s);
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
  const connected = getBrowserWalletAddress();
  if (!connected) {
    return 'Connect your wallet to get a quote.';
  }
  if (connected !== wallet) {
    return 'Connected wallet does not match the address field.';
  }
  return null;
}

async function refreshSelectedRouteQuote(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
): Promise<void> {
  if (swapNoLiquidityStickyActiveForForm()) {
    reapplySwapNoLiquidityStickyUi();
    return;
  }
  if (swapQuoteError) clearInlineError(swapQuoteError);
  if (swapQuoteWarning) clearInlineWarning(swapQuoteWarning);
  applyQuoteLoadingUi();

  try {
    const buildOpts = collectSwapBuildOptions();
    if (enumeratedRoutesUiState?.routes.length && !selectedRoutePinFields()) {
      throw new Error('Select a route market before refreshing the quote.');
    }
    const pinnedOpts = mergeSelectedRoutePinIntoBuildOpts(buildOpts);
    const quoteAmount =
      typeof pinnedOpts.amount === 'number' && Number.isFinite(pinnedOpts.amount)
        ? pinnedOpts.amount
        : amount;
    void refreshLowSolTradeWarning();

    const priceStats = await resolvePairTokenPrices(inputMint, outputMint, [inputMint, outputMint]);
    updateSwapPairCards(priceStats);
    updateSwapTokenIcons();
    syncSwapSellAmountUi();

    pushSuppressClientPriceResolve();
    try {
      const walletErr = validateVybeQuoteWallet();
      if (walletErr) throw new Error(walletErr);
      await requestVybeQuote(
        wallet,
        inputMint,
        outputMint,
        quoteAmount,
        swapBuildOptsForRefetchQuote(pinnedOpts),
        { skipEnsurePrices: true },
      );
    } finally {
      popSuppressClientPriceResolve();
    }

    if (!lastSwapQuoteOk) {
      throw new Error('Quote refresh failed.');
    }
  } catch (err) {
    handleSwapQuoteFetchFailure(err);
  } finally {
    swapQuoteFetching = false;
    setSwapQuoteButtonLoading(false, { skipEnableSync: lastSwapQuoteOk != null });
    if (lastSwapQuoteOk) {
      startSwapActionCooldownsAfterQuote();
    } else {
      setBuyReadoutLoading(false);
      setBuyFiatLoading(false);
      setFooterStatsLoading(false);
    }
    syncSwapQuoteButtonState();
    syncSwapRouterSwitchState();
    syncBuildButtonState();
    if (swapQuoteLoading) {
      swapQuoteLoading.hidden = true;
      swapQuoteLoading.setAttribute('aria-hidden', 'true');
    }
  }
}

async function fetchSwapQuote(): Promise<void> {
  if (!swapInputMintInput || !swapOutputMintInput || !swapAmountInput) return;
  if (tryFlashValidationFieldsOnQuoteAttempt()) return;
  if (!isSwapQuoteInputReady()) return;
  const inputMint = swapInputMintInput.value.trim();
  const outputMint = swapOutputMintInput.value.trim();
  if (swapNoLiquidityStickyActiveForForm()) {
    reapplySwapNoLiquidityStickyUi();
    return;
  }
  const amount = parseSwapAmountInputValue(swapAmountInput.value);
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
    if (amountExceedsWalletBalance(amount, inputMint)) {
      syncSwapSellAmountUi();
      const item = getWalletBalanceListItem(inputMint);
      const totalBal =
        item != null ? Number(maxSwapInputStringForWalletItem(item)) : getWalletBalanceAmountUi(inputMint);
      if (swapQuoteError && totalBal != null) {
        showInlineError(
          swapQuoteError,
          `Amount exceeds wallet balance (${formatSwapInputAmountValue(totalBal, getMintDecimals(inputMint))}).`,
        );
      }
      void recoverSellAmountAfterBalanceError(inputMint);
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

  if (isSwapQuoteRefreshMode() && !shouldRefetchMarketsAfterEnablingEnumeration()) {
    await refreshSelectedRouteQuote(wallet, inputMint, outputMint, amount);
    return;
  }

  lastSwapQuoteOk = null;
  lastVybeBuild = null;
  clearBuildBtnQuoteWindow();
  if (swapBuildBtn) syncBuildButtonState();
  resetSwapQuoteDetailsPanel();
  if (swapQuoteError) clearInlineError(swapQuoteError);
  if (swapQuoteWarning) clearInlineWarning(swapQuoteWarning);
  if (swapRouteOptionsWarningEl) {
    swapRouteOptionsWarningEl.hidden = true;
    swapRouteOptionsWarningEl.setAttribute('aria-hidden', 'true');
    swapRouteOptionsWarningEl.innerHTML = '';
  }
  applyQuoteLoadingUi();

  try {
    const buildOpts = swapBuildOptsWithEnrich(collectSwapBuildOptions());
    const quoteAmount =
      typeof buildOpts.amount === 'number' && Number.isFinite(buildOpts.amount)
        ? buildOpts.amount
        : amount;
    void refreshLowSolTradeWarning();

    try {
      await requestVybeQuote(wallet, inputMint, outputMint, quoteAmount, buildOpts);
    } catch (quoteErr) {
      handleSwapQuoteFetchFailure(quoteErr);
    }
  } catch (err) {
    handleSwapQuoteFetchFailure(err);
  } finally {
    swapQuoteFetching = false;
    setSwapQuoteButtonLoading(false, { skipEnableSync: lastSwapQuoteOk != null });
    if (lastSwapQuoteOk) {
      startSwapActionCooldownsAfterQuote();
      rememberSwapQuoteFormContextKey();
    } else {
      setBuyReadoutLoading(false);
      setBuyFiatLoading(false);
      setFooterStatsLoading(false);
    }
    syncSwapQuoteButtonState();
    syncSwapRouterSwitchState();
    syncBuildButtonState();
    if (swapQuoteLoading) {
      swapQuoteLoading.hidden = true;
      swapQuoteLoading.setAttribute('aria-hidden', 'true');
    }
  }
}

let swapSignFlowGeneration = 0;
let swapSignPendingLogEl: HTMLElement | null = null;
let swapSignDialogSuccess = false;
let swapSignRetryContext: {
  quote: Record<string, unknown>;
  buildPayload: Record<string, unknown>;
  txStrings: string[];
} | null = null;
/** Show Refetch & Retry only after the user rejects signing or on-chain confirmation fails. */
let swapSignRefetchRetryEligible = false;
let swapSignSuccessContext: {
  soldMint: string;
  buyMint: string;
  signatures: string[];
} | null = null;

type SwapSignPrepTimings = {
  pricesStartedAt?: number;
  pricesFinishedAt?: number;
  pricesMints?: string[];
  pricesSkipped?: boolean;
  quoteStartedAt?: number;
  quoteFinishedAt?: number;
  quoteCached?: boolean;
  quoteLabel?: string;
};

let swapSignPrepTimings: SwapSignPrepTimings = {};

function resetSwapSignPrepTimings(): void {
  swapSignPrepTimings = {};
}

function isWalletSignRejection(err: unknown): boolean {
  const rec = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  const code = rec?.code;
  if (code === 4001 || code === '4001') return true;
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request') ||
    msg.includes('request rejected') ||
    msg.includes('approval denied') ||
    msg.includes('transaction cancelled') ||
    msg.includes('signing cancelled')
  );
}

function showSwapSignRefetchRetry(): void {
  swapSignRefetchRetryEligible = true;
  syncSignDialogRefetchButton();
}

function hideSwapSignRefetchRetry(): void {
  swapSignRefetchRetryEligible = false;
  syncSignDialogRefetchButton();
}

function isSwapSignConfirmDialogOpen(): boolean {
  return Boolean(swapSignConfirmDialogEl?.open);
}

function isSwapSignDialogActive(): boolean {
  return isSwapSignConfirmDialogOpen();
}

function formatSignLogDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSignLogAddress(value: string): string {
  const v = value.trim();
  if (v.length <= 12) return v;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function mintMatchesSwapSide(mint: string, sideMint: string): boolean {
  if (!mint || !sideMint) return false;
  if (mint === sideMint) return true;
  return isSolMint(mint) && isSolMint(sideMint);
}

function formatSignLogMint(mint: string): string {
  const m = mint.trim();
  if (!m) return '—';
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  if (inputMint && mintMatchesSwapSide(m, inputMint)) {
    const sym = getSwapInSym();
    if (sym !== '—') return sym;
  }
  if (outputMint && mintMatchesSwapSide(m, outputMint)) {
    const sym = getSwapOutSym();
    if (sym !== '—') return sym;
  }
  return mintSymbolSync(m);
}

function formatSignLogMintList(mints: string[]): string {
  return mints.map(formatSignLogMint).join(', ');
}

function lookupResolvePriceStat(
  mint: string,
  stats: Record<string, TokenPriceStats>,
): TokenPriceStats | undefined {
  const m = mint.trim();
  if (stats[m]) return stats[m];
  if (isSolMint(m)) {
    const sol = stats[WSOL_MINT] ?? stats[NATIVE_SOL_MINT];
    if (sol) return sol;
  }
  const session = getSessionTokenPriceStats(m);
  if (session) return session;
  if (isSolMint(m)) {
    return getSessionTokenPriceStats(WSOL_MINT) ?? getSessionTokenPriceStats(NATIVE_SOL_MINT);
  }
  return undefined;
}

function formatPriceResolveSourceLabel(source: string | undefined): string {
  const s = source?.trim() ?? '';
  if (!s) return '—';
  if (s === 'Pumpfun-API') return 'pumpfun-api';
  return s.toLowerCase();
}

function formatResolvePriceTokenLogLine(
  mint: string,
  stats: Record<string, TokenPriceStats>,
): string {
  const stat = lookupResolvePriceStat(mint, stats);
  const sym = formatSignLogMint(mint);
  const source = formatPriceResolveSourceLabel(stat?.source);
  const ms =
    typeof stat?.responseTimeMs === 'number' && Number.isFinite(stat.responseTimeMs)
      ? `${Math.round(stat.responseTimeMs)}ms`
      : '—';
  return `${sym} · ${source} · ${ms}`;
}

function appendResolvePricesSignLogs(
  mints: string[],
  stats: Record<string, TokenPriceStats>,
  options?: { headline?: string },
): void {
  if (options?.headline) appendSwapSignLog(options.headline, 'neutral');
  for (const mint of mints) {
    appendSwapSignLog(formatResolvePriceTokenLogLine(mint, stats), 'neutral');
  }
}

function sessionStatsForResolveLogMints(mints: string[]): Record<string, TokenPriceStats> {
  const out: Record<string, TokenPriceStats> = {};
  for (const mint of mints) {
    const fromSession =
      getSessionTokenPriceStats(mint) ??
      (isSolMint(mint)
        ? getSessionTokenPriceStats(WSOL_MINT) ?? getSessionTokenPriceStats(NATIVE_SOL_MINT)
        : undefined);
    if (fromSession) out[mint.trim()] = fromSession;
  }
  return out;
}

function formatVybeQuoteParamsForSignLog(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): string {
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const parts = [
    `wallet=${wallet.length > 12 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet}`,
    `router=${router}`,
    `amount=${amount}`,
    `in=${formatSignLogMint(inputMint)}`,
    `out=${formatSignLogMint(outputMint)}`,
  ];
  const pool = String(buildOpts.poolAddress ?? '').trim();
  if (pool) parts.push(`pool=${formatSignLogAddress(pool)}`);
  const slip = buildOpts.slippage;
  if (typeof slip === 'number' && Number.isFinite(slip)) parts.push(`slippage=${slip}`);
  return parts.join(' · ');
}

function formatAggregatorQuoteParamsForSignLog(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  buildOpts: Record<string, unknown>,
): string {
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());
  const parts = [
    `wallet=${wallet.length > 12 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet}`,
    `router=${router}`,
    `amount=${amount}`,
    `in=${formatSignLogMint(inputMint)}`,
    `out=${formatSignLogMint(outputMint)}`,
  ];
  const slip = buildOpts.slippage;
  if (typeof slip === 'number' && Number.isFinite(slip)) parts.push(`slippage=${slip}`);
  return parts.join(' · ');
}

function recordSwapSignResolvePricesStart(mints: string[]): void {
  swapSignPrepTimings.pricesStartedAt = performance.now();
  swapSignPrepTimings.pricesFinishedAt = undefined;
  swapSignPrepTimings.pricesMints = [...mints];
  swapSignPrepTimings.pricesSkipped = false;
}

function recordSwapSignResolvePricesDone(): void {
  swapSignPrepTimings.pricesFinishedAt = performance.now();
}

function recordSwapSignResolvePricesSkipped(mints: string[]): void {
  const now = performance.now();
  swapSignPrepTimings.pricesStartedAt = now;
  swapSignPrepTimings.pricesFinishedAt = now;
  swapSignPrepTimings.pricesMints = [...mints];
  swapSignPrepTimings.pricesSkipped = true;
}

function recordSwapSignQuoteTxStart(label: string): void {
  swapSignPrepTimings.quoteStartedAt = performance.now();
  swapSignPrepTimings.quoteFinishedAt = undefined;
  swapSignPrepTimings.quoteCached = false;
  swapSignPrepTimings.quoteLabel = label;
}

function recordSwapSignQuoteTxDone(): void {
  swapSignPrepTimings.quoteFinishedAt = performance.now();
}

function recordSwapSignQuoteTxCached(label = 'quote tx'): void {
  const now = performance.now();
  swapSignPrepTimings.quoteStartedAt = now;
  swapSignPrepTimings.quoteFinishedAt = now;
  swapSignPrepTimings.quoteCached = true;
  swapSignPrepTimings.quoteLabel = label;
}

function logSwapSignPrepTimingsAfterSign(): void {
  if (!isSwapSignDialogActive()) return;
  const t = swapSignPrepTimings;
  const parts: string[] = [];
  if (t.pricesStartedAt != null && t.pricesFinishedAt != null) {
    const label = t.pricesSkipped ? 'prices (cached)' : 'prices';
    parts.push(`${label}: ${formatSignLogDurationMs(t.pricesFinishedAt - t.pricesStartedAt)}`);
  }
  if (t.quoteStartedAt != null && t.quoteFinishedAt != null) {
    const label = t.quoteCached ? `${t.quoteLabel ?? 'quote tx'} (cached)` : (t.quoteLabel ?? 'quote tx');
    parts.push(`${label}: ${formatSignLogDurationMs(t.quoteFinishedAt - t.quoteStartedAt)}`);
  }
  if (parts.length > 0) {
    appendSwapSignLog(`Prep timings — ${parts.join(' · ')}`, 'neutral');
  }
}

type SwapSignLogTone = 'neutral' | 'pending' | 'success' | 'error';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SWAP_SIGN_CANCEL_BUTTON_HTML = 'Cancel';
const SWAP_SIGN_CLOSE_BUTTON_HTML = 'Close';

function setSwapSignCancelButtonLabel(mode: 'cancel' | 'close'): void {
  if (!swapSignConfirmCancelEl) return;
  swapSignConfirmCancelEl.classList.remove(
    'swap-sign-dialog__btn--primary',
    'swap-sign-dialog__btn--secondary',
  );
  if (mode === 'close') {
    swapSignConfirmCancelEl.classList.add('swap-sign-dialog__btn--primary');
    swapSignConfirmCancelEl.textContent = SWAP_SIGN_CLOSE_BUTTON_HTML;
  } else {
    swapSignConfirmCancelEl.classList.add('swap-sign-dialog__btn--secondary');
    swapSignConfirmCancelEl.textContent = SWAP_SIGN_CANCEL_BUTTON_HTML;
  }
}

function resetSwapSignDialogUi(clearLogs = true): void {
  if (clearLogs && swapSignConfirmLogsEl) swapSignConfirmLogsEl.innerHTML = '';
  swapSignPendingLogEl = null;
  swapSignDialogSuccess = false;
  swapSignSuccessContext = null;
  swapSignRetryContext = null;
  swapSignRefetchRetryEligible = false;
  resetSwapSignPrepTimings();
  if (swapSignConfirmCancelEl) {
    swapSignConfirmCancelEl.hidden = false;
    swapSignConfirmCancelEl.disabled = false;
    setSwapSignCancelButtonLabel('cancel');
  }
  setSwapSignTxidButtonsState('hidden');
  syncSignDialogRefetchButton();
  if (swapSignConfirmRefetchRetryEl) swapSignConfirmRefetchRetryEl.disabled = false;
  if (swapSignConfirmRoutePanelEl) {
    swapSignConfirmRoutePanelEl.hidden = true;
    swapSignConfirmDialogEl?.classList.remove('swap-sign-dialog--with-route');
  }
  clearRoutingDiagram(swapSignConfirmRoutingEl);
  if (swapSignConfirmRouteStepsEl) swapSignConfirmRouteStepsEl.innerHTML = '';
}

function setSignDialogRefetchButtonDisabled(disabled: boolean): void {
  if (swapSignConfirmRefetchRetryEl) swapSignConfirmRefetchRetryEl.disabled = disabled;
}

/** Refetch & Retry — only after sign rejection or failed confirmation. */
function syncSignDialogRefetchButton(): void {
  const show = Boolean(
    swapSignConfirmDialogEl?.open && !swapSignDialogSuccess && swapSignRefetchRetryEligible,
  );
  if (swapSignConfirmRefetchRetryEl) {
    swapSignConfirmRefetchRetryEl.hidden = !show;
    swapSignConfirmRefetchRetryEl.style.display = show ? '' : 'none';
  }
}

function setSwapSignTxidButtonsState(mode: 'hidden' | 'pending' | 'ready'): void {
  if (!swapSignConfirmTxidsEl) return;
  swapSignConfirmTxidsEl.innerHTML = '';
  const sigs = (swapSignSuccessContext?.signatures ?? []).map((s) => s.trim()).filter(Boolean);
  if (mode === 'hidden' || sigs.length === 0) {
    swapSignConfirmTxidsEl.hidden = true;
    return;
  }
  swapSignConfirmTxidsEl.hidden = false;
  const multi = sigs.length > 1;
  const enabled = mode === 'ready';
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i]!;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'swap-sign-dialog__btn swap-sign-dialog__btn--secondary swap-sign-dialog__solscan swap-sign-dialog__btn-with-icon';
    if (!enabled) btn.classList.add('swap-sign-dialog__solscan--pending');
    btn.disabled = !enabled;
    btn.dataset.signature = sig;
    const label = multi ? `View TXID #${i + 1}` : 'View TXID';
    btn.innerHTML = `<img class="swap-sign-dialog__btn-logo" src="/images/solscan-logo.png" alt="" width="16" height="16" decoding="async" /><span>${label}</span>`;
    swapSignConfirmTxidsEl.appendChild(btn);
  }
}

function setSwapSignDialogActions(state: 'running' | 'success' | 'failed'): void {
  swapSignDialogSuccess = state === 'success';
  if (state === 'running') hideSwapSignRefetchRetry();
  if (swapSignConfirmCancelEl) {
    swapSignConfirmCancelEl.hidden = false;
    swapSignConfirmCancelEl.disabled = false;
    setSwapSignCancelButtonLabel(state === 'success' ? 'close' : 'cancel');
  }
  if (state === 'success') {
    setSwapSignTxidButtonsState('ready');
  } else if ((swapSignSuccessContext?.signatures ?? []).some((s) => s.trim())) {
    setSwapSignTxidButtonsState('pending');
  } else {
    setSwapSignTxidButtonsState('hidden');
  }
  syncSignDialogRefetchButton();
}

function appendSwapSignLog(
  text: string,
  tone: SwapSignLogTone = 'neutral',
  detail?: string,
): HTMLElement | null {
  if (!swapSignConfirmLogsEl) return null;
  if (swapSignPendingLogEl) {
    swapSignPendingLogEl.classList.remove('swap-sign-dialog__log--pending');
    swapSignPendingLogEl = null;
  }
  const row = document.createElement('div');
  row.className = `swap-sign-dialog__log swap-sign-dialog__log--${tone}`;
  const label = document.createElement('span');
  label.className = 'swap-sign-dialog__log-text';
  label.textContent = text;
  row.appendChild(label);
  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'swap-sign-dialog__log-detail';
    detailEl.textContent = detail;
    row.appendChild(detailEl);
  }
  swapSignConfirmLogsEl.appendChild(row);
  swapSignConfirmLogsEl.scrollTop = swapSignConfirmLogsEl.scrollHeight;
  if (tone === 'pending') swapSignPendingLogEl = row;
  return row;
}

function syncSwapSignDialogRoutePanel(quote: Record<string, unknown>): void {
  if (!swapSignConfirmRoutePanelEl || !swapSignConfirmRoutingEl || !swapSignConfirmRouteStepsEl) {
    return;
  }
  if (!quoteHasRoutePlan(quote)) {
    swapSignConfirmRoutePanelEl.hidden = true;
    swapSignConfirmDialogEl?.classList.remove('swap-sign-dialog--with-route');
    clearRoutingDiagram(swapSignConfirmRoutingEl);
    swapSignConfirmRouteStepsEl.innerHTML = '';
    return;
  }
  swapSignConfirmRoutePanelEl.hidden = false;
  swapSignConfirmDialogEl?.classList.add('swap-sign-dialog--with-route');
  mountRoutingDiagram(swapSignConfirmRoutingEl, renderRoutingDiagram(quote));
  swapSignConfirmRouteStepsEl.innerHTML = renderQuoteRoutePlanSteps(quote);
  scheduleRoutingDiagramZoom();
}

function setSwapSignDialogSummary(
  quote: Record<string, unknown>,
  buildPayload?: Record<string, unknown>,
): void {
  if (swapSignConfirmSummaryEl) {
    swapSignConfirmSummaryEl.innerHTML = renderSignConfirmSummaryHtml(quote, buildPayload);
  }
  syncSwapSignDialogRoutePanel(quote);
}

function openSwapSignDialog(
  quote: Record<string, unknown>,
  buildPayload?: Record<string, unknown>,
  options?: { preserveLogs?: boolean },
): void {
  if (options?.preserveLogs) {
    swapSignPendingLogEl = null;
    swapSignDialogSuccess = false;
    swapSignSuccessContext = null;
    resetSwapSignPrepTimings();
    setSwapSignTxidButtonsState('hidden');
    syncSignDialogRefetchButton();
    if (swapSignConfirmCancelEl) {
      swapSignConfirmCancelEl.hidden = false;
      swapSignConfirmCancelEl.disabled = false;
      setSwapSignCancelButtonLabel('cancel');
    }
  } else {
    resetSwapSignDialogUi(true);
  }
  setSwapSignDialogSummary(quote, buildPayload);
  setSwapSignDialogActions('running');
  if (!swapSignConfirmDialogEl?.open) {
    swapSignConfirmDialogEl?.showModal();
    lockPageScroll();
  }
  syncSwapQuoteButtonState();
  syncBuildButtonState();
}

function restoreSwapActionButtonsAfterSignDialogClose(): void {
  if (swapQuoteFetching) swapQuoteFetching = false;
  setSwapQuoteButtonLoading(false);
  if (quoteBtnCooldownEndsAt > 0 && !isQuoteBtnInCooldown()) {
    clearQuoteBtnCooldown();
  }
  syncSwapRouterSwitchState();
  syncSwapQuoteButtonState();
  syncBuildButtonState();
}

function closeSwapSignDialog(): void {
  swapSignFlowGeneration++;
  if (swapSignConfirmDialogEl?.open) swapSignConfirmDialogEl.close();
  unlockPageScroll();
  resetSwapSignDialogUi();
  restoreSwapActionButtonsAfterSignDialogClose();
}

async function closeSwapSignDialogAfterSuccess(): Promise<void> {
  if (!swapSignSuccessContext) {
    closeSwapSignDialog();
    return;
  }

  const flippedOutputAmountUi = parseFlipOutputAmountUi();
  closeSwapSignDialog();

  if (postTxConfirmRefreshPromise) {
    try {
      await postTxConfirmRefreshPromise;
    } catch {
      // Best-effort; balance panel may still be stale.
    }
  }

  if (!swapInputMintInput?.value.trim() || !swapOutputMintInput?.value.trim()) return;

  invalidateSwapQuoteUi();
  flipSellBuyTokens({ force: true });
  await refreshSwapSymbols();
  afterSellBuyTokensFlipped(flippedOutputAmountUi);
}

function openSignatureOnSolscan(signature: string): void {
  const sig = signature.trim();
  if (!sig) return;
  window.open(
    `https://solscan.io/tx/${encodeURIComponent(sig)}`,
    '_blank',
    'noopener,noreferrer',
  );
}

async function pollTransactionConfirmation(
  signature: string,
  generation: number | null,
): Promise<{ ok: boolean; err?: string }> {
  const connection = getBrowserConnection();
  for (let attempt = 0; attempt < SWAP_TX_CONFIRM_MAX_POLLS; attempt++) {
    if (generation != null && generation !== swapSignFlowGeneration) {
      return { ok: false, err: 'Cancelled' };
    }
    await sleepMs(SWAP_TX_CONFIRM_POLL_MS);
    if (generation != null && generation !== swapSignFlowGeneration) {
      return { ok: false, err: 'Cancelled' };
    }
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status?.err) {
        return { ok: false, err: JSON.stringify(status.err) };
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return { ok: true };
      }
    } catch (err) {
      return {
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: false, err: 'Transaction confirmation timed out' };
}

/** Confirm each leg in order; refresh only after the last signature is confirmed. */
async function pollAllTransactionConfirmations(
  signatures: string[],
  generation: number | null,
  onLeg?: (leg: number, total: number) => void,
): Promise<{ ok: boolean; err?: string }> {
  const sigs = signatures.map((s) => s.trim()).filter(Boolean);
  if (sigs.length === 0) return { ok: false, err: 'No transaction signatures' };

  for (let i = 0; i < sigs.length; i++) {
    if (sigs.length > 1) onLeg?.(i + 1, sigs.length);
    const confirmed = await pollTransactionConfirmation(sigs[i]!, generation);
    if (!confirmed.ok) return confirmed;
  }
  return { ok: true };
}

async function signAndSendSwapLegs(txStrings: string[]): Promise<string[]> {
  const txs = txStrings.map((t) => t.trim()).filter(Boolean);
  if (txs.length === 0) throw new Error('No transaction to sign.');

  const provider = getSolanaWalletProvider();
  if (!provider?.signTransaction && !provider?.signAllTransactions && !provider?.signAndSendTransaction) {
    throw new Error('Connected wallet cannot sign transactions.');
  }

  const prepared = await Promise.all(txs.map((t) => prepareSwapTxForSigning(t)));
  const connection = getBrowserConnection();
  const signatures: string[] = [];

  if (txs.length === 1 && provider.signAndSendTransaction) {
    const { signature } = await provider.signAndSendTransaction(prepared[0]!, { skipPreflight: false });
    signatures.push(signature);
    return signatures;
  }

  if (txs.length > 1 && !provider.signAllTransactions) {
    throw new Error(
      'This route requires multiple transactions. Use a wallet that supports signAllTransactions (e.g. Phantom).',
    );
  }

  const signed =
    txs.length === 1 && provider.signTransaction
      ? [await provider.signTransaction(prepared[0]!)]
      : await provider.signAllTransactions!(prepared);

  // Quote-bridge post-swap: leg 2 spends WSOL produced by leg 1 — confirm each leg before the next send.
  for (let i = 0; i < signed.length; i++) {
    const stx = signed[i]!;
    const sig = await connection.sendRawTransaction(stx.serialize(), { skipPreflight: false });
    signatures.push(sig);
    if (i < signed.length - 1) {
      const confirmed = await pollTransactionConfirmation(sig, null);
      if (!confirmed.ok) {
        throw new Error(
          confirmed.err ?? `Transaction leg ${i + 1} failed to confirm before sending leg ${i + 2}`,
        );
      }
    }
  }
  return signatures;
}

async function completeSwapSignFlow(generation: number, txStrings: string[]): Promise<void> {
  appendSwapSignLog('Waiting for user to sign transaction', 'pending');
  let signatures: string[];
  try {
    signatures = await signAndSendSwapLegs(txStrings);
  } catch (err) {
    if (generation !== swapSignFlowGeneration) return;
    if (isWalletSignRejection(err)) {
      appendSwapSignLog('User rejected the request.', 'error');
      showSwapSignRefetchRetry();
      setSwapSignDialogActions('failed');
      return;
    }
    throw err;
  }
  if (generation !== swapSignFlowGeneration) return;

  appendSwapSignLog('User signed transaction', 'success');
  logSwapSignPrepTimingsAfterSign();
  const lastSig = signatures[signatures.length - 1] ?? '';
  if (!lastSig) throw new Error('Wallet did not return a transaction signature.');

  if (signatures.length > 1) {
    appendSwapSignLog(`Sent ${signatures.length} transactions`, 'neutral');
  } else {
    appendSwapSignLog(`Transaction sent: ${lastSig}`, 'neutral');
  }

  swapSignSuccessContext = {
    soldMint: swapInputMintInput?.value.trim() ?? '',
    buyMint: swapOutputMintInput?.value.trim() ?? '',
    signatures,
  };
  setSwapSignTxidButtonsState('pending');

  appendSwapSignLog(
    signatures.length > 1 ? 'Confirming transactions' : 'Confirming transaction',
    'pending',
  );
  const confirmed = await pollAllTransactionConfirmations(signatures, generation, (leg, total) => {
    appendSwapSignLog(`Confirming transaction ${leg} of ${total}`, 'pending');
  });
  if (generation !== swapSignFlowGeneration) return;

  if (!confirmed.ok) {
    appendSwapSignLog(
      confirmed.err === 'Cancelled'
        ? 'Confirmation cancelled'
        : `Transaction failed: ${confirmed.err ?? 'unknown error'}`,
      'error',
    );
    if (confirmed.err !== 'Cancelled') showSwapSignRefetchRetry();
    setSwapSignDialogActions('failed');
    return;
  }

  appendSwapSignLog('Transaction confirmed', 'success');
  if (swapTxBase64El) swapTxBase64El.value = lastSig;
  syncSwapBuildResultPanel();
  if (swapQuoteWarning) {
    showInlineWarning(swapQuoteWarning, `Transaction confirmed: ${lastSig}`);
  }
  swapSignSuccessContext = {
    soldMint: swapInputMintInput?.value.trim() ?? '',
    buyMint: swapOutputMintInput?.value.trim() ?? '',
    signatures,
  };
  scheduleWalletRefreshAfterTxConfirm({
    soldMint: swapSignSuccessContext.soldMint,
    buyMint: swapSignSuccessContext.buyMint,
  });
  setSwapSignDialogActions('success');
}

function beginSwapSignBuildFlow(needsQuoteRefetch: boolean): number {
  const generation = ++swapSignFlowGeneration;
  resetSwapSignPrepTimings();
  const previewBuild = lastVybeBuild?.buildPayload
    ? projectSwapBuildForBrowser(lastVybeBuild.buildPayload as Record<string, unknown>)
    : undefined;
  openSwapSignDialog(lastSwapQuoteOk!, previewBuild);
  if (!needsQuoteRefetch) {
    appendSwapSignLog('Preparing transaction…', 'pending');
  }
  return generation;
}

function reportSwapSignPrepError(message: string, generation: number | null): void {
  if (
    generation != null &&
    generation === swapSignFlowGeneration &&
    swapSignConfirmDialogEl?.open
  ) {
    appendSwapSignLog(message, 'error');
    setSwapSignDialogActions('failed');
    return;
  }
  if (swapQuoteError) showInlineError(swapQuoteError, message);
}

async function runSwapSignDialogFlow(
  quote: Record<string, unknown>,
  buildPayload: Record<string, unknown>,
  txStrings: string[],
  options?: {
    preserveLogs?: boolean;
    skipOpen?: boolean;
    generation?: number;
  },
): Promise<void> {
  const generation = options?.generation ?? ++swapSignFlowGeneration;
  let confirmQuote = quote;
  let confirmBuild = buildPayload;
  const txSizeBytes = computeSwapTxSizesBytes(txStrings);
  let txNetworkFeeLamports = computeNetworkFeeLamportsFromSwapTxStrings(txStrings);
  try {
    const estimated = await estimateNetworkFeeLamportsForSwapTxs(
      getBrowserConnection(),
      txStrings,
    );
    if (estimated) txNetworkFeeLamports = estimated;
  } catch (err) {
    console.warn('Could not estimate swap network fee from tx:', err);
  }
  if (txNetworkFeeLamports) {
    confirmBuild = { ...buildPayload, _txNetworkFeeLamports: txNetworkFeeLamports };
    confirmQuote = {
      ...applyFeeEnrichmentToQuote(quote, null, confirmBuild),
      _txNetworkFeeLamports: txNetworkFeeLamports,
      _networkFeeLamports: txNetworkFeeLamports,
    };
  }
  if (txSizeBytes.length > 0) {
    confirmBuild = { ...confirmBuild, _txSizeBytes: txSizeBytes };
    confirmQuote = { ...confirmQuote, _txSizeBytes: txSizeBytes };
  }
  swapSignRetryContext = { quote: confirmQuote, buildPayload: confirmBuild, txStrings };
  if (options?.skipOpen) {
    setSwapSignDialogSummary(confirmQuote, confirmBuild);
    if (!options?.preserveLogs) {
      appendSwapSignLog('Transaction ready — waiting for wallet…', 'neutral');
    } else {
      appendSwapSignLog('Retrying with rebuilt transaction…', 'neutral');
    }
  } else {
    openSwapSignDialog(confirmQuote, confirmBuild, { preserveLogs: options?.preserveLogs });
    appendSwapSignLog(
      options?.preserveLogs ? 'Retrying with rebuilt transaction…' : 'Preparing transaction…',
      'neutral',
    );
  }

  try {
    await completeSwapSignFlow(generation, txStrings);
  } catch (err) {
    if (generation !== swapSignFlowGeneration) return;
    appendSwapSignLog(err instanceof Error ? err.message : String(err), 'error');
    if (isWalletSignRejection(err)) showSwapSignRefetchRetry();
    setSwapSignDialogActions('failed');
  }
}

async function handleSwapSignDialogRefetchRebuild(): Promise<void> {
  hideSwapSignRefetchRetry();
  setSignDialogRefetchButtonDisabled(true);
  resetSwapSignPrepTimings();
  try {
    let wallet = swapWalletAddressInput?.value.trim() ?? '';
    wallet = await ensureBrowserWalletConnected(wallet);
    const inputMint = swapInputMintInput?.value.trim() ?? '';
    const outputMint = swapOutputMintInput?.value.trim() ?? '';
    const amount = swapAmountInput ? parseSwapAmountInputValue(swapAmountInput.value) : NaN;
    const buildOpts = swapBuildOptsForRefetchQuote(
      mergeSelectedRoutePinIntoBuildOpts(collectSwapBuildOptions()),
    );

    await refetchSwapQuoteBeforeBuild(wallet, inputMint, outputMint, amount, buildOpts);
    if (!lastSwapQuoteOk) {
      appendSwapSignLog('Quote failed — fix inputs and try again.', 'error');
      setSwapSignDialogActions('failed');
      return;
    }
    appendSwapSignLog('Quote received — rebuilding swap…', 'neutral');
    await postBuildSwap({
      skipQuoteRefetch: true,
      preserveSignDialogLogs: true,
      enrich: isSelectedVybeMultiHopMarket(),
    });
  } catch (err) {
    appendSwapSignLog(err instanceof Error ? err.message : String(err), 'error');
    setSwapSignDialogActions('failed');
  } finally {
    setSignDialogRefetchButtonDisabled(false);
    syncSignDialogRefetchButton();
  }
}

function syncBuildButtonState(): void {
  if (!swapBuildBtn) return;
  swapBuildBtn.disabled =
    isSwapSignConfirmDialogOpen() || swapQuoteFetching || lastSwapQuoteOk == null;
  syncBuildButtonLabel();
  const refetchStripe =
    !swapBuildBtn.disabled &&
    isBuildBtnQuoteExpired() &&
    lastSwapQuoteOk != null;
  swapBuildBtn.classList.toggle('swap-action-btn--refetch-stripe', refetchStripe);
}

function syncBuildButtonLabel(): void {
  if (!swapBuildBtn) return;
  const buildLabelEl = swapBuildBtn.querySelector('.swap-action-btn__label');
  const buildHintEl = swapBuildBtn.querySelector('.swap-action-btn__hint');
  if (!buildLabelEl) return;

  const expired = isBuildBtnQuoteExpired() && lastSwapQuoteOk != null;

  buildLabelEl.textContent = expired
    ? 'Refetch quote then build & sign swap'
    : 'Build & sign swap';
  if (buildHintEl) {
    buildHintEl.textContent = expired
      ? 'Update pricing, then open wallet to sign'
      : 'Connect wallet & sign';
  }
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

function getActiveEnumeratedRoute(): EnumeratedRoutesUiState['routes'][0] | null {
  if (!enumeratedRoutesUiState?.routes.length) return null;
  return (
    enumeratedRoutesUiState.routes.find((r) => r.index === enumeratedRoutesUiState!.selectedIndex) ??
    enumeratedRoutesUiState.routes[0] ??
    null
  );
}

/** Pool/program for the route card the user selected — not a fresh discovery sweep. */
function selectedRoutePinFields(): {
  poolAddress: string;
  programAddress?: string;
  protocol?: string;
} | null {
  const candidate = getSelectedEnumeratedRouteCandidate();
  const quoteBody = activeRouteQuoteBodyForPin();

  const baseCandidate: NonNullable<EnumeratedRoutesUiState['routes'][0]['candidate']> = {
    marketAddress: candidate?.marketAddress?.trim() ?? '',
    programAddress: candidate?.programAddress?.trim() ?? '',
    protocol: candidate?.protocol?.trim(),
    programLabel: candidate?.programLabel,
    tradeCount: candidate?.tradeCount ?? 0,
    buyCount: candidate?.buyCount ?? 0,
    sellCount: candidate?.sellCount ?? 0,
    ...(candidate?.liquidity != null ? { liquidity: candidate.liquidity } : {}),
  };

  const enriched = quoteBody ? enrichTradeCandidateFromBody(baseCandidate, quoteBody) : baseCandidate;

  let poolAddress = enriched.marketAddress?.trim() ?? '';
  let programAddress = enriched.programAddress?.trim() ?? '';
  let protocol = enriched.protocol?.trim() ?? '';

  if (quoteBody) {
    if (!poolAddress) poolAddress = poolAddressFromQuoteBody(quoteBody);
    if (!programAddress) programAddress = programAddressFromQuoteBody(quoteBody);
    if (!protocol) protocol = protocolFromQuoteBody(quoteBody);
  }

  if (!poolAddress && isSwapRoutePinMode()) {
    poolAddress = swapPoolAddressInput?.value.trim() ?? '';
    if (!protocol) protocol = swapProtocolSelect?.value.trim() ?? '';
  }

  if (!poolAddress) return null;
  return completeRoutePinFields({ poolAddress, programAddress, protocol });
}

function isVybeMultiHopQuoteBody(body: Record<string, unknown>): boolean {
  const plan = body.routePlan;
  if (Array.isArray(plan) && plan.length > 1) return true;
  const hopCount = body._hopCount ?? body.hopCount;
  if (typeof hopCount === 'number' && hopCount > 1) return true;
  const build = body._build as Record<string, unknown> | undefined;
  const details = (build?.details ?? body.details) as Record<string, unknown> | undefined;
  if (details?.quoteBridge && typeof details.quoteBridge === 'object') return true;
  if (details?.preSwapNeeded === true || details?.postSwapNeeded === true) return true;
  return false;
}

function isSelectedVybeMultiHopMarket(): boolean {
  if (normalizeRouterId(getSwapRouter()) !== 'vybe') return false;
  const body =
    activeRouteQuoteBodyForPin() ??
    (lastSwapQuoteOk && typeof lastSwapQuoteOk === 'object'
      ? (lastSwapQuoteOk as Record<string, unknown>)
      : null);
  return body != null && isVybeMultiHopQuoteBody(body);
}

/** Apply selected route pins to the build request only — never mutate manual pool/protocol UI fields. */
function mergeSelectedRoutePinIntoBuildOpts(opts: Record<string, unknown>): Record<string, unknown> {
  const pin = selectedRoutePinFields();
  if (!pin) return opts;
  if (isSelectedVybeMultiHopMarket()) {
    // Atomic quote-bridge: leg-2 pool/program pins disable ix-builder enumeration.
    const {
      poolAddress: _poolAddress,
      programAddress: _programAddress,
      protocol: _protocol,
      ...rest
    } = opts;
    return {
      ...rest,
      marketFetchMode: opts.marketFetchMode ?? MARKET_FETCH_MODE,
      enumerateRoutes: true,
      enrich: true,
    };
  }
  const next: Record<string, unknown> = {
    ...opts,
    poolAddress: pin.poolAddress,
    marketFetchMode: undefined,
    enumerateRoutes: false,
  };
  if (pin.programAddress) next.programAddress = pin.programAddress;
  if (pin.protocol) next.protocol = pin.protocol;
  return next;
}

function tryCachedVybeBuildTxForSelectedRoute(
  buildOpts?: Record<string, unknown>,
): {
  tx: string;
  buildPayload: Record<string, unknown>;
} | null {
  if (buildOpts?.enrich === false) return null;
  if (!lastVybeQuoteBodyForRoutes) return null;
  const activeBody = getQuoteBodyForActiveRoute(lastVybeQuoteBodyForRoutes);
  const buildPayload = activeBody._build as Record<string, unknown> | undefined;
  const tx = extractSwapBuildTransaction(buildPayload);
  if (!tx || !buildPayload) return null;
  // Refuse cache when it is not the market card the user selected.
  const pin = selectedRoutePinFields();
  if (pin?.poolAddress) {
    const buildPool = poolAddressFromQuoteBody(activeBody);
    if (buildPool && buildPool !== pin.poolAddress) return null;
  }
  return { tx, buildPayload: projectSwapBuildForBrowser(buildPayload) };
}

async function postBuildSwap(options?: {
  skipQuoteRefetch?: boolean;
  preserveSignDialogLogs?: boolean;
  /** When false, vybe/swap build skips ix-builder enrichment (refetch-retry flows). */
  enrich?: boolean;
}): Promise<void> {
  if (!lastSwapQuoteOk) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Get a quote first.');
    return;
  }
  if (!swapBuildResultEl || !swapTxBase64El) return;

  const needsQuoteRefetch =
    !options?.skipQuoteRefetch &&
    (isBuildBtnQuoteExpired() || needsQuoteRefetchBeforeBuild());
  let signFlowGeneration: number | null = null;

  if (swapBuildBtn) swapBuildBtn.disabled = true;
  if (!options?.preserveSignDialogLogs) {
    signFlowGeneration = beginSwapSignBuildFlow(needsQuoteRefetch);
  } else {
    signFlowGeneration = swapSignFlowGeneration;
  }

  let wallet = swapWalletAddressInput?.value.trim() ?? '';
  try {
    wallet = await ensureBrowserWalletConnected(wallet);
  } catch (err) {
    reportSwapSignPrepError(err instanceof Error ? err.message : String(err), signFlowGeneration);
    syncBuildButtonState();
    return;
  }
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = swapAmountInput ? parseSwapAmountInputValue(swapAmountInput.value) : NaN;
  let buildOpts = mergeSelectedRoutePinIntoBuildOpts(collectSwapBuildOptions());
  if (options?.enrich === false) {
    buildOpts = swapBuildOptsWithoutEnrich(buildOpts);
  } else if (options?.enrich === true) {
    buildOpts = swapBuildOptsWithEnrich(buildOpts);
  } else if (needsQuoteRefetch) {
    buildOpts = swapBuildOptsForRefetchQuote(buildOpts);
  }
  const router = normalizeRouterId(buildOpts.router ?? getSwapRouter());

  if (swapQuoteError) clearInlineError(swapQuoteError);
  void refreshLowSolTradeWarning();

  if (needsQuoteRefetch) {
    await refetchSwapQuoteBeforeBuild(wallet, inputMint, outputMint, amount, buildOpts);
    if (signFlowGeneration != null && signFlowGeneration !== swapSignFlowGeneration) {
      syncBuildButtonState();
      return;
    }
  }

  pushSuppressClientPriceResolve();
  try {
    let buildTx: string;
    let buildPayload: Record<string, unknown>;
    if (router === 'vybe') {
      const cached = tryCachedVybeBuildTxForSelectedRoute(buildOpts);
      if (cached) {
        if (isSwapSignDialogActive()) {
          recordSwapSignQuoteTxCached('vybe-quote');
          appendSwapSignLog('Using cached vybe-quote tx', 'neutral');
        }
        buildTx = cached.tx;
        buildPayload = projectSwapBuildForBrowser(cached.buildPayload);
        lastRawSwapResponse = buildPayload;
        lastVybeBuild = {
          tx: buildTx,
          builtAt: Date.now(),
          paramsKey: vybeBuildParamsKey(wallet, inputMint, outputMint, amount, vybeCacheBuildOpts(buildOpts)),
          buildPayload,
        };
        renderRawResponsePanels();
      } else {
        const resolved = await resolveVybeBuildTx(wallet, inputMint, outputMint, amount, buildOpts);
        buildTx = resolved.tx;
        buildPayload = projectSwapBuildForBrowser(resolved.buildPayload);
      }
    } else {
      const cached = tryReuseCachedBuildTx(wallet, inputMint, outputMint, amount, buildOpts);
      if (cached) {
        buildTx = cached.tx;
        buildPayload = cached.buildPayload;
        lastRawSwapResponse = buildPayload;
        renderRawResponsePanels();
      } else {
        const resolved = await resolveAggregatorBuildTx(wallet, inputMint, outputMint, amount, buildOpts);
        buildTx = resolved.tx;
        buildPayload = projectSwapBuildForBrowser(resolved.buildPayload);
      }
    }
    if (signFlowGeneration != null && signFlowGeneration !== swapSignFlowGeneration) return;

    const legTxs = extractSwapBuildTransactions(buildPayload);
    const toSign = legTxs.length > 0 ? legTxs : [buildTx];
    const confirmQuoteBase = lastSwapQuoteOk
      ? applyFeeEnrichmentToQuote(lastSwapQuoteOk, null, buildPayload)
      : {};
    const confirmQuote =
      buildOpts.enrich === false && lastSwapQuoteOk
        ? preserveQuoteEnrichmentDisplay(lastSwapQuoteOk, confirmQuoteBase)
        : confirmQuoteBase;
    lastSwapQuoteOk = confirmQuote;
    renderSwapQuoteUI(confirmQuote);
    await runSwapSignDialogFlow(confirmQuote, buildPayload, toSign, {
      preserveLogs: options?.preserveSignDialogLogs,
      skipOpen: signFlowGeneration != null,
      generation: signFlowGeneration ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      signFlowGeneration != null &&
      signFlowGeneration === swapSignFlowGeneration &&
      swapSignConfirmDialogEl?.open
    ) {
      appendSwapSignLog(msg, 'error');
      setSwapSignDialogActions('failed');
    } else if (swapQuoteError) {
      showInlineError(swapQuoteError, msg);
    }
  } finally {
    popSuppressClientPriceResolve();
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
  const prevFieldWallet = existingWallet.trim();
  const needsBalanceRefresh =
    connected !== prevFieldWallet ||
    walletBalancesReadyFor !== connected ||
    !isWalletBalanceCacheReady(connected);
  if (needsBalanceRefresh) {
    onWalletAddressReady(true);
  }
  return connected;
}

function getBrowserConnection(): Connection {
  const w = getSolanaWindow();
  if (!w.__swapBrowserConnection) {
    w.__swapBrowserConnection = new Connection(`${window.location.origin}/api/solana/rpc`, 'processed');
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
      cache: 'no-store',
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
  const { blockhash } = await connection.getLatestBlockhash('processed');
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
  } else if (hasWallet) {
    btn.disabled = true;
    btn.classList.add('swap-wallet-field-connect--connected', 'swap-btn-3d--static');
    if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--wallet';
    textEl.textContent = truncate(address, 4, 4);
    updateWalletTotalUsdUi();
  } else {
    btn.disabled = false;
    if (iconEl) iconEl.className = 'swap-wallet-field-connect__icon swap-wallet-field-connect__icon--wallet';
    textEl.textContent = 'Connect wallet';
    updateWalletTotalUsdUi();
  }
  syncSwapWalletTrayLockState();
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
  swapBuildResultEl.hidden = false;

  if (swapCopyTxBtn) swapCopyTxBtn.disabled = !hasTx;
}

function syncSwapBuildResultFromQuote(): void {
  const buildTx = lastVybeBuild?.tx?.trim() ?? '';
  if (swapTxBase64El) swapTxBase64El.value = buildTx;
  syncSwapBuildResultPanel();
}

function syncWalletFieldForMode(): void {
  const address = swapWalletAddressInput?.value.trim() ?? '';
  const hasWallet = Boolean(address);

  if (swapWalletSignRowEl) swapWalletSignRowEl.hidden = false;

  if (swapWalletAddressInput) {
    swapWalletAddressInput.hidden = true;
    swapWalletAddressInput.readOnly = false;
  }

  updateConnectWalletButtonUi(address, hasWallet);
}

function syncBuildSignUi(): void {
  syncWalletFieldForMode();
  syncBuildButtonState();
  syncSwapQuoteButtonState();
  syncBuildButtonLabel();
  if (swapAdvancedBuildHintEl) {
    swapAdvancedBuildHintEl.innerHTML =
      'Applied when you click <strong>Get quote</strong> or <strong>Build &amp; sign swap</strong>.';
  }
  syncSwapBuildResultPanel();
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
  const cur = parseSwapAmountInputValue(swapAmountInput.value);
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
    onSwapBuildOptionChanged();
  };
  enableEl.addEventListener('change', sync);
  valueEl?.addEventListener('input', onSwapBuildOptionChanged);
  valueEl?.addEventListener('change', onSwapBuildOptionChanged);
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
  getQuotePayUsdEstimateLabel: () => {
    const payUsd = estimateSwapPayUsdFromInput();
    return payUsd != null ? formatSwapPayUsdLabel(payUsd) : null;
  },
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
  vybeMarketDiscoveryActive,
  swapRouteOptionsPanelActive,
  isSwapQuoteFetching: () => swapQuoteFetching,
  dom: {
    swapRouteOptionsEl,
    swapQuoteDetailsRoutingEl,
    swapQuoteDetailsRouteStepsEl,
    routingDialogBodyEl,
    routingDialogTitleEl,
    swapQuoteRouteSubtitleEl,
    swapSignConfirmRoutingEl,
  },
});

wireBuildOptionToggle(swapEnablePartnerCheckbox, swapPartnerFieldEl, swapPartnerInput);
swapEnablePartnerCheckbox?.addEventListener('change', () => {
  syncServiceFeePartnerGate(hasValidSwapWallet());
  onSwapBuildOptionChanged();
});
swapPartnerInput?.addEventListener('input', () => {
  onSwapBuildOptionChanged();
  syncSwapQuoteButtonState();
});
swapPartnerInput?.addEventListener('change', () => {
  onSwapBuildOptionChanged();
  syncSwapQuoteButtonState();
});
swapPinRouteCheckbox?.addEventListener('change', () => {
  const hadQuote = lastSwapQuoteOk != null;
  const savedRoutes = enumeratedRoutesUiState;
  const savedBody = lastVybeQuoteBodyForRoutes;
  const savedQuote = lastSwapQuoteOk;
  const savedRawQuote = lastRawQuoteResponse;
  const savedVybeBuild = lastVybeBuild;

  syncSwapRoutePinMode();

  if (hadQuote && savedQuote) {
    enumeratedRoutesUiState = savedRoutes;
    lastVybeQuoteBodyForRoutes = savedBody;
    lastSwapQuoteOk = savedQuote;
    lastRawQuoteResponse = savedRawQuote;
    lastVybeBuild = savedVybeBuild;
    if ((!enumeratedRoutesUiState || !enumeratedRoutesUiState.routes.length) && savedBody) {
      syncEnumeratedRoutesFromBody(savedBody);
    }
    if (isSwapRoutePinMode()) {
      applyEnumeratedRouteCandidateToPinFields(getSelectedEnumeratedRouteCandidate());
    }
    renderSwapQuoteUI(savedQuote);
    renderRouteOptionsPanel();
    markSwapQuoteBuildOptsStale();
  } else {
    invalidateSwapQuoteAfterInputChange();
  }
  syncSwapQuoteButtonState();
});
swapPoolAddressInput?.addEventListener('input', () => {
  invalidateSwapQuoteAfterInputChange();
  syncSwapQuoteButtonState();
});
swapPoolAddressInput?.addEventListener('change', () => {
  invalidateSwapQuoteAfterInputChange();
  syncSwapQuoteButtonState();
});
swapProtocolSelect?.addEventListener('change', () => {
  invalidateSwapQuoteAfterInputChange();
  syncSwapQuoteButtonState();
});
swapEnumerateRoutesCheckbox?.addEventListener('change', onEnumerateRoutesChanged);
syncMarketFetchModeSelectLocked();
syncSwapRoutePinMode();

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
    onSwapBuildOptionChanged();
  };
  swapEnableServiceFeeCheckbox.addEventListener('change', () => {
    sync();
    syncSwapQuoteButtonState();
  });
  swapServiceFeeInput?.addEventListener('input', () => {
    onSwapBuildOptionChanged();
    syncSwapQuoteButtonState();
  });
  swapServiceFeeInput?.addEventListener('change', () => {
    onSwapBuildOptionChanged();
    syncSwapQuoteButtonState();
  });
  sync();
}

wireServiceFeeToggle();
syncServiceFeePartnerGate(hasValidSwapWallet());

swapRouterSwitchEl?.addEventListener('click', (e) => {
  if (swapQuoteFetching) return;
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-router]');
  if (!btn?.dataset.router) return;
  setSwapRouter(btn.dataset.router);
});
swapVybeFallbackCheckbox?.addEventListener('change', () => {
  syncSwapQuoteButtonState();
});
syncRouterFallbackToggleUi();
syncSwapRouterSwitchState();
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
  if (swapQuoteFetching) return;
  void disconnectBrowserWallet();
});
swapWalletTotalUsdEl?.addEventListener('click', () => {
  if (swapQuoteFetching) return;
  tryOpenSellTokenPicker();
});
swapWalletAddressInput?.addEventListener('input', () => onWalletAddressReady(false));
swapWalletAddressInput?.addEventListener('change', () => onWalletAddressReady(true));
syncBuildSignUi();
syncSellTokenPickerState();

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
  getSwapInputMint: () => swapInputMintInput?.value.trim() ?? '',
  getSwapInputSymbol: () => swapInputSymbolEl?.textContent?.trim() ?? '',
  canOpenSellPicker: () => hasValidSwapWallet() && !swapQuoteFetching,
  canOpenBuyPicker: () => hasValidSwapWallet() && !swapQuoteFetching,
  onRefetchHoldings: async () => {
    const wallet = swapWalletAddressInput?.value.trim() ?? '';
    if (!isValidSolanaWalletAddress(wallet)) return;
    updateSwapPairCards(undefined, true);
    try {
      await refreshWalletHoldingsFull(wallet);
    } catch {
      updateSwapPairCards();
    }
  },
  isWalletHoldingsFetching: () => walletBalancesFetching,
});
setWalletBalanceStreamListener(() => {
  refreshWalletBalancesPanel();
  updateWalletTotalUsdUi();
});
wireTokenPickerOpen(swapInputTokenBtn, swapInputMintInput, 'input');
wireTokenPickerOpen(swapOutputTokenBtn, swapOutputMintInput, 'output');

if (swapFlipBtnEl && swapInputMintInput && swapOutputMintInput) {
  swapFlipBtnEl.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (swapQuoteFetching) return;
    const blockedReason = getFlipBlockedReason();
    if (blockedReason) {
      if (swapQuoteError) showInlineError(swapQuoteError, blockedReason);
      return;
    }
    if (swapQuoteError) clearInlineError(swapQuoteError);
    const flippedOutputAmountUi = parseFlipOutputAmountUi();
    flipSellBuyTokens();
    afterSellBuyTokensFlipped(flippedOutputAmountUi);
  });
}

if (swapPasteOutputBtnEl && swapOutputMintInput) {
  swapPasteOutputBtnEl.addEventListener('click', async () => {
    if (swapQuoteFetching || !hasValidSwapWallet()) return;
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

function handleSwapSignDialogDismiss(): void {
  if (swapSignDialogSuccess) {
    void closeSwapSignDialogAfterSuccess();
    return;
  }
  closeSwapSignDialog();
}

routeWarningConfirmCancelEl?.addEventListener('click', () => settleRouteWarningConfirm(false));
routeWarningConfirmDismissEl?.addEventListener('click', () => settleRouteWarningConfirm(false));
routeWarningConfirmOkEl?.addEventListener('click', () => settleRouteWarningConfirm(true));
routeWarningConfirmDialogEl?.addEventListener('cancel', (event) => {
  event.preventDefault();
  settleRouteWarningConfirm(false);
});
routeWarningConfirmDialogEl?.addEventListener('click', (event) => {
  if (event.target === routeWarningConfirmDialogEl) settleRouteWarningConfirm(false);
});

swapSignConfirmCancelEl?.addEventListener('click', () => handleSwapSignDialogDismiss());
swapSignConfirmDismissEl?.addEventListener('click', () => handleSwapSignDialogDismiss());
swapSignConfirmTxidsEl?.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest('button[data-signature]') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  const sig = btn.dataset.signature?.trim();
  if (sig) openSignatureOnSolscan(sig);
});
swapSignConfirmRefetchRetryEl?.addEventListener('click', () => void handleSwapSignDialogRefetchRebuild());
swapSignConfirmDialogEl?.addEventListener('cancel', (event) => {
  event.preventDefault();
  handleSwapSignDialogDismiss();
});
swapSignConfirmDialogEl?.addEventListener(
  'wheel',
  (event) => {
    if (!swapSignConfirmDialogEl?.open) return;
    const shell = swapSignConfirmDialogEl.querySelector('.swap-sign-dialog__shell');
    if (shell && event.target instanceof Node && shell.contains(event.target)) return;
    event.preventDefault();
  },
  { passive: false },
);
swapSignConfirmDialogEl?.addEventListener(
  'touchmove',
  (event) => {
    if (!swapSignConfirmDialogEl?.open) return;
    const shell = swapSignConfirmDialogEl.querySelector('.swap-sign-dialog__shell');
    if (shell && event.target instanceof Node && shell.contains(event.target)) return;
    event.preventDefault();
  },
  { passive: false },
);

swapGaslessCheckbox?.addEventListener('change', () => {
  onSwapBuildOptionChanged();
  void refreshLowSolTradeWarning();
});
swapAutoSlippageCheckbox?.addEventListener('change', () => {
  syncSlippageInputForAutoSlippage();
  onSwapBuildOptionChanged();
});
swapSlippageInput?.addEventListener('input', onSwapBuildOptionChanged);
swapSlippageInput?.addEventListener('change', onSwapBuildOptionChanged);
syncSlippageInputForAutoSlippage();

if (swapInputMintInput) {
  swapInputMintInput.addEventListener('input', () => {
    clearSwapNoLiquidityStickyOnMintChange();
    invalidateSwapQuoteAfterInputChange();
    applyOutputMintConstraintForInput();
    updateSwapPairCards();
    syncSwapSellAmountUi();
    void refreshSwapSymbols();
    void refreshLowSolTradeWarning();
    syncSwapAmountMaxFromBalance();
  });
}
if (swapOutputMintInput) {
  swapOutputMintInput.addEventListener('input', () => {
    clearSwapNoLiquidityStickyOnMintChange();
    invalidateSwapQuoteAfterInputChange();
    updateSwapPairCards();
    syncSwapSellAmountUi();
    void refreshSwapSymbols();
    void refreshLowSolTradeWarning();
    syncFlipButtonState();
  });
}

swapAmountInput?.addEventListener('focus', () => {
  syncSwapAmountDisplayOverlay();
});
swapAmountInput?.addEventListener('blur', () => {
  const clamped = clampSwapAmountInputToMax();
  syncSwapAmountDisplayOverlay();
  if (clamped) {
    invalidateSwapQuoteAfterInputChange();
    syncSwapSellAmountUi();
    syncSellPctButtonsState();
  }
});
swapAmountInput?.addEventListener('input', () => {
  invalidateSwapQuoteAfterInputChange();
  syncSwapSellAmountUi();
  syncSellPctButtonsState();
});
swapAmountInput?.addEventListener('change', () => {
  invalidateSwapQuoteAfterInputChange();
  syncSwapSellAmountUi();
  syncSellPctButtonsState();
});

void ensureTokenCatalogLoaded().then(async () => {
  updateSwapTokenIcons();
  applyOutputMintConstraintForInput();
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const pairMints = [...new Set([inputMint, outputMint].filter(Boolean))];
  if (pairMints.length === 0) return;
  await Promise.all(pairMints.map((m) => ensureTokenMetaForMint(m)));
  updateSwapPairCards();
  syncSwapSellAmountUi();
});
void refreshSwapSymbols();
updateSwapPairCards();
syncSwapAmountDisplayOverlay();
syncSellPctButtonsState();
bindRoutingDiagramZoomListeners();
scheduleRoutingDiagramZoom();
resetSwapQuoteDetailsPanel();

/** Page load: live Vybe+RPC wallet balances (same policy as resolve-prices — always network). */
onWalletAddressReady(true);

syncSwapQuoteButtonState();
void fetch('/api/ui-config')
  .then((res) => (res.ok ? res.json() : null))
  .then((cfg: { enableSwapQuoteBtnDebug?: boolean } | null) => {
    swapQuoteBtnDebugEnabled = cfg?.enableSwapQuoteBtnDebug === true;
    syncSwapQuoteButtonState();
  })
  .catch(() => {});
