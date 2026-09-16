'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function editorLocationFile(localAppData, userData) {
  return localAppData
    ? path.join(localAppData, 'SimpleVlogEditor', 'editor-location.json')
    : path.join(userData, 'editor-location.json');
}

function sourceLocation(sourceRoot) {
  const projectRoot = path.resolve(sourceRoot);
  const mcpHostPath = path.join(projectRoot, 'electron', 'src', 'mcp-host.js');
  return fs.existsSync(mcpHostPath) ? { projectRoot, mcpHostPath } : {};
}

async function rememberEditorLocation(stateFile, details) {
  let previous = {};
  try { previous = JSON.parse(await fsp.readFile(stateFile, 'utf8')); } catch {}
  const source = sourceLocation(details.sourceRoot);
  const record = {
    ...previous,
    version: 1,
    ...source,
    executablePath: details.executablePath,
    resourcesPath: details.resourcesPath,
    updatedAt: new Date().toISOString()
  };
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await fsp.rename(temporary, stateFile);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  return record;
}

module.exports = { editorLocationFile, rememberEditorLocation, sourceLocation };
