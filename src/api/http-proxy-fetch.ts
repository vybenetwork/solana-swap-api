/**
 * Optional HTTP proxy pool for outbound API calls (IPRoyal / PROXY_HOST + PROXY_AUTH).
 * Warms up to 5 proxy dispatchers and prefetches Jupiter + pump.fun before first use.
 */

import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import {
  getHttpProxyPoolSize,
  getHttpProxyUrl,
  isHttpProxyWarmupEnabled,
} from '../config.js';
import {
  listHttpWarmupTargets,
  prefetchHttpWarmupTarget,
} from './http-proxy-warmup.js';

let poolInitialized = false;
let proxyAgents: ProxyAgent[] = [];
let roundRobin = 0;
let warmupPromise: Promise<void> | null = null;
let warmupComplete = false;

function initProxyPool(): void {
  if (poolInitialized) return;
  poolInitialized = true;
  const proxyUrl = getHttpProxyUrl();
  if (!proxyUrl) return;
  const size = getHttpProxyPoolSize();
  proxyAgents = Array.from({ length: size }, () => new ProxyAgent(proxyUrl));
}

function pickProxyAgent(): ProxyAgent | undefined {
  initProxyPool();
  if (proxyAgents.length === 0) return undefined;
  const agent = proxyAgents[roundRobin % proxyAgents.length]!;
  roundRobin = (roundRobin + 1) % proxyAgents.length;
  return agent;
}

async function fetchViaDispatcher(
  url: string | URL,
  init: RequestInit | undefined,
  dispatcher: ProxyAgent | undefined,
): Promise<Response> {
  if (!dispatcher) return fetch(url, init);
  return undiciFetch(url, {
    ...init,
    dispatcher,
  } as UndiciRequestInit) as unknown as Response;
}

/** One prefetch per pool slot — rotates Jupiter / pump.fun targets across slots. */
async function warmupProxySlot(slotIndex: number, agent: ProxyAgent | undefined): Promise<void> {
  const targets = listHttpWarmupTargets();
  const target = targets[slotIndex % targets.length]!;
  await prefetchHttpWarmupTarget(target, (url, init) =>
    fetchViaDispatcher(url, init, agent),
  );
}

/**
 * Warm up to {@link getHttpProxyPoolSize} proxy threads and prefetch Jupiter + pump.fun.
 * Idempotent; safe to call from startup and before the first proxied request.
 */
export async function warmupHttpProxyPool(): Promise<void> {
  if (warmupComplete) return;
  if (!isHttpProxyWarmupEnabled()) {
    warmupComplete = true;
    return;
  }

  initProxyPool();
  const slotCount = getHttpProxyPoolSize();
  const proxyMode = getHttpProxyUrl() ? 'proxy' : 'direct';
  console.log(
    `[http-proxy] warming ${slotCount} ${proxyMode} slot(s) — prefetch Jupiter + pump.fun`,
  );

  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: slotCount }, (_, slotIndex) =>
      warmupProxySlot(slotIndex, proxyAgents[slotIndex]),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  warmupComplete = true;
  console.log(
    `[http-proxy] warmup done in ${Date.now() - started}ms (${ok}/${results.length} slots ok` +
      `${failed > 0 ? `, ${failed} failed` : ''})`,
  );
}

/** Ensures warmup finished before outbound Jupiter / pump.fun calls. */
export function ensureHttpProxyPoolWarmed(): Promise<void> {
  if (warmupComplete) return Promise.resolve();
  if (!warmupPromise) {
    warmupPromise = warmupHttpProxyPool()
      .catch((err) => {
        console.warn(
          `[http-proxy] warmup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        warmupComplete = true;
      });
  }
  return warmupPromise;
}

/** fetch() through PROXY_HOST pool when configured; otherwise plain fetch. */
export async function fetchWithHttpProxy(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  await ensureHttpProxyPoolWarmed();
  return fetchViaDispatcher(url, init, pickProxyAgent());
}

/** @internal test hook */
export function resetHttpProxyPoolForTests(): void {
  poolInitialized = false;
  proxyAgents = [];
  roundRobin = 0;
  warmupPromise = null;
  warmupComplete = false;
}
