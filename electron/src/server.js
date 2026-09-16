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
const { randomBytes } = require('node:crypto');
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
 * Starts the loopback server and resolves with its origin, actual port and
 * lifecycle methods. Production passes a remembered port so origin-scoped
 * browser storage survives relaunches; tests and development may still use 0.
 *
 * If a preferred port is occupied, the caller may allow a random fallback.
 */
function startServer(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const shell = path.join(root, 'index.html');
  const media = new Map();
  const mediaPrefix = `/__sve_media_${randomBytes(16).toString('hex')}/`;
  const preferredPort = Number.isInteger(options.port) ? options.port : 0;

  const server = http.createServer((req, res) => {
    isolate(res);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method Not Allowed');
      return;
    }

    const urlPath = (req.url ?? '/').split('?')[0].split('#')[0];

    if (urlPath.startsWith(mediaPrefix)) {
      const id = urlPath.slice(mediaPrefix.length).split('/')[0];
      const entry = media.get(id);
      if (!entry) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      sendMedia(req, res, entry).catch(() => {
        if (res.headersSent) res.destroy();
        else { res.statusCode = 500; res.end('Internal Server Error'); }
      });
      return;
    }

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

  const listen = (port) => new Promise((resolveListen, rejectListen) => {
    const failed = (error) => {
      server.removeListener('listening', ready);
      rejectListen(error);
    };
    const ready = () => {
      server.removeListener('error', failed);
      resolveListen();
    };
    server.once('error', failed);
    server.once('listening', ready);
    // A media request that never completes must not hold its socket for the
    // life of the application: the connection pool is what the next reader
    // needs back, and six abandoned ones is all it takes to stall everything.
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;
    server.requestTimeout = 0; // a large range legitimately takes minutes
    server.listen(port, '127.0.0.1');
  });

  return (async () => {
    let usedFallback = false;
    try {
      await listen(preferredPort);
    } catch (error) {
      if (preferredPort === 0 || error.code !== 'EADDRINUSE' || options.fallbackToRandom === false) throw error;
      usedFallback = true;
      await listen(0);
    }

    const address = server.address();
    return {
      origin: `http://127.0.0.1:${address.port}`,
      port: address.port,
      preferredPort,
      usedFallback,
      registerMedia(file, stat, type) {
        const id = randomBytes(18).toString('base64url');
        media.set(id, { file, stat, type });
        return `http://127.0.0.1:${address.port}${mediaPrefix}${id}/${encodeURIComponent(path.basename(file))}`;
      },
      releaseMedia(url) {
        try {
          const pathname = new URL(url).pathname;
          if (pathname.startsWith(mediaPrefix)) media.delete(pathname.slice(mediaPrefix.length).split('/')[0]);
        } catch {}
      },
      close: () => new Promise((done) => server.close(() => done()))
    };
  })();
}

async function sendMedia(req, res, entry) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const size = entry.stat.size;
  const rawRange = req.headers.range;
  let start = 0;
  let end = Math.max(0, size - 1);
  if (rawRange) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
    if (!match) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); res.end(); return; }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
    if (start > end || start >= size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); res.end(); return; }
    end = Math.min(end, size - 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else res.statusCode = 200;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', entry.type || TYPES.get(path.extname(entry.file).toLowerCase()) || 'application/octet-stream');
  res.setHeader('Content-Length', Math.max(0, end - start + 1));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }

  /*
   * The stream dies with the response, explicitly.
   *
   * A client that stops reading without closing — a video element torn down
   * mid-seek, a decoder that gave up — leaves this request open, and with it a
   * socket and a file handle. Chrome allows six connections to this origin, so
   * a few of those and the next request for the same file never gets a reply:
   * `readyState 0`, `networkState 2`, nothing buffered, no error. That has now
   * been seen twice, from a frame grab and from an export.
   *
   * `pipeline` tears down on error, but an abandoned response is not an error
   * until something notices. This notices.
   */
  const stream = fs.createReadStream(entry.file, { start, end });
  const stopReading = () => stream.destroy();
  res.once('close', stopReading);
  try {
    await pipeline(stream, res);
  } finally {
    res.removeListener('close', stopReading);
    if (!stream.destroyed) stream.destroy();
  }
}

module.exports = { startServer };
