'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sve-mcp-lifecycle-'));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-host.js')], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, SVE_CONTROLLER: 'codex', SVE_MCP_ROOTS: scratch },
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true
});

let sequence = 0;
let buffer = '';
const pending = new Map();
const timer = setTimeout(() => {
  child.kill();
  for (const settle of pending.values()) settle.reject(new Error('Lifecycle smoke test timed out.'));
  pending.clear();
}, 90_000);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const settle = pending.get(message.id);
    if (!settle) continue;
    pending.delete(message.id);
    if (message.error) settle.reject(new Error(message.error.message));
    else if (message.result?.isError) settle.reject(new Error(message.result.content?.[0]?.text || 'MCP tool failed.'));
    else settle.resolve(message.result);
  }
});

function request(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function tool(name, args = {}) {
  return request('tools/call', { name, arguments: args }).then((reply) => reply.structuredContent);
}

(async () => {
  await request('initialize', { protocolVersion: '2025-06-18' });
  const before = (await tool('get_diagnostics')).result;
  const checkpoint = (await tool('checkpoint_project')).result;
  const recovery = (await tool('get_recovery_state')).result;
  if (!recovery.exists || recovery.path !== checkpoint.path) throw new Error('Recovery checkpoint was not written.');

  const restarted = (await tool('restart_editor')).result;
  const after = (await tool('get_diagnostics')).result;
  if (!restarted.restarted) throw new Error('Restart was not acknowledged.');
  if (!after.electronPid || after.electronPid === before.electronPid) throw new Error('Electron PID did not change after restart.');
  if (after.windowCount !== 1) throw new Error(`Expected one visible editor window after restart, got ${after.windowCount}.`);

  const closed = (await tool('close_editor')).result;
  if (!closed.closing) throw new Error('Close was not acknowledged.');
  clearTimeout(timer);
  child.stdin.end();
  process.stdout.write(JSON.stringify({
    ok: true,
    beforePid: before.electronPid,
    afterPid: after.electronPid,
    windowCount: after.windowCount,
    recoveryPath: recovery.path,
    closed: true
  }) + '\n');
})().catch((error) => {
  clearTimeout(timer);
  child.kill();
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
