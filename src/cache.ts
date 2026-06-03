/**
 * Persistent JSON cache for symbol lookups.
 * Read from disk before each request; write to disk when a new record is added.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SYMBOL_CACHE_PATH = path.join(DATA_DIR, 'symbol-cache.json');

let cachePathsLogged = false;
function logCachePathsOnce(): void {
  if (cachePathsLogged) return;
  cachePathsLogged = true;
  console.log('Cache files (data/):');
  console.log('  symbol:', SYMBOL_CACHE_PATH);
}

function readJsonFile<T>(filePath: string, defaultVal: T): T {
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as T;
    return parsed != null && typeof parsed === 'object' ? parsed : defaultVal;
  } catch {
    return defaultVal;
  }
}

function writeJsonFile(filePath: string, data: object): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
}

export function readSymbolCacheFromDisk(): Record<string, string> {
  logCachePathsOnce();
  return readJsonFile<Record<string, string>>(SYMBOL_CACHE_PATH, {});
}

export function writeSymbolCacheToDisk(data: Record<string, string>): void {
  writeJsonFile(SYMBOL_CACHE_PATH, data);
}
