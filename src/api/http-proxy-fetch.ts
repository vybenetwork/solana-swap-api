/**
 * HTTP proxy slot queue for outbound API calls (IPRoyal / PROXY_HOST + PROXY_AUTH).
 * Each use: take front slot → fetch → close → new ProxyAgent → rewarm → enqueue at back.
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

async function warmupDirectConnections(): Promise<void> {
  const slotCount = getHttpProxyPoolSize();
  console.log(
    `[http-proxy] warming ${slotCount} direct slot(s) — prefetch Jupiter + pump.fun`,
  );
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: slotCount }, () =>
      prefetchHttpWarmupTargets((url, init) => fetch(url, init)),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  console.log(
    `[http-proxy] direct warmup done in ${Date.now() - started}ms (${ok}/${results.length} slots ok)`,
  );
}

async function fillInitialProxyPool(): Promise<void> {
  const proxyUrl = getHttpProxyUrl();
  if (!proxyUrl) {
    await warmupDirectConnections();
    return;
  }

  const slotCount = getHttpProxyPoolSize();
  console.log(
    `[http-proxy] filling ${slotCount} proxy slot(s) — prefetch Jupiter + pump.fun`,
  );
  const started = Date.now();
  await Promise.all(Array.from({ length: slotCount }, () => createAndEnqueueAgent()));
  console.log(
    `[http-proxy] pool ready in ${Date.now() - started}ms (${readyAgents.length} slot(s) queued)`,
  );
}

/**
 * Fill the slot queue at startup (idempotent).
 */
export async function warmupHttpProxyPool(): Promise<void> {
  if (warmupComplete) return;
  if (!isHttpProxyWarmupEnabled()) {
    warmupComplete = true;
    return;
  }
  await ensureHttpProxyPoolWarmed();
}

/** Wait until initial slots are warmed (or direct prefetch finished). */
export function ensureHttpProxyPoolWarmed(): Promise<void> {
  if (warmupComplete) return Promise.resolve();
  if (!initialFillPromise) {
    initialFillPromise = fillInitialProxyPool()
      .catch((err) => {
        initialFillPromise = null;
        console.warn(
          `[http-proxy] initial pool fill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        warmupComplete = true;
      });
  }
  return initialFillPromise;
}

/**
 * fetch() through a FIFO proxy slot: use front slot, then close → new proxy → rewarm → back of queue.
 */
export async function fetchWithHttpProxy(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  await ensureHttpProxyPoolWarmed();
  const proxyUrl = getHttpProxyUrl();
  if (!proxyUrl) {
    return fetch(url, init);
  }

  const agent = await acquireAgent();
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
  warmupComplete = false;
}
