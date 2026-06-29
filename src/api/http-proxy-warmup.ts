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
const IP_CHECK_TIMEOUT_MS = 4_000;
const IP_CHECK_URL = 'https://ipwho.is/';

export interface ProxySlotIdentity {
  ip: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  isp?: string;
  org?: string;
}

export function formatProxySlotIdentity(identity: ProxySlotIdentity): string {
  const geo = [identity.city, identity.region, identity.countryCode ?? identity.country]
    .filter(Boolean)
    .join(', ');
  const net = [identity.isp, identity.org].filter(Boolean).join(' / ');
  return `ip=${identity.ip}${geo ? ` geo=${geo}` : ''}${net ? ` via=${net}` : ''}`;
}

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

/** Confirm the proxy tunnel exits on a public IP (and log geo/ISP metadata). */
export async function verifyProxySlotIdentity(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<ProxySlotIdentity> {
  const res = await fetchFn(IP_CHECK_URL, {
    method: 'GET',
    signal: AbortSignal.timeout(IP_CHECK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`proxy ip check HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    success?: boolean;
    message?: string;
    ip?: string;
    country?: string;
    country_code?: string;
    region?: string;
    city?: string;
    connection?: { isp?: string; org?: string };
  };
  if (data.success === false) {
    throw new Error(data.message?.trim() || 'proxy ip check rejected');
  }
  const ip = String(data.ip ?? '').trim();
  if (!ip) throw new Error('proxy ip check returned empty ip');
  return {
    ip,
    country: data.country?.trim() || undefined,
    countryCode: data.country_code?.trim() || undefined,
    region: data.region?.trim() || undefined,
    city: data.city?.trim() || undefined,
    isp: data.connection?.isp?.trim() || undefined,
    org: data.connection?.org?.trim() || undefined,
  };
}
