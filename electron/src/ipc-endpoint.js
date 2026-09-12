'use strict';

const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

/**
 * A stable per-install endpoint. Every MCP stdio adapter connects here, while
 * the single Electron process owns the server. A stable name is what lets a
 * freshly started adapter reconnect to an editor that is already open.
 */
function editorEndpoint(appRoot = path.join(__dirname, '..')) {
  const identity = `${path.resolve(appRoot).toLowerCase()}\0${os.userInfo().username}`;
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\simple-vlog-editor-${suffix}`
    : path.join(os.tmpdir(), `simple-vlog-editor-${process.getuid?.() ?? 'user'}-${suffix}.sock`);
}

module.exports = { editorEndpoint };
