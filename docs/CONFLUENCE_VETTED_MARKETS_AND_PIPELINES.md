# Vetted markets — trade-count rules and HTTP pool selection

Formal rules are in **Sections 1–10** below. **Non‑technical folks:** read **Plain-language overview** once; skip jargon tables unless you implement it.

---

## Plain-language overview (read this first)

**TL;DR**  
Per **pair** your token trades (each **quote mint** is its own lane), sort **pools by how many trades** hit them in your sample. Keep pools that satisfy **three dead-simple tiers** spelled out below. If a token **graduated** off a launchpad bonding pool, treat that **old pool as disqualified**, even when it still has the biggest trade totals.

---

**Pools (venues)** — same mint can trade on lots of venues. Each has a **pool (`market`) address**. Selection is deterministic: counts first, graduation second.

---

**Rule bundle 1 — more than ten pools on that quote lane**

You look only at **the five busiest** pools by trade count (#1 busiest … #5).

Then look at **`#1`’s** trade count (call it **`topMarketCount`**, not literally “five hundred”):

- If **`topMarketCount` is ≥ 500** → every pool among those five must itself have **≥ 500 trades** or it drops.  
  *(So **500** is “the leader crossed a depth line; we tighten the floor for everybody in top-five.”)*  
- If **`topMarketCount` is anywhere below 500** (even **499**) → each of those five needs **≥ 50 trades**.

Everyone ranked **outside** **#1–#5** loses automatically.

---

**Rule bundle 2 — two to ten pools on that lane**

Still rank by bustle. Let **`maxCount`** be **the champion’s** trade count.

Keep a pool **only if BOTH**:

- **`totalCount ≥ 10% × maxCount`** (ten percent of the champ’s trades — this is **`threshold`**)  
- **`totalCount ≥ 10`** trades minimum

**Exactly one pool** → this mass-drop branch does nothing.

---

**Rule bundle 3 — launchpad graduation (Pump.fun-ish)**

Bonding curves often sit on **tons of old volume**; once the token moves, traffic is usually on the **new pool**.

If our **graduation store** says **`graduated = true`:**

1. Tagged **bonding pool** ⇒ **always reject** for **`selected`** (even when it’s still #1 by count and passes Bundles 1/2).  
2. **Successor** pools compete under Bundles 1/2 only.

---

**`GET /api/vetted-markets`** — **JSON list of pools**, each with **address**, **trade count**, **`selected`** yes/no, optional extras for debugging. Callers ingest trades (Vybe or proxy), run Bundles **1–3**, return this shape. **Candlestick OHLC stays on OHLC endpoints** — not mixed into this payload.

**Token “last price”** — Vybe **`GET /v4/tokens/{mint}`** (we proxy **`GET /api/tokens/:mint`**). The **`price`** field is the ticker-style number people treat as spot. **We want it sourced from pools that pass the same bundles as above**, not miscellaneous pools upstream still counts as acceptable.

---

> **Paste note (Confluence)**  
> Send non-engineers straight to **Plain-language overview**.

---

## 1. Purpose

Define **how we choose which pool / market addresses are “in” for a token**: **trade-count rules** (**Sections 4.1–4.2**) plus **launchpad graduation overrides** (**Section 4.3**) so legacy bonding venues (e.g. **Pump.fun** pre-migration pools) cannot stay selected purely because they dominate historical volume—see **Purpose** consumers below.

The **baseline** mirrors the **app script** (`src/frontend/app.ts`) count logic; **graduation tracking** described here extends that behaviour and is **not** yet wired in this repo’s UI.

That selected set feeds:

| Consumer | Goal |
|----------|------|
| **Candles pipeline** | Build or aggregate OHLC from trades **only from selected markets** (per quote mint as needed). |
| **Swap quotes pipeline** | Prefer or restrict **`poolAddress`** / routes to pools in the selected set. |
| **`vetted-markets` API** | **REST** (`GET`): pool rows with **`marketAddress`**, **`totalTradeCount`**, **`selected`**, computed with **Sections 4.1–4.3**. Response omits OHLC bar fields (`open`/`high`/`low`/`close` series); use candle endpoints for time series. |
| **Token details / spot “last price”** | Vybe **`GET /v4/tokens/{mintAddress}`** (**`price`** and related aggregates). Proxied here as **`GET /api/tokens/:mint`** (`solana-quote-swap-api`). **Proposal:** **`price`** must aggregate over the **same `selected`** pool universe as Sections **4.1–4.3**, not stray low-signal venues (today this path can effectively include pools we would **reject**—e.g. un-thin markets or **legacy bonding pools after graduation**). |


**Optional OHLC hygiene** (“filter wicks on”: lookback, deviation %, candle close/open gap filtering) remains in the script for **chart quality** on trade-rebuilt candles. It is **not** how we decide **which** markets are listed as vetted; **vetting = Sections 4.1–4.3** (**counts + graduation**).

---

## 2. Reference implementation

**File:** `solana-quote-swap-api` → `src/frontend/app.ts`  
**Activation:** candles source **“Vybe OHLC from Trades”** and **Filter wicks ON** triggers the **full** pipeline in the UI; **market auto-exclusion** (the inclusion rules documented here) runs in that block keyed off **`combinedByMarket`** and **`excludedMarkets`** after per-market rows are assembled.

Vybe **`GET /v4/trading/swap-quote`** “vetted liquidity” is **their** wording; **`vetted-markets` here** means **our** explicit count-based pool list.

---

## 3. Inputs (canonical)

| Input | Meaning |
|--------|--------|
| **`tokenMint`** | Mint being analysed (the “either side” / chart mint in the UI). |
| **`trades`** | Full trade rows with **`marketAddress`**, **`baseMintAddress`**, counterparty mint fields, timestamps, optional program. |
| **`quoteMint` (optional)** | If omitted, apply rules **once per quote mint** seen with `tokenMint`. If provided, restrict to that quote. |
| **Graduation store (service)** | For launchpad tokens (**Pump.fun**, etc.): whether the mint **has graduated**, **when**, and mappings **legacy bonding `marketAddress` → successor pool(s)**. Feeds **Section 4.3**. |

Within each quote mint, derive **markets**: distinct **`marketAddress`** with **`totalTradeCount`** = count of fetched trades for `(tokenMint side, quoteMint, market)` (the script aligns this with **`totalCount`** on each pooled row before auto-exclusion).

Sort **`combinedByMarket`** by **`totalCount` descending** (highest-trade-count pool first).

---

## 4. Primary spec: **which markets are selected**

### Evaluation order

1. **Trade counts only:** apply **Sections 4.1–4.2** to derive a candidate set from aggregates (**`totalTradeCount`** per market).
2. **Launchpad graduation:** apply **Section 4.3** — **must remove** labelled **legacy bonding** pools from **`selected`** when the mint has graduated, regardless of counts from **Sections 4.1–4.2** (they may rank #1 or pass depth thresholds).

**Count-based checks** (**4.1–4.2**) use **`totalTradeCount`** (**`totalCount`** in code) **per market within that quote cohort**, after pooling trades by market.

Let **`N`** = number of distinct markets (**pools**) for this quote mint.

Let **`topMarketCount`** = trade count of the **rank-1** market (the pool with the **most** trades).

### 4.1 More than ten pools (**`N > 10`**)

1. Take only the **top five** markets by **`totalTradeCount`** (five largest pools).
2. Define the minimum acceptable count for keeping a pool among those five:  
   **`MIN_COUNT_TOP5`** = **`500`** if **`topMarketCount ≥ 500`**, otherwise **`MIN_COUNT_TOP5`** = **`50`**.
3. **Selected:** a pool is kept **only if** it is **among that top-five list** **and** **`totalTradeCount ≥ MIN_COUNT_TOP5`**.
4. **Rejected:** every other pool (**not top five**, or inside top five but **below** `MIN_COUNT_TOP5`).

So the **deepest venue** defines the floor: dominant pools pull the bar to **500** minimum among the top quintet when liquidity is genuinely deep; thinner tokens use **50** among the same top five slice.

### 4.2 Two to ten pools (**`2 ≤ N ≤ 10`**)

Let **`maxCount`** = maximum **`totalTradeCount`** among those markets.

Let **`threshold`** = **`0.1 × maxCount`** (10% of the busiest pool).

**Selected:** **`totalTradeCount ≥ threshold`** **and** **`totalTradeCount ≥ 10`** (hard floor of **10 trades**).

**Rejected:** failing either inequality.

Single-pool (**`N = 1`**): the script applies **no** mass exclusion from this branch.

### 4.3 Launchpad graduation override (Pump.fun and similar)

**Problem:** Pools tied to bonding-curve launchpads (**Pump.fun** and peers) often **dominate legacy trade totals**. After **graduation** (migration into **PumpSwap / Raydium / successor AMM**, etc.), the **economically canonical** liquidity lives on **new pool address(es)**. Naive inclusion rules (**Sections 4.1–4.2**) keep selecting the **old** address while it stays #1 by count or clears **volume-relative** tiers (sometimes described casually as **“top-X% busiest pool” / depth bands** grounded in **`maxCount`** for **Section 4.2**).

**Operational requirement**

- Persist **graduation state** per **`tokenMint`** (and optionally per **legacy pool**): **`graduated`**, **`graduatedAt`**, **`launchpad`** (protocol id), **`successorMarketAddress`**(es) or rule that resolves them.

**Override rules** (applied **after** Sections **4.1–4.2**)

| Condition | Effect on **`selected`** |
|-----------|---------------------------|
| Pool is flagged **legacy bonding / pre-graduation venue** **and** `tokenMint` has **`graduated = true`** for that launchpad | **Force exclusion:** **`selected = false`** for that **`marketAddress`**, **even when** it is **largest `totalTradeCount`**, qualifies for **top-five + `MIN_COUNT_TOP5`**, or passes **≥ 10% × `maxCount`** + **`≥ 10`** trades (**Section 4.2**) — **counts do not salvage** the legacy venue. |
| Post-graduation **successor** pool address(es) | Eligible strictly through **Sections 4.1–4.2** among **remaining** venues; optionally **prioritize successors** briefly when thin trade ingestion right after graduation. |

**Consumers**

**`vetted-markets`, candles aggregates, swap `poolAddress`** all honor **Section 4.3** so stale bonding-curve pools stop driving routing / OHLC after graduation.

---

## 5. `GET /api/vetted-markets` (pool selection payload)

Implementations ingest trades (Vybe **`GET /v4/trades`** or **`GET /api/trades`** proxy), aggregate counts per **`marketAddress`**, apply **Sections 4.1–4.3**, and return structured rows (**no OHLC candle array** in response; see Purpose table **`vetted-markets` API**).

For each **`quoteMint`**, return **`marketAddress`** rows annotated with **`selected`** reflecting **counts + overrides**.

Suggested response fields:

- **`marketAddress`**
- **`totalTradeCount`**
- **`selected`** (boolean) — **`true`** only if Sections **4.1–4.2** qualify the row **and** Section **4.3** does not force exclusion  
- **`quoteMint`**, **`tokenMint`**
- **Optional diagnostics:** **`legacyLaunchpad`**, **`graduateSuperseded`** (explain forced drop), **`successorHints`**

Do **not** require “suspicious” / percentile-wick scoring for selection; optionally return those as **secondary analytics** only, clearly separate from **`selected`**.

**Parameter scope:** callers use trade-fetch dimensions (`tokenMint`, optional `quoteMint`, paging/time window mirroring **`GET /api/trades`**). Omit candle-only parameters (`resolution`, gap/wick knobs for OHLC); those live on OHLC endpoints.

```
GET /api/vetted-markets?tokenMint=<pubkey>&quoteMint=<optional>&pageFrom=0&pageTo=...
```

---

## 6. Candles pipeline

| Step | Behaviour |
|------|-----------|
| Ingest trades | Same universe as chart “from trades”. |
| **Pool list** | Apply **Sections 4.1–4.3**: counts per quote, **then graduation exclusions**. |
| OHLC build | Prefer aggregating **`selected`** pools only when building candles for that mint/quote (or configurable override). |

Wick filtering + `filterCandlesByCloseOpenGap` remains available for **smoothing plotted bars**, not for redefining **`selected`**.

---

## 7. Swap quotes pipeline

| Step | Behaviour |
|------|-----------|
| Resolve pools | **`vetted-markets(tokenMint [, quoteMint])`**. |
| Request build | Vybe **`POST /v4/trading/swap`** already supports **`poolAddress`** — pin to a **`selected`** pool when enforcing this policy. |

If **`selected`** is empty after counts, fallback policy is product-owned (relax constraint vs error).

---

## 7.1 Token details / last price (`GET /v4/tokens/{mint}`)

Vybe **`GET /v4/tokens/{mintAddress}`** exposes **`price`**, **`volume24h`**, etc. Proxied by **`GET /api/tokens/:mint`** in **`solana-quote-swap-api`**.

| Step | Behaviour |
|------|-----------|
| Market universe | **`price`** (and aggregates derived from trading) should use pools in the **`selected`** set from **Sections 4.1–4.3**, matching **candles** and **swap quotes** parity. |
| Gap today | Consumers report **`price`** effectively tied to upstream market selection that may **still include** excluded venues (thin pools, bonded curve pool post-graduation, etc.). **Align** aggregator rules or overlays with **`vetted-markets`**. |

This is distinct from **`GET /api/tokens/:mint/candles`** (OHLC resolution, `vettedMarketsOnly`).

---

## 8. Engineering checklist

- [ ] Extract **`selectMarketsByTradeCounts`** (pure): inputs = list `{ marketAddress, totalCount }`; output = preliminary **`selected`** per **Sections 4.1–4.2** only.  
- [ ] Unit tests from **fabricated counts**: `N > 10` edges (top-five cut, **500 vs 50** flip at `topMarketCount = 499` vs **500**, **49** failing top-five bar).  
- [ ] Unit tests **`2 ≤ N ≤ 10`** (10% vs **maxCount**, **`min`** 10 **trades**).  
- [ ] **`applyLaunchpadGraduationOverrides(selected, graduationStore)`** — strips **legacy bonding** venues after **`graduated`**, irrespective of dominance by **`totalTradeCount`** or Sections **4.1–4.2** tiers.  
- [ ] **`GET /api/vetted-markets`** wired to Vybe trades + graduation store + selector.  
- [ ] **`GET /api/tokens/:mint`** (**Vybe **`/v4/tokens/{mint}`**): **`price`** / spot aggregates constrained to **`selected`** pools—or documented fallback if upstream Vybe aggregates cannot be narrowed yet.  
- [ ] Separate optional module for **OHLC-from-trades wick trimming** — must not redefine **`selected`** vs **Sections 4.1–4.3**.

---

## 9. Risks & open questions

| Risk | Mitigation |
|------|------------|
| Thin **top five** still passes with **49** trades when **`topMarketCount`** is under **500** | Documented behaviour; tighten **floor** externally if ops require it. |
| **Pagination** biases counts | Prefer full window or capped “first N pages” semantics in API docs. |
| Incorrect **graduation** signal | False positives orphan **fresh** bonding pools or starve successors — needs reconciliation window + alerting. |

**Open**

1. **`vetted-markets`**: expose **counts only** (`selected=false`) alongside boolean, or **`selected`** only?  
2. Multi-hop swaps: **`vetted-markets`** keyed per **leg mint**?  
3. Source of truth for **`graduated`**: indexer contract, Vybe field, cron scan — **ownership**?

---

## 10. Appendix — OHLC hygiene (same script; **does not drive `selected`**)

When **filter wicks** is **on**, the UI may **exclude trades**, **adjust candles**, etc. **`selected`** in **`vetted-markets`** stays defined by **Sections 4.1–4.3** only (**counts + graduation**).

*(Document revision **7**.)*
