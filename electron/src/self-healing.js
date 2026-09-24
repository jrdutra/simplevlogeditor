'use strict';

/**
 * Recovering from the failures that are only a moment.
 *
 * A stalled media load, a renderer that stopped answering, a dropped pipe, an
 * editor that timed out: none of them is a verdict on the request, and none of
 * them should end an edit or read as an error. The host retries them itself —
 * after a short wait, or after closing and reopening the editor, which restores
 * the recovery checkpoint — and only a failure that survives that reaches the
 * client.
 *
 * What may be retried blindly is decided by what the request does:
 *
 *   reads     retried on the same or on a fresh editor. Nothing can be done twice.
 *   changes   retried only on the same editor process, where the idempotency
 *             ledger replays a request that already ran instead of running it
 *             again. After a restart that ledger is gone, so instead of guessing
 *             the host answers with `editor_restored` — recoverable, with the
 *             instruction to read the project again and continue.
 */

/** Requests that read, analyse or look: repeating them changes nothing. */
const READS = new Set([
  'get_editor_capabilities', 'get_project', 'list_assets', 'get_timeline', 'get_waveform_page',
  'transcribe', 'get_frames', 'get_contact_sheet', 'analyze_silence', 'analyze_noise',
  'health_check', 'get_diagnostics', 'get_recovery_state', 'get_import_status', 'get_operation_status',
  'preview', 'checkpoint_project', 'save_project'
]);

/** A stuck editor: worth reopening. */
const RESTART_CODES = new Set(['media_timeout', 'editor_timeout', 'renderer_unresponsive', 'editor_start_timeout', 'editor_start_failed']);
/** A moment: worth waiting for. */
const WAIT_CODES = new Set(['editor_reconnecting', 'editor_unavailable', 'editor_close_timeout']);

function isRecoverable(error) {
  const code = error && error.code;
  return RESTART_CODES.has(code) || WAIT_CODES.has(code) || Boolean(error && error.details && error.details.recoverable === true);
}

function isRead(request) {
  return READS.has(request.name) || (request.name === 'apply_edit_batch' && request.arguments && request.arguments.dryRun === true);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ callEditor, recover, editorPid }} manager
 * @param {{ name: string, arguments?: object }} request
 */
async function callWithRecovery(manager, request, options = {}) {
  const logger = options.logger || { warn() {}, info() {} };
  const attempts = options.attempts || 3;
  const wait = options.wait || delay;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const pidBefore = manager.editorPid;
    try {
      const response = await manager.callEditor(request);
      if (attempt > 1) logger.info('self_heal_succeeded', { request: request.name, attempt });
      return response;
    } catch (error) {
      lastError = error;
      if (!isRecoverable(error) || attempt === attempts) throw error;
      logger.warn('self_heal_retry', { request: request.name, attempt, code: error.code, message: error.message });

      const restart = RESTART_CODES.has(error.code) || (attempt >= 2 && WAIT_CODES.has(error.code));
      if (restart) {
        try { await manager.recover(`${request.name}: ${error.code}`); }
        catch (recoveryError) { logger.warn('self_heal_recovery_failed', { error: recoveryError }); }
      } else {
        await wait(Math.min(5000, Number(error.details && error.details.retryAfterMs) || 750));
      }

      if (!isRead(request) && (restart || (manager.editorPid && pidBefore && manager.editorPid !== pidBefore))) {
        throw Object.assign(new Error(
          'The editor was reopened and restored from its recovery checkpoint while this change was in flight, so whether it was applied is not known. ' +
          'Call get_project, check the change against the current timeline, and send it again with a new requestId if it is missing.'
        ), {
          code: 'editor_restored',
          details: { recoverable: true, cause: error.code, request: request.name, nextStep: 'get_project, then retry with a new requestId against the new projectRevision.' }
        });
      }
    }
  }
  throw lastError;
}

module.exports = { callWithRecovery, isRecoverable, isRead, READS, RESTART_CODES, WAIT_CODES };
