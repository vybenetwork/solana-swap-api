/**
 * Route diagram, route plan steps, hop % badges, and fee/rent accounting.
 *
 * ## Hop outgoing % (badge on each hop)
 * 1. Start with swapUsd / payUsd (wallet pay includes input-side fees/rent).
 * 2. For each hop through index i, multiply by hopLocalOutRetentionFactor:
 *    - Prefer netRaw / grossRaw from resolveHopOutAmounts.
 *    - Else netUi / (netUi + outputSideFeesUi) when pool/protocol fees sit on output mint.
 * 3. Last hop may scale quoted raw by wallet pay vs swap leg (scaleQuotedRawToWalletPay).
 * 4. Fallback: hopOutUsd / cumulativePayUsd when USD prices exist.
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
  dom: {
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
  destinationAddress?: string;
  destinationKind?: 'lp_pool' | 'new_token_account' | 'fee_recipient' | 'output_deduction' | 'input_wallet' | 'network_priority';
  destinationNote?: string;
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
}
export const ACC_RENT_FEE_LABEL = 'Acc Rent Fee';
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
  if (label === 'protocol fee' || label === 'route fee' || label === 'priority fee') {
    if (isSolMint(inputMint)) return isSolMint(item.mint);
    return item.mint === inputMint;
  }
  return false;
}

function isWalletDebitedFeeItem(item: HopFeeItemLite, inputMint: string): boolean {
  return isWalletCostFeeItem(item, { inputMintAddress: inputMint } as Record<string, unknown>);
}

/** Hop fees actually debited from the wallet (matches Phantom), not output-side pool/route cuts. */
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
      const feeUi = feeAmountToUi(item.amountRaw, item.mint);
      if (feeUi == null || feeUi <= 0) continue;
      let sellUi: number | null = null;
      if (routeLegMintMatches(item.mint, sellMint)) {
        sellUi = feeUi;
      } else if (isForeignFeeMint(item.mint, quote)) {
        const usd = computeFeeUsdNumeric(item, quote);
        const sellPrice = lookupMintPriceUsd(sellMint, quote);
        if (usd != null && Number.isFinite(sellPrice) && sellPrice > 0) {
          sellUi = usd / sellPrice;
        }
      } else {
        sellUi = convertFeeUiToSellLeg(feeUi, item.mint, quote);
      }
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

function hopPercentLabel(step: VybeRoutePlanStepLite): string {
  if (step.percent == null || !Number.isFinite(step.percent)) return '—';
  const rounded = Math.round(step.percent * 100) / 100;
  return `${rounded}%`;
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

/** Sum hop fees (output-mint + PDA rent) expressed in output-token raw units. */
function sumHopFeeDeductionInOutputRaw(
  hopFees: HopFeeBreakdownLite,
  outMint: string,
  inRaw: bigint | null,
  quotedOutRaw: bigint,
  inputMint: string,
  quote: Record<string, unknown>,
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
      if (routeLegMintMatches(rentMint, inputMint)) {
        /* Rent raw shares the hop input mint's units — the hop rate ratio is valid. */
        total += (rent * quotedOutRaw) / inRaw;
      } else {
        /* Cross-mint rent (e.g. SOL rent on a BONK-input hop): convert via USD prices. */
        const rentUi = feeAmountToUi(rent.toString(), rentMint);
        const rentPrice = lookupMintPriceUsd(rentMint, quote);
        const outPrice = lookupMintPriceUsd(outMint, quote);
        if (
          rentUi != null &&
          Number.isFinite(rentPrice) &&
          rentPrice > 0 &&
          Number.isFinite(outPrice) &&
          outPrice > 0
        ) {
          const outUi = (rentUi * rentPrice) / outPrice;
          const outRawNum = Math.round(outUi * 10 ** deps.getMintDecimals(outMint));
          if (Number.isFinite(outRawNum) && outRawNum > 0) {
            try {
              total += BigInt(outRawNum);
            } catch {
              /* skip overflow */
            }
          }
        }
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
  const swapUsd = deps.getQuoteSwapUsdValue(quote);
  if (swapUsd == null || swapUsd <= 0) return null;

  const buckets = getQuoteWalletCostBucketsUsd(quote);
  const feeUsd = resolveQuoteYouPayFeeUsd(quote, buckets);
  const rentUsd = buckets.rentUsd ?? null;
  const totalUsd = swapUsd + (feeUsd ?? 0) + (rentUsd ?? 0);
  return { swapUsd, feeUsd, rentUsd, totalUsd };
}

/** Same string as the You pay hero sub-label, e.g. `≈ $1.24 + $0.01 (fee) + $0.13 (rent)`. */
export function getQuoteYouPaySubLabel(quote: Record<string, unknown>): string | null {
  const breakdown = resolveQuoteYouPayUsd(quote);
  if (!breakdown) return null;

  const feeCount = getQuotePayHeroCostStack(quote, deps.getSwapInSym())
    .filter((row) => row.kind === 'fee')
    .reduce((total, row) => total + (row.count ?? 1), 0);

  const parts: string[] = [`≈ $${deps.formatSwapPayUsdAmount(breakdown.swapUsd)}`];
  if (breakdown.feeUsd != null && breakdown.feeUsd > 0) {
    parts.push(`+ $${deps.formatSwapPayUsdAmount(breakdown.feeUsd)} (${feeCount > 1 ? 'fees' : 'fee'})`);
  }
  if (breakdown.rentUsd != null && breakdown.rentUsd > 0) {
    parts.push(`+ $${deps.formatSwapPayUsdAmount(breakdown.rentUsd)} (rent)`);
  }
  return parts.join(' ');
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
  const outUsd = deps.getQuoteReceiveUsd(quote);
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

  const pctLabel = `${Math.round(pct * 100) / 100}%`;
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

  const pctLabel = `${Math.round(pct * 100) / 100}%`;
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
  }
  if (!netRaw) return null;

  let grossRaw = quotedRaw;
  if (feeDeductionOut > 0n) {
    const impliedGross = netRaw + feeDeductionOut;
    if (impliedGross > grossRaw) grossRaw = impliedGross;
  }

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
      pctLabel: `${Math.round(pct * 100) / 100}%`,
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
}

export function getQuotePayHeroCostStack(
  quote: Record<string, unknown>,
  sellSym: string,
): QuotePayHeroCostStackItem[] {
  const mint = quoteInputMint(quote);
  if (!mint) return [];

  let feeUi = 0;
  let feeItemCount = 0;
  let sameMintRentUi = 0;
  let foreignRentUi = 0;
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
        if (sameMint) {
          sameMintRentUi += ui;
          foundSameMintRent = true;
        } else if (isSolMint(item.mint)) {
          foreignRentUi += ui;
          foundForeignRent = true;
        }
        continue;
      }

      if (sameMint) {
        feeUi += ui;
        feeItemCount += 1;
        foundFee = true;
      }
    }
  }

  if (!foundFee) {
    const payRaw = quoteWalletPayRaw(quote);
    const swapRaw = quoteInAmountRaw(quote);
    if (payRaw && swapRaw) {
      try {
        const pay = BigInt(String(payRaw).replace(/,/g, ''));
        const swap = BigInt(String(swapRaw).replace(/,/g, ''));
        if (pay > swap) {
          const deltaUi = deps.rawAmountToUiNumber(
            (pay - swap).toString(),
            deps.getMintDecimals(mint),
          );
          if (Number.isFinite(deltaUi) && deltaUi > 0) {
            const rentTotal = (foundSameMintRent ? sameMintRentUi : 0) + (foundForeignRent ? foreignRentUi : 0);
            const impliedFee = deltaUi - rentTotal;
            if (impliedFee > 0) {
              feeUi = impliedFee;
              foundFee = true;
              if (feeItemCount === 0) feeItemCount = 1;
            } else if (!foundSameMintRent && !foundForeignRent) {
              feeUi = deltaUi;
              foundFee = true;
              if (feeItemCount === 0) feeItemCount = 1;
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
      if (feeItemCount === 0) feeItemCount = 1;
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
    });
  }
  if (foundSameMintRent && sameMintRentUi > 0) {
    stack.push({ ui: sameMintRentUi, sym: sellSym, mint, kind: 'rent' });
  }
  if (foundForeignRent && foreignRentUi > 0) {
    stack.push({
      ui: foreignRentUi,
      sym: mintSymbolSync(NATIVE_SOL_MINT),
      mint: NATIVE_SOL_MINT,
      kind: 'rent',
    });
  }
  return stack;
}

function payHeroCostKindLabel(
  kind: QuotePayHeroCostStackItem['kind'],
  count = 1,
): string {
  if (kind === 'rent') return ' (rent)';
  return count > 1 ? ' (fees)' : ' (fee)';
}

function formatPayHeroCostDisplay(ui: number): string {
  return deps.formatFeeStackAmount(ui);
}

function renderPayHeroCostRow(
  sym: string,
  ui: number,
  amtCls: string,
  mint: string,
  kind: QuotePayHeroCostStackItem['kind'],
  feeCount = 1,
): string {
  const symCls = tokenSymColorClass(mint, sym);
  return `<span class="swap-quote-summary-fee-part">
        <span class="swap-quote-summary-amt swap-quote-summary-amt--fee${amtCls}">${deps.escapeHtml(formatPayHeroCostDisplay(ui))}</span>
        <span class="swap-quote-summary-sym ${symCls}">${deps.escapeHtml(sym)}</span><span class="swap-quote-summary-fee-kind">${payHeroCostKindLabel(kind, feeCount)}</span>
      </span>`;
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
    return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(swapAmt)}</span>
        <span class="swap-quote-summary-sym ${inputSymCls}">${deps.escapeHtml(inSym)}</span>`;
  }

  const stackRows = stack.map((row) =>
    renderPayHeroCostRow(row.sym, row.ui, amtCls, row.mint, row.kind, row.count ?? 1),
  );

  return `<span class="swap-quote-summary-amt${amtCls}">${deps.escapeHtml(swapAmt)}</span>
      <span class="swap-quote-summary-sym ${inputSymCls}">${deps.escapeHtml(inSym)}</span>
      <span class="swap-quote-summary-plus">+</span>
      <span class="swap-quote-summary-fee-stack">${stackRows.join('')}</span>`;
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

function countDiagramInputFeeLines(
  feeRows: QuotePayHeroCostStackItem[],
  showAllEndpointLabels: boolean,
): number {
  if (feeRows.length > 0) return feeRows.length;
  if (showAllEndpointLabels) return 1;
  return 0;
}

function renderDiagramOutputFeeAlignSpacers(spacerCount: number, matchInputFeeStack: boolean): string {
  if (spacerCount <= 0) return '';
  const spacers = Array.from(
    { length: spacerCount },
    () => '<span class="routing-output-fees-spacer" aria-hidden="true">&nbsp;</span>',
  );
  if (matchInputFeeStack && spacerCount > 0) {
    return `<div class="routing-input-addon-stack routing-output-fees-spacer-stack">${spacers.join('')}</div>`;
  }
  return spacers.join('');
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
  const breakdown = resolveQuoteYouPayUsd(quote);
  if (!breakdown) return null;

  const stack = getQuotePayHeroCostStack(quote, deps.getSwapInSym());
  const feeCount = stack
    .filter((row) => row.kind === 'fee')
    .reduce((total, row) => total + (row.count ?? 1), 0);
  const hasFee = breakdown.feeUsd != null && breakdown.feeUsd > 0;
  const hasRent = breakdown.rentUsd != null && breakdown.rentUsd > 0;

  let suffix = '';
  if (hasFee && hasRent) suffix = feeCount > 1 ? ' (fees + rent)' : ' (fee + rent)';
  else if (hasFee) suffix = feeCount > 1 ? ' (fees)' : ' (fee)';
  else if (hasRent) suffix = ' (rent)';

  return `≈ $${deps.formatSwapPayUsdAmount(breakdown.totalUsd)}${suffix}`;
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
function renderRoutingTokenIcon(mint: string, _sym: string): string {
  const meta = getCachedTokenMeta(mint);
  return renderTokenIconImgHtml(effectiveTokenIconSrc(meta?.logoUrl), 'routing-token-img');
}

function renderRouteEndpointPill(
  amt: string,
  sym: string,
  title?: string,
  amtLoading = false,
): string {
  const mint =
    sym === deps.getSwapInSym()
      ? (deps.getFormInputMint())
      : sym === deps.getSwapOutSym()
        ? (deps.getFormOutputMint())
        : '';
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
  const titleAttr = title ? ` title="${deps.escapeHtml(title)}"` : '';
  const ariaHidden = title ? '' : ' aria-hidden="true"';
  return `<div class="routing-hop-link routing-hop-link--${direction}"${ariaHidden}>
    <span class="routing-pct-badge${outClass}"${titleAttr}>${deps.escapeHtml(pct)}</span>
  </div>`;
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

/** SOL/token-account rent — always debited from the wallet, even when selling a non-SOL token. */
function isAccRentWalletFeeItem(item: HopFeeItemLite): boolean {
  if (isAccRentFeeLabel(item.label)) return true;
  return item.destinationKind === 'new_token_account';
}

function isOutputSideFeeDisplayItem(item: HopFeeItemLite): boolean {
  const kind = item.destinationKind;
  if (kind === 'lp_pool' || kind === 'output_deduction') return true;
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  return label === 'pool fee' || label === 'slippage/spread';
}

/** Wallet-debited protocol/route on the sell mint (even if destination enrichment tagged lp_pool). */
function isInputSideWalletFeeItem(item: HopFeeItemLite, inputMint: string): boolean {
  const label = normalizeFeeItemLabel(item.label).toLowerCase();
  if (label !== 'protocol fee' && label !== 'route fee') return false;
  if (isSolMint(inputMint)) return isSolMint(item.mint);
  return item.mint === inputMint;
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
  if (label === 'protocol fee' || label === 'route fee' || label === 'priority fee') {
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

function getQuoteDiagramWalletFeesUsdLabel(quote: Record<string, unknown>): string | null {
  const buckets = getQuoteWalletCostBucketsUsd(quote);
  const total = (buckets.feeUsd ?? 0) + (buckets.rentUsd ?? 0);
  if (!(total > 0)) return null;
  return `-$${deps.formatSwapPayUsdAmount(total)}`;
}

function getQuoteDiagramOutputUsdSubline(quote: Record<string, unknown>): string | null {
  const usd = deps.getQuoteReceiveUsd(quote);
  if (usd == null) return null;
  const label = deps.formatSwapReceiveUsdLabel(usd);
  return label ? `≈ ${label}` : null;
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
  return `<div class="routing-chip-stack routing-chip-stack--${variant}" title="${deps.escapeHtml(title)}">
    <span class="routing-chip-top routing-chip-top--fee-label">${deps.escapeHtml(label)}</span>
    <div class="routing-pill routing-pill--chip routing-pill--chip-fee">
      <span class="routing-chip-amt routing-chip-amt--usd">${deps.escapeHtml(usdInChip)}</span>
    </div>
    ${
      baseBelow
        ? `<span class="routing-chip-bottom routing-chip-bottom--base">${deps.escapeHtml(baseBelow)}</span>`
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
  const chip = renderRoutingFeeChip(
    ACC_RENT_FEE_LABEL,
    placeholderRoutingFeeEquiv(),
    feeChipVariant(ACC_RENT_FEE_LABEL),
    ACC_RENT_FEE_LABEL,
  );
  return `<div class="routing-acc-rent-above" aria-label="Account rent fee at this hop">
    <div class="routing-acc-rent-cards"><div class="routing-fee-slot routing-fee-slot--acc-rent">${chip}</div></div>
    <div class="routing-acc-rent-connector" aria-hidden="true">${renderRoutingAccRentConnectorDown()}</div>
  </div>`;
}

function renderMockRoutingFeeBranch(): string {
  const labels = [PRIORITY_FEE_LABEL, 'Protocol fee'];
  const feeCount = labels.length;
  const slots = labels
    .map((label) => {
      const chip = renderRoutingFeeChip(
        label,
        placeholderRoutingFeeEquiv(),
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
): string {
  const symCls = tokenSymColorClass(mint, sym);
  const safeSym = deps.escapeHtml(sym);
  const display = placeholder
    ? ROUTING_PLACEHOLDER_DASH
    : deps.escapeHtml(formatHopFeeTableAmount(amountRaw, mint));
  return `<span class="hop-fee-row__amt-val ${symCls}">−${display} ${safeSym}</span>`;
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
      ACC_RENT_FEE_LABEL,
      renderMockFeeDestBracketOnly('ata', 'Token Account'),
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
    `<div class="hop-fee-group"><div class="hop-fee-group__title">Deducted from output</div>${outputRows}</div>`;
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
  const feeBranchBelow = renderMockRoutingFeeBranch();
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

function renderHopFeeChip(item: HopFeeItemLite, quote: Record<string, unknown>): string {
  const label = displayFeeItemLabel(item);
  const equiv = computeFeeEquivalents(item.amountRaw, item.mint, quote);
  const title = formatFeeEquivDetailText(equiv);
  return renderRoutingFeeChip(label, equiv, feeChipVariant(label), title);
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

function renderFeeDestinationAddrLine(addr: string): string {
  const trimmed = addr.trim();
  if (!isLikelySolanaPubkey(trimmed)) return '';
  const display = deps.escapeHtml(deps.truncate(trimmed, 8, 8));
  const url = deps.escapeHtml(solscanAccountUrl(trimmed));
  return `<a class="swap-hop-fee-dest__addr swap-hop-fee-dest__addr-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${deps.escapeHtml(trimmed)}">${display}</a>`;
}

function formatMintDetailValue(mint: string, sym?: string): string {
  const symVal = sym?.trim();
  const addrHtml = deps.escapeHtml(mint);
  const symCls = tokenSymColorClass(mint, symVal || undefined);
  const symPart =
    symVal && symVal !== '—'
      ? `<span class="swap-hop-detail-row__mint-sym ${symCls}"> (${deps.escapeHtml(symVal)})</span>`
      : '';
  return `<span class="swap-hop-detail-row__mint-val"><span class="swap-hop-detail-row__mint-addr">${addrHtml}</span>${symPart}</span>`;
}

function hopFlowPartClass(mint: string, sym?: string): string {
  return `swap-hop-detail-row__flow-part ${tokenSymColorClass(mint, sym?.trim() || undefined)}`;
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
  /* network_priority goes to validators — never show the user's wallet as its destination. */
  if (item.destinationKind === 'input_wallet' && isLikelySolanaPubkey(wallet)) {
    return wallet;
  }
  return '';
}

const FEE_DEST_KIND_META: Record<string, { label: string; mod: string }> = {
  lp_pool: { label: 'Pool Vault', mod: 'pool' },
  new_token_account: { label: 'Token Account', mod: 'ata' },
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
    item.destinationKind === 'network_priority' || item.destinationKind === 'new_token_account'
      ? ''
      : item.destinationNote?.trim();

  if (!meta && !addrHtml) {
    if (!note) return '';
    return `<span class="hop-fee-dest"><span class="hop-fee-dest__note">${deps.escapeHtml(note)}</span></span>`;
  }

  const mod = meta?.mod ?? 'generic';
  if (addrHtml && meta) {
    return `<span class="hop-fee-dest hop-fee-dest--${mod}">${addrHtml} ${renderFeeDestBracketTag(meta.label)}</span>`;
  }

  if (addrHtml) {
    return `<span class="hop-fee-dest">${addrHtml}</span>`;
  }

  if (meta && !note) {
    return `<span class="hop-fee-dest hop-fee-dest--${mod}">${renderFeeDestBracketTag(meta.label)}</span>`;
  }

  const kindHtml = meta
    ? `<span class="hop-fee-dest__kind">${deps.escapeHtml(meta.label)}</span>`
    : '';
  const tail = note ? `<span class="hop-fee-dest__note">${deps.escapeHtml(note)}</span>` : '';
  const sep = kindHtml && tail ? '<span class="hop-fee-dest__sep" aria-hidden="true">·</span>' : '';
  return `<span class="hop-fee-dest hop-fee-dest--${mod}">${kindHtml}${sep}${tail}</span>`;
}

/** Compact fee row: label · destination · token amount · USD. */
function renderHopFeeRow(
  item: HopFeeItemLite,
  equiv: FeeAmountEquiv,
  destCtx?: FeeDestinationRenderCtx,
): string {
  const label = displayFeeItemLabel(item);
  const variant = feeChipVariant(label);
  const titleParts = [formatFeeEquivDetailText(equiv)];
  const note = item.destinationNote?.trim();
  if (note) titleParts.push(note);
  const amtHtml = renderHopFeeAmountHtml(item.mint, item.amountRaw, equiv.feeSym);
  const usd = equiv.usd ? `$${stripFiatPrefixForChip(equiv.usd)}` : '—';
  return `<div class="hop-fee-row hop-fee-row--${variant}" title="${deps.escapeHtml(titleParts.join(' — '))}">
    <span class="hop-fee-row__label">${deps.escapeHtml(label)}</span>
    <span class="hop-fee-row__dest">${renderFeeDestinationInline(item, destCtx)}</span>
    <span class="hop-fee-row__amt"><span>${amtHtml}</span></span>
    <span class="hop-fee-row__usd"><span>${deps.escapeHtml(usd)}</span></span>
  </div>`;
}

function renderHopPlanFeesSection(
  hopFees: HopFeeBreakdownLite,
  leg: RouteHopLeg,
  quote: Record<string, unknown>,
  feeMint: string,
  feeAmt: string | null,
  ammKey?: string,
): string {
  const destCtx: FeeDestinationRenderCtx = {
    walletAddress: quoteWalletAddress(quote),
    ammKey: ammKey?.trim() || undefined,
  };
  const rowData = flattenHopFeeItems(hopFees.items).map((item) => ({
    item,
    equiv: computeFeeEquivalents(item.amountRaw, item.mint, quote),
  }));

  const walletRows: string[] = [];
  const outputRows: string[] = [];
  for (const { item, equiv } of rowData) {
    const row = renderHopFeeRow(item, equiv, destCtx);
    if (isOutputSideFeeDisplayItem(item) && !isWalletCostFeeItem(item, quote)) {
      outputRows.push(row);
    } else {
      walletRows.push(row);
    }
  }

  const group = (title: string | null, rows: string[]) =>
    rows.length
      ? `<div class="hop-fee-group">${
          title ? `<div class="hop-fee-group__title">${deps.escapeHtml(title)}</div>` : ''
        }${rows.join('')}</div>`
      : '';
  const splitGroups = walletRows.length > 0 && outputRows.length > 0;
  const groupsHtml = splitGroups
    ? group('Paid from wallet', walletRows) + group('Deducted from output', outputRows)
    : group(null, [...walletRows, ...outputRows]);

  const totalHtml = renderHopFeesTotalsChips(rowData, quote);

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

/** Base-column UI amount for one fee row (sell leg, or SOL via USD for foreign-mint fees). */
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
    const usdN = computeFeeUsdNumeric(item, quote) ?? parseFeeEquivUsdNumber(equiv.usd);
    if (usdN != null && usdN > 0) {
      totalUsd += usdN;
      found = true;
    }
  }
  return found ? totalUsd : null;
}

function formatHopFeeUsdTotalDisplay(usd: number): string {
  if (usd < 0.01) return '< $0.01';
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

function renderRouteMarketNode(
  meta: RouteHopMeta,
  leg: RouteHopLeg,
  quote: Record<string, unknown>,
  dexLoading = false,
): string {
  const si = meta.step.swapInfo;
  const dexHtml = dexLoading ? deps.renderLoadingSpinner('sm') : deps.escapeHtml(si?.label ?? 'DEX');
  const sym = deps.escapeHtml(leg.outSym);
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

function parseHopPctLabel(label: string | null): number | null {
  if (!label) return null;
  const n = Number(label.replace(/%/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function renderRouteTrack(node: RouteNode, legs: RouteHopLeg[], quote: Record<string, unknown>): string {
  const metas: RouteHopMeta[] = [];
  collectRouteHopMetas(node, metas);
  if (metas.length === 0) return '';

  let prevOutPct: number | null = null;
  const inner = metas
    .map((meta, i) => {
      const leg = legs[meta.planIndex];
      if (!leg) return '';
      const isLastHop = i === metas.length - 1;
      const inLink =
        i === 0 ? renderRoutePctBadge(hopPercentLabel(meta.step)) : '';
      const pctBreakdown = isLastHop
        ? computeFinalReceivePctBreakdown(quote)
        : computeIntermediateHopReceivePctBreakdown(quote, meta.planIndex, meta.step);
      let outPct = pctBreakdown?.pctLabel ?? hopOutgoingPercentLabel(meta.step, quote, isLastHop, meta.planIndex);
      const pctNum = parseHopPctLabel(outPct);
      if (!pctBreakdown && pctNum != null && prevOutPct != null && pctNum >= prevOutPct - 0.001) {
        outPct = null;
      } else if (pctNum != null) {
        prevOutPct = pctNum;
      }
      const outLink =
        outPct && outPct !== '100%'
          ? renderRoutePctBadge(outPct, 'out', pctBreakdown?.title ?? null)
          : '';
      return inLink + renderRouteMarketNode(meta, leg, quote) + outLink;
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
  inputFeeRows: QuotePayHeroCostStackItem[] | null = null,
  inputTotalLabel: string | null = null,
  outputFeesUsdLabel: string | null = null,
  outputUsdSubline: string | null = null,
  outputUsdTitle: string | null = null,
  showAllEndpointLabels = false,
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
        ? `$${ROUTING_PLACEHOLDER_DASH} (fee)`
        : ROUTING_PLACEHOLDER_DASH;
  const outputFeesVal =
    outputFeesUsdLabel && outputFeesUsdLabel !== '—'
      ? outputFeesUsdLabel
      : `-${ROUTING_PLACEHOLDER_DASH}`;
  const outputUsdVal =
    outputUsdSubline && outputUsdSubline !== '—'
      ? outputUsdSubline
      : `≈ ${ROUTING_PLACEHOLDER_DASH}`;

  const inputAddonHtml = renderDiagramInputFeeStackHtml(
    feeRows,
    inSym,
    showAllEndpointLabels,
    deps.getFormInputMint(),
  );
  const inputFeeLineCount = countDiagramInputFeeLines(feeRows, showAllEndpointLabels);
  const outputFeesShown =
    showAllEndpointLabels || (outputFeesUsdLabel != null && outputFeesUsdLabel !== '—');
  const outputFeeSpacerCount =
    outputFeesShown && inputFeeLineCount > 1 ? inputFeeLineCount - 1 : 0;
  const outputFeeSpacerHtml = renderDiagramOutputFeeAlignSpacers(
    outputFeeSpacerCount,
    feeRows.length > 1,
  );
  const multiInputFeesClass = feeRows.length > 1 ? ' routing-frame--multi-input-fees' : '';
  const inputTotalHtml =
    showAllEndpointLabels || (inputTotalLabel && inputTotalLabel !== '—')
      ? `<span class="routing-input-total">Total: <span class="routing-input-total__val">${deps.escapeHtml(inputTotalVal)}</span></span>`
      : '';
  const outputFeesUsdHtml =
    showAllEndpointLabels || (outputFeesUsdLabel && outputFeesUsdLabel !== '—')
      ? `<span class="routing-output-fees-usd">USD Fees: <span class="routing-output-fees-usd__val">${deps.escapeHtml(outputFeesVal)}</span></span>`
      : '';
  const outputUsdHtml =
    showAllEndpointLabels || (outputUsdSubline && outputUsdSubline !== '—')
      ? `<span class="routing-output-usd"${outputUsdTitle ? ` title="${deps.escapeHtml(outputUsdTitle)}"` : ''}>USD Output: <span class="routing-output-usd__val">${deps.escapeHtml(outputUsdVal)}</span></span>`
      : '';
  return `<div class="routing-canvas routing-canvas--flow${split ? ' routing-canvas--split' : ''}${routingCanvasHopClass(hopCount)}${feesClass}${accRentClass}${placeholderClass}${loadingClass}"${routingCanvasLayoutAttrs(hopCount, hasAccRentAbove)}>
    <div class="routing-frame${multiInputFeesClass}">
      <div class="routing-endpoint routing-endpoint--in">
        <div class="routing-endpoint-stack">
          ${inputAddonHtml}
          ${renderRouteEndpointPill(inDisplay, inSym, undefined, loading && inDisplay === '—')}
          ${inputTotalHtml}
        </div>
      </div>
      <div class="routing-endpoint routing-endpoint--out">
        <div class="routing-endpoint-stack">
          ${outputFeeSpacerHtml}
          ${outputFeesUsdHtml}
          ${renderRouteEndpointPill(outDisplay, outSym, outTitle, loading)}
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

export function renderRoutingDiagram(quote: Record<string, unknown>): string {
  const inSym = deps.getSwapInSym();
  const outSym = deps.getSwapOutSym();
  const inTotalDisplay = getQuoteWalletPayLabelFromQuote(quote);
  const inDisplay = getQuoteDiagramInputChipLabel(quote);
  const outAmt = formatQuoteTokenAmount(quote, 'out');
  const inputFeeRows = getQuoteDiagramInputFeeRows(quote, inSym);
  const inputTotalLabel = getQuoteDiagramInputTotalLabel(quote);
  const outputFeesUsdLabel = getQuoteDiagramWalletFeesUsdLabel(quote);
  const outputUsdSubline = getQuoteDiagramOutputUsdSubline(quote);
  const outputUsdTitle = deps.quoteOutputPriceSourceTitle(quote);

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
      outputFeesUsdLabel,
      outputUsdSubline,
      outputUsdTitle,
    );
  }

  const tree = buildRouteTree(plan);
  const split = routeTreeHasFork(tree);
  const hasFees = routePlanHasHopFees(plan);
  const hasAccRentAbove = routePlanHasAccRentFee(plan);
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
    outputFeesUsdLabel,
    outputUsdSubline,
    outputUsdTitle,
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
  const inputTotalLabel = lastQuote ? getQuoteDiagramInputTotalLabel(lastQuote) : null;
  const outputFeesUsdLabel = lastQuote ? getQuoteDiagramWalletFeesUsdLabel(lastQuote) : null;
  const outputUsdSubline = lastQuote ? getQuoteDiagramOutputUsdSubline(lastQuote) : null;
  const outputUsdTitle = lastQuote ? deps.quoteOutputPriceSourceTitle(lastQuote) : null;
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
    outputFeesUsdLabel,
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

export function updateRouteDiagramTitle(quote: Record<string, unknown>): void {
  const title = formatRouteDiagramTitle(quote);
  if (deps.dom.swapQuoteRouteSubtitleEl) deps.dom.swapQuoteRouteSubtitleEl.textContent = title;
  if (deps.dom.routingDialogTitleEl) deps.dom.routingDialogTitleEl.textContent = title;
}
export function renderRoutePanels(quote: Record<string, unknown>): void {
  updateRouteDiagramTitle(quote);
  if (deps.dom.swapQuoteDetailsRoutingEl) deps.dom.swapQuoteDetailsRoutingEl.innerHTML = renderRoutingDiagram(quote);
  if (deps.dom.swapQuoteDetailsRouteStepsEl) deps.dom.swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanSteps(quote);
  deps.syncRoutePlanStepsUi();
  if (deps.dom.routingDialogBodyEl) deps.dom.routingDialogBodyEl.innerHTML = renderRoutingDiagram(quote);
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

/** Center the diagram's scroll position when it still overflows after fitting. */
function centerRoutingDiagramScroll(container: HTMLElement | null): void {
  if (!container) return;
  const overflowX = container.scrollWidth - container.clientWidth;
  if (overflowX > 2) container.scrollLeft = overflowX / 2;
  const overflowY = container.scrollHeight - container.clientHeight;
  if (overflowY > 2) container.scrollTop = overflowY / 2;
}

export function scheduleRoutingDiagramZoom(): void {
  requestAnimationFrame(() => {
    syncRoutingDiagramZoom(deps.dom.swapQuoteDetailsRoutingEl);
    syncRoutingDiagramZoom(deps.dom.routingDialogBodyEl);
    requestAnimationFrame(() => {
      syncRoutingDiagramZoom(deps.dom.swapQuoteDetailsRoutingEl);
      syncRoutingDiagramZoom(deps.dom.routingDialogBodyEl);
      centerRoutingDiagramScroll(deps.dom.swapQuoteDetailsRoutingEl);
      centerRoutingDiagramScroll(deps.dom.routingDialogBodyEl);
    });
  });
}

let routingDiagramZoomBound = false;

export function bindRoutingDiagramZoomListeners(): void {
  if (routingDiagramZoomBound) return;
  routingDiagramZoomBound = true;
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
    loading && !hasInAmt ? deps.renderLoadingSpinner('sm') : deps.escapeHtml(leg.inAmt);
  const previewOutAmt = loading && !hasOutAmt ? deps.renderLoadingSpinner('sm') : deps.escapeHtml(leg.outAmt);
  const preview = `${previewInAmt} ${deps.escapeHtml(leg.inSym)} → ${previewOutAmt} ${deps.escapeHtml(leg.outSym)}`;
  const previewShare = showRouteShare ? ` · ${deps.escapeHtml(pct)} route share` : '';
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

  const detailRow = (
    label: string,
    valueHtml: string,
    opts?: { full?: string; mono?: boolean; mint?: boolean },
  ) => {
    const valClass = opts?.mint
      ? ' swap-hop-detail-row__v--mint'
      : opts?.mono
        ? ' swap-hop-detail-row__v--mono'
        : '';
    return `<div class="swap-hop-detail-row">
      <span class="swap-hop-detail-row__k">${deps.escapeHtml(label)}</span>
      <span class="swap-hop-detail-row__v${valClass}"${opts?.full ? ` title="${deps.escapeHtml(opts.full)}"` : ''}>${valueHtml}</span>
    </div>`;
  };

  const venueHtml =
    dex !== '—' && dex !== 'Unknown DEX'
      ? deps.escapeHtml(dex)
      : hopDetailPendingCell(loading, '—');
  const dexSummaryHtml = venueHtml;

  const mintRow = (label: string, mint: string, sym?: string) => {
    if (pendingHop) {
      if (mint) {
        return detailRow(label, formatMintDetailValue(mint, sym), { full: mint, mint: true });
      }
      return detailRow(label, hopDetailPendingCell(loading, '—'));
    }
    if (!mint) return detailRow(label, '—');
    return detailRow(label, formatMintDetailValue(mint, sym), { full: mint, mint: true });
  };

  const marketHtml = si?.ammKey
    ? deps.escapeHtml(si.ammKey)
    : pendingHop
      ? hopDetailPendingCell(loading, '—')
      : '—';
  const marketMono = Boolean(si?.ammKey && isLikelySolanaPubkey(si.ammKey));
  const marketTitle = si?.ammKey ? deps.escapeHtml(si.ammKey) : undefined;

  const metaRow = `<div class="swap-hop-detail-row swap-hop-detail-row--meta">
    <div class="swap-hop-detail-row__meta-box">
      <span class="swap-hop-detail-row__meta-k">Venue</span>
      <span class="swap-hop-detail-row__meta-v">${venueHtml}</span>
    </div>
    <div class="swap-hop-detail-row__meta-box">
      <span class="swap-hop-detail-row__meta-k">Market</span>
      <span class="swap-hop-detail-row__meta-v${marketMono ? ' swap-hop-detail-row__meta-v--mono' : ''}"${marketTitle ? ` title="${marketTitle}"` : ''}>${marketHtml}</span>
    </div>
    <div class="swap-hop-detail-row__meta-box">
      <span class="swap-hop-detail-row__meta-k">Route share</span>
      <span class="swap-hop-detail-row__meta-v">${deps.escapeHtml(pct)}</span>
    </div>
  </div>`;

  let inAmountHtml: string;
  if (si?.inAmount) {
    const inFmt = deps.formatRawTokenAmount(si.inAmount, leg.inMint);
    inAmountHtml = `${deps.escapeHtml(inFmt.display)} ${deps.escapeHtml(leg.inSym)}`;
  } else if (pendingHop) {
    inAmountHtml = hasInAmt
      ? `${deps.escapeHtml(leg.inAmt)} ${deps.escapeHtml(leg.inSym)}`
      : hopDetailPendingCell(loading, '—');
  } else {
    inAmountHtml = '—';
  }

  let quotedOutputHtml: string;
  const quotedOutRaw = hopFees?.quotedOutRaw || si?.outAmount;
  if (quotedOutRaw) {
    const grossFmt = deps.formatRawTokenAmount(quotedOutRaw, leg.outMint);
    quotedOutputHtml = `${deps.escapeHtml(grossFmt.display)} ${deps.escapeHtml(leg.outSym)}`;
  } else {
    quotedOutputHtml = pendingHop ? hopDetailPendingCell(loading, '—') : '—';
  }

  let netOutputHtml: string;
  const netOutRaw = hopFees?.netOutRaw || si?.outAmount;
  if (netOutRaw) {
    const netFmt = deps.formatRawTokenAmount(netOutRaw, leg.outMint);
    netOutputHtml = `${deps.escapeHtml(netFmt.display)} ${deps.escapeHtml(leg.outSym)}`;
  } else {
    netOutputHtml = pendingHop ? hopDetailPendingCell(loading, '—') : '—';
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

  const quotedTitle = quotedOutRaw
    ? (() => {
        const grossFmt = deps.formatRawTokenAmount(quotedOutRaw, leg.outMint);
        return `${grossFmt.full || grossFmt.display} ${leg.outSym} (${quotedOutRaw} raw)`;
      })()
    : undefined;

  const netTitle = netOutRaw
    ? (() => {
        const netFmt = deps.formatRawTokenAmount(netOutRaw, leg.outMint);
        return `${netFmt.full || netFmt.display} ${leg.outSym} (${netOutRaw} raw)`;
      })()
    : undefined;

  let feesHtml = '';
  if (hopFees?.items.length) {
    feesHtml = renderHopPlanFeesSection(hopFees, leg, quote, feeMint, feeAmt, si?.ammKey);
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

  const amountFlowRow = `<div class="swap-hop-detail-row swap-hop-detail-row--flow">
    <span class="swap-hop-detail-row__k">Amounts</span>
    <span class="swap-hop-detail-row__v swap-hop-detail-row__v--flow">
      <span class="${hopFlowPartClass(leg.inMint, leg.inSym)}"${inAmountTitle ? ` title="${deps.escapeHtml(inAmountTitle)}"` : ''}>${inAmountHtml}</span>
      <span class="swap-hop-detail-row__flow-sep" aria-hidden="true">→</span>
      <span class="${hopFlowPartClass(leg.outMint, leg.outSym)}"${quotedTitle ? ` title="${deps.escapeHtml(quotedTitle)}"` : ''}>${quotedOutputHtml}</span>
      <span class="swap-hop-detail-row__flow-sep" aria-hidden="true">→</span>
      <span class="${hopFlowPartClass(leg.outMint, leg.outSym)}"${netTitle ? ` title="${deps.escapeHtml(netTitle)}"` : ''}>${netOutputHtml}</span>
    </span>
  </div>`;

  const detailsHtml = `<div class="swap-hop-detail-rows">
    ${metaRow}
    ${amountFlowRow}
    ${mintRow('Input mint', leg.inMint, leg.inSym)}
    ${mintRow('Output mint', leg.outMint, leg.outSym)}
    ${
      feeMint
        ? detailRow(
            'Fee mint',
            pendingHop && loading && feeSym === '—'
              ? hopDetailPendingCell(loading, '—')
              : formatMintDetailValue(feeMint, feeSym !== '—' ? feeSym : undefined),
            { full: feeMint, mint: true },
          )
        : pendingHop
          ? detailRow(
              'Fee mint',
              leg.outMint
                ? formatMintDetailValue(leg.outMint, leg.outSym)
                : hopDetailPendingCell(loading, '—'),
              leg.outMint ? { full: leg.outMint, mint: true } : undefined,
            )
          : detailRow('Fee mint', '—')
    }
  </div>`;

  const shareBadgeHtml = showRouteShare
    ? `<span class="swap-hop-card__pct">${deps.escapeHtml(pct)}</span>`
    : '';

  const placeholderClass = placeholder ? ' swap-hop-step-details--placeholder' : '';
  const loadingClass = loading ? ' swap-hop-step-details--loading' : '';
  return `<details class="swap-hop-step-card swap-hop-step-details${placeholderClass}${loadingClass}"${expanded ? ' open' : ''}>
    <summary class="swap-hop-step-details__summary">
      <span class="swap-hop-card__index">Hop #${deps.escapeHtml(hopLabel)}</span>
      <span class="swap-hop-step-details__main">
        <span class="swap-hop-card__dex">${dexSummaryHtml}</span>
        <span class="swap-hop-step-details__preview">${preview}${previewShare}</span>
      </span>
      ${shareBadgeHtml}
    </summary>
    <div class="swap-hop-step-details__body">
      ${feesHtml}
      <section class="swap-hop-panel swap-hop-panel--details">
        <h5 class="swap-hop-panel__title">Details</h5>
        ${detailsHtml}
      </section>
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
  return renderRoutePlanStepDetail(mockStep, '1', mockLeg, true, true, loading, {}, true);
}

export function renderQuoteRoutePlanSteps(quote: Record<string, unknown>): string {
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
