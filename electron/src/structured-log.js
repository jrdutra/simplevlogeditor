'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safeError(error, seen = new Set()) {
  if (!error) return undefined;
  if (seen.has(error)) return { name: 'CircularError', message: 'Circular error cause omitted.' };
  seen.add(error);
  return {
    name: error.name,
    code: error.code,
    message: error.message ?? String(error),
    stack: typeof error.stack === 'string' ? error.stack.slice(0, 128_000) : undefined,
    stage: error.stage,
    exitCode: error.exitCode,
    signal: error.signal,
    stdout: typeof error.stdout === 'string' ? error.stdout.slice(0, 256_000) : undefined,
    stderr: typeof error.stderr === 'string' ? error.stderr.slice(0, 256_000) : undefined,
    details: error.details,
    cause: error.cause ? safeError(error.cause, seen) : undefined
  };
}

/*
 * stderr may belong to a process that is already gone.
 *
 * The editor window outlives the MCP session that opened it, and a pipe whose
 * reader has exited fails every later write with EPIPE — asynchronously, as an
 * 'error' event on the stream, which no try/catch around write() can catch.
 * Unhandled, Electron shows it as "A JavaScript error occurred in the main
 * process", once per log line. So the error is absorbed here, and once the
 * pipe is known to be broken this process stops writing to it; the log file,
 * when there is one, keeps everything.
 */
let stderrBroken = false;
function guardStream(stream) {
  if (!stream || stream.__sveGuarded) return;
  stream.__sveGuarded = true;
  stream.on('error', (error) => {
    if (stream === process.stderr) stderrBroken = true;
    if (error && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED' && error.code !== 'EOF') {
      // Anything else is still not worth a crash dialog for a log line.
    }
  });
}
guardStream(process.stderr);
guardStream(process.stdout);

/** JSON lines go to stderr and, when configured, a bounded append-only file. */
function createLogger(component, options = {}) {
  const file = options.file || process.env.SVE_MCP_LOG_FILE;
  const write = (level, event, fields = {}) => {
    const record = JSON.stringify({
      at: new Date().toISOString(), level, component, event,
      pid: process.pid, memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ...fields,
      ...(fields.error instanceof Error ? { error: safeError(fields.error) } : {})
    });
    if (!stderrBroken) {
      try { process.stderr.write(record + '\n'); } catch { stderrBroken = true; }
    }
    if (file) {
      try {
        const resolved = path.resolve(file);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        try {
          if (fs.statSync(resolved).size > 5 * 1024 * 1024) {
            try { fs.rmSync(`${resolved}.1`, { force: true }); } catch {}
            fs.renameSync(resolved, `${resolved}.1`);
          }
        } catch {}
        fs.appendFileSync(resolved, record + '\n', 'utf8');
      } catch {}
    }
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields)
  };
}

module.exports = { createLogger, safeError, guardStream };
