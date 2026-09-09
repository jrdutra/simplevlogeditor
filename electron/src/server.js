/**
 * The site, served to the window over loopback.
 *
 * Loading the built site from `file://` would be simpler and wrong: the tools
 * decode video in workers and run ONNX Runtime with threads, and a browser only
 * hands out `SharedArrayBuffer` to a cross-origin isolated document — which
 * means an origin, and the two isolation headers on every response. So the same
 * three rules `web/server.ts` follows in production are followed here:
 *
 *   1. `Cross-Origin-Opener-Policy: same-origin` and
 *      `Cross-Origin-Embedder-Policy: require-corp` on everything.
 *   2. A real 404 for a missing file. Answering `ort-wasm-simd-threaded.wasm`
 *      with `index.html` and a 200 makes the runtime report a bad WebAssembly
 *      magic word instead of a missing file.
 *   3. Only a path with no file extension falls back to the app shell, because
 *      that is a route, not an asset.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}));

/** A build output name carries its own hash, so it can be cached forever. */
const HASHED = /-[A-Z0-9]{8}\.(?:js|css)$/;

function isolate(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

async function statFile(candidate) {
  try {
    const info = await fsp.stat(candidate);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/**
 * Where a request lands on disk, or null when nothing does.
 *
 * The path is resolved inside the root and then checked against it again: a
 * request is untrusted input even when the only thing that can make one is the
 * window we opened ourselves.
 */
async function resolve(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  const direct = await statFile(target);
  if (direct) return { file: target, stat: direct };

  const index = path.join(target, 'index.html');
  const nested = await statFile(index);
  if (nested) return { file: index, stat: nested };

  return null;
}

async function send(res, file, stat, status = 200) {
  const extension = path.extname(file).toLowerCase();
  res.statusCode = status;
  res.setHeader('Content-Type', TYPES.get(extension) ?? 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Cache-Control',
    HASHED.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'no-cache'
  );
  await pipeline(fs.createReadStream(file), res);
}

/**
 * Starts the loopback server and resolves with `{ origin, close }`.
 *
 * Port 0: the operating system picks a free one, so two copies of the app can
 * run at once and nothing on the machine is ever displaced.
 */
function startServer(rootDir) {
  const root = path.resolve(rootDir);
  const shell = path.join(root, 'index.html');

  const server = http.createServer((req, res) => {
    isolate(res);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method Not Allowed');
      return;
    }

    const urlPath = (req.url ?? '/').split('?')[0].split('#')[0];

    resolve(root, urlPath)
      .then(async (found) => {
        if (found) return send(res, found.file, found.stat);

        // No extension means a route the router knows and the prerender did not
        // write out. Anything else is a missing file and is told so.
        if (path.extname(urlPath)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not Found');
          return;
        }

        const stat = await statFile(shell);
        if (!stat) {
          res.statusCode = 500;
          res.end('The site build is missing. Run "npm run build:web" first.');
          return;
        }
        await send(res, shell, stat);
      })
      .catch(() => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.statusCode = 500;
        res.end('Internal Server Error');
      });
  });

  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveStart({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

module.exports = { startServer };
