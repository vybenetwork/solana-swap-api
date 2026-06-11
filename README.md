# Solana Swap API

**Live demo:** [https://solana-swap-api.vybenetwork.com](https://solana-swap-api.vybenetwork.com)

**Solana Swap API** is a reference implementation and starter kit for **swap quote** and **unsigned swap transaction** flows on Solana using the [Vybe Trading API](https://docs.vybenetwork.com/docs/swap-overview). It includes a production-style Express proxy, wallet-aware swap UI, multi-hop route visualization, and support for **Vybe**, **Jupiter**, and **Titan** routers.

**[Try the live demo →](https://solana-swap-api.vybenetwork.com)**

**[Get your free Vybe API key →](https://vybenetwork.com/pricing)**

**[Vybe swap docs →](https://docs.vybenetwork.com/docs/swap-overview)**

---

## What This Repo Provides

### API proxy (Express)

- **Swap quote** — `GET /api/trading/swap-quote` → Vybe `GET /v4/trading/swap-quote` (Jupiter / Titan: first step before swap build)
- **Vybe quote + build** — `POST /api/trading/vybe-quote` → token price resolve + `POST /v4/trading/swap` with `router=vybe`; returns synthesized quote, route plan, `_build`, `_builtAt`, `_tokenStats`
- **Swap build** — `POST /api/trading/swap` → Vybe `POST /v4/trading/swap` with optional simulation and per-hop fee enrichment
- **Token prices** — `POST /api/tokens/resolve-prices` — cache-first stats (`price`, `price1d`, `price7d`) for pair cards
- **Token metadata** — `GET /api/token/:mint` (Vybe token details; disk cache in `data/token-meta-cache.json`)
- **Token symbols** — `GET /api/token-symbol/:mint` and `POST /api/token-symbols` (Metaplex + Vybe fallback; `data/symbol-cache.json`)
- **Wallet helpers** — token balances, sell-balance check, low-SOL trade warning for SPL sells
- **Solana RPC helpers** — JSON-RPC proxy, latest blockhash, and `prepare-swap-tx` (refresh blockhash + ALTs before wallet sign)
- **Token icons** — served from `/cached/token-icons` (local cache)

### Web UI

Single-page swap widget with:

- **Sell / Buy** token picker (Jupiter catalog + wallet holdings), amount, flip, 25/50/100% sell shortcuts
- **Router switch** — Vybe / Jupiter / Titan, with optional Vybe → Jupiter/Titan fallback
- **Wallet connect** — Phantom-compatible provider; connect, total USD balance chip, disconnect
- **Execution modes** — **Build & Sign**, **Build only**, **Paste & Sign**
- **Pair cards** — 24h / 7d price change for sell and buy mints
- **Route diagram** — multi-hop visual flow with per-hop fee branches (protocol, pool, acc rent, priority)
- **Quote details panel** — summary, route diagram, collapsible **Route plan steps** (per-hop amounts + fee tables), **Top-level API fields**, raw quote/swap JSON
- **Swap build options** — slippage, gasless, auto slippage, simulate, partner, pool, protocol, service fee
- **Unsigned tx output** — base64 textarea + copy (Build only). **Build & Sign** and **Paste & Sign** refresh blockhash, sign in-wallet, and may broadcast via the connected wallet.

The server does **not** broadcast transactions. **Build & Sign** / **Paste & Sign** send only from the user’s browser wallet after explicit confirmation.

---

## Prerequisites

- **Node.js** ≥ 20 (LTS recommended)
- **npm** ≥ 10 (or equivalent)
- **Vybe API key** — [vybenetwork.com/pricing](https://vybenetwork.com/pricing)

## Quick Start

```bash
git clone https://github.com/vybenetwork/solana-swap-api.git
cd solana-swap-api
npm install
cp .env.example .env
# Edit .env and set VYBE_API_KEY=your_api_key_here
npm start
```

Then open **http://localhost:3000**, set sell/buy mints and amount, connect a wallet (or paste an address), and click **Get quote**. Use **Build unsigned transaction** or **Build & sign swap** depending on mode.

---

## Environment Variables

| Variable         | Required | Description                                              | Example                                |
|------------------|----------|----------------------------------------------------------|----------------------------------------|
| `VYBE_API_KEY`   | Yes      | Vybe API key for all Vybe requests                       | `your_api_key_here`                    |
| `SOLANA_RPC_URL` | No       | RPC for wallet balance checks, blockhash, tx prepare     | `https://api.mainnet-beta.solana.com` |
| `PORT`           | No       | HTTP server port                                         | `3000`                                 |
| `TUNNEL`         | No       | Set to `1` to run behind a Cloudflare Tunnel             | `1`                                    |

---

## SOL Balance Thresholds

These UI amounts (in SOL) guard wallet balance checks across the server and swap UI. They are not env vars — edit the source constants if you need different limits.

| Constant | Value | Description |
|----------|-------|-------------|
| `SOL_MIN_TX_FEE_BALANCE_UI` | `0.006` | Minimum SOL when **selling an SPL token** (non-gasless). Below this, the UI warns to enable **Gasless** or deposit more SOL. `src/config.ts`, `src/api/trade-sol-warning.ts`. |
| `SOL_WALLET_MIN_RESERVE_UI` | `0.006` | SOL reserve when **selling native/wrapped SOL** — max sell = total SOL minus this. `src/api/wallet-balance.ts`, `src/frontend/token-picker.ts`. |
| `SOL_MIN_TRADABLE_TOTAL_UI` | `0.0061` | Minimum total SOL (native + wSOL) before a SOL sell is allowed. `wallet-balance.ts`, token picker. |
| `SOL_MIN_AUTO_PICK_TOTAL_UI` | `0.0065` | Minimum total SOL to **auto-select SOL** as sell token when loading wallet balances. `src/frontend/app.ts`, `token-picker.ts`. |

---

## Frontend Overview

Source: `src/frontend/` → bundled to `public/app.js` via `npm run build:frontend` (runs automatically on `npm start`).

| File | Role |
|------|------|
| `app.ts` | Swap widget, quote/build flows, wallet connect, mode switching |
| `route-ui.ts` | Route diagram, route plan steps, hop % badges, fee accounting |
| `token-picker.ts` | Token search, wallet balances, icons, sell-amount helpers |

### Execution modes

| Mode | Quote | Build | Sign | Broadcast |
|------|-------|-------|------|-----------|
| **Build & Sign** (default) | Yes | Yes | In-browser wallet | Optional (wallet sends) |
| **Build only** | Yes | Yes | No | No |
| **Paste & Sign** | No | No (paste base64) | In-browser wallet | Optional (wallet sends) |

### Quote & build flow

1. **Get quote**
   - **Vybe** — requires wallet address; `POST /api/trading/vybe-quote` resolves prices, builds swap, synthesizes quote + enriched route. Built tx cached **45 seconds**.
   - **Jupiter / Titan** — `GET /api/trading/swap-quote` then `POST /api/trading/swap` with the quote `routePlan`. UI populated from swap build (fees, route enrichment, tx). Cached tx reused when params unchanged.
   - After quote, **Route plan steps** opens automatically if another panel was expanded.
2. **Build / sign** — reuses cached tx within cache window; otherwise refetches. **Build & Sign** calls `POST /api/solana/prepare-swap-tx` before signing so Phantom can simulate balance changes.
3. **Copy base64** (Build only) or sign/send in wallet (Build & Sign / Paste & Sign).

### Route & fees UI

- **Route diagram** — input/output pills, per-hop DEX nodes, fee branches, cumulative % badges on links
- **Route plan steps** — accordion hops with IN / pre-fees output / NET tiles; fee groups (**Paid from wallet**, **Deducted from pool**); hop header % badges aligned with diagram retention math
- **Quote details accordions** — only one panel open at a time; open panel summary is not clickable until another panel is selected

---

## Server Proxy Routes

| Route | Description |
|-------|-------------|
| `GET /api/trading/swap-quote` | Query: `amount`, `inputMintAddress`, `outputMintAddress`, optional `accountAddress`, `slippage` |
| `POST /api/trading/vybe-quote` | JSON: swap fields + optional `tokenHints`, `forceFullDetailsMints`, `router=vybe`. Returns quote, `_build`, `_builtAt`, `_tokenStats` |
| `POST /api/trading/swap` | JSON: `accountAddress`, `amount`, mints, optional `slippage`, `router` (`vybe` \| `jupiter` \| `titan`), `gasless`, `autoCalculateSlippage`, `simulate`, `partner`, `poolAddress`, `protocol`, `swapFee` |
| `POST /api/tokens/resolve-prices` | JSON: `mints[]`, optional `tokenHints`, `forceFullDetailsMints` → `{ stats: { [mint]: { price, price1d, price7d, … } } }` |
| `GET /api/token/:mint` | Token metadata + price fields (disk cache) |
| `GET /api/token-symbol/:mint` | Resolve symbol (disk cache) |
| `POST /api/token-symbols` | Batch symbol lookup |
| `GET /api/wallets/:ownerAddress/token-balances` | Wallet SPL holdings for token picker (`limit`, default 50, max 100) |
| `GET /api/wallets/:ownerAddress/sell-balance-check` | Query: `mint`, `amount`, optional `symbol` — verify sell amount |
| `GET /api/wallets/:ownerAddress/low-sol-trade-warning` | Query: `inputMint`, optional `outputMint`, `gasless` — SPL sell SOL warning |
| `POST /api/solana/rpc` | Proxy JSON-RPC to `SOLANA_RPC_URL` (browser Connection) |
| `GET /api/solana/latest-blockhash` | Fresh blockhash for wallet simulation |
| `POST /api/solana/prepare-swap-tx` | JSON: `{ tx }` base64 — refresh blockhash + resolve ALTs before sign |
| `GET /api/health` | `{ ok: true }` |
| `GET /cached/token-icons/*` | Cached token icon assets |

Vybe API docs:

- [Swap quote](https://docs.vybenetwork.com/reference/get_swap_quote_proxy)
- [Build swap](https://docs.vybenetwork.com/docs/swap-overview)

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

### Local

```bash
git clone https://github.com/vybenetwork/solana-swap-api.git
cd solana-swap-api
npm install
cp .env.example .env
# Add VYBE_API_KEY to .env
npm start
```

Open **http://localhost:3000**.

### Cloudflare Tunnel (optional)

```bash
TUNNEL=1 npm start
```

The console prints a **Cloudflare Tunnel URL** when supported.

---

## Project Structure

```text
solana-swap-api/
├── .env.example
├── package.json
├── data/                      # Disk caches (symbol, token meta, icons)
├── public/                    # Static UI (HTML, CSS; app.js built from src/frontend)
│   ├── index.html
│   ├── app.css
│   └── app.js                 # Generated — do not edit directly
├── tools/
│   ├── bundle-frontend.mjs
│   ├── fetch-jupiter-token-catalog.mjs
│   └── download-token-icons.mjs
└── src/
    ├── server.ts              # Express routes
    ├── config.ts              # Env, RPC URL, SOL thresholds
    ├── cache.ts               # Symbol cache I/O
    ├── token-icon-cache.ts
    ├── api/
    │   ├── client.ts          # Vybe HTTP client
    │   ├── swap-quote.ts
    │   ├── swap-build.ts
    │   ├── vybe-swap-quote.ts
    │   ├── enrich-route-fees.ts
    │   ├── simulate-swap-output.ts
    │   ├── resolve-token-prices.ts
    │   ├── wallet-balance.ts
    │   ├── trade-sol-warning.ts
    │   ├── solana-prepare-swap-tx.ts
    │   ├── token-symbol.ts
    │   └── tokens.ts
    ├── types/
    │   ├── api.ts
    │   └── swap.ts
    └── frontend/
        ├── app.ts             # Main swap UI
        ├── route-ui.ts        # Route diagram + plan steps
        └── token-picker.ts    # Token search + wallet balances
```

---

## Direct API Usage Example

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

---

## Troubleshooting

| Issue | What to do |
|-------|------------|
| **403 Forbidden** | Verify `VYBE_API_KEY` in `.env`. If the key works locally but not on a server, it may be IP-restricted — contact Vybe to allow your server IP. |
| **Slow responses / timeouts** | Vybe requests use retries and a 60s timeout. Retry later if the API is under load. |
| **Missing env vars** | Copy `.env.example` to `.env` and set `VYBE_API_KEY`. |
| **Build fails without wallet** | `accountAddress` is required for swap build routes. Get a quote first so mints and amount match. |
| **Phantom simulation / balance changes** | Use **Build & Sign** so the UI calls `prepare-swap-tx` before signing. |
| **Low SOL warning on SPL sell** | Enable **Gasless** or keep ≥ ~0.006 SOL for fees/rent (see thresholds above). |

---

## Support

- **Telegram:** [Vybe community](https://t.me/vybenetwork)
- **Support ticket:** [Submit a ticket via vybenetwork.com](https://vybenetwork.com)
