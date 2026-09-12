'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

function session() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-host.js')], {
      cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true
    });
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP smoke test timed out.')); }, 45_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== 2) continue;
        clearTimeout(timer);
        child.stdin.end();
        if (message.result?.isError) reject(new Error(message.result.content?.[0]?.text || 'MCP error'));
        else resolve(message.result.structuredContent.result);
      }
    });
    child.once('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_diagnostics', arguments: {} } }) + '\n');
  });
}

(async () => {
  const first = await session();
  const second = await session();
  if (!first.electronPid || first.electronPid !== second.electronPid) throw new Error('MCP adapters did not reuse one Electron process.');
  if (first.windowCount !== 1 || second.windowCount !== 1) throw new Error(`Expected one window, got ${first.windowCount} and ${second.windowCount}.`);
  process.stdout.write(JSON.stringify({ ok: true, electronPid: first.electronPid, windowCount: second.windowCount, protocolVersion: second.protocolVersion }) + '\n');
})().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
