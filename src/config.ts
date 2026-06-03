/**
 * Application configuration: env loading, API base URL, and constants.
 * All Vybe API base URLs and timeouts live here — no magic strings in api/ or server.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

/** Load .env from project root. Call once at startup. */
export function loadEnv(): void {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

/**
 * Get Vybe API key from env. Throws if missing.
 * @returns The trimmed VYBE_API_KEY value
 */
export function getApiKey(): string {
  const key = (process.env.VYBE_API_KEY ?? '').trim();
  if (!key) {
    throw new Error(
      'VYBE_API_KEY is required. Copy .env.example to .env and add your key from https://vybenetwork.com/pricing'
    );
  }
  return key;
}

/** Vybe API base URL (no trailing slash). */
export const VYBE_API_BASE = 'https://api.vybenetwork.xyz';

/** Request timeout for Vybe API calls (ms). */
export const VYBE_TIMEOUT_MS = 60_000;

/** Max retries for backend calls before failing (total attempts = this + 1). */
export const VYBE_MAX_RETRIES = 3;

/** Delay between retries (ms). */
export const VYBE_RETRY_DELAY_MS = 2000;

/** Path to public static assets (for Express). */
export const PUBLIC_DIR = path.join(projectRoot, 'public');

