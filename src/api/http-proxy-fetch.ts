/**
 * Optional HTTP proxy for outbound API calls (IPRoyal / PROXY_HOST + PROXY_AUTH).
 * When proxy env is unset, uses the default global fetch with no proxy.
 */

import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { getHttpProxyUrl } from '../config.js';

let cachedProxyDispatcher: ProxyAgent | undefined;

function getProxyDispatcher(): ProxyAgent | undefined {
  if (cachedProxyDispatcher !== undefined) return cachedProxyDispatcher;
  const proxyUrl = getHttpProxyUrl();
  cachedProxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  return cachedProxyDispatcher;
}

/** fetch() through PROXY_HOST when configured; otherwise plain fetch. */
export async function fetchWithHttpProxy(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  if (!dispatcher) {
    return fetch(url, init);
  }
  return undiciFetch(url, {
    ...init,
    dispatcher,
  } as UndiciRequestInit) as unknown as Response;
}
