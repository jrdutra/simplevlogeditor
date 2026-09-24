'use strict';

/**
 * Stdio is owned by this small, durable Node process. Electron owns a stable
 * named-pipe server, so an editor crash only rejects the affected command and
 * the next command can reconnect (or restart the single editor instance).
 *
 * It runs in two ways, with the same code:
 *
 *   node electron/src/mcp-host.js                  from a checkout (npm run mcp)
 *   SimpleVlogEditor.exe <app>/src/mcp-host.js --mcp-stdio --controller claude-code
 *                                                  the packaged editor running
 *                                                  as Node (ELECTRON_RUN_AS_NODE),
 *                                                  which is what the plugins start
 *
 * In both, stdout is the MCP channel and nothing else. That is why this process
 * supervises the window instead of being it: `restart_editor` has to be able to
 * close and reopen Electron while the client's connection stays up.
 */

// ---------------------------------------------------------------- stdout is MCP

/*
 * Anything a dependency prints with console.log would land between two JSON-RPC
 * messages and break the client's parser. Human-readable output is moved to
 * stderr before any other module is loaded; the MCP server itself writes to
 * process.stdout directly and is unaffected.
 */
for (const method of ['log', 'info', 'debug']) {
  // eslint-disable-next-line no-console
  console[method] = (...values) => console.error(...values);
}
// A client that went away closes the pipe under us. Exit quietly instead of
// dying on an unhandled EPIPE and leaving a stack trace where logs are read.
process.stdout.on('error', (error) => {
  if (error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')) process.exit(0);
});

function argumentValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : null;
}

// `--controller codex` is the explicit form; SVE_CONTROLLER still works and wins
// when both are given, because it is what existing configurations set.
const controllerArgument = argumentValue('--controller');
if (controllerArgument && !process.env.SVE_CONTROLLER) process.env.SVE_CONTROLLER = controllerArgument;

const { EditorProcessManager } = require('./editor-process-manager');
const { startMcpServer } = require('./mcp-server');
const { callWithRecovery } = require('./self-healing');
const { createLogger } = require('./structured-log');

const logger = createLogger('mcp-host');
const manager = new EditorProcessManager({ logger });

/*
 * The plugin's own update notice, carried into the conversation.
 *
 * The launcher works out whether the plugin is the version the current editor
 * was released with, and writes what it found here. stderr already has it, but
 * stderr is read by whoever installed the plugin, not by whoever is using it —
 * so it rides along on the three answers every session starts with, and the
 * skill tells the assistant to pass it on before doing anything else.
 */
const updateNotice = (process.env.SVE_UPDATE_NOTICE || '').trim();
const NOTICED_BY = new Set(['get_editor_capabilities', 'health_check', 'get_diagnostics']);

startMcpServer(
  async (request) => {
    if (request.name === '__host_diagnostics') return { apiVersion: 2, projectRevision: 0, result: manager.diagnostics() };
    if (request.name === 'close_editor') return manager.closeEditor();
    if (request.name === 'restart_editor') return manager.restartEditor();
    // Stalls, timeouts and dropped connections are retried here — reopening
    // the editor from its checkpoint when that is what it takes — so the
    // client sees them only when they survive that (see self-healing.js).
    const response = await callWithRecovery(manager, request, { logger });
    if (request.name === 'get_diagnostics') response.result = { ...response.result, host: manager.diagnostics() };
    if (updateNotice && NOTICED_BY.has(request.name) && response && typeof response.result === 'object' && response.result) {
      response.result = { ...response.result, updateNotice };
    }
    return response;
  },
  {
    // The client closed stdin: the session is over. Pending calls hold timers
    // of up to thirty minutes, so waiting for the event loop to drain would
    // leave this process behind for that long; a short grace period lets the
    // last replies flush and then it goes. The window stays — it is the
    // user's editor, and whatever it was doing it finishes on its own.
    onClose: () => {
      manager.close();
      setTimeout(() => process.exit(0), 1500);
    },
    // Folders the user connected in their client session. Forwarded as their
    // own layer: they are neither the editor's defaults nor consent given in
    // the editor window, and they last only as long as this session.
    onClientRoots: (roots) => manager.setClientRoots(roots)
  }
);

process.on('uncaughtException', (error) => logger.error('uncaught_exception', { error }));
process.on('unhandledRejection', (error) => logger.error('unhandled_rejection', {
  error: error instanceof Error ? error : new Error(String(error))
}));
process.on('SIGINT', () => { manager.close(); process.exit(0); });
process.on('SIGTERM', () => { manager.close(); process.exit(0); });
// Started by a launcher that has itself gone away (killed, not closed): its end
// of stdin closes, which the MCP server already treats as the end of the
// session. A disconnect of the Node IPC channel, when there is one, means the
// same thing.
process.on('disconnect', () => { manager.close(); process.exit(0); });
