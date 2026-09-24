/**
 * The plugin launcher, tested from the outside with a fake installed editor: a
 * copy of the plugin in a folder with spaces and accents, and an "installed"
 * SimpleVlogEditor in the installer's default folder of a scratch profile,
 * whose executable is a copy of Node and whose archive is a folder holding a
 * fake MCP host. Everything the launcher does to find, start, wire and stop
 * the host is exercised; only Electron itself is replaced.
 *
 * Run:  node --test ai-client/tests/*.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE = path.resolve(here, '..', 'simplevlogeditor-claude-plugin', 'plugins', 'simple-vlog-editor');
const CODEX_SOURCE = path.resolve(here, '..', 'simplevlogeditor-codex-plugin', 'plugins', 'simple-vlog-editor');
const FAKE_HOST = path.join(here, 'fixtures', 'fake-mcp-host.cjs');

const scripts = pathToFileURL(path.join(PLUGIN_SOURCE, 'scripts')).href;
const { platformKey, RUNTIME_PLATFORMS } = await import(`${scripts}/runtime-location.mjs`);
const { startProbe, processAlive } = await import(`${scripts}/mcp-probe.mjs`);
const { inspectCandidate, INSTALL_URL } = await import(`${scripts}/editor-discovery.mjs`);
const { codexLaunchSpec } = await import(pathToFileURL(path.join(CODEX_SOURCE, 'scripts', 'codex-config.mjs')).href);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sve launcher tést '));
test.after(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

function copyTree(from, to, skip = new Set(['runtime', 'node_modules'])) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, skip);
    else fs.copyFileSync(source, target);
  }
}

/** A runtime folder whose "executable" is Node and whose "archive" is a folder. */
function fakeRuntime(runtimeDir, executableName, options = {}) {
  const executable = path.join(runtimeDir, executableName);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  if (options.realExecutable !== false) {
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
  } else {
    fs.writeFileSync(executable, 'MZ');
  }
  const src = path.join(runtimeDir, 'resources', 'app.asar', 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, '..', 'package.json'), JSON.stringify({ version: options.version || '1.1.3' }));
  if (options.host !== false) fs.copyFileSync(FAKE_HOST, path.join(src, 'mcp-host.js'));
  if (options.marker !== false) fs.writeFileSync(path.join(src, 'mcp-stdio-entry.js'), '// marker\n');
  fs.mkdirSync(path.join(runtimeDir, 'resources', 'site'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'resources', 'site', 'index.html'), '<!doctype html>');
  return executable;
}

const EXECUTABLE = (RUNTIME_PLATFORMS[platformKey()] || { executable: 'SimpleVlogEditor.exe' }).executable;

test('discovery rejects obsolete editors even when the MCP marker exists', () => {
  for (const version of ['1.1.0', '1.1.2', '1.1.3']) {
    const executable = fakeRuntime(path.join(scratch, `version-${version}`), EXECUTABLE, { version, realExecutable: false });
    const candidate = inspectCandidate(executable);
    assert.equal(candidate.ok, version === '1.1.3');
    if (!candidate.ok) assert.match(candidate.reason, /older than the plugin requires/);
  }
});

let pluginCounter = 0;
/** A copy of the plugin, in a folder with spaces and accents. */
function pluginCopy(source = PLUGIN_SOURCE) {
  const root = path.join(scratch, `Plugin Ç ${++pluginCounter}`, 'simple-vlog-editor');
  copyTree(source, root);
  return root;
}

/** A scratch profile: its own home, AppData and Program Files, nothing of the real machine. */
function isolatedEnvironment(extra = {}) {
  const home = fs.mkdtempSync(path.join(scratch, 'home '));
  const environment = {
    ...process.env,
    HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
    ProgramFiles: path.join(home, 'Program Files'), ProgramW6432: path.join(home, 'Program Files'),
    'ProgramFiles(x86)': path.join(home, 'Program Files (x86)'),
    SVE_SKIP_UPDATE_CHECK: '1', SVE_MCP_LOG_FILE: path.join(home, 'mcp.log'),
    ...extra
  };
  for (const name of ['SVE_EDITOR_PROJECT_ROOT', 'SVE_DEV_EDITOR_ROOT', 'SVE_EDITOR_EXECUTABLE', 'SVE_RUNTIME_MODE', 'SVE_CONTROLLER']) {
    if (!(name in extra)) delete environment[name];
  }
  return environment;
}

/** The editor where the installer puts it for a "just for me" install. */
function installPerUser(environment, options = {}) {
  return fakeRuntime(path.join(environment.LOCALAPPDATA, 'Programs', 'SimpleVlogEditor'), EXECUTABLE, options);
}

/** The editor where the installer puts it for an "all users" install. */
function installForAllUsers(environment, options = {}) {
  return fakeRuntime(path.join(environment.ProgramFiles, 'SimpleVlogEditor'), EXECUTABLE, options);
}

function launch(pluginRoot, extra = {}, prepare = () => {}) {
  const environment = isolatedEnvironment(extra);
  prepare(environment);
  const probe = startProbe({
    args: [path.join(pluginRoot, 'scripts', 'mcp-launcher.mjs')],
    cwd: fs.mkdtempSync(path.join(scratch, 'cwd ')),
    env: environment,
    timeoutMs: 20_000
  });
  probe.environment = environment;
  return probe;
}

const installed = (extra = {}) => launch(pluginCopy(), extra, (environment) => installPerUser(environment));

// ------------------------------------------------------------- the wire

test('from a folder with spaces and accents, the installed editor starts and answers MCP', async () => {
  const root = pluginCopy();
  assert.match(root, / /);
  const probe = launch(root, {}, (environment) => installForAllUsers(environment));
  const hello = await probe.initialize();
  assert.equal(hello.serverInfo.name, 'simple-vlog-editor');
  const { tools } = await probe.request('tools/list');
  assert.equal(tools.length, 24);
  const health = await probe.tool('health_check');
  // Started as the installed editor's own executable running as Node, in MCP mode.
  assert.equal(health.result.runAsNode, '1');
  assert.deepEqual(health.result.argv, ['--mcp-stdio', '--controller', 'claude-code']);
  assert.equal(health.result.controller, 'claude-code');
  const outcome = await probe.close();
  assert.equal(outcome.code, 0);
  assert.deepEqual(probe.contamination, [], 'stdout must carry MCP only');
});

test('the Codex declaration starts its own launcher and identifies the Codex controller', async () => {
  const root = pluginCopy(CODEX_SOURCE);
  const environment = isolatedEnvironment();
  installPerUser(environment);
  const probe = startProbe(codexLaunchSpec(root, environment));
  try {
    const hello = await probe.initialize();
    assert.equal(hello.serverInfo.name, 'simple-vlog-editor');
    const health = await probe.tool('health_check');
    assert.deepEqual(health.result.argv, ['--mcp-stdio', '--controller', 'codex']);
    assert.equal(health.result.controller, 'codex');
  } finally { await probe.close(); }
  assert.deepEqual(probe.contamination, []);
});

test('stderr is free for diagnostics and never reaches the MCP channel', async () => {
  const probe = installed();
  await probe.initialize();
  await probe.request('tools/list');
  await probe.close();
  assert.match(probe.stderr(), /\[simple-vlog-editor\] starting the installed editor /);
  assert.match(probe.stderr(), /fake-host: <- tools\/list/);
  assert.deepEqual(probe.contamination, []);
});

test('the launcher exits with the host\'s exit code', async () => {
  const probe = installed({ FAKE_EXIT_AFTER_INIT: '7' });
  await probe.initialize();
  const outcome = await Promise.race([probe.exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000))]);
  assert.notEqual(outcome, 'timeout');
  assert.equal(outcome.code, 7);
});

test('closing stdin ends both the launcher and the host', async () => {
  const probe = installed();
  await probe.initialize();
  const { result } = await probe.tool('health_check');
  const outcome = await probe.close();
  assert.equal(outcome.code, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processAlive(result.hostPid), false, 'no orphaned host');
});

test('a host that ignores the end of the session is stopped after the grace period', async () => {
  const probe = installed({ FAKE_IGNORE_STDIN_END: '1' });
  await probe.initialize();
  const { result } = await probe.tool('health_check');
  const started = Date.now();
  const outcome = await probe.close(20_000);
  assert.notEqual(outcome.timedOut, true);
  assert.ok(Date.now() - started < 15_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processAlive(result.hostPid), false, 'no orphaned host');
});

test('terminating the launcher terminates the host', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const probe = installed();
  await probe.initialize();
  const { result } = await probe.tool('health_check');
  probe.child.kill('SIGTERM');
  await Promise.race([probe.exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && processAlive(result.hostPid)) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processAlive(result.hostPid), false, 'no orphaned host');
});

// ------------------------------------------------------------- not installed

test('an editor anywhere but the installer\'s default folder is ignored: the plugin says it is not installed and where to get it', async () => {
  const portable = path.join(scratch, 'Meus Apps', 'SimpleVlogEditor Portátil');
  fakeRuntime(portable, EXECUTABLE);
  const probe = launch(pluginCopy(), { SVE_EDITOR_EXECUTABLE: path.join(portable, EXECUTABLE) }, (environment) => {
    // A remembered location from an older plugin, pointing at the same copy.
    const record = path.join(environment.LOCALAPPDATA, 'SimpleVlogEditor', 'editor-location.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ userSelectedPath: portable, executablePath: path.join(portable, EXECUTABLE) }));
  });
  try {
    const hello = await probe.initialize();
    assert.equal(hello.capabilities.tools.listChanged, true);
    assert.ok(hello.instructions.includes(INSTALL_URL));
    const first = await probe.request('tools/list');
    assert.deepEqual(first.tools.map((entry) => entry.name).sort(), ['check_installation', 'get_editor_capabilities', 'health_check']);
    const health = await probe.tool('health_check');
    assert.equal(health.result.state, 'editor_not_installed');
    assert.equal(health.result.downloadUrl, 'https://simplevlogeditor.com/');
    assert.match(health.result.message, /not installed/);
    await assert.rejects(probe.tool('check_installation'), /simplevlogeditor\.com/);
    assert.match(probe.stderr(), /not installed on this computer/);
  } finally { await probe.close(); }
  assert.deepEqual(probe.contamination, []);
});

test('once the user installs the editor, check_installation connects it in the same session', async () => {
  const probe = launch(pluginCopy());
  await probe.initialize();
  installPerUser(probe.environment);
  const checked = await probe.request('tools/call', { name: 'check_installation', arguments: {} });
  assert.notEqual(checked.isError, true, checked.content?.[0]?.text);
  assert.equal(JSON.parse(checked.content[0].text).connected, true);
  const after = await probe.request('tools/list');
  assert.equal(after.tools.length, 24, 'the real host answers now');
  const real = await probe.tool('health_check');
  assert.equal(real.result.runAsNode, '1');
  await probe.close();
  assert.deepEqual(probe.contamination, []);
});

test('an installed editor older than the plugin is reported as outdated, with the download link', async () => {
  const probe = launch(pluginCopy(), {}, (environment) => installPerUser(environment, { version: '1.1.0' }));
  try {
    await probe.initialize();
    const health = await probe.tool('health_check');
    assert.equal(health.result.state, 'editor_outdated');
    assert.match(health.result.message, /too old/);
    assert.ok(health.result.message.includes(INSTALL_URL));
  } finally { await probe.close(); }
});

// ------------------------------------------------------------- packaging hygiene

test('both plugins ship identical shared scripts and skills', () => {
  const codex = CODEX_SOURCE;
  const clientSpecificScripts = new Set(['codex-config.mjs', 'doctor.mjs', 'launcher-core.mjs', 'mcp-probe.mjs']);
  for (const folder of ['scripts', 'skills']) {
    const walk = (base, relative = '') => fs.readdirSync(path.join(base, relative), { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory() ? walk(base, path.join(relative, entry.name)) : [path.join(relative, entry.name)]).sort();
    const claudeFiles = walk(path.join(PLUGIN_SOURCE, folder)).filter((file) => folder !== 'scripts' || !clientSpecificScripts.has(file));
    const codexFiles = walk(path.join(codex, folder));
    const sharedCodexFiles = codexFiles.filter((file) => folder !== 'scripts' || !clientSpecificScripts.has(file));
    assert.deepEqual(sharedCodexFiles, claudeFiles, `${folder}: same shared file list`);
    for (const file of claudeFiles) {
      assert.equal(fs.readFileSync(path.join(codex, folder, file), 'utf8'), fs.readFileSync(path.join(PLUGIN_SOURCE, folder, file), 'utf8'), `${folder}/${file}`);
    }
  }
});
