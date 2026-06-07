# Solana Swap API (Vybe Trading)

Try the live demo: **https://solana-swap-api.vybenetwork.com**

Reference implementation and starter kit for **swap quote** and **unsigned swap transaction** flows on Solana using the [Vybe Trading API](https://docs.vybenetwork.com/docs/swap-overview).

**[Try the LIVE demo →](https://solana-swap-api.vybenetwork.com)**

**[Get your free Vybe API key →](https://vybenetwork.com/pricing)**

**[Vybe swap docs →](https://docs.vybenetwork.com/docs/swap-overview)**

---

## What This Repo Provides

- **Swap quote proxy** — `GET /api/trading/swap-quote` → Vybe `GET /v4/trading/swap-quote` (Jupiter / Titan UI: quote then immediate swap build)
- **Vybe quote flow** — `POST /api/trading/vybe-quote` → token spot prices + `POST /v4/trading/swap` with `router=vybe`
- **Token price resolve** — `POST /api/tokens/resolve-prices` — cache-first price stats (`price`, `price1d`, `price7d`) for pair cards; 5s TTL, first quote fetches full details
- **Swap build proxy** — `POST /api/trading/swap` → Vybe `POST /v4/trading/swap`
- **Token metadata** — `GET /api/token/:mint` (Vybe token details including price fields, disk cache)
- **Token symbol lookup** — `GET /api/token-symbol/:mint` and `POST /api/token-symbols` (Metaplex + Vybe fallback, disk cache)
- **Web UI** — single-page swap widget: sell/buy mints, amount, slippage, router (Vybe / Jupiter / Titan), 24h/7d pair cards, route diagram, and base64 unsigned transaction output

The UI does **not** broadcast transactions. Copy the base64 payload and sign in your wallet.

---

## Prerequisites

- **Node.js** ≥ 20 (LTS recommended)
- **npm** ≥ 10 (or equivalent)

## Quick Start

```bash
git clone https://github.com/vybenetwork/solana-swap-api.git
cd solana-swap-api
npm install
cp .env.example .env
# Edit .env and set VYBE_API_KEY=your_api_key_here
npm start
```

Then open **http://localhost:3000**, set sell/buy mints and amount, and click **Get quote**. Enter a wallet address and click **Build unsigned transaction** to receive base64.

## Environment Variables

| Variable         | Required | Description                                              | Example                                |
|------------------|----------|----------------------------------------------------------|----------------------------------------|
| `VYBE_API_KEY`   | Yes      | Vybe API key for all Vybe requests                       | `your_api_key_here`                    |
| `SOLANA_RPC_URL` | No       | RPC for Metaplex symbol lookup (`token-symbol` fallback) | `https://api.mainnet-beta.solana.com` |
| `PORT`           | No       | HTTP server port                                         | `3000`                                 |
| `TUNNEL`         | No       | Set to `1` to run behind a Cloudflare Tunnel             | `1`                                    |

Get your API key at [vybenetwork.com/pricing](https://vybenetwork.com/pricing).

---

## SOL balance thresholds

These UI amounts (in SOL) guard wallet balance checks across the server and swap UI. They are not env vars — edit the source constants if you need different limits.

| Constant | Value | Description |
|----------|-------|-------------|
| `SOL_MIN_TX_FEE_BALANCE_UI` | `0.006` | Minimum SOL a wallet should hold when **selling an SPL token** (non-gasless). Below this, the UI warns to enable **Gasless** or deposit more SOL for transaction fees and possible ATA rent. Defined in `src/config.ts`; used by `src/api/trade-sol-warning.ts`. |
| `SOL_WALLET_MIN_RESERVE_UI` | `0.006` | SOL left in the wallet when **selling native/wrapped SOL** — covers rent + fees so the account stays funded after the swap. Max sell = total SOL minus this reserve. Defined in `src/api/wallet-balance.ts` and `src/frontend/token-picker.ts`. |
| `SOL_MIN_TRADABLE_TOTAL_UI` | `0.0061` | Minimum **total** SOL (native + wSOL) required before a SOL sell is allowed. Set to reserve (`0.006`) plus `0.0001` so at least a tiny amount remains tradable after the reserve. Enforced server-side in `wallet-balance.ts` and in the token picker max-amount logic. |
| `SOL_MIN_AUTO_PICK_TOTAL_UI` | `0.0065` | Minimum total SOL to **auto-select SOL** as the sell token when loading wallet balances. Wallets below this prefer USDC/USDT (or the next largest holding) instead. Used in `src/frontend/app.ts` and `token-picker.ts`. |

---

## Frontend Overview

The swap UI lives in `src/frontend/app.ts` and compiles to `public/app.js` via `npm run build:frontend` (run automatically by `npm start`).

### Swap widget

- **Sell / Buy** — input and output mint addresses with symbol pills (SOL, BONK, etc.)
- **Amount** — UI units for the sell side; buy side updates from the quote
- **Wallet & execution** — signer address, slippage %, router select
- **Swap build parameters** — gasless, auto slippage, simulate, partner, pool, protocol, service fee (sent on build only)
- **Quote response & route** — route diagram, per-hop `swapInfo`, and top-level quote fields

### Build flow

1. **Get quote**
   - **Vybe router** — requires connected wallet; resolves token prices, builds via `POST /api/trading/vybe-quote`, synthesizes quote + route. Built transaction is cached for **45 seconds**.
   - **Jupiter / Titan** — requires wallet address; `GET /api/trading/swap-quote` then immediately `POST /api/trading/swap` with the quote `routePlan`. UI is populated from the **swap build response** (fees, route enrichment, tx). Cached tx reused on Build Swap when params unchanged.
2. **Build unsigned transaction** — reuses cached tx when within cache window; otherwise refetches (Vybe: `vybe-quote`, Jupiter/Titan: quote + swap again)
3. Copy base64 from the result and sign locally

---

## Server Proxy Routes

The Express server in `src/server.ts` exposes:

| Route | Description |
|-------|-------------|
| `GET /api/trading/swap-quote` | Query: `amount`, `inputMintAddress`, `outputMintAddress`, optional `accountAddress`, `slippage` (Jupiter / Titan: first step before swap build) |
| `POST /api/trading/vybe-quote` | JSON: same fields as swap build + optional `tokenHints`, `forceFullDetailsMints`, `router=vybe`. Returns synthesized quote, `_build`, `_builtAt`, `_tokenStats` |
| `POST /api/tokens/resolve-prices` | JSON: `mints[]`, optional `tokenHints`, `forceFullDetailsMints`. Returns `{ stats: { [mint]: { price, price1d, price7d, decimals, priceFetchedAt } } }` |
| `POST /api/trading/swap` | JSON: `accountAddress`, `amount`, `inputMintAddress`, `outputMintAddress`, optional `slippage`, `router` (`vybe` \| `jupiter` \| `titan`), `gasless`, `autoCalculateSlippage`, `simulate`, `partner`, `poolAddress`, `protocol`, `swapFee` |
| `GET /api/token/:mint` | Token metadata + spot price fields (`price`, `price1d`, `price7d`); cached in `data/token-meta-cache.json` |
| `GET /api/token-symbol/:mint` | Resolves token symbol; cached in `data/symbol-cache.json` |
| `POST /api/token-symbols` | Batch symbol lookup |
| `GET /api/health` | Health check |

Vybe API docs:

- [Swap quote](https://docs.vybenetwork.com/reference/get_swap_quote_proxy)
- [Build swap](https://docs.vybenetwork.com/docs/swap-overview)

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

Open **http://localhost:3000**.

### 5. (Optional) Run with Cloudflare Tunnel

```bash
TUNNEL=1 npm start
```

The console prints a **Cloudflare Tunnel URL** when supported.

---

## Project Structure

```text
solana-swap-api/
├── .env.example           # Copy to .env; set VYBE_API_KEY
├── package.json
├── public/                # Web GUI (HTML, CSS; app.js built from src/frontend)
│   ├── index.html
│   └── app.css
└── src/
    ├── server.ts          # Express server; swap + symbol proxies
    ├── config.ts          # Env loading, PUBLIC_DIR
    ├── cache.ts           # On-disk symbol cache (data/)
    ├── api/
    │   ├── index.ts       # createClient(apiKey)
    │   ├── client.ts      # HTTP client, error formatting
    │   ├── swap-quote.ts  # GET /v4/trading/swap-quote
    │   ├── swap-build.ts  # POST /v4/trading/swap
    │   ├── tokens.ts      # GET /v4/tokens/{mint} (symbol fallback)
    │   └── token-symbol.ts
    ├── types/
    │   ├── api.ts
    │   └── swap.ts
    └── frontend/
        └── app.ts         # Swap UI → public/app.js
```

---

## Direct API Usage Example

```typescript
const base = 'http://localhost:3000';

// Quote
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
  }),
});
const { transaction } = await buildRes.json();
console.log('base64 length', transaction?.length);
```

---

## Troubleshooting

| Issue                         | What to do |
|-------------------------------|-----------|
| **403 Forbidden**             | Verify `VYBE_API_KEY` in `.env`. If the key works locally but not on a server, it may be IP-restricted — contact Vybe to allow your server IP. |
| **Slow responses / timeouts** | Vybe requests use retries and a 60s timeout. Retry later if the API is under load. |
| **Missing env vars**          | Copy `.env.example` to `.env` and set `VYBE_API_KEY`. Look for `VYBE_API_KEY loaded` in server logs on start. |
| **Build fails without wallet**| `accountAddress` is required for `POST /api/trading/swap`. Get a quote first so mints and amount match. |

---

## Support

- **Telegram:** [Vybe community](https://t.me/vybenetwork)
- **Support ticket:** [Submit a ticket via vybenetwork.com](https://vybenetwork.com)
