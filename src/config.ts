/**
 * Application configuration: env loading, API base URL, and constants.
 * All Vybe API base URLs and timeouts live here — no magic strings in api/ or server.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

/** Load .env before any env-backed constants below (import order must not matter). */
dotenv.config({ path: path.join(projectRoot, '.env') });

/** Load .env from project root. Idempotent; call at startup if needed. */
export function loadEnv(): void {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

/** API key for `VYBE_API_BASE` (swap quote/build). May be empty for local Rust with permissions off. */
export function getTradingApiKey(): string {
  return (process.env.VYBE_API_KEY ?? '').trim();
}

/**
 * API key for `VYBE_DATA_API_BASE` (wallets, tokens, trades).
 * Uses `VYBE_DATA_API_KEY` when set, otherwise falls back to `VYBE_API_KEY`.
 */
export function getDataApiKey(): string {
  const dataKey = (process.env.VYBE_DATA_API_KEY ?? '').trim();
  if (dataKey) return dataKey;
  const tradingKey = getTradingApiKey();
  if (tradingKey) return tradingKey;
  throw new Error(
    'VYBE_DATA_API_KEY is required (or set VYBE_API_KEY as fallback). Get a key at https://vybe.fyi/api-pricing'
  );
}

/** @deprecated Use getTradingApiKey / getDataApiKey */
export function getApiKey(): string {
  return getDataApiKey();
}

/** Vybe API base URL (no trailing slash). Override for local Vybe / prod-like proxy testing. */
export const VYBE_API_BASE = (
  process.env.VYBE_API_BASE ?? 'https://api.vybenetwork.xyz'
)
  .trim()
  .replace(/\/$/, '');

/**
 * Vybe API for wallets, tokens, and trades when `VYBE_API_BASE` is local Rust/proxy.
 * Trading (swap quote/build) uses `VYBE_API_BASE`; everything else defaults to prod Vybe.
 */
export const VYBE_DATA_API_BASE = (
  process.env.VYBE_DATA_API_BASE ?? 'https://api.vybenetwork.xyz'
)
  .trim()
  .replace(/\/$/, '');

/** Debug assets source: GET /api/assets/:wallet. Set ASSETS_API_BASE in .env (required). */
export const ASSETS_API_BASE = (process.env.ASSETS_API_BASE ?? '').trim().replace(/\/$/, '');

/** Request timeout for Vybe API calls (ms). */
export const VYBE_TIMEOUT_MS = 60_000;

/** Max retries for backend calls before failing (total attempts = this + 1). */
export const VYBE_MAX_RETRIES = 2;

/** Delay between retries (ms). */
export const VYBE_RETRY_DELAY_MS = 250;

/** Path to public static assets (for Express). */
export const PUBLIC_DIR = path.join(projectRoot, 'public');

const PUBLIC_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** Resolve Solana RPC: explicit URL → Helius key → public mainnet. */
export function resolveSolanaRpcUrl(): string {
  const explicit = (process.env.SOLANA_RPC_URL ?? '').trim();
  if (explicit) return explicit;
  const heliusKey = (process.env.HELIUS_API_KEY ?? '').trim();
  if (heliusKey) return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  return PUBLIC_SOLANA_RPC_URL;
}

/** Solana JSON-RPC endpoint for on-chain account checks. */
export const SOLANA_RPC_URL = resolveSolanaRpcUrl();

/** Startup label — never includes API keys. */
export function getSolanaRpcProviderLabel(): string {
  if ((process.env.SOLANA_RPC_URL ?? '').trim()) return 'custom (SOLANA_RPC_URL)';
  if ((process.env.HELIUS_API_KEY ?? '').trim()) return 'Helius';
  return 'public mainnet';
}

/** Minimum SOL to pay fees + ATA rent when selling SPL tokens (non-gasless). */
export const SOL_MIN_TX_FEE_BALANCE_UI = 0.006;

/** Default service/protocol fee percent on swap build (0 = none). UI uses whole percent. */
export const DEFAULT_SWAP_SERVICE_FEE_PCT = 0;

/** Default slippage tolerance percent when the client does not specify one. */
export const DEFAULT_SWAP_SLIPPAGE_PCT = 5;

function parseEnvBool(raw: string | undefined, defaultValue: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return defaultValue;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

/** Show inline "Get quote blocked" debug meta under the quote button (default: off). */
export function isSwapQuoteBtnDebugEnabled(): boolean {
  return parseEnvBool(process.env.ENABLE_SWAP_QUOTE_BTN_DEBUG, false);
}

/** Optional JWT for pump.fun API (`Authorization: Bearer …`). */
export function getPumpfunAuthToken(): string | undefined {
  const token = (process.env.PUMPFUN_AUTH_TOKEN ?? '').trim();
  return token || undefined;
}

/** Optional path to JSON file with extra pump.fun request headers (Cookie, etc.). */
export function getPumpfunHeadersPath(): string | undefined {
  const raw = (process.env.PUMPFUN_HEADERS_PATH ?? '').trim();
  return raw || undefined;
}

/** Axios proxy config when both PROXY_HOST and PROXY_AUTH are set; otherwise direct. */
export function getHttpProxyConfig():
  | { host: string; port: number; auth: { username: string; password: string }; protocol: 'http' }
  | undefined {
  const hostRaw = (process.env.PROXY_HOST ?? '').trim();
  const authRaw = (process.env.PROXY_AUTH ?? '').trim();
  if (!hostRaw || !authRaw) return undefined;

  const colonIdx = authRaw.indexOf(':');
  if (colonIdx <= 0) return undefined;

  const [hostname, portStr] = hostRaw.includes(':')
    ? hostRaw.split(':', 2)
    : [hostRaw, '80'];
  const port = Number(portStr) || 80;

  return {
    host: hostname,
    port,
    auth: {
      username: authRaw.slice(0, colonIdx),
      password: authRaw.slice(colonIdx + 1),
    },
    protocol: 'http',
  };
}

/** Full proxy URL for undici ProxyAgent (`http://user:pass@host:port`). */
export function getHttpProxyUrl(): string | undefined {
  const cfg = getHttpProxyConfig();
  if (!cfg) return undefined;
  const { username, password } = cfg.auth;
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${cfg.host}:${cfg.port}`;
}

const HTTP_PROXY_POOL_SIZE_MAX = 10;

/** Concurrent proxy dispatchers to warm (1–10). Default 10 when proxy is configured. */
export function getHttpProxyPoolSize(): number {
  const raw = Number(process.env.HTTP_PROXY_POOL_SIZE ?? HTTP_PROXY_POOL_SIZE_MAX);
  const n = Number.isFinite(raw) ? Math.floor(raw) : HTTP_PROXY_POOL_SIZE_MAX;
  return Math.min(HTTP_PROXY_POOL_SIZE_MAX, Math.max(1, n));
}

/** Skip startup Jupiter / pump.fun connection warmup when false. */
export function isHttpProxyWarmupEnabled(): boolean {
  return parseEnvBool(process.env.HTTP_PROXY_WARMUP, true);
}

/**
 * Quote-bridge hop pairs to skip during route discovery (comma-separated).
 * Keys use short protocol slugs joined by `-`, e.g. `damm2-damm2`, `ammv4-ammv4`.
 */
export function getDisabledQuoteBridgeHopCombos(): ReadonlySet<string> {
  const raw = (process.env.DISABLED_QUOTE_BRIDGE_HOP_COMBOS ?? '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

