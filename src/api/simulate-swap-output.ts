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
import type { VybeRoutePlanStep } from '../types/swap.js';

type TokenBalanceEntry = {
  accountIndex?: number;
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string };
};

const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** Typical SPL token account rent (lamports). */
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
/** Minimum system account rent (lamports). */
const MIN_ACCOUNT_RENT_LAMPORTS = 890_880n;
const RENT_UPPER_SLACK = 100_000n;

export interface TokenAccRentEntry {
  mint: string;
  lamports: bigint;
}

export interface SwapSimulationResult {
  outputDeltaRaw: string | null;
  /** SOL lamports deposited into newly created accounts (e.g. aggregator fee PDAs). */
  pdaRentLamports: bigint;
  /** Rent split by mint for newly created wallet token accounts. */
  tokenAccRentByMint: TokenAccRentEntry[];
  /** LP pool fees embedded in non-last hops when Jupiter omits feeAmount. */
  embeddedPoolFeesByHop: EmbeddedPoolFeeEntry[];
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

function extractWalletNativeSolDeltaLamports(
  preBalances: number[] | undefined,
  postBalances: number[] | undefined,
  accountKeyStrings: string[],
  ownerAddress: string,
): bigint | null {
  if (!preBalances?.length || !postBalances?.length) return null;
  const owner = ownerAddress.trim();
  let delta = 0n;
  let found = false;

  const tryIndex = (idx: number) => {
    if (idx < 0 || idx >= preBalances.length || idx >= postBalances.length) return;
    const d = BigInt(postBalances[idx] ?? 0) - BigInt(preBalances[idx] ?? 0);
    if (idx === 0 || accountKeyStrings[idx] === owner) {
      delta = d;
      found = true;
    }
  };

  tryIndex(0);
  for (let idx = 0; idx < accountKeyStrings.length; idx++) {
    if (accountKeyStrings[idx] === owner) tryIndex(idx);
  }

  return found ? delta : null;
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
  preBalances?: number[] | undefined,
  postBalances?: number[] | undefined,
  accountKeyStrings?: string[],
): string | null {
  if (isSolMint(outputMint) && preBalances?.length && postBalances?.length && accountKeyStrings?.length) {
    const nativeDelta = extractWalletNativeSolDeltaLamports(
      preBalances,
      postBalances,
      accountKeyStrings,
      ownerAddress,
    );
    if (nativeDelta != null && nativeDelta > 0n) return nativeDelta.toString();
  }

  const postEntry = post?.find((b) => b.owner === ownerAddress && b.mint === outputMint);
  if (!postEntry?.uiTokenAmount?.amount) return null;

  const postAmt = BigInt(postEntry.uiTokenAmount.amount);
  const preEntry = pre?.find((b) => b.owner === ownerAddress && b.mint === outputMint);
  const preAmt = preEntry?.uiTokenAmount?.amount ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
  const delta = postAmt - preAmt;
  if (delta <= 0n) return null;
  return delta.toString();
}

export interface EmbeddedPoolFeeEntry {
  hopIndex: number;
  amountRaw: string;
  mint: string;
}

function mintMatchesPoolFee(a: string | undefined, b: string | undefined): boolean {
  const left = a?.trim() ?? '';
  const right = b?.trim() ?? '';
  if (!left || !right) return false;
  return left === right || (isSolMint(left) && isSolMint(right));
}

function poolOwnerMatchesHop(owner: string | undefined, ammKey: string | undefined): boolean {
  if (!owner || !ammKey) return false;
  return owner.trim() === ammKey.trim();
}

function sumPoolTokenDelta(
  mint: string,
  preTokenBalances: TokenBalanceEntry[],
  postTokenBalances: TokenBalanceEntry[],
  ownerAddress: string,
  opts: { ammKey?: string; outflow: boolean },
): bigint {
  let total = 0n;
  for (const post of postTokenBalances) {
    const idx = post.accountIndex;
    const postMint = post.mint?.trim();
    if (idx == null || !postMint || !mintMatchesPoolFee(postMint, mint)) continue;
    if (post.owner === ownerAddress) continue;
    if (opts.ammKey && !poolOwnerMatchesHop(post.owner, opts.ammKey)) continue;

    const pre = preTokenBalances.find((b) => b.accountIndex === idx);
    const postAmt = BigInt(post.uiTokenAmount?.amount ?? '0');
    const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? '0');
    const delta = postAmt - preAmt;
    if (opts.outflow && delta < 0n) total += -delta;
    if (!opts.outflow && delta > 0n) total += delta;
  }
  return total;
}

function inferEmbeddedPoolFeeRaw(
  poolPaidOut: bigint,
  hopOut: bigint,
  nextIn: bigint,
): bigint {
  if (poolPaidOut <= 0n) return 0n;
  if (poolPaidOut > hopOut) return poolPaidOut - hopOut;
  if (hopOut > poolPaidOut) return hopOut - poolPaidOut;
  if (nextIn > 0n && poolPaidOut > nextIn) return poolPaidOut - nextIn;
  return 0n;
}

function detectEmbeddedPoolFeeForHop(
  hop: VybeRoutePlanStep,
  nextHop: VybeRoutePlanStep | undefined,
  preTokenBalances: TokenBalanceEntry[],
  postTokenBalances: TokenBalanceEntry[],
  ownerAddress: string,
): { amountRaw: bigint; mint: string } | null {
  if (hop.swapInfo?.feeAmount && hop.swapInfo.feeAmount !== '0') return null;

  const outMint = hop.swapInfo?.outputMintAddress?.trim();
  const inMint = hop.swapInfo?.inputMintAddress?.trim();
  const outRaw = hop.swapInfo?.outAmount?.trim();
  const inRaw = hop.swapInfo?.inAmount?.trim();
  if (!outMint || !outRaw || !/^\d+$/.test(outRaw)) return null;

  const ammKey = hop.swapInfo?.ammKey?.trim();
  const hopOut = BigInt(outRaw);
  let nextIn = 0n;
  const nextInRaw = nextHop?.swapInfo?.inAmount?.trim();
  if (nextInRaw && /^\d+$/.test(nextInRaw)) {
    try {
      nextIn = BigInt(nextInRaw);
    } catch {
      nextIn = 0n;
    }
  }

  for (const scoped of ammKey ? [true, false] : [false]) {
    const poolPaidOut = sumPoolTokenDelta(outMint, preTokenBalances, postTokenBalances, ownerAddress, {
      ammKey: scoped ? ammKey : undefined,
      outflow: true,
    });
    const feeRaw = inferEmbeddedPoolFeeRaw(poolPaidOut, hopOut, nextIn);
    if (feeRaw > 0n) {
      return {
        amountRaw: feeRaw,
        mint: isSolMint(outMint) ? WSOL_MINT : outMint,
      };
    }
  }

  if (ammKey && inMint && inRaw && /^\d+$/.test(inRaw)) {
    const hopIn = BigInt(inRaw);
    const poolReceivedIn = sumPoolTokenDelta(
      inMint,
      preTokenBalances,
      postTokenBalances,
      ownerAddress,
      { ammKey, outflow: false },
    );
    if (poolReceivedIn > hopIn) {
      return { amountRaw: poolReceivedIn - hopIn, mint: inMint };
    }
  }

  return null;
}

function detectEmbeddedPoolFeesByHop(
  routePlan: VybeRoutePlanStep[],
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  postTokenBalances: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
): EmbeddedPoolFeeEntry[] {
  if (!routePlan.length || !preTokenBalances?.length || !postTokenBalances?.length) return [];
  const owner = ownerAddress.trim();
  const lastIdx = routePlan.length - 1;
  const entries: EmbeddedPoolFeeEntry[] = [];

  for (let i = 0; i < lastIdx; i++) {
    const detected = detectEmbeddedPoolFeeForHop(
      routePlan[i]!,
      routePlan[i + 1],
      preTokenBalances,
      postTokenBalances,
      owner,
    );
    if (detected && detected.amountRaw > 0n) {
      entries.push({
        hopIndex: i,
        amountRaw: detected.amountRaw.toString(),
        mint: detected.mint,
      });
    }
  }

  return entries;
}

function isRentSizedDeposit(pre: bigint, post: bigint): boolean {
  if (post <= pre) return false;
  const deposit = post - pre;
  return (
    (deposit >= TOKEN_ACCOUNT_RENT_LAMPORTS - 1_000n &&
      deposit <= TOKEN_ACCOUNT_RENT_LAMPORTS + RENT_UPPER_SLACK) ||
    (deposit >= MIN_ACCOUNT_RENT_LAMPORTS - 1_000n &&
      deposit <= MIN_ACCOUNT_RENT_LAMPORTS + RENT_UPPER_SLACK)
  );
}

function isLikelyRentDeposit(pre: bigint, post: bigint): boolean {
  if (pre !== 0n || post <= 0n) return false;
  return isRentSizedDeposit(pre, post);
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

function detectNewOwnerTokenMints(
  pre: TokenBalanceEntry[] | null | undefined,
  post: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
): string[] {
  const owner = ownerAddress.trim();
  const preMints = new Set<string>();
  for (const b of pre ?? []) {
    const m = b.mint?.trim();
    if (b.owner === owner && m) preMints.add(m);
  }
  const newMints: string[] = [];
  for (const b of post ?? []) {
    const m = b.mint?.trim();
    if (b.owner === owner && m && !preMints.has(m)) newMints.push(m);
  }
  return newMints;
}

function detectAtaCreationRentByMint(
  prepared: VersionedTransaction,
  accountKeyStrings: string[],
  preBalances: number[] | undefined,
  postBalances: number[] | undefined,
  ownerAddress: string,
): TokenAccRentEntry[] {
  if (!preBalances?.length || !postBalances?.length) return [];
  const owner = ownerAddress.trim();
  const entries: TokenAccRentEntry[] = [];

  for (const ix of prepared.message.compiledInstructions) {
    const programId = accountKeyStrings[ix.programIdIndex];
    if (programId !== ATA_PROGRAM_ID) continue;
    const kind = ix.data[0];
    if (kind !== 0 && kind !== 1) continue;

    const payerIdx = ix.accountKeyIndexes[0];
    const ataIdx = ix.accountKeyIndexes[1];
    const walletIdx = ix.accountKeyIndexes[2];
    const mintIdx = ix.accountKeyIndexes[3];
    if (payerIdx == null || ataIdx == null || mintIdx == null) continue;

    const payer = accountKeyStrings[payerIdx];
    const wallet = walletIdx != null ? accountKeyStrings[walletIdx] : payer;
    if (payer !== owner && wallet !== owner) continue;

    const mint = accountKeyStrings[mintIdx]?.trim();
    if (!mint) continue;

    const pre = BigInt(preBalances[ataIdx] ?? 0);
    const post = BigInt(postBalances[ataIdx] ?? 0);
    if (!isRentSizedDeposit(pre, post)) continue;

    entries.push({ mint, lamports: post - pre });
  }

  return entries;
}

function mergeTokenAccRentEntries(entries: TokenAccRentEntry[]): TokenAccRentEntry[] {
  const byMint = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.lamports <= 0n) continue;
    const mint = entry.mint.trim();
    byMint.set(mint, (byMint.get(mint) ?? 0n) + entry.lamports);
  }
  return [...byMint.entries()].map(([mint, lamports]) => ({ mint, lamports }));
}

function detectTokenAccRentByMint(
  prepared: VersionedTransaction,
  accountKeyStrings: string[],
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  postTokenBalances: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  preBalances: number[] | undefined,
  postBalances: number[] | undefined,
): TokenAccRentEntry[] {
  const fromAtaIx = detectAtaCreationRentByMint(
    prepared,
    accountKeyStrings,
    preBalances,
    postBalances,
    ownerAddress,
  );
  if (fromAtaIx.length > 0) return mergeTokenAccRentEntries(fromAtaIx);

  const newMints = detectNewOwnerTokenMints(preTokenBalances, postTokenBalances, ownerAddress);
  if (newMints.length === 0) return [];

  const totalRent = detectPdaRentLamports(preBalances, postBalances);
  if (totalRent <= 0n) {
    return newMints.map((mint) => ({ mint, lamports: TOKEN_ACCOUNT_RENT_LAMPORTS }));
  }

  const perMint = totalRent / BigInt(newMints.length);
  const remainder = totalRent % BigInt(newMints.length);
  return newMints.map((mint, i) => ({
    mint,
    lamports: perMint + (i === newMints.length - 1 ? remainder : 0n),
  }));
}

/** Returns simulation effects, or null values if simulation fails. */
export async function simulateSwapEffects(
  base64Tx: string,
  ownerAddress: string,
  outputMint: string,
  inputMint?: string,
  routePlan?: VybeRoutePlanStep[],
): Promise<SwapSimulationResult> {
  const empty: SwapSimulationResult = {
    outputDeltaRaw: null,
    pdaRentLamports: 0n,
    tokenAccRentByMint: [],
    embeddedPoolFeesByHop: [],
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

  const tokenAccRentByMint = detectTokenAccRentByMint(
    prepared,
    accountKeyStrings,
    value.preTokenBalances,
    value.postTokenBalances,
    ownerAddress.trim(),
    value.preBalances,
    value.postBalances,
  );

  const embeddedPoolFeesByHop =
    routePlan?.length
      ? detectEmbeddedPoolFeesByHop(
          routePlan,
          value.preTokenBalances,
          value.postTokenBalances,
          ownerAddress.trim(),
        )
      : [];

  return {
    outputDeltaRaw: extractWalletOutputDeltaRaw(
      value.preTokenBalances,
      value.postTokenBalances,
      ownerAddress.trim(),
      outputMint.trim(),
      value.preBalances,
      value.postBalances,
      accountKeyStrings,
    ),
    pdaRentLamports: detectPdaRentLamports(value.preBalances, value.postBalances),
    tokenAccRentByMint,
    embeddedPoolFeesByHop,
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
