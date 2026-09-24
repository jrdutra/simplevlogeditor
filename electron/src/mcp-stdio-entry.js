'use strict';

/**
 * `SimpleVlogEditor.exe --mcp-stdio`: the executable as an MCP server.
 *
 * The plugins do not come through here — their launcher starts the same host
 * directly, with the executable running as Node — but a person configuring an
 * MCP client by hand should be able to point it at the program they installed
 * and nothing else. This is that door.
 *
 * It does not serve MCP from the Electron main process. `restart_editor` closes
 * and reopens the window's process while the client stays connected, so the
 * process that owns stdio cannot be the one that gets restarted. Instead the
 * executable starts itself again as Node (`ELECTRON_RUN_AS_NODE`) running
 * `mcp-host.js`, hands it this process's own stdin, stdout and stderr, and
 * waits. No window is created here and the single-instance lock is not taken:
 * the host opens the real editor, as a separate process, when a tool first
 * needs it.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

/** Only the flags the host understands travel on; everything else stays here. */
function hostArguments(argv) {
  const forwarded = ['--mcp-stdio'];
  const controllerAt = argv.indexOf('--controller');
  if (controllerAt >= 0 && argv[controllerAt + 1] && !argv[controllerAt + 1].startsWith('--')) {
    forwarded.push('--controller', argv[controllerAt + 1]);
  }
  if (argv.includes('--dev')) forwarded.push('--dev');
  return forwarded;
}

function runMcpStdio(app, options = {}) {
  const argv = options.argv || process.argv;
  const host = path.join(__dirname, 'mcp-host.js');
  app.dock?.hide?.();
  const child = spawn(process.execPath, [host, ...hostArguments(argv)], {
    // Inherited, not piped: the same handles the client gave this process, so
    // nothing between the client and the host can reorder or buffer a byte.
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    shell: false
  });
  const forward = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.once('error', (error) => {
    process.stderr.write(`SimpleVlogEditor could not start its MCP host: ${error.message}\n`);
    app.exit(1);
  });
  child.once('exit', (code, signal) => app.exit(code ?? (signal ? 1 : 0)));
  return child;
}

module.exports = { runMcpStdio, hostArguments };
