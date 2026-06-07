/**
 * Simulate a Vybe unsigned swap tx and read wallet output + one-time rent costs.
 * Phantom uses the same simulation for "Estimated balance changes" — often lower than
 * build.details.quote.outAmount when fees are taken on-chain.
 */

import {
  Connection,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';
import { prepareVersionedSwapTransaction } from './prepare-versioned-swap-tx.js';
import { WSOL_MINT, isSolMint } from './sol-mints.js';

type TokenBalanceEntry = {
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string };
};

/** Typical SPL token account rent (lamports). */
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
/** Minimum system account rent (lamports). */
const MIN_ACCOUNT_RENT_LAMPORTS = 890_880n;
const RENT_UPPER_SLACK = 100_000n;

export interface SwapSimulationResult {
  outputDeltaRaw: string | null;
  /** SOL lamports deposited into newly created accounts (e.g. aggregator fee PDAs). */
  pdaRentLamports: bigint;
  /** Total wallet debit for the input leg (swap + input-side fees), in input mint raw units. */
  walletPayDebitRaw: string | null;
}

function isNativeSolInputMint(mint: string): boolean {
  return isSolMint(mint);
}

async function loadAltAccounts(
  connection: Connection,
  prepared: VersionedTransaction,
): Promise<AddressLookupTableAccount[]> {
  const altAccounts: AddressLookupTableAccount[] = [];
  for (const lookup of prepared.message.addressTableLookups) {
    const res = await connection.getAddressLookupTable(lookup.accountKey);
    if (res.value) altAccounts.push(res.value);
  }
  return altAccounts;
}

function listAccountKeyStrings(
  prepared: VersionedTransaction,
  altAccounts: AddressLookupTableAccount[],
): string[] {
  const keys = prepared.message.getAccountKeys(
    altAccounts.length > 0 ? { addressLookupTableAccounts: altAccounts } : undefined,
  );
  const out: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys.get(i);
    if (key) out.push(key.toBase58());
  }
  return out;
}

function extractWalletSolDebitLamports(
  preBalances: number[] | undefined,
  postBalances: number[] | undefined,
  accountKeyStrings: string[],
  ownerAddress: string,
): string | null {
  if (!preBalances?.length || !postBalances?.length) return null;
  const owner = ownerAddress.trim();
  let maxDebit = 0n;

  const tryIndex = (idx: number) => {
    if (idx < 0 || idx >= preBalances.length || idx >= postBalances.length) return;
    const delta = BigInt(postBalances[idx] ?? 0) - BigInt(preBalances[idx] ?? 0);
    if (delta < 0n) {
      const debit = -delta;
      if (debit > maxDebit) maxDebit = debit;
    }
  };

  // Fee payer (index 0) — reliable for Jupiter/Titan v0 txs when ALT key lists misalign.
  tryIndex(0);

  for (let idx = 0; idx < accountKeyStrings.length; idx++) {
    if (accountKeyStrings[idx] === owner) tryIndex(idx);
  }

  return maxDebit > 0n ? maxDebit.toString() : null;
}

function extractWalletSplDebitRaw(
  pre: TokenBalanceEntry[] | null | undefined,
  post: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  mint: string,
): string | null {
  const owner = ownerAddress.trim();
  const postEntry = post?.find((b) => b.owner === owner && b.mint === mint);
  const preEntry = pre?.find((b) => b.owner === owner && b.mint === mint);
  const postAmt = postEntry?.uiTokenAmount?.amount ? BigInt(postEntry.uiTokenAmount.amount) : 0n;
  const preAmt = preEntry?.uiTokenAmount?.amount ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
  const delta = postAmt - preAmt;
  if (delta >= 0n) return null;
  return (-delta).toString();
}

function extractWalletPayDebitRaw(
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  postTokenBalances: TokenBalanceEntry[] | null | undefined,
  preBalances: number[] | undefined,
  postBalances: number[] | undefined,
  accountKeyStrings: string[],
  ownerAddress: string,
  inputMint: string,
): string | null {
  const input = inputMint.trim();
  if (!input) return null;

  if (isNativeSolInputMint(input)) {
    const nativeDebit = extractWalletSolDebitLamports(
      preBalances,
      postBalances,
      accountKeyStrings,
      ownerAddress,
    );
    if (nativeDebit) return nativeDebit;
    const wsolDebit = extractWalletSplDebitRaw(
      preTokenBalances,
      postTokenBalances,
      ownerAddress,
      WSOL_MINT,
    );
    if (wsolDebit) return wsolDebit;
    return null;
  }

  return extractWalletSplDebitRaw(preTokenBalances, postTokenBalances, ownerAddress, input);
}

function extractWalletOutputDeltaRaw(
  pre: TokenBalanceEntry[] | null | undefined,
  post: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  outputMint: string,
): string | null {
  const postEntry = post?.find((b) => b.owner === ownerAddress && b.mint === outputMint);
  if (!postEntry?.uiTokenAmount?.amount) return null;

  const postAmt = BigInt(postEntry.uiTokenAmount.amount);
  const preEntry = pre?.find((b) => b.owner === ownerAddress && b.mint === outputMint);
  const preAmt = preEntry?.uiTokenAmount?.amount ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
  const delta = postAmt - preAmt;
  if (delta <= 0n) return null;
  return delta.toString();
}

function isLikelyRentDeposit(pre: bigint, post: bigint): boolean {
  if (pre !== 0n || post <= 0n) return false;
  return (
    (post >= TOKEN_ACCOUNT_RENT_LAMPORTS - 1_000n &&
      post <= TOKEN_ACCOUNT_RENT_LAMPORTS + RENT_UPPER_SLACK) ||
    (post >= MIN_ACCOUNT_RENT_LAMPORTS - 1_000n && post <= MIN_ACCOUNT_RENT_LAMPORTS + RENT_UPPER_SLACK)
  );
}

function detectPdaRentLamports(preBalances: number[] | undefined, postBalances: number[] | undefined): bigint {
  if (!preBalances?.length || !postBalances?.length) return 0n;
  const len = Math.min(preBalances.length, postBalances.length);
  let rent = 0n;
  for (let i = 0; i < len; i++) {
    const pre = BigInt(preBalances[i] ?? 0);
    const post = BigInt(postBalances[i] ?? 0);
    if (isLikelyRentDeposit(pre, post)) rent += post;
  }
  return rent;
}

/** Returns simulation effects, or null values if simulation fails. */
export async function simulateSwapEffects(
  base64Tx: string,
  ownerAddress: string,
  outputMint: string,
  inputMint?: string,
): Promise<SwapSimulationResult> {
  const empty: SwapSimulationResult = {
    outputDeltaRaw: null,
    pdaRentLamports: 0n,
    walletPayDebitRaw: null,
  };
  const trimmed = base64Tx.trim();
  if (!trimmed || !ownerAddress.trim() || !outputMint.trim()) {
    return empty;
  }

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  let prepared: VersionedTransaction;
  try {
    prepared = await prepareVersionedSwapTransaction(connection, trimmed);
  } catch {
    return empty;
  }

  let sim: Awaited<ReturnType<Connection['simulateTransaction']>>;
  try {
    sim = await connection.simulateTransaction(prepared, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
  } catch {
    return empty;
  }

  const value = sim.value as {
    err: unknown;
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
    preBalances?: number[];
    postBalances?: number[];
  };
  if (value.err) return empty;

  const altAccounts = await loadAltAccounts(connection, prepared);
  const accountKeyStrings = listAccountKeyStrings(prepared, altAccounts);
  const walletPayDebitRaw =
    inputMint?.trim()
      ? extractWalletPayDebitRaw(
          value.preTokenBalances,
          value.postTokenBalances,
          value.preBalances,
          value.postBalances,
          accountKeyStrings,
          ownerAddress.trim(),
          inputMint.trim(),
        )
      : null;

  return {
    outputDeltaRaw: extractWalletOutputDeltaRaw(
      value.preTokenBalances,
      value.postTokenBalances,
      ownerAddress.trim(),
      outputMint.trim(),
    ),
    pdaRentLamports: detectPdaRentLamports(value.preBalances, value.postBalances),
    walletPayDebitRaw,
  };
}

/** Returns raw integer output amount the owner receives, or null if simulation fails. */
export async function simulateSwapOutputRaw(
  base64Tx: string,
  ownerAddress: string,
  outputMint: string,
): Promise<string | null> {
  const { outputDeltaRaw } = await simulateSwapEffects(base64Tx, ownerAddress, outputMint);
  return outputDeltaRaw;
}
