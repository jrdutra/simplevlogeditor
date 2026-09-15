#!/usr/bin/env node

/**
 * Checks everything the plugin needs, and says what to run for whatever is
 * missing.
 *
 * Worth knowing before reading: Claude Code **copies** a plugin into
 * `~/.claude/plugins/cache` when it installs it. After that, nothing about the
 * plugin's own location points back at the repository — so the launcher finds
 * the editor through the record this doctor writes under LOCALAPPDATA, or
 * through `SVE_EDITOR_PROJECT_ROOT`, or by walking up from wherever Claude Code
 * was started. Running this once from the repository is what makes the first
 * two work, which is why the install script runs it before installing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, rememberProjectRoot } from './editor-location.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const skipTests = process.argv.includes('--skip-tests');

const results = [];
const pass = (label, detail = '') => results.push({ ok: true, label, detail });
const fail = (label, remedy, detail = '') => results.push({ ok: false, label, remedy, detail });

process.stdout.write('\nSimpleVlogEditor — Claude Code plugin doctor\n\n');

const projectRoot = findProjectRoot({ scriptDir });
if (!projectRoot) {
  process.stdout.write(
    'FAIL  SimpleVlogEditor was not found.\n\n' +
    '      The plugin looks for a folder containing electron\\src\\mcp-host.js, in this order:\n' +
    '        1. the SVE_EDITOR_PROJECT_ROOT environment variable\n' +
    '        2. the location recorded by this doctor or by a previous editor launch\n' +
    '        3. the folder Claude Code was started in, and its parents\n' +
    '        4. the plugin folder and its parents\n\n' +
    '      Run this doctor from inside the repository:\n' +
    '        node .\\ai-client\\claude\\plugins\\simple-vlog-editor\\scripts\\doctor.mjs\n\n' +
    '      Or set the variable and try again:\n' +
    '        $env:SVE_EDITOR_PROJECT_ROOT = "C:\\path\\to\\simplevlogeditor"\n\n'
  );
  process.exit(1);
}
pass('SimpleVlogEditor found', projectRoot);

/*
 * Registered as soon as the project is found, and deliberately not held back
 * until every other check passes. A build that has not been made yet is a
 * reason to run one command, not a reason to withhold the one piece of state
 * the installed plugin cannot work without — and holding it back was exactly
 * what left a freshly installed plugin unable to find the editor.
 */
try {
  const registeredAt = await rememberProjectRoot(projectRoot);
  pass('editor location registered', registeredAt);
} catch (error) {
  fail('editor location could not be registered',
    'Check that %LOCALAPPDATA% is writable, or set SVE_EDITOR_PROJECT_ROOT in the environment Claude Code runs in.',
    error.message);
}

const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const servers = manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {};
  if (servers['simple-vlog-editor']) pass('MCP server declared in plugin.json', `version ${manifest.version}`);
  else fail('plugin.json does not declare the simple-vlog-editor MCP server',
    'Restore the mcpServers block in .claude-plugin/plugin.json.');
} catch (error) {
  fail('plugin.json could not be read', `Check ${manifestPath}.`, error.message);
}

const files = [
  ['MCP launcher', path.join(pluginRoot, 'scripts', 'mcp-launcher.mjs'),
    'Reinstall the plugin; scripts/mcp-launcher.mjs is missing.'],
  ['editing skill', path.join(pluginRoot, 'skills', 'edit-video', 'SKILL.md'),
    'Reinstall the plugin; skills/edit-video/SKILL.md is missing.'],
  ['Electron MCP host', path.join(projectRoot, 'electron', 'src', 'mcp-host.js'),
    'This does not look like a SimpleVlogEditor checkout.'],
  ['Electron dependencies', path.join(projectRoot, 'electron', 'node_modules', 'electron', 'package.json'),
    `npm install          (in ${path.join(projectRoot, 'electron')})`],
  ['web bundle', path.join(projectRoot, 'web', 'dist', 'browser', 'index.html'),
    `npm run build:site   (in ${path.join(projectRoot, 'web')})`]
];
for (const [label, target, remedy] of files) {
  if (fs.existsSync(target)) pass(label);
  else fail(label, remedy, target);
}

/*
 * The roots decide whether any media path is reachable at all. Reported here
 * because the symptom of getting them wrong — every path refused as "outside
 * the allowed roots" — reads like a permission fault rather than a setting.
 */
try {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { RootStore } = require(path.join(projectRoot, 'electron', 'src', 'mcp-roots.js'));
  // The editor asks Electron where the user's media folders are; this runs
  // outside Electron, so the same folders are named from the home directory.
  const home = os.homedir();
  const named = { videos: 'Videos', pictures: 'Pictures', music: 'Music', downloads: 'Downloads', desktop: 'Desktop', documents: 'Documents' };
  const store = new RootStore({
    getPath: (name) => (named[name] ? path.join(home, named[name]) : null),
    projectRoot
  });
  const roots = store.roots();
  if (!roots.length) {
    fail('allowed folders', 'Open the editor and add a folder under Allowed folders in the project settings.', store.notice());
  } else if (store.overridden) {
    pass('allowed folders', `${roots.join(path.delimiter)} (SVE_MCP_ROOTS is set, so the defaults stand down)`);
  } else {
    pass('allowed folders', `${roots.length} folder${roots.length === 1 ? '' : 's'}, starting with ${roots[0]}`);
  }
} catch (error) {
  fail('allowed folders could not be determined',
    'Check that electron/src/mcp-roots.js exists in the editor checkout.', error.message);
}

const launcher = spawnSync(process.execPath, [path.join(scriptDir, 'mcp-launcher.mjs'), '--locate'], {
  cwd: pluginRoot,
  env: { ...process.env, SVE_EDITOR_PROJECT_ROOT: projectRoot },
  encoding: 'utf8',
  windowsHide: true
});
const located = launcher.status === 0 &&
  path.resolve(launcher.stdout.trim()) === path.join(projectRoot, 'electron', 'src', 'mcp-host.js');
if (located) pass('launcher resolves the editor');
else fail('launcher could not resolve the editor',
  'Reinstall the plugin; scripts/editor-location.mjs may be missing or damaged.',
  (launcher.stderr || launcher.stdout || '').trim());

if (skipTests) {
  pass('MCP protocol tests', 'skipped (--skip-tests)');
} else {
  const tests = spawnSync(process.execPath, ['--test', 'src/mcp-server.test.js'], {
    cwd: path.join(projectRoot, 'electron'), encoding: 'utf8', windowsHide: true
  });
  if (tests.status === 0) pass('MCP protocol tests');
  else fail('MCP protocol tests failed',
    `npm run test:mcp     (in ${path.join(projectRoot, 'electron')}) to see the failures`,
    (tests.stderr || tests.stdout || '').trim().split('\n').slice(-6).join('\n'));
}

const width = Math.max(...results.map((entry) => entry.label.length));
for (const entry of results) {
  process.stdout.write(`  ${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.label.padEnd(width)}  ${entry.detail || ''}\n`.trimEnd() + '\n');
}

const problems = results.filter((entry) => !entry.ok);
if (!problems.length) {
  process.stdout.write('\nEverything the plugin needs is in place.\n\n');
  process.exit(0);
}

process.stdout.write(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} to fix:\n\n`);
for (const entry of problems) {
  process.stdout.write(`  ${entry.label}\n      ${entry.remedy}\n`);
  if (entry.detail) process.stdout.write(`      ${entry.detail.split('\n').join('\n      ')}\n`);
  process.stdout.write('\n');
}
process.exit(1);
