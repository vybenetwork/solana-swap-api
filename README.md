# Solana Swap API

<p align="center">

[![Swap guides](https://img.shields.io/badge/Guides-Swap%20overview-3b82f6?style=for-the-badge)](https://docs.vybenetwork.com/docs/swap-overview)
[![Swap quote API](https://img.shields.io/badge/Endpoint-Swap%20quote-6366f1?style=for-the-badge)](https://docs.vybenetwork.com/reference/get_swap_quote_proxy)
[![Build swap API](https://img.shields.io/badge/Endpoint-Build%20swap-8b5cf6?style=for-the-badge)](https://docs.vybenetwork.com/reference/do_swap_proxy)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github)](https://github.com/vybenetwork/solana-swap-api)
[![Telegram](https://img.shields.io/badge/Telegram-VybeNetwork-26A5E4?style=for-the-badge&logo=telegram)](https://t.me/VybeNetwork_Official)
[![X](https://img.shields.io/badge/X-Vybe__Network-000000?style=for-the-badge&logo=x)](https://x.com/Vybe_Network)

</p>

**Solana Swap API:** This repository demonstrates how to use the Vybe Solana swap API to fetch DEX quotes, compare Vybe/Jupiter/Titan routes, and build unsigned swap transactions for any SPL or Token-2022 token. Use this project as a reference implementation or starter kit for building Solana swap UIs, wallet integrations, and on-chain trading apps.

It includes a production-ready Node.js backend and a modern frontend that integrate Vybe’s swap quote, swap build, token price, and wallet balance endpoints—explore multi-hop route diagrams, per-hop fee breakdowns, and base64 unsigned transactions ready for wallet signing.

Try the live demo: https://solana-swap-api.vybenetwork.com

![Solana Swap API Repo](screenshots/solana-swap-api-repo.png)

---

**[Try the LIVE demo →](https://solana-swap-api.vybenetwork.com)**

**[Get your free Vybe API key →](https://vybe.fyi/api-pricing)**

**[Vybe swap overview →](https://docs.vybenetwork.com/docs/swap-overview)** · **[Swap quote endpoint →](https://docs.vybenetwork.com/reference/get_swap_quote_proxy)** · **[Build swap endpoint →](https://docs.vybenetwork.com/reference/do_swap_proxy)** · **[GitHub repo →](https://github.com/vybenetwork/solana-swap-api)** · **[Telegram →](https://t.me/VybeNetwork_Official)** · **[X →](https://x.com/Vybe_Network)**

---

## Prerequisites

- **Node.js** ≥ 20 (LTS recommended)
- **npm** ≥ 10 (or equivalent)

## Quick Start

Get from clone to running app in a few commands:

```bash
git clone https://github.com/vybenetwork/solana-swap-api.git
cd solana-swap-api
npm install
cp .env.example .env
# Edit .env and set VYBE_API_KEY=your_api_key_here
npm start
```

Then open **http://localhost:3000**, set sell/buy mints and amount, connect a wallet (or paste an address), and click **Get quote**. Use **Build unsigned transaction** or **Build & sign swap** depending on mode.

## Environment Variables

| Variable         | Required | Description                                              | Example                                |
|------------------|----------|----------------------------------------------------------|----------------------------------------|
| `VYBE_DATA_API_KEY`   | Yes*     | Key for wallets, tokens, trades (`VYBE_DATA_API_BASE`)   | `your_api_key_here`                    |
| `VYBE_API_KEY`        | No       | Key for swap quote/build (`VYBE_API_BASE`); empty OK local | `your_api_key_here`                  |
| `VYBE_API_BASE`       | No       | Trading API (swap quote/build); local Rust/proxy for dev | `https://api.vybenetwork.xyz`          |
| `VYBE_DATA_API_BASE`  | No       | Wallets, tokens, trades (defaults prod when trading local)| `https://api.vybenetwork.xyz`         |
| `HELIUS_API_KEY`      | No       | Helius RPC key (used when `SOLANA_RPC_URL` unset)        | `your_helius_key`                      |
| `SOLANA_RPC_URL` | No       | Full RPC URL override (wins over `HELIUS_API_KEY`)       | `https://api.mainnet-beta.solana.com` |
| `PORT`           | No       | HTTP server port                                         | `3000`                                 |
| `TUNNEL`         | No       | Set to `1` to run behind a Cloudflare Tunnel             | `1`                                    |

Get your API keys at `https://vybe.fyi/api-pricing`.

\* `VYBE_DATA_API_KEY` is required unless `VYBE_API_KEY` is set (used as fallback for data endpoints).

---

## What This Repo Provides

- **Swap quote and build proxy**
  - Express server that proxies Vybe:
    - `GET /v4/trading/swap-quote` (Jupiter / Titan quote path)
    - `POST /v4/trading/swap` (build unsigned swap transaction)
    - `GET /v4/tokens/{mintAddress}` (token metadata + price fields)
    - Wallet balance and sell-balance checks via Vybe wallet APIs
- **Vybe quote + build flow**
  - `POST /api/trading/vybe-quote` resolves token prices, builds via Vybe router, and synthesizes a full quote + route plan in one call.
  - Built transaction cached for **45 seconds** when params unchanged.
- **Swap web UI**
  - Single-page GUI (no frameworks) built from `src/frontend/` into `public/app.js`.
  - Lets you quote, compare routes, inspect fees, and build or sign swap transactions for any SPL or Token-2022 pair.
- **Three execution modes**
  - **Build & Sign** (default) — quote, build, refresh blockhash, sign in Phantom-compatible wallet.
  - **Build only** — quote + build; copy base64 unsigned transaction.
  - **Paste & Sign** — paste existing base64 tx, refresh blockhash, sign in wallet.
- **Three router options**
  - **Vybe** — native Vybe routing with optional fallback to Jupiter or Titan.
  - **Jupiter** — quote via `swap-quote`, then immediate swap build.
  - **Titan** — same aggregator flow as Jupiter through Vybe proxy.
- **Route visualization and fee accounting**
  - Multi-hop route diagram with per-hop fee branches (protocol, pool, acc rent, priority).
  - Route plan steps with IN / pre-fees output / NET tiles and **Paid from wallet** / **Deducted from pool** fee tables.
  - Hop % badges aligned between diagram and accordion headers.
- **Wallet-aware token picker**
  - Jupiter token catalog search + connected wallet holdings.
  - 25 / 50 / 100% sell shortcuts, SOL reserve guards, low-SOL warnings for SPL sells.
- **Token price pair cards**
  - 24h / 7d price change for sell and buy mints via `POST /api/tokens/resolve-prices`.

The server does **not** broadcast transactions. **Build & Sign** and **Paste & Sign** may send only from the user’s browser wallet after explicit confirmation.

All of this uses Vybe’s production swap routing across Raydium, Orca, Meteora, Pump.fun, and other Solana DEX aggregators via Vybe, Jupiter, and Titan.

---

### Solana API docs for these endpoints

- **Swap overview (guides)**:
  - [https://docs.vybenetwork.com/docs/swap-overview](https://docs.vybenetwork.com/docs/swap-overview)
- **Swap quote (`GET /v4/trading/swap-quote`)**:
  - [https://docs.vybenetwork.com/reference/get_swap_quote_proxy](https://docs.vybenetwork.com/reference/get_swap_quote_proxy)
- **Build swap (`POST /v4/trading/swap`)**:
  - [https://docs.vybenetwork.com/reference/do_swap_proxy](https://docs.vybenetwork.com/reference/do_swap_proxy)
- **Token details (`GET /v4/tokens/{mintAddress}`)**:
  - [https://docs.vybenetwork.com/reference/get_token_details_v4](https://docs.vybenetwork.com/reference/get_token_details_v4)

---

## Why Swap Quote & Build APIs Matter

Swap quote and transaction build APIs are critical for:

- **Trading UIs**: show expected output, price impact, slippage, and min receive before the user signs.
- **Route transparency**: visualize multi-hop paths and every fee debited from wallet or pool.
- **Wallet integrations**: return base64 unsigned transactions for Phantom, Solflare, and other signers.
- **Aggregator choice**: compare Vybe-native routing vs Jupiter or Titan through one proxy.
- **Production safety**: simulate swaps, enrich route fees from build responses, and refresh blockhash before sign.

This repo shows how to build a **practical swap explorer and builder** on top of Vybe’s quote and swap endpoints.

---

## Frontend Overview (Swap UI)

The swap UI is implemented in `src/frontend/` and compiled to `public/app.js` via `npm start` (which runs `npm run build:frontend` first).

| File | Role |
|------|------|
| `app.ts` | Swap widget, quote/build flows, wallet connect, mode switching |
| `route-ui.ts` | Route diagram, route plan steps, hop % badges, fee accounting |
| `token-picker.ts` | Token search, wallet balances, icons, sell-amount helpers |

### Sections

- **Wallet & execution**
  - Signer address input, Phantom-compatible **Connect wallet**, total USD balance chip, disconnect.
  - Router switch: Vybe / Jupiter / Titan with optional Vybe → Jupiter/Titan fallback.
  - Slippage, gasless, auto slippage, simulate, partner, pool, protocol, service fee (sent on build).

- **Sell / Buy sides**
  - Token picker (catalog + wallet holdings), amount input, flip button, 25/50/100% sell shortcuts.
  - Live USD estimates and 24h / 7d pair cards for both mints.

- **Quote response & route panel**
  - Quote summary, route diagram, collapsible **Route plan steps**, **Top-level API fields**, raw quote/swap JSON.
  - After **Get quote**, **Route plan steps** opens automatically if another panel was expanded.
  - Quote details accordions: only one panel open at a time.

- **Route diagram**
  - Input/output pills, per-hop DEX nodes, fee branches, hop retention % badges on rail links.

- **Route plan steps**
  - Accordion hops with IN / pre-fees output / NET tiles.
  - Fee groups: **Paid from wallet**, **Deducted from pool** with recipient addresses and USD amounts.
  - Single-hop routes stay expanded; multi-hop allows one open hop at a time.

- **Build result**
  - Base64 unsigned transaction textarea + copy (Build only).
  - Build & Sign calls `POST /api/solana/prepare-swap-tx` before signing so Phantom can simulate balance changes.

### Execution modes

| Mode | Quote | Build | Sign | Broadcast |
|------|-------|-------|------|-----------|
| **Build & Sign** (default) | Yes | Yes | In-browser wallet | Optional (wallet sends) |
| **Build only** | Yes | Yes | No | No |
| **Paste & Sign** | No | No (paste base64) | In-browser wallet | Optional (wallet sends) |

### Quote & build workflow

1. **Get quote**
   - **Vybe** — `POST /api/trading/vybe-quote` resolves prices, builds swap, synthesizes quote + enriched route.
   - **Jupiter / Titan** — `GET /api/trading/swap-quote` then `POST /api/trading/swap` with the quote `routePlan`.
   - Cached tx reused on **Build Swap** when params unchanged (45s window for Vybe).
2. **Build / sign** — reuses cached tx within cache window; otherwise refetches.
3. **Copy base64** (Build only) or sign/send in wallet (Build & Sign / Paste & Sign).

---

## SOL Balance Thresholds

These UI amounts (in SOL) guard wallet balance checks. They are not env vars — edit source constants if you need different limits.

| Constant | Value | Description |
|----------|-------|-------------|
| `SOL_MIN_TX_FEE_BALANCE_UI` | `0.006` | Minimum SOL when **selling an SPL token** (non-gasless). Warns to enable **Gasless** or deposit more SOL. |
| `SOL_WALLET_MIN_RESERVE_UI` | `0.006` | SOL reserve when **selling native/wrapped SOL** — max sell = total minus reserve. |
| `SOL_MIN_TRADABLE_TOTAL_UI` | `0.0061` | Minimum total SOL before a SOL sell is allowed. |
| `SOL_MIN_AUTO_PICK_TOTAL_UI` | `0.0065` | Minimum total SOL to auto-select SOL as sell token when loading wallet balances. |

Defined in `src/config.ts`, `src/api/wallet-balance.ts`, `src/api/trade-sol-warning.ts`, and `src/frontend/token-picker.ts`.

---

## Server Proxy Routes

The Express server in `src/server.ts` exposes:

- **`GET /api/trading/swap-quote`**
  - Proxies to Vybe `GET /v4/trading/swap-quote` with query params: `amount`, `inputMintAddress`, `outputMintAddress`, optional `accountAddress`, `slippage`.
- **`POST /api/trading/vybe-quote`**
  - Resolves token prices + builds via Vybe router. Returns synthesized quote, `_build`, `_builtAt`, `_tokenStats`.
- **`POST /api/trading/swap`**
  - Proxies to Vybe `POST /v4/trading/swap` with JSON body: `accountAddress`, `amount`, mints, optional `slippage`, `router` (`vybe` \| `jupiter` \| `titan`), `gasless`, `autoCalculateSlippage`, `simulate`, `partner`, `poolAddress`, `protocol`, `swapFee`.
- **`POST /api/tokens/resolve-prices`**
  - Cache-first price stats (`price`, `price1d`, `price7d`) for pair cards.
- **`GET /api/token/:mint`**
  - Proxies to Vybe `GET /v4/tokens/{mintAddress}`; cached in `data/token-meta-cache.json`.
- **`GET /api/token-symbol/:mint`**
  - Resolves symbol via Metaplex and/or Vybe; cached in `data/symbol-cache.json`.
- **`POST /api/token-symbols`**
  - Batch symbol lookup for multiple mints.
- **`GET /api/wallets/:ownerAddress/token-balances`**
  - Wallet SPL holdings for token picker (`limit`, default 50, max 100).
- **`GET /api/wallets/:ownerAddress/sell-balance-check`**
  - Query: `mint`, `amount`, optional `symbol` — verify sell amount before quote.
- **`GET /api/wallets/:ownerAddress/low-sol-trade-warning`**
  - Query: `inputMint`, optional `outputMint`, `gasless` — SPL sell SOL warning.
- **`POST /api/solana/rpc`**
  - Proxy JSON-RPC to `SOLANA_RPC_URL` (browser Connection).
- **`GET /api/solana/latest-blockhash`**
  - Fresh blockhash for wallet simulation.
- **`POST /api/solana/prepare-swap-tx`**
  - JSON: `{ tx }` base64 — refresh blockhash + resolve ALTs before sign.
- **`GET /api/health`**
  - Health check `{ ok: true }`.
- **`GET /cached/token-icons/*`**
  - Cached token icon assets.

All Vybe requests use a shared client (`src/api/client.ts`) with timeouts, retries, and human-readable errors (`toHumanReadableError`). Symbol and token-meta caches are JSON files in `data/`.

---

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Build frontend + run Express server (`tsx src/server.ts`) |
| `npm run dev` | Same as start |
| `npm run build` | Compile server TypeScript → `dist/` |
| `npm run build:frontend` | Bundle `src/frontend/` → `public/app.js` |
| `npm run typecheck` | Server typecheck |
| `npm run typecheck:frontend` | Frontend typecheck |
| `npm run fetch:catalog` | Fetch Jupiter token catalog for picker |
| `npm run download:token-icons` | Download token icons into cache |

---

## How to Run

### 1. Clone the repository

```bash
git clone https://github.com/vybenetwork/solana-swap-api.git
cd solana-swap-api
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set your API key

```bash
cp .env.example .env
# Add your VYBE_API_KEY to .env
```

### 4. Run the server + web app

```bash
npm start
```

Then open **http://localhost:3000**. The UI shows **swap quote and route** data for any SPL or Token-2022 pair: choose router (Vybe, Jupiter, or Titan), enter sell/buy mints and amount, connect a wallet, and click **Get quote**. Inspect the route diagram and fee breakdown, then **Build unsigned transaction** or **Build & sign swap**.

### 5. (Optional) Run with Cloudflare Tunnel

To expose the app on a public URL (e.g. for sharing or testing from another device), you can enable a tunnel (requires `cloudflared` installed):

```bash
TUNNEL=1 npm start
```

The console will print a **Cloudflare Tunnel URL** if supported.

---

## Project Structure

```text
solana-swap-api/
├── .env.example           # Copy to .env — VYBE_API_KEY, optional HELIUS_API_KEY / SOLANA_RPC_URL
├── package.json           # Scripts and pinned dependencies
├── README.md
├── screenshots/           # Screenshots referenced in this README
├── data/                  # Disk caches (symbol, token meta)
├── public/                # Web GUI (HTML, CSS, built JS)
│   ├── index.html
│   ├── app.css
│   ├── app.js             # Generated by `npm run build:frontend` from src/frontend/
│   └── images/            # Router logos (Jupiter, Titan)
├── tools/
│   ├── bundle-frontend.mjs
│   ├── fetch-jupiter-token-catalog.mjs
│   └── download-token-icons.mjs
└── src/
    ├── server.ts          # Express server; proxies Vybe API and serves public/
    ├── config.ts          # Env loading, API base URL, timeouts, SOL thresholds
    ├── cache.ts           # On-disk symbol cache in data/
    ├── token-icon-cache.ts
    ├── types/
    │   ├── api.ts
    │   └── swap.ts
    ├── api/
    │   ├── index.ts       # createClient(apiKey) — wires all API methods
    │   ├── client.ts      # HTTP client, retries, human-readable errors
    │   ├── swap-quote.ts  # GET /v4/trading/swap-quote
    │   ├── swap-build.ts  # POST /v4/trading/swap
    │   ├── vybe-swap-quote.ts
    │   ├── enrich-route-fees.ts
    │   ├── simulate-swap-output.ts
    │   ├── resolve-token-prices.ts
    │   ├── wallet-balance.ts
    │   ├── trade-sol-warning.ts
    │   ├── solana-prepare-swap-tx.ts
    │   ├── token-symbol.ts
    │   └── tokens.ts
    └── frontend/
        ├── app.ts         # Swap UI (quote, build, wallet, modes) → public/app.js
        ├── route-ui.ts    # Route diagram + plan steps + fee accounting
        └── token-picker.ts# Token search + wallet balances
```

---

## Direct API Usage Example

If you want to bypass the UI and fetch quotes / build swaps through the local proxy:

```typescript
const base = 'http://localhost:3000';

// Quote (Jupiter / Titan path)
const quoteParams = new URLSearchParams({
  amount: '0.05',
  inputMintAddress: 'So11111111111111111111111111111111111111112',
  outputMintAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  slippage: '0.5',
});
const quoteRes = await fetch(`${base}/api/trading/swap-quote?${quoteParams}`);
const quote = await quoteRes.json();
console.log('outAmountUi', quote.outAmountUi);

// Build unsigned transaction
const buildRes = await fetch(`${base}/api/trading/swap`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    accountAddress: 'YOUR_WALLET_PUBKEY',
    amount: 0.05,
    inputMintAddress: 'So11111111111111111111111111111111111111112',
    outputMintAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    slippage: 0.5,
    router: 'vybe',
    simulate: true,
  }),
});
const { transaction } = await buildRes.json();
console.log('base64 length', transaction?.length);
```

Or call Vybe directly:

```typescript
import axios from 'axios';

const API = 'https://api.vybenetwork.xyz';
const headers = { 'X-API-KEY': process.env.VYBE_API_KEY!, Accept: 'application/json' };

async function fetchSwapQuote(inputMint: string, outputMint: string, amount: number) {
  const { data } = await axios.get(`${API}/v4/trading/swap-quote`, {
    params: {
      amount,
      inputMintAddress: inputMint,
      outputMintAddress: outputMint,
      slippage: 0.5,
    },
    headers,
  });
  return data;
}

async function buildSwapTx(
  accountAddress: string,
  inputMint: string,
  outputMint: string,
  amount: number,
  routePlan: unknown[],
) {
  const { data } = await axios.post(
    `${API}/v4/trading/swap`,
    {
      accountAddress,
      amount,
      inputMintAddress: inputMint,
      outputMintAddress: outputMint,
      slippage: 0.5,
      router: 'vybe',
      routePlan,
      simulate: true,
    },
    { headers },
  );
  return data.transaction as string;
}
```

---

## Troubleshooting

| Issue | What to do |
|-------|------------|
| **403 Forbidden** | Verify `VYBE_API_KEY` in `.env` is correct and has access to swap quote and build endpoints. If the key works locally but not on a server, it may be IP-restricted — contact Vybe to allow your server IP. |
| **Slow responses / timeouts** | The app uses a 60s timeout for Vybe requests and retries. If the API is under load, you may see timeouts; check Vybe status or retry later. |
| **Missing env vars** | Ensure you copied `.env.example` to `.env` and set `VYBE_API_KEY`. |
| **Build fails without wallet** | `accountAddress` is required for swap build routes. Get a quote first so mints and amount match. |
| **Phantom simulation / balance changes** | Use **Build & Sign** so the UI calls `prepare-swap-tx` before signing. |
| **Low SOL warning on SPL sell** | Enable **Gasless** or keep ≥ ~0.006 SOL for fees/rent (see thresholds above). |

---

## Support

- **Telegram:** [VybeNetwork Official](https://t.me/VybeNetwork_Official)
- **X:** [@Vybe_Network](https://x.com/Vybe_Network)
- **GitHub:** [solana-swap-api](https://github.com/vybenetwork/solana-swap-api)
- **Support ticket:** [Submit a ticket via vybenetwork.com](https://vybenetwork.com)
