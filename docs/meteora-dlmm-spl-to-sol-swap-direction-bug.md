# Meteora DLMM: SPL → SOL swap direction bug (ix-builder)

**Component:** ix-builder `src/services/meteora-dlmm.js`  
**Severity:** High — SPL → SOL builds fail on-chain or show ~25k–43k SOL output  
**Status:** Fixed locally in ix-builder (pending deploy)  
**Workaround (swap-api):** Route via Trades sim-rejects bad DLMM builds and falls back to Raydium CLMM  

## Summary

Meteora DLMM pinned swaps used inverted `swapYtoX` direction:

```javascript
// WRONG — breaks SPL → SOL when token X is the SPL (e.g. BONK) and Y is WSOL
const swapYtoX = inputMint === tokenYMint;

// CORRECT — Meteora SDK: swapYtoX=true when spending token X
const swapYtoX = inputMint === tokenXMint;
```

## Symptoms

| Direction | Old behavior | Expected |
|-----------|--------------|----------|
| SOL → SPL | Worked | ~151k BONK for 0.01 SOL |
| SPL → USDC | Worked (no WSOL leg) | Normal USDC out |
| SPL → SOL | **Broken** | ~0.018 SOL for ~285k BONK |
| SPL → SOL (bad build) | `outAmount` ~4.3e13 lamports (~43k SOL UI) | ~1.8e7 lamports (~0.018 SOL) |
| On-chain sim | `ExceededAmountSlippageTolerance (6003)` | Success |

## Reproduction

Pool: `6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp` (BONK/WSOL Meteora DLMM)  
Wallet: `7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza`  
Amount: `28497303456` raw BONK (5 decimals)

SDK quote with wrong direction (`swapYtoX=false`): **43035 SOL**  
SDK quote with correct direction (`swapYtoX=true`): **0.0188 SOL**

Raydium CLMM on same pair (`ysq96dVZ…`): **0.01815 SOL**, sim OK.

## Fix (ix-builder)

File: `ix-builder-api-main-nodejs/src/services/meteora-dlmm.js`

1. `swapYtoX = inputMint === tokenXMint` (not `tokenYMint`)
2. Use `swapQuote.binArraysPubkey` for instruction bin accounts (exact set from quote)

## Note on naming

Raydium uses **CLMM** (Concentrated Liquidity). **Meteora DLMM** is a separate program (`LBUZKhRx…`). Raydium CLMM SDK was already correct for SPL → SOL; this bug was Meteora DLMM only.

## Deploy

After ix-builder deploy, swap-api can keep simulation gating as defense-in-depth or allow Meteora DLMM when sim passes.
