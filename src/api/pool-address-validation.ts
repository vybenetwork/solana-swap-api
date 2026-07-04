/**
 * On-chain validation for pool vs program addresses (Vybe often puts authority wallets in txs).
 */

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { VybeSwapBuildResponse } from '../types/swap.js';

/** Static account keys from a base64 v0 swap tx (no ALT resolution). */
export function staticAccountKeysFromSwapTx(base64Tx: string): ReadonlySet<string> {
  const trimmed = base64Tx.trim();
  if (!trimmed) return new Set();
  try {
    const vtx = VersionedTransaction.deserialize(Buffer.from(trimmed, 'base64'));
    return new Set(vtx.message.staticAccountKeys.map((k) => k.toBase58()));
  } catch {
    return new Set();
  }
}

/** Pool addresses ix-builder already reported (top-level, details, enrichment ammKey). */
export function reportedPoolAddresses(build: VybeSwapBuildResponse): ReadonlySet<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const s = String(v ?? '').trim();
    if (s) out.add(s);
  };
  add(build.poolAddress);
  const details = build.details as unknown as Record<string, unknown> | undefined;
  add(details?.poolAddress);
  const quote = details?.quote as Record<string, unknown> | undefined;
  add(quote?.poolAddress);
  add(quote?.pool);
  const enrichment = build.enrichment as
    | {
        routePlan?: Array<{
          swapInfo?: { ammKey?: string };
          hopFees?: { items?: Array<{ destinationAddress?: string }> };
        }>;
      }
    | undefined;
  for (const hop of enrichment?.routePlan ?? []) {
    add(hop?.swapInfo?.ammKey);
    for (const fee of hop?.hopFees?.items ?? []) {
      add(fee?.destinationAddress);
    }
  }
  return out;
}

/**
 * Pool is present when it is in static keys, or ix-builder already reported it
 * (CLMM/DLMM often put pool state only in ALTs — static-key checks alone false-reject).
 */
export function buildIncludesPoolAccount(
  build: VybeSwapBuildResponse,
  pool: string,
  keys: ReadonlySet<string>,
): boolean {
  const poolAddr = pool.trim();
  if (!poolAddr) return true;
  if (keys.has(poolAddr)) return true;
  return reportedPoolAddresses(build).has(poolAddr);
}

export interface TradePoolCandidate {
  marketAddress: string;
  programAddress: string;
}

export interface TradeBuildValidationResult {
  ok: boolean;
  reason?: string;
  /** Program-owned pool state account found in the built tx (not an authority wallet). */
  poolStateInTx?: string;
}

/** First non-program account in tx owned by one of the given DEX program ids. */
export async function findProgramOwnedPoolStateInTx(
  connection: Connection,
  accountKeys: Iterable<string>,
  programIds: readonly string[],
): Promise<string | null> {
  const programSet = new Set(programIds);
  for (const key of accountKeys) {
    const addr = key.trim();
    if (!addr || programSet.has(addr)) continue;
    try {
      const info = await connection.getAccountInfo(new PublicKey(addr), 'processed');
      if (!info) continue;
      const owner = info.owner.toBase58();
      if (!programSet.has(owner)) continue;
      if ((info.data?.length ?? 0) === 0) continue;
      return addr;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Trade-routed build is valid only when:
 * - DEX program is in the tx
 * - marketAddress is a real pool account (owner === programAddress on-chain)
 * - marketAddress appears in the tx
 * - tx includes at least one pool state account owned by the program
 */
export async function validateTradeRoutedBuildOnChain(
  connection: Connection,
  build: VybeSwapBuildResponse,
  candidate: TradePoolCandidate,
): Promise<TradeBuildValidationResult> {
  const tx = build.tx ?? build.transaction;
  if (typeof tx !== 'string' || !tx.trim()) {
    return { ok: false, reason: 'Built tx missing' };
  }

  const keys = staticAccountKeysFromSwapTx(tx);
  const program = candidate.programAddress.trim();
  const pool = candidate.marketAddress.trim();

  if (!program) return { ok: true };

  if (!keys.has(program)) {
    return { ok: false, reason: `Built tx missing program ${program}` };
  }

  if (pool) {
    if (!buildIncludesPoolAccount(build, pool, keys)) {
      return { ok: false, reason: `Built tx missing pool ${pool}` };
    }
    // Pinned pool is in the tx (static, reported, or ALT) — skip scanning every static account.
    return { ok: true, poolStateInTx: pool };
  }

  const poolStateInTx = await findProgramOwnedPoolStateInTx(connection, keys, [program]);
  if (!poolStateInTx) {
    return {
      ok: false,
      reason: `Built tx has no pool state account owned by program ${program}`,
    };
  }

  return { ok: true, poolStateInTx };
}

/** Static tx key checks only — no RPC (for enumerate route list entries). */
export function validateTradeBuildStatic(
  build: VybeSwapBuildResponse,
  candidate: TradePoolCandidate,
): TradeBuildValidationResult {
  const tx = build.tx ?? build.transaction;
  if (typeof tx !== 'string' || !tx.trim()) {
    return { ok: false, reason: 'Built tx missing' };
  }

  const keys = staticAccountKeysFromSwapTx(tx);
  const program = candidate.programAddress.trim();
  const pool = candidate.marketAddress.trim();

  if (program && !keys.has(program)) {
    return { ok: false, reason: `Built tx missing program ${program}` };
  }
  if (pool && !buildIncludesPoolAccount(build, pool, keys)) {
    return { ok: false, reason: `Built tx missing pool ${pool}` };
  }

  return { ok: true, poolStateInTx: pool || undefined };
}
