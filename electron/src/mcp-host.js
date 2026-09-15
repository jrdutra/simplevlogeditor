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

startMcpServer(
  async (request) => {
    if (request.name === '__host_diagnostics') return { apiVersion: 2, projectRevision: 0, result: manager.diagnostics() };
    if (request.name === 'close_editor') return manager.closeEditor();
    if (request.name === 'restart_editor') return manager.restartEditor();
    const response = await manager.callEditor(request);
    if (request.name === 'get_diagnostics') response.result = { ...response.result, host: manager.diagnostics() };
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
