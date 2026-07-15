#!/usr/bin/env npx tsx
/**
 * Smoke test: wallet holdings from internal assets API (internal-debug).
 */
import { ASSETS_API_BASE } from '../src/config.js';
import { getOwnerAssets } from '../src/api/owner-assets.js';
import {
  fetchWalletBalancesFromAssets,
  streamWalletTokenBalances,
} from '../src/api/wallet-balance.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const wallet = process.env.TEST_WALLET?.trim() || '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';
  console.log(`ASSETS_API_BASE=${ASSETS_API_BASE}`);
  console.log(`wallet=${wallet}`);

  const assets = await getOwnerAssets(wallet);
  assert(assets.holdings.length > 0, 'assets holdings empty');
  const sample = assets.holdings.find((h) => h.price > 0) ?? assets.holdings[0];
  console.log('✓ assets sample holding:', JSON.stringify(sample, null, 2));

  const { items } = await fetchWalletBalancesFromAssets(wallet, 50);
  assert(items.length > 0, 'mapped list empty');
  const localLogos = items.filter((i) => i.logoUrl?.startsWith('/cached/') || i.logoUrl?.startsWith('/data/'));
  const priced = items.filter((i) => i.valueUsd > 0);
  const unpriced = items.filter((i) => !(i.valueUsd > 0) && i.amountUi > 0);
  console.log(
    `✓ mapped ${items.length} tokens (priced=${priced.length}, unpriced=${unpriced.length}, localLogos=${localLogos.length})`,
  );
  console.log('  first:', {
    mint: items[0]?.mintAddress,
    symbol: items[0]?.symbol,
    amountUi: items[0]?.amountUi,
    valueUsd: items[0]?.valueUsd,
    logoUrl: items[0]?.logoUrl,
  });

  let updates = 0;
  await streamWalletTokenBalances(undefined, wallet, 50, (ev) => {
    if (ev.event === 'initial') {
      console.log(`  stream initial: ${ev.tokens.length} tokens`);
    } else if (ev.event === 'update') {
      updates += 1;
    }
  });
  assert(updates === 0, 'server stream should not emit enrichment updates');
  console.log('✓ stream complete (assets only, no enrich updates)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
