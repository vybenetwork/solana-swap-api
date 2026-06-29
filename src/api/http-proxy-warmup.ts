/**
 * Startup prefetch for Jupiter and pump.fun via the HTTP proxy pool (or direct fetch).
 */

import { loadPumpfunHeaders } from './pumpfun-price-fallback.js';
import { getJupiterWarmupUrls } from './jupiter-token-fallback.js';

export interface HttpWarmupTarget {
  label: string;
  url: string;
  headers?: Record<string, string>;
}

const WARMUP_TIMEOUT_MS = 12_000;

export function listHttpWarmupTargets(): HttpWarmupTarget[] {
  const jupiter = getJupiterWarmupUrls();
  return [
    { label: 'jupiter-datapi', url: jupiter.datapi },
    { label: 'jupiter-quote', url: jupiter.quote },
    {
      label: 'pumpfun-api',
      url: jupiter.pumpfunProbe,
      headers: loadPumpfunHeaders(),
    },
  ];
}

/** Lightweight GET — status/body ignored; establishes DNS, TLS, and proxy tunnel. */
export async function prefetchHttpWarmupTarget(
  target: HttpWarmupTarget,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const res = await fetchFn(target.url, {
    method: 'GET',
    headers: target.headers,
    signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
  });
  try {
    await res.arrayBuffer();
  } catch {
    /* body drain optional */
  }
}

export async function prefetchHttpWarmupTargets(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ ok: number; failed: number }> {
  const targets = listHttpWarmupTargets();
  let ok = 0;
  let failed = 0;
  await Promise.all(
    targets.map(async (target) => {
      try {
        await prefetchHttpWarmupTarget(target, fetchFn);
        ok++;
      } catch {
        failed++;
      }
    }),
  );
  return { ok, failed };
}
