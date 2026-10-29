import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';

/** A complete GA4 measurement ID is G- plus 10 letters or digits. */
const GA_MEASUREMENT_ID_RE = /^G-[A-Z0-9]{10}$/;

export function googleMeasurementId(): string | null {
  const id = (process.env.GA_MEASUREMENT_ID ?? '').trim();
  return GA_MEASUREMENT_ID_RE.test(id) ? id : null;
}

/** Empty unless GA_MEASUREMENT_ID is a complete measurement ID. */
export function googleTagSnippet(): string {
  const id = googleMeasurementId();
  if (!id) return '';
  return `<!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());

      gtag('config', '${id}');
    </script>`;
}

export function injectGoogleTag(html: string): string {
  const snippet = googleTagSnippet();
  if (!snippet) return html;
  if (html.includes('googletagmanager.com/gtag/js')) return html;
  const head = html.match(/<head[^>]*>/i);
  if (!head || head.index === undefined) return html;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}\n    ${snippet}${html.slice(at)}`;
}

function sendIndex(publicDir: string, res: Response, next: NextFunction): void {
  fs.readFile(path.join(publicDir, 'index.html'), 'utf8', (err, html) => {
    if (err) {
      next(err);
      return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.type('html').send(injectGoogleTag(html));
  });
}

/** Serve / and /index.html with the Google tag inserted only when the env ID is complete. */
export function serveIndexWithGoogleTag(publicDir: string) {
  return function googleTagIndex(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.path !== '/' && req.path !== '/index.html') {
      next();
      return;
    }
    sendIndex(publicDir, res, next);
  };
}

export function sendIndexHtml(publicDir: string, res: Response, next: NextFunction): void {
  sendIndex(publicDir, res, next);
}
