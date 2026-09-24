'use strict';

const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

/**
 * One stable endpoint per user, whichever copy of the editor is running.
 *
 * Every MCP stdio adapter connects here, while the single Electron process
 * owns the server. The name used to be derived from the application folder,
 * which was fine while there was exactly one copy: the checkout. There are now
 * three — the installed application, the portable one, and the runtime that
 * ships inside the plugin — and an adapter from one copy must find a window
 * opened from another. They already share one single-instance lock (the lock
 * is per user data folder, and every copy has the same product name), so a
 * second copy cannot open a window of its own; if it could not find the first
 * one's pipe either, the adapter would wait for an editor that would never
 * answer. Keying the pipe on the user alone is what makes "the editor is
 * already open" a case that works rather than a case that times out.
 *
 * `SVE_EDITOR_ENDPOINT` pins a different name, which keeps a test or a second
 * isolated profile from joining the user's real editor.
 */
function editorEndpoint(environment = process.env) {
  if (environment.SVE_EDITOR_ENDPOINT) return environment.SVE_EDITOR_ENDPOINT;
  let user = 'user';
  try { user = os.userInfo().username || user; } catch { /* no passwd entry */ }
  const identity = `simple-vlog-editor\0${user.toLowerCase()}`;
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\simple-vlog-editor-${suffix}`
    : path.join(os.tmpdir(), `simple-vlog-editor-${process.getuid?.() ?? 'user'}-${suffix}.sock`);
}

module.exports = { editorEndpoint };
