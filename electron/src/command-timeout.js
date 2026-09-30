'use strict';

/** Leave time for the renderer's own deadline to return its precise failure. */
function commandTimeout(request, slackMs = 10_000) {
  if (request.name !== 'transcribe') return 30 * 60_000;
  const requested = Number(request.arguments?.timeoutMs) || 30 * 60_000;
  return Math.max(1000, Math.min(3_600_000, requested)) + slackMs;
}

module.exports = { commandTimeout };
