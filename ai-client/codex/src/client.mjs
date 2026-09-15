#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_ROOT = path.resolve(SOURCE_DIR, '..');
export const PROJECT_ROOT = path.resolve(CLIENT_ROOT, '..', '..');
export const MCP_HOST = path.join(PROJECT_ROOT, 'electron', 'src', 'mcp-host.js');
export const AGENT_PROMPT = path.join(CLIENT_ROOT, 'EDITOR_AGENT.md');

const SERVER_NAME = 'simple-vlog-editor';
const DEFAULT_STARTUP_TIMEOUT = 60;
const DEFAULT_TOOL_TIMEOUT = 1800;

export class ClientUsageError extends Error {}

function nextValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new ClientUsageError(`${name} requires a value.`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    roots: [],
    workdir: null,
    model: null,
    exec: false,
    dev: false,
    doctor: false,
    dryConfig: false,
    help: false,
    prompt: ''
  };
  const prompt = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') {
      prompt.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '--root' || arg === '-r') {
      options.roots.push(nextValue(argv, index, arg));
      index++;
      continue;
    }
    if (arg === '--workdir' || arg === '-C') {
      options.workdir = nextValue(argv, index, arg);
      index++;
      continue;
    }
    if (arg === '--model' || arg === '-m') {
      options.model = nextValue(argv, index, arg);
      index++;
      continue;
    }
    if (arg === '--exec') { options.exec = true; continue; }
    if (arg === '--dev') { options.dev = true; continue; }
    if (arg === '--doctor') { options.doctor = true; continue; }
    if (arg === '--dry-config') { options.dryConfig = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg.startsWith('-')) throw new ClientUsageError(`Unknown option: ${arg}`);
    prompt.push(arg);
  }

  options.prompt = prompt.join(' ').trim();
  if (options.exec && !options.prompt && !options.doctor && !options.dryConfig && !options.help) {
    throw new ClientUsageError('--exec requires an editing brief after --.');
  }
  return options;
}

function directory(candidate, label) {
  const resolved = path.resolve(candidate);
  let actual;
  try { actual = fs.realpathSync(resolved); }
  catch { throw new ClientUsageError(`${label} does not exist: ${resolved}`); }
  if (!fs.statSync(actual).isDirectory()) throw new ClientUsageError(`${label} is not a directory: ${actual}`);
  return actual;
}

/**
 * Roots come from --root, else from an SVE_MCP_ROOTS already set for the user,
 * else from the editor project. Honouring the variable here means one
 * user-scope setting drives Codex and Claude Code alike.
 */
export function inheritedRoots(env = process.env) {
  return String(env.SVE_MCP_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveSession(options, env = process.env) {
  const declared = options.roots.length ? options.roots : inheritedRoots(env);
  const roots = (declared.length ? declared : [PROJECT_ROOT])
    .map((candidate) => directory(candidate, 'Allowed root'));
  const workdir = directory(options.workdir ?? roots[0], 'Codex working directory');
  const key = (candidate) => process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  if (!roots.some((root) => key(root) === key(workdir))) roots.push(workdir);
  return { roots: [...new Set(roots.map(key))].map((normalised) => roots.find((root) => key(root) === normalised)), workdir };
}

export function tomlString(value) {
  return JSON.stringify(String(value));
}

export function mcpConfigArgs(session, options = {}) {
  const hostArgs = [MCP_HOST, ...(options.dev ? ['--dev'] : [])];
  const roots = session.roots.join(path.delimiter);
  return [
    '-c', `mcp_servers.${SERVER_NAME}.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.${SERVER_NAME}.args=[${hostArgs.map(tomlString).join(',')}]`,
    '-c', `mcp_servers.${SERVER_NAME}.env={SVE_MCP_ROOTS=${tomlString(roots)}}`,
    '-c', `mcp_servers.${SERVER_NAME}.startup_timeout_sec=${DEFAULT_STARTUP_TIMEOUT}`,
    '-c', `mcp_servers.${SERVER_NAME}.tool_timeout_sec=${DEFAULT_TOOL_TIMEOUT}`
  ];
}

export function combinedPrompt(brief, instructions = fs.readFileSync(AGENT_PROMPT, 'utf8')) {
  const request = brief || 'Introduce yourself as the video editing agent, inspect the editor state, and wait for my editing brief without changing the project.';
  return `${instructions.trim()}\n\n## Current editing brief\n\n${request}`;
}

export function codexArgs(options, session) {
  const config = mcpConfigArgs(session, options);
  const common = [
    ...config,
    '-C', session.workdir,
    '--sandbox', 'read-only',
    '--ask-for-approval', 'never'
  ];
  if (options.model) common.push('--model', options.model);
  const prompt = combinedPrompt(options.prompt);
  if (!options.exec) return [...common, prompt];
  return [...config, 'exec', '-C', session.workdir, '--sandbox', 'read-only', '--ask-for-approval', 'never', '--skip-git-repo-check', ...(options.model ? ['--model', options.model] : []), prompt];
}

function codexBinary() {
  return process.env.SVE_CODEX_BIN || (process.platform === 'win32' ? 'codex.exe' : 'codex');
}

function assertProjectFiles() {
  const required = [MCP_HOST, AGENT_PROMPT, path.join(PROJECT_ROOT, 'electron', 'package.json')];
  for (const file of required) {
    if (!fs.existsSync(file)) throw new ClientUsageError(`Required file was not found: ${file}`);
  }
}

export function doctor(options, session, output = process.stdout) {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  record('Node.js', Number(process.versions.node.split('.')[0]) >= 18, process.version);
  record('MCP host', fs.existsSync(MCP_HOST), MCP_HOST);
  record('Electron dependency', fs.existsSync(path.join(PROJECT_ROOT, 'electron', 'node_modules', 'electron', 'package.json')), 'electron/node_modules/electron');
  record('Built web editor', fs.existsSync(path.join(PROJECT_ROOT, 'web', 'dist', 'browser', 'index.html')), 'web/dist/browser/index.html');

  const version = spawnSync(codexBinary(), ['--version'], { encoding: 'utf8', windowsHide: true });
  record('Codex CLI', version.status === 0, (version.stdout || version.stderr || 'not found').trim());

  if (version.status === 0) {
    const login = spawnSync(codexBinary(), ['login', 'status'], { encoding: 'utf8', windowsHide: true });
    record('Codex login', login.status === 0, (login.stdout || login.stderr || 'not logged in').trim());

    const listing = spawnSync(codexBinary(), [...mcpConfigArgs(session, options), 'mcp', 'list', '--json'], {
      encoding: 'utf8', windowsHide: true
    });
    let configured = false;
    try {
      const servers = JSON.parse(listing.stdout || '[]');
      configured = listing.status === 0 && servers.some((server) => server.name === SERVER_NAME && server.enabled);
    } catch {}
    record('Session MCP configuration', configured, configured ? `${SERVER_NAME} enabled` : (listing.stderr || 'configuration rejected').trim());
  }

  for (const check of checks) output.write(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  output.write(`OK   Allowed roots: ${session.roots.join(path.delimiter)}\n`);
  return checks.every((check) => check.ok);
}

export function usage() {
  return `SimpleVlogEditor Codex client

Usage:
  npm start -- --root <media-or-output-folder> -- <editing brief>
  npm start -- --root <folder> --exec -- <editing brief>
  npm run doctor -- --root <folder>

Options:
  -r, --root <folder>       Folder the editor may import from or export to. Repeatable.
  -C, --workdir <folder>    Codex working directory. Also becomes an allowed root.
  -m, --model <model>       Optional Codex model override.
      --exec                Run once non-interactively and exit.
      --dev                 Use the Angular development server at localhost:4200.
      --doctor              Validate Codex, Electron, the web build and MCP configuration.
      --dry-config          Print the generated session configuration without launching Codex.
  -h, --help                Show this help.
`;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage()); return; }
    assertProjectFiles();
    const session = resolveSession(options);
    if (options.doctor) {
      process.exitCode = doctor(options, session) ? 0 : 1;
      return;
    }
    if (options.dryConfig) {
      process.stdout.write(JSON.stringify({
        server: SERVER_NAME,
        command: process.execPath,
        args: [MCP_HOST, ...(options.dev ? ['--dev'] : [])],
        allowedRoots: session.roots,
        workdir: session.workdir,
        mode: options.exec ? 'exec' : 'interactive',
        model: options.model || 'Codex default'
      }, null, 2) + '\n');
      return;
    }

    const child = spawn(codexBinary(), codexArgs(options, session), {
      cwd: session.workdir,
      env: process.env,
      stdio: 'inherit',
      windowsHide: false
    });
    child.once('error', (error) => {
      process.stderr.write(`Could not start Codex: ${error.message}\n`);
      process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
      if (signal) process.stderr.write(`Codex ended after signal ${signal}.\n`);
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
