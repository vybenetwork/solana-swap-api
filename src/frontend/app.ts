/**
 * Swap quote & build UI — built from TypeScript; compiles to public/app.js.
 * No imports to keep a single-file build (tsc emits one script).
 */

interface TokenSymbolResponse {
  symbol?: string;
  error?: string;
}

interface VybeSwapInfoLite {
  ammKey?: string;
  label?: string;
  inputMintAddress?: string;
  outputMintAddress?: string;
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

/** Hardcoded mint → symbol; never fetch these from API. */
const HARDCODED_MINT_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
};

const swapQuoteLoading = document.getElementById('swapQuoteLoading') as HTMLElement | null;
const swapQuoteError = document.getElementById('swapQuoteError') as HTMLElement | null;
const swapWalletAddressInput = document.getElementById('swapWalletAddress') as HTMLInputElement | null;
const swapInputMintInput = document.getElementById('swapInputMint') as HTMLInputElement | null;
const swapOutputMintInput = document.getElementById('swapOutputMint') as HTMLInputElement | null;
const swapAmountInput = document.getElementById('swapAmount') as HTMLInputElement | null;
const swapAmountUpBtn = document.getElementById('swapAmountUp') as HTMLButtonElement | null;
const swapAmountDownBtn = document.getElementById('swapAmountDown') as HTMLButtonElement | null;
const swapSlippageInput = document.getElementById('swapSlippage') as HTMLInputElement | null;
const swapRouterSelect = document.getElementById('swapRouter') as HTMLSelectElement | null;
const swapGaslessCheckbox = document.getElementById('swapGasless') as HTMLInputElement | null;
const swapAutoSlippageCheckbox = document.getElementById('swapAutoSlippage') as HTMLInputElement | null;
const swapSimulateCheckbox = document.getElementById('swapSimulate') as HTMLInputElement | null;
const swapPartnerInput = document.getElementById('swapPartner') as HTMLInputElement | null;
const swapPoolAddressInput = document.getElementById('swapPoolAddress') as HTMLInputElement | null;
const swapProtocolSelect = document.getElementById('swapProtocol') as HTMLSelectElement | null;
const swapServiceFeeInput = document.getElementById('swapServiceFee') as HTMLInputElement | null;
const swapQuoteBtn = document.getElementById('swapQuoteBtn') as HTMLButtonElement | null;
const swapBuildBtn = document.getElementById('swapBuildBtn') as HTMLButtonElement | null;
const swapBuildResultEl = document.getElementById('swapBuildResult') as HTMLElement | null;
const swapTxBase64El = document.getElementById('swapTxBase64') as HTMLTextAreaElement | null;
const swapCopyTxBtn = document.getElementById('swapCopyTxBtn') as HTMLButtonElement | null;

const swapInputSymbolEl = document.getElementById('swapInputSymbol') as HTMLElement | null;
const swapOutputSymbolEl = document.getElementById('swapOutputSymbol') as HTMLElement | null;
const swapBuyAmountDisplayEl = document.getElementById('swapBuyAmountDisplay') as HTMLElement | null;
const swapSellFiatEl = document.getElementById('swapSellFiat') as HTMLElement | null;
const swapBuyFiatEl = document.getElementById('swapBuyFiat') as HTMLElement | null;
const swapFooterRateEl = document.getElementById('swapFooterRate') as HTMLElement | null;
const swapFooterImpactEl = document.getElementById('swapFooterImpact') as HTMLElement | null;
const swapFooterMinOutEl = document.getElementById('swapFooterMinOut') as HTMLElement | null;
const swapRouteBtnEl = document.getElementById('swapRouteBtn') as HTMLButtonElement | null;
const swapFlipBtnEl = document.getElementById('swapFlipBtn') as HTMLButtonElement | null;
const swapPasteOutputBtnEl = document.getElementById('swapPasteOutputBtn') as HTMLButtonElement | null;
const swapCardSellMintEl = document.getElementById('swapCardSellMint') as HTMLElement | null;
const swapCardBuyMintEl = document.getElementById('swapCardBuyMint') as HTMLElement | null;
const swapCardSellNameEl = document.getElementById('swapCardSellName') as HTMLElement | null;
const swapCardBuyNameEl = document.getElementById('swapCardBuyName') as HTMLElement | null;
const swapCardSellPriceEl = document.getElementById('swapCardSellPrice') as HTMLElement | null;
const swapCardBuyPriceEl = document.getElementById('swapCardBuyPrice') as HTMLElement | null;

const routingDialogEl = document.getElementById('routingDialog') as HTMLDialogElement | null;
const routingDialogBodyEl = document.getElementById('routingDialogBody') as HTMLElement | null;
const routingDialogCloseEl = document.getElementById('routingDialogClose') as HTMLButtonElement | null;
const swapPairCardsEl = document.getElementById('swapPairCards') as HTMLElement | null;
const swapQuoteDetailsEmptyEl = document.getElementById('swapQuoteDetailsEmpty') as HTMLElement | null;
const swapQuoteDetailsBodyEl = document.getElementById('swapQuoteDetailsBody') as HTMLElement | null;
const swapQuoteDetailsRoutingEl = document.getElementById('swapQuoteDetailsRouting') as HTMLElement | null;
const swapQuoteDetailsFieldsEl = document.getElementById('swapQuoteDetailsFields') as HTMLElement | null;
const swapQuoteDetailsRouteStepsEl = document.getElementById('swapQuoteDetailsRouteSteps') as HTMLElement | null;

/** Last successful swap quote response (for build tx validation). */
let lastSwapQuoteOk: Record<string, unknown> | null = null;

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
  updateSwapPairCards();
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

function updateSwapPairCards(): void {
  const inMint = swapInputMintInput?.value.trim() ?? '';
  const outMint = swapOutputMintInput?.value.trim() ?? '';
  if (swapCardSellMintEl) swapCardSellMintEl.textContent = inMint ? truncate(inMint, 4, 4) : '—';
  if (swapCardBuyMintEl) swapCardBuyMintEl.textContent = outMint ? truncate(outMint, 4, 4) : '—';
  if (swapCardSellNameEl) swapCardSellNameEl.textContent = getSwapInSym();
  if (swapCardBuyNameEl) swapCardBuyNameEl.textContent = getSwapOutSym();
  if (swapCardSellPriceEl) {
    swapCardSellPriceEl.innerHTML = '<span class="swap-pair-chg swap-pair-chg--muted">—</span>';
  }
  if (swapCardBuyPriceEl) {
    swapCardBuyPriceEl.innerHTML = '<span class="swap-pair-chg swap-pair-chg--muted">—</span>';
  }
}

function routeOutputMintSymbol(mint: string | undefined): string {
  const m = (mint ?? '').trim();
  if (!m) return '—';
  const hard = HARDCODED_MINT_SYMBOLS[m];
  if (hard) return hard;
  return truncate(m, 4, 4);
}

function endpointTokenDotClass(sym: string): string {
  const u = sym.toUpperCase();
  if (u.includes('SOL')) return 'routing-token-dot--sol';
  if (u === 'USDC') return 'routing-token-dot--usdc';
  if (u === 'USDT' || u === 'USDT1') return 'routing-token-dot--usdt';
  return 'routing-token-dot';
}

function partitionRouteBranches(plan: VybeRoutePlanStepLite[]): VybeRoutePlanStepLite[][] {
  if (plan.length === 0) return [];
  if (plan.length === 1) return [[plan[0]!]];
  const p0 = plan[0]?.percent ?? 0;
  if (p0 >= 99.9) return [plan];

  let headEnd = -1;
  let sum = 0;
  for (let i = 0; i < plan.length; i++) {
    sum += plan[i]?.percent ?? 0;
    headEnd = i;
    if (sum >= 99.5) break;
  }
  const head = plan.slice(0, headEnd + 1);
  const headSum = head.reduce((a, s) => a + (s.percent ?? 0), 0);
  const isParallel =
    head.length >= 2 &&
    headSum >= 98.5 &&
    headSum <= 101.5 &&
    head.every((s) => (s.percent ?? 0) > 0 && (s.percent ?? 0) < 99);

  if (!isParallel) return [plan];

  const rest = plan.slice(head.length);
  const branches = head.map((h) => [h]);
  for (const step of rest) {
    const inMint = (step.swapInfo?.inputMintAddress ?? '').trim();
    let assigned = -1;
    for (let b = 0; b < branches.length; b++) {
      const last = branches[b]![branches[b]!.length - 1]!;
      const out = (last.swapInfo?.outputMintAddress ?? '').trim();
      if (inMint && out && inMint === out) {
        assigned = b;
        break;
      }
    }
    if (assigned >= 0) branches[assigned]!.push(step);
    else branches[branches.length - 1]!.push(step);
  }
  return branches;
}

function renderRoutingMarketNode(step: VybeRoutePlanStepLite, opts: { showPercent: boolean }): string {
  const si = step.swapInfo;
  const sym = routeOutputMintSymbol(si?.outputMintAddress);
  const dotClass = endpointTokenDotClass(sym);
  const pct = step.percent != null ? `${step.percent}%` : '';
  const dex = escapeHtml(si?.label ?? '—');
  const pctBlock =
    opts.showPercent && pct ? `<span class="routing-pct-badge">${escapeHtml(pct)}</span>` : '';
  return `
    <div class="routing-market-node">
      ${pctBlock}
      <div class="routing-pill routing-pill--hop">
        <span class="routing-token-dot ${dotClass}" aria-hidden="true"></span>
        <span class="routing-token-sym">${escapeHtml(sym)}</span>
      </div>
      <div class="routing-dex-caption">${dex}</div>
    </div>`;
}

function renderRoutingBranch(steps: VybeRoutePlanStepLite[]): string {
  if (steps.length === 0) return '';
  const parts: string[] = [];
  steps.forEach((step, idx) => {
    if (idx > 0) {
      const p = step.percent != null ? `${step.percent}%` : '';
      parts.push(
        `<div class="routing-between-hops">${p ? `<span class="routing-pct-badge">${escapeHtml(p)}</span>` : ''}</div>`,
      );
    }
    parts.push(renderRoutingMarketNode(step, { showPercent: idx === 0 }));
  });
  return `<div class="routing-branch">${parts.join('')}</div>`;
}

function renderRoutingDiagram(quote: Record<string, unknown>): string {
  const inSym = getSwapInSym();
  const outSym = getSwapOutSym();
  const inAmtRaw = quote.inAmount != null ? escapeHtml(String(quote.inAmount)) : '—';
  const outUi =
    typeof quote.outAmountUi === 'number' && Number.isFinite(quote.outAmountUi)
      ? escapeHtml(String(quote.outAmountUi))
      : quote.outAmount != null
        ? escapeHtml(String(quote.outAmount))
        : '—';
  const inDot = endpointTokenDotClass(inSym);
  const outDot = endpointTokenDotClass(outSym);

  const endpointRow = `<div class="routing-endpoints">
      <div class="routing-pill routing-pill--endpoint routing-pill--in"><span class="routing-token-dot ${inDot}" aria-hidden="true"></span><span class="routing-amt">${inAmtRaw}</span><span class="routing-sym">${escapeHtml(inSym)}</span></div>
      <div class="routing-pill routing-pill--endpoint routing-pill--out"><span class="routing-token-dot ${outDot}" aria-hidden="true"></span><span class="routing-amt">${outUi}</span><span class="routing-sym">${escapeHtml(outSym)}</span></div>
    </div>`;

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  if (plan.length === 0) {
    return `<div class="routing-canvas routing-canvas--flow">
    ${endpointRow}
    <p class="routing-empty">No route steps in this quote.</p>
  </div>`;
  }

  const branches = partitionRouteBranches(plan);
  const splitClass = branches.length >= 2 ? 'routing-split-board--2' : 'routing-split-board--1';
  const branchesHtml = branches.map((b) => renderRoutingBranch(b)).join('');

  return `<div class="routing-canvas routing-canvas--flow">
    ${endpointRow}
    <div class="routing-split-board ${splitClass}">${branchesHtml}</div>
  </div>`;
}

const SWAP_QUOTE_FIELD_ORDER: readonly string[] = [
  'inputMintAddress',
  'inAmount',
  'outputMintAddress',
  'outAmount',
  'otherAmountThreshold',
  'swapMode',
  'priceImpactPct',
  'outAmountUi',
  'otherAmountThresholdUi',
  'swapRate',
  'contextSlot',
  'slippageBps',
  'swapUsdValue',
  'timeTaken',
  'mostReliableAmmsQuoteReport',
  'otherRoutePlans',
];

function renderQuoteFieldCellHtml(v: unknown): string {
  if (v === null || v === undefined) return '<span class="swap-quote-null">null</span>';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return `<code>${escapeHtml(String(v))}</code>`;
  }
  try {
    return `<pre class="swap-quote-pre">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
  } catch {
    return `<code>${escapeHtml(String(v))}</code>`;
  }
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
    return `<div class="swap-quote-field-item"><div class="swap-quote-k">${escapeHtml(key)}</div><div class="swap-quote-v">${renderQuoteFieldCellHtml(v)}</div></div>`;
  });

  let routeRow: string;
  if (Array.isArray(quote.routePlan)) {
    const n = quote.routePlan.length;
    routeRow =
      n > 0
        ? `<div class="swap-quote-field-item swap-quote-field-item--full"><div class="swap-quote-k">routePlan</div><div class="swap-quote-v"><em>${escapeHtml(`${n} hop(s) — see Route plan steps above`)}</em></div></div>`
        : `<div class="swap-quote-field-item swap-quote-field-item--full"><div class="swap-quote-k">routePlan</div><div class="swap-quote-v"><code>[]</code></div></div>`;
  } else {
    routeRow = `<div class="swap-quote-field-item swap-quote-field-item--full"><div class="swap-quote-k">routePlan</div><div class="swap-quote-v">${renderQuoteFieldCellHtml(quote.routePlan)}</div></div>`;
  }

  return `<div class="swap-quote-fields-grid">${rowHtml.join('')}${routeRow}</div>`;
}

function renderRoutePlanStepDetail(step: VybeRoutePlanStepLite, index: number): string {
  const si = step.swapInfo;
  const pct = step.percent != null && Number.isFinite(step.percent) ? `${step.percent}%` : '—';
  const bps = step.bps != null && Number.isFinite(Number(step.bps)) ? String(step.bps) : '—';
  const rows: [string, string][] = [
    ['percent', pct],
    ['bps', bps],
    ['ammKey', si?.ammKey ?? '—'],
    ['label', si?.label ?? '—'],
    ['inputMintAddress', si?.inputMintAddress ?? '—'],
    ['outputMintAddress', si?.outputMintAddress ?? '—'],
    ['inAmount', si?.inAmount ?? '—'],
    ['outAmount', si?.outAmount ?? '—'],
    ['feeAmount', si?.feeAmount ?? '—'],
    ['feeMintAddress', si?.feeMintAddress ?? '—'],
  ];
  const dl = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd><code>${escapeHtml(v)}</code></dd>`)
    .join('');
  return `<div class="swap-quote-step-card">
    <div class="swap-quote-step-head">Step ${index + 1}</div>
    <dl class="swap-quote-step-dl">${dl}</dl>
  </div>`;
}

function renderQuoteRoutePlanSteps(quote: Record<string, unknown>): string {
  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  if (plan.length === 0) return '<p class="routing-empty">No route steps in this quote.</p>';
  return plan.map((s, i) => renderRoutePlanStepDetail(s, i)).join('');
}

function renderSwapQuoteDetailsPanel(quote: Record<string, unknown>): void {
  if (swapQuoteDetailsEmptyEl) swapQuoteDetailsEmptyEl.hidden = true;
  if (swapQuoteDetailsBodyEl) swapQuoteDetailsBodyEl.hidden = false;
  if (swapQuoteDetailsRoutingEl) swapQuoteDetailsRoutingEl.innerHTML = renderRoutingDiagram(quote);
  if (swapQuoteDetailsRouteStepsEl) swapQuoteDetailsRouteStepsEl.innerHTML = renderQuoteRoutePlanSteps(quote);
  if (swapQuoteDetailsFieldsEl) swapQuoteDetailsFieldsEl.innerHTML = renderQuoteFieldsTable(quote);
}

function resetSwapQuoteDetailsPanel(): void {
  if (swapQuoteDetailsEmptyEl) swapQuoteDetailsEmptyEl.hidden = false;
  if (swapQuoteDetailsBodyEl) swapQuoteDetailsBodyEl.hidden = true;
  if (swapQuoteDetailsRoutingEl) swapQuoteDetailsRoutingEl.innerHTML = '';
  if (swapQuoteDetailsFieldsEl) swapQuoteDetailsFieldsEl.innerHTML = '';
  if (swapQuoteDetailsRouteStepsEl) swapQuoteDetailsRouteStepsEl.innerHTML = '';
}

function clearSwapQuotePanel(): void {
  lastSwapQuoteOk = null;
  if (swapBuildBtn) swapBuildBtn.disabled = true;
  if (swapBuyAmountDisplayEl) swapBuyAmountDisplayEl.textContent = '—';
  if (swapSellFiatEl) swapSellFiatEl.textContent = '—';
  if (swapBuyFiatEl) swapBuyFiatEl.textContent = '—';
  if (swapFooterRateEl) swapFooterRateEl.textContent = 'Rate updates after quote';
  if (swapFooterImpactEl) swapFooterImpactEl.textContent = '—';
  if (swapFooterMinOutEl) swapFooterMinOutEl.textContent = '—';
  if (swapRouteBtnEl) {
    swapRouteBtnEl.disabled = true;
    swapRouteBtnEl.textContent = 'Routing';
  }
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
  if (swapBuyAmountDisplayEl) {
    if (typeof quote.outAmountUi === 'number' && Number.isFinite(quote.outAmountUi)) {
      swapBuyAmountDisplayEl.textContent = String(quote.outAmountUi);
    } else if (quote.outAmount != null) {
      swapBuyAmountDisplayEl.textContent = String(quote.outAmount);
    } else {
      swapBuyAmountDisplayEl.textContent = '—';
    }
  }

  const usdLabel = formatSwapUsdLabel(quote.swapUsdValue);
  if (swapSellFiatEl) swapSellFiatEl.textContent = usdLabel ? `~ ${usdLabel}` : '—';
  if (swapBuyFiatEl) swapBuyFiatEl.textContent = usdLabel ? `~ ${usdLabel}` : '—';

  const inS = getSwapInSym();
  const outS = getSwapOutSym();
  if (swapFooterRateEl) {
    if (typeof quote.swapRate === 'number' && Number.isFinite(quote.swapRate)) {
      swapFooterRateEl.textContent = `1 ${inS} ≈ ${quote.swapRate.toFixed(8)} ${outS}`;
    } else {
      swapFooterRateEl.textContent = 'Rate from quote';
    }
  }

  if (swapFooterImpactEl) {
    if (quote.priceImpactPct != null && String(quote.priceImpactPct).length > 0) {
      swapFooterImpactEl.textContent = `Price impact ${String(quote.priceImpactPct)}%`;
    } else {
      swapFooterImpactEl.textContent = '—';
    }
  }

  if (swapFooterMinOutEl) {
    if (quote.otherAmountThresholdUi != null) {
      swapFooterMinOutEl.textContent = `Min. out (UI) ${String(quote.otherAmountThresholdUi)} ${outS}`;
    } else {
      swapFooterMinOutEl.textContent = '—';
    }
  }

  const plan = Array.isArray(quote.routePlan) ? (quote.routePlan as VybeRoutePlanStepLite[]) : [];
  const planLen = plan.length;
  const branches = partitionRouteBranches(plan);
  if (swapRouteBtnEl) {
    swapRouteBtnEl.disabled = planLen === 0;
    if (branches.length >= 2) {
      swapRouteBtnEl.textContent = `${branches.length} markets (${planLen} hops)`;
    } else if (planLen) {
      swapRouteBtnEl.textContent = `${planLen} hop${planLen === 1 ? '' : 's'}`;
    } else {
      swapRouteBtnEl.textContent = 'Routing';
    }
  }

  if (routingDialogBodyEl) routingDialogBodyEl.innerHTML = renderRoutingDiagram(quote);

  renderSwapQuoteDetailsPanel(quote);
  updateSwapPairCards();
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
  if (swapBuildBtn) swapBuildBtn.disabled = true;
  resetSwapQuoteDetailsPanel();
  if (swapQuoteError) clearInlineError(swapQuoteError);
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

  try {
    const res = await fetchWithRetry(`/api/trading/swap-quote?${params.toString()}`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) {
      if (swapQuoteError) showInlineError(swapQuoteError, body.error || `Quote failed (${res.status})`);
      return;
    }
    lastSwapQuoteOk = body;
    renderSwapQuoteUI(body);
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
  const wallet = swapWalletAddressInput?.value.trim() ?? '';
  if (!wallet) {
    if (swapQuoteError) showInlineError(swapQuoteError, 'Wallet (accountAddress) is required to build the transaction.');
    return;
  }
  const inputMint = swapInputMintInput?.value.trim() ?? '';
  const outputMint = swapOutputMintInput?.value.trim() ?? '';
  const amount = swapAmountInput ? Number(swapAmountInput.value) : NaN;
  const slippage = swapSlippageInput ? Number(swapSlippageInput.value) : undefined;
  const router = swapRouterSelect?.value ?? 'vybe';
  const serviceFeeRaw = swapServiceFeeInput?.value.trim() ?? '';
  const serviceFeeN = serviceFeeRaw ? Number(serviceFeeRaw) : NaN;

  if (!swapBuildResultEl || !swapTxBase64El) return;
  if (swapQuoteError) clearInlineError(swapQuoteError);
  if (swapBuildBtn) swapBuildBtn.disabled = true;

  try {
    const res = await fetchWithRetry('/api/trading/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountAddress: wallet,
        amount,
        inputMintAddress: inputMint,
        outputMintAddress: outputMint,
        slippage: Number.isFinite(slippage) ? slippage : undefined,
        router,
        gasless: swapGaslessCheckbox?.checked === true,
        autoCalculateSlippage: swapAutoSlippageCheckbox?.checked === true,
        simulate: swapSimulateCheckbox?.checked === true,
        partner: swapPartnerInput?.value.trim() || undefined,
        poolAddress: swapPoolAddressInput?.value.trim() || undefined,
        protocol: swapProtocolSelect?.value.trim() || undefined,
        swapFee: Number.isFinite(serviceFeeN) && serviceFeeN >= 0 ? serviceFeeN : undefined,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { transaction?: string; error?: string };
    if (!res.ok) {
      if (swapQuoteError) showInlineError(swapQuoteError, body.error || `Build failed (${res.status})`);
      return;
    }
    if (typeof body.transaction === 'string') {
      swapTxBase64El.value = body.transaction;
      swapBuildResultEl.hidden = false;
    }
  } catch (err) {
    if (swapQuoteError) showInlineError(swapQuoteError, err instanceof Error ? err.message : String(err));
  } finally {
    if (swapBuildBtn) swapBuildBtn.disabled = false;
  }
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
  const rounded = Math.round(next / step) * step;
  const out =
    Number.isInteger(rounded) || Math.abs(rounded - Math.round(rounded)) < 1e-9
      ? String(Math.round(rounded))
      : String(parseFloat(rounded.toFixed(10)));
  swapAmountInput.value = out;
  swapAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
}

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

swapAmountUpBtn?.addEventListener('click', () => adjustSwapAmountByStep(1));
swapAmountDownBtn?.addEventListener('click', () => adjustSwapAmountByStep(-1));

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
      void refreshSwapSymbols();
      void fetchSwapQuote();
    } catch {
      if (swapQuoteError) showInlineError(swapQuoteError, 'Could not read clipboard (permission denied).');
    }
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

if (swapInputMintInput) {
  swapInputMintInput.addEventListener('input', () => {
    updateSwapPairCards();
    void refreshSwapSymbols();
  });
}
if (swapOutputMintInput) {
  swapOutputMintInput.addEventListener('input', () => {
    updateSwapPairCards();
    void refreshSwapSymbols();
  });
}

void refreshSwapSymbols();
updateSwapPairCards();
