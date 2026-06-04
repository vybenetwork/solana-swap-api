/**
 * Download token logos to public/data/token-icons/ and return local web paths.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ICON_DIR = path.join(__dirname, '..', 'public', 'data', 'token-icons');
export const ICON_WEB_PREFIX = '/data/token-icons';

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(png|jpe?g|svg|webp|gif)$/i);
    if (m) {
      const ext = m[1].toLowerCase();
      return ext === 'jpeg' ? '.jpg' : `.${ext}`;
    }
  } catch {
    /* ignore */
  }
  return '.png';
}

function extFromContentType(ct) {
  const t = (ct ?? '').toLowerCase();
  if (t.includes('svg')) return '.svg';
  if (t.includes('webp')) return '.webp';
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  if (t.includes('gif')) return '.gif';
  return '.png';
}

function isLocalLogoUrl(url) {
  return typeof url === 'string' && url.startsWith(ICON_WEB_PREFIX);
}

function existingIconPath(mint) {
  if (!fs.existsSync(ICON_DIR)) return null;
  const files = fs.readdirSync(ICON_DIR);
  const prefix = `${mint}.`;
  const hit = files.find((f) => f === mint || f.startsWith(prefix));
  return hit ? `${ICON_WEB_PREFIX}/${hit}` : null;
}

export async function downloadTokenIcon(mint, remoteUrl, { force = false } = {}) {
  const m = String(mint ?? '').trim();
  if (!m) return '';

  const existing = existingIconPath(m);
  if (existing && !force) return existing;

  const url = String(remoteUrl ?? '').trim();
  if (!url || isLocalLogoUrl(url)) return existing ?? url;

  fs.mkdirSync(ICON_DIR, { recursive: true });

  try {
    const res = await fetch(url, {
      headers: { Accept: 'image/*,*/*;q=0.8', 'User-Agent': 'vybe-swap-demo/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.warn(`  skip ${m.slice(0, 8)}… HTTP ${res.status} ${url}`);
      return existing ?? '';
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) {
      console.warn(`  skip ${m.slice(0, 8)}… HTML response ${url}`);
      return existing ?? '';
    }
    const ext = extFromContentType(ct) || extFromUrl(url);
    const fileName = `${m}${ext}`;
    const filePath = path.join(ICON_DIR, fileName);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) {
      console.warn(`  skip ${m.slice(0, 8)}… tiny payload ${url}`);
      return existing ?? '';
    }
    fs.writeFileSync(filePath, buf);
    return `${ICON_WEB_PREFIX}/${fileName}`;
  } catch (err) {
    console.warn(`  skip ${m.slice(0, 8)}… ${err instanceof Error ? err.message : err}`);
    return existing ?? '';
  }
}

export async function localizeCatalogIcons(tokens, { force = false, concurrency = 6 } = {}) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  let done = 0;
  let failed = 0;

  async function work(token) {
    const mint = String(token.mint ?? token.id ?? '').trim();
    if (!mint) return token;
    const remote = String(token.logoUrl ?? token.icon ?? '').trim();
    const local = await downloadTokenIcon(mint, isLocalLogoUrl(remote) ? '' : remote, { force });
    if (local) {
      token.logoUrl = local;
      done += 1;
    } else if (remote) {
      failed += 1;
    }
    return token;
  }

  const out = [];
  for (let i = 0; i < tokens.length; i += concurrency) {
    const batch = tokens.slice(i, i + concurrency);
    out.push(...(await Promise.all(batch.map(work))));
  }
  return { tokens: out, downloaded: done, failed };
}
