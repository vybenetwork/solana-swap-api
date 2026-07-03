/**
 * Outbound fetch for Jupiter + pump.fun: direct first, HTTP proxy only on HTTP 429.
 * Proxy slot queue (IPRoyal / PROXY_HOST + PROXY_AUTH) is filled lazily on first 429.
 */

import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import {
  getHttpProxyPoolSize,
  getHttpProxyUrl,
  isHttpProxyWarmupEnabled,
} from '../config.js';
import {
  formatProxySlotIdentity,
  listHttpWarmupTargets,
  prefetchHttpWarmupTarget,
  prefetchHttpWarmupTargets,
  verifyProxySlotIdentity,
} from './http-proxy-warmup.js';

const REPLENISH_RETRY_MS = 750;
const MAX_REPLENISH_ATTEMPTS = 3;

/** Warmed agents ready at the front; recycled slots join the back after rewarm. */
const readyAgents: ProxyAgent[] = [];
const agentWaiters: Array<(agent: ProxyAgent) => void> = [];

let warmupRotation = 0;
let initialFillPromise: Promise<void> | null = null;
let warmupComplete = false;
let proxyPoolFillPromise: Promise<void> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Take the next warmed slot (FIFO). Waits if the pool is empty. */
function acquireAgent(): Promise<ProxyAgent> {
  const ready = readyAgents.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve) => agentWaiters.push(resolve));
}

/** Append a re-warmed slot to the back of the queue (or hand to a waiter). */
function enqueueAgent(agent: ProxyAgent): void {
  const waiter = agentWaiters.shift();
  if (waiter) waiter(agent);
  else readyAgents.push(agent);
}

async function closeAgent(agent: ProxyAgent): Promise<void> {
  try {
    await agent.close();
  } catch (err) {
    console.warn(
      `[http-proxy] slot close failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Prefetch Jupiter/pump.fun, then verify outbound IP/geo through the proxy. */
async function warmAgent(agent: ProxyAgent, slotIndex: number): Promise<void> {
  const targets = listHttpWarmupTargets();
  const target = targets[slotIndex % targets.length]!;
  await prefetchHttpWarmupTarget(target, (url, init) =>
    fetchViaDispatcher(url, init, agent),
  );
  const identity = await verifyProxySlotIdentity((url, init) =>
    fetchViaDispatcher(url, init, agent),
  );
  console.log(`[http-proxy] slot ${slotIndex} verified — ${formatProxySlotIdentity(identity)}`);
}

/** Create a fresh proxy connection, warm it, and append to the slot queue. */
async function createAndEnqueueAgent(): Promise<void> {
  const proxyUrl = getHttpProxyUrl();
  if (!proxyUrl) return;

  for (let attempt = 0; attempt < MAX_REPLENISH_ATTEMPTS; attempt++) {
    let agent: ProxyAgent | null = null;
    try {
      agent = new ProxyAgent(proxyUrl);
      const slotIndex = warmupRotation++;
      await warmAgent(agent, slotIndex);
      enqueueAgent(agent);
      return;
    } catch (err) {
      if (agent) await closeAgent(agent);
      if (attempt + 1 < MAX_REPLENISH_ATTEMPTS) {
        await sleep(REPLENISH_RETRY_MS * (attempt + 1));
        continue;
      }
      console.warn(
        `[http-proxy] slot replenish failed after ${MAX_REPLENISH_ATTEMPTS} attempts: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Close used slot, spawn replacement, rewarm, enqueue at back. */
async function recycleAgent(agent: ProxyAgent): Promise<void> {
  await closeAgent(agent);
  await createAndEnqueueAgent();
}

async function drainResponseBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* optional */
  }
}

async function warmupDirectConnections(): Promise<void> {
  const slotCount = getHttpProxyPoolSize();
  console.log(
    `[http-proxy] direct warmup — prefetch Jupiter + pump.fun (${slotCount} parallel probe(s))`,
  );
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: slotCount }, () =>
      prefetchHttpWarmupTargets((url, init) => fetch(url, init)),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  console.log(
    `[http-proxy] direct warmup done in ${Date.now() - started}ms (${ok}/${results.length} ok)`,
  );
}

async function fillInitialProxyPool(): Promise<void> {
  await warmupDirectConnections();
  if (getHttpProxyUrl()) {
    console.log('[http-proxy] proxy pool deferred — used only on HTTP 429 from Jupiter/pump.fun');
  }
}

/** Lazily create at least one proxy slot when a 429 requires it. */
async function ensureProxyAgentAvailable(): Promise<ProxyAgent> {
  if (readyAgents.length > 0 || agentWaiters.length > 0) {
    return acquireAgent();
  }
  if (!proxyPoolFillPromise) {
    proxyPoolFillPromise = createAndEnqueueAgent().finally(() => {
      proxyPoolFillPromise = null;
    });
  }
  await proxyPoolFillPromise;
  return acquireAgent();
}

/**
 * Fill direct connection warmup at startup (idempotent). Proxy slots are not prefilled.
 */
export async function warmupHttpProxyPool(): Promise<void> {
  if (warmupComplete) return;
  if (!isHttpProxyWarmupEnabled()) {
    warmupComplete = true;
    return;
  }
  await ensureHttpProxyPoolWarmed();
}

/** Wait until direct Jupiter/pump.fun prefetch finished. */
export function ensureHttpProxyPoolWarmed(): Promise<void> {
  if (warmupComplete) return Promise.resolve();
  if (!initialFillPromise) {
    initialFillPromise = fillInitialProxyPool()
      .catch((err) => {
        initialFillPromise = null;
        console.warn(
          `[http-proxy] initial warmup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        warmupComplete = true;
      });
  }
  return initialFillPromise;
}

/**
 * Jupiter / pump.fun fetch: try direct first; retry through proxy only on HTTP 429.
 */
export async function fetchWithHttpProxy(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  await ensureHttpProxyPoolWarmed();

  let directRes: Response;
  try {
    directRes = await fetch(url, init);
  } catch (err) {
    throw err;
  }

  if (directRes.status !== 429) {
    return directRes;
  }

  const proxyUrl = getHttpProxyUrl();
  if (!proxyUrl) {
    return directRes;
  }

  console.warn(`[http-proxy] HTTP 429 on direct fetch — retrying via proxy: ${String(url)}`);
  await drainResponseBody(directRes);

  const agent = await ensureProxyAgentAvailable();
  try {
    return await fetchViaDispatcher(url, init, agent);
  } finally {
    void recycleAgent(agent);
  }
}

/** @internal test hook */
export function resetHttpProxyPoolForTests(): void {
  readyAgents.length = 0;
  agentWaiters.length = 0;
  warmupRotation = 0;
  initialFillPromise = null;
  proxyPoolFillPromise = null;
  warmupComplete = false;
}
