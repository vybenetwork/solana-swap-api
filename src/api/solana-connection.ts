/**
 * Shared Solana Connection with RPC method logging on HTTP 429 (rate limit).
 */

import { Connection, type ConnectionConfig } from '@solana/web3.js';
import { SOLANA_RPC_URL } from '../config.js';

function solanaRpcHost(): string {
  try {
    return new URL(SOLANA_RPC_URL).host;
  } catch {
    return SOLANA_RPC_URL;
  }
}

export function getSolanaRpcHost(): string {
  return solanaRpcHost();
}

function rpcMethodFromInit(init?: RequestInit): string {
  try {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body && typeof body.method === 'string') return body.method;
  } catch {
    /* ignore */
  }
  return 'unknown';
}

function createLoggingRpcFetch(caller: string): typeof fetch {
  const host = solanaRpcHost();
  return async (input, init) => {
    const method = rpcMethodFromInit(init);
    const res = await fetch(input, init);
    if (res.status === 429) {
      console.warn(`[solana-rpc] HTTP 429 caller=${caller} method=${method} host=${host}`);
    }
    return res;
  };
}

/** Server-side Connection — logs which JSON-RPC method hits 429. */
export function createSolanaConnection(
  caller: string,
  commitment: ConnectionConfig['commitment'] = 'confirmed',
): Connection {
  return new Connection(SOLANA_RPC_URL, {
    commitment,
    fetch: createLoggingRpcFetch(caller),
  });
}

/** Log 429 from browser RPC proxy (`POST /api/solana/rpc`). */
export function logBrowserRpc429(method: string): void {
  console.warn(
    `[solana-rpc] HTTP 429 caller=browser-proxy method=${method} host=${solanaRpcHost()}`,
  );
}
