import type { NextFunction, Request, Response } from 'express';

/** Letters and digits only, so the value can be a single root filename. */
const ROOT_TEXT_KEY_RE = /^[A-Za-z0-9]+$/;

/** The root text key, or null when ROOT_TEXT_KEY is empty. */
export function rootTextKey(): string | null {
  const key = (process.env.ROOT_TEXT_KEY ?? '').trim();
  return ROOT_TEXT_KEY_RE.test(key) ? key : null;
}

/** Serve /{ROOT_TEXT_KEY}.txt when the env value is set. Otherwise this route is absent. */
export function serveRootKeyFile() {
  return function rootKeyFile(req: Request, res: Response, next: NextFunction): void {
    const key = rootTextKey();
    if (!key) {
      next();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.path !== `/${key}.txt`) {
      next();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(key);
  };
}
