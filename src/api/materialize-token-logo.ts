/**
 * Download remote token logos onto the server and return local /cached paths only.
 */

import {
  ensureTokenIconCached,
  getCachedTokenIconWebPath,
  hasCachedTokenIcon,
  isLocalCachedIconUrl,
  readTokenMetaCache,
  writeTokenMetaCache,
} from '../token-icon-cache.js';

function persistLocalLogoOnMeta(mint: string, localPath: string): void {
  const cache = readTokenMetaCache();
  const entry = cache[mint];
  if (!entry) return;
  if (entry.logoUrl === localPath) return;
  entry.logoUrl = localPath;
  writeTokenMetaCache(cache);
}

/**
 * Ensure the mint has a locally served icon. Downloads `remoteOrLocal` when it is a
 * remote URL. Always returns a local path or null — never a remote CDN URL.
 */
export async function materializeTokenLogoLocal(
  mint: string,
  remoteOrLocal?: string | null,
): Promise<string | null> {
  const m = mint.trim();
  if (!m) return null;

  if (hasCachedTokenIcon(m)) {
    const existing = getCachedTokenIconWebPath(m) ?? null;
    if (existing) {
      persistLocalLogoOnMeta(m, existing);
      return existing;
    }
  }

  const hint = String(remoteOrLocal ?? '').trim();
  if (isLocalCachedIconUrl(hint)) return hint;

  if (hint) {
    const local = await ensureTokenIconCached(m, hint);
    if (local) {
      persistLocalLogoOnMeta(m, local);
      return local;
    }
  }

  return null;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export type LogoMaterializeItem = {
  mintAddress: string;
  logoUrl: string | null;
  valueUsd?: number;
};

/**
 * Download logos for items that still need a local icon.
 * Strips any remaining remote URLs so clients never load external CDNs.
 */
export async function materializeItemLogosLocal<T extends LogoMaterializeItem>(
  items: T[],
  options?: {
    limit?: number;
    concurrency?: number;
  },
): Promise<T[]> {
  const limit = Math.max(0, options?.limit ?? items.length);
  const concurrency = Math.max(1, options?.concurrency ?? 8);

  const ranked = [...items].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  const needDownload = ranked
    .filter((item) => {
      if (hasCachedTokenIcon(item.mintAddress)) return false;
      const logo = item.logoUrl?.trim() || '';
      if (isLocalCachedIconUrl(logo)) return false;
      return Boolean(logo);
    })
    .slice(0, limit);

  const localByMint = new Map<string, string | null>();
  await mapPool(needDownload, concurrency, async (item) => {
    const local = await materializeTokenLogoLocal(item.mintAddress, item.logoUrl);
    localByMint.set(item.mintAddress, local);
    return local;
  });

  return items.map((item) => {
    if (hasCachedTokenIcon(item.mintAddress)) {
      const local =
        getCachedTokenIconWebPath(item.mintAddress) ?? localByMint.get(item.mintAddress) ?? null;
      return { ...item, logoUrl: local };
    }
    if (localByMint.has(item.mintAddress)) {
      return { ...item, logoUrl: localByMint.get(item.mintAddress) ?? null };
    }
    const logo = item.logoUrl?.trim() || null;
    return { ...item, logoUrl: isLocalCachedIconUrl(logo) ? logo : null };
  });
}
