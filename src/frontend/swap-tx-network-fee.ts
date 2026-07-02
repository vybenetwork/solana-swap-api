/**
 * Decode or estimate Solana network (priority) fee from swap tx wire bytes.
 * Matches ix-builder swap-sim-effects.computeNetworkFeeLamports when compute budget
 * instructions are present; otherwise simulates + recent prioritization fees.
 */

import {
  ComputeBudgetProgram,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';

export type NetworkFeeEstimateOptions = {
  feeMultiplier?: bigint;
  routeHopCount?: number;
};

export type PrepareSwapTxSigningOptions = {
  targetNetworkFeeLamports?: string;
  injectComputeBudget?: boolean;
};

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const BASE_SIGNATURE_FEE_LAMPORTS = 5_000n;
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000n;
const DEFAULT_MICRO_LAMPORTS_PER_CU = 50_000n;

/** Default 2× bump on simulated priority fee. */
export const FRONTEND_NETWORK_FEE_MULTIPLIER = 2n;
/** Single-tx atomic multi-hop routes need more headroom than one-hop swaps. */
export const FRONTEND_ATOMIC_MULTI_HOP_NETWORK_FEE_MULTIPLIER = 4n;
/** Floor shown in sign-confirm for 2+ hop routes (0.0001 SOL). */
export const FRONTEND_MULTI_HOP_MIN_NETWORK_FEE_LAMPORTS = 100_000n;

export function resolveFrontendNetworkFeeMultiplier(options: {
  routeHopCount?: number;
  txCount?: number;
}): bigint {
  const hops = options.routeHopCount ?? 0;
  const txCount = options.txCount ?? 1;
  if (hops >= 2 && txCount === 1) return FRONTEND_ATOMIC_MULTI_HOP_NETWORK_FEE_MULTIPLIER;
  return FRONTEND_NETWORK_FEE_MULTIPLIER;
}

function applyFrontendNetworkFeeMultiplier(lamports: bigint, multiplier: bigint): bigint {
  if (lamports <= 0n || multiplier <= 1n) return lamports;
  return lamports * multiplier;
}

export function applyMultiHopNetworkFeeFloor(lamports: bigint, routeHopCount: number): bigint {
  if (routeHopCount < 2) return lamports;
  return lamports < FRONTEND_MULTI_HOP_MIN_NETWORK_FEE_LAMPORTS
    ? FRONTEND_MULTI_HOP_MIN_NETWORK_FEE_LAMPORTS
    : lamports;
}

export function applyFrontendNetworkFeeAdjustments(
  lamports: bigint | null,
  options?: NetworkFeeEstimateOptions,
): bigint | null {
  if (lamports == null || lamports <= 0n) return lamports;
  const multiplier = options?.feeMultiplier ?? 1n;
  let adjusted = applyFrontendNetworkFeeMultiplier(lamports, multiplier);
  adjusted = applyMultiHopNetworkFeeFloor(adjusted, options?.routeHopCount ?? 0);
  return adjusted;
}

/** Inject compute budget on the last leg of multi-tx quote-bridge routes only. */
export function shouldInjectComputeBudgetForSwapLeg(options: {
  routeHopCount: number;
  txCount: number;
  legIndex: number;
}): boolean {
  const { routeHopCount, txCount, legIndex } = options;
  if (routeHopCount >= 2 && txCount === 1) return false;
  if (routeHopCount >= 2 && txCount > 1) return legIndex === txCount - 1;
  return true;
}

function readUInt32LE(data: Uint8Array, offset: number): bigint {
  return (
    BigInt(data[offset]!) |
    (BigInt(data[offset + 1]!) << 8n) |
    (BigInt(data[offset + 2]!) << 16n) |
    (BigInt(data[offset + 3]!) << 24n)
  );
}

function readBigUInt64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) value |= BigInt(data[offset + i]!) << (8n * BigInt(i));
  return value;
}

function accountKeyStrings(vtx: VersionedTransaction): string[] {
  return vtx.message.staticAccountKeys.map((k) => k.toBase58());
}

function txHasComputeBudgetPrice(vtx: VersionedTransaction): boolean {
  const keys = accountKeyStrings(vtx);
  for (const ix of vtx.message.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const data = ix.data;
    if (data.length >= 9 && data[0] === 3) return true;
  }
  return false;
}

function txHasAnyComputeBudget(vtx: VersionedTransaction): boolean {
  const keys = accountKeyStrings(vtx);
  return vtx.message.compiledInstructions.some(
    (ix) => keys[ix.programIdIndex] === COMPUTE_BUDGET_PROGRAM_ID,
  );
}

function readComputeUnitLimitFromInstructions(
  instructions: Array<{ programId: { toBase58(): string }; data: Uint8Array }>,
): bigint | null {
  for (const ix of instructions) {
    if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const data = ix.data;
    if (data[0] === 2 && data.length >= 5) return readUInt32LE(data, 1);
  }
  return null;
}

/** Add compute budget ixs so wallet simulation shows a realistic priority fee. */
export async function augmentVersionedSwapTxWithTargetNetworkFee(
  connection: Connection,
  vtx: VersionedTransaction,
  targetTotalLamports: bigint,
  altAccounts: AddressLookupTableAccount[] = [],
): Promise<VersionedTransaction> {
  if (targetTotalLamports <= 0n) return vtx;
  if (txHasAnyComputeBudget(vtx)) return vtx;
  const decoded = computeNetworkFeeLamportsFromVersionedTx(vtx);
  if (txHasComputeBudgetPrice(vtx) && decoded >= targetTotalLamports) return vtx;

  const decompiled = TransactionMessage.decompile(vtx.message, {
    addressLookupTableAccounts: altAccounts,
  });
  const computeBudgetProgramId = ComputeBudgetProgram.programId.toBase58();
  const swapInstructions = decompiled.instructions.filter(
    (ix) => ix.programId.toBase58() !== computeBudgetProgramId,
  );

  const numSigs = BigInt(Math.max(vtx.message.header.numRequiredSignatures, 1));
  const baseFee = numSigs * BASE_SIGNATURE_FEE_LAMPORTS;
  const priorityTarget = targetTotalLamports > baseFee ? targetTotalLamports - baseFee : 0n;

  let unitLimit =
    readComputeUnitLimitFromInstructions(decompiled.instructions) ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  if (unitLimit <= 0n) unitLimit = DEFAULT_COMPUTE_UNIT_LIMIT;

  try {
    const sim = await connection.simulateTransaction(vtx, {
      replaceRecentBlockhash: true,
      commitment: 'processed',
    });
    const consumed = sim.value.unitsConsumed;
    if (consumed != null && consumed > 0) {
      unitLimit = BigInt(Math.ceil(consumed * 1.1));
    }
  } catch {
    /* use default / decoded unit limit */
  }

  const microLamportsPerCu =
    priorityTarget > 0n
      ? (priorityTarget * 1_000_000n + unitLimit - 1n) / unitLimit
      : DEFAULT_MICRO_LAMPORTS_PER_CU;

  decompiled.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: Number(unitLimit) }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(microLamportsPerCu) }),
    ...swapInstructions,
  ];
  return new VersionedTransaction(decompiled.compileToV0Message(altAccounts));
}

/** signatures * 5000 + ceil(unitLimit * microLamports/CU / 1e6) */
export function computeNetworkFeeLamportsFromVersionedTx(vtx: VersionedTransaction): bigint {
  const keys = accountKeyStrings(vtx);
  const numSigs = BigInt(Math.max(vtx.message.header.numRequiredSignatures, 1));
  let fee = numSigs * BASE_SIGNATURE_FEE_LAMPORTS;

  let unitLimit: bigint | null = null;
  let microLamportsPerCu: bigint | null = null;
  for (const ix of vtx.message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const data = ix.data;
    if (data[0] === 2 && data.length >= 5) {
      unitLimit = readUInt32LE(data, 1);
    } else if (data[0] === 3 && data.length >= 9) {
      microLamportsPerCu = readBigUInt64LE(data, 1);
    }
  }
  if (microLamportsPerCu != null && microLamportsPerCu > 0n) {
    const limit = unitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
    fee += (limit * microLamportsPerCu + 999_999n) / 1_000_000n;
  }
  return fee;
}

export function decodeVersionedSwapTxFromBase64(txString: string): VersionedTransaction {
  const trimmed = txString.trim();
  return VersionedTransaction.deserialize(Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0)));
}

async function recommendedMicroLamportsPerCu(connection: Connection): Promise<bigint> {
  try {
    const fees = await connection.getRecentPrioritizationFees();
    const values = fees
      .map((f) => BigInt(f.prioritizationFee))
      .filter((n) => n > 0n)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (values.length === 0) return DEFAULT_MICRO_LAMPORTS_PER_CU;
    const median = values[Math.floor(values.length / 2)]!;
    return median > 5_000n ? median : DEFAULT_MICRO_LAMPORTS_PER_CU;
  } catch {
    return DEFAULT_MICRO_LAMPORTS_PER_CU;
  }
}

async function estimateNetworkFeeLamportsFromSimulation(
  connection: Connection,
  vtx: VersionedTransaction,
): Promise<bigint> {
  const numSigs = BigInt(Math.max(vtx.message.header.numRequiredSignatures, 1));
  let units = DEFAULT_COMPUTE_UNIT_LIMIT;
  try {
    const sim = await connection.simulateTransaction(vtx, {
      replaceRecentBlockhash: true,
      commitment: 'processed',
    });
    const consumed = sim.value.unitsConsumed;
    if (consumed != null && consumed > 0) {
      units = BigInt(Math.ceil(consumed * 1.1));
    }
  } catch {
    /* use default units */
  }
  const microLamports = await recommendedMicroLamportsPerCu(connection);
  const base = numSigs * BASE_SIGNATURE_FEE_LAMPORTS;
  const priority = (units * microLamports + 999_999n) / 1_000_000n;
  return base + priority;
}

/** Decode network fee from tx wire bytes (no RPC). Same decode path as tx size. */
export function computeNetworkFeeLamportsFromSwapTx(txString: string): string | null {
  const trimmed = txString.trim();
  if (!trimmed) return null;
  try {
    const vtx = decodeVersionedSwapTxFromBase64(trimmed);
    const fee = computeNetworkFeeLamportsFromVersionedTx(vtx);
    return fee > 0n ? fee.toString() : null;
  } catch {
    return null;
  }
}

/** Sum decoded network fees across quote-bridge legs (pre / main / post). */
export function computeNetworkFeeLamportsFromSwapTxStrings(txStrings: string[]): string | null {
  let total = 0n;
  let found = false;
  for (const tx of txStrings) {
    const lamports = computeNetworkFeeLamportsFromSwapTx(tx);
    if (!lamports) continue;
    try {
      total += BigInt(lamports);
      found = true;
    } catch {
      /* skip */
    }
  }
  return found ? total.toString() : null;
}

export async function estimateNetworkFeeLamportsForSwapTx(
  connection: Connection,
  txString: string,
  options?: NetworkFeeEstimateOptions,
): Promise<string | null> {
  const trimmed = txString.trim();
  if (!trimmed) return null;
  try {
    const vtx = decodeVersionedSwapTxFromBase64(trimmed);
    const decoded = computeNetworkFeeLamportsFromVersionedTx(vtx);
    if (txHasComputeBudgetPrice(vtx) && decoded > BASE_SIGNATURE_FEE_LAMPORTS) {
      const bumped = applyFrontendNetworkFeeAdjustments(decoded, options);
      return bumped != null && bumped > 0n ? bumped.toString() : null;
    }
    const estimated = await estimateNetworkFeeLamportsFromSimulation(connection, vtx);
    const raw = estimated > 0n ? estimated : decoded > 0n ? decoded : null;
    const bumped = applyFrontendNetworkFeeAdjustments(raw, options);
    return bumped != null && bumped > 0n ? bumped.toString() : null;
  } catch {
    const decoded = computeNetworkFeeLamportsFromSwapTx(trimmed);
    if (!decoded) return null;
    const bumped = applyFrontendNetworkFeeAdjustments(BigInt(decoded), options);
    return bumped != null && bumped > 0n ? bumped.toString() : null;
  }
}

/** Serialized v0 transaction wire size in bytes. */
export function computeSwapTxSizeBytes(txString: string): number | null {
  const trimmed = txString.trim();
  if (!trimmed) return null;
  try {
    const vtx = decodeVersionedSwapTxFromBase64(trimmed);
    return vtx.serialize().length;
  } catch {
    return null;
  }
}

/** One size per leg tx (pre → main → post). */
export function computeSwapTxSizesBytes(txStrings: string[]): number[] {
  const sizes: number[] = [];
  for (const tx of txStrings) {
    const bytes = computeSwapTxSizeBytes(tx);
    if (bytes != null && bytes > 0) sizes.push(bytes);
  }
  return sizes;
}

/** e.g. `1161 bytes` or `1200 bytes + 848 bytes` */
export function formatSwapTxSizesBytesDisplay(sizes: number[]): string | null {
  if (sizes.length === 0) return null;
  if (sizes.length === 1) return `${sizes[0]} bytes`;
  return sizes.map((n) => `${n} bytes`).join(' + ');
}

/** Sum network fees across quote-bridge legs (pre / main / post). */
export async function estimateNetworkFeeLamportsForSwapTxs(
  connection: Connection,
  txStrings: string[],
  options?: NetworkFeeEstimateOptions,
): Promise<string | null> {
  let total = 0n;
  let found = false;
  for (const tx of txStrings) {
    const lamports = await estimateNetworkFeeLamportsForSwapTx(connection, tx, options);
    if (!lamports) continue;
    try {
      total += BigInt(lamports);
      found = true;
    } catch {
      /* skip */
    }
  }
  const hops = options?.routeHopCount ?? 0;
  if (found && hops >= 2) {
    total = applyMultiHopNetworkFeeFloor(total, hops);
  }
  return found ? total.toString() : null;
}
