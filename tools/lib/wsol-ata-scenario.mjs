/**
 * On-chain WSOL ATA scenario setup for 7Tar wallet benchmarks.
 * Requires PROTOCOL_CHECK_WALLET_SECRET (bs58) matching CATALOG_FILTER_WALLET / 7Tar.
 */
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { WSOL_MINT } from './ix-builder-programs.mjs';
import { WALLET } from './swap-api-quote-lib.mjs';

const EXPECTED_WALLET = '7Tar8QZTrRPwoGY5Ke9Vfwf6CmpBfekrNofERxgReza';

function heliusOrRpcUrl() {
  const explicit = (process.env.SOLANA_RPC_URL ?? '').trim();
  if (explicit) return explicit;
  const key = (process.env.HELIUS_API_KEY ?? '').trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return 'https://api.mainnet-beta.solana.com';
}

export function loadBenchmarkWalletKeypair() {
  const secret = (process.env.PROTOCOL_CHECK_WALLET_SECRET ?? '').trim();
  if (!secret) {
    throw new Error(
      'PROTOCOL_CHECK_WALLET_SECRET unset — needed to open/fund/close WSOL ATA on-chain for WSOL scenarios',
    );
  }
  const kp = Keypair.fromSecretKey(bs58.decode(secret));
  const pub = kp.publicKey.toBase58();
  const expected = (process.env.CATALOG_FILTER_WALLET ?? '').trim() || WALLET || EXPECTED_WALLET;
  if (pub !== expected) {
    throw new Error(`PROTOCOL_CHECK_WALLET_SECRET pubkey ${pub} !== expected wallet ${expected}`);
  }
  return kp;
}

export function createBenchmarkConnection() {
  return new Connection(heliusOrRpcUrl(), 'confirmed');
}

export async function readWsolState(conn, owner) {
  const ata = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info) {
    return { exists: false, ata: ata.toBase58(), amountExact: '0' };
  }
  try {
    const acct = await getAccount(conn, ata, 'confirmed', TOKEN_PROGRAM_ID);
    return {
      exists: true,
      ata: ata.toBase58(),
      amountExact: acct.amount.toString(),
    };
  } catch {
    return { exists: true, ata: ata.toBase58(), amountExact: '?' };
  }
}

async function sendIxs(conn, kp, ixs, label) {
  if (!ixs.length) return null;
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`    on-chain WSOL ${label}: ${sig}`);
  return sig;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntilWsolGone(conn, owner, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const state = await readWsolState(conn, owner);
    if (!state.exists) return state;
    await sleep(400);
  }
  return readWsolState(conn, owner);
}

/**
 * Force wallet WSOL ATA into the requested scenario on-chain.
 * funded — ATA exists with ~fundedUi SOL wrapped
 * zero   — ATA exists with 0 balance
 * absent — ATA closed / does not exist
 */
export async function ensureOnChainWsolScenario(conn, kp, scenario, fundedUi = 0.01) {
  const owner = kp.publicKey;
  const ata = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  let state = await readWsolState(conn, owner);
  console.log(
    `    on-chain WSOL before: exists=${state.exists} amountExact=${state.amountExact} ata=${state.ata}`,
  );

  // Leave chain alone — use whatever WSOL ATA state the wallet already has.
  if (scenario.key === 'current') {
    console.log(
      `    on-chain WSOL after:  exists=${state.exists} amountExact=${state.amountExact} (unchanged)`,
    );
    return state;
  }

  const target =
    scenario.key === 'funded'
      ? BigInt(Math.round(Number(fundedUi) * 1e9))
      : scenario.key === 'zero'
        ? 0n
        : null; // absent

  if (scenario.key === 'absent') {
    if (state.exists) {
      await sendIxs(
        conn,
        kp,
        [createCloseAccountInstruction(ata, owner, owner, [], TOKEN_PROGRAM_ID)],
        'close→absent',
      );
      state = await waitUntilWsolGone(conn, owner);
    }
  } else {
    // Need ATA present at exact target lamports (wrapped).
    if (state.exists && state.amountExact !== '?' && BigInt(state.amountExact) !== target) {
      await sendIxs(
        conn,
        kp,
        [createCloseAccountInstruction(ata, owner, owner, [], TOKEN_PROGRAM_ID)],
        'close→reset',
      );
      state = await waitUntilWsolGone(conn, owner);
    }

    if (!state.exists) {
      const ixs = [
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ata,
          owner,
          NATIVE_MINT,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ];
      if (target > 0n) {
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: ata,
            lamports: Number(target),
          }),
          createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
        );
      }
      await sendIxs(
        conn,
        kp,
        ixs,
        scenario.key === 'zero' ? 'create@0' : `create+wrap@${fundedUi}`,
      );
    } else if (target > 0n && BigInt(state.amountExact) === 0n) {
      await sendIxs(
        conn,
        kp,
        [
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: ata,
            lamports: Number(target),
          }),
          createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
        ],
        `wrap@${fundedUi}`,
      );
    }
  }

  // Confirm final state (retry briefly for RPC lag).
  for (let i = 0; i < 10; i++) {
    state = await readWsolState(conn, owner);
    const ok =
      scenario.key === 'absent'
        ? !state.exists
        : state.exists && state.amountExact === String(target);
    if (ok) break;
    await sleep(400);
  }

  const ok =
    scenario.key === 'absent'
      ? !state.exists
      : state.exists && state.amountExact === String(target);
  if (!ok) {
    throw new Error(
      `WSOL scenario ${scenario.key} not reached after txs (exists=${state.exists} amountExact=${state.amountExact})`,
    );
  }
  console.log(
    `    on-chain WSOL after:  exists=${state.exists} amountExact=${state.amountExact} ✓`,
  );
  return state;
}

/** Merge on-chain WSOL truth into wallet-API rows so ATA hints match reality if API lags. */
export function mergeWsolStateIntoWalletItems(items, wsolState) {
  const rest = (items || []).filter((i) => String(i.mintAddress ?? '').trim() !== WSOL_MINT);
  if (!wsolState?.exists) return rest;
  return [
    ...rest,
    {
      mintAddress: WSOL_MINT,
      symbol: 'WSOL',
      decimals: 9,
      amountExact: wsolState.amountExact,
      amount: Number(wsolState.amountExact) / 1e9,
    },
  ];
}
