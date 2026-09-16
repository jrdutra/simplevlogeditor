import { APP_BASE_HREF } from '@angular/common';
import { CommonEngine } from '@angular/ssr';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import bootstrap from './src/main.server';

const CANONICAL_HOST = 'simplevlogeditor.com';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHost(host: string | undefined): string {
  return (host ?? '').split(',')[0].trim().split(':')[0].toLowerCase();
}

function normalizeProtocol(protocol: string | string[] | undefined): string {
  const value = Array.isArray(protocol) ? protocol[0] : protocol;
  return (value ?? '').split(',')[0].trim().toLowerCase();
}

export function app(): express.Express {
  const server = express();
  const serverDistFolder = dirname(fileURLToPath(import.meta.url));
  const browserDistFolder = resolve(serverDistFolder, '../browser');
  const indexHtml = join(serverDistFolder, 'index.server.html');

  const commonEngine = new CommonEngine();

  server.set('trust proxy', true);
  server.set('view engine', 'html');
  server.set('views', browserDistFolder);

  /*
   * The version manifest is the one address that must answer on whatever host
   * it was asked of. The desktop application and the AI plugins fetch it at
   * startup to find out whether they are current; a 301 to the canonical host
   * turns that into a redirect the simplest possible client has to follow, and
   * the check is not worth a redirect. Exempted before the canonical rules
   * below, and nothing else is.
   */
  server.use((req, res, next) => {
    if (req.path === '/currentversion' || req.path === '/currentversion.json') {
      res.type('application/json');
      // Short, because it is read on every start and a stale answer delays an
      // update notice by minutes at most.
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.sendFile(join(browserDistFolder, 'currentversion'));
      return;
    }
    next();
  });

  server.use((req, res, next) => {
    const host = normalizeHost(req.get('x-forwarded-host') ?? req.get('host'));
    const isLocal = !host || LOCAL_HOSTS.has(host);

    // Canonical host and HTTPS, skipped on localhost. www.* lands on the apex.
    if (!isLocal) {
      const protocol = normalizeProtocol(req.get('x-forwarded-proto') ?? req.protocol);
      if (host !== CANONICAL_HOST || protocol !== 'https') {
        res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
        return;
      }
    }

    // One URL shape: no trailing slash, except the root.
    const [pathOnly, query] = req.originalUrl.split('?');
    if (pathOnly.length > 1 && pathOnly.endsWith('/')) {
      const stripped = pathOnly.replace(/\/+$/, '') || '/';
      const target = query ? `${stripped}?${query}` : stripped;
      res.redirect(301, isLocal ? target : `https://${CANONICAL_HOST}${target}`);
      return;
    }

    next();
  });

  /*
   * The media tools decode video with WebCodecs inside workers and, for noise
   * removal, run ONNX Runtime with threads. SharedArrayBuffer is what makes the
   * threaded build usable, and browsers only hand it to a cross-origin isolated
   * document — which is these two headers and nothing else.
   */
  server.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });

  server.get('*.*', express.static(browserDistFolder, { maxAge: '1y' }));

  server.get('*', (req, res, next) => {
    const { protocol, originalUrl, baseUrl, headers } = req;

    commonEngine
      .render({
        bootstrap,
        documentFilePath: indexHtml,
        url: `${protocol}://${headers.host}${originalUrl}`,
        publicPath: browserDistFolder,
        providers: [{ provide: APP_BASE_HREF, useValue: baseUrl }],
      })
      .then((html) => res.send(html))
      .catch((err) => next(err));
  });

  return server;
}

function run(): void {
  const port = process.env['PORT'] || 4000;
  const server = app();
  server.listen(port, () => {
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

run();
