import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const HOST_PARTS = ['electron', 'src', 'mcp-host.js'];

export function locationFile(environment = process.env, home = os.homedir()) {
  const base = environment.LOCALAPPDATA || environment.APPDATA || home;
  return path.join(base, 'SimpleVlogEditor', 'editor-location.json');
}

function hostAt(root) {
  return path.join(root, ...HOST_PARTS);
}

function addAncestors(candidates, start) {
  if (!start) return;
  let current = path.resolve(start);
  while (true) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function registeredRoots(environment, home) {
  try {
    const saved = JSON.parse(fs.readFileSync(locationFile(environment, home), 'utf8'));
    return [saved.projectRoot, saved.mcpHostPath ? path.resolve(saved.mcpHostPath, '..', '..', '..') : null]
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function findProjectRoot(options = {}) {
  const environment = options.environment || process.env;
  const home = options.home || os.homedir();
  const candidates = [];
  if (environment.SVE_EDITOR_PROJECT_ROOT) candidates.push(environment.SVE_EDITOR_PROJECT_ROOT);
  candidates.push(...registeredRoots(environment, home));
  addAncestors(candidates, options.cwd || process.cwd());
  addAncestors(candidates, options.scriptDir);

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(hostAt(resolved))) return resolved;
  }
  return null;
}

export async function rememberProjectRoot(projectRoot, options = {}) {
  const resolved = path.resolve(projectRoot);
  const mcpHostPath = hostAt(resolved);
  if (!fs.existsSync(mcpHostPath)) throw new Error(`Electron MCP host was not found under ${resolved}.`);
  const target = options.target || locationFile(options.environment, options.home);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const record = {
    version: 1,
    projectRoot: resolved,
    mcpHostPath,
    updatedAt: new Date().toISOString()
  };
  try {
    await fsp.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}

export function mcpHostAt(projectRoot) {
  return hostAt(path.resolve(projectRoot));
}
