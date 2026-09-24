'use strict';

/**
 * Stands in for the editor's `mcp-host.js` inside a fake runtime, so the
 * launcher can be tested end to end on any machine without Electron.
 *
 * Behaviour switches, from the environment:
 *   FAKE_EXIT_AFTER_INIT=<code>   exit with that code right after answering initialize
 *   FAKE_IGNORE_STDIN_END=1       keep running after stdin closes (an unresponsive host)
 */

const readline = require('node:readline');

process.stderr.write(`fake-host: started pid=${process.pid} args=${JSON.stringify(process.argv.slice(2))} runAsNode=${process.env.ELECTRON_RUN_AS_NODE || ''} controller=${process.env.SVE_CONTROLLER || ''}\n`);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const tools = Array.from({ length: 24 }, (_, index) => ({ name: index === 0 ? 'health_check' : `fake_tool_${index}`, inputSchema: { type: 'object' } }));

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  process.stderr.write(`fake-host: <- ${message.method || 'reply'}\n`);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'simple-vlog-editor', version: 'fake' } } });
    if (process.env.FAKE_EXIT_AFTER_INIT) setTimeout(() => process.exit(Number(process.env.FAKE_EXIT_AFTER_INIT)), 50);
    return;
  }
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  if (message.method === 'tools/call') {
    const result = { apiVersion: 2, projectRevision: 0, result: { state: 'ready', hostPid: process.pid, controller: process.env.SVE_CONTROLLER, argv: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE || null } };
    return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } });
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});
input.on('close', () => {
  process.stderr.write('fake-host: stdin closed\n');
  if (process.env.FAKE_IGNORE_STDIN_END === '1') { setInterval(() => {}, 1000); return; }
  setTimeout(() => process.exit(0), 50);
});
