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
import { createSolanaConnection } from './solana-connection.js';
import { findProgramOwnedPoolStateInTx } from './pool-address-validation.js';
import { IX_BUILDER_PROGRAM_IDS } from './route-via-trades.js';
import { prepareVersionedSwapTransactionWithAlts } from './prepare-versioned-swap-tx.js';
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
  /** SPL token account that received rent (from createIdempotent). */
  accountAddress?: string;
  /** True when the account did not exist pre-simulation. */
  createdNew?: boolean;
}

export interface WalletFeeTransferEntry {
  recipientAddress: string;
  amountLamports: bigint;
}

/** Non-wallet token account that received tokens during simulation (fee / LP retention). */
export interface TokenFeeCreditEntry {
  mint: string;
  amountRaw: string;
  ownerAddress: string;
  tokenAccountAddress?: string;
}

export interface InferredHopPoolEntry {
  hopIndex: number;
  poolAddress: string;
}

export interface SwapSimulationResult {
  outputDeltaRaw: string | null;
  /** Set when RPC simulation returns an error (e.g. insufficient input token for fees). */
  simulationErr: unknown | null;
  /** SOL lamports deposited into newly created accounts (e.g. aggregator fee PDAs). */
  pdaRentLamports: bigint;
  /** Rent split by mint for newly created wallet token accounts. */
  tokenAccRentByMint: TokenAccRentEntry[];
  /** LP pool fees embedded in non-last hops when Jupiter omits feeAmount. */
  embeddedPoolFeesByHop: EmbeddedPoolFeeEntry[];
  /** SOL system transfers debited from the wallet (protocol / route fees). */
  walletSolTransfers: WalletFeeTransferEntry[];
  /** Token inflows to non-wallet accounts (fee recipients, pool vaults). */
  tokenFeeCredits: TokenFeeCreditEntry[];
  /** Total wallet debit for the input leg (swap + input-side fees), in input mint raw units. */
  walletPayDebitRaw: string | null;
  /** Network tx fee (base signature fee + compute-budget priority fee), lamports. */
  networkFeeLamports: bigint;
  /** Pool state addresses inferred from token balance deltas (Vybe has no swap-quote ammKey). */
  inferredPoolAddressesByHop: InferredHopPoolEntry[];
  /** Wallet-owned token accounts closed in this transaction. */
  walletTokenAccountCloses: WalletTokenAccountCloseEntry[];
}

export type WalletTokenAccountCloseCategory = 'input' | 'output' | 'wsol' | 'other';

export interface WalletTokenAccountCloseEntry {
  mint: string;
  category: WalletTokenAccountCloseCategory;
  accountAddress?: string;
  /** Token balance in the account immediately before close (raw integer string). */
  preBalanceRaw?: string;
  /** SOL lamports returned to the wallet when the account is closed. */
  reclaimedLamports?: string;
}

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const SPL_TOKEN_PROGRAM_IDS = new Set([SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID]);

function normalizeSimMint(mint: string): string {
  const m = mint.trim();
  return isSolMint(m) ? WSOL_MINT : m;
}

function detectWalletTokenAccountCloses(
  prepared: VersionedTransaction,
  accountKeyStrings: string[],
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  inputMint: string,
  outputMint: string,
  preBalances?: number[],
): WalletTokenAccountCloseEntry[] {
  const owner = ownerAddress.trim();
  if (!owner) return [];

  const mintByAccountIndex = new Map<number, { mint: string; amount: string }>();
  for (const pre of preTokenBalances ?? []) {
    if (pre.owner?.trim() !== owner || pre.accountIndex == null) continue;
    const mint = pre.mint?.trim();
    if (!mint) continue;
    mintByAccountIndex.set(pre.accountIndex, {
      mint,
      amount: pre.uiTokenAmount?.amount ?? '0',
    });
  }

  const normInput = normalizeSimMint(inputMint);
  const normOutput = normalizeSimMint(outputMint);
  const closes: WalletTokenAccountCloseEntry[] = [];
  const seenAccounts = new Set<string>();

  for (const ix of prepared.message.compiledInstructions) {
    const programId = accountKeyStrings[ix.programIdIndex];
    if (!SPL_TOKEN_PROGRAM_IDS.has(programId)) continue;
    if (ix.data.length < 1 || ix.data[0] !== 9) continue;

    const accountIdx = ix.accountKeyIndexes[0];
    const authorityIdx = ix.accountKeyIndexes[2];
    if (accountIdx == null || authorityIdx == null) continue;
    if (accountKeyStrings[authorityIdx]?.trim() !== owner) continue;

    const accountAddress = accountKeyStrings[accountIdx]?.trim();
    if (!accountAddress || seenAccounts.has(accountAddress)) continue;
    seenAccounts.add(accountAddress);

    const meta = mintByAccountIndex.get(accountIdx);
    const mint = meta?.mint ?? '';
    if (!mint) continue;

    const normMint = normalizeSimMint(mint);
    let category: WalletTokenAccountCloseCategory = 'other';
    if (normMint === WSOL_MINT) category = 'wsol';
    else if (normMint === normInput) category = 'input';
    else if (normMint === normOutput) category = 'output';

    closes.push({
      mint: normMint,
      category,
      accountAddress,
      preBalanceRaw: meta?.amount,
      reclaimedLamports:
        preBalances?.[accountIdx] != null && preBalances[accountIdx]! > 0
          ? String(preBalances[accountIdx])
          : TOKEN_ACCOUNT_RENT_LAMPORTS.toString(),
    });
  }

  return closes;
}

export function mergeBuildAtaCloseHints(
  closes: WalletTokenAccountCloseEntry[],
  buildDetails: Record<string, unknown> | undefined,
  inputMint: string,
): WalletTokenAccountCloseEntry[] {
  const merged = [...closes];
  const closeIx =
    buildDetails?.closeAccountIX === true || buildDetails?.closeAccountIx === true;
  if (closeIx && !merged.some((c) => c.category === 'input')) {
    merged.push({
      mint: inputMint.trim(),
      category: 'input',
      reclaimedLamports: TOKEN_ACCOUNT_RENT_LAMPORTS.toString(),
    });
  }
  return merged;
}

const EXCLUDED_POOL_OWNER_ADDRESSES = new Set([
  SYSTEM_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
]);

function isLikelySolanaPubkey(value: string | undefined): boolean {
  const s = value?.trim() ?? '';
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
const BASE_SIGNATURE_FEE_LAMPORTS = 5_000n;
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000n;

/** Decodes the tx network fee: signatures × 5000 + ceil(unitLimit × µLamports/CU ÷ 1e6). */
function computeNetworkFeeLamports(
  prepared: VersionedTransaction,
  accountKeyStrings: string[],
): bigint {
  const numSigs = BigInt(Math.max(prepared.message.header?.numRequiredSignatures ?? 1, 1));
  let fee = numSigs * BASE_SIGNATURE_FEE_LAMPORTS;

  let unitLimit: bigint | null = null;
  let microLamportsPerCu: bigint | null = null;
  for (const ix of prepared.message.compiledInstructions) {
    if (accountKeyStrings[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const data = Buffer.from(ix.data);
    if (data[0] === 2 && data.length >= 5) {
      unitLimit = BigInt(data.readUInt32LE(1));
    } else if (data[0] === 3 && data.length >= 9) {
      microLamportsPerCu = data.readBigUInt64LE(1);
    }
  }
  if (microLamportsPerCu != null && microLamportsPerCu > 0n) {
    const limit = unitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
    fee += (limit * microLamportsPerCu + 999_999n) / 1_000_000n;
  }
  return fee;
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
  /** SPL token account that retained the pool fee (from simulation). */
  vaultAddress?: string;
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
  accountKeyStrings: string[],
  opts: { ammKey?: string; outflow: boolean },
): { total: bigint; vaultAddress?: string } {
  let total = 0n;
  let bestDelta = 0n;
  let vaultAddress: string | undefined;
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
    const magnitude = opts.outflow ? (delta < 0n ? -delta : 0n) : delta > 0n ? delta : 0n;
    if (magnitude <= 0n) continue;
    total += magnitude;
    if (magnitude > bestDelta) {
      bestDelta = magnitude;
      vaultAddress = accountKeyStrings[idx]?.trim() || post.owner?.trim() || undefined;
    }
  }
  return { total, vaultAddress: bestDelta > 0n ? vaultAddress : undefined };
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
  accountKeyStrings: string[],
): { amountRaw: bigint; mint: string; vaultAddress?: string } | null {
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
    const poolPaidOut = sumPoolTokenDelta(outMint, preTokenBalances, postTokenBalances, ownerAddress, accountKeyStrings, {
      ammKey: scoped ? ammKey : undefined,
      outflow: true,
    });
    const feeRaw = inferEmbeddedPoolFeeRaw(poolPaidOut.total, hopOut, nextIn);
    if (feeRaw > 0n) {
      return {
        amountRaw: feeRaw,
        mint: isSolMint(outMint) ? WSOL_MINT : outMint,
        vaultAddress: poolPaidOut.vaultAddress,
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
      accountKeyStrings,
      { ammKey, outflow: false },
    );
    if (poolReceivedIn.total > hopIn) {
      return {
        amountRaw: poolReceivedIn.total - hopIn,
        mint: inMint,
        vaultAddress: poolReceivedIn.vaultAddress,
      };
    }
  }

  return null;
}

function detectEmbeddedPoolFeesByHop(
  routePlan: VybeRoutePlanStep[],
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  postTokenBalances: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  accountKeyStrings: string[],
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
      accountKeyStrings,
    );
    if (detected && detected.amountRaw > 0n) {
      entries.push({
        hopIndex: i,
        amountRaw: detected.amountRaw.toString(),
        mint: detected.mint,
        vaultAddress: detected.vaultAddress,
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

    const ataAddress = accountKeyStrings[ataIdx]?.trim();
    entries.push({
      mint,
      lamports: post - pre,
      accountAddress: ataAddress || undefined,
      createdNew: pre === 0n,
    });
  }

  return entries;
}

function inferPoolOwnerFromTokenDeltas(
  preTokenBalances: TokenBalanceEntry[],
  postTokenBalances: TokenBalanceEntry[],
  walletAddress: string,
  inputMint: string,
  outputMint: string,
): string | null {
  const ownerInflow = new Map<string, bigint>();
  const ownerOutflow = new Map<string, bigint>();

  for (const post of postTokenBalances) {
    const owner = post.owner?.trim();
    const mint = post.mint?.trim();
    const idx = post.accountIndex;
    if (idx == null || !owner || !mint || owner === walletAddress) continue;
    if (EXCLUDED_POOL_OWNER_ADDRESSES.has(owner)) continue;

    const pre = preTokenBalances.find((b) => b.accountIndex === idx);
    const postAmt = BigInt(post.uiTokenAmount?.amount ?? '0');
    const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? '0');
    const delta = postAmt - preAmt;
    if (delta === 0n) continue;

    if (mintMatchesPoolFee(mint, inputMint) && delta > 0n) {
      ownerInflow.set(owner, (ownerInflow.get(owner) ?? 0n) + delta);
    }
    if (mintMatchesPoolFee(mint, outputMint) && delta < 0n) {
      ownerOutflow.set(owner, (ownerOutflow.get(owner) ?? 0n) + (-delta));
    }
  }

  let best: string | null = null;
  let bestScore = 0n;
  const owners = new Set([...ownerInflow.keys(), ...ownerOutflow.keys()]);
  for (const owner of owners) {
    if (!isLikelySolanaPubkey(owner)) continue;
    const inflow = ownerInflow.get(owner) ?? 0n;
    const outflow = ownerOutflow.get(owner) ?? 0n;
    const score =
      inflow > 0n && outflow > 0n
        ? inflow + outflow
        : inflow > 0n || outflow > 0n
          ? (inflow + outflow) / 2n
          : 0n;
    if (score > bestScore) {
      bestScore = score;
      best = owner;
    }
  }

  return best;
}

function inferSwapPoolAddressesByHop(
  routePlan: VybeRoutePlanStep[] | undefined,
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  postTokenBalances: TokenBalanceEntry[] | null | undefined,
  walletAddress: string,
  inputMint: string,
  outputMint: string,
): InferredHopPoolEntry[] {
  if (!preTokenBalances?.length || !postTokenBalances?.length) return [];

  const hops: Array<{ inputMintAddress: string; outputMintAddress: string }> =
    routePlan?.length
      ? routePlan.map((hop) => ({
          inputMintAddress: hop.swapInfo?.inputMintAddress?.trim() || inputMint,
          outputMintAddress: hop.swapInfo?.outputMintAddress?.trim() || outputMint,
        }))
      : [{ inputMintAddress: inputMint, outputMintAddress: outputMint }];

  const entries: InferredHopPoolEntry[] = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    const poolAddress = inferPoolOwnerFromTokenDeltas(
      preTokenBalances,
      postTokenBalances,
      walletAddress,
      hop.inputMintAddress,
      hop.outputMintAddress,
    );
    if (poolAddress) entries.push({ hopIndex: i, poolAddress });
  }
  return entries;
}

function detectTokenFeeCredits(
  preTokenBalances: TokenBalanceEntry[] | null | undefined,
  postTokenBalances: TokenBalanceEntry[] | null | undefined,
  ownerAddress: string,
  accountKeyStrings: string[],
): TokenFeeCreditEntry[] {
  if (!preTokenBalances?.length || !postTokenBalances?.length) return [];
  const owner = ownerAddress.trim();
  const entries: TokenFeeCreditEntry[] = [];

  for (const post of postTokenBalances) {
    const mint = post.mint?.trim();
    const idx = post.accountIndex;
    if (!mint || idx == null || post.owner === owner) continue;

    const pre = preTokenBalances.find((b) => b.accountIndex === idx);
    const postAmt = BigInt(post.uiTokenAmount?.amount ?? '0');
    const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? '0');
    const delta = postAmt - preAmt;
    if (delta <= 0n) continue;

    entries.push({
      mint,
      amountRaw: delta.toString(),
      ownerAddress: post.owner?.trim() ?? '',
      tokenAccountAddress: accountKeyStrings[idx],
    });
  }

  return entries;
}

function detectWalletSolTransfersFromWallet(
  prepared: VersionedTransaction,
  accountKeyStrings: string[],
  ownerAddress: string,
): WalletFeeTransferEntry[] {
  const owner = ownerAddress.trim();
  const entries: WalletFeeTransferEntry[] = [];

  for (const ix of prepared.message.compiledInstructions) {
    const programId = accountKeyStrings[ix.programIdIndex];
    if (programId !== SYSTEM_PROGRAM_ID) continue;
    if (ix.data.length < 12 || ix.data[0] !== 2) continue;

    const fromIdx = ix.accountKeyIndexes[0];
    const toIdx = ix.accountKeyIndexes[1];
    if (fromIdx == null || toIdx == null) continue;

    const from = accountKeyStrings[fromIdx]?.trim();
    const to = accountKeyStrings[toIdx]?.trim();
    if (from !== owner || !to) continue;

    const lamports = Buffer.from(ix.data).readBigUInt64LE(4);
    if (lamports <= 0n) continue;
    if (isRentSizedDeposit(0n, lamports)) continue;

    entries.push({ recipientAddress: to, amountLamports: lamports });
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

export interface SimulateSwapEffectsOptions {
  /** Skip scanning tx accounts for pool state when pool is already pinned. */
  pinnedPoolAddress?: string;
}

/** Returns simulation effects, or null values if simulation fails. */
export async function simulateSwapEffects(
  base64Tx: string,
  ownerAddress: string,
  outputMint: string,
  inputMint?: string,
  routePlan?: VybeRoutePlanStep[],
  options?: SimulateSwapEffectsOptions,
): Promise<SwapSimulationResult> {
  const empty: SwapSimulationResult = {
    outputDeltaRaw: null,
    simulationErr: null,
    pdaRentLamports: 0n,
    tokenAccRentByMint: [],
    embeddedPoolFeesByHop: [],
    walletSolTransfers: [],
    tokenFeeCredits: [],
    walletPayDebitRaw: null,
    networkFeeLamports: 0n,
    inferredPoolAddressesByHop: [],
    walletTokenAccountCloses: [],
  };
  const trimmed = base64Tx.trim();
  if (!trimmed || !ownerAddress.trim() || !outputMint.trim()) {
    return empty;
  }

  const connection = createSolanaConnection('simulateSwapEffects');
  console.info(
    `[solana-rpc] simulateSwapEffects owner=${ownerAddress.slice(0, 8)}… ` +
      `output=${outputMint.trim().slice(0, 8)}…` +
      `${options?.pinnedPoolAddress ? ` pool=${options.pinnedPoolAddress.slice(0, 8)}…` : ''}`,
  );
  let prepared: import('@solana/web3.js').VersionedTransaction;
  let altAccounts: import('@solana/web3.js').AddressLookupTableAccount[] = [];
  try {
    const ctx = await prepareVersionedSwapTransactionWithAlts(connection, trimmed);
    prepared = ctx.prepared;
    altAccounts = ctx.altAccounts;
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
  if (value.err) return { ...empty, simulationErr: value.err };

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
          accountKeyStrings,
        )
      : [];

  const walletSolTransfers = detectWalletSolTransfersFromWallet(
    prepared,
    accountKeyStrings,
    ownerAddress.trim(),
  );

  const tokenFeeCredits = detectTokenFeeCredits(
    value.preTokenBalances,
    value.postTokenBalances,
    ownerAddress.trim(),
    accountKeyStrings,
  );

  const inferredPoolAddressesByHop = inferSwapPoolAddressesByHop(
    routePlan,
    value.preTokenBalances,
    value.postTokenBalances,
    ownerAddress.trim(),
    inputMint?.trim() ?? '',
    outputMint.trim(),
  );

  const pinnedPool = options?.pinnedPoolAddress?.trim();
  const dexPoolState = pinnedPool
    ? pinnedPool
    : await findProgramOwnedPoolStateInTx(connection, accountKeyStrings, IX_BUILDER_PROGRAM_IDS);
  if (dexPoolState) {
    const hopIdx = 0;
    const existing = inferredPoolAddressesByHop.findIndex((e) => e.hopIndex === hopIdx);
    if (existing >= 0) inferredPoolAddressesByHop[existing]!.poolAddress = dexPoolState;
    else inferredPoolAddressesByHop.unshift({ hopIndex: hopIdx, poolAddress: dexPoolState });
  }

  const walletTokenAccountCloses = detectWalletTokenAccountCloses(
    prepared,
    accountKeyStrings,
    value.preTokenBalances,
    ownerAddress.trim(),
    inputMint?.trim() ?? '',
    outputMint.trim(),
    value.preBalances,
  );

  return {
    simulationErr: null,
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
    walletSolTransfers,
    tokenFeeCredits,
    walletPayDebitRaw,
    networkFeeLamports: computeNetworkFeeLamports(prepared, accountKeyStrings),
    inferredPoolAddressesByHop,
    walletTokenAccountCloses,
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
