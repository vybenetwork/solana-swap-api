#!/usr/bin/env npx tsx
/**
 * Smoke test: Jupiter fallback + RPC mint decimals for wallet enrichment.
 */
import { fetchJupiterAsset, fetchJupiterQuotePrice } from '../src/api/jupiter-token-fallback.js';
import { fetchMintDecimalsFromRpc } from '../src/api/mint-decimals-rpc.js';
import { createDataHttpClient } from '../src/api/client.js';
import { getDataApiKey, getSolanaRpcProviderLabel } from '../src/config.js';
import { listWalletTokenBalances } from '../src/api/wallet-balance.js';
import { WSOL_MINT } from '../src/api/sol-mints.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
/** Obscure mint unlikely in Vybe token-details — adjust if needed. */
const OBSCURE = process.env.TEST_RPC_ONLY_MINT?.trim() || '9UjwQHUVbJtgdYhBSSpzBF4z9mBwFkBoT2RJroGwwray';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  console.log(`RPC provider: ${getSolanaRpcProviderLabel()}`);

  const usdcAsset = await fetchJupiterAsset(USDC);
  assert(usdcAsset != null, 'USDC Jupiter asset missing');
  assert(usdcAsset.decimals === 6, `USDC decimals expected 6, got ${usdcAsset.decimals}`);
  assert(Boolean(usdcAsset.logoUrl), 'USDC logoUrl missing');
  console.log('✓ Jupiter asset USDC', usdcAsset.symbol, usdcAsset.logoUrl?.slice(0, 48));

  const usdcQuote = await fetchJupiterQuotePrice(USDC, 6);
  assert(usdcQuote?.denom === 'usd' && usdcQuote.priceUsd === 1, 'USDC quote price expected 1');
  console.log('✓ Jupiter quote USDC', usdcQuote);

  const wsolQuote = await fetchJupiterQuotePrice(WSOL_MINT, 9);
  assert(wsolQuote?.denom === 'usd' && wsolQuote.priceUsd > 1, `WSOL quote out of range: ${JSON.stringify(wsolQuote)}`);
  console.log('✓ Jupiter quote WSOL (via USDC/USD1)', wsolQuote);

  const chainDec = await fetchMintDecimalsFromRpc(USDC);
  assert(chainDec === 6, `RPC mint decimals expected 6, got ${chainDec}`);
  console.log('✓ RPC mint decimals USDC', chainDec);

  const obscureAsset = await fetchJupiterAsset(OBSCURE);
  if (obscureAsset) {
    console.log('✓ Jupiter asset obscure', obscureAsset.symbol, 'decimals', obscureAsset.decimals);
    const dec = obscureAsset.decimals ?? (await fetchMintDecimalsFromRpc(OBSCURE));
    if (dec != null) {
      const quote = await fetchJupiterQuotePrice(OBSCURE, dec);
      console.log('✓ Jupiter quote obscure', quote ?? '(no route)');
    }
  } else {
    console.log('○ Obscure mint not in Jupiter datapi — testing RPC decimals only');
    const dec = await fetchMintDecimalsFromRpc(OBSCURE);
    console.log('  RPC decimals', dec);
  }

  const usd1Quote = await fetchJupiterQuotePrice(USD1, 6);
  assert(usd1Quote?.denom === 'usd' && usd1Quote.priceUsd === 1, 'USD1 quote price expected 1');
  console.log('✓ Jupiter quote USD1', usd1Quote);

  console.log('\nAll wallet RPC enrichment checks passed.');

  const wallet = process.env.TEST_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
  const http = createDataHttpClient(getDataApiKey());
  const balances = await listWalletTokenBalances(http, wallet, 30);
  assert(balances.length > 0, 'wallet balance list empty');
  const withMeta = balances.filter((b) => b.logoUrl || b.valueUsd > 0 || (b.valueSol ?? 0) > 0);
  console.log(`\n✓ listWalletTokenBalances(${wallet.slice(0, 8)}…) → ${balances.length} tokens, ${withMeta.length} with logo or value`);
  for (const b of balances.slice(0, 5)) {
    const val =
      b.valueUsd > 0
        ? `$${b.valueUsd.toFixed(2)}`
        : b.valueSol != null && b.valueSol > 0
          ? `${b.valueSol.toPrecision(4)} SOL`
          : '$0';
    console.log(
      `  ${b.symbol.padEnd(8)} ${b.amountUi.toPrecision(6)}  ${val}  ${b.logoUrl ? 'icon' : 'no-icon'}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
