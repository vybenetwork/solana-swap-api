#!/usr/bin/env npx tsx
/**
 * Smoke test: Jupiter fallback + RPC mint decimals for wallet enrichment.
 */
import { fetchJupiterAsset, fetchJupiterQuotePriceUsd } from '../src/api/jupiter-token-fallback.js';
import { fetchMintDecimalsFromRpc } from '../src/api/mint-decimals-rpc.js';
import { createDataHttpClient } from '../src/api/client.js';
import { getDataApiKey, getSolanaRpcProviderLabel } from '../src/config.js';
import { listWalletTokenBalances } from '../src/api/wallet-balance.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
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

  const usdcPrice = await fetchJupiterQuotePriceUsd(USDC, 6);
  assert(usdcPrice === 1, `USDC price expected 1, got ${usdcPrice}`);
  console.log('✓ Jupiter quote USDC price', usdcPrice);

  const wsolPrice = await fetchJupiterQuotePriceUsd(WSOL, 9);
  assert(wsolPrice != null && wsolPrice > 1, `WSOL price out of range: ${wsolPrice}`);
  console.log('✓ Jupiter quote WSOL price', wsolPrice);

  const chainDec = await fetchMintDecimalsFromRpc(USDC);
  assert(chainDec === 6, `RPC mint decimals expected 6, got ${chainDec}`);
  console.log('✓ RPC mint decimals USDC', chainDec);

  const obscureAsset = await fetchJupiterAsset(OBSCURE);
  if (obscureAsset) {
    console.log('✓ Jupiter asset obscure', obscureAsset.symbol, 'decimals', obscureAsset.decimals);
    const dec = obscureAsset.decimals ?? (await fetchMintDecimalsFromRpc(OBSCURE));
    if (dec != null) {
      const price = await fetchJupiterQuotePriceUsd(OBSCURE, dec);
      console.log('✓ Jupiter quote obscure price', price ?? '(no route)');
    }
  } else {
    console.log('○ Obscure mint not in Jupiter datapi — testing RPC decimals only');
    const dec = await fetchMintDecimalsFromRpc(OBSCURE);
    console.log('  RPC decimals', dec);
  }

  console.log('\nAll wallet RPC enrichment checks passed.');

  const wallet = process.env.TEST_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
  const http = createDataHttpClient(getDataApiKey());
  const balances = await listWalletTokenBalances(http, wallet, 30);
  assert(balances.length > 0, 'wallet balance list empty');
  const withMeta = balances.filter((b) => b.logoUrl || b.valueUsd > 0);
  console.log(`\n✓ listWalletTokenBalances(${wallet.slice(0, 8)}…) → ${balances.length} tokens, ${withMeta.length} with logo or USD value`);
  for (const b of balances.slice(0, 5)) {
    console.log(
      `  ${b.symbol.padEnd(8)} ${b.amountUi.toPrecision(6)}  $${b.valueUsd.toFixed(2)}  ${b.logoUrl ? 'icon' : 'no-icon'}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
