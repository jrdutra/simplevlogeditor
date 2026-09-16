'use strict';

/**
 * Stdio is owned by this small, durable Node process. Electron owns a stable
 * named-pipe server, so an editor crash only rejects the affected command and
 * the next command can reconnect (or restart the single editor instance).
 */
const { EditorProcessManager } = require('./editor-process-manager');
const { startMcpServer } = require('./mcp-server');
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
    const response = await manager.callEditor(request);
    if (request.name === 'get_diagnostics') response.result = { ...response.result, host: manager.diagnostics() };
    if (updateNotice && NOTICED_BY.has(request.name) && response && typeof response.result === 'object' && response.result) {
      response.result = { ...response.result, updateNotice };
    }
    return response;
  },
  {
    onClose: () => manager.close(),
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
process.on('SIGINT', () => { manager.close(); process.exitCode = 0; });
process.on('SIGTERM', () => { manager.close(); process.exitCode = 0; });
