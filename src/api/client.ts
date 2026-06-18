/**
 * Vybe API HTTP client: axios instance with X-API-Key, retries, and human-readable errors.
 * Used by api modules. Never log the raw API key.
 */

import axios, { AxiosError, type AxiosInstance } from 'axios';
import {
  VYBE_API_BASE,
  VYBE_DATA_API_BASE,
  VYBE_MAX_RETRIES,
  VYBE_RETRY_DELAY_MS,
  VYBE_TIMEOUT_MS,
} from '../config.js';

/**
 * Turn Axios/API errors into a message suitable for logs or API responses.
 * Example: "API returned 403 Forbidden — verify your API key has access to the /v4/trades endpoint."
 */
export function toHumanReadableError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{ message?: string; error?: string }>;
    const status = ax.response?.status;
    const endpoint = ax.config?.url ?? 'endpoint';
    const body = ax.response?.data;
    const msg = typeof body === 'object' && body && (body.message ?? body.error);
    if (status === 403) {
      return `API returned 403 Forbidden — verify your API key has access to ${endpoint}. If the key works locally but not on a server, the key may be IP-restricted; contact Vybe support to allow your server IP.`;
    }
    if (status === 404) {
      return `API returned 404 Not Found for ${endpoint}.`;
    }
    if (status && status >= 500) {
      const id =
        typeof body === 'object' && body && 'id' in body && body.id != null ? String(body.id) : '';
      const detail =
        msg && typeof msg === 'string' ? msg : 'Vybe server error. Try again later or contact support.';
      return id ? `${detail} (ref: ${id})` : detail;
    }
    if (msg && typeof msg === 'string') return msg;
    if (status) return `API returned ${status} for ${endpoint}.`;
  }
  if (err instanceof Error) {
    const msg = err.message.trim();
    return msg || 'An unexpected error occurred.';
  }
  const s = String(err).trim();
  return s || 'An unexpected error occurred.';
}

/** True when Vybe API responded 404 (e.g. /v4/trades not enabled for this key). */
export function isVybeApiNotFoundError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}

/** Deterministic swap/build failures — retrying won't help; move to the next route immediately. */
export function isNonRetryableSwapBuildError(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status != null && status >= 400 && status < 500 && status !== 429) return true;
    const body = err.response?.data as { details?: string; detail?: string; error?: string } | undefined;
    if (body && typeof body === 'object') {
      const detail = (body.details ?? body.detail ?? '').trim();
      if (detail && isNonRetryableSwapBuildErrorMessage(detail)) return true;
    }
  }
  const msg =
    err instanceof Error ? err.message : err != null ? String(err) : '';
  return isNonRetryableSwapBuildErrorMessage(msg);
}

function isNonRetryableSwapBuildErrorMessage(msg: string): boolean {
  if (!msg.trim()) return false;
  return (
    /insufficient liquidity in binarrays/i.test(msg) ||
    /failed to build dlmm swap/i.test(msg) ||
    /insufficientbalance/i.test(msg) ||
    /no routes found/i.test(msg) ||
    /no swap route found/i.test(msg) ||
    /token mints don't match/i.test(msg) ||
    /all pools failed/i.test(msg) ||
    /built tx missing expected pool/i.test(msg) ||
    /swap quote returned zero output/i.test(msg) ||
    /transaction too large/i.test(msg)
  );
}

/**
 * Run an async function with retries on error (2s delay, up to 3 retries).
 * @param fn - Function that performs one attempt
 * @returns Result of fn
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= VYBE_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isVybeApiNotFoundError(err) || isNonRetryableSwapBuildError(err)) throw err;
      if (attempt < VYBE_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, VYBE_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function vybeRequestHeaders(apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  return {
    ...(key ? { 'X-API-Key': key } : {}),
    Accept: 'application/json',
  };
}

/** Trading client (`VYBE_API_BASE`). Omits `X-API-Key` when key is empty (local Rust). */
export function createTradingHttpClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: VYBE_API_BASE,
    timeout: VYBE_TIMEOUT_MS,
    headers: vybeRequestHeaders(apiKey),
  });
}

/**
 * Generic Vybe client for a custom base URL.
 * @param requireKey - when true (default), throws if apiKey is empty
 */
export function createHttpClient(
  apiKey: string,
  baseURL: string = VYBE_API_BASE,
  requireKey = true,
): AxiosInstance {
  const key = apiKey.trim();
  if (requireKey && !key) {
    throw new Error('Vybe API key is required for this endpoint.');
  }
  return axios.create({
    baseURL,
    timeout: VYBE_TIMEOUT_MS,
    headers: vybeRequestHeaders(apiKey),
  });
}

/** Wallets, tokens, trades (`VYBE_DATA_API_BASE`) — always requires a key. */
export function createDataHttpClient(apiKey: string): AxiosInstance {
  return createHttpClient(apiKey, VYBE_DATA_API_BASE, true);
}

