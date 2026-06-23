#!/usr/bin/env npx tsx
/**
 * Smoke test: phased wallet balances (RPC+Vybe parallel, then Jupiter enrichment).
 */
import { fetchJupiterAsset, fetchJupiterQuotePrice } from '../src/api/jupiter-token-fallback.js';
import { createDataHttpClient } from '../src/api/client.js';
import { getDataApiKey, getSolanaRpcProviderLabel } from '../src/config.js';
import {
  mergeWalletBalancesFromRpcAndVybe,
  streamWalletTokenBalances,
  RPC_ONLY_ENRICH_LIMIT,
} from '../src/api/wallet-balance.js';
import { WSOL_MINT } from '../src/api/sol-mints.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
const OBSCURE = process.env.TEST_RPC_ONLY_MINT?.trim() || '9UjwQHUVbJtgdYhBSSpzBF4z9mBwFkBoT2RJroGwwray';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  console.log(`RPC provider: ${getSolanaRpcProviderLabel()}`);

  const usdcAsset = await fetchJupiterAsset(USDC);
  assert(usdcAsset != null && usdcAsset.decimals === 6, 'USDC Jupiter asset');
  console.log('✓ Jupiter asset USDC');

  const wsolQuote = await fetchJupiterQuotePrice(WSOL_MINT, 9);
  assert(wsolQuote?.denom === 'usd' && wsolQuote.priceUsd > 1, 'WSOL quote');
  console.log('✓ Jupiter quote WSOL', wsolQuote);

  const obscureAsset = await fetchJupiterAsset(OBSCURE);
  if (obscureAsset?.decimals != null) {
    const quote = await fetchJupiterQuotePrice(OBSCURE, obscureAsset.decimals);
    console.log('✓ Jupiter quote obscure', quote ?? '(no route)');
  }

  const usd1Quote = await fetchJupiterQuotePrice(USD1, 6);
  assert(usd1Quote?.denom === 'usd' && usd1Quote.priceUsd === 1, 'USD1 quote');
  console.log('✓ Jupiter quote USD1');

  const wallet = process.env.TEST_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
  const http = createDataHttpClient(getDataApiKey());

  const merged = await mergeWalletBalancesFromRpcAndVybe(http, wallet, 50);
  assert(merged.items.length > 0, 'merged list empty');
  assert(
    merged.rpcOnlyToEnrich.length <= RPC_ONLY_ENRICH_LIMIT,
    `rpc-only enrich exceeds ${RPC_ONLY_ENRICH_LIMIT}`,
  );
  const pending = merged.items.filter((i) => i.enrichmentPending);
  console.log(
    `\n✓ merge phase: ${merged.items.length} tokens, ${pending.length} pending enrichment, ${merged.rpcOnlyToEnrich.length} to enrich`,
  );

  let updates = 0;
  await streamWalletTokenBalances(http, wallet, 50, (ev) => {
    if (ev.event === 'initial') {
      console.log(`  stream initial: ${ev.tokens.length} tokens`);
    } else if (ev.event === 'update') {
      updates += 1;
      const t = ev.token;
      console.log(
        `  stream update ${updates}: ${t.symbol} $${t.valueUsd.toFixed(2)}${t.valueSol ? ` / ${t.valueSol.toPrecision(4)} SOL` : ''}`,
      );
    }
  });
  console.log(`✓ stream complete (${updates} RPC-only updates)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
