'use strict';

/**
 * The parts of the MCP host that changed so it can run from a packaged
 * executable: how the window is started, which pipe is used, which folders are
 * refused, where FFprobe comes from, and that stdout carries MCP and nothing
 * else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { editorLaunchCommand } = require('./editor-process-manager');
const { editorEndpoint } = require('./ipc-endpoint');
const { RootStore, deniedRoot } = require('./mcp-roots');
const { ffprobeExecutable, ffmpegExecutable } = require('./media-import-service');
const { hostArguments } = require('./mcp-stdio-entry');

test('a packaged host starts the window from its own executable, never from node_modules', () => {
  const launch = editorLaunchCommand({
    environment: { ELECTRON_RUN_AS_NODE: '1', SVE_CONTROLLER: 'claude-code', PATH: 'x' },
    versions: { electron: '44.0.0' },
    execPath: 'C:\\Users\\João Ricardo\\Plugin\\runtime\\win32-x64\\SimpleVlogEditor.exe',
    appDirectory: 'C:\\Users\\João Ricardo\\Plugin\\runtime\\win32-x64\\resources\\app.asar',
    resolveElectron: () => { throw new Error('must not be required'); }
  });
  assert.equal(launch.mode, 'packaged');
  assert.equal(launch.command, 'C:\\Users\\João Ricardo\\Plugin\\runtime\\win32-x64\\SimpleVlogEditor.exe');
  assert.deepEqual(launch.args, ['--mcp-open']);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined, 'the window must not start as Node');
  assert.equal(launch.env.SVE_CONTROLLER, 'claude-code');
});

test('electron-as-node from a checkout still tells the window which application to open', () => {
  const launch = editorLaunchCommand({
    environment: { ELECTRON_RUN_AS_NODE: '1' },
    versions: { electron: '44.0.0' },
    execPath: '/repo/electron/node_modules/electron/dist/electron',
    appDirectory: '/repo/electron',
    dev: true
  });
  assert.equal(launch.mode, 'checkout-electron');
  assert.deepEqual(launch.args, ['/repo/electron', '--mcp-open', '--dev']);
  assert.equal(launch.env.SVE_CONTROLLER, 'codex');
});

test('plain node from a checkout keeps using the development Electron', () => {
  const launch = editorLaunchCommand({
    environment: {}, versions: {}, resolveElectron: () => '/repo/node_modules/electron/dist/electron'
  });
  assert.equal(launch.mode, 'checkout');
  assert.equal(launch.command, '/repo/node_modules/electron/dist/electron');
  assert.equal(launch.args.at(-1), '--mcp-open');
});

test('the editor pipe is one per user, whichever copy of the editor computes it', () => {
  const a = editorEndpoint({});
  const b = editorEndpoint({});
  assert.equal(a, b);
  assert.match(a, /simple-vlog-editor-(\w+-)?[0-9a-f]{20}/);
  assert.equal(editorEndpoint({ SVE_EDITOR_ENDPOINT: 'custom-pipe' }), 'custom-pipe');
});

test('the program folder is refused even inside an allowed media folder', () => {
  const runtime = 'C:\\Users\\ana\\Downloads\\simple-vlog-editor\\runtime\\win32-x64';
  const store = new RootStore({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' },
    getPath: (name) => (name === 'downloads' ? 'C:\\Users\\ana\\Downloads' : null),
    projectRoot: null,
    denied: [runtime]
  });
  assert.equal(store.admits('C:\\Users\\ana\\Downloads\\clip.mp4'), true);
  assert.equal(store.admits(`${runtime}\\resources\\app.asar`), false);
  assert.equal(store.add(runtime).added, false);
  assert.match(deniedRoot(`${runtime}\\x`, { platform: 'win32', env: {}, denied: [runtime] }), /program folder/);
});

test('FFprobe: explicit variable, then the packed copy, then PATH', () => {
  assert.equal(ffprobeExecutable({ environment: { SVE_FFPROBE: 'D:\\ff\\ffprobe.exe' } }), 'D:\\ff\\ffprobe.exe');
  assert.equal(
    ffprobeExecutable({ environment: {}, resourcesPath: 'R', platform: 'win32', exists: () => true }),
    path.join('R', 'bin', 'ffprobe.exe')
  );
  assert.equal(ffprobeExecutable({ environment: {}, resourcesPath: 'R', platform: 'win32', exists: () => false }), 'ffprobe');
  assert.equal(ffprobeExecutable({ environment: {}, resourcesPath: null }), 'ffprobe');
  assert.equal(ffmpegExecutable({ environment: {}, resourcesPath: 'R', platform: 'win32', exists: () => true }), path.join('R', 'bin', 'ffmpeg.exe'));
  assert.equal(ffmpegExecutable({ environment: { SVE_FFMPEG: 'X' } }), 'X');
});

test('--mcp-stdio forwards only the flags the host understands', () => {
  assert.deepEqual(hostArguments(['exe', '--mcp-stdio', '--controller', 'codex', '--inspect=9229']),
    ['--mcp-stdio', '--controller', 'codex']);
  assert.deepEqual(hostArguments(['exe', '.', '--mcp-stdio', '--dev']), ['--mcp-stdio', '--dev']);
});

test('the real host keeps stdout for MCP only and exits when the client closes stdin', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-host.js'), '--mcp-stdio', '--controller', 'codex'], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      // A pipe nobody owns, so nothing here can reach a real editor.
      SVE_EDITOR_ENDPOINT: process.platform === 'win32'
        ? `\\\\.\\pipe\\sve-test-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `sve-test-${process.pid}-${Date.now()}.sock`),
      SVE_CONTROLLER: ''
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && stdout.split('\n').filter(Boolean).length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const started = Date.now();
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000))]);
  if (code === 'timeout') child.kill();
  assert.notEqual(code, 'timeout', 'the host must not outlive its client');
  assert.ok(Date.now() - started < 8000);

  const lines = stdout.split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
  }
  const list = JSON.parse(lines[1]);
  assert.ok(list.result.tools.some((tool) => tool.name === 'health_check'));
});

test('logging into a stderr whose reader is gone never crashes the process (EPIPE)', async () => {
  const script = `
    const { createLogger } = require(${JSON.stringify(path.join(__dirname, 'structured-log.js'))});
    const log = createLogger('epipe-test');
    let n = 0;
    const timer = setInterval(() => {
      log.info('tick', { n: n++ });
      if (n > 40) { clearInterval(timer); process.exit(0); }
    }, 10);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  // The reader goes away at once, exactly like an MCP host that has exited.
  child.stderr.destroy();
  const code = await new Promise((resolve) => child.once('exit', (value) => resolve(value)));
  assert.equal(code, 0);
});

test('the editor window never inherits the host\'s streams', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, 'editor-process-manager.js'), 'utf8');
  assert.match(source, /stdio: \['ignore', 'ignore', 'ignore'\]/);
});
