import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ClientUsageError,
  MCP_HOST,
  PROJECT_ROOT,
  codexArgs,
  combinedPrompt,
  mcpConfigArgs,
  parseArgs,
  resolveSession,
  tomlString
} from './client.mjs';
import {
  findProjectRoot,
  locationFile,
  rememberProjectRoot
} from '../plugins/simple-vlog-editor/scripts/editor-location.mjs';

const pluginRoot = path.join(PROJECT_ROOT, 'ai-client', 'codex', 'plugins', 'simple-vlog-editor');

test('parses repeatable roots and a non-interactive editing brief', () => {
  const options = parseArgs(['--root', PROJECT_ROOT, '-r', path.dirname(PROJECT_ROOT), '--exec', '--', 'Remove', 'repetitions']);
  assert.deepEqual(options.roots, [PROJECT_ROOT, path.dirname(PROJECT_ROOT)]);
  assert.equal(options.exec, true);
  assert.equal(options.prompt, 'Remove repetitions');
});

test('requires a brief in non-interactive mode', () => {
  assert.throws(() => parseArgs(['--exec']), ClientUsageError);
});

test('builds an ephemeral stdio MCP configuration with admitted roots', () => {
  const options = parseArgs(['--root', PROJECT_ROOT, '--', 'Make a rough cut']);
  const session = resolveSession(options);
  const args = mcpConfigArgs(session, options).join('\n');
  assert.match(args, /mcp_servers\.simple-vlog-editor\.command=/);
  assert.match(args, /SVE_MCP_ROOTS=/);
  assert.match(args, /tool_timeout_sec=1800/);
  assert.ok(args.includes(tomlString(MCP_HOST)));
});

test('runs Codex read-only while keeping MCP editing available', () => {
  const options = parseArgs(['--root', PROJECT_ROOT, '--', 'Add a push-in']);
  const session = resolveSession(options);
  const args = codexArgs(options, session);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(args.at(-1).includes('Add a push-in'));
  assert.ok(args.at(-1).includes('add_push_in'));
});

test('the agent protocol requires every audiovisual asset to be understood', () => {
  const prompt = combinedPrompt('Edit this vlog', 'Use add_push_in. Inspect every distinct asset.');
  assert.match(prompt, /Inspect every distinct asset/);
  assert.match(prompt, /Edit this vlog/);
});

test('the Codex plugin exposes the local editor MCP server', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  assert.equal(manifest.name, 'simple-vlog-editor');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(Array.isArray(manifest.interface.defaultPrompt));
  assert.equal(mcp.mcpServers['simple-vlog-editor'].enabled, true);
  assert.deepEqual(mcp.mcpServers['simple-vlog-editor'].args, ['./scripts/mcp-launcher.mjs']);
  assert.equal(mcp.mcpServers['simple-vlog-editor'].cwd, '.');
  assert.equal(JSON.stringify(mcp).includes('C:\\\\Users\\\\'), false);
});

test('the portable plugin launcher resolves an explicit, contextual or registered editor root', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sve-plugin-location-'));
  const project = path.join(temporary, 'moved-editor');
  const nested = path.join(project, 'videos', 'episode');
  const localAppData = path.join(temporary, 'local-app-data');
  fs.mkdirSync(path.join(project, 'electron', 'src'), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(project, 'electron', 'src', 'mcp-host.js'), '// fixture\n');
  try {
    assert.equal(findProjectRoot({ environment: { SVE_EDITOR_PROJECT_ROOT: project }, cwd: temporary, home: temporary }), project);
    assert.equal(findProjectRoot({ environment: {}, cwd: nested, home: temporary }), project);
    await rememberProjectRoot(project, { environment: { LOCALAPPDATA: localAppData }, home: temporary });
    assert.equal(fs.existsSync(locationFile({ LOCALAPPDATA: localAppData }, temporary)), true);
    assert.equal(findProjectRoot({ environment: { LOCALAPPDATA: localAppData }, cwd: temporary, home: temporary }), project);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('the plugin skill mandates transcripts, frames, revisions and push-ins', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'edit-video', 'SKILL.md'), 'utf8');
  for (const requirement of ['transcribe every asset', 'contact sheet for every asset', 'expectedRevision', 'dryRun: true', 'add_push_in']) {
    assert.ok(skill.includes(requirement), `missing skill requirement: ${requirement}`);
  }
  const operations = fs.readFileSync(path.join(pluginRoot, 'skills', 'edit-video', 'references', 'mcp-operations.md'), 'utf8');
  assert.match(skill, /get_capabilities\.captions\.presetGroups/);
  assert.match(skill, /upper-left[\s\S]*upper-right[\s\S]*center-left[\s\S]*center-right/);
  assert.match(skill, /zoom-in[\s\S]*zoom-out[\s\S]*scroll-\*/);
  assert.match(operations, /"stylePreset": "behind-subject-zoom-in-display"[\s\S]*"positionX": 0\.5[\s\S]*"positionY": 0\.5[\s\S]*"animation": "zoom-in"/);
});
