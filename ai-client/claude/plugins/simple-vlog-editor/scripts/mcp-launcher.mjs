#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findProjectRoot, mcpHostAt } from './editor-location.mjs';
import { updateNotice } from './version-check.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = findProjectRoot({ scriptDir });

if (!projectRoot) {
  process.stderr.write(
    'SimpleVlogEditor could not be located. Start the editor once from its project, run the plugin doctor, ' +
    'or set SVE_EDITOR_PROJECT_ROOT to the folder that contains electron and web.\n'
  );
  process.exitCode = 1;
} else {
  const host = mcpHostAt(projectRoot);
  if (process.argv.includes('--locate')) {
    process.stdout.write(`${host}\n`);
  } else {
    process.env.SVE_EDITOR_PROJECT_ROOT = projectRoot;
    // Say which folders automation may reach before the first tool call, so a
    // refused media path is diagnosed from this line rather than from
    // get_diagnostics after the fact.
    // Only the advanced override is visible from here. The folders the editor
    // actually allows are decided inside Electron, where the user's own media
    // folders and their saved consent are known.
    if (process.env.SVE_MCP_ROOTS) {
      process.stderr.write(`SVE_MCP_ROOTS is set, so the editor's default media folders stand down: ${process.env.SVE_MCP_ROOTS}\n`);
    }

    /*
     * Asked before the first tool call, and answered in two places.
     *
     * stderr is where a client's own logs show it, which is the right place for
     * whoever installed the plugin. The environment variable is how it reaches
     * the reader: the MCP host puts it on the capability and health answers,
     * and the skill tells the assistant to pass it on before doing anything
     * else. A notice nobody in the conversation sees is not a notice.
     */
    const notice = await updateNotice().catch(() => null);
    if (notice) {
      process.stderr.write(`${notice}\n`);
      process.env.SVE_UPDATE_NOTICE = notice;
    }
    await import(pathToFileURL(host).href);
  }
}
