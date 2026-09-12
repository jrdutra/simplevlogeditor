#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const inferredProjectRoot = path.resolve(scriptDir, '..', '..', '..', '..', '..');
const projectRoot = process.env.SVE_EDITOR_PROJECT_ROOT
  ? path.resolve(process.env.SVE_EDITOR_PROJECT_ROOT)
  : inferredProjectRoot;

const checks = [
  ['plugin manifest', path.join(pluginRoot, '.codex-plugin', 'plugin.json')],
  ['MCP manifest', path.join(pluginRoot, '.mcp.json')],
  ['Electron MCP host', path.join(projectRoot, 'electron', 'src', 'mcp-host.js')],
  ['Electron dependency', path.join(projectRoot, 'electron', 'node_modules', 'electron', 'package.json')],
  ['WEB bundle', path.join(projectRoot, 'web', 'dist', 'browser', 'index.html')]
];

let healthy = true;
for (const [label, target] of checks) {
  const exists = fs.existsSync(target);
  healthy &&= exists;
  process.stdout.write(`${exists ? 'OK  ' : 'FAIL'} ${label}: ${target}\n`);
}

const serverTest = spawnSync(process.execPath, ['--test', 'src/mcp-server.test.js'], {
  cwd: path.join(projectRoot, 'electron'),
  encoding: 'utf8',
  windowsHide: true
});
healthy &&= serverTest.status === 0;
process.stdout.write(`${serverTest.status === 0 ? 'OK  ' : 'FAIL'} MCP protocol tests\n`);
if (serverTest.status !== 0) process.stderr.write(serverTest.stderr || serverTest.stdout || 'MCP tests failed.\n');

process.exitCode = healthy ? 0 : 1;
